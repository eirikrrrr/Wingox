// A device on its own window (detached from the main one), so it can sit on
// another monitor. It keeps its pane layout, reconnects on open, and can dock
// back: the main window takes the tab again and this window closes.
import { useCallback, useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ArrowDownToLine, LockOpen, RefreshCw, Terminal } from "lucide-react";
import { AmbientNetwork } from "./AmbientNetwork";
import { newLeaf, normalizePane, type DeviceData, type Pane } from "./Pane";
import { Workspace } from "./Workspace";
import { PLAIN_HTTP_TITLE, isPlainHttp, label, probe, useTheme, type DetachPayload } from "./App";

export function Detached({ winLabel }: { winLabel: string }) {
  useTheme();
  const [payload] = useState<DetachPayload | null>(() => {
    try {
      const raw = localStorage.getItem(`wingox.detach.${winLabel}`);
      return raw ? (JSON.parse(raw) as DetachPayload) : null;
    } catch {
      return null;
    }
  });
  const [layout, setLayout] = useState<Pane>(() => (payload ? normalizePane(payload.layout) : newLeaf()));
  const [data, setData] = useState<DeviceData | null>(payload?.data ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reconnect = useCallback(async () => {
    if (!payload) return;
    setBusy(true);
    setError(null);
    try {
      setData(await probe(payload.profile));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [payload]);

  useEffect(() => { void reconnect(); }, [reconnect]);

  // "Close all sessions" in the main window closes this one too
  useEffect(() => {
    let off: (() => void) | undefined;
    listen("wingox-logout-all", () => {
      try { localStorage.removeItem(`wingox.detach.${winLabel}`); } catch { /* ignore */ }
      void getCurrentWebviewWindow().close();
    }).then((u) => { off = u; }).catch(() => { /* outside the desktop shell */ });
    return () => off?.();
  }, [winLabel]);

  async function dock() {
    if (!payload) return;
    try {
      await emit("wingox-dock", { profile: payload.profile, layout, data } satisfies DetachPayload);
      localStorage.removeItem(`wingox.detach.${winLabel}`);
      await getCurrentWebviewWindow().close();
    } catch (e) {
      setError(String(e));
    }
  }

  if (!payload) {
    return <div className="grid h-full place-items-center font-mono text-sm text-ink-faint">This window has no device.</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <AmbientNetwork />
      <header className="flex items-center gap-3 border-b border-line/80 px-4 py-2.5 backdrop-blur-sm">
        <span className="grid h-7 w-7 place-items-center rounded-md bg-accent/15 text-accent"><Terminal size={15} /></span>
        <div className="min-w-0">
          <div className="truncate font-mono text-sm font-semibold text-ink">{label(payload.profile)}</div>
          <div className="truncate text-[11px] text-ink-faint">
            {payload.profile.host}:{payload.profile.port}{payload.profile.proxy ? ` · via ${payload.profile.proxy.kind} ${payload.profile.proxy.host}` : ""}
            {isPlainHttp(payload.profile) && (
              <span title={PLAIN_HTTP_TITLE} className="ml-1 inline-flex items-center gap-0.5 text-danger"><LockOpen size={10} /> HTTP unencrypted</span>
            )}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={() => void reconnect()} title="Reconnect"
            className="flex items-center gap-1.5 rounded-md border border-line-strong bg-panel-2 px-2.5 py-1 font-mono text-xs text-ink-dim hover:text-ink">
            <RefreshCw size={12} className={busy ? "animate-spin" : ""} /> Reconnect
          </button>
          <button type="button" onClick={() => void dock()} title="Dock back into the main window"
            className="flex items-center gap-1.5 rounded-md bg-accent/90 px-2.5 py-1 font-mono text-xs font-semibold text-bg hover:brightness-110">
            <ArrowDownToLine size={12} /> Dock
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <Workspace profile={payload.profile} data={data} busy={busy} error={error} layout={layout} setLayout={setLayout} />
      </div>
    </div>
  );
}
