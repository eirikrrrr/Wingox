// How a profile trusts its router's TLS certificate: pinned fingerprint (trust
// on first use), a trusted CA (PEM), the public roots, or anything (insecure).
import { useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BadgeCheck, FileUp, Fingerprint, Loader2, ShieldAlert, ShieldCheck, TriangleAlert, X } from "lucide-react";

export type TlsMode = "pinned" | "ca" | "verify" | "insecure";

export interface CertificateInfo {
  sha256: string;
  sha256Pretty: string;
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  subjectAltNames: string[];
  selfSigned: boolean;
}

/** what a profile uses: profiles saved before the choice existed keep their old behaviour */
export const tlsModeOf = (p: { tlsMode?: TlsMode | ""; insecure: boolean }): TlsMode =>
  p.tlsMode || (p.insecure ? "insecure" : "verify");

export const normalizePin = (raw: string) => raw.replace(/[\s:-]/g, "").toLowerCase();
export const prettyPin = (hex: string) => (hex.match(/.{1,2}/g) ?? []).join(":").toUpperCase();
export const pemCount = (pem: string) => (pem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length;

const MODES: { id: TlsMode; label: string; Icon: typeof Fingerprint }[] = [
  { id: "pinned", label: "Pinned", Icon: Fingerprint },
  { id: "ca", label: "Trusted CA", Icon: BadgeCheck },
  { id: "verify", label: "Public CA", Icon: ShieldCheck },
  { id: "insecure", label: "Accept any", Icon: ShieldAlert },
];

interface Props {
  mode: TlsMode;
  pin: string;
  caPem: string;
  onChange: (change: { tlsMode?: TlsMode; pin?: string; caPem?: string; insecure?: boolean }) => void;
  /** the connection args (host, port, proxy…) to fetch the certificate along the same route */
  fetchArgs: () => unknown;
}

export function CertificateSection({ mode, pin, caPem, onChange, fetchArgs }: Props) {
  const [fetching, setFetching] = useState(false);
  const [cert, setCert] = useState<CertificateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  async function fetchCert() {
    setFetching(true);
    setError(null);
    setCert(null);
    try {
      setCert(await fetchCertificate(fetchArgs()));
    } catch (e) {
      setError(String(e));
    } finally {
      setFetching(false);
    }
  }

  function loadFile(f: File | undefined) {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => onChange({ caPem: String(reader.result ?? "") });
    reader.readAsText(f);
  }

  const pinHex = normalizePin(pin);
  const pinValid = /^[0-9a-f]{64}$/.test(pinHex);

  return (
    <div className="mb-3">
      <span className="mb-1 block font-mono text-xs text-ink-faint">Certificate</span>
      <div className="grid grid-cols-4 gap-1 rounded-lg border border-line-strong bg-panel-2 p-1">
        {MODES.map(({ id, label, Icon }) => (
          <button key={id} type="button" onClick={() => onChange({ tlsMode: id, insecure: id === "insecure" })}
            className={`flex items-center justify-center gap-1 rounded-md px-1 py-1.5 font-mono text-[11px] transition ${
              mode === id ? (id === "insecure" ? "bg-amber/20 text-amber" : "bg-accent/20 text-accent") : "text-ink-faint hover:text-ink"}`}>
            <Icon size={12} className="shrink-0" /> <span className="truncate">{label}</span>
          </button>
        ))}
      </div>

      <div className="mt-2 rounded-lg border border-line bg-panel-2/60 p-2.5 text-xs text-ink-dim">
        {mode === "pinned" && (
          <>
            <p className="mb-2">
              Only the router's exact certificate is accepted (its SHA-256 fingerprint). Recommended for RouterOS's
              self-signed certificates. <b className="text-ink">Fetch</b> reads it without sending any credentials.
            </p>
            <div className="flex gap-1.5">
              <input value={pinValid ? prettyPin(pinHex) : pin} onChange={(e) => onChange({ pin: e.target.value })}
                placeholder="not pinned yet — Fetch, or paste a SHA-256"
                className="min-w-0 flex-1 rounded-md border border-line-strong bg-panel px-2 py-1.5 font-mono text-[10.5px] text-ink outline-none placeholder:text-ink-faint focus:border-accent" />
              <button type="button" onClick={() => void fetchCert()} disabled={fetching}
                className="flex shrink-0 items-center gap-1 rounded-md border border-line-strong bg-panel px-2.5 font-mono text-[11px] text-ink-dim hover:text-accent disabled:opacity-60">
                {fetching ? <Loader2 size={12} className="animate-spin" /> : <Fingerprint size={12} />} Fetch
              </button>
            </div>
            {pin && !pinValid && <p className="mt-1 text-danger">Not a SHA-256 fingerprint (64 hex digits).</p>}
            {!pin && <p className="mt-1 text-ink-faint">If you connect without a pin, Wingox shows the certificate first and asks you.</p>}
            {error && <p className="mt-1.5 font-mono text-[11px] text-danger">{error}</p>}
            {cert && (
              <CertCard cert={cert} pinned={pinValid ? pinHex : null}
                onTrust={() => { onChange({ pin: cert.sha256 }); setCert(null); }} onDismiss={() => setCert(null)} />
            )}
          </>
        )}

        {mode === "ca" && (
          <>
            <p className="mb-2">
              The router's certificate must be issued by this CA and name the host you connect to (e.g. your company's
              internal CA). Paste its certificate (PEM) or load the file — never its private key.
            </p>
            <textarea value={caPem} onChange={(e) => onChange({ caPem: e.target.value })} rows={4} spellCheck={false}
              placeholder={"-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"}
              className="w-full resize-y rounded-md border border-line-strong bg-panel px-2 py-1.5 font-mono text-[10.5px] text-ink outline-none placeholder:text-ink-faint focus:border-accent" />
            <div className="mt-1 flex items-center gap-2">
              <button type="button" onClick={() => file.current?.click()}
                className="flex items-center gap-1 rounded-md border border-line-strong bg-panel px-2.5 py-1 font-mono text-[11px] text-ink-dim hover:text-accent">
                <FileUp size={12} /> Load file…
              </button>
              <input ref={file} type="file" accept=".pem,.crt,.cer,.txt" className="hidden" onChange={(e) => loadFile(e.target.files?.[0])} />
              <span className={pemCount(caPem) ? "text-ok" : "text-ink-faint"}>
                {pemCount(caPem) ? `${pemCount(caPem)} certificate${pemCount(caPem) > 1 ? "s" : ""}` : "no certificate yet"}
              </span>
            </div>
          </>
        )}

        {mode === "verify" && (
          <p>Standard verification against the public roots — only for a certificate from a public CA (e.g. Let's Encrypt)
            that names this host. RouterOS's default self-signed certificate fails here: use Pinned.</p>
        )}

        {mode === "insecure" && (
          <p className="flex gap-1.5 text-amber">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" />
            <span>Any certificate is accepted — also an impostor's, who could then capture the RouterOS password.
              Prefer <b>Pinned</b>: it is as easy and it is safe.</span>
          </p>
        )}
      </div>
    </div>
  );
}

export async function fetchCertificate(args: unknown): Promise<CertificateInfo> {
  return invoke<CertificateInfo>("tls_fetch", { args });
}

/** the router's certificate, to compare and pin */
export function CertCard({ cert, pinned, onTrust, onDismiss, trustLabel = "Trust this certificate" }: {
  cert: CertificateInfo;
  pinned: string | null;
  onTrust: () => void;
  onDismiss: () => void;
  trustLabel?: string;
}) {
  const same = pinned === cert.sha256;
  const changed = !!pinned && !same;
  return (
    <div className={`wx-rise mt-2 rounded-md border p-2.5 ${changed ? "border-danger/60 bg-danger/10" : "border-line-strong bg-panel"}`}>
      <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[11px] font-semibold text-ink">
        <Fingerprint size={13} className="text-accent" /> Router certificate
        {cert.selfSigned && <span className="rounded bg-amber/15 px-1 text-[10px] font-normal text-amber">self-signed</span>}
        <button type="button" onClick={onDismiss} className="ml-auto text-ink-faint hover:text-ink" title="Dismiss"><X size={12} /></button>
      </div>
      <dl className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-0.5 font-mono text-[10.5px]">
        <Item k="subject">{cert.subject}</Item>
        <Item k="issuer">{cert.issuer}</Item>
        <Item k="valid">{cert.notBefore} → {cert.notAfter}</Item>
        {cert.subjectAltNames.length > 0 && <Item k="names">{cert.subjectAltNames.join(", ")}</Item>}
        <Item k="SHA-256"><span className="text-accent">{cert.sha256Pretty}</span></Item>
      </dl>
      <p className="mt-1.5 text-[10.5px] text-ink-faint">
        Compare it with the router: <span className="font-mono">/certificate print detail</span> → <span className="font-mono">fingerprint</span>.
      </p>
      {changed && (
        <p className="mt-1.5 flex gap-1 text-[11px] text-danger">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" /> It differs from the pinned one. Trust it only if you renewed the
          certificate on the router.
        </p>
      )}
      {same ? (
        <p className="mt-1.5 text-[11px] text-ok">This is the pinned certificate.</p>
      ) : (
        <button type="button" onClick={onTrust}
          className={`mt-2 w-full rounded-md px-3 py-1.5 font-mono text-xs font-semibold text-bg hover:brightness-110 ${changed ? "bg-danger" : "bg-accent"}`}>
          {trustLabel}
        </button>
      )}
    </div>
  );
}

function Item({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-faint">{k}</dt>
      <dd className="break-all text-ink">{children}</dd>
    </>
  );
}
