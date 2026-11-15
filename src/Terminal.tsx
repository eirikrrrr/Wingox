// The device terminal: a real RouterOS CLI over SSH (xterm.js), through the
// profile's own route (proxy included). Each terminal pane is its own session;
// closing the pane (or the tab, or "Close all") ends it.
//
// The router's SSH host key is pinned per profile, like OpenSSH's known_hosts:
// the first time Wingox shows it and asks; afterwards a different key is
// refused with a loud warning. The password is never sent before that.
import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { KeyRound, Loader2, RotateCw, Search, SquareTerminal, TriangleAlert } from "lucide-react";
import { restGet, type Profile } from "./App";
import { monoCss, useSettings } from "./settings";

interface HostKeyInfo { algorithm: string; sha256: string; server?: string | null; routeros?: boolean }
interface SshError { kind: "hostKeyUnknown" | "hostKeyMismatch" | "notRouterOS" | "other"; message: string; got?: string; expected?: string; algorithm?: string }
type SshEvent = { kind: "data"; b64: string } | { kind: "closed"; reason: string | null };

type Phase =
  | { at: "checking" }
  | { at: "trust"; key: HostKeyInfo }
  | { at: "mismatch"; expected: string; got: string }
  | { at: "connecting" }
  | { at: "open" }
  | { at: "closed"; reason: string | null }
  | { at: "error"; message: string; notRouterOS?: boolean };

export const sshArgs = (p: Profile) => ({
  host: p.host,
  sshPort: p.sshPort ?? 22,
  username: p.username,
  password: p.password,
  hostKey: p.sshHostKey ?? "",
  proxy: p.proxy
    ? { kind: p.proxy.kind, host: p.proxy.host, port: p.proxy.port, username: p.proxy.username || null, password: p.proxy.password || null }
    : null,
});

const asSshError = (e: unknown): SshError =>
  typeof e === "object" && e && "kind" in e ? (e as SshError) : { kind: "other", message: String(e) };

function b64bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** the terminal palette, from the active Wingox theme */
function themeFromCss(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: v("--wx-panel"),
    foreground: v("--wx-ink"),
    cursor: v("--wx-accent"),
    cursorAccent: v("--wx-panel"),
    selectionBackground: `color-mix(in srgb, ${v("--wx-accent")} 30%, transparent)`,
    // the scrollbar, like the app's own (see index.css)
    scrollbarSliderBackground: v("--wx-line-strong"),
    scrollbarSliderHoverBackground: v("--wx-ink-faint"),
    scrollbarSliderActiveBackground: v("--wx-ink-dim"),
    overviewRulerBorder: "transparent",
    black: v("--wx-line-strong"), brightBlack: v("--wx-ink-faint"),
    red: v("--wx-danger"), brightRed: v("--wx-danger"),
    green: v("--wx-ok"), brightGreen: v("--wx-accent"),
    yellow: v("--wx-amber"), brightYellow: v("--wx-amber"),
    blue: v("--wx-info"), brightBlue: v("--wx-info"),
    magenta: v("--wx-dyn"), brightMagenta: v("--wx-dyn"),
    cyan: v("--wx-info"), brightCyan: v("--wx-ok"),
    white: v("--wx-ink-dim"), brightWhite: v("--wx-ink"),
  };
}

export function SshTerminal({ profile, onPinHostKey, onSshPort }: {
  profile: Profile;
  onPinHostKey: (key: string) => void;
  /** the user fixed the device's SSH port here (its pinned key belonged to the old one) */
  onSshPort: (port: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const session = useRef<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ at: "checking" });
  const { settings } = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // the profile at the time of (re)connecting — a later edit does not drop a live session
  const profileRef = useRef(profile);
  profileRef.current = profile;

  const closeSession = useCallback(() => {
    const id = session.current;
    session.current = null;
    if (id) void invoke("ssh_close", { id }).catch(() => { /* already gone */ });
  }, []);

  const connect = useCallback(async (hostKey?: string) => {
    closeSession();
    const p = { ...profileRef.current, sshHostKey: hostKey ?? profileRef.current.sshHostKey };
    if (!p.sshHostKey) {
      setPhase({ at: "checking" });
      try {
        setPhase({ at: "trust", key: await invoke<HostKeyInfo>("ssh_host_key", { args: sshArgs(p) }) });
      } catch (e) {
        setPhase({ at: "error", message: asSshError(e).message });
      }
      return;
    }
    setPhase({ at: "connecting" });
    const t = term.current!;
    fit.current?.fit();
    const channel = new Channel<SshEvent>();
    channel.onmessage = (ev) => {
      if (ev.kind === "data") t.write(b64bytes(ev.b64));
      else { session.current = null; setPhase({ at: "closed", reason: ev.reason }); }
    };
    try {
      const id = await invoke<string>("ssh_open", { args: sshArgs(p), cols: t.cols, rows: t.rows, onEvent: channel });
      session.current = id;
      setPhase({ at: "open" });
    } catch (e) {
      const err = asSshError(e);
      if (err.kind === "hostKeyMismatch") setPhase({ at: "mismatch", expected: err.expected ?? "", got: err.got ?? "" });
      else if (err.kind === "hostKeyUnknown") setPhase({ at: "trust", key: { algorithm: err.algorithm ?? "", sha256: err.got ?? "" } });
      else setPhase({ at: "error", message: err.message, notRouterOS: err.kind === "notRouterOS" });
    }
  }, [closeSession]);

  /** use another SSH port: saved in the profile, the old pinned key dropped, then connect */
  const usePort = useCallback((port: number) => {
    profileRef.current = { ...profileRef.current, sshPort: port, sshHostKey: "" };
    onSshPort(port);
    void connect("");
  }, [onSshPort, connect]);

  // the terminal itself lives as long as the pane
  useEffect(() => {
    const st = settingsRef.current;
    const t = new XTerm({
      fontFamily: monoCss(st),
      fontSize: st.termFontSize,
      cursorStyle: st.termCursor,
      cursorBlink: st.termBlink,
      scrollback: st.termScrollback,
      allowProposedApi: false,
      // xterm draws its own scrollbar; this width also sizes it (default 14px)
      overviewRuler: { width: 8 },
      theme: themeFromCss(),
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    term.current = t;
    fit.current = f;
    try { f.fit(); } catch { /* not laid out yet */ }

    // keystrokes (and the terminal's own answers to RouterOS's probes) → router
    const onData = t.onData((data) => {
      const id = session.current;
      if (id) void invoke("ssh_write", { id, data }).catch(() => { /* closed */ });
    });
    const onResize = t.onResize(({ cols, rows }) => {
      const id = session.current;
      if (id) void invoke("ssh_resize", { id, cols, rows }).catch(() => { /* closed */ });
    });
    // Ctrl+Shift+C / Ctrl+Shift+V copy and paste, like terminal apps
    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey) return true;
      if (e.code === "KeyC") { void navigator.clipboard?.writeText(t.getSelection()); return false; }
      if (e.code === "KeyV") { void navigator.clipboard?.readText().then((txt) => t.paste(txt)); return false; }
      return true;
    });

    const ro = new ResizeObserver(() => { try { f.fit(); } catch { /* hidden */ } });
    ro.observe(host.current!);
    // follow the Wingox theme
    const mo = new MutationObserver(() => { t.options.theme = themeFromCss(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });

    void connect();
    return () => {
      ro.disconnect();
      mo.disconnect();
      onData.dispose();
      onResize.dispose();
      closeSession();
      t.dispose();
      term.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // preferences changed (Settings ▸ Terminal / Appearance): apply to the open terminal
  useEffect(() => {
    const t = term.current;
    if (!t) return;
    t.options.fontFamily = monoCss(settings);
    t.options.fontSize = settings.termFontSize;
    t.options.cursorStyle = settings.termCursor;
    t.options.cursorBlink = settings.termBlink;
    t.options.scrollback = settings.termScrollback;
    // the provider applies the colors after this effect runs: read them next frame
    requestAnimationFrame(() => { if (term.current) term.current.options.theme = themeFromCss(); });
    try { fit.current?.fit(); } catch { /* hidden */ }
  }, [settings]);

  // focus once the terminal is visible (a hidden one cannot take the focus)
  useEffect(() => {
    if (phase.at === "open") term.current?.focus();
  }, [phase.at]);

  function trust(key: string) {
    onPinHostKey(key);
    void connect(key);
  }

  const overlay = phase.at !== "open";
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-panel">
      <div ref={host} className={`min-h-0 flex-1 px-1.5 pt-1 ${overlay && phase.at !== "closed" ? "invisible" : ""}`} />

      {phase.at === "closed" && (
        <div className="flex items-center gap-2 border-t border-line bg-panel-2/80 px-2 py-1 font-mono text-[11px] text-ink-faint">
          <SquareTerminal size={12} /> session ended{phase.reason ? ` — ${phase.reason}` : ""}
          <button type="button" onClick={() => void connect()}
            className="ml-auto flex items-center gap-1 rounded border border-line-strong px-2 py-0.5 text-ink-dim hover:text-accent">
            <RotateCw size={11} /> Reconnect
          </button>
        </div>
      )}

      {overlay && phase.at !== "closed" && (
        <div className="absolute inset-0 grid place-items-center overflow-auto p-3">
          {(phase.at === "checking" || phase.at === "connecting") && (
            <div className="flex items-center gap-2 font-mono text-sm text-ink-faint">
              <Loader2 size={14} className="animate-spin" />
              {phase.at === "checking" ? "reading the router's SSH host key…" : `ssh ${profile.username}@${profile.host}:${profile.sshPort ?? 22}…`}
            </div>
          )}

          {phase.at === "trust" && (
            <div className="wx-rise w-full max-w-md rounded-lg border border-line-strong bg-panel-2 p-3 text-xs text-ink-dim">
              <div className="mb-1.5 flex items-center gap-1.5 font-mono font-semibold text-ink">
                <KeyRound size={13} className="text-accent" /> First SSH connection to {profile.host}:{profile.sshPort ?? 22}
              </div>
              <p>Wingox has not seen this router's SSH host key. Check it is the router's — then it is pinned and any other key
                is refused. No password has been sent yet.</p>
              <dl className="mt-2 grid grid-cols-[64px_1fr] gap-x-2 gap-y-0.5 font-mono text-[11px]">
                <dt className="text-ink-faint">type</dt><dd className="text-ink">{phase.key.algorithm}</dd>
                <dt className="text-ink-faint">key</dt><dd className="break-all text-accent">{phase.key.sha256}</dd>
                <dt className="text-ink-faint">server</dt><dd className="break-all text-ink">{phase.key.server ?? "unknown"}</dd>
              </dl>
              {phase.key.server && !phase.key.routeros && (
                <p className="mt-2 rounded border border-amber/40 bg-amber/10 p-1.5 text-amber">
                  This server is not RouterOS (RouterOS says <span className="font-mono">SSH-2.0-ROSSSH</span>). The SSH port{" "}
                  <b>{profile.sshPort ?? 22}</b> probably points at another machine: fix the SSH port in the device's profile
                  instead of trusting this key.
                </p>
              )}
              <p className="mt-1.5 text-[10.5px] text-ink-faint">
                To compare from a trusted machine: <span className="font-mono">ssh-keyscan -p {profile.sshPort ?? 22} {profile.host} | ssh-keygen -lf -</span>
              </p>
              <button type="button" onClick={() => trust(phase.key.sha256)}
                className="mt-2.5 w-full rounded-md bg-accent px-3 py-1.5 font-mono text-xs font-semibold text-bg hover:brightness-110">
                Trust, pin and connect
              </button>
            </div>
          )}

          {phase.at === "mismatch" && (
            <div className="wx-rise w-full max-w-md rounded-lg border border-danger/60 bg-danger/10 p-3 text-xs text-ink">
              <div className="mb-1.5 flex items-center gap-1.5 font-mono font-semibold text-danger">
                <TriangleAlert size={14} /> The router's SSH host key CHANGED
              </div>
              <dl className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-0.5 font-mono text-[11px]">
                <dt className="text-ink-faint">pinned</dt><dd className="break-all">{phase.expected}</dd>
                <dt className="text-ink-faint">now</dt><dd className="break-all text-danger">{phase.got}</dd>
              </dl>
              <p className="mt-1.5 text-ink-dim">If the router was reinstalled or its host key regenerated, accept the new key.
                Otherwise someone may be intercepting the connection — do not continue.</p>
              <button type="button" onClick={() => trust(phase.got)}
                className="mt-2.5 w-full rounded-md bg-danger px-3 py-1.5 font-mono text-xs font-semibold text-bg hover:brightness-110">
                I renewed it — trust the new key
              </button>
            </div>
          )}

          {phase.at === "error" && (
            <div className="w-full max-w-md text-center">
              <p className="font-mono text-xs text-danger">{phase.message}</p>
              <button type="button" onClick={() => void connect()}
                className="mt-2 inline-flex items-center gap-1 rounded border border-line-strong px-2.5 py-1 font-mono text-[11px] text-ink-dim hover:text-accent">
                <RotateCw size={11} /> Retry
              </button>
              <PortFixer profile={profile} highlight={!!phase.notRouterOS} onUse={usePort} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** SSH ports worth trying when the profile's one is wrong (port forwards, NAT…) */
const COMMON_SSH_PORTS = [22, 2022, 2222, 8022, 22022, 10022];

/**
 * Fix the device's SSH port from the terminal itself: type it, or let Wingox
 * find it — the SSH port the router itself reports (ip/service) and a few
 * usual forwards, keeping the first whose server greets as RouterOS (ROSSSH).
 * Only the greeting is read: no login, no password sent.
 */
function PortFixer({ profile, highlight, onUse }: { profile: Profile; highlight: boolean; onUse: (port: number) => void }) {
  const current = profile.sshPort ?? 22;
  const [port, setPort] = useState(String(current));
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  async function find() {
    setBusy(true);
    setNote(null);
    const candidates: number[] = [];
    try {
      // the router's own SSH service port (the real one when there is no port forward)
      const services = await restGet(profile, "ip/service") as Record<string, unknown>[];
      const ssh = Array.isArray(services) ? services.find((s) => s.name === "ssh") : undefined;
      if (ssh?.port) candidates.push(Number(ssh.port));
    } catch { /* no REST rights: the usual ports below */ }
    for (const p of COMMON_SSH_PORTS) if (!candidates.includes(p)) candidates.push(p);
    const tried: string[] = [];
    for (const p of candidates) {
      const id = await invoke<string | null>("ssh_identify", { args: sshArgs(profile), port: p }).catch(() => null);
      tried.push(`${p}: ${id ?? "no answer"}`);
      if (id && id.includes("ROSSSH")) {
        setPort(String(p));
        setNote({ text: `RouterOS answers SSH on port ${p}.`, ok: true });
        setBusy(false);
        return;
      }
    }
    setNote({ text: `No RouterOS SSH found (${tried.join(" · ")}). Check the router's ip/service ssh and any port forward.`, ok: false });
    setBusy(false);
  }

  const n = Number(port);
  const valid = Number.isInteger(n) && n > 0 && n < 65536;
  return (
    <div className={`mt-3 rounded-md border p-2 text-left font-mono text-[11px] ${highlight ? "border-amber/50 bg-amber/10" : "border-line bg-panel-2/40"}`}>
      <div className="mb-1.5 text-ink-dim">
        {highlight ? "The SSH port of this device points at another machine. The router's SSH port:" : "SSH port of this device:"}
      </div>
      <div className="flex items-center gap-1.5">
        <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} inputMode="numeric"
          className="w-20 rounded border border-line bg-panel px-1.5 py-0.5 text-ink outline-none focus:border-accent" />
        <button type="button" onClick={() => void find()} disabled={busy}
          className="inline-flex items-center gap-1 rounded border border-line-strong px-2 py-0.5 text-ink-dim hover:text-accent disabled:opacity-50">
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Search size={11} />} Find it
        </button>
        <button type="button" onClick={() => valid && onUse(n)} disabled={!valid || n === current && !highlight}
          className="ml-auto rounded bg-accent px-2 py-0.5 font-semibold text-bg hover:brightness-110 disabled:opacity-40">
          Save &amp; connect
        </button>
      </div>
      {note && <p className={`mt-1.5 ${note.ok ? "text-accent" : "text-ink-faint"}`}>{note.text}</p>}
    </div>
  );
}
