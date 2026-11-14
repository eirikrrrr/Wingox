// The device's own menu tree (see menu.ts), read once per router and RouterOS
// version and cached: walking the tree is ~450 requests (2–3 s direct, longer
// through a slow proxy). Until it is read — or if it cannot be (RouterOS 6, a
// user without the rights) — the curated menu is shown.
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { connArgs, type Profile } from "./App";
import { STATIC_MENU, buildMenu, type MenuModel, type MenuNode } from "./menu";

export interface MenuStatus {
  state: "static" | "loading" | "ready" | "error";
  error?: string;
  /** when the tree was read (ms) */
  at?: number;
}

interface Cached {
  version: string;
  at: number;
  nodes: MenuNode[];
}

const cacheKey = (p: Profile) => `wingox.menus.${p.scheme ?? "https"}://${p.host}:${p.port}`;

function readCache(p: Profile): Cached | null {
  try {
    const raw = localStorage.getItem(cacheKey(p));
    const c = raw ? (JSON.parse(raw) as Cached) : null;
    return c && Array.isArray(c.nodes) ? c : null;
  } catch {
    return null;
  }
}

function writeCache(p: Profile, c: Cached) {
  try { localStorage.setItem(cacheKey(p), JSON.stringify(c)); } catch { /* full or blocked: read again next time */ }
}

/** one walk per router at a time, shared by every tab/pane that asks */
const inFlight = new Map<string, Promise<MenuNode[]>>();

function readTree(p: Profile): Promise<MenuNode[]> {
  const k = cacheKey(p);
  let job = inFlight.get(k);
  if (!job) {
    job = invoke<MenuNode[]>("menu_tree", { args: connArgs(p) }).finally(() => inFlight.delete(k));
    inFlight.set(k, job);
  }
  return job;
}

/** the menu for a device; `version` = its RouterOS version once connected */
export function useRouterMenu(profile: Profile, version: string | undefined) {
  const [nodes, setNodes] = useState<MenuNode[] | null>(null);
  const [status, setStatus] = useState<MenuStatus>({ state: "static" });

  const load = useCallback(async (force: boolean) => {
    if (!version) return;
    const cached = readCache(profile);
    if (!force && cached?.version === version) {
      setNodes(cached.nodes);
      setStatus({ state: "ready", at: cached.at });
      return;
    }
    setStatus((st) => ({ ...st, state: "loading", error: undefined }));
    try {
      const tree = await readTree(profile);
      const at = Date.now();
      writeCache(profile, { version, at, nodes: tree });
      setNodes(tree);
      setStatus({ state: "ready", at });
    } catch (e) {
      // keep what is shown (the curated menu, or an older tree)
      setStatus((st) => ({ ...st, state: "error", error: String(e) }));
    }
    // the connection details are what matter, not the profile object's identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, profile.host, profile.port, profile.scheme, profile.username, profile.password]);

  useEffect(() => { void load(false); }, [load]);

  const model: MenuModel = useMemo(() => (nodes ? buildMenu(nodes) : STATIC_MENU), [nodes]);
  return { model, status, refresh: () => void load(true) };
}
