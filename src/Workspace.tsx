// One device's workspace: a WinBox-style menu sidebar on the left and the
// tmux-like pane tree on the right. A menu click opens that section in the
// focused pane; Ctrl/⌘-click (or middle-click) opens it in a new pane beside it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Loader2, PanelLeftClose, PanelLeftOpen, RefreshCw, Search, TriangleAlert, X } from "lucide-react";
import { MenuContext, sectionOf, under, type MenuEntry, type MenuItem, type MenuModel, type Section } from "./menu";
import { useRouterMenu, type MenuStatus } from "./routerMenu";
import { PaneTree, closePane, leaves, newLeaf, paneId, resizeSplit, setPaneView, splitPane, type DeviceData, type Pane } from "./Pane";
import { restGet, type Profile } from "./App";
import { SshTerminal } from "./Terminal";
import { makeApi } from "./rest";
import { AccessContext, type Access } from "./risk";

interface Props {
  profile: Profile;
  data: DeviceData | null;
  busy: boolean;
  error: string | null;
  layout: Pane;
  setLayout: (f: (l: Pane) => Pane) => void;
  /** the profile changed here (e.g. its SSH host key was pinned) */
  onProfileChange: (p: Profile) => void;
}

export function Workspace({ profile, data, busy, error, layout, setLayout, onProfileChange }: Props) {
  const all = leaves(layout);
  const [focused, setFocused] = useState<string | null>(all[0]?.id ?? null);
  // keep the focus on a pane that still exists
  const focusId = all.some((l) => l.id === focused) ? focused : all[0]?.id ?? null;
  const focusedView = all.find((l) => l.id === focusId)?.view;
  const openViews = new Set(all.map((l) => l.view));

  const fetcher = useCallback((path: string) => restGet(profile, path), [profile]);
  const api = useMemo(() => makeApi(profile), [profile]);
  // how Wingox reaches this router, for the "this may cut your access" warnings:
  // the interfaces that carry the address it connects to (none behind NAT)
  const [mgmtIfaces, setMgmtIfaces] = useState<string[]>([]);
  const connected = !!data;
  useEffect(() => {
    if (!connected) return;
    let live = true;
    api.get("ip/address")
      .then((rows) => {
        if (!live || !Array.isArray(rows)) return;
        setMgmtIfaces((rows as Record<string, unknown>[])
          .filter((r) => String(r.address ?? "").split("/")[0] === profile.host)
          .map((r) => String(r.interface ?? "")).filter(Boolean));
      })
      .catch(() => { /* no rights to read it: only the other checks apply */ });
    return () => { live = false; };
  }, [api, connected, profile.host]);
  const access: Access = useMemo(() => ({
    host: profile.host, scheme: profile.scheme ?? "https", port: profile.port, sshPort: profile.sshPort ?? 22,
    username: profile.username, interfaces: mgmtIfaces,
  }), [profile.host, profile.scheme, profile.port, profile.sshPort, profile.username, mgmtIfaces]);
  // the menu: this router's own tree (cached), the curated one until then
  const menu = useRouterMenu(profile, data?.version);

  // Terminals must outlive layout changes: splitting or closing a neighbour
  // remounts the pane tree, and an SSH session must not drop because of that.
  // Each terminal renders (via a portal) into a DOM node owned here, keyed by
  // its pane id; the pane only lends it a slot. It ends when its pane is closed
  // or switched to another view.
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const terminalPanes = all.filter((l) => l.view === "terminal").map((l) => l.id);
  const nodeFor = (id: string) => {
    let el = nodes.current.get(id);
    if (!el) {
      el = document.createElement("div");
      el.className = "flex min-h-0 flex-1 flex-col";
      nodes.current.set(id, el);
    }
    return el;
  };
  for (const id of [...nodes.current.keys()]) if (!terminalPanes.includes(id)) nodes.current.delete(id);

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
    <MenuContext.Provider value={menu.model}>
    <AccessContext.Provider value={access}>
    <div className="flex min-h-0 min-w-0 flex-1">
      <MenuSidebar model={menu.model} status={menu.status} onRefresh={menu.refresh}
        onOpen={openSection} focusedView={focusedView} openViews={openViews} />
      <div className="flex min-h-0 min-w-0 flex-1 p-2">
        <PaneTree
          pane={layout}
          data={data}
          busy={busy}
          error={error}
          fetcher={fetcher}
          api={api}
          focused={focusId}
          onFocus={setFocused}
          canClose={layout.kind === "split"}
          onSplit={(leaf, dir) => setLayout((l) => splitPane(l, leaf, dir))}
          onClose={(leaf) => setLayout((l) => closePane(l, leaf) ?? newLeaf())}
          onView={(leaf, view) => setLayout((l) => setPaneView(l, leaf, view))}
          onResize={(split, sizes) => setLayout((l) => resizeSplit(l, split, sizes))}
          renderTerminal={(id) => <TerminalSlot node={nodeFor(id)} />}
        />
      </div>
      {terminalPanes.map((id) => createPortal(
        <SshTerminal profile={profile} onPinHostKey={(key) => onProfileChange({ ...profile, sshHostKey: key })}
          onSshPort={(sshPort) => onProfileChange({ ...profile, sshPort, sshHostKey: "" })} />,
        nodeFor(id),
        id,
      ))}
    </div>
    </AccessContext.Provider>
    </MenuContext.Provider>
  );
}

/** where a pane shows its (longer-lived) terminal */
function TerminalSlot({ node }: { node: HTMLDivElement }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = slot.current!;
    host.appendChild(node);
    return () => { if (node.parentNode === host) host.removeChild(node); };
  }, [node]);
  return <div ref={slot} className="flex min-h-0 flex-1 flex-col" />;
}

const COLLAPSE_KEY = "wingox.menu.collapsed";

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

function MenuSidebar({ model, status, onRefresh, onOpen, focusedView, openViews }: {
  model: MenuModel;
  status: MenuStatus;
  onRefresh: () => void;
  onOpen: (id: string, inNewPane: boolean) => void;
  focusedView: string | undefined;
  openViews: Set<string>;
}) {
  const [collapsed, setCollapsed] = useState<boolean>(() => load(COLLAPSE_KEY, false));
  const [query, setQuery] = useState("");
  /** the group whose submenu is showing, and where (like WinBox's IP ▸ flyout) */
  const [fly, setFly] = useState<{ item: MenuItem; top: number; left: number } | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  useEffect(() => store(COLLAPSE_KEY, collapsed), [collapsed]);

  const MENU = model.items;
  const focusedItem = focusedView ? model.itemOf(focusedView) : undefined;
  const focusedPath = focusedView ? sectionOf(focusedView).section.path : undefined;
  const openItems = useMemo(() => new Set([...openViews].map((v) => model.itemOf(v))), [openViews, model]);
  /** a group's entry stands for a menu and everything under it (a window with tabs) */
  const entryHolds = (item: MenuItem, c: MenuEntry, path: string | undefined, itemId: string | undefined) =>
    itemId === item.id && !!path && under(path, c.under ?? c.path ?? "");

  const q = query.trim().toLowerCase();
  // while searching: every section of the device that matches, under its sidebar entry
  const results = useMemo(() => {
    if (!q) return [];
    const hit = (x: string) => x.toLowerCase().includes(q);
    const out: { item: MenuItem; entries: MenuEntry[] }[] = [];
    for (const m of MENU) {
      if (m.section && !m.section.path) { if (hit(m.label)) out.push({ item: m, entries: [] }); continue; }
      const entries: MenuEntry[] = model.sections
        .filter(({ section, item }) => item === m.label && (hit(section.label) || hit(section.path ?? "") || hit(m.label)))
        .map(({ section }) => ({ ...section, under: section.path }));
      if (entries.length) out.push({ item: m, entries });
    }
    return out;
  }, [q, MENU, model]);

  const open = (s: Section, e: MouseEvent) => { onOpen(s.id, e.ctrlKey || e.metaKey); setFly(null); };
  const middle = (s: Section) => (e: MouseEvent) => { if (e.button === 1) { e.preventDefault(); onOpen(s.id, true); setFly(null); } };

  // the submenu opens on hover (or click) and closes shortly after the pointer leaves both
  const showFly = (item: MenuItem, el: HTMLElement) => {
    window.clearTimeout(closeTimer.current);
    const r = el.getBoundingClientRect();
    setFly({ item, top: r.top, left: r.right });
  };
  const keepFly = () => window.clearTimeout(closeTimer.current);
  const dropFly = () => { closeTimer.current = window.setTimeout(() => setFly(null), 160); };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  /** one top-level entry: a leaf opens its section, a group shows its submenu */
  const top = (m: MenuItem, rail: boolean) => {
    const active = focusedItem === m.id;
    const flyOpen = fly?.item.id === m.id;
    const common = `relative flex w-full items-center gap-2 font-mono text-xs transition ${
      active ? "bg-accent/15 text-accent" : flyOpen ? "bg-panel-2 text-ink" : openItems.has(m.id) ? "text-ink hover:bg-panel-2" : "text-ink-dim hover:bg-panel-2 hover:text-ink"}`;
    if (m.section) {
      const s = m.section;
      return (
        <button key={m.id} type="button" title={rail ? m.label : undefined} onClick={(e) => open(s, e)} onMouseDown={middle(s)}
          onMouseEnter={dropFly}
          className={`${common} ${rail ? "h-8 justify-center rounded-md" : "h-[26px] rounded px-2"}`}>
          {openItems.has(m.id) && !active && <span className="absolute left-0 top-1/2 h-3 w-0.5 -translate-y-1/2 rounded bg-accent/70" />}
          <m.Icon size={rail ? 15 : 14} className="shrink-0" />
          {!rail && <span className="truncate">{m.label}</span>}
        </button>
      );
    }
    return (
      <button key={m.id} type="button" title={rail ? m.label : undefined} aria-haspopup="menu" aria-expanded={flyOpen}
        onMouseEnter={(e) => showFly(m, e.currentTarget)} onMouseLeave={dropFly}
        onClick={(e) => (flyOpen ? setFly(null) : showFly(m, e.currentTarget))}
        className={`${common} ${rail ? "h-8 justify-center rounded-md" : "h-[26px] rounded px-2"}`}>
        {openItems.has(m.id) && !active && <span className="absolute left-0 top-1/2 h-3 w-0.5 -translate-y-1/2 rounded bg-accent/70" />}
        <m.Icon size={rail ? 15 : 14} className="shrink-0" />
        {!rail && <span className="truncate">{m.label}</span>}
        {!rail && <ChevronRight size={12} className="ml-auto shrink-0 text-ink-faint" />}
      </button>
    );
  };

  const flyout = fly && createPortal(
    <Flyout top={fly.top} left={fly.left} onMouseEnter={keepFly} onMouseLeave={dropFly}>
      {[...fly.item.children!].sort((a, b) => a.label.localeCompare(b.label)).map((c) => {
        const act = entryHolds(fly.item, c, focusedPath, focusedItem);
        const isOpen = [...openViews].some((v) => entryHolds(fly.item, c, sectionOf(v).section.path, model.itemOf(v)));
        return (
          <button key={c.under ?? c.id} type="button" role="menuitem" onClick={(e) => open(c, e)} onMouseDown={middle(c)}
            title={c.path ? `/${c.path}` : undefined}
            className={`relative flex w-full items-center whitespace-nowrap px-3 py-[3px] text-left font-mono text-xs transition ${
              act ? "bg-accent/15 text-accent" : isOpen ? "text-ink hover:bg-accent/10" : "text-ink-dim hover:bg-accent/10 hover:text-ink"}`}>
            {isOpen && !act && <span className="absolute left-0.5 top-1/2 h-3 w-0.5 -translate-y-1/2 rounded bg-accent/70" />}
            {c.label}
          </button>
        );
      })}
    </Flyout>,
    document.body,
  );

  if (collapsed) {
    return (
      <nav className="flex w-11 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-line/80 bg-panel/50 px-1 py-1.5">
        <RailBtn title="Expand menu" onClick={() => setCollapsed(false)}><PanelLeftOpen size={15} /></RailBtn>
        <div className="my-1 h-px w-6 bg-line" />
        {MENU.map((m) => top(m, true))}
        {flyout}
      </nav>
    );
  }

  return (
    <nav className="flex w-48 shrink-0 flex-col border-r border-line/80 bg-panel/50">
      <div className="flex items-center gap-1 px-1.5 pb-1 pt-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded border border-line bg-panel px-1.5">
          <Search size={11} className="shrink-0 text-ink-faint" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find menu…"
            className="w-full bg-transparent py-[3px] font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint" />
          {query && <button type="button" onClick={() => setQuery("")} className="text-ink-faint hover:text-ink"><X size={11} /></button>}
        </div>
        <RailBtn title="Collapse menu" onClick={() => setCollapsed(true)}><PanelLeftClose size={14} /></RailBtn>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2" onScroll={() => setFly(null)}>
        {!q && MENU.map((m) => top(m, false))}
        {q && results.map(({ item, entries }) => (
          <div key={item.id} className="mb-1">
            {entries.length === 0 ? top(item, false) : (
              <>
                <div className="flex items-center gap-2 px-2 pt-1 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
                  <item.Icon size={11} /> {item.label}
                </div>
                {entries.map((c) => (
                  <button key={c.under ?? c.id} type="button" onClick={(e) => open(c, e)} onMouseDown={middle(c)}
                    className={`flex w-full items-center gap-2 rounded px-2 py-[3px] pl-6 text-left font-mono text-xs transition ${
                      entryHolds(item, c, focusedPath, focusedItem) ? "bg-accent/15 text-accent" : "text-ink-dim hover:bg-panel-2 hover:text-ink"}`}>
                    <span className="truncate">{c.label}</span>
                    {c.path && <span className="ml-auto truncate pl-1 text-[9.5px] text-ink-faint">{c.path}</span>}
                  </button>
                ))}
              </>
            )}
          </div>
        ))}
        {q && results.length === 0 && <p className="px-2 py-3 text-center font-mono text-[11px] text-ink-faint">no menu matches</p>}
      </div>
      <MenuSource model={model} status={status} onRefresh={onRefresh} />
      {flyout}
    </nav>
  );
}

/** a submenu beside its entry, moved up as needed to fit in the window */
function Flyout({ top, left, children, onMouseEnter, onMouseLeave }: {
  top: number;
  left: number;
  children: ReactNode;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [y, setY] = useState(top - 4);
  useLayoutEffect(() => {
    const h = box.current?.offsetHeight ?? 0;
    setY(Math.max(8, Math.min(top - 4, window.innerHeight - h - 8)));
  }, [top, children]);
  return (
    <div ref={box} role="menu" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{ top: y, left: left + 2 }}
      className="fixed z-50 max-h-[calc(100vh-16px)] min-w-44 overflow-y-auto rounded-md border border-line-strong bg-panel py-1 shadow-xl">
      {children}
    </div>
  );
}

/** where the menu comes from: the router's own tree, or the curated fallback */
function MenuSource({ model, status, onRefresh }: { model: MenuModel; status: MenuStatus; onRefresh: () => void }) {
  const count = model.sections.length;
  const when = status.at ? new Date(status.at).toLocaleString() : "";
  let text: ReactNode;
  let title: string;
  if (status.state === "loading") {
    text = <><Loader2 size={11} className="animate-spin text-accent" /> reading the router's menus…</>;
    title = "Reading this router's menu tree (console/inspect). The curated menu is shown meanwhile.";
  } else if (status.state === "error") {
    text = <><TriangleAlert size={11} className="text-amber" /> {model.fromRouter ? `${count} menus (old copy)` : `curated menu · ${count}`}</>;
    title = `Could not read this router's menus: ${status.error ?? "unknown error"}`;
  } else if (model.fromRouter) {
    text = <>{count} menus from the router</>;
    title = `This router's own menu tree, read ${when}. Re-read it after installing or removing packages.`;
  } else {
    text = <>curated menu · {count}</>;
    title = "The router's menu tree has not been read yet.";
  }
  return (
    <div className="flex items-center gap-1 border-t border-line/80 px-2.5 py-1 font-mono text-[10px] text-ink-faint" title={title}>
      <span className="flex min-w-0 flex-1 items-center gap-1 truncate">{text}</span>
      {status.state !== "loading" && status.state !== "static" && (
        <button type="button" onClick={onRefresh} title="Read the router's menus again"
          className="grid h-5 w-5 shrink-0 place-items-center rounded transition hover:bg-accent/15 hover:text-accent">
          <RefreshCw size={11} />
        </button>
      )}
    </div>
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
