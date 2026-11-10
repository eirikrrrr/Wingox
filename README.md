# Wingox

A cross-platform desktop app to manage MikroTik RouterOS devices — a modern
alternative to WinBox (its name is a nod to WinBox) whose headline feature is connecting **through a proxy or
an SSH jump** to routers on another network. Built on the official RouterOS APIs
(REST + binary API) with Tauri (Rust) + React/TypeScript.

> Local, pre-repository stage: the design is documented first;
> code comes next.

Una app de escritorio multiplataforma para gestionar routers MikroTik (RouterOS)
— una alternativa moderna a WinBox cuya función estrella es conectar **a través
de un proxy o un salto SSH** a routers de otra red. Sobre las APIs oficiales de
RouterOS (REST + API binaria), con Tauri (Rust) + React/TypeScript.

> Fase local, previa al repositorio: primero el diseño
> documentado; luego el código.

## Design / Diseño

- [docs/DESIGN.en.md](docs/DESIGN.en.md) — technical design (English)
- [docs/DESIGN.es.md](docs/DESIGN.es.md) — diseño técnico (español)

## Build & run (desktop app)

```sh
npm install
npm run tauri dev      # run the app in development
npm run tauri build    # build installers for the current OS
```

The Rust core and the headless CLI (no GUI, for testing) live in `core/` and
`cli/`: `cargo run -p wingox-cli -- <host> <user> <pass> [--insecure] [--http] [--proxy socks5://host:port]`.
`--http` uses the router's plain-HTTP `www` service for routers whose `www-ssl`
has no certificate — **unencrypted**: the RouterOS password travels in clear text.

## Windows builds

Windows binaries are built in CI (`.github/workflows/windows.yml`) on every push
to `main`: download the `.exe`/installers from the run's artifacts. Windows apps
must be built on Windows (WebView2 + MSVC), so this does not run on Linux.

## Test router (lab)

`dev/routeros-lab.sh` runs a MikroTik RouterOS 7 (CHR, in QEMU/KVM) on this
host, reachable from the LAN: REST on `:2443` (self-signed), SSH on `:2022`,
binary API on `:2728`, login `admin` / `admin`. After a container restart
RouterOS boots fresh: run `dev/routeros-lab.sh rest` to enable REST again.
A lab only — never expose it outside a trusted network.
