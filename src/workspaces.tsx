// Saved workspaces: the open device tabs with their pane layouts, the active
// tab and the detached windows (with their place on screen), saved under a name
// and reopened as they were. A tab refers to a saved device by its profile id —
// never to a password. Live SSH sessions and router data are not saved: on
// reopening, terminals connect afresh and tables load again.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Bookmark, FolderOpen, Loader2, RefreshCw, Save, Trash2, TriangleAlert } from "lucide-react";
import type { Pane } from "./Pane";

export interface WorkspaceTab { profileId: string; layout: Pane }
export interface WorkspaceWindow extends WorkspaceTab { x: number; y: number; width: number; height: number }

export interface Workspace {
  version: 1;
  id: string;
  name: string;
  savedAt: number;
  activeProfileId: string | null;
  tabs: WorkspaceTab[];
  windows: WorkspaceWindow[];
}

/** what the current state can be saved as, and what had to be left out */
export interface Capture {
  tabs: WorkspaceTab[];
  windows: WorkspaceWindow[];
  activeProfileId: string | null;
  /** open connections that are not saved devices (cannot be reopened) */
  skipped: string[];
}

export function WorkspacesMenu({ capture, restore, openSessions }: {
  capture: () => Promise<Capture>;
  restore: (ws: Workspace) => Promise<void>;
  /** tabs + detached windows open now (reopening a workspace closes them) */
  openSessions: number;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Workspace[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; warn?: boolean } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // the tab bar scrolls (overflow) and would clip the panel: it is placed on <body>, under the button
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const toggle = () => {
    const r = box.current?.getBoundingClientRect();
    if (r) setAt({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    setOpen((o) => !o);
  };

  const refresh = () => invoke<Workspace[]>("workspaces_list").then((l) => setList(l.sort((a, b) => b.savedAt - a.savedAt))).catch(() => setList([]));
  useEffect(() => { if (open) { void refresh(); setNote(null); setConfirm(null); } }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !panel.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);

  async function save(existing?: Workspace) {
    setBusy(existing?.id ?? "new");
    try {
      const c = await capture();
      if (!c.tabs.length && !c.windows.length) {
        setNote({ text: "Nothing to save: open some saved devices first.", warn: true });
        return;
      }
      const ws: Workspace = {
        version: 1,
        id: existing?.id ?? `w${Date.now().toString(36)}`,
        name: existing?.name ?? (name.trim() || `Workspace ${new Date().toLocaleString()}`),
        savedAt: Date.now(),
        activeProfileId: c.activeProfileId,
        tabs: c.tabs,
        windows: c.windows,
      };
      await invoke("workspace_save", { workspace: ws });
      setName("");
      await refresh();
      const parts = `${c.tabs.length} tab${c.tabs.length === 1 ? "" : "s"}${c.windows.length ? ` + ${c.windows.length} window${c.windows.length === 1 ? "" : "s"}` : ""}`;
      setNote(c.skipped.length
        ? { text: `Saved "${ws.name}" (${parts}). Not saved — not saved devices: ${c.skipped.join(", ")}.`, warn: true }
        : { text: `Saved "${ws.name}" (${parts}).` });
    } catch (e) {
      setNote({ text: String(e), warn: true });
    } finally {
      setBusy(null);
    }
  }

  async function reopen(ws: Workspace) {
    if (openSessions > 0 && confirm !== ws.id) { setConfirm(ws.id); return; }
    setBusy(ws.id);
    try {
      await restore(ws);
      setOpen(false);
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  async function remove(ws: Workspace) {
    await invoke("workspace_delete", { id: ws.id }).catch(() => { /* ignore */ });
    await refresh();
  }

  return (
    <div ref={box} className="relative">
      <button type="button" onClick={toggle} title="Save these sessions, or reopen saved ones"
        className={`flex h-7 items-center gap-1.5 rounded-md px-2 font-mono text-[11px] transition ${
          open ? "bg-accent/15 text-accent" : "text-ink-faint hover:bg-panel-2 hover:text-ink"}`}>
        <Bookmark size={13} /> Workspaces
      </button>
      {open && at && createPortal(
        <div ref={panel} data-workspaces-panel style={{ position: "fixed", top: at.top, right: at.right }}
          className="wx-rise z-50 w-[22rem] rounded-lg border border-line-strong bg-panel p-3 shadow-2xl">
          <div className="mb-2 font-mono text-xs font-semibold text-ink">Save the open sessions</div>
          <div className="flex gap-1.5">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. Night shift)"
              onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
              className="min-w-0 flex-1 rounded-md border border-line-strong bg-panel-2 px-2 py-1.5 font-mono text-xs text-ink outline-none placeholder:text-ink-faint focus:border-accent" />
            <button type="button" onClick={() => void save()} disabled={!!busy}
              className="flex items-center gap-1 rounded-md bg-accent px-2.5 font-mono text-xs font-semibold text-bg hover:brightness-110 disabled:opacity-60">
              {busy === "new" ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save
            </button>
          </div>
          <p className="mt-1 text-[10.5px] leading-snug text-ink-faint">
            Tabs, their panes and sections, and detached windows with their position. Passwords are not stored here.
          </p>
          {note && (
            <p className={`mt-2 flex gap-1 text-[11px] ${note.warn ? "text-amber" : "text-ok"}`}>
              {note.warn && <TriangleAlert size={12} className="mt-0.5 shrink-0" />} {note.text}
            </p>
          )}

          <div className="mb-1 mt-3 font-mono text-xs font-semibold text-ink">Saved</div>
          {list.length === 0 && <p className="py-2 text-center text-[11px] text-ink-faint">No saved workspaces yet.</p>}
          <div className="max-h-72 space-y-1 overflow-auto">
            {list.map((ws) => (
              <div key={ws.id} className="rounded-md border border-line bg-panel-2/60 px-2 py-1.5">
                <div className="flex items-center gap-1">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs text-ink">{ws.name}</div>
                    <div className="text-[10px] text-ink-faint">
                      {ws.tabs.length} tab{ws.tabs.length === 1 ? "" : "s"}{ws.windows.length ? ` · ${ws.windows.length} window${ws.windows.length === 1 ? "" : "s"}` : ""} · {new Date(ws.savedAt).toLocaleString()}
                    </div>
                  </div>
                  <button type="button" title="Reopen these sessions" onClick={() => void reopen(ws)} disabled={!!busy}
                    className="grid h-6 w-6 place-items-center rounded text-ink-faint hover:text-accent disabled:opacity-50">
                    {busy === ws.id ? <Loader2 size={12} className="animate-spin" /> : <FolderOpen size={13} />}
                  </button>
                  <button type="button" title="Replace with the sessions open now" onClick={() => void save(ws)} disabled={!!busy}
                    className="grid h-6 w-6 place-items-center rounded text-ink-faint hover:text-accent disabled:opacity-50"><RefreshCw size={12} /></button>
                  <button type="button" title="Delete" onClick={() => void remove(ws)} disabled={!!busy}
                    className="grid h-6 w-6 place-items-center rounded text-ink-faint hover:text-danger disabled:opacity-50"><Trash2 size={12} /></button>
                </div>
                {confirm === ws.id && (
                  <div className="mt-1.5 flex items-center gap-2 text-[11px] text-amber">
                    <TriangleAlert size={12} /> This closes the {openSessions} open session{openSessions === 1 ? "" : "s"}.
                    <button type="button" onClick={() => void reopen(ws)} className="ml-auto rounded bg-amber/20 px-2 py-0.5 font-mono text-amber hover:bg-amber/30">Reopen</button>
                    <button type="button" onClick={() => setConfirm(null)} className="text-ink-faint hover:text-ink">Cancel</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/** run `jobs` with at most `limit` at a time */
export async function pool<T>(items: T[], limit: number, job: (item: T) => Promise<void>) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await job(queue.shift()!);
  });
  await Promise.all(workers);
}
