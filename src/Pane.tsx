// A tmux-like pane tree for a device tab: a leaf is one view of the device; a
// split holds two children side by side (h) or stacked (v). Panes can be split
// and closed, nesting freely.
import type { ReactNode } from "react";
import { Cpu, Clock, Boxes, Network, SplitSquareHorizontal, SplitSquareVertical, X, Terminal } from "lucide-react";

export type View = "overview" | "interfaces" | "terminal";

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

let counter = 0;
const uid = () => `n${Date.now().toString(36)}${counter++}`;

export const newLeaf = (view: View = "overview"): Pane => ({ kind: "leaf", id: uid(), view });

export function splitPane(tree: Pane, leafId: string, dir: "h" | "v"): Pane {
  if (tree.kind === "leaf") {
    if (tree.id !== leafId) return tree;
    return { kind: "split", id: uid(), dir, a: tree, b: newLeaf(tree.view) };
  }
  return { ...tree, a: splitPane(tree.a, leafId, dir), b: splitPane(tree.b, leafId, dir) };
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

interface TreeProps {
  pane: Pane;
  data: DeviceData | null;
  busy: boolean;
  error: string | null;
  onSplit: (leafId: string, dir: "h" | "v") => void;
  onClose: (leafId: string) => void;
  onView: (leafId: string, view: View) => void;
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

const VIEWS: { id: View; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "interfaces", label: "Interfaces" },
  { id: "terminal", label: "Terminal" },
];

function Leaf({ pane, data, busy, error, onSplit, onClose, onView, canClose }: TreeProps & { pane: Extract<Pane, { kind: "leaf" }> }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-panel/80">
      <div className="flex items-center gap-1 border-b border-line bg-panel-2/60 px-2 py-1">
        <select
          value={pane.view}
          onChange={(e) => onView(pane.id, e.target.value as View)}
          className="rounded bg-transparent py-0.5 font-mono text-[11px] text-ink-dim outline-none"
        >
          {VIEWS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </select>
        <div className="ml-auto flex items-center gap-0.5">
          <IconBtn title="Split right" onClick={() => onSplit(pane.id, "h")}><SplitSquareHorizontal size={13} /></IconBtn>
          <IconBtn title="Split down" onClick={() => onSplit(pane.id, "v")}><SplitSquareVertical size={13} /></IconBtn>
          {canClose && <IconBtn title="Close pane" onClick={() => onClose(pane.id)}><X size={13} /></IconBtn>}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <LeafBody view={pane.view} data={data} busy={busy} error={error} />
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

function LeafBody({ view, data, busy, error }: { view: View; data: DeviceData | null; busy: boolean; error: string | null }) {
  if (busy) return <Centered>connecting…</Centered>;
  if (error) return <div className="font-mono text-sm text-danger">{error}</div>;
  if (!data) return <Centered>no data</Centered>;

  if (view === "terminal") {
    return (
      <div className="font-mono text-sm text-ink-dim">
        <div className="mb-2 flex items-center gap-2 text-ink-faint"><Terminal size={14} /> device CLI</div>
        <p className="text-ink-faint">A real terminal arrives with the device CLI (binary API / SSH).</p>
        <p className="mt-2 text-accent">[admin@{data.identity}] &gt; <span className="wx-cursor">▌</span></p>
      </div>
    );
  }

  if (view === "interfaces") {
    return (
      <table className="w-full font-mono text-sm">
        <tbody>
          {data.interfaces.map((row, i) => (
            <tr key={i} className="border-b border-line/50 last:border-0">
              <td className="py-1.5 pr-3 text-ink">{s(row.name)}</td>
              <td className="py-1.5 pr-3 text-ink-dim">{s(row.type)}</td>
              <td className="py-1.5 pr-3">
                <span className={s(row.running) === "true" ? "text-accent" : "text-ink-faint"}>
                  {s(row.running) === "true" ? "running" : "down"}
                </span>
              </td>
              <td className="py-1.5 text-ink-faint">{s(row["mac-address"])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  // overview
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

const Centered = ({ children }: { children: ReactNode }) => (
  <div className="grid h-full place-items-center font-mono text-sm text-ink-faint">{children}</div>
);

function Mini({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-panel-2 px-2 py-1.5">
      <div className="flex items-center gap-1 text-ink-faint">{icon}<span className="text-[10px] uppercase tracking-wide">{label}</span></div>
      <div className="mt-0.5 font-mono text-xs text-ink">{value}</div>
    </div>
  );
}

const s = (v: unknown) => (v == null ? "" : String(v));
