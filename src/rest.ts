// Configuring the router over REST — how RouterOS maps its console onto HTTP:
//   print  → GET    menu              add    → PUT    menu {…}
//   set    → PATCH  menu/*id {…}      remove → DELETE menu/*id
//   other commands (enable, disable, comment, `set` on a settings menu…)
//          → POST   menu/<command> {…}
// What the user may change is the router's call (its user's rights); its
// errors come back as RouterOS words them ("invalid value abc for mtu…").
//
// The fields a command takes come from the router itself
// (`console/inspect request=syntax`), and a field's possible values from
// `request=completion` — so forms fit each menu and RouterOS version.
import { invoke } from "@tauri-apps/api/core";
import { connArgs, type Profile } from "./App";

export type Row = Record<string, unknown>;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export function restCall(p: Profile, method: Method, path: string, body?: unknown): Promise<unknown> {
  return invoke<unknown>("rest_call", { args: connArgs(p), method, path, body: body ?? null });
}

/** the actions on one menu of one device */
export interface Api {
  get: (path: string) => Promise<unknown>;
  add: (path: string, fields: Row) => Promise<unknown>;
  set: (path: string, id: string, fields: Row) => Promise<unknown>;
  /** `set` on a settings menu (one object, no ids: ip/dns, system/identity…) */
  setSettings: (path: string, fields: Row) => Promise<unknown>;
  remove: (path: string, id: string) => Promise<unknown>;
  enable: (path: string, id: string) => Promise<unknown>;
  disable: (path: string, id: string) => Promise<unknown>;
  /** the fields a command takes, with their help text (cached per device) */
  fields: (path: string, cmd: string) => Promise<Field[]>;
  /** the values a field may take, when RouterOS knows them (enums, interface names…) */
  values: (path: string, cmd: string, field: string) => Promise<string[]>;
}

export interface Field {
  name: string;
  help: string;
}

/** arguments that steer a command rather than set a property */
const NOT_FIELDS = new Set(["numbers", "copy-from", "place-before", "value-name", ".id", ".proplist", ".query"]);

const cache = new Map<string, Promise<unknown>>();
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  let hit = cache.get(key) as Promise<T> | undefined;
  if (!hit) {
    hit = load();
    cache.set(key, hit);
    hit.catch(() => cache.delete(key)); // a failure is not remembered
  }
  return hit;
}

const comma = (path: string) => path.split("/").join(",");

export function makeApi(p: Profile): Api {
  const call = (method: Method, path: string, body?: unknown) => restCall(p, method, path, body);
  const device = `${p.scheme ?? "https"}://${p.host}:${p.port}`;
  const inspect = (body: Row) => call("POST", "console/inspect", body) as Promise<Row[]>;
  return {
    get: (path) => call("GET", path),
    add: (path, fields) => call("PUT", path, fields),
    set: (path, id, fields) => call("PATCH", `${path}/${id}`, fields),
    setSettings: (path, fields) => call("POST", `${path}/set`, fields),
    remove: (path, id) => call("DELETE", `${path}/${id}`),
    enable: (path, id) => call("POST", `${path}/enable`, { ".id": id }),
    disable: (path, id) => call("POST", `${path}/disable`, { ".id": id }),
    fields: (path, cmd) =>
      cached(`${device} syntax ${path} ${cmd}`, async () => {
        const out = await inspect({ request: "syntax", path: `${comma(path)},${cmd}` });
        return out
          .filter((x) => x["symbol-type"] === "explanation" && x.nested === "1")
          .map((x) => ({ name: String(x.symbol), help: String(x.text ?? "") }))
          .filter((f) => f.name && !NOT_FIELDS.has(f.name));
      }),
    // not cached: they change (a new interface, a new address list…)
    values: async (path, cmd, field) => {
      const out = await inspect({ request: "completion", input: `/${path}/${cmd} ${field}=` });
      return out
        .filter((x) => x.show === "true" && x.style !== "syntax-meta" && String(x.completion ?? "").trim())
        .map((x) => String(x.completion))
        .filter((v, i, all) => all.indexOf(v) === i);
    },
  };
}
