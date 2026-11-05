// The device menu, laid out like WinBox's left sidebar. Each entry is a section
// a pane can show: a few are built-in views (dashboard, terminal); the rest are
// RouterOS menus read over REST and rendered as a generic list / property sheet.
import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard, EthernetPort, Wifi, Network, Cable, Waypoints, Globe, Earth, Tags, Route,
  Settings, ListOrdered, Folder, ScrollText, ShieldCheck, Wrench, SquareTerminal,
} from "lucide-react";

export interface Section {
  /** stable id, stored in pane layouts */
  id: string;
  label: string;
  /** REST menu path; absent for built-in views */
  path?: string;
  /** columns to show first, in this order (the rest follow as they appear) */
  columns?: string[];
}

export interface MenuItem {
  id: string;
  label: string;
  Icon: LucideIcon;
  /** a leaf opens one section… */
  section?: Section;
  /** …a group unfolds into sub-sections (WinBox's "IP ▸") */
  children?: Section[];
}

const s = (id: string, label: string, path?: string, columns?: string[]): Section => ({ id, label, path, columns });

export const MENU: MenuItem[] = [
  { id: "overview", label: "Dashboard", Icon: LayoutDashboard, section: s("overview", "Dashboard") },
  {
    id: "interfaces", label: "Interfaces", Icon: EthernetPort,
    section: s("interfaces", "Interfaces", "interface", ["name", "type", "actual-mtu", "l2mtu", "mac-address", "last-link-up-time"]),
  },
  { id: "wifi", label: "WiFi", Icon: Wifi, section: s("wifi", "WiFi", "interface/wifi", ["name", "mac-address", "configuration"]) },
  {
    id: "bridge", label: "Bridge", Icon: Network, children: [
      s("bridge", "Bridges", "interface/bridge", ["name", "mac-address", "vlan-filtering", "protocol-mode"]),
      s("bridge-port", "Ports", "interface/bridge/port", ["interface", "bridge", "pvid", "role"]),
      s("bridge-vlan", "VLANs", "interface/bridge/vlan", ["bridge", "vlan-ids", "tagged", "untagged"]),
      s("bridge-host", "Hosts", "interface/bridge/host", ["mac-address", "on-interface", "bridge"]),
    ],
  },
  {
    id: "ppp", label: "PPP", Icon: Cable, children: [
      s("ppp-secret", "Secrets", "ppp/secret", ["name", "service", "profile", "remote-address"]),
      s("ppp-profile", "Profiles", "ppp/profile", ["name", "local-address", "remote-address"]),
      s("ppp-active", "Active Connections", "ppp/active", ["name", "service", "address", "uptime"]),
    ],
  },
  { id: "switch", label: "Switch", Icon: Waypoints, section: s("switch", "Switch", "interface/ethernet/switch") },
  {
    id: "ip", label: "IP", Icon: Globe, children: [
      s("ip-address", "Addresses", "ip/address", ["address", "network", "interface"]),
      s("ip-route", "Routes", "ip/route", ["dst-address", "gateway", "distance", "routing-table"]),
      s("ip-arp", "ARP", "ip/arp", ["address", "mac-address", "interface"]),
      s("ip-dhcp-client", "DHCP Client", "ip/dhcp-client", ["interface", "status", "address"]),
      s("ip-dhcp-server", "DHCP Server", "ip/dhcp-server", ["name", "interface", "address-pool", "lease-time"]),
      s("ip-dhcp-lease", "DHCP Leases", "ip/dhcp-server/lease", ["address", "mac-address", "host-name", "status"]),
      s("ip-dns", "DNS", "ip/dns"),
      s("ip-dns-static", "DNS Static", "ip/dns/static", ["name", "address", "type", "ttl"]),
      s("ip-fw-filter", "Firewall Filter", "ip/firewall/filter", ["chain", "action", "protocol", "src-address", "dst-address", "dst-port", "in-interface", "bytes", "packets"]),
      s("ip-fw-nat", "Firewall NAT", "ip/firewall/nat", ["chain", "action", "protocol", "src-address", "dst-address", "dst-port", "to-addresses", "to-ports", "out-interface"]),
      s("ip-fw-mangle", "Firewall Mangle", "ip/firewall/mangle", ["chain", "action", "new-routing-mark", "new-packet-mark"]),
      s("ip-fw-addrlist", "Address Lists", "ip/firewall/address-list", ["list", "address", "timeout"]),
      s("ip-fw-conn", "Connections", "ip/firewall/connection", ["protocol", "src-address", "dst-address", "tcp-state", "timeout"]),
      s("ip-neighbor", "Neighbors", "ip/neighbor", ["interface", "address", "mac-address", "identity", "platform", "version"]),
      s("ip-pool", "Pool", "ip/pool", ["name", "ranges", "next-pool"]),
      s("ip-service", "Services", "ip/service", ["name", "port", "address", "vrf", "certificate"]),
      s("ip-vrf", "VRF", "ip/vrf", ["name", "interfaces"]),
      s("ip-settings", "Settings", "ip/settings"),
    ],
  },
  {
    id: "ipv6", label: "IPv6", Icon: Earth, children: [
      s("ipv6-address", "Addresses", "ipv6/address", ["address", "interface", "advertise"]),
      s("ipv6-route", "Routes", "ipv6/route", ["dst-address", "gateway", "distance"]),
      s("ipv6-fw-filter", "Firewall Filter", "ipv6/firewall/filter", ["chain", "action", "protocol", "src-address", "dst-address"]),
      s("ipv6-neighbor", "Neighbors", "ipv6/neighbor", ["address", "mac-address", "interface", "status"]),
      s("ipv6-nd", "ND", "ipv6/nd", ["interface", "ra-interval"]),
    ],
  },
  {
    id: "mpls", label: "MPLS", Icon: Tags, children: [
      s("mpls-ldp", "LDP", "mpls/ldp"),
      s("mpls-interface", "Interfaces", "mpls/interface", ["interface", "mpls-mtu"]),
    ],
  },
  {
    id: "routing", label: "Routing", Icon: Route, children: [
      s("routing-table", "Tables", "routing/table", ["name", "fib"]),
      s("bgp-connection", "BGP Connections", "routing/bgp/connection", ["name", "remote.address", "remote.as", "local.role"]),
      s("bgp-session", "BGP Sessions", "routing/bgp/session", ["name", "remote.address", "remote.as", "established"]),
      s("ospf-instance", "OSPF Instances", "routing/ospf/instance", ["name", "version", "router-id"]),
      s("ospf-neighbor", "OSPF Neighbors", "routing/ospf/neighbor", ["address", "router-id", "state", "interface"]),
      s("routing-filter", "Filters", "routing/filter/rule", ["chain", "rule"]),
    ],
  },
  {
    id: "system", label: "System", Icon: Settings, children: [
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
    ],
  },
  {
    id: "queues", label: "Queues", Icon: ListOrdered, children: [
      s("queue-simple", "Simple Queues", "queue/simple", ["name", "target", "max-limit", "rate"]),
      s("queue-tree", "Queue Tree", "queue/tree", ["name", "parent", "packet-mark", "max-limit"]),
      s("queue-type", "Queue Types", "queue/type", ["name", "kind"]),
    ],
  },
  { id: "files", label: "Files", Icon: Folder, section: s("files", "Files", "file", ["name", "type", "size", "last-modified"]) },
  { id: "log", label: "Log", Icon: ScrollText, section: s("log", "Log", "log", ["time", "topics", "message"]) },
  { id: "radius", label: "RADIUS", Icon: ShieldCheck, section: s("radius", "RADIUS", "radius", ["service", "address", "secret", "timeout"]) },
  {
    id: "tools", label: "Tools", Icon: Wrench, children: [
      s("tool-netwatch", "Netwatch", "tool/netwatch", ["host", "type", "interval", "status"]),
      s("tool-graphing", "Graphing", "tool/graphing"),
      s("tool-romon", "RoMON", "tool/romon"),
      s("tool-bw-server", "Bandwidth Server", "tool/bandwidth-server"),
      s("tool-email", "Email", "tool/e-mail"),
    ],
  },
  { id: "terminal", label: "New Terminal", Icon: SquareTerminal, section: s("terminal", "Terminal") },
];

const ALL = new Map<string, { section: Section; Icon: LucideIcon; group?: string }>();
for (const item of MENU) {
  if (item.section) ALL.set(item.section.id, { section: item.section, Icon: item.Icon });
  for (const c of item.children ?? []) ALL.set(c.id, { section: c, Icon: item.Icon, group: item.label });
}

/** the section for a pane's view id (an unknown id falls back to the dashboard) */
export function sectionOf(id: string) {
  return ALL.get(id) ?? ALL.get("overview")!;
}
