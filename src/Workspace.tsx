// One device's workspace: a WinBox-style menu sidebar on the left and the
// tmux-like pane tree on the right. A menu click opens that section in the
// focused pane; Ctrl/⌘-click (or middle-click) opens it in a new pane beside it.
import { useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { ChevronRight, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { MENU, type MenuItem, type Section } from "./menu";
import { PaneTree, closePane, leaves, newLeaf, paneId, resizeSplit, setPaneView, splitPane, type DeviceData, type Pane } from "./Pane";
import { restGet, type Profile } from "./App";

interface Props {
  profile: Profile;
  data: DeviceData | null;
  busy: boolean;
  error: string | null;
  layout: Pane;
  setLayout: (f: (l: Pane) => Pane) => void;
}

export function Workspace({ profile, data, busy, error, layout, setLayout }: Props) {
  const all = leaves(layout);
  const [focused, setFocused] = useState<string | null>(all[0]?.id ?? null);
  // keep the focus on a pane that still exists
  const focusId = all.some((l) => l.id === focused) ? focused : all[0]?.id ?? null;
  const focusedView = all.find((l) => l.id === focusId)?.view;
  const openViews = new Set(all.map((l) => l.view));

  const fetcher = useCallback((path: string) => restGet(profile, path), [profile]);

  function openSection(id: string, inNewPane: boolean) {
    if (!focusId) return;
    if (inNewPane) {
      // like a new WinBox window: the new pane takes the focus
      const fresh = paneId();
      setLayout((l) => splitPane(l, focusId, "h", id, fresh));
      setFocused(fresh);
    } else {
      setLayout((l) => setPaneView(l, focusId, id));
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <MenuSidebar onOpen={openSection} focusedView={focusedView} openViews={openViews} />
      <div className="flex min-h-0 min-w-0 flex-1 p-2">
        <PaneTree
          pane={layout}
          data={data}
          busy={busy}
          error={error}
          fetcher={fetcher}
          focused={focusId}
          onFocus={setFocused}
          canClose={layout.kind === "split"}
          onSplit={(leaf, dir) => setLayout((l) => splitPane(l, leaf, dir))}
          onClose={(leaf) => setLayout((l) => closePane(l, leaf) ?? newLeaf())}
          onResize={(split, sizes) => setLayout((l) => resizeSplit(l, split, sizes))}
        />
      </div>
    </div>
  );
}

const COLLAPSE_KEY = "wingox.menu.collapsed";
const OPEN_KEY = "wingox.menu.open";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

function MenuSidebar({ onOpen, focusedView, openViews }: {
  onOpen: (id: string, inNewPane: boolean) => void;
  focusedView: string | undefined;
  openViews: Set<string>;
}) {
  const [collapsed, setCollapsed] = useState<boolean>(() => load(COLLAPSE_KEY, false));
  const [expanded, setExpanded] = useState<string[]>(() => load(OPEN_KEY, ["ip"]));
  const [query, setQuery] = useState("");
  useEffect(() => store(COLLAPSE_KEY, collapsed), [collapsed]);
  useEffect(() => store(OPEN_KEY, expanded), [expanded]);

  const q = query.trim().toLowerCase();
  // while searching, show only matching entries, with their groups unfolded
  const items = useMemo(() => {
    if (!q) return MENU;
    const hit = (s: string) => s.toLowerCase().includes(q);
    return MENU.flatMap((m): MenuItem[] => {
      if (!m.children) return hit(m.label) || hit(m.section?.path ?? "") ? [m] : [];
      if (hit(m.label)) return [m];
      const kids = m.children.filter((c) => hit(c.label) || hit(c.path ?? ""));
      return kids.length ? [{ ...m, children: kids }] : [];
    });
  }, [q]);

  const toggle = (id: string) => setExpanded((e) => (e.includes(id) ? e.filter((x) => x !== id) : [...e, id]));
  const click = (s: Section) => (e: MouseEvent) => onOpen(s.id, e.ctrlKey || e.metaKey);
  const middle = (s: Section) => (e: MouseEvent) => { if (e.button === 1) { e.preventDefault(); onOpen(s.id, true); } };

  if (collapsed) {
    return (
      <nav className="flex w-11 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-line/80 bg-panel/50 py-1.5">
        <RailBtn title="Expand menu" onClick={() => setCollapsed(false)}><PanelLeftOpen size={15} /></RailBtn>
        <div className="my-1 h-px w-6 bg-line" />
        {MENU.map((m) => {
          const active = m.section ? focusedView === m.section.id : m.children!.some((c) => c.id === focusedView);
          return (
            <RailBtn key={m.id} title={m.label} active={active}
              onClick={(e) => {
                if (m.section) return onOpen(m.section.id, e.ctrlKey || e.metaKey);
                setExpanded((x) => (x.includes(m.id) ? x : [...x, m.id]));
                setCollapsed(false);
              }}>
              <m.Icon size={15} />
            </RailBtn>
          );
        })}
      </nav>
    );
  }

  return (
    <nav className="flex w-52 shrink-0 flex-col border-r border-line/80 bg-panel/50">
      <div className="flex items-center gap-1 px-2 pb-1 pt-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line bg-panel px-2">
          <Search size={12} className="shrink-0 text-ink-faint" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find menu…"
            className="w-full bg-transparent py-1 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint" />
        </div>
        <RailBtn title="Collapse menu" onClick={() => setCollapsed(true)}><PanelLeftClose size={14} /></RailBtn>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {items.map((m) => {
          if (m.section) {
            const s = m.section;
            return (
              <Entry key={m.id} onClick={click(s)} onMouseDown={middle(s)}
                active={focusedView === s.id} open={openViews.has(s.id)}>
                <m.Icon size={14} className="shrink-0" />
                <span className="truncate">{m.label}</span>
              </Entry>
            );
          }
          const isOpen = !!q || expanded.includes(m.id);
          const holds = m.children!.some((c) => c.id === focusedView);
          return (
            <div key={m.id}>
              <Entry onClick={() => toggle(m.id)} active={false} open={holds && !isOpen}>
                <m.Icon size={14} className="shrink-0" />
                <span className="truncate">{m.label}</span>
                <ChevronRight size={12} className={`ml-auto shrink-0 text-ink-faint transition-transform ${isOpen ? "rotate-90" : ""}`} />
              </Entry>
              {isOpen && (
                <div className="mb-0.5 ml-[15px] border-l border-line pl-1.5">
                  {m.children!.map((c) => (
                    <Entry key={c.id} onClick={click(c)} onMouseDown={middle(c)}
                      active={focusedView === c.id} open={openViews.has(c.id)} sub>
                      <span className="truncate">{c.label}</span>
                    </Entry>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {items.length === 0 && <p className="px-2 py-3 text-center font-mono text-[11px] text-ink-faint">no menu matches</p>}
      </div>
      <p className="border-t border-line/80 px-2.5 py-1.5 text-[10px] leading-snug text-ink-faint">
        Click opens in the focused pane · <kbd className="font-mono">Ctrl</kbd>+click in a new one
      </p>
    </nav>
  );
}

function Entry({ children, onClick, onMouseDown, active, open, sub }: {
  children: ReactNode;
  onClick: (e: MouseEvent) => void;
  onMouseDown?: (e: MouseEvent) => void;
  active: boolean;
  /** shown in some pane (not necessarily the focused one) */
  open: boolean;
  sub?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} onMouseDown={onMouseDown}
      className={`relative flex w-full items-center gap-2 rounded-md px-2 text-left font-mono transition ${
        sub ? "py-[3px] text-[11.5px]" : "py-1 text-xs"} ${
        active ? "bg-accent/15 text-accent" : open ? "text-ink" : "text-ink-dim hover:bg-panel-2 hover:text-ink"}`}>
      {open && !active && <span className="absolute left-0 top-1/2 h-3 w-0.5 -translate-y-1/2 rounded bg-accent/70" />}
      {children}
    </button>
  );
}

function RailBtn({ title, onClick, active, children }: {
  title: string;
  onClick: (e: MouseEvent) => void;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button type="button" title={title} onClick={onClick}
      className={`grid h-7 w-7 shrink-0 place-items-center rounded-md transition ${
        active ? "bg-accent/15 text-accent" : "text-ink-faint hover:bg-panel-2 hover:text-ink"}`}>
      {children}
    </button>
  );
}
