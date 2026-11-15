// Changes that can cut Wingox off the router it is configuring. REST has no
// Safe Mode (each request applies at once, nothing rolls back), so before such
// a change the user is told why it is risky and has to confirm it.
//
// What Wingox knows about its own way in: the address and port it connects to
// (the profile), the SSH port, the RouterOS user, and — read from the router —
// which interfaces carry that address. Behind NAT (or a proxy that reaches
// the router by another address) the address is not on the router: then only
// the service, firewall and user checks apply.
import { createContext, useContext } from "react";

export interface Access {
  /** the address Wingox connects to */
  host: string;
  scheme: "https" | "http";
  /** REST port as configured on the client side (may differ behind NAT) */
  port: number;
  sshPort: number;
  username: string;
  /** router interfaces that carry `host` (from ip/address), when it is the router's own */
  interfaces: string[];
}

export const AccessContext = createContext<Access | null>(null);
export const useAccess = () => useContext(AccessContext);

export type Action = "set" | "add" | "remove" | "disable" | "enable" | "move";
type Row = Record<string, unknown>;

const str = (v: unknown) => (v == null ? "" : String(v));
const ipOf = (address: unknown) => str(address).split("/")[0];
const services = (a: Access) => [a.scheme === "https" ? "www-ssl" : "www", "ssh", "api", "api-ssl"];
const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/**
 * Why `action` on `row` in menu `path` (with `changes`, for set/add) may cut
 * Wingox's access, or null. Conservative: it warns, it never blocks.
 */
export function riskOf(path: string, row: Row | undefined, action: Action, changes: Row | null, a: Access | null): string | null {
  if (!a) return null;
  const r = row ?? {};
  const touches = (...keys: string[]) => action !== "set" || keys.some((k) => changes && k in changes);
  const stopping = action === "disable" || action === "remove" || (action === "set" && changes?.disabled === "yes")
    || (action === "set" && changes?.disabled === "true");

  // the interface Wingox comes in through (or a bridge / port holding it)
  if (under(path, "interface") && a.interfaces.length) {
    // the item itself; for a bridge port, also the port and its bridge (a VLAN's
    // parent is not touched by changing the VLAN, unless the VLAN is the way in)
    const port = path === "interface/bridge/port";
    const names = [str(r.name), str(changes?.name), ...(port ? [str(r.interface), str(r.bridge), str(changes?.bridge)] : [])].filter(Boolean);
    const hit = names.find((n) => a.interfaces.includes(n));
    if (hit && (stopping || touches("name", "mtu", "bridge", "interface", "vlan-id", "disabled", "pvid", "frame-types"))) {
      return `Wingox reaches this router through interface "${hit}" (${a.host}). Changing it can cut the connection — and REST has no Safe Mode to undo it.`;
    }
  }
  // the address Wingox connects to
  if (path === "ip/address" && ipOf(r.address) === a.host && (stopping || touches("address", "interface", "network"))) {
    return `${a.host} is the address Wingox connects to. Changing or removing it cuts the connection.`;
  }
  // the service Wingox (or its terminal) uses
  if (path === "ip/service" && services(a).includes(str(r.name)) && (stopping || touches("port", "address", "vrf", "certificate", "disabled", "tls-version"))) {
    const svc = str(r.name);
    const why = svc === "ssh" ? "the device terminal (SSH)" : svc.startsWith("api") ? "other API clients" : "Wingox itself (REST)";
    return `"${svc}" carries ${why}. A wrong port, address list or certificate here can lock Wingox out.`;
  }
  // input firewall: a drop/reject (or an order change) can block the management traffic
  if (/^ipv?6?\/firewall\/(filter|raw)$/.test(path)) {
    const chain = str(changes?.chain ?? r.chain);
    const act = str(changes?.action ?? r.action);
    if (chain === "input" || (path.endsWith("raw") && chain === "prerouting")) {
      if (action === "move" || action === "enable" || ["drop", "reject", "tarpit", ""].includes(act) || touches("chain", "action", "src-address", "src-address-list", "dst-port", "in-interface", "protocol")) {
        return `An ${chain} rule decides whether the router answers Wingox (${a.host}:${a.port}). Check it does not drop that traffic — REST has no Safe Mode to undo it.`;
      }
    }
  }
  // the RouterOS user Wingox logs in as
  if (path === "user" && str(r.name) === a.username && (stopping || touches("password", "group", "address", "name"))) {
    return `"${a.username}" is the user Wingox logs in with. Changing its password, group or allowed addresses here ends the session.`;
  }
  return null;
}
