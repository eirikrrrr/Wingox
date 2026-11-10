// A tmux-like pane tree for a device tab: a leaf is one section of the device
// (picked from the menu sidebar); a split lays out its children side by side
// (h) or stacked (v), each with a share of the space. Splitting a pane inserts
// the new one right after it and evens out that row/column (like tmux's even
// layouts), so every pane — not only the newest — keeps a usable size; the
// dividers between panes can be dragged (double-click evens them out again).
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  Cpu, Clock, Boxes, Network, SplitSquareHorizontal, SplitSquareVertical, X, Terminal, RefreshCw, Search, ArrowUp, ArrowDown,
  BookOpen,
} from "lucide-react";
import { docsLink, openDocs } from "./docs";
import { sectionOf, type Section } from "./menu";

/** a section id from the menu (see menu.ts) */
export type View = string;

export type LeafPane = { kind: "leaf"; id: string; view: View };
export type Split = { kind: "split"; id: string; dir: "h" | "v"; children: Pane[]; sizes: number[] };
export type Pane = LeafPane | Split;

export interface DeviceData {
  identity: string;
  version: string;
  board: string;
  architecture: string;
  cpuLoad: string;
  uptime: string;
  interfaces: Record<string, unknown>[];
}

/** reads a RouterOS menu path for this device */
export type Fetcher = (path: string) => Promise<unknown>;

let counter = 0;
const uid = () => `n${Date.now().toString(36)}${counter++}`;
/** a fresh pane id (to know, e.g., which pane a split just created) */
export const paneId = uid;

export const newLeaf = (view: View = "overview"): Pane => ({ kind: "leaf", id: uid(), view });

const even = (n: number) => Array.from({ length: n }, () => 1 / n);

/**
 * Split a leaf; the new pane shows `view` (or the same view) and gets id `newId`
 * if given. In the same direction as its parent split, the new pane joins that
 * split right after the leaf and the row/column is evened out; otherwise the
 * leaf becomes a two-pane split.
 */
export function splitPane(tree: Pane, leafId: string, dir: "h" | "v", view?: View, newId?: string): Pane {
  const fresh = (from: LeafPane): LeafPane => ({ kind: "leaf", id: newId ?? uid(), view: view ?? from.view });
  if (tree.kind === "leaf") {
    if (tree.id !== leafId) return tree;
    return { kind: "split", id: uid(), dir, children: [tree, fresh(tree)], sizes: [0.5, 0.5] };
  }
  const at = tree.children.findIndex((c) => c.kind === "leaf" && c.id === leafId);
  if (at >= 0 && tree.dir === dir) {
    const children = [...tree.children];
    children.splice(at + 1, 0, fresh(tree.children[at] as LeafPane));
    return { ...tree, children, sizes: even(children.length) };
  }
  return { ...tree, children: tree.children.map((c) => splitPane(c, leafId, dir, view, newId)) };
}

/** close a leaf; its space goes to its neighbours, and a split left with one child collapses */
export function closePane(tree: Pane, leafId: string): Pane | null {
  if (tree.kind === "leaf") return tree.id === leafId ? null : tree;
  const children: Pane[] = [];
  const sizes: number[] = [];
  tree.children.forEach((c, i) => {
    const next = closePane(c, leafId);
    if (next) { children.push(next); sizes.push(tree.sizes[i] ?? 0); }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...tree, children, sizes: sizes.map((x) => x / total) };
}

export function setPaneView(tree: Pane, leafId: string, view: View): Pane {
  if (tree.kind === "leaf") return tree.id === leafId ? { ...tree, view } : tree;
  return { ...tree, children: tree.children.map((c) => setPaneView(c, leafId, view)) };
}

/** new sizes for one split (after dragging a divider or evening it out) */
export function resizeSplit(tree: Pane, splitId: string, sizes: number[]): Pane {
  if (tree.kind === "leaf") return tree;
  if (tree.id === splitId) return { ...tree, sizes };
  return { ...tree, children: tree.children.map((c) => resizeSplit(c, splitId, sizes)) };
}

export function leaves(tree: Pane): LeafPane[] {
  return tree.kind === "leaf" ? [tree] : tree.children.flatMap(leaves);
}

/**
 * A layout from storage or another window, possibly in the older binary shape
 * (`{ a, b }` splits): turned into the current one, flattening a split nested
 * in the same direction.
 */
export function normalizePane(raw: unknown): Pane {
  const p = raw as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return newLeaf();
  if (p.kind === "leaf") return { kind: "leaf", id: String(p.id ?? uid()), view: String(p.view ?? "overview") };
  const dir = p.dir === "v" ? "v" : "h";
  const kids = Array.isArray(p.children) ? (p.children as unknown[]) : [p.a, p.b].filter(Boolean);
  if (kids.length === 0) return newLeaf();
  const children = kids.map(normalizePane);
  if (children.length === 1) return children[0];
  const sizes = Array.isArray(p.sizes) && p.sizes.length === children.length && p.sizes.every((x) => typeof x === "number" && x > 0)
    ? (p.sizes as number[])
    : even(children.length);
  return { kind: "split", id: String(p.id ?? uid()), dir, children, sizes };
}

interface TreeProps {
  pane: Pane;
  data: DeviceData | null;
  busy: boolean;
  error: string | null;
  fetcher: Fetcher;
  focused: string | null;
  onFocus: (leafId: string) => void;
  onSplit: (leafId: string, dir: "h" | "v") => void;
  onClose: (leafId: string) => void;
  onResize: (splitId: string, sizes: number[]) => void;
  canClose: boolean;
  /** the device terminal (SSH) for a "terminal" pane, by pane id */
  renderTerminal?: (paneId: string) => ReactNode;
}

/** the smallest a pane may be dragged to, in px */
const MIN_PANE = { h: 160, v: 90 };

export function PaneTree(props: TreeProps) {
  const { pane } = props;
  if (pane.kind === "split") return <SplitView {...props} split={pane} />;
  return <Leaf {...props} pane={pane} />;
}

function SplitView(props: TreeProps & { split: Split }) {
  const { split, onResize } = props;
  const box = useRef<HTMLDivElement>(null);
  const horizontal = split.dir === "h";

  /** drag the divider between child i and i+1 */
  function startDrag(i: number, e: ReactPointerEvent<HTMLDivElement>) {
    const el = box.current;
    if (!el) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const length = horizontal ? rect.width : rect.height;
    const start = horizontal ? e.clientX : e.clientY;
    const base = [...split.sizes];
    const pair = base[i] + base[i + 1];
    const min = Math.min(MIN_PANE[split.dir] / length, pair / 2);
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
    const move = (ev: PointerEvent) => {
      const delta = ((horizontal ? ev.clientX : ev.clientY) - start) / length;
      const first = Math.min(Math.max(base[i] + delta, min), pair - min);
      const next = [...base];
      next[i] = first;
      next[i + 1] = pair - first;
      onResize(split.id, next);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      document.body.style.cursor = "";
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  return (
    <div ref={box} className={`flex min-h-0 min-w-0 flex-1 ${horizontal ? "flex-row" : "flex-col"}`}>
      {split.children.map((child, i) => (
        <div key={child.id} className={`flex min-h-0 min-w-0 ${horizontal ? "flex-row" : "flex-col"}`}
          style={{ flex: `${split.sizes[i] ?? 1 / split.children.length} 1 0%` }}>
          {i > 0 && (
            <div role="separator" aria-orientation={horizontal ? "vertical" : "horizontal"}
              title="Drag to resize · double-click to even out"
              onPointerDown={(e) => startDrag(i - 1, e)}
              onDoubleClick={() => onResize(split.id, even(split.children.length))}
              className={`group flex shrink-0 items-center justify-center ${horizontal ? "w-1.5 cursor-col-resize" : "h-1.5 cursor-row-resize"}`}>
              <span className={`rounded-full bg-line transition-colors group-hover:bg-accent/70 ${horizontal ? "h-8 w-0.5" : "h-0.5 w-8"}`} />
            </div>
          )}
          <PaneTree {...props} pane={child} />
        </div>
      ))}
    </div>
  );
}

function Leaf({ pane, data, busy, error, fetcher, focused, onFocus, onSplit, onClose, canClose, renderTerminal }: TreeProps & { pane: LeafPane }) {
  const { section, Icon, group } = sectionOf(pane.view);
  const [reload, setReload] = useState(0);
  const [find, setFind] = useState("");
  const isFocused = focused === pane.id;

  return (
    <div onMouseDown={() => onFocus(pane.id)}
      className={`@container flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-panel/80 transition-colors ${
        isFocused ? "border-accent/60" : "border-line"}`}>
      <div className="flex items-center gap-1.5 border-b border-line bg-panel-2/60 px-1.5 py-1">
        <Icon size={13} className={`hidden shrink-0 @[9rem]:block ${isFocused ? "text-accent" : "text-ink-faint"}`} />
        <span className="min-w-0 truncate font-mono text-[11px] text-ink">
          {group && <span className="hidden text-ink-faint @[26rem]:inline">{group} ▸ </span>}{section.label}
        </span>
        {section.path && <span className="hidden truncate font-mono text-[10px] text-ink-faint @[34rem]:inline">/{section.path}</span>}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {section.path && (
            <>
              <div className="mr-1 hidden items-center gap-1 rounded border border-line bg-panel px-1.5 @[20rem]:flex">
                <Search size={11} className="text-ink-faint" />
                <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find"
                  className="w-20 bg-transparent py-0.5 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint" />
              </div>
              <span className="hidden @[12rem]:contents">
                <IconBtn title="Refresh" onClick={() => setReload((n) => n + 1)}><RefreshCw size={12} /></IconBtn>
              </span>
            </>
          )}
          <span className="hidden @[14rem]:contents">
            <DocsBtn sectionId={section.id} label={group ? `${group} ${section.label}` : section.label} />
          </span>
          <IconBtn title="Split right" onClick={() => onSplit(pane.id, "h")}><SplitSquareHorizontal size={13} /></IconBtn>
          <IconBtn title="Split down" onClick={() => onSplit(pane.id, "v")}><SplitSquareVertical size={13} /></IconBtn>
          {canClose && <IconBtn title="Close pane" onClick={() => onClose(pane.id)}><X size={13} /></IconBtn>}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* the terminal is SSH: it does not depend on the REST connection */}
        {section.id === "terminal" && renderTerminal ? renderTerminal(pane.id)
          : busy ? <Centered>connecting…</Centered>
          : error ? <div className="p-3 font-mono text-sm text-danger">{error}</div>
          : !data ? <Centered>no data</Centered>
          : section.path ? <RestView key={`${section.id}:${reload}`} section={section} fetcher={fetcher} find={find} />
          : <div className="min-h-0 flex-1 overflow-auto p-3"><BuiltIn id={section.id} data={data} /></div>}
      </div>
    </div>
  );
}

/** this section in MikroTik's official documentation (exact page and heading) */
function DocsBtn({ sectionId, label }: { sectionId: string; label: string }) {
  const { url, exact } = docsLink(sectionId, label);
  return (
    <IconBtn title={exact ? `Official docs: ${label}` : `Search the official docs for ${label}`} onClick={() => void openDocs(url)}>
      <BookOpen size={12} />
    </IconBtn>
  );
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" title={title} onClick={onClick}
      className="grid h-6 w-6 place-items-center rounded text-ink-faint transition hover:bg-accent/15 hover:text-accent">
      {children}
    </button>
  );
}

// ── built-in views ───────────────────────────────────────────────────────────

function BuiltIn({ id, data }: { id: string; data: DeviceData }) {
  if (id === "terminal") {
    return (
      <div className="font-mono text-sm text-ink-dim">
        <div className="mb-2 flex items-center gap-2 text-ink-faint"><Terminal size={14} /> device CLI</div>
        <p className="text-ink-faint">A real terminal arrives with the device CLI (binary API / SSH).</p>
        <p className="mt-2 text-accent">[admin@{data.identity}] &gt; <span className="wx-cursor">▌</span></p>
      </div>
    );
  }
  // dashboard
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="wx-pulse h-2 w-2 rounded-full bg-accent" />
        <h3 className="font-mono text-base font-semibold text-ink">{data.identity}</h3>
      </div>
      <p className="mt-1 font-mono text-sm text-ink-dim">RouterOS {data.version} · {data.board} ({data.architecture})</p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <Mini icon={<Cpu size={13} />} label="CPU" value={`${data.cpuLoad}%`} />
        <Mini icon={<Clock size={13} />} label="Uptime" value={data.uptime} />
        <Mini icon={<Boxes size={13} />} label="Ports" value={String(data.interfaces.length)} />
      </div>
      <div className="mt-3 flex items-center gap-1.5 font-mono text-[11px] text-ink-faint">
        <Network size={12} className="text-accent" /> {data.interfaces.length} interfaces
      </div>
    </div>
  );
}

// ── generic RouterOS menu: a list (array) or a property sheet (object) ───────

type Row = Record<string, unknown>;

/** WinBox-style flag letters, from the boolean fields RouterOS reports, each with its color */
const FLAGS: [key: string, letter: string, title: string, tone: string][] = [
  ["disabled", "X", "disabled", "text-ink-faint"],
  ["invalid", "I", "invalid", "text-danger"],
  ["dynamic", "D", "dynamic", "text-dyn"],
  ["running", "R", "running", "text-ok"],
  ["active", "A", "active", "text-ok"],
  ["slave", "S", "slave", "text-info"],
];
const HIDDEN = new Set([".id", ".nextid", "comment", ...FLAGS.map(([k]) => k)]);
const truthy = (v: unknown) => v === true || v === "true";

// values that read as a state, colored the same everywhere (status, state, running…)
const GOOD = new Set(["true", "yes", "up", "running", "bound", "established", "connected", "link-ok", "ok", "active",
  "reachable", "enabled", "done", "finished", "authorized", "registered", "permanent", "full-duplex", "master"]);
const WARN = new Set(["searching", "requesting", "offered", "waiting", "connecting", "negotiating", "syn-sent", "syn-received",
  "time-wait", "close-wait", "fin-wait", "stale", "delay", "probe", "incomplete", "rebinding", "renewing", "testing", "unknown"]);
const BAD = new Set(["false", "no", "down", "failed", "error", "invalid", "no-link", "disabled", "unreachable", "rejected",
  "timeout", "expired", "half-duplex", "not-running", "lost"]);
const IP = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?(%\S+)?$|^[0-9a-f]*:[0-9a-f:]+(\/\d{1,3})?$/i;
const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
/** columns whose true/false is itself a state (for the rest a boolean stays neutral) */
const STATE_COLS = /(^|-)(running|active|connected|enabled|link|state|status|up)($|-)/;

/** a Tailwind text color for one cell */
function tone(col: string, v: unknown): string {
  const text = fmt(v).trim().toLowerCase();
  if (!text) return "";
  if (text === "true" || text === "false") return STATE_COLS.test(col) ? (text === "true" ? "text-ok" : "text-danger") : "text-ink-dim";
  if (GOOD.has(text)) return "text-ok";
  if (WARN.has(text)) return "text-amber";
  if (BAD.has(text)) return "text-danger";
  if (MAC.test(text)) return "text-ink-dim";
  if (IP.test(text)) return "text-info";
  return "";
}

/** a whole row's tone: invalid red, disabled faint, a log line by its topics */
function rowTone(r: Row, isLog: boolean): string {
  if (truthy(r.invalid)) return "text-danger";
  if (truthy(r.disabled)) return "text-ink-faint";
  if (isLog) {
    const topics = String(r.topics ?? "");
    if (/critical|error/.test(topics)) return "text-danger";
    if (/warning/.test(topics)) return "text-amber";
    if (/debug|packet/.test(topics)) return "text-ink-faint";
  }
  return "text-ink";
}

const FLAG_COL = 44;
const MIN_COL = 36;
const MAX_AUTO = 480;
const colsKey = (sectionId: string) => `wingox.cols.${sectionId}`;
function loadWidths(sectionId: string): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(colsKey(sectionId)) ?? "{}") as Record<string, number>; } catch { return {}; }
}

let measurer: CanvasRenderingContext2D | null = null;
/** the width a column needs to show its longest value (and its header) in full */
function fitWidth(col: string, rows: Row[]): number {
  measurer ??= document.createElement("canvas").getContext("2d");
  if (!measurer) return 140;
  measurer.font = '12px "JetBrains Mono", ui-monospace, monospace';
  let w = measurer.measureText(col).width + 22; // header text + sort arrow room
  for (const r of rows) w = Math.max(w, measurer.measureText(fmt(r[col])).width);
  return Math.min(Math.max(Math.ceil(w) + 18, MIN_COL), MAX_AUTO);
}

function RestView({ section, fetcher, find }: { section: Section; fetcher: Fetcher; find: string }) {
  const [state, setState] = useState<{ loading: boolean; error: string | null; value: unknown }>({ loading: true, error: null, value: null });
  const [sort, setSort] = useState<{ col: string; asc: boolean } | null>(null);
  // column widths, like WinBox: drag a header's edge, double-click it to fit; remembered per section
  const [widths, setWidths] = useState<Record<string, number>>(() => loadWidths(section.id));
  const resizing = useRef(false);

  useEffect(() => {
    let live = true;
    fetcher(section.path!)
      .then((value) => live && setState({ loading: false, error: null, value }))
      .catch((e) => live && setState({ loading: false, error: String(e), value: null }));
    return () => { live = false; };
  }, [section.path, fetcher]);

  const rows: Row[] | null = Array.isArray(state.value) ? (state.value as Row[]) : null;

  const columns = useMemo(() => {
    if (!rows) return [];
    const seen = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r)) if (!HIDDEN.has(k)) seen.add(k);
    const first = (section.columns ?? []).filter((c) => seen.has(c));
    return [...first, ...[...seen].filter((c) => !first.includes(c))];
  }, [rows, section.columns]);

  // a column without a remembered width starts fitted to its content (capped)
  const widthOf = (c: string) => widths[c] ?? Math.min(fitWidth(c, rows ?? []), 280);
  const setWidth = (c: string, w: number) =>
    setWidths((all) => {
      const next = { ...all, [c]: Math.max(MIN_COL, Math.round(w)) };
      try { localStorage.setItem(colsKey(section.id), JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });

  function startResize(col: string, e: ReactPointerEvent<HTMLSpanElement>) {
    e.preventDefault();
    e.stopPropagation();
    resizing.current = true;
    const startX = e.clientX;
    const base = widthOf(col);
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    const move = (ev: PointerEvent) => setWidth(col, base + ev.clientX - startX);
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      document.body.style.cursor = "";
      // the click that ends a drag must not sort
      setTimeout(() => { resizing.current = false; }, 0);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  const shown = useMemo(() => {
    if (!rows) return [];
    const q = find.trim().toLowerCase();
    let list = q ? rows.filter((r) => Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(q))) : rows;
    if (sort) {
      list = [...list].sort((a, b) => {
        const x = String(a[sort.col] ?? ""), y = String(b[sort.col] ?? "");
        const n = x.localeCompare(y, undefined, { numeric: true });
        return sort.asc ? n : -n;
      });
    }
    return list;
  }, [rows, find, sort]);

  if (state.loading) return <Centered>loading /{section.path}…</Centered>;
  if (state.error) return <div className="p-3 font-mono text-xs text-danger">{state.error}</div>;

  // a settings menu (one object): a property sheet
  if (!rows) {
    const obj = (state.value ?? {}) as Row;
    const q = find.trim().toLowerCase();
    const entries = Object.entries(obj).filter(([k, v]) => !q || k.includes(q) || String(v).toLowerCase().includes(q));
    return (
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <table className="w-full font-mono text-xs">
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k} className="border-b border-line/40 last:border-0">
                <td className="w-1/3 py-1 pr-3 text-ink-faint">{k}</td>
                <td className={`break-all py-1 ${tone(k, v) || "text-ink"}`}>{fmt(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const toggleSort = (col: string) => {
    if (resizing.current) return;
    setSort((s) => (s?.col === col ? (s.asc ? { col, asc: false } : null) : { col, asc: true }));
  };
  const isLog = section.id === "log";
  const total = FLAG_COL + columns.reduce((sum, c) => sum + widthOf(c), 0);

  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="table-fixed font-mono text-xs" style={{ width: total }}>
          <colgroup>
            <col style={{ width: FLAG_COL }} />
            {columns.map((c) => <col key={c} style={{ width: widthOf(c) }} />)}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-panel-2">
            <tr className="text-left text-ink-faint">
              <th className="border-b border-line px-2 py-1 font-normal" />
              {columns.map((c) => (
                <th key={c} onClick={() => toggleSort(c)}
                  className="relative cursor-pointer select-none overflow-hidden border-b border-l border-line px-2 py-1 font-normal hover:text-ink">
                  <span className="flex items-center gap-1 overflow-hidden">
                    <span className="truncate">{c}</span>
                    {sort?.col === c && (sort.asc ? <ArrowUp size={10} className="shrink-0" /> : <ArrowDown size={10} className="shrink-0" />)}
                  </span>
                  <span role="separator" aria-orientation="vertical" title="Drag to resize · double-click to fit"
                    onPointerDown={(e) => startResize(c, e)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => { e.stopPropagation(); setWidth(c, fitWidth(c, rows)); }}
                    className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize hover:bg-accent/40" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => {
              const flags = FLAGS.filter(([k]) => truthy(r[k]));
              const rt = rowTone(r, isLog);
              const plain = rt === "text-ink";
              return (
                <RowGroup key={String(r[".id"] ?? i)} comment={r.comment ? String(r.comment) : null} span={columns.length + 1}>
                  <tr className={`border-b border-line/40 hover:bg-accent/5 ${rt}`}>
                    <td className="whitespace-nowrap px-2 py-1 font-semibold" title={flags.map(([, , t]) => t).join(", ")}>
                      {flags.map(([k, l, , t]) => <span key={k} className={t}>{l}</span>)}
                    </td>
                    {columns.map((c) => (
                      <td key={c} className={`truncate whitespace-nowrap px-2 py-1 ${plain ? tone(c, r[c]) : ""}`} title={fmt(r[c])}>{fmt(r[c])}</td>
                    ))}
                  </tr>
                </RowGroup>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 && <Centered>{rows.length ? "nothing matches" : "empty"}</Centered>}
      </div>
      <div className="flex items-center gap-3 border-t border-line bg-panel-2/60 px-2 py-0.5 font-mono text-[10px] text-ink-faint">
        <span>{shown.length === rows.length ? items(rows.length) : `${shown.length} of ${items(rows.length)}`}</span>
        <Legend rows={rows} />
      </div>
    </>
  );
}

/** the flag letters present in this list, with what they mean */
function Legend({ rows }: { rows: Row[] }) {
  const present = FLAGS.filter(([k]) => rows.some((r) => truthy(r[k])));
  if (!present.length) return null;
  return (
    <span className="ml-auto hidden gap-2 truncate @[22rem]:flex">
      {present.map(([k, l, title, t]) => (
        <span key={k}><span className={`font-semibold ${t}`}>{l}</span> {title}</span>
      ))}
    </span>
  );
}

/** a row, preceded by its `;;; comment` line like WinBox */
function RowGroup({ comment, span, children }: { comment: string | null; span: number; children: ReactNode }) {
  return (
    <>
      {comment && (
        <tr>
          <td colSpan={span} className="truncate px-2 pt-1 font-mono text-[11px] text-ink-faint">;;; {comment}</td>
        </tr>
      )}
      {children}
    </>
  );
}

const items = (n: number) => `${n} item${n === 1 ? "" : "s"}`;
const fmt = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

const Centered = ({ children }: { children: ReactNode }) => (
  <div className="grid h-full min-h-16 place-items-center font-mono text-sm text-ink-faint">{children}</div>
);

function Mini({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-panel-2 px-2 py-1.5">
      <div className="flex items-center gap-1 text-ink-faint">{icon}<span className="text-[10px] uppercase tracking-wide">{label}</span></div>
      <div className="mt-0.5 font-mono text-xs text-ink">{value}</div>
    </div>
  );
}
