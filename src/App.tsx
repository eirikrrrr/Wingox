import { useState, type FormEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Server, ShieldAlert, Network, Cpu, Clock, Boxes, Loader2, Terminal } from "lucide-react";

type ProxyKind = "socks5" | "http";

interface Probe {
  identity: string;
  version: string;
  board: string;
  architecture: string;
  cpuLoad: string;
  uptime: string;
  interfaces: Record<string, unknown>[];
}

export function App() {
  const [host, setHost] = useState("");
  const [port, setPort] = useState(443);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [insecure, setInsecure] = useState(true);
  const [useProxy, setUseProxy] = useState(false);
  const [proxyKind, setProxyKind] = useState<ProxyKind>("socks5");
  const [proxyHost, setProxyHost] = useState("");
  const [proxyPort, setProxyPort] = useState(1080);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);

  async function connect(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setProbe(null);
    try {
      const result = await invoke<Probe>("connect", {
        args: {
          host,
          port,
          username,
          password,
          insecure,
          proxy: useProxy ? { kind: proxyKind, host: proxyHost, port: proxyPort } : null,
        },
      });
      setProbe(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full wx-grid">
      <header className="flex items-center gap-3 border-b border-line px-6 py-4">
        <span className="grid h-9 w-9 place-items-center rounded-md bg-accent/15 text-accent">
          <Terminal size={18} />
        </span>
        <div>
          <h1 className="font-mono text-lg font-semibold tracking-tight text-ink">
            wingox<span className="text-accent">_</span>
          </h1>
          <p className="text-xs text-ink-faint">manage MikroTik RouterOS — through a proxy or a jump</p>
        </div>
        <span className="ml-auto rounded border border-line px-2 py-0.5 font-mono text-[11px] text-ink-faint">
          alpha
        </span>
      </header>

      <main className="mx-auto grid max-w-5xl gap-6 px-6 py-8 lg:grid-cols-[380px_1fr]">
        {/* connection form */}
        <form
          onSubmit={connect}
          className="h-fit rounded-xl border border-line bg-panel p-5 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]"
        >
          <h2 className="mb-4 flex items-center gap-2 font-mono text-sm font-semibold text-ink-dim">
            <Server size={15} className="text-accent" /> New connection
          </h2>

          <Field label="Host">
            <input className={input} value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.88.1" required />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Port">
              <input className={input} type="number" value={port} onChange={(e) => setPort(+e.target.value)} />
            </Field>
            <Field label="User">
              <input className={input} value={username} onChange={(e) => setUsername(e.target.value)} />
            </Field>
          </div>
          <Field label="Password">
            <input className={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>

          <label className="mb-3 flex cursor-pointer items-center gap-2 text-sm text-ink-dim">
            <input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} className="accent-amber" />
            <ShieldAlert size={14} className="text-amber" /> Allow self-signed certificate
          </label>

          <label className="mb-3 flex cursor-pointer items-center gap-2 text-sm text-ink-dim">
            <input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} className="accent-accent" />
            <Network size={14} className="text-accent" /> Reach it through a proxy
          </label>

          {useProxy && (
            <div className="mb-3 rounded-lg border border-line-strong bg-panel-2 p-3">
              <div className="grid grid-cols-[88px_1fr_80px] gap-2">
                <select className={input} value={proxyKind} onChange={(e) => setProxyKind(e.target.value as ProxyKind)}>
                  <option value="socks5">SOCKS5</option>
                  <option value="http">HTTP</option>
                </select>
                <input className={input} value={proxyHost} onChange={(e) => setProxyHost(e.target.value)} placeholder="proxy host" />
                <input className={input} type="number" value={proxyPort} onChange={(e) => setProxyPort(+e.target.value)} />
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-1 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 font-mono text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-60"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Terminal size={16} />}
            {busy ? "Connecting…" : "Connect"}
          </button>
        </form>

        {/* result */}
        <section className="min-w-0">
          {!probe && !error && (
            <div className="grid h-full min-h-[280px] place-items-center rounded-xl border border-dashed border-line text-center">
              <div className="text-ink-faint">
                <Terminal size={28} className="mx-auto mb-3 opacity-50" />
                <p className="font-mono text-sm">Connect to a router to see it here.</p>
                <p className="mt-1 text-xs">Its traffic goes directly, or through the proxy you set.</p>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-danger/40 bg-danger/10 p-4 font-mono text-sm text-danger">
              {error}
            </div>
          )}

          {probe && (
            <div className="space-y-4">
              <div className="rounded-xl border border-line bg-panel p-5">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-accent shadow-[0_0_10px] shadow-accent" />
                  <h2 className="font-mono text-lg font-semibold text-ink">{probe.identity}</h2>
                </div>
                <p className="mt-1 font-mono text-sm text-ink-dim">
                  RouterOS {probe.version} · {probe.board} ({probe.architecture})
                </p>
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Stat icon={<Cpu size={14} />} label="CPU" value={`${probe.cpuLoad}%`} />
                  <Stat icon={<Clock size={14} />} label="Uptime" value={probe.uptime} />
                  <Stat icon={<Boxes size={14} />} label="Interfaces" value={String(probe.interfaces.length)} />
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border border-line bg-panel">
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
      </main>
    </div>
  );
}

const input =
  "w-full rounded-md border border-line-strong bg-panel-2 px-3 py-2 font-mono text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent";

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
