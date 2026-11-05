// A tmux-like pane tree for a device tab: a leaf is one section of the device
// (picked from the menu sidebar); a split holds two children side by side (h)
// or stacked (v). Panes can be split and closed, nesting freely.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Cpu, Clock, Boxes, Network, SplitSquareHorizontal, SplitSquareVertical, X, Terminal, RefreshCw, Search, ArrowUp, ArrowDown,
} from "lucide-react";
import { sectionOf, type Section } from "./menu";

/** a section id from the menu (see menu.ts) */
export type View = string;

export type Pane =
  | { kind: "leaf"; id: string; view: View }
  | { kind: "split"; id: string; dir: "h" | "v"; a: Pane; b: Pane };

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

/** split a leaf in two; the new half shows `view` (or the same view), with id `newId` if given */
export function splitPane(tree: Pane, leafId: string, dir: "h" | "v", view?: View, newId?: string): Pane {
  if (tree.kind === "leaf") {
    if (tree.id !== leafId) return tree;
    return { kind: "split", id: uid(), dir, a: tree, b: { kind: "leaf", id: newId ?? uid(), view: view ?? tree.view } };
  }
  return { ...tree, a: splitPane(tree.a, leafId, dir, view, newId), b: splitPane(tree.b, leafId, dir, view, newId) };
}

export function closePane(tree: Pane, leafId: string): Pane | null {
  if (tree.kind === "leaf") return tree.id === leafId ? null : tree;
  const a = closePane(tree.a, leafId);
  const b = closePane(tree.b, leafId);
  if (a === null) return b;
  if (b === null) return a;
  return { ...tree, a, b };
}

export function setPaneView(tree: Pane, leafId: string, view: View): Pane {
  if (tree.kind === "leaf") return tree.id === leafId ? { ...tree, view } : tree;
  return { ...tree, a: setPaneView(tree.a, leafId, view), b: setPaneView(tree.b, leafId, view) };
}

export function leaves(tree: Pane): Extract<Pane, { kind: "leaf" }>[] {
  return tree.kind === "leaf" ? [tree] : [...leaves(tree.a), ...leaves(tree.b)];
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
  canClose: boolean;
}

export function PaneTree(props: TreeProps) {
  const { pane } = props;
  if (pane.kind === "split") {
    return (
      <div className={`flex min-h-0 min-w-0 flex-1 gap-1.5 ${pane.dir === "h" ? "flex-row" : "flex-col"}`}>
        <PaneTree {...props} pane={pane.a} />
        <PaneTree {...props} pane={pane.b} />
      </div>
    );
  }
  return <Leaf {...props} pane={pane} />;
}

function Leaf({ pane, data, busy, error, fetcher, focused, onFocus, onSplit, onClose, canClose }: TreeProps & { pane: Extract<Pane, { kind: "leaf" }> }) {
  const { section, Icon, group } = sectionOf(pane.view);
  const [reload, setReload] = useState(0);
  const [find, setFind] = useState("");
  const isFocused = focused === pane.id;

  return (
    <div onMouseDown={() => onFocus(pane.id)}
      className={`@container flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-panel/80 transition-colors ${
        isFocused ? "border-accent/60" : "border-line"}`}>
      <div className="flex items-center gap-1.5 border-b border-line bg-panel-2/60 px-2 py-1">
        <Icon size={13} className={`shrink-0 ${isFocused ? "text-accent" : "text-ink-faint"}`} />
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
              <IconBtn title="Refresh" onClick={() => setReload((n) => n + 1)}><RefreshCw size={12} /></IconBtn>
            </>
          )}
          <IconBtn title="Split right" onClick={() => onSplit(pane.id, "h")}><SplitSquareHorizontal size={13} /></IconBtn>
          <IconBtn title="Split down" onClick={() => onSplit(pane.id, "v")}><SplitSquareVertical size={13} /></IconBtn>
          {canClose && <IconBtn title="Close pane" onClick={() => onClose(pane.id)}><X size={13} /></IconBtn>}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {busy ? <Centered>connecting…</Centered>
          : error ? <div className="p-3 font-mono text-sm text-danger">{error}</div>
          : !data ? <Centered>no data</Centered>
          : section.path ? <RestView key={`${section.id}:${reload}`} section={section} fetcher={fetcher} find={find} />
          : <div className="min-h-0 flex-1 overflow-auto p-3"><BuiltIn id={section.id} data={data} /></div>}
      </div>
    </div>
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

/** WinBox-style flag letters, from the boolean fields RouterOS reports */
const FLAGS: [key: string, letter: string, title: string][] = [
  ["disabled", "X", "disabled"],
  ["invalid", "I", "invalid"],
  ["dynamic", "D", "dynamic"],
  ["running", "R", "running"],
  ["active", "A", "active"],
  ["slave", "S", "slave"],
];
const HIDDEN = new Set([".id", ".nextid", "comment", ...FLAGS.map(([k]) => k)]);
const truthy = (v: unknown) => v === true || v === "true";

function RestView({ section, fetcher, find }: { section: Section; fetcher: Fetcher; find: string }) {
  const [state, setState] = useState<{ loading: boolean; error: string | null; value: unknown }>({ loading: true, error: null, value: null });
  const [sort, setSort] = useState<{ col: string; asc: boolean } | null>(null);

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
                <td className="break-all py-1 text-ink">{fmt(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const toggleSort = (col: string) =>
    setSort((s) => (s?.col === col ? (s.asc ? { col, asc: false } : null) : { col, asc: true }));

  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-max min-w-full font-mono text-xs">
          <thead className="sticky top-0 z-10 bg-panel-2">
            <tr className="text-left text-ink-faint">
              <th className="w-10 border-b border-line px-2 py-1 font-normal" />
              {columns.map((c) => (
                <th key={c} onClick={() => toggleSort(c)}
                  className="cursor-pointer select-none whitespace-nowrap border-b border-l border-line px-2 py-1 font-normal hover:text-ink">
                  <span className="inline-flex items-center gap-1">
                    {c}
                    {sort?.col === c && (sort.asc ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => {
              const off = truthy(r.disabled);
              const flags = FLAGS.filter(([k]) => truthy(r[k]));
              return (
                <RowGroup key={String(r[".id"] ?? i)} comment={r.comment ? String(r.comment) : null} span={columns.length + 1}>
                  <tr className={`border-b border-line/40 hover:bg-accent/5 ${off ? "text-ink-faint" : "text-ink"}`}>
                    <td className="whitespace-nowrap px-2 py-1 text-ink-dim" title={flags.map(([, , t]) => t).join(", ")}>
                      {flags.map(([, l]) => l).join("")}
                    </td>
                    {columns.map((c) => (
                      <td key={c} className="max-w-72 truncate whitespace-nowrap px-2 py-1" title={fmt(r[c])}>{fmt(r[c])}</td>
                    ))}
                  </tr>
                </RowGroup>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 && <Centered>{rows.length ? "nothing matches" : "empty"}</Centered>}
      </div>
      <div className="border-t border-line bg-panel-2/60 px-2 py-0.5 font-mono text-[10px] text-ink-faint">
        {shown.length === rows.length ? items(rows.length) : `${shown.length} of ${items(rows.length)}`}
      </div>
    </>
  );
}

/** a row, preceded by its `;;; comment` line like WinBox */
function RowGroup({ comment, span, children }: { comment: string | null; span: number; children: ReactNode }) {
  return (
    <>
      {comment && (
        <tr>
          <td colSpan={span} className="px-2 pt-1 font-mono text-[11px] text-ink-faint">;;; {comment}</td>
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
