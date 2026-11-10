#!/usr/bin/env python3
"""Regenerate src/docsLinks.ts: each Wingox menu section -> the exact page (and
heading) of MikroTik's official RouterOS documentation (help.mikrotik.com).

    python3 dev/docs-links.py          # resolve, verify, write src/docsLinks.ts

Each section is mapped to (page title, heading anchor) below. The script asks
the documentation's public Confluence API for each page's canonical link,
checks that the anchor really exists on that page and that the page answers
HTTP 200, and fails without writing anything if one does not. Run it again
when MikroTik reorganizes the documentation, and when a section is added to
src/menu.ts.
"""
import json, re, sys, time, urllib.parse, urllib.request
BASE = "https://help.mikrotik.com/docs"
MAP = {
  "overview": ("Getting started", None),
  "interfaces": ("Interface stats and monitor-traffic", None),
  "wifi": ("WiFi", None),
  "bridge": ("Bridging and Switching", "BridgingandSwitching-BridgeInterfaceSetup"),
  "bridge-port": ("Bridging and Switching", "BridgingandSwitching-PortSettings"),
  "bridge-vlan": ("Bridging and Switching", "BridgingandSwitching-BridgeVLANFiltering"),
  "bridge-host": ("Bridging and Switching", "BridgingandSwitching-HostsTable"),
  "ppp-secret": ("PPP AAA", "PPPAAA-UserDatabase"),
  "ppp-profile": ("PPP AAA", "PPPAAA-UserProfiles"),
  "ppp-active": ("PPP AAA", "PPPAAA-ActiveUsers"),
  "switch": ("Switch Chip Features", None),
  "ip-address": ("IP Addressing", "IPAddressing-IPv4Addressing"),
  "ip-route": ("IP Routing", None),
  "ip-arp": ("ARP", None),
  "ip-dhcp-client": ("DHCP", "DHCP-DHCPClient"),
  "ip-dhcp-server": ("DHCP", "DHCP-DHCPServer"),
  "ip-dhcp-lease": ("DHCP", "DHCP-Leases"),
  "ip-dns": ("DNS", "DNS-DNSconfiguration"),
  "ip-dns-static": ("DNS", "DNS-DNSStatic"),
  "ip-fw-filter": ("Filter", None),
  "ip-fw-nat": ("NAT", None),
  "ip-fw-mangle": ("Mangle", None),
  "ip-fw-addrlist": ("Address-lists", None),
  "ip-fw-conn": ("Connection tracking", None),
  "ip-neighbor": ("Neighbor discovery", "Neighbordiscovery-Neighborlist"),
  "ip-pool": ("IP Pools", None),
  "ip-service": ("Services", None),
  "ip-vrf": ("Virtual Routing and Forwarding - VRF", None),
  "ip-settings": ("IP Settings", None),
  "ipv6-address": ("IP Addressing", "IPAddressing-IPv6Addressing"),
  "ipv6-route": ("IP Routing", None),
  "ipv6-fw-filter": ("Filter", None),
  "ipv6-neighbor": ("IPv6 Neighbor Discovery", None),
  "ipv6-nd": ("IPv6 Neighbor Discovery", None),
  "mpls-ldp": ("LDP", None),
  "mpls-interface": ("MPLS Reference", None),
  "routing-table": ("Policy Routing", "PolicyRouting-RoutingTables"),
  "bgp-connection": ("/routing/bgp", "id-/routing/bgp-/routing/bgp/connection"),
  "bgp-session": ("/routing/bgp", "id-/routing/bgp-/routing/bgp/session"),
  "ospf-instance": ("/routing/ospf", "id-/routing/ospf-/routing/ospf/instance"),
  "ospf-neighbor": ("/routing/ospf", "id-/routing/ospf-/routing/ospf/neighbor"),
  "routing-filter": ("/routing/filter", None),
  "sys-identity": ("Identity", None),
  "sys-resource": ("Resource", None),
  "sys-clock": ("Clock", None),
  "sys-users": ("User", None),
  "sys-packages": ("Packages", None),
  "sys-routerboard": ("RouterBOARD", None),
  "sys-health": ("Health", None),
  "sys-license": ("RouterOS license keys", None),
  "sys-ntp": ("NTP", None),
  "sys-scheduler": ("Scheduler", None),
  "sys-scripts": ("Scripting", None),
  "sys-logging": ("Log", "Log-Loggingconfiguration"),
  "queue-simple": ("Queues", "Queues-SimpleQueue"),
  "queue-tree": ("Queues", "Queues-QueueTree"),
  "queue-type": ("Queues", "Queues-QueueTypes"),
  "files": ("Files", None),
  "log": ("Log", "Log-Logmessages"),
  "radius": ("RADIUS", "RADIUS-RADIUSClient"),
  "tool-netwatch": ("Netwatch", None),
  "tool-graphing": ("Graphing", None),
  "tool-romon": ("RoMON", None),
  "tool-bw-server": ("Bandwidth Test", "BandwidthTest-BandwidthTestServer"),
  "tool-email": ("E-mail", None),
  "terminal": ("Command Line Interface", None),
}
pages = {}
def page(title):
    if title not in pages:
        u = f"{BASE}/rest/api/content?spaceKey=ROS&expand=body.view&title=" + urllib.parse.quote(title)
        d = json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "wingox-docs-links"}), timeout=30))
        r = d["results"]
        pages[title] = None if not r else (r[0]["_links"]["webui"], r[0]["title"], set(re.findall(r'id="([^"]+)"', r[0]["body"]["view"]["value"])))
        time.sleep(0.3)
    return pages[title]
bad, out = [], {}
for sid, (title, anchor) in MAP.items():
    p = page(title)
    if not p:
        bad.append(f"{sid}: page {title!r} not found"); continue
    webui, real, ids = p
    url = BASE + webui  # the canonical link Confluence itself gives
    if anchor:
        if anchor not in ids:
            bad.append(f"{sid}: anchor #{anchor} not on {real!r}"); continue
        url += "#" + urllib.parse.quote(anchor, safe="-/.()")
    out[sid] = url
# every page must open (HTTP 200)
checked = {}
for sid, url in out.items():
    page_url = url.split("#")[0]
    if page_url not in checked:
        try:
            req = urllib.request.Request(page_url, headers={"User-Agent": "wingox-docs-links"})
            checked[page_url] = urllib.request.urlopen(req, timeout=30).status
        except Exception as e:
            checked[page_url] = str(e)
        time.sleep(0.3)
    if checked[page_url] != 200:
        bad.append(f"{sid}: {page_url} answered {checked[page_url]}")

print(f"{len(out)} sections resolved, {len(checked)} pages checked, {len(bad)} problems", file=sys.stderr)
for b in bad:
    print("  PROBLEM", b, file=sys.stderr)
if bad:
    sys.exit(1)

import os
target = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "docsLinks.ts")
lines = [
    "// GENERATED by dev/docs-links.py — do not edit by hand; edit the map there and re-run it.",
    "// Each menu section -> its page (and heading) in MikroTik's official RouterOS docs,",
    "// every link verified against help.mikrotik.com when generated.",
    "export const DOCS: Record<string, string> = {",
]
lines += [f"  {json.dumps(k)}: {json.dumps(v)}," for k, v in out.items()]
lines += ["};", ""]
open(target, "w").write("\n".join(lines))
print("wrote", os.path.relpath(target), file=sys.stderr)
