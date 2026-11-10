import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import {
  Server, Network, Loader2, Terminal, Moon, Sun, SquareTerminal, Flame,
  User, KeyRound, Plus, Play, Trash2, Save, Router, X, ExternalLink, PanelLeftClose, PanelLeftOpen,
  LockOpen, Lock, TriangleAlert, Activity, LogOut, BellRing, CircleCheck,
} from "lucide-react";
import { CertCard, CertificateSection, fetchCertificate, normalizePin, tlsModeOf, type CertificateInfo, type TlsMode } from "./Certificate";
import { DOWN_AFTER, INTERVALS, ago, notify, useMonitor, type MonitorEvent, type ReachState } from "./monitor";
import { AmbientNetwork } from "./AmbientNetwork";
import { newLeaf, normalizePane, type DeviceData, type Pane } from "./Pane";
import { Workspace } from "./Workspace";

export type ProxyKind = "socks5" | "http";

/** which RouterOS web service carries REST: www-ssl (HTTPS) or www (plain HTTP, unencrypted) */
export type Scheme = "https" | "http";
export const DEFAULT_PORT: Record<Scheme, number> = { https: 443, http: 80 };
/** profiles saved before the protocol choice existed are HTTPS */
export const isPlainHttp = (p: { scheme?: Scheme }) => p.scheme === "http";
export const PLAIN_HTTP_TITLE =
  "Unencrypted HTTP: the RouterOS user, password and all data travel in clear text (readable by the proxy and every network hop)";

export interface Proxy { kind: ProxyKind; host: string; port: number; username: string; password: string }

export interface Profile {
  id: string;
  name: string;
  host: string;
  /** missing on profiles saved before the protocol choice: means https */
  scheme?: Scheme;
  port: number;
  username: string;
  password: string;
  insecure: boolean;
  /** how the certificate is trusted; missing on older profiles (see tlsModeOf) */
  tlsMode?: TlsMode | "";
  /** pinned SHA-256 of the router's certificate */
  pin?: string;
  /** trusted CA certificate(s), PEM */
  caPem?: string;
  /** watched by the reachability monitor */
  monitor?: boolean;
  proxy: Proxy | null;
}

/** an open device: its connection, what it answered, and its pane layout */
/** what a detached window carries */
export interface DetachPayload {
  profile: Profile;
  layout: Pane;
  data: DeviceData | null;
}

export interface Tab {
  id: string;
  profile: Profile;
  data: DeviceData | null;
  busy: boolean;
  error: string | null;
  layout: Pane;
}

export const THEMES = [
  { id: "dark", label: "Dark", Icon: Moon },
  { id: "light", label: "Light", Icon: Sun },
  { id: "terminal", label: "Terminal", Icon: SquareTerminal },
  { id: "amber", label: "Amber", Icon: Flame },
] as const;
export type ThemeId = (typeof THEMES)[number]["id"];

export function useTheme() {
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
  // a theme chosen in another Wingox window follows here
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "wingox.theme" && e.newValue && THEMES.some((t) => t.id === e.newValue)) setTheme(e.newValue as ThemeId);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return [theme, setTheme] as const;
}

export const emptyProxy = (): Proxy => ({ kind: "socks5", host: "", port: 1080, username: "", password: "" });
const blank = (): Profile => ({
  id: "", name: "", host: "", scheme: "https", port: 443, username: "admin", password: "",
  insecure: false, tlsMode: "pinned", pin: "", caPem: "", monitor: false, proxy: null,
});
export const label = (p: Profile) => p.name.trim() || p.host || "device";

export const connArgs = (p: Profile) => ({
  host: p.host, scheme: p.scheme ?? "https", port: p.port, username: p.username, password: p.password, insecure: p.insecure,
  tlsMode: tlsModeOf(p), pin: normalizePin(p.pin ?? ""), caPem: p.caPem ?? "",
  proxy: p.proxy
    ? { kind: p.proxy.kind, host: p.proxy.host, port: p.proxy.port, username: p.proxy.username || null, password: p.proxy.password || null }
    : null,
});

/** pinned but nothing pinned yet: the certificate must be shown and accepted first */
const needsPin = (p: Profile) =>
  (p.scheme ?? "https") === "https" && tlsModeOf(p) === "pinned" && !/^[0-9a-f]{64}$/.test(normalizePin(p.pin ?? ""));

interface Toast extends MonitorEvent { key: string }

export async function probe(p: Profile): Promise<DeviceData> {
  return invoke<DeviceData>("connect", { args: connArgs(p) });
}

/** read one RouterOS menu (e.g. `ip/address`) through the device's route */
export async function restGet(p: Profile, path: string): Promise<unknown> {
  return invoke<unknown>("rest_get", { args: connArgs(p), path });
}

export function App() {
  const [theme, setTheme] = useTheme();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>("new");
  const [draft, setDraft] = useState<Profile>(blank);
  const [useProxy, setUseProxy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** first contact with a pinned profile: its certificate, waiting for the user's OK */
  const [tofu, setTofu] = useState<{ profile: Profile; cert: CertificateInfo } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmLogout, setConfirmLogout] = useState<{ windows: string[] } | null>(null);
  const [monitorEvery, setMonitorEvery] = useState<number>(() => {
    try { const v = Number(localStorage.getItem("wingox.monitor.every")); return INTERVALS.includes(v as never) ? v : 30; } catch { return 30; }
  });
  useEffect(() => { try { localStorage.setItem("wingox.monitor.every", String(monitorEvery)); } catch { /* ignore */ } }, [monitorEvery]);
  const [devicesFolded, setDevicesFolded] = useState<boolean>(() => {
    try { return localStorage.getItem("wingox.devices.folded") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("wingox.devices.folded", devicesFolded ? "1" : "0"); } catch { /* ignore */ }
  }, [devicesFolded]);

  const refresh = useCallback(async () => {
    try { setProfiles(await invoke<Profile[]>("profiles_list")); }
    catch (e) { console.warn("profiles_list:", e); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const patchTab = (id: string, change: Partial<Tab>) =>
    setTabs((list) => list.map((t) => (t.id === id ? { ...t, ...change } : t)));

  // a detached device window docks back: its tab returns here
  useEffect(() => {
    let off: (() => void) | undefined;
    listen<DetachPayload>("wingox-dock", ({ payload }) => {
      const id = payload.profile.id || `t${Date.now().toString(36)}`;
      setTabs((list) => [...list.filter((t) => t.id !== id),
        { id, profile: payload.profile, data: payload.data, busy: false, error: null, layout: normalizePane(payload.layout) }]);
      setActive(id);
    }).then((u) => { off = u; }).catch(() => { /* outside the desktop shell */ });
    return () => off?.();
  }, []);

  // ── reachability monitor ──────────────────────────────────────────────────
  const watched = useMemo(
    () => profiles.filter((p) => p.monitor).map((p) => ({ id: p.id, name: label(p), args: connArgs(p) })),
    [profiles],
  );
  const reach = useMonitor(watched, monitorEvery, (e) => {
    const key = `${e.id}-${e.at}`;
    setToasts((list) => [...list.filter((t) => t.id !== e.id), { ...e, key }].slice(-6));
    if (e.kind === "up") setTimeout(() => setToasts((list) => list.filter((t) => t.key !== key)), 8000);
    void notify(e.kind === "down" ? `${e.name} is not answering` : `${e.name} is back`,
      e.kind === "down" ? e.detail : `${e.name} ${e.detail}`);
  });
  async function toggleMonitor(p: Profile) {
    try {
      await invoke<Profile>("profile_save", { profile: { ...p, monitor: !p.monitor } });
      await refresh();
    } catch (e) { setFormError(String(e)); }
  }
  const downCount = watched.filter((w) => reach[w.id]?.status === "down").length;

  // ── close every session at once ───────────────────────────────────────────
  async function askLogoutAll() {
    let windows: string[] = [];
    try { windows = (await getAllWebviewWindows()).map((w) => w.label).filter((l) => l.startsWith("device-")); } catch { /* not in the shell */ }
    setConfirmLogout({ windows });
  }
  async function logoutAll() {
    setTabs([]);
    setActive("new");
    setConfirmLogout(null);
    try { await emit("wingox-logout-all"); } catch { /* not in the shell */ }
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith("wingox.detach.")) localStorage.removeItem(k);
    } catch { /* ignore */ }
  }

  /** the user accepted a router's certificate on first contact: pin it, save it, connect */
  async function trustAndOpen(p: Profile, cert: CertificateInfo) {
    setTofu(null);
    const pinned = { ...p, pin: cert.sha256 };
    if (pinned.id) {
      try { await invoke<Profile>("profile_save", { profile: pinned }); await refresh(); } catch (e) { console.warn("profile_save:", e); }
    }
    setDraft((d) => (d.id === pinned.id && d.host === pinned.host ? { ...d, pin: cert.sha256 } : d));
    void open(pinned);
  }

  /** move a tab to its own window, to place it on another monitor */
  function detach(t: Tab) {
    const winLabel = `device-${Date.now().toString(36)}`;
    const payload: DetachPayload = { profile: t.profile, layout: t.layout, data: t.data };
    try {
      localStorage.setItem(`wingox.detach.${winLabel}`, JSON.stringify(payload));
      const win = new WebviewWindow(winLabel, {
        url: `index.html?detach=${winLabel}`,
        title: `Wingox — ${label(t.profile)}`,
        width: 980, height: 680, minWidth: 520, minHeight: 360,
      });
      win.once("tauri://error", (e) => console.warn("detach:", e));
      closeTab(t.id);
    } catch (e) {
      console.warn("detach:", e);
    }
  }

  /** open (or refocus) a tab for a device and connect it */
  const open = useCallback(async (p: Profile) => {
    if (needsPin(p)) {
      try {
        setTofu({ profile: p, cert: await fetchCertificate(connArgs(p)) });
        return;
      } catch {
        /* unreachable etc.: the tab below shows the error of the real attempt */
      }
    }
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
        {/* devices — folds to a rail so the device menu and panes get the room */}
        {devicesFolded ? (
          <aside className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-line/80 bg-panel/40 py-2">
            <button type="button" title="Show devices" onClick={() => setDevicesFolded(false)}
              className="grid h-7 w-7 place-items-center rounded-md text-ink-faint hover:bg-panel-2 hover:text-ink"><PanelLeftOpen size={15} /></button>
            <div className="my-1 h-px w-6 bg-line" />
            {profiles.map((p) => {
              const open_ = tabs.some((t) => t.id === p.id);
              return (
                <button key={p.id} type="button" title={`${p.name} — ${p.host}:${p.port}${isPlainHttp(p) ? " — UNENCRYPTED HTTP" : ""}`}
                  onClick={() => (open_ ? setActive(p.id) : void open(p))}
                  className={`grid h-7 w-7 place-items-center rounded-md transition ${
                    active === p.id ? "bg-accent/15 text-accent" : open_ ? "text-accent/80 hover:bg-panel-2" : "text-ink-faint hover:bg-panel-2 hover:text-ink"}`}>
                  <span className="relative"><Router size={15} />{p.monitor && <ReachDot state={reach[p.id]} />}</span>
                </button>
              );
            })}
            <button type="button" title="New device" onClick={newProfile}
              className="grid h-7 w-7 place-items-center rounded-md text-ink-faint hover:bg-accent/15 hover:text-accent"><Plus size={15} /></button>
          </aside>
        ) : (
        <aside className="flex w-60 shrink-0 flex-col border-r border-line/80 bg-panel/40">
          <div className="flex items-center justify-between px-3 py-2.5">
            <span className="font-mono text-xs uppercase tracking-wide text-ink-faint">Devices</span>
            <div className="flex items-center gap-0.5">
              <button type="button" title="New device" onClick={newProfile}
                className="grid h-6 w-6 place-items-center rounded text-ink-faint hover:bg-accent/15 hover:text-accent"><Plus size={15} /></button>
              <button type="button" title="Fold devices" onClick={() => setDevicesFolded(true)}
                className="grid h-6 w-6 place-items-center rounded text-ink-faint hover:bg-panel-2 hover:text-ink"><PanelLeftClose size={14} /></button>
            </div>
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
                  <span className="relative">
                    <Router size={15} className={open_ ? "text-accent" : "text-ink-faint"} />
                    {p.monitor && <ReachDot state={reach[p.id]} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-sm text-ink">{p.name}</div>
                    <div className="truncate text-[11px] text-ink-faint">
                      {p.host}:{p.port}{p.proxy ? " · proxy" : ""}
                      {isPlainHttp(p) && <span className="text-danger" title={PLAIN_HTTP_TITLE}> · HTTP unencrypted</span>}
                    </div>
                    {p.monitor && <ReachLine state={reach[p.id]} />}
                  </div>
                  <button type="button" title={p.monitor ? "Stop monitoring" : "Monitor reachability (ping)"}
                    onClick={(e) => { e.stopPropagation(); void toggleMonitor(p); }}
                    className={`h-6 w-6 place-items-center rounded hover:text-accent ${p.monitor ? "grid text-accent" : "hidden text-ink-faint group-hover:grid"}`}><Activity size={13} /></button>
                  <button type="button" title="Open" onClick={(e) => { e.stopPropagation(); void open(p); }}
                    className="hidden h-6 w-6 place-items-center rounded text-ink-faint hover:text-accent group-hover:grid"><Play size={13} /></button>
                  <button type="button" title="Delete" onClick={(e) => { e.stopPropagation(); void remove(p.id); }}
                    className="hidden h-6 w-6 place-items-center rounded text-ink-faint hover:text-danger group-hover:grid"><Trash2 size={13} /></button>
                </div>
              );
            })}
          </div>
          <MonitorBar watched={watched.length} down={downCount} every={monitorEvery} setEvery={setMonitorEvery} />
        </aside>
        )}

        {/* workspace */}
        <section className="flex min-w-0 flex-1 flex-col">
          <nav className="flex items-end gap-1 overflow-x-auto border-b border-line/80 px-2 pt-2">
            {tabs.map((t) => (
              <div key={t.id} onClick={() => setActive(t.id)}
                className={`group flex cursor-pointer items-center gap-2 rounded-t-md border border-b-0 px-3 py-1.5 font-mono text-xs transition ${
                  active === t.id ? "border-line bg-panel text-ink" : "border-transparent text-ink-faint hover:text-ink"}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${t.error ? "bg-danger" : t.busy ? "bg-amber" : "bg-accent"}`} />
                <span className="max-w-40 truncate">{label(t.profile)}</span>
                {isPlainHttp(t.profile) && (
                  <span title={PLAIN_HTTP_TITLE} className="flex items-center gap-0.5 rounded bg-danger/15 px-1 text-[10px] text-danger">
                    <LockOpen size={10} /> HTTP
                  </span>
                )}
                <button type="button" title="Detach to a window" onClick={(e) => { e.stopPropagation(); detach(t); }}
                  className="grid h-4 w-4 place-items-center rounded text-ink-faint opacity-60 hover:text-accent hover:opacity-100"><ExternalLink size={11} /></button>
                <button type="button" title="Close tab" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                  className="grid h-4 w-4 place-items-center rounded text-ink-faint opacity-60 hover:text-danger hover:opacity-100"><X size={11} /></button>
              </div>
            ))}
            <button type="button" title="New connection" onClick={newProfile}
              className={`mb-1 grid h-7 w-7 place-items-center rounded-md transition ${active === "new" ? "bg-accent/20 text-accent" : "text-ink-faint hover:text-ink"}`}>
              <Plus size={14} />
            </button>
            <div className="relative mb-1 ml-auto shrink-0">
              <button type="button" onClick={() => void askLogoutAll()} title="Close all sessions (every device tab and detached window)"
                className="flex h-7 items-center gap-1.5 rounded-md px-2 font-mono text-[11px] text-ink-faint transition hover:bg-danger/15 hover:text-danger">
                <LogOut size={13} /> Close all{tabs.length ? ` (${tabs.length})` : ""}
              </button>
            </div>
          </nav>

          <div className="flex min-h-0 flex-1">
            {tab ? (
              <Workspace
                key={tab.id}
                profile={tab.profile}
                data={tab.data}
                busy={tab.busy}
                error={tab.error}
                layout={tab.layout}
                setLayout={(f) => setTabs((list) => list.map((t) => (t.id === tab.id ? { ...t, layout: f(t.layout) } : t)))}
              />
            ) : (
              <div className="min-h-0 flex-1 overflow-auto p-2">
                <ConnectionForm
                  draft={draft} setDraft={setDraft} useProxy={useProxy} setUseProxy={setUseProxy} error={formError}
                  onConnect={() => void open({ ...current(), id: draft.id })} onSave={() => void save()}
                />
              </div>
            )}
          </div>
        </section>
      </div>

      {confirmLogout && (
        <Modal onClose={() => setConfirmLogout(null)}>
          <h3 className="mb-2 flex items-center gap-2 font-mono text-sm font-semibold text-ink"><LogOut size={15} className="text-danger" /> Close all sessions?</h3>
          <p className="text-sm text-ink-dim">
            {tabs.length || confirmLogout.windows.length
              ? <>This closes <b className="text-ink">{tabs.length} device tab{tabs.length === 1 ? "" : "s"}</b>
                  {confirmLogout.windows.length > 0 && <> and <b className="text-ink">{confirmLogout.windows.length} detached window{confirmLogout.windows.length === 1 ? "" : "s"}</b></>}
                  , with their panes. Saved devices stay; the monitor keeps running.</>
              : "There are no open sessions."}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmLogout(null)}
              className="rounded-md border border-line-strong bg-panel-2 px-3 py-1.5 font-mono text-xs text-ink-dim hover:text-ink">Cancel</button>
            <button type="button" onClick={() => void logoutAll()} autoFocus
              className="flex items-center gap-1.5 rounded-md bg-danger px-3 py-1.5 font-mono text-xs font-semibold text-bg hover:brightness-110">
              <LogOut size={12} /> Close all
            </button>
          </div>
        </Modal>
      )}

      {tofu && (
        <Modal onClose={() => setTofu(null)}>
          <h3 className="mb-1 font-mono text-sm font-semibold text-ink">First connection to {label(tofu.profile)}</h3>
          <p className="text-xs text-ink-dim">
            Wingox has not seen this router's certificate before. Check that its fingerprint is the router's — then it is
            pinned, and any other certificate will be refused. Nothing (no password) has been sent yet.
          </p>
          <CertCard cert={tofu.cert} pinned={null} trustLabel="Trust, pin and connect"
            onTrust={() => void trustAndOpen(tofu.profile, tofu.cert)} onDismiss={() => setTofu(null)} />
        </Modal>
      )}

      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.key} role="status"
            className={`wx-rise pointer-events-auto rounded-lg border p-3 shadow-lg backdrop-blur ${
              t.kind === "down" ? "border-danger/60 bg-panel/95" : "border-ok/50 bg-panel/95"}`}>
            <div className="flex items-center gap-2 font-mono text-xs font-semibold">
              {t.kind === "down" ? <BellRing size={14} className="text-danger" /> : <CircleCheck size={14} className="text-ok" />}
              <span className={t.kind === "down" ? "text-danger" : "text-ok"}>{t.name} {t.kind === "down" ? "is not answering" : "is back"}</span>
              <button type="button" onClick={() => setToasts((l) => l.filter((x) => x.key !== t.key))}
                className="ml-auto text-ink-faint hover:text-ink" title="Dismiss"><X size={12} /></button>
            </div>
            <p className="mt-1 line-clamp-3 break-words text-[11px] text-ink-dim">{t.detail}</p>
            <p className="mt-0.5 font-mono text-[10px] text-ink-faint">{new Date(t.at).toLocaleTimeString()}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-bg/70 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div className="wx-rise w-full max-w-md rounded-xl border border-line-strong bg-panel p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

/** the monitor's status dot on a device icon */
function ReachDot({ state }: { state: ReachState | undefined }) {
  const c = !state || state.status === "pending" ? "bg-ink-faint" : state.status === "up" ? "bg-ok" : "bg-danger";
  return <span className={`absolute -right-1 -top-1 h-2 w-2 rounded-full ring-2 ring-panel ${c} ${state?.status === "down" ? "animate-pulse" : ""}`} />;
}

function ReachLine({ state }: { state: ReachState | undefined }) {
  if (!state || state.status === "pending") {
    return <div className="font-mono text-[10px] text-ink-faint">{state?.fails ? `no answer (${state.fails}/${DOWN_AFTER})…` : "checking…"}</div>;
  }
  if (state.status === "up") {
    return <div className="font-mono text-[10px] text-ok" title={`up for ${ago(state.since)}`}>● {state.ms} ms{state.fails ? " · 1 lost" : ""}</div>;
  }
  return <div className="truncate font-mono text-[10px] text-danger" title={state.error}>● down {ago(state.since)} — {state.error}</div>;
}

function MonitorBar({ watched, down, every, setEvery }: { watched: number; down: number; every: number; setEvery: (n: number) => void }) {
  return (
    <div className="flex items-center gap-1.5 border-t border-line/80 px-3 py-2 font-mono text-[10.5px] text-ink-faint"
      title="Reachability monitor: the router's web service is probed along each device's route (proxy included) without credentials — ICMP cannot cross a proxy">
      <Activity size={12} className={down ? "text-danger" : watched ? "text-ok" : ""} />
      {watched ? (
        <span>{watched} watched{down ? <span className="text-danger"> · {down} down</span> : ""}</span>
      ) : (
        <span>monitor: none</span>
      )}
      <select value={every} onChange={(e) => setEvery(Number(e.target.value))} title="Probe every"
        className="ml-auto rounded border border-line bg-panel px-1 py-0.5 text-[10.5px] text-ink-dim outline-none">
        {INTERVALS.map((n) => <option key={n} value={n}>{n < 60 ? `${n}s` : `${n / 60}m`}</option>)}
      </select>
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
  const scheme: Scheme = draft.scheme ?? "https";
  // switching protocol moves the port along when it is still the other one's default
  const setScheme = (sc: Scheme) => setDraft((d) => {
    const from: Scheme = d.scheme ?? "https";
    return { ...d, scheme: sc, port: d.port === DEFAULT_PORT[from] ? DEFAULT_PORT[sc] : d.port };
  });
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

      <div className="mb-3">
        <span className="mb-1 block font-mono text-xs text-ink-faint">Protocol</span>
        <div className="grid grid-cols-2 gap-1 rounded-lg border border-line-strong bg-panel-2 p-1">
          {(["https", "http"] as const).map((sc) => {
            const on = scheme === sc;
            const Icon = sc === "https" ? Lock : LockOpen;
            return (
              <button key={sc} type="button" onClick={() => setScheme(sc)}
                className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-mono text-xs transition ${
                  on ? (sc === "https" ? "bg-accent/20 text-accent" : "bg-danger/20 text-danger") : "text-ink-faint hover:text-ink"}`}>
                <Icon size={13} /> {sc === "https" ? "HTTPS · www-ssl" : "HTTP · unencrypted"}
              </button>
            );
          })}
        </div>
      </div>

      {scheme === "http" ? (
        <div role="alert" className="wx-rise mb-3 rounded-lg border border-danger/60 bg-danger/10 p-3 text-xs leading-relaxed text-ink">
          <div className="mb-1 flex items-center gap-1.5 font-mono font-semibold text-danger">
            <TriangleAlert size={14} /> Unencrypted connection — not secure
          </div>
          <p>
            With HTTP <b>nothing is encrypted</b>: the RouterOS <b>username and password</b> (sent with every request) and all
            the configuration you read travel in <b>clear text</b>. The proxy and anyone on the network path between Wingox and
            the router can read and reuse them.
          </p>
          <p className="mt-1.5 text-ink-dim">
            Use it only when the router's <span className="font-mono">www-ssl</span> service cannot be used — typically it has
            no certificate (<span className="font-mono">certificate=none</span>), so HTTPS fails with a TLS handshake error.
            The real fix is on the router: assign a certificate to <span className="font-mono">www-ssl</span> and switch back to HTTPS.
            The router's <span className="font-mono">www</span> service (port 80) must be enabled.
          </p>
        </div>
      ) : (
        <CertificateSection mode={tlsModeOf(draft)} pin={draft.pin ?? ""} caPem={draft.caPem ?? ""}
          onChange={(c) => setDraft((d) => ({ ...d, ...c }))}
          fetchArgs={() => connArgs({ ...draft, proxy: useProxy ? draft.proxy ?? emptyProxy() : null })} />
      )}
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

      <label className="mb-3 flex cursor-pointer items-center gap-2 text-sm text-ink-dim"
        title="Probe the router periodically (no credentials, along its route) and notify when it stops answering">
        <input type="checkbox" checked={!!draft.monitor} onChange={(e) => set("monitor", e.target.checked)} className="accent-accent" />
        <Activity size={14} className="text-accent" /> Monitor reachability (ping) and notify
      </label>

      {error && <p className="mb-3 font-mono text-xs text-danger">{error}</p>}

      <div className="mt-1 flex gap-2">
        <button type="submit"
          className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 font-mono text-sm font-semibold text-bg transition hover:brightness-110 ${
            scheme === "http" ? "bg-danger" : "bg-accent"}`}>
          {scheme === "http" ? <><LockOpen size={16} /> Connect unencrypted</> : <><Terminal size={16} /> Connect</>}
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
