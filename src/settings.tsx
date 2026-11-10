// The user's local preferences: appearance, terminal, behaviour and
// notifications. Stored by the backend in settings.json (app config dir), applied
// live in every window (a save is broadcast as the "wingox-settings" event).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Bell, Monitor, Moon, Palette, RotateCcw, Settings as Gear, SlidersHorizontal, Sun, SquareTerminal, X,
} from "lucide-react";
import { MENU } from "./menu";

export type ThemePref = "dark" | "light" | "system";
export type Density = "compact" | "normal" | "comfortable";

export interface Settings {
  theme: ThemePref;
  /** accent color (hex); null = the theme's own green */
  accent: string | null;
  uiFont: string;
  monoFont: string;
  /** whole-app zoom, percent */
  scale: number;
  density: Density;
  termFontSize: number;
  termCursor: "block" | "bar" | "underline";
  termBlink: boolean;
  termScrollback: number;
  monitorEvery: number;
  confirmCloseAll: boolean;
  /** the section a newly opened device shows */
  defaultView: string;
  osNotifications: boolean;
  notifyRecovery: boolean;
  sound: boolean;
}

export const DEFAULTS: Settings = {
  theme: "dark",
  accent: null,
  uiFont: "Inter",
  monoFont: "JetBrains Mono",
  scale: 100,
  density: "normal",
  termFontSize: 13,
  termCursor: "block",
  termBlink: true,
  termScrollback: 5000,
  monitorEvery: 30,
  confirmCloseAll: true,
  defaultView: "overview",
  osNotifications: true,
  notifyRecovery: true,
  sound: false,
};

export const UI_FONTS = [
  { id: "Inter", label: "Inter", css: '"Inter", system-ui, sans-serif' },
  { id: "system", label: "System (Segoe UI…)", css: 'system-ui, "Segoe UI", Roboto, sans-serif' },
];
export const MONO_FONTS = [
  { id: "JetBrains Mono", label: "JetBrains Mono", css: '"JetBrains Mono", ui-monospace, monospace' },
  { id: "Cascadia Code", label: "Cascadia Code", css: '"Cascadia Code", "Cascadia Mono", Consolas, monospace' },
  { id: "Consolas", label: "Consolas", css: 'Consolas, "Courier New", monospace' },
  { id: "system", label: "System monospace", css: "ui-monospace, monospace" },
];
export const ACCENTS = [
  { id: null, label: "Wingox green" },
  { id: "#60a5fa", label: "Blue" },
  { id: "#22d3ee", label: "Cyan" },
  { id: "#a78bfa", label: "Violet" },
  { id: "#f59e0b", label: "Orange" },
  { id: "#f472b6", label: "Pink" },
] as const;
export const MONITOR_INTERVALS = [10, 30, 60, 300];

const fontCss = (list: { id: string; css: string }[], id: string) => (list.find((f) => f.id === id) ?? list[0]).css;
export const monoCss = (s: Settings) => fontCss(MONO_FONTS, s.monoFont);

/** a stored document merged over the defaults (unknown or mistyped keys are dropped) */
function sanitize(raw: unknown): Settings {
  const out: Settings = { ...DEFAULTS };
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      const v = (raw as Record<string, unknown>)[k];
      const d = DEFAULTS[k];
      if (v === undefined) continue;
      if (k === "accent" ? v === null || typeof v === "string" : typeof v === typeof d) (out as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/** preferences that used to live in localStorage come along once */
function legacy(): Partial<Settings> {
  const out: Partial<Settings> = {};
  try {
    const t = localStorage.getItem("wingox.theme");
    if (t === "light" || t === "dark") out.theme = t;
    const m = Number(localStorage.getItem("wingox.monitor.every"));
    if (MONITOR_INTERVALS.includes(m)) out.monitorEvery = m;
  } catch { /* ignore */ }
  return out;
}

interface Ctx {
  settings: Settings;
  update: (change: Partial<Settings>) => void;
  reset: () => void;
  /** the theme actually shown ("system" resolved) */
  resolvedTheme: "dark" | "light";
}
const SettingsCtx = createContext<Ctx | null>(null);

export function useSettings(): Ctx {
  const ctx = useContext(SettingsCtx);
  if (!ctx) throw new Error("useSettings outside SettingsProvider");
  return ctx;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(() => ({ ...DEFAULTS, ...legacy() }));
  const loaded = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // load once; follow saves made in other windows
  useEffect(() => {
    invoke<unknown>("settings_get")
      .then((raw) => {
        const empty = !raw || (typeof raw === "object" && Object.keys(raw as object).length === 0);
        setSettings(empty ? { ...DEFAULTS, ...legacy() } : sanitize(raw));
      })
      .catch(() => { /* outside the desktop shell: defaults */ })
      .finally(() => { loaded.current = true; });
    let off: (() => void) | undefined;
    listen<unknown>("wingox-settings", ({ payload }) => setSettings(sanitize(payload)))
      .then((u) => { off = u; })
      .catch(() => { /* outside the shell */ });
    return () => off?.();
  }, []);

  const persist = useCallback((next: Settings) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void invoke("settings_save", { settings: next }).catch((e) => console.warn("settings_save:", e));
    }, 250);
  }, []);

  const update = useCallback((change: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s, ...change };
      persist(next);
      return next;
    });
  }, [persist]);
  const reset = useCallback(() => { setSettings(DEFAULTS); persist(DEFAULTS); }, [persist]);

  // the OS theme, for "system"
  const [osDark, setOsDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const on = (e: MediaQueryListEvent) => setOsDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const resolvedTheme: "dark" | "light" = settings.theme === "system" ? (osDark ? "dark" : "light") : settings.theme;

  // apply: theme, accent, fonts, density on <html>; zoom on the webview
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.dataset.density = settings.density;
    if (settings.accent) root.style.setProperty("--wx-accent", settings.accent);
    else root.style.removeProperty("--wx-accent");
    root.style.setProperty("--font-sans", fontCss(UI_FONTS, settings.uiFont));
    root.style.setProperty("--font-mono", fontCss(MONO_FONTS, settings.monoFont));
    try { localStorage.setItem("wingox.theme", resolvedTheme); } catch { /* ignore */ }
  }, [resolvedTheme, settings.accent, settings.uiFont, settings.monoFont, settings.density]);

  useEffect(() => {
    const factor = settings.scale / 100;
    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(factor))
      .catch(() => { (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom = String(factor); });
  }, [settings.scale]);

  const value = useMemo(() => ({ settings, update, reset, resolvedTheme }), [settings, update, reset, resolvedTheme]);
  return <SettingsCtx.Provider value={value}>{children}</SettingsCtx.Provider>;
}

// ── the gear button and the dialog ───────────────────────────────────────────

type Tab = "appearance" | "terminal" | "behaviour" | "notifications";
const TABS: { id: Tab; label: string; Icon: typeof Palette }[] = [
  { id: "appearance", label: "Appearance", Icon: Palette },
  { id: "terminal", label: "Terminal", Icon: SquareTerminal },
  { id: "behaviour", label: "Behaviour", Icon: SlidersHorizontal },
  { id: "notifications", label: "Notifications", Icon: Bell },
];

export function SettingsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" title="Settings" onClick={() => setOpen(true)}
        className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-panel/70 text-ink-faint transition hover:text-accent">
        <Gear size={16} />
      </button>
      {/* on <body>: an ancestor with backdrop-filter (the header) would trap a fixed overlay */}
      {open && createPortal(<SettingsDialog onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings: s, update, reset } = useSettings();
  const [tab, setTab] = useState<Tab>("appearance");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sections = MENU.flatMap((m) => (m.section ? [{ id: m.section.id, label: m.label }] : (m.children ?? []).map((c) => ({ id: c.id, label: `${m.label} ▸ ${c.label}` }))));
  const resetColumns = () => {
    try { for (const k of Object.keys(localStorage)) if (k.startsWith("wingox.cols.")) localStorage.removeItem(k); } catch { /* ignore */ }
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-bg/70 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div role="dialog" aria-label="Settings" onMouseDown={(e) => e.stopPropagation()}
        className="wx-rise flex h-[min(560px,90vh)] w-full max-w-2xl overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl">
        <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-line bg-panel-2/50 p-2">
          <div className="mb-2 flex items-center gap-2 px-2 pt-1 font-mono text-sm font-semibold text-ink"><Gear size={15} className="text-accent" /> Settings</div>
          {TABS.map(({ id, label, Icon }) => (
            <button key={id} type="button" onClick={() => setTab(id)}
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-xs transition ${
                tab === id ? "bg-accent/15 text-accent" : "text-ink-dim hover:bg-panel-2 hover:text-ink"}`}>
              <Icon size={13} /> {label}
            </button>
          ))}
          <button type="button" onClick={reset} title="Every setting back to its default"
            className="mt-auto flex items-center gap-1.5 rounded-md px-2 py-1.5 font-mono text-[11px] text-ink-faint hover:text-danger">
            <RotateCcw size={12} /> Reset all
          </button>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center border-b border-line px-4 py-2.5">
            <h3 className="font-mono text-sm text-ink">{TABS.find((t) => t.id === tab)!.label}</h3>
            <span className="ml-3 text-[11px] text-ink-faint">saved automatically · this computer only</span>
            <button type="button" onClick={onClose} title="Close" className="ml-auto text-ink-faint hover:text-ink"><X size={15} /></button>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 text-sm">
            {tab === "appearance" && (
              <>
                <Row label="Theme">
                  <Segmented value={s.theme} onChange={(theme) => update({ theme })} options={[
                    { id: "dark", label: "Dark", Icon: Moon }, { id: "light", label: "Light", Icon: Sun }, { id: "system", label: "System", Icon: Monitor },
                  ]} />
                </Row>
                <Row label="Accent color">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {ACCENTS.map((a) => (
                      <button key={a.label} type="button" title={a.label} onClick={() => update({ accent: a.id })}
                        className={`h-6 w-6 rounded-full border-2 transition ${s.accent === a.id ? "border-ink" : "border-transparent hover:border-line-strong"}`}
                        style={{ background: a.id ?? "#4ade80" }} />
                    ))}
                    <label title="Custom color" className="ml-1 flex items-center gap-1 font-mono text-[11px] text-ink-faint">
                      <input type="color" value={s.accent ?? "#4ade80"} onChange={(e) => update({ accent: e.target.value })}
                        className="h-6 w-8 cursor-pointer rounded border border-line bg-transparent" /> custom
                    </label>
                  </div>
                </Row>
                <Row label="Interface font">
                  <Select value={s.uiFont} onChange={(uiFont) => update({ uiFont })} options={UI_FONTS} />
                </Row>
                <Row label="Data font (tables, terminal)">
                  <Select value={s.monoFont} onChange={(monoFont) => update({ monoFont })} options={MONO_FONTS} />
                  <p className="mt-1 text-[11px] text-ink-faint">Cascadia Code and Consolas come with Windows; JetBrains Mono ships with Wingox.</p>
                </Row>
                <Row label={`Interface size — ${s.scale}%`}>
                  <input type="range" min={80} max={150} step={5} value={s.scale} onChange={(e) => update({ scale: Number(e.target.value) })}
                    className="w-full accent-accent" />
                </Row>
                <Row label="Table density">
                  <Segmented value={s.density} onChange={(density) => update({ density })} options={[
                    { id: "compact", label: "Compact" }, { id: "normal", label: "Normal" }, { id: "comfortable", label: "Comfortable" },
                  ]} />
                </Row>
              </>
            )}

            {tab === "terminal" && (
              <>
                <Row label={`Font size — ${s.termFontSize}px`}>
                  <input type="range" min={10} max={22} value={s.termFontSize} onChange={(e) => update({ termFontSize: Number(e.target.value) })}
                    className="w-full accent-accent" />
                </Row>
                <Row label="Cursor">
                  <Segmented value={s.termCursor} onChange={(termCursor) => update({ termCursor })} options={[
                    { id: "block", label: "Block" }, { id: "bar", label: "Bar" }, { id: "underline", label: "Underline" },
                  ]} />
                </Row>
                <Toggle label="Blinking cursor" value={s.termBlink} onChange={(termBlink) => update({ termBlink })} />
                <Row label="Scrollback (lines)">
                  <Select value={String(s.termScrollback)} onChange={(v) => update({ termScrollback: Number(v) })}
                    options={[1000, 5000, 10000, 50000].map((n) => ({ id: String(n), label: n.toLocaleString() }))} />
                </Row>
                <p className="text-[11px] text-ink-faint">The terminal font is the data font (Appearance). Changes apply to open terminals too.</p>
              </>
            )}

            {tab === "behaviour" && (
              <>
                <Row label="A device opens on">
                  <Select value={s.defaultView} onChange={(defaultView) => update({ defaultView })}
                    options={sections.map((x) => ({ id: x.id, label: x.label }))} />
                </Row>
                <Row label="Monitor probes every">
                  <Select value={String(s.monitorEvery)} onChange={(v) => update({ monitorEvery: Number(v) })}
                    options={MONITOR_INTERVALS.map((n) => ({ id: String(n), label: n < 60 ? `${n} seconds` : `${n / 60} minute${n > 60 ? "s" : ""}` }))} />
                </Row>
                <Toggle label='Ask before "Close all"' value={s.confirmCloseAll} onChange={(confirmCloseAll) => update({ confirmCloseAll })} />
                <Row label="Column widths">
                  <button type="button" onClick={resetColumns}
                    className="rounded-md border border-line-strong bg-panel-2 px-3 py-1.5 font-mono text-xs text-ink-dim hover:text-ink">
                    Reset all column widths
                  </button>
                  <p className="mt-1 text-[11px] text-ink-faint">Tables opened afterwards fit their columns to the content again.</p>
                </Row>
              </>
            )}

            {tab === "notifications" && (
              <>
                <Toggle label="System notifications when a monitored device stops answering" value={s.osNotifications}
                  onChange={(osNotifications) => update({ osNotifications })} />
                <Toggle label="…and when it comes back" value={s.notifyRecovery} onChange={(notifyRecovery) => update({ notifyRecovery })} />
                <Toggle label="Play a sound with the alert" value={s.sound} onChange={(sound) => update({ sound })} />
                <p className="text-[11px] text-ink-faint">The in-app alert always shows; these control the operating system's notification and the sound.</p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 font-mono text-xs text-ink-faint">{label}</div>
      {children}
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink-dim">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} className="accent-accent" /> {label}
    </label>
  );
}

function Select<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { id: string; label: string }[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)}
      className="w-full rounded-md border border-line-strong bg-panel-2 px-2.5 py-1.5 font-mono text-xs text-ink outline-none focus:border-accent">
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}

function Segmented<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: { id: T; label: string; Icon?: typeof Moon }[];
}) {
  return (
    <div className="inline-flex gap-1 rounded-lg border border-line-strong bg-panel-2 p-1">
      {options.map(({ id, label, Icon }) => (
        <button key={id} type="button" onClick={() => onChange(id)}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1 font-mono text-xs transition ${
            value === id ? "bg-accent/20 text-accent" : "text-ink-faint hover:text-ink"}`}>
          {Icon && <Icon size={12} />} {label}
        </button>
      ))}
    </div>
  );
}

/** a short two-tone alert sound (WebAudio, nothing to ship) */
export function beep() {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    [880, 660].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.18);
      o.stop(ctx.currentTime + i * 0.18 + 0.17);
    });
    setTimeout(() => void ctx.close(), 600);
  } catch { /* no audio */ }
}
