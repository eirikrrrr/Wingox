import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Server, ShieldAlert, Network, Cpu, Clock, Boxes, Loader2, Terminal,
  Moon, Sun, SquareTerminal, Flame, User, KeyRound, Plus, Play, Trash2, Save, Router,
} from "lucide-react";
import { AmbientNetwork } from "./AmbientNetwork";

type ProxyKind = "socks5" | "http";

interface Proxy {
  kind: ProxyKind;
  host: string;
  port: number;
  username: string;
  password: string;
}

interface Profile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  insecure: boolean;
  proxy: Proxy | null;
}

interface Probe {
  identity: string;
  version: string;
  board: string;
  architecture: string;
  cpuLoad: string;
  uptime: string;
  interfaces: Record<string, unknown>[];
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

const blank = (): Profile => ({
  id: "", name: "", host: "", port: 443, username: "admin", password: "", insecure: true, proxy: null,
});

export function App() {
  const [theme, setTheme] = useTheme();

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [draft, setDraft] = useState<Profile>(blank);
  const [useProxy, setUseProxy] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);

  const set = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const setProxy = <K extends keyof Proxy>(key: K, value: Proxy[K]) =>
    setDraft((d) => ({ ...d, proxy: { ...(d.proxy ?? emptyProxy()), [key]: value } }));

  const refresh = useCallback(async () => {
    try {
      setProfiles(await invoke<Profile[]>("profiles_list"));
    } catch (e) {
      // not fatal (and invoke is absent outside the Tauri shell): keep the list empty
      console.warn("profiles_list:", e);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  function openProfile(p: Profile) {
    setDraft({ ...p, proxy: p.proxy ? { ...p.proxy } : null });
    setUseProxy(!!p.proxy);
    setError(null);
    setProbe(null);
  }
  function newProfile() {
    setDraft(blank());
    setUseProxy(false);
    setError(null);
    setProbe(null);
  }

  async function save() {
    const toSave: Profile = {
      ...draft,
      name: draft.name.trim() || draft.host || "Untitled",
      proxy: useProxy ? draft.proxy ?? emptyProxy() : null,
    };
    try {
      const saved = await invoke<Profile>("profile_save", { profile: toSave });
      setDraft(saved);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove(id: string) {
    try {
      await invoke("profile_delete", { id });
      if (draft.id === id) newProfile();
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  const runConnect = useCallback(async (p: Profile, proxyOn: boolean) => {
    setBusy(true);
    setError(null);
    setProbe(null);
    try {
      const result = await invoke<Probe>("connect", {
        args: {
          host: p.host, port: p.port, username: p.username, password: p.password, insecure: p.insecure,
          proxy: proxyOn && p.proxy
            ? { kind: p.proxy.kind, host: p.proxy.host, port: p.proxy.port, username: p.proxy.username || null, password: p.proxy.password || null }
            : null,
        },
      });
      setProbe(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void runConnect(draft, useProxy);
  }

  return (
    <div className="flex h-full flex-col">
      <AmbientNetwork />

      <header className="flex items-center gap-3 border-b border-line/80 px-5 py-3 backdrop-blur-sm">
        <span className="grid h-9 w-9 place-items-center rounded-md bg-accent/15 text-accent">
          <Terminal size={18} />
        </span>
        <div>
          <h1 className="font-mono text-base font-semibold tracking-tight text-ink">
            wingox<span className="wx-cursor text-accent">▌</span>
          </h1>
          <p className="text-[11px] text-ink-faint">manage MikroTik RouterOS — through a proxy or a jump</p>
        </div>
        <div className="ml-auto flex items-center gap-1 rounded-lg border border-line bg-panel/70 p-1">
          {THEMES.map(({ id, label, Icon }) => (
            <button key={id} type="button" title={label} onClick={() => setTheme(id)}
              className={`grid h-7 w-7 place-items-center rounded-md transition ${
                theme === id ? "bg-accent/20 text-accent" : "text-ink-faint hover:text-ink"}`}>
              <Icon size={15} />
            </button>
          ))}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* profiles sidebar */}
        <aside className="flex w-60 flex-col border-r border-line/80 bg-panel/40">
          <div className="flex items-center justify-between px-3 py-2.5">
            <span className="font-mono text-xs uppercase tracking-wide text-ink-faint">Devices</span>
            <button type="button" title="New device" onClick={newProfile}
              className="grid h-6 w-6 place-items-center rounded text-ink-faint hover:bg-accent/15 hover:text-accent">
              <Plus size={15} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
            {profiles.length === 0 && (
              <p className="px-2 py-4 text-center text-xs text-ink-faint">No saved devices yet.<br />Fill the form and Save.</p>
            )}
            {profiles.map((p) => (
              <div key={p.id}
                onClick={() => openProfile(p)}
                className={`group mb-1 flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 transition ${
                  draft.id === p.id ? "border-accent/50 bg-accent/10" : "border-transparent hover:bg-panel-2"}`}>
                <Router size={15} className={draft.id === p.id ? "text-accent" : "text-ink-faint"} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-sm text-ink">{p.name}</div>
                  <div className="truncate text-[11px] text-ink-faint">
                    {p.host}:{p.port}{p.proxy ? " · proxy" : ""}
                  </div>
                </div>
                <button type="button" title="Connect"
                  onClick={(e) => { e.stopPropagation(); openProfile(p); void runConnect(p, !!p.proxy); }}
                  className="hidden h-6 w-6 place-items-center rounded text-ink-faint hover:text-accent group-hover:grid">
                  <Play size={13} />
                </button>
                <button type="button" title="Delete"
                  onClick={(e) => { e.stopPropagation(); void remove(p.id); }}
                  className="hidden h-6 w-6 place-items-center rounded text-ink-faint hover:text-danger group-hover:grid">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </aside>

        {/* main */}
        <main className="min-w-0 flex-1 overflow-auto">
          <div className="mx-auto grid max-w-5xl gap-6 px-6 py-7 lg:grid-cols-[360px_1fr]">
            <form onSubmit={onSubmit} className="wx-rise h-fit rounded-xl border border-line bg-panel/90 p-5">
              <h2 className="mb-4 flex items-center gap-2 font-mono text-sm font-semibold text-ink-dim">
                <Server size={15} className="text-accent" /> {draft.id ? "Edit device" : "New connection"}
              </h2>

              <Field label="Name">
                <input className={input} value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="Core router" />
              </Field>
              <Field label="Host">
                <input className={input} value={draft.host} onChange={(e) => set("host", e.target.value)} placeholder="192.168.88.1" required />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Port">
                  <input className={input} type="number" value={draft.port} onChange={(e) => set("port", +e.target.value)} />
                </Field>
                <Field label="User">
                  <input className={input} value={draft.username} onChange={(e) => set("username", e.target.value)} />
                </Field>
              </div>
              <Field label="Password">
                <input className={input} type="password" value={draft.password} onChange={(e) => set("password", e.target.value)} />
              </Field>

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
                    <select className={input} value={(draft.proxy ?? emptyProxy()).kind} onChange={(e) => setProxy("kind", e.target.value as ProxyKind)}>
                      <option value="socks5">SOCKS5</option>
                      <option value="http">HTTP</option>
                    </select>
                    <input className={input} value={(draft.proxy ?? emptyProxy()).host} onChange={(e) => setProxy("host", e.target.value)} placeholder="proxy host" />
                    <input className={input} type="number" value={(draft.proxy ?? emptyProxy()).port} onChange={(e) => setProxy("port", +e.target.value)} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex items-center gap-2 rounded-md border border-line-strong bg-panel px-2">
                      <User size={13} className="text-ink-faint" />
                      <input className={bare} value={(draft.proxy ?? emptyProxy()).username} onChange={(e) => setProxy("username", e.target.value)} placeholder="proxy user" />
                    </div>
                    <div className="flex items-center gap-2 rounded-md border border-line-strong bg-panel px-2">
                      <KeyRound size={13} className="text-ink-faint" />
                      <input className={bare} type="password" value={(draft.proxy ?? emptyProxy()).password} onChange={(e) => setProxy("password", e.target.value)} placeholder="proxy password" />
                    </div>
                  </div>
                  <p className="text-[11px] text-ink-faint">Optional — leave empty if the proxy needs no login.</p>
                </div>
              )}

              <div className="mt-1 flex gap-2">
                <button type="submit" disabled={busy}
                  className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 font-mono text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-60">
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <Terminal size={16} />}
                  {busy ? "Connecting…" : "Connect"}
                </button>
                <button type="button" onClick={() => void save()} title="Save device"
                  className="flex items-center gap-2 rounded-lg border border-line-strong bg-panel-2 px-4 py-2.5 font-mono text-sm text-ink-dim transition hover:text-ink">
                  <Save size={15} /> Save
                </button>
              </div>
            </form>

            <section className="min-w-0">
              {!probe && !error && (
                <div className="wx-rise grid h-full min-h-[280px] place-items-center rounded-xl border border-dashed border-line text-center">
                  <div className="text-ink-faint">
                    <Terminal size={28} className="mx-auto mb-3 opacity-50" />
                    <p className="font-mono text-sm">Connect to a router to see it here<span className="wx-cursor">▌</span></p>
                    <p className="mt-1 text-xs">Its traffic goes directly, or through the proxy you set.</p>
                  </div>
                </div>
              )}

              {error && (
                <div className="wx-rise rounded-xl border border-danger/40 bg-danger/10 p-4 font-mono text-sm text-danger">{error}</div>
              )}

              {probe && (
                <div className="space-y-4">
                  <div className="wx-rise rounded-xl border border-line bg-panel/90 p-5">
                    <div className="flex items-center gap-2">
                      <span className="wx-pulse h-2 w-2 rounded-full bg-accent" />
                      <h2 className="font-mono text-lg font-semibold text-ink">{probe.identity}</h2>
                    </div>
                    <p className="mt-1 font-mono text-sm text-ink-dim">RouterOS {probe.version} · {probe.board} ({probe.architecture})</p>
                    <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                      <Stat icon={<Cpu size={14} />} label="CPU" value={`${probe.cpuLoad}%`} />
                      <Stat icon={<Clock size={14} />} label="Uptime" value={probe.uptime} />
                      <Stat icon={<Boxes size={14} />} label="Interfaces" value={String(probe.interfaces.length)} />
                    </div>
                  </div>

                  <div className="wx-rise overflow-hidden rounded-xl border border-line bg-panel/90">
                    <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 font-mono text-xs text-ink-dim">
                      <Network size={13} className="text-accent" /> interfaces
                    </div>
                    <table className="w-full font-mono text-sm">
                      <tbody>
                        {probe.interfaces.map((row, i) => (
                          <tr key={i} className="border-b border-line/60 last:border-0">
                            <td className="px-4 py-2 text-ink">{str(row.name)}</td>
                            <td className="px-4 py-2 text-ink-dim">{str(row.type)}</td>
                            <td className="px-4 py-2">
                              <span className={str(row.running) === "true" ? "text-accent" : "text-ink-faint"}>
                                {str(row.running) === "true" ? "running" : "down"}
                              </span>
                            </td>
                            <td className="px-4 py-2 text-ink-faint">{str(row["mac-address"])}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}

const emptyProxy = (): Proxy => ({ kind: "socks5", host: "", port: 1080, username: "", password: "" });

const input =
  "w-full rounded-md border border-line-strong bg-panel-2 px-3 py-2 font-mono text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent";
const bare = "w-full bg-transparent py-2 font-mono text-sm text-ink outline-none placeholder:text-ink-faint";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block font-mono text-xs text-ink-faint">{label}</span>
      {children}
    </label>
  );
}

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
      <div className="flex items-center gap-1.5 text-ink-faint">
        {icon}
        <span className="text-[11px] uppercase tracking-wide">{label}</span>
      </div>
      <div className="mt-0.5 font-mono text-sm text-ink">{value}</div>
    </div>
  );
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}
