import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Server, ShieldAlert, Network, Loader2, Terminal, Moon, Sun, SquareTerminal, Flame,
  User, KeyRound, Plus, Play, Trash2, Save, Router, X,
} from "lucide-react";
import { AmbientNetwork } from "./AmbientNetwork";
import { PaneTree, closePane, newLeaf, setPaneView, splitPane, type DeviceData, type Pane, type View } from "./Pane";

type ProxyKind = "socks5" | "http";

interface Proxy { kind: ProxyKind; host: string; port: number; username: string; password: string }

export interface Profile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  insecure: boolean;
  proxy: Proxy | null;
}

/** an open device: its connection, what it answered, and its pane layout */
interface Tab {
  id: string;
  profile: Profile;
  data: DeviceData | null;
  busy: boolean;
  error: string | null;
  layout: Pane;
}

const THEMES = [
  { id: "dark", label: "Dark", Icon: Moon },
  { id: "light", label: "Light", Icon: Sun },
  { id: "terminal", label: "Terminal", Icon: SquareTerminal },
  { id: "amber", label: "Amber", Icon: Flame },
] as const;
type ThemeId = (typeof THEMES)[number]["id"];

function useTheme() {
  const [theme, setTheme] = useState<ThemeId>(() => {
    try {
      const saved = localStorage.getItem("wingox.theme");
      if (saved && THEMES.some((t) => t.id === saved)) return saved as ThemeId;
    } catch { /* ignore */ }
    return "dark";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("wingox.theme", theme); } catch { /* ignore */ }
  }, [theme]);
  return [theme, setTheme] as const;
}

const emptyProxy = (): Proxy => ({ kind: "socks5", host: "", port: 1080, username: "", password: "" });
const blank = (): Profile => ({ id: "", name: "", host: "", port: 443, username: "admin", password: "", insecure: true, proxy: null });
const label = (p: Profile) => p.name.trim() || p.host || "device";

async function probe(p: Profile): Promise<DeviceData> {
  return invoke<DeviceData>("connect", {
    args: {
      host: p.host, port: p.port, username: p.username, password: p.password, insecure: p.insecure,
      proxy: p.proxy
        ? { kind: p.proxy.kind, host: p.proxy.host, port: p.proxy.port, username: p.proxy.username || null, password: p.proxy.password || null }
        : null,
    },
  });
}

export function App() {
  const [theme, setTheme] = useTheme();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>("new");
  const [draft, setDraft] = useState<Profile>(blank);
  const [useProxy, setUseProxy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setProfiles(await invoke<Profile[]>("profiles_list")); }
    catch (e) { console.warn("profiles_list:", e); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const patchTab = (id: string, change: Partial<Tab>) =>
    setTabs((list) => list.map((t) => (t.id === id ? { ...t, ...change } : t)));

  /** open (or refocus) a tab for a device and connect it */
  const open = useCallback(async (p: Profile) => {
    const id = p.id || `t${Date.now().toString(36)}`;
    setTabs((list) => {
      const existing = list.find((t) => t.id === id);
      if (existing) return list.map((t) => (t.id === id ? { ...t, profile: p, busy: true, error: null } : t));
      return [...list, { id, profile: p, data: null, busy: true, error: null, layout: newLeaf("overview") }];
    });
    setActive(id);
    try {
      const data = await probe(p);
      patchTab(id, { data, busy: false, error: null });
    } catch (e) {
      patchTab(id, { busy: false, error: String(e) });
    }
  }, []);

  function closeTab(id: string) {
    setTabs((list) => {
      const next = list.filter((t) => t.id !== id);
      if (active === id) setActive(next.length ? next[next.length - 1].id : "new");
      return next;
    });
  }

  function editProfile(p: Profile) {
    setDraft({ ...p, proxy: p.proxy ? { ...p.proxy } : null });
    setUseProxy(!!p.proxy);
    setFormError(null);
    setActive("new");
  }
  function newProfile() {
    setDraft(blank());
    setUseProxy(false);
    setFormError(null);
    setActive("new");
  }

  const current = (): Profile => ({ ...draft, proxy: useProxy ? draft.proxy ?? emptyProxy() : null });

  async function save() {
    try {
      const saved = await invoke<Profile>("profile_save", { profile: { ...current(), name: label(draft) } });
      setDraft(saved);
      await refresh();
    } catch (e) { setFormError(String(e)); }
  }
  async function remove(id: string) {
    try {
      await invoke("profile_delete", { id });
      if (draft.id === id) newProfile();
      await refresh();
    } catch (e) { setFormError(String(e)); }
  }

  const tab = tabs.find((t) => t.id === active);

  return (
    <div className="flex h-full flex-col">
      <AmbientNetwork />

      <header className="flex items-center gap-3 border-b border-line/80 px-5 py-3 backdrop-blur-sm">
        <span className="grid h-9 w-9 place-items-center rounded-md bg-accent/15 text-accent"><Terminal size={18} /></span>
        <div>
          <h1 className="font-mono text-base font-semibold tracking-tight text-ink">wingox<span className="wx-cursor text-accent">▌</span></h1>
          <p className="text-[11px] text-ink-faint">manage MikroTik RouterOS — through a proxy or a jump</p>
        </div>
        <div className="ml-auto flex items-center gap-1 rounded-lg border border-line bg-panel/70 p-1">
          {THEMES.map(({ id, label: name, Icon }) => (
            <button key={id} type="button" title={name} onClick={() => setTheme(id)}
              className={`grid h-7 w-7 place-items-center rounded-md transition ${theme === id ? "bg-accent/20 text-accent" : "text-ink-faint hover:text-ink"}`}>
              <Icon size={15} />
            </button>
          ))}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* devices */}
        <aside className="flex w-60 shrink-0 flex-col border-r border-line/80 bg-panel/40">
          <div className="flex items-center justify-between px-3 py-2.5">
            <span className="font-mono text-xs uppercase tracking-wide text-ink-faint">Devices</span>
            <button type="button" title="New device" onClick={newProfile}
              className="grid h-6 w-6 place-items-center rounded text-ink-faint hover:bg-accent/15 hover:text-accent"><Plus size={15} /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
            {profiles.length === 0 && (
              <p className="px-2 py-4 text-center text-xs text-ink-faint">No saved devices yet.<br />Fill the form and Save.</p>
            )}
            {profiles.map((p) => {
              const open_ = tabs.some((t) => t.id === p.id);
              return (
                <div key={p.id} onClick={() => (open_ ? setActive(p.id) : editProfile(p))}
                  className={`group mb-1 flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 transition ${
                    active === p.id || (active === "new" && draft.id === p.id) ? "border-accent/50 bg-accent/10" : "border-transparent hover:bg-panel-2"}`}>
                  <Router size={15} className={open_ ? "text-accent" : "text-ink-faint"} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-sm text-ink">{p.name}</div>
                    <div className="truncate text-[11px] text-ink-faint">{p.host}:{p.port}{p.proxy ? " · proxy" : ""}</div>
                  </div>
                  <button type="button" title="Open" onClick={(e) => { e.stopPropagation(); void open(p); }}
                    className="hidden h-6 w-6 place-items-center rounded text-ink-faint hover:text-accent group-hover:grid"><Play size={13} /></button>
                  <button type="button" title="Delete" onClick={(e) => { e.stopPropagation(); void remove(p.id); }}
                    className="hidden h-6 w-6 place-items-center rounded text-ink-faint hover:text-danger group-hover:grid"><Trash2 size={13} /></button>
                </div>
              );
            })}
          </div>
        </aside>

        {/* workspace */}
        <section className="flex min-w-0 flex-1 flex-col">
          <nav className="flex items-end gap-1 overflow-x-auto border-b border-line/80 px-2 pt-2">
            {tabs.map((t) => (
              <div key={t.id} onClick={() => setActive(t.id)}
                className={`group flex cursor-pointer items-center gap-2 rounded-t-md border border-b-0 px-3 py-1.5 font-mono text-xs transition ${
                  active === t.id ? "border-line bg-panel text-ink" : "border-transparent text-ink-faint hover:text-ink"}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${t.error ? "bg-danger" : t.busy ? "bg-amber" : "bg-accent"}`} />
                <span className="max-w-40 truncate">{label(t.profile)}</span>
                <button type="button" title="Close tab" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                  className="grid h-4 w-4 place-items-center rounded text-ink-faint opacity-60 hover:text-danger hover:opacity-100"><X size={11} /></button>
              </div>
            ))}
            <button type="button" title="New connection" onClick={newProfile}
              className={`mb-1 grid h-7 w-7 place-items-center rounded-md transition ${active === "new" ? "bg-accent/20 text-accent" : "text-ink-faint hover:text-ink"}`}>
              <Plus size={14} />
            </button>
          </nav>

          <div className="flex min-h-0 flex-1 p-2">
            {tab ? (
              <PaneTree
                pane={tab.layout}
                data={tab.data}
                busy={tab.busy}
                error={tab.error}
                canClose={tab.layout.kind === "split"}
                onSplit={(leaf, dir) => patchTab(tab.id, { layout: splitPane(tab.layout, leaf, dir) })}
                onClose={(leaf) => patchTab(tab.id, { layout: closePane(tab.layout, leaf) ?? newLeaf() })}
                onView={(leaf, view: View) => patchTab(tab.id, { layout: setPaneView(tab.layout, leaf, view) })}
              />
            ) : (
              <div className="min-h-0 flex-1 overflow-auto">
                <ConnectionForm
                  draft={draft} setDraft={setDraft} useProxy={useProxy} setUseProxy={setUseProxy} error={formError}
                  onConnect={() => void open({ ...current(), id: draft.id })} onSave={() => void save()}
                />
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function ConnectionForm({ draft, setDraft, useProxy, setUseProxy, error, onConnect, onSave }: {
  draft: Profile;
  setDraft: (f: (d: Profile) => Profile) => void;
  useProxy: boolean;
  setUseProxy: (v: boolean) => void;
  error: string | null;
  onConnect: () => void;
  onSave: () => void;
}) {
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const proxy = draft.proxy ?? emptyProxy();
  const setProxy = <K extends keyof Proxy>(k: K, v: Proxy[K]) => setDraft((d) => ({ ...d, proxy: { ...(d.proxy ?? emptyProxy()), [k]: v } }));
  const submit = (e: FormEvent) => { e.preventDefault(); onConnect(); };

  return (
    <form onSubmit={submit} className="wx-rise mx-auto mt-6 w-full max-w-md rounded-xl border border-line bg-panel/90 p-5">
      <h2 className="mb-4 flex items-center gap-2 font-mono text-sm font-semibold text-ink-dim">
        <Server size={15} className="text-accent" /> {draft.id ? "Edit device" : "New connection"}
      </h2>
      <Field label="Name"><input className={input} value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="Core router" /></Field>
      <Field label="Host"><input className={input} value={draft.host} onChange={(e) => set("host", e.target.value)} placeholder="192.168.88.1" required /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Port"><input className={input} type="number" value={draft.port} onChange={(e) => set("port", +e.target.value)} /></Field>
        <Field label="User"><input className={input} value={draft.username} onChange={(e) => set("username", e.target.value)} /></Field>
      </div>
      <Field label="Password"><input className={input} type="password" value={draft.password} onChange={(e) => set("password", e.target.value)} /></Field>

      <label className="mb-3 flex cursor-pointer items-center gap-2 text-sm text-ink-dim">
        <input type="checkbox" checked={draft.insecure} onChange={(e) => set("insecure", e.target.checked)} className="accent-amber" />
        <ShieldAlert size={14} className="text-amber" /> Allow self-signed certificate
      </label>
      <label className="mb-3 flex cursor-pointer items-center gap-2 text-sm text-ink-dim">
        <input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} className="accent-accent" />
        <Network size={14} className="text-accent" /> Reach it through a proxy
      </label>

      {useProxy && (
        <div className="wx-rise mb-3 space-y-2 rounded-lg border border-line-strong bg-panel-2 p-3">
          <div className="grid grid-cols-[84px_1fr_72px] gap-2">
            <select className={input} value={proxy.kind} onChange={(e) => setProxy("kind", e.target.value as ProxyKind)}>
              <option value="socks5">SOCKS5</option>
              <option value="http">HTTP</option>
            </select>
            <input className={input} value={proxy.host} onChange={(e) => setProxy("host", e.target.value)} placeholder="proxy host" />
            <input className={input} type="number" value={proxy.port} onChange={(e) => setProxy("port", +e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex items-center gap-2 rounded-md border border-line-strong bg-panel px-2">
              <User size={13} className="text-ink-faint" />
              <input className={bare} value={proxy.username} onChange={(e) => setProxy("username", e.target.value)} placeholder="proxy user" />
            </div>
            <div className="flex items-center gap-2 rounded-md border border-line-strong bg-panel px-2">
              <KeyRound size={13} className="text-ink-faint" />
              <input className={bare} type="password" value={proxy.password} onChange={(e) => setProxy("password", e.target.value)} placeholder="proxy password" />
            </div>
          </div>
          <p className="text-[11px] text-ink-faint">Optional — leave empty if the proxy needs no login.</p>
        </div>
      )}

      {error && <p className="mb-3 font-mono text-xs text-danger">{error}</p>}

      <div className="mt-1 flex gap-2">
        <button type="submit"
          className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 font-mono text-sm font-semibold text-bg transition hover:brightness-110">
          <Terminal size={16} /> Connect
        </button>
        <button type="button" onClick={onSave} title="Save device"
          className="flex items-center gap-2 rounded-lg border border-line-strong bg-panel-2 px-4 py-2.5 font-mono text-sm text-ink-dim transition hover:text-ink">
          <Save size={15} /> Save
        </button>
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-[11px] text-ink-faint">
        <Loader2 size={11} /> Connect opens the device in a tab — split it into panes like tmux.
      </p>
    </form>
  );
}

const input =
  "w-full rounded-md border border-line-strong bg-panel-2 px-3 py-2 font-mono text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent";
const bare = "w-full bg-transparent py-2 font-mono text-sm text-ink outline-none placeholder:text-ink-faint";

function Field({ label: name, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block font-mono text-xs text-ink-faint">{name}</span>
      {children}
    </label>
  );
}
