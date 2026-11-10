// Reachability monitor: a constant "ping" to the profiles that ask for it, with
// a notification when one stops answering (and when it comes back).
//
// ICMP cannot cross a SOCKS5/HTTP proxy — only TCP does — so the ping is an
// unauthenticated request to the router's web service along the profile's own
// route (proxy included): any answer from the router counts as up. No
// credentials are sent. It runs in the main window only.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface ReachState {
  status: "up" | "down" | "pending";
  /** last round trip, ms */
  ms?: number;
  /** last error while down */
  error?: string;
  /** consecutive failures */
  fails: number;
  /** when the status last changed */
  since: number;
  lastCheck?: number;
}

export interface MonitorEvent {
  id: string;
  name: string;
  kind: "down" | "up";
  detail: string;
  at: number;
}

/** failures in a row before a device counts as down (one lost probe is not an outage) */
export const DOWN_AFTER = 2;
export const INTERVALS = [10, 30, 60, 300] as const;

interface Watched {
  id: string;
  name: string;
  args: unknown;
}

export function useMonitor(watched: Watched[], intervalSec: number, onEvent: (e: MonitorEvent) => void) {
  const [states, setStates] = useState<Record<string, ReachState>>({});
  const inflight = useRef(new Set<string>());
  const latest = useRef({ watched, onEvent });
  latest.current = { watched, onEvent };
  const stateRef = useRef(states);
  stateRef.current = states;

  // forget devices that are no longer watched
  const ids = watched.map((w) => w.id).join(",");
  useEffect(() => {
    setStates((all) => Object.fromEntries(Object.entries(all).filter(([id]) => watched.some((w) => w.id === id))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  useEffect(() => {
    if (!ids) return;
    let stopped = false;

    async function probe(w: Watched) {
      if (inflight.current.has(w.id)) return;
      inflight.current.add(w.id);
      let ok = false, ms: number | undefined, error: string | undefined;
      try {
        ms = await invoke<number>("reach_device", { args: w.args });
        ok = true;
      } catch (e) {
        error = String(e);
      } finally {
        inflight.current.delete(w.id);
      }
      if (stopped) return;
      const prev = stateRef.current[w.id];
      const now = Date.now();
      let next: ReachState;
      if (ok) {
        next = { status: "up", ms, fails: 0, since: prev?.status === "up" ? prev.since : now, lastCheck: now };
        if (prev?.status === "down") latest.current.onEvent({ id: w.id, name: w.name, kind: "up", detail: `answers again (${ms} ms)`, at: now });
      } else {
        const fails = (prev?.fails ?? 0) + 1;
        const down = fails >= DOWN_AFTER;
        next = {
          status: down ? "down" : prev?.status ?? "pending",
          ms: prev?.ms, error, fails,
          since: down && prev?.status !== "down" ? now : prev?.since ?? now,
          lastCheck: now,
        };
        if (down && prev?.status !== "down") latest.current.onEvent({ id: w.id, name: w.name, kind: "down", detail: error ?? "no answer", at: now });
      }
      setStates((all) => ({ ...all, [w.id]: next }));
    }

    const round = () => latest.current.watched.forEach((w) => void probe(w));
    round();
    const timer = setInterval(round, intervalSec * 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [ids, intervalSec]);

  return states;
}

/** an OS notification, if the user allows them (silently skipped otherwise) */
export async function notify(title: string, body: string) {
  try {
    const n = await import("@tauri-apps/plugin-notification");
    let granted = await n.isPermissionGranted();
    if (!granted) granted = (await n.requestPermission()) === "granted";
    if (granted) n.sendNotification({ title, body });
  } catch {
    /* outside the desktop shell, or notifications unavailable */
  }
}

export const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
};
