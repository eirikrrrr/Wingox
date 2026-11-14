// A RouterOS item in a window of its own, like WinBox's item dialogs: every
// property with its full value (nothing cut off by a column), the ones the
// router lets you change as inputs — with the values it suggests for each —
// and the exact change listed before it is applied. Also used to add an item
// (empty form) and, inline, for settings menus (PropertyForm).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Ban, Check, ClipboardCopy, Loader2, Plus, Search, Trash2, X } from "lucide-react";
import type { Api, Field, Row } from "./rest";

/** a property as text, the way the form edits it */
const text = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const truthy = (v: unknown) => v === true || v === "true" || v === "yes";

/** fields shown first, when a menu has them */
const FIRST = ["name", "interface", "address", "network", "dst-address", "gateway", "chain", "action", "list", "vlan-id",
  "bridge", "type", "comment", "disabled"];

/** properties that are RouterOS bookkeeping, never shown as fields */
const INTERNAL = new Set([".id", ".nextid", ".about"]);

/** the name a window is titled with */
export function itemName(row: Row): string {
  for (const k of ["name", "address", "dst-address", "host", "list", "chain", "interface", "mac-address", "user"]) {
    if (row[k] != null && String(row[k]) !== "") return String(row[k]);
  }
  return String(row[".id"] ?? "");
}

/** the fields a command takes, read from the router (null while loading) */
function useFields(api: Api, path: string, cmd: string | null) {
  const [state, setState] = useState<{ fields: Field[] | null; error: string | null }>({ fields: null, error: null });
  useEffect(() => {
    if (!cmd) { setState({ fields: [], error: null }); return; }
    let live = true;
    api.fields(path, cmd)
      .then((fields) => live && setState({ fields, error: null }))
      .catch((e) => live && setState({ fields: [], error: String(e) }));
    return () => { live = false; };
  }, [api, path, cmd]);
  return state;
}

export interface Change {
  name: string;
  from: string;
  to: string;
}

/** what differs between the original and the form */
function changesOf(original: Row, values: Record<string, string>, adding: boolean): Change[] {
  const out: Change[] = [];
  for (const [name, to] of Object.entries(values)) {
    const from = text(original[name]);
    if (adding ? to.trim() !== "" : to !== from) out.push({ name, from, to });
  }
  return out;
}

const asBody = (changes: Change[]): Row => Object.fromEntries(changes.map((c) => [c.name, c.to]));

/** the form itself: editable fields, then the read-only status */
function Fields({ api, path, cmd, original, fields, values, setValues, filter, readOnly }: {
  api: Api;
  path: string;
  cmd: string;
  original: Row;
  fields: Field[];
  values: Record<string, string>;
  setValues: (f: (v: Record<string, string>) => Record<string, string>) => void;
  filter: string;
  readOnly: boolean;
}) {
  const editable = new Set(readOnly ? [] : fields.map((f) => f.name));
  const help = new Map(fields.map((f) => [f.name, f.help]));
  // what identifies an item first (like WinBox's General tab), then the item's own
  // properties in the router's order, then settable ones it does not show
  const rest = [...Object.keys(original).filter((k) => !INTERNAL.has(k)), ...fields.map((f) => f.name).filter((n) => !(n in original))];
  const names = [...FIRST.filter((n) => rest.includes(n)), ...rest.filter((n) => !FIRST.includes(n))];
  const q = filter.trim().toLowerCase();
  const hit = (n: string) => !q || n.includes(q) || (values[n] ?? text(original[n])).toLowerCase().includes(q);
  const edit = names.filter((n) => editable.has(n) && hit(n));
  const status = names.filter((n) => !editable.has(n) && hit(n));
  return (
    <div className="grid grid-cols-[minmax(110px,34%)_1fr] items-start gap-x-3 gap-y-1 font-mono text-xs">
      {edit.map((n) => (
        <FieldInput key={n} name={n} help={help.get(n) ?? ""} value={values[n] ?? text(original[n])}
          changed={n in values && values[n] !== text(original[n])}
          onChange={(v) => setValues((all) => ({ ...all, [n]: v }))}
          suggest={() => api.values(path, cmd, n)} />
      ))}
      {status.length > 0 && (
        <>
          {edit.length > 0 && <div className="col-span-2 mt-2 border-b border-line pb-0.5 text-[10px] uppercase tracking-wide text-ink-faint">Status</div>}
          {status.map((n) => (
            <div key={n} className="contents">
              <span className="truncate py-0.5 text-ink-faint" title={n}>{n}</span>
              <span className="select-text whitespace-pre-wrap break-all py-0.5 text-ink-dim">{text(original[n]) || "—"}</span>
            </div>
          ))}
        </>
      )}
      {edit.length + status.length === 0 && <span className="col-span-2 py-2 text-center text-ink-faint">nothing matches</span>}
    </div>
  );
}

function FieldInput({ name, help, value, changed, onChange, suggest }: {
  name: string;
  help: string;
  value: string;
  changed: boolean;
  onChange: (v: string) => void;
  suggest: () => Promise<string[]>;
}) {
  const [options, setOptions] = useState<string[] | null>(null);
  const listId = useMemo(() => `wx-opts-${Math.random().toString(36).slice(2)}`, []);
  const long = value.length > 60 || value.includes("\n");
  // the values RouterOS knows for this field (enums, interface names…), asked on first focus
  const load = () => { if (options === null) suggest().then(setOptions, () => setOptions([])); };
  const cls = `w-full rounded border bg-panel px-1.5 py-0.5 text-ink outline-none focus:border-accent ${changed ? "border-accent/70 bg-accent/5" : "border-line"}`;
  return (
    <>
      <label className={`truncate py-1 ${changed ? "text-accent" : "text-ink-dim"}`} title={help ? `${name} — ${help}` : name}>{name}</label>
      {long ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={Math.min(12, value.split("\n").length + 1)}
          spellCheck={false} className={`${cls} resize-y`} />
      ) : (
        <>
          <input value={value} onChange={(e) => onChange(e.target.value)} onFocus={load} list={listId}
            spellCheck={false} placeholder={help ? help.slice(0, 60) : ""} className={cls} />
          {options && options.length > 0 && (
            <datalist id={listId}>{options.map((o) => <option key={o} value={o} />)}</datalist>
          )}
        </>
      )}
    </>
  );
}

/** the change about to be applied, field by field */
function ChangeList({ changes, adding }: { changes: Change[]; adding: boolean }) {
  if (!changes.length) return null;
  return (
    <div className="max-h-28 shrink-0 overflow-y-auto border-t border-line bg-panel-2/40 px-3 py-1.5 font-mono text-[11px]">
      {changes.map((c) => (
        <div key={c.name} className="truncate">
          <span className="text-ink-faint">{c.name}:</span>{" "}
          {adding ? <span className="text-accent">{c.to}</span> : (
            <><span className="text-danger line-through decoration-danger/60">{c.from || "∅"}</span> → <span className="text-accent">{c.to || "∅"}</span></>
          )}
        </div>
      ))}
    </div>
  );
}

const Btn = ({ children, onClick, tone = "plain", disabled, title }: {
  children: ReactNode; onClick: () => void; tone?: "plain" | "primary" | "danger"; disabled?: boolean; title?: string;
}) => (
  <button type="button" onClick={onClick} disabled={disabled} title={title}
    className={`flex items-center gap-1 rounded-md px-2.5 py-1 font-mono text-[11px] transition disabled:opacity-40 ${
      tone === "primary" ? "bg-accent font-semibold text-bg hover:brightness-110"
      : tone === "danger" ? "text-danger hover:bg-danger/15"
      : "text-ink-dim hover:bg-panel-2 hover:text-ink"}`}>
    {children}
  </button>
);

/**
 * The window. `row` = the item (edit/view), absent to add one. `cmds` = the
 * menu's commands when known (from the router's tree): no `set` → read-only.
 */
export function ItemWindow({ api, path, title, row, cmds, onClose, onChanged }: {
  api: Api;
  path: string;
  /** the section's name ("Bridges", "Addresses"…) */
  title: string;
  row?: Row;
  cmds?: string[];
  onClose: () => void;
  /** something changed on the router: re-read the table */
  onChanged: () => void;
}) {
  const adding = !row;
  const can = (c: string) => !cmds || cmds.includes(c);
  const cmd = adding ? (can("add") ? "add" : null) : can("set") ? "set" : null;
  const [original, setOriginal] = useState<Row>(row ?? {});
  const { fields, error: fieldsError } = useFields(api, path, cmd);
  const [values, setValues] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const id = original[".id"] ? String(original[".id"]) : null;
  const dynamic = truthy(original.dynamic);
  const disabled = truthy(original.disabled);
  const readOnly = !cmd || (fieldsError !== null && !adding);
  const changes = changesOf(original, values, adding);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void apply(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function run(label: string, job: () => Promise<unknown>, after?: (result: unknown) => void) {
    setBusy(label);
    setError(null);
    try {
      const result = await job();
      after?.(result);
      onChanged();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function apply(close: boolean) {
    if (busy) return;
    if (!changes.length) { if (close) onClose(); return; }
    const body = asBody(changes);
    const ok = adding
      ? await run("adding", () => api.add(path, body))
      : await run("applying", () => api.set(path, id!, body), (r) => {
        // PATCH answers the whole item as it now is
        if (r && typeof r === "object" && !Array.isArray(r)) setOriginal(r as Row);
        setValues({});
      });
    if (ok && (close || adding)) onClose();
  }

  const toggle = () => void run(disabled ? "enabling" : "disabling",
    () => (disabled ? api.enable(path, id!) : api.disable(path, id!)),
    () => setOriginal((o) => ({ ...o, disabled: disabled ? "false" : "true" })));
  const remove = async () => {
    if (await run("removing", () => api.remove(path, id!))) onClose();
  };
  const copy = async () => {
    const lines = Object.entries(original).filter(([k]) => !INTERNAL.has(k)).map(([k, v]) => `${k}=${text(v)}`);
    try { await navigator.clipboard.writeText(lines.join("\n")); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* blocked */ }
  };

  const heading = adding ? `${title} — new item` : `${title} <${itemName(original)}>`;
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-bg/60 p-4 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div ref={box} role="dialog" aria-label={heading} onMouseDown={(e) => e.stopPropagation()}
        className="wx-rise flex max-h-[min(720px,92vh)] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-line-strong bg-panel shadow-2xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel-2/70 px-3 py-1.5">
          {adding ? <Plus size={13} className="text-accent" /> : <span className={`h-2 w-2 rounded-full ${disabled ? "bg-ink-faint" : "bg-accent"}`} />}
          <span className="min-w-0 truncate font-mono text-xs font-semibold text-ink">{heading}</span>
          <span className="hidden truncate font-mono text-[10px] text-ink-faint sm:inline">/{path}{id ? ` ${id}` : ""}</span>
          <div className="ml-auto flex items-center gap-1 rounded border border-line bg-panel px-1.5">
            <Search size={11} className="text-ink-faint" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find field"
              className="w-24 bg-transparent py-0.5 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint" />
          </div>
          <button type="button" onClick={onClose} title="Close (Esc)" className="grid h-6 w-6 place-items-center rounded text-ink-faint hover:bg-danger/15 hover:text-danger"><X size={13} /></button>
        </div>
        {(dynamic || readOnly || fieldsError) && (
          <div className="shrink-0 border-b border-line bg-amber/10 px-3 py-1 font-mono text-[10.5px] text-amber">
            {dynamic ? "Dynamic item: RouterOS manages it, changes may be refused. "
              : !cmd ? "This menu cannot be changed (RouterOS has no set/add for it). "
              : fieldsError ? `Could not read the fields from the router (${fieldsError}) — shown read-only. ` : ""}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {fields === null ? (
            <div className="flex items-center gap-2 py-6 font-mono text-xs text-ink-faint"><Loader2 size={13} className="animate-spin" /> reading the fields from the router…</div>
          ) : (
            <Fields api={api} path={path} cmd={cmd ?? "set"} original={original} fields={fields} values={values}
              setValues={setValues} filter={filter} readOnly={readOnly} />
          )}
        </div>
        <ChangeList changes={changes} adding={adding} />
        {error && <div className="shrink-0 border-t border-danger/40 bg-danger/10 px-3 py-1.5 font-mono text-[11px] text-danger">{error}</div>}
        <div className="flex shrink-0 items-center gap-1 border-t border-line bg-panel-2/50 px-2 py-1.5">
          {!adding && id && can("enable") && (
            <Btn onClick={toggle} disabled={!!busy} title={disabled ? "Enable this item" : "Disable this item"}>
              {disabled ? <Check size={12} /> : <Ban size={12} />} {disabled ? "Enable" : "Disable"}
            </Btn>
          )}
          {!adding && id && can("remove") && (
            confirmRemove
              ? <Btn tone="danger" onClick={() => void remove()} disabled={!!busy}><Trash2 size={12} /> Confirm remove</Btn>
              : <Btn tone="danger" onClick={() => setConfirmRemove(true)} disabled={!!busy}><Trash2 size={12} /> Remove</Btn>
          )}
          {!adding && <Btn onClick={() => void copy()} title="Copy every property as name=value lines"><ClipboardCopy size={12} /> {copied ? "Copied" : "Copy"}</Btn>}
          <span className="ml-auto flex items-center gap-1">
            {busy && <span className="flex items-center gap-1 font-mono text-[10.5px] text-ink-faint"><Loader2 size={11} className="animate-spin" /> {busy}…</span>}
            <Btn onClick={onClose}>{readOnly && !adding ? "Close" : "Cancel"}</Btn>
            {!readOnly && !adding && <Btn onClick={() => void apply(false)} disabled={!!busy || !changes.length}>Apply</Btn>}
            {!readOnly && (
              <Btn tone="primary" onClick={() => void apply(true)} disabled={!!busy || (adding && !changes.length)}
                title="Ctrl+Enter">{adding ? "Add" : "OK"}</Btn>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * A settings menu (one object: ip/dns, system/identity…) as an inline form,
 * applied with `set` — the window's body without the window.
 */
export function PropertyForm({ api, path, value, canSet, filter, onChanged }: {
  api: Api;
  path: string;
  value: Row;
  canSet: boolean;
  filter: string;
  onChanged: () => void;
}) {
  const { fields, error: fieldsError } = useFields(api, path, canSet ? "set" : null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changes = changesOf(value, values, false);
  const readOnly = !canSet || fieldsError !== null;

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      await api.setSettings(path, asBody(changes));
      setValues({});
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {fields === null
          ? <div className="flex items-center gap-2 p-2 font-mono text-xs text-ink-faint"><Loader2 size={13} className="animate-spin" /> reading the fields…</div>
          : <Fields api={api} path={path} cmd="set" original={value} fields={fields} values={values} setValues={setValues}
              filter={filter} readOnly={readOnly} />}
      </div>
      <ChangeList changes={changes} adding={false} />
      {error && <div className="border-t border-danger/40 bg-danger/10 px-3 py-1 font-mono text-[11px] text-danger">{error}</div>}
      {changes.length > 0 && (
        <div className="flex items-center justify-end gap-1 border-t border-line bg-panel-2/50 px-2 py-1">
          <Btn onClick={() => setValues({})} disabled={busy}>Discard</Btn>
          <Btn tone="primary" onClick={() => void apply()} disabled={busy}>{busy ? "Applying…" : `Apply ${changes.length} change${changes.length > 1 ? "s" : ""}`}</Btn>
        </div>
      )}
    </div>
  );
}
