// The device menu, laid out like WinBox's left sidebar — and built from the
// router itself. On connect the app reads the router's own menu tree
// (`/console/inspect`, see core/src/routeros/inspect.rs), so a device shows
// exactly the menus it has, for its RouterOS version and installed packages.
// Over that tree sits our layer:
//
//  - SPECS: the WinBox layout — which menu paths each sidebar entry owns
//    ("Interfaces" owns `interface/*` except what Bridge, WiFi, PPP… claim).
//  - CURATED: names, column order and stable ids (kept in saved layouts and
//    used for the docs links) for the sections we know well.
//  - tabs: a section shows its sibling menus as tabs, like a WinBox window
//    (Interfaces → Ethernet | VLAN | EoIP…; IP ▸ Firewall → Filter | NAT…).
//
// Menus no SPEC claims (e.g. an extra package: Container, User Manager…) get a
// sidebar entry of their own. When the tree cannot be read (RouterOS 6, a user
// without the rights, or still loading), the curated sections alone are used.
import { createContext, useContext } from "react";
import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard, EthernetPort, Wifi, Network, Cable, Waypoints, Globe, Earth, Tags, Route, RadioTower,
  Settings, ListOrdered, Folder, ScrollText, ShieldCheck, Wrench, SquareTerminal, HardDrive, Boxes,
} from "lucide-react";

export interface Section {
  /** stable id, stored in pane layouts: a curated id, `p:<path>` otherwise */
  id: string;
  label: string;
  /** REST menu path; absent for built-in views */
  path?: string;
  /** columns to show first, in this order (the rest follow as they appear) */
  columns?: string[];
}

/** a sidebar entry: a leaf opens one section, a group unfolds into entries */
export interface MenuItem {
  id: string;
  label: string;
  Icon: LucideIcon;
  section?: Section;
  children?: MenuEntry[];
}

/** an entry of a group; `under` = the menu it stands for (it may only hold sub-menus) */
export interface MenuEntry extends Section {
  under?: string;
}

/** one menu of the router's tree (from the `menu_tree` command) */
export interface MenuNode {
  path: string;
  cmds: string[];
}

export interface Tab {
  /** the section the tab opens */
  id: string;
  label: string;
  active: boolean;
}

// ── our layer ────────────────────────────────────────────────────────────────

const s = (id: string, label: string, path?: string, columns?: string[]): Section => ({ id, label, path, columns });

/** sections we know well: stable ids (saved layouts, docs links), names, columns */
const CURATED: Section[] = [
  s("overview", "Dashboard"),
  s("interfaces", "Interfaces", "interface", ["name", "type", "actual-mtu", "l2mtu", "mac-address", "last-link-up-time"]),
  s("wifi", "WiFi", "interface/wifi", ["name", "mac-address", "configuration"]),
  s("bridge", "Bridges", "interface/bridge", ["name", "mac-address", "vlan-filtering", "protocol-mode"]),
  s("bridge-port", "Ports", "interface/bridge/port", ["interface", "bridge", "pvid", "role"]),
  s("bridge-vlan", "VLANs", "interface/bridge/vlan", ["bridge", "vlan-ids", "tagged", "untagged"]),
  s("bridge-host", "Hosts", "interface/bridge/host", ["mac-address", "on-interface", "bridge"]),
  s("ppp-secret", "Secrets", "ppp/secret", ["name", "service", "profile", "remote-address"]),
  s("ppp-profile", "Profiles", "ppp/profile", ["name", "local-address", "remote-address"]),
  s("ppp-active", "Active Connections", "ppp/active", ["name", "service", "address", "uptime"]),
  s("switch", "Switch", "interface/ethernet/switch"),
  s("ip-address", "Addresses", "ip/address", ["address", "network", "interface"]),
  s("ip-route", "Routes", "ip/route", ["dst-address", "gateway", "distance", "routing-table"]),
  s("ip-arp", "ARP", "ip/arp", ["address", "mac-address", "interface"]),
  s("ip-dhcp-client", "DHCP Client", "ip/dhcp-client", ["interface", "status", "address"]),
  s("ip-dhcp-server", "DHCP Server", "ip/dhcp-server", ["name", "interface", "address-pool", "lease-time"]),
  s("ip-dhcp-lease", "Leases", "ip/dhcp-server/lease", ["address", "mac-address", "host-name", "status"]),
  s("ip-dns", "DNS", "ip/dns"),
  s("ip-dns-static", "Static", "ip/dns/static", ["name", "address", "type", "ttl"]),
  s("ip-fw-filter", "Filter Rules", "ip/firewall/filter", ["chain", "action", "protocol", "src-address", "dst-address", "dst-port", "in-interface", "bytes", "packets"]),
  s("ip-fw-nat", "NAT", "ip/firewall/nat", ["chain", "action", "protocol", "src-address", "dst-address", "dst-port", "to-addresses", "to-ports", "out-interface"]),
  s("ip-fw-mangle", "Mangle", "ip/firewall/mangle", ["chain", "action", "new-routing-mark", "new-packet-mark"]),
  s("ip-fw-addrlist", "Address Lists", "ip/firewall/address-list", ["list", "address", "timeout"]),
  s("ip-fw-conn", "Connections", "ip/firewall/connection", ["protocol", "src-address", "dst-address", "tcp-state", "timeout"]),
  s("ip-neighbor", "Neighbors", "ip/neighbor", ["interface", "address", "mac-address", "identity", "platform", "version"]),
  s("ip-pool", "Pool", "ip/pool", ["name", "ranges", "next-pool"]),
  s("ip-service", "Services", "ip/service", ["name", "port", "address", "vrf", "certificate"]),
  s("ip-vrf", "VRF", "ip/vrf", ["name", "interfaces"]),
  s("ip-settings", "Settings", "ip/settings"),
  s("ipv6-address", "Addresses", "ipv6/address", ["address", "interface", "advertise"]),
  s("ipv6-route", "Routes", "ipv6/route", ["dst-address", "gateway", "distance"]),
  s("ipv6-fw-filter", "Filter Rules", "ipv6/firewall/filter", ["chain", "action", "protocol", "src-address", "dst-address"]),
  s("ipv6-neighbor", "Neighbors", "ipv6/neighbor", ["address", "mac-address", "interface", "status"]),
  s("ipv6-nd", "ND", "ipv6/nd", ["interface", "ra-interval"]),
  s("mpls-ldp", "LDP", "mpls/ldp"),
  s("mpls-interface", "Interfaces", "mpls/interface", ["interface", "mpls-mtu"]),
  s("routing-table", "Tables", "routing/table", ["name", "fib"]),
  s("bgp-connection", "Connections", "routing/bgp/connection", ["name", "remote.address", "remote.as", "local.role"]),
  s("bgp-session", "Sessions", "routing/bgp/session", ["name", "remote.address", "remote.as", "established"]),
  s("ospf-instance", "Instances", "routing/ospf/instance", ["name", "version", "router-id"]),
  s("ospf-neighbor", "Neighbors", "routing/ospf/neighbor", ["address", "router-id", "state", "interface"]),
  s("routing-filter", "Rules", "routing/filter/rule", ["chain", "rule"]),
  s("sys-identity", "Identity", "system/identity"),
  s("sys-resource", "Resources", "system/resource"),
  s("sys-clock", "Clock", "system/clock"),
  s("sys-users", "Users", "user", ["name", "group", "address", "last-logged-in"]),
  s("sys-packages", "Packages", "system/package", ["name", "version", "build-time", "size"]),
  s("sys-routerboard", "RouterBOARD", "system/routerboard"),
  s("sys-health", "Health", "system/health", ["name", "value", "type"]),
  s("sys-license", "License", "system/license"),
  s("sys-ntp", "NTP Client", "system/ntp/client"),
  s("sys-scheduler", "Scheduler", "system/scheduler", ["name", "start-date", "start-time", "interval", "on-event"]),
  s("sys-scripts", "Scripts", "system/script", ["name", "owner", "last-started", "run-count"]),
  s("sys-logging", "Logging", "system/logging", ["topics", "action", "prefix"]),
  s("queue-simple", "Simple Queues", "queue/simple", ["name", "target", "max-limit", "rate"]),
  s("queue-tree", "Queue Tree", "queue/tree", ["name", "parent", "packet-mark", "max-limit"]),
  s("queue-type", "Queue Types", "queue/type", ["name", "kind"]),
  s("files", "Files", "file", ["name", "type", "size", "last-modified"]),
  s("log", "Log", "log", ["time", "topics", "message"]),
  s("radius", "RADIUS", "radius", ["service", "address", "secret", "timeout"]),
  s("tool-netwatch", "Netwatch", "tool/netwatch", ["host", "type", "interval", "status"]),
  s("tool-graphing", "Graphing", "tool/graphing"),
  s("tool-romon", "RoMON", "tool/romon"),
  s("tool-bw-server", "Bandwidth Server", "tool/bandwidth-server"),
  s("tool-email", "Email", "tool/e-mail"),
  s("terminal", "Terminal"),
];

/** names for menus we do not curate otherwise (the rest are spelled from the path) */
const LABELS: Record<string, string> = {
  "certificate": "Certificates", "port": "Ports", "disk": "Disks", "snmp": "SNMP", "snmp/community": "Communities",
  "special-login": "Special Login", "console": "Console", "interface/list": "Interface List",
  "interface/list/member": "Members", "interface/wifi/registration-table": "Registration",
  "ip/dhcp-server/network": "Networks", "ip/hotspot": "Hotspot", "ip/ipsec": "IPsec",
  "system/ntp/server": "NTP Server", "user/group": "Groups", "user/active": "Active Users",
};

/** words spelled specially when a label is made from a path */
const WORDS: Record<string, string> = {
  ip: "IP", ipv6: "IPv6", dhcp: "DHCP", dns: "DNS", nat: "NAT", arp: "ARP", vrf: "VRF", vlan: "VLAN", vlans: "VLANs",
  eoip: "EoIP", eoipv6: "EoIPv6", gre: "GRE", gre6: "GRE6", ipip: "IPIP", ipipv6: "IPIPv6", "6to4": "6to4",
  vrrp: "VRRP", vxlan: "VXLAN", vpls: "VPLS", vteps: "VTEPs", fdb: "FDB", lte: "LTE", apn: "APN", esim: "eSIM",
  ppp: "PPP", pppoe: "PPPoE", l2tp: "L2TP", sstp: "SSTP", ovpn: "OVPN", pptp: "PPTP", macsec: "MACsec",
  macvlan: "MACVLAN", wireguard: "WireGuard", wifi: "WiFi", aaa: "AAA", capsman: "CAPsMAN", "caps-man": "CAPsMAN",
  mpls: "MPLS", ldp: "LDP", bgp: "BGP", ospf: "OSPF", rip: "RIP", isis: "IS-IS", pimsm: "PIM-SM", igmp: "IGMP",
  gmp: "GMP", bfd: "BFD", rpki: "RPKI", evpn: "EVPN", vpn: "VPN", lsa: "LSA", lsp: "LSP", bsr: "BSR", rp: "RP",
  uib: "UIB", mfc: "MFC", mdb: "MDB", msti: "MSTI", mst: "MST", mvrp: "MVRP", calea: "CALEA", ipsec: "IPsec",
  psk: "PSK", rsa: "RSA", qkd: "QKD", sa: "SA", ntp: "NTP", smb: "SMB", tftp: "TFTP", upnp: "UPnP", pmp: "PMP",
  ipfix: "IPFIX", socks: "SOCKS", ssh: "SSH", mac: "MAC", romon: "RoMON", sms: "SMS", irq: "IRQ", rps: "RPS",
  cpu: "CPU", usb: "USB", wps: "WPS", leds: "LEDs", scep: "SCEP", crl: "CRL", otp: "OTP", ra: "RA", nd: "ND",
  iot: "IoT", zerotier: "ZeroTier", snmp: "SNMP", radius: "RADIUS", dot1x: "Dot1X", pcap: "PCAP", id: "ID",
  layer7: "Layer7", cap: "CAP", e: "E", "e-mail": "Email",
};

const word = (w: string) => WORDS[w] ?? w.charAt(0).toUpperCase() + w.slice(1);
/** "dhcp-server" → "DHCP Server" */
export function titleize(segment: string): string {
  return WORDS[segment] ?? segment.split("-").map(word).join(" ");
}
const lastSeg = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
export const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** the WinBox layout: which menus each sidebar entry owns */
interface Spec {
  id: string;
  label: string;
  Icon: LucideIcon;
  /** a built-in view (no menus) */
  view?: string;
  /** menus it owns, with everything under them (unless a deeper root claims it) */
  roots?: string[];
  /** one entry that opens its root, the rest reached through tabs (a WinBox window) */
  leaf?: boolean;
}

const PPP_INTERFACES = ["pppoe-client", "pppoe-server", "l2tp-client", "l2tp-server", "l2tp-ether", "sstp-client",
  "sstp-server", "ovpn-client", "ovpn-server", "pptp-client", "pptp-server", "ppp-client", "ppp-server"];

const SPECS: Spec[] = [
  { id: "overview", label: "Dashboard", Icon: LayoutDashboard, view: "overview" },
  { id: "interfaces", label: "Interfaces", Icon: EthernetPort, roots: ["interface"], leaf: true },
  { id: "wireless", label: "Wireless", Icon: RadioTower, roots: ["interface/wireless"], leaf: true },
  { id: "wifi", label: "WiFi", Icon: Wifi, roots: ["interface/wifi"], leaf: true },
  { id: "capsman", label: "CAPsMAN", Icon: RadioTower, roots: ["caps-man"], leaf: true },
  { id: "bridge", label: "Bridge", Icon: Network, roots: ["interface/bridge"], leaf: true },
  { id: "ppp", label: "PPP", Icon: Cable, roots: ["ppp", ...PPP_INTERFACES.map((t) => `interface/${t}`)] },
  { id: "switch", label: "Switch", Icon: Waypoints, roots: ["interface/ethernet/switch"], leaf: true },
  { id: "ip", label: "IP", Icon: Globe, roots: ["ip", "snmp"] },
  { id: "ipv6", label: "IPv6", Icon: Earth, roots: ["ipv6"] },
  { id: "mpls", label: "MPLS", Icon: Tags, roots: ["mpls"] },
  { id: "routing", label: "Routing", Icon: Route, roots: ["routing"] },
  { id: "system", label: "System", Icon: Settings, roots: ["system", "user", "certificate", "port", "console", "special-login"] },
  { id: "queues", label: "Queues", Icon: ListOrdered, roots: ["queue"] },
  { id: "files", label: "Files", Icon: Folder, roots: ["file"], leaf: true },
  { id: "disks", label: "Disks", Icon: HardDrive, roots: ["disk"], leaf: true },
  { id: "log", label: "Log", Icon: ScrollText, roots: ["log"], leaf: true },
  { id: "radius", label: "RADIUS", Icon: ShieldCheck, roots: ["radius"], leaf: true },
  { id: "tools", label: "Tools", Icon: Wrench, roots: ["tool"] },
  // (menus of extra packages and anything unclaimed are inserted here)
  { id: "terminal", label: "New Terminal", Icon: SquareTerminal, view: "terminal" },
];

/** console-only menus with nothing to show in a table */
const SKIP = ["environment", "safe-mode", "task"];

const CURATED_BY_ID = new Map(CURATED.map((c) => [c.id, c]));
const CURATED_BY_PATH = new Map(CURATED.filter((c) => c.path).map((c) => [c.path!, c]));
const ORDER = new Map(CURATED.filter((c) => c.path).map((c, i) => [c.path!, i]));

/** the spec owning a path: the deepest root it falls under (an unclaimed top-level menu gets its own) */
function ownerOf(path: string): Spec {
  let best: Spec | null = null;
  let depth = -1;
  for (const spec of SPECS) {
    for (const r of spec.roots ?? []) {
      if (under(path, r) && r.length > depth) { best = spec; depth = r.length; }
    }
  }
  if (best) return best;
  const top = path.split("/")[0];
  return { id: `auto:${top}`, label: titleize(top), Icon: Boxes, roots: [top] };
}

/** the section for a menu path */
function sectionForPath(path: string): Section {
  const curated = CURATED_BY_PATH.get(path);
  if (curated) return curated;
  const spec = ownerOf(path);
  const root = (spec.roots ?? []).filter((r) => under(path, r)).sort((a, b) => b.length - a.length)[0] ?? "";
  // named relative to its sidebar entry: interface/vlan → "VLAN", ip/firewall/raw → "Firewall Raw"
  const rel = path === root ? lastSeg(path) : path.slice(root.length + 1);
  const label = LABELS[path] ?? (path === root && spec.leaf ? spec.label : rel.split("/").map(titleize).join(" "));
  return { id: `p:${path}`, label, path };
}

/** a tab's short name: the curated one, or the menu's own name */
const tabLabel = (path: string) => CURATED_BY_PATH.get(path)?.label ?? LABELS[path] ?? titleize(lastSeg(path));

const byOrder = (a: string, b: string) =>
  (ORDER.get(a) ?? 1e4) - (ORDER.get(b) ?? 1e4) || a.localeCompare(b);

/** the section for a pane's view id (an unknown id falls back to the dashboard) */
export function sectionOf(id: string): { section: Section; Icon: LucideIcon; group?: string } {
  const curated = CURATED_BY_ID.get(id);
  const section = curated ?? (id.startsWith("p:") ? sectionForPath(id.slice(2)) : null);
  if (!section) return sectionOf("overview");
  if (!section.path) {
    const spec = SPECS.find((sp) => sp.view === section.id)!;
    return { section, Icon: spec.Icon };
  }
  const spec = ownerOf(section.path);
  // a window's own root needs no prefix ("Interfaces"); inside it, "Interfaces ▸ VLAN"
  const isRoot = spec.leaf && spec.roots?.[0] === section.path;
  return { section, Icon: spec.Icon, group: isRoot ? undefined : spec.label };
}

// ── the model: sidebar + tabs, from a tree (or from the curated sections) ────

export interface MenuModel {
  items: MenuItem[];
  /** rows of tabs for a section (a WinBox window's tabs); empty when it has no siblings */
  tabsOf: (sectionId: string) => Tab[][];
  /** the sidebar entry (MenuItem id) a section belongs to */
  itemOf: (sectionId: string) => string | undefined;
  /** every section of the device, for the sidebar search */
  sections: { section: Section; item: string }[];
  /** the commands of a menu (print, add, set, remove…), when the tree was read */
  cmdsOf: (path: string) => string[] | undefined;
  /** built from the router's own tree (vs. the curated fallback) */
  fromRouter: boolean;
}

export function buildMenu(tree: MenuNode[] | null): MenuModel {
  const cmds = new Map<string, string[]>();
  const printable = new Set<string>();
  if (tree) {
    for (const n of tree) {
      cmds.set(n.path, n.cmds);
      if (n.cmds.includes("print") && !SKIP.some((k) => under(n.path, k))) printable.add(n.path);
    }
  } else {
    for (const c of CURATED) if (c.path) printable.add(c.path);
  }

  // which spec owns each printable menu; specs for unclaimed top-level menus on the way
  const owned = new Map<string, string[]>();
  const autoSpecs = new Map<string, Spec>();
  const specOf = new Map<string, Spec>();
  for (const p of printable) {
    const spec = ownerOf(p);
    if (spec.id.startsWith("auto:") && !autoSpecs.has(spec.id)) {
      autoSpecs.set(spec.id, { ...spec, leaf: printable.has(spec.roots![0]) });
    }
    const sp = autoSpecs.get(spec.id) ?? spec;
    specOf.set(p, sp);
    owned.set(sp.id, [...(owned.get(sp.id) ?? []), p]);
  }

  /** the menus directly under `dir` within a spec: real sections, or a sub-menu
      holding only deeper ones (e.g. ip/firewall), named after it */
  function heads(spec: Spec, dir: string): string[] {
    const out = new Set<string>();
    for (const p of owned.get(spec.id) ?? []) {
      if (p !== dir && p.startsWith(`${dir}/`)) out.add(`${dir}/${p.slice(dir.length + 1).split("/")[0]}`);
    }
    return [...out].sort((a, b) => byOrder(firstUnder(spec, a), firstUnder(spec, b)));
  }
  /** what a head opens: itself, or its first section (curated order) */
  function firstUnder(spec: Spec, head: string): string {
    if (printable.has(head)) return head;
    return (owned.get(spec.id) ?? []).filter((p) => p.startsWith(`${head}/`)).sort(byOrder)[0] ?? head;
  }
  const idFor = (path: string) => sectionForPath(path).id;

  const specs = [...SPECS.slice(0, -1), ...[...autoSpecs.values()].sort((a, b) => a.label.localeCompare(b.label)), SPECS[SPECS.length - 1]];
  const items: MenuItem[] = [];
  for (const spec of specs) {
    if (spec.view) {
      items.push({ id: spec.id, label: spec.label, Icon: spec.Icon, section: CURATED_BY_ID.get(spec.view)! });
      continue;
    }
    const mine = owned.get(spec.id);
    if (!mine?.length) continue; // this device does not have it
    const roots = spec.roots!;
    if (spec.leaf && roots.length === 1 && printable.has(roots[0])) {
      items.push({ id: spec.id, label: spec.label, Icon: spec.Icon, section: { ...sectionForPath(roots[0]), label: spec.label } });
      continue;
    }
    const entries: MenuEntry[] = [];
    for (const r of roots) {
      const list = printable.has(r) ? [r] : heads(spec, r);
      for (const h of list) {
        const target = firstUnder(spec, h);
        const label = printable.has(h)
          ? (CURATED_BY_PATH.get(h)?.label ?? LABELS[h] ?? sectionForPath(h).label)
          : (LABELS[h] ?? titleize(lastSeg(h)));
        entries.push({ ...sectionForPath(target), label, under: h });
      }
    }
    items.push({ id: spec.id, label: spec.label, Icon: spec.Icon, children: entries });
  }

  function row(spec: Spec, dir: string, current: string): Tab[] {
    const tabs: Tab[] = [];
    if (printable.has(dir)) tabs.push({ id: idFor(dir), label: tabLabel(dir), active: current === dir });
    for (const h of heads(spec, dir)) {
      tabs.push({ id: idFor(firstUnder(spec, h)), label: LABELS[h] ?? tabLabel(h), active: under(current, h) });
    }
    return tabs;
  }

  function tabsOf(sectionId: string): Tab[][] {
    const { section } = sectionOf(sectionId);
    const path = section.path;
    if (!path || !printable.has(path)) return [];
    const spec = specOf.get(path)!;
    const roots = spec.roots ?? [];
    const rows: Tab[][] = [];
    const parent = dirname(path);
    // the parent's window: a real menu of this spec, or a sub-menu that is not
    // one of the spec's top-level containers (ip/firewall yes, ip no)
    const parentOk = parent && (printable.has(parent)
      ? specOf.get(parent)?.id === spec.id
      : roots.some((r) => parent.startsWith(`${r}/`)));
    if (parentOk) rows.push(row(spec, parent, path));
    if (heads(spec, path).length) rows.push(row(spec, path, path));
    return rows.filter((r) => r.length > 1);
  }

  const sections = [...printable].sort(byOrder).map((p) => ({ section: sectionForPath(p), item: specOf.get(p)!.label }));
  function itemOf(sectionId: string): string | undefined {
    const { section } = sectionOf(sectionId);
    if (!section.path) return SPECS.find((sp) => sp.view === section.id)?.id;
    return specOf.get(section.path)?.id;
  }

  return { items, tabsOf, itemOf, sections, cmdsOf: (p) => cmds.get(p), fromRouter: !!tree };
}

/** the curated menu, before (or without) the router's tree */
export const STATIC_MENU = buildMenu(null);

export const MenuContext = createContext<MenuModel>(STATIC_MENU);
export const useMenu = () => useContext(MenuContext);
