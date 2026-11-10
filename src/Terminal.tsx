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
import { KeyRound, Loader2, RotateCw, SquareTerminal, TriangleAlert } from "lucide-react";
import type { Profile } from "./App";

interface HostKeyInfo { algorithm: string; sha256: string }
interface SshError { kind: "hostKeyUnknown" | "hostKeyMismatch" | "other"; message: string; got?: string; expected?: string; algorithm?: string }
type SshEvent = { kind: "data"; b64: string } | { kind: "closed"; reason: string | null };

type Phase =
  | { at: "checking" }
  | { at: "trust"; key: HostKeyInfo }
  | { at: "mismatch"; expected: string; got: string }
  | { at: "connecting" }
  | { at: "open" }
  | { at: "closed"; reason: string | null }
  | { at: "error"; message: string };

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

export function SshTerminal({ profile, onPinHostKey }: { profile: Profile; onPinHostKey: (key: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const session = useRef<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ at: "checking" });
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
      else setPhase({ at: "error", message: err.message });
    }
  }, [closeSession]);

  // the terminal itself lives as long as the pane
  useEffect(() => {
    const t = new XTerm({
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
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
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

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
              </dl>
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
            </div>
          )}
        </div>
      )}
    </div>
  );
}
