//! Wingox headless test harness.
//!
//! Connects to a RouterOS device over REST — directly or through a proxy — and
//! prints its identity, version and interfaces. This is how we prove the core
//! idea (proxy connectivity) here on the Pi, before any UI.
//!
//! Usage:
//!   wingox <host> <user> <password> [--port 443] [--insecure | --pin <sha256> | --ca <pem-file>]
//!          [--http] [--proxy <url>] [--fetch-cert] [--reach]
//!
//! --pin accepts only the certificate with that SHA-256 fingerprint; --ca
//! verifies the chain and the name against that CA. --fetch-cert prints the
//! router's certificate (nothing else is sent), --reach checks reachability
//! without credentials.
//!
//! SSH (port --ssh-port, 22 by default): --fetch-host-key prints the router's
//! host key (disconnects before logging in); --ssh-run "<command>" logs in with
//! the pinned --host-key SHA256:…, runs the command in a shell and prints it;
//! --ssh-pipe bridges the shell to stdin/stdout byte for byte (for driving it
//! from another program — the other end must answer like a terminal).
//!
//! --http talks to the router's plain-HTTP `www` service (port 80) instead of
//! `www-ssl`: NOTHING is encrypted, the RouterOS password travels in clear text.
//! Only for routers whose www-ssl has no certificate.
//!
//! <url> is socks5://[user:pass@]host:port or http://[user:pass@]host:port.
//! Values may also come from env: WINGOX_HOST, WINGOX_USER, WINGOX_PASS,
//! WINGOX_PORT, WINGOX_INSECURE, WINGOX_HTTP, WINGOX_PROXY.

use std::env;

use wingox_core::{
    fetch_certificate, fetch_host_key, probe, ConnectionConfig, ProxyConfig, ProxyKind, RestClient, Scheme, Shell, ShellInput,
    ShellOutput, SshTarget, TlsMode,
};

#[tokio::main]
async fn main() {
    if let Err(message) = run().await {
        eprintln!("error: {message}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let args = Args::parse()?;

    let mut cfg = ConnectionConfig::new(args.host, args.user, args.pass);
    if args.http {
        cfg.scheme = Scheme::Http;
        eprintln!(
            "WARNING: plain HTTP — the RouterOS user and password and all data travel UNENCRYPTED \
             (readable by the proxy and every network hop)."
        );
    }
    cfg.port = args.port.unwrap_or(cfg.scheme.default_port());
    if args.insecure {
        cfg.tls = TlsMode::AcceptInvalid;
    }
    if let Some(pin) = &args.pin {
        cfg.tls = TlsMode::Pinned(pin.clone());
    }
    if let Some(file) = &args.ca {
        let pem = std::fs::read_to_string(file).map_err(|e| format!("--ca {file}: {e}"))?;
        cfg.tls = TlsMode::TrustedCa(pem);
    }
    if let Some(url) = args.proxy.as_deref() {
        cfg.proxy = Some(parse_proxy(url)?);
    }

    let via = match &cfg.proxy {
        Some(p) => format!("via {:?} {}:{}", p.kind, p.host, p.port),
        None => "directly".to_string(),
    };
    eprintln!("connecting to {}://{}:{} {via}…", cfg.scheme.as_str(), cfg.host, cfg.port);

    if args.fetch_host_key || args.ssh_run.is_some() || args.ssh_pipe {
        let target = SshTarget {
            host: cfg.host.clone(),
            port: args.ssh_port.unwrap_or(22),
            username: cfg.username.clone(),
            password: cfg.password.clone(),
            proxy: cfg.proxy.clone(),
            host_key: args.host_key.clone(),
        };
        if args.fetch_host_key {
            let k = fetch_host_key(&target).await.map_err(|e| e.to_string())?;
            println!("{} {}\n\npin it with: --host-key {}", k.algorithm, k.sha256, k.sha256);
            return Ok(());
        }
        if args.ssh_pipe {
            return ssh_pipe(&target).await;
        }
        // non-interactive: RouterOS's "+ct" login suffix turns off colors and the
        // terminal auto-detection (which needs a real terminal to answer)
        let mut target = target;
        if !target.username.contains('+') {
            target.username.push_str("+ct");
        }
        return ssh_run(&target, args.ssh_run.as_deref().unwrap_or("")).await;
    }
    if args.fetch_cert {
        let c = fetch_certificate(&cfg).await.map_err(|e| e.to_string())?;
        println!("sha256      {}", c.sha256_pretty);
        println!("subject     {}", c.subject);
        println!("issuer      {}{}", c.issuer, if c.self_signed { "  (self-signed)" } else { "" });
        println!("valid       {} → {}", c.not_before, c.not_after);
        println!("alt names   {}", c.subject_alt_names.join(", "));
        println!("\npin it with: --pin {}", c.sha256);
        return Ok(());
    }
    if args.reach {
        let r = probe(&cfg, args.ssh_port.unwrap_or(22), std::time::Duration::from_secs(8)).await;
        if r.up {
            println!("reachable — {} ms via {}", r.ms.unwrap_or(0), r.via.unwrap_or_default());
            return Ok(());
        }
        return Err(format!("{}{}", if r.blocked { "cannot probe (blocked by the proxy): " } else { "down: " }, r.detail.unwrap_or_default()));
    }

    let client = RestClient::connect(&cfg).map_err(|e| e.to_string())?;
    let identity = client.identity().await.map_err(|e| e.to_string())?;
    let res = client.system_resource().await.map_err(|e| e.to_string())?;

    println!(
        "\n✓ {} — RouterOS {} on {} ({}), cpu {}%, up {}",
        identity.name, res.version, res.board_name, res.architecture, res.cpu_load, res.uptime
    );

    let interfaces = client.interfaces().await.map_err(|e| e.to_string())?;
    println!("\ninterfaces ({}):", interfaces.len());
    for row in &interfaces {
        let s = |key: &str| row.get(key).map(render).unwrap_or_default();
        println!(
            "  {:<16} {:<12} running={:<5} {}",
            s("name"),
            s("type"),
            s("running"),
            s("mac-address")
        );
    }
    Ok(())
}

/// open a shell, type one command, print what comes back, quit
async fn ssh_run(target: &SshTarget, command: &str) -> Result<(), String> {
    let shell = Shell::open(target, 120, 40).await.map_err(|e| e.to_string())?;
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel();
    let pump = tokio::spawn(shell.run(rx, move |o| { let _ = out_tx.send(o); }));
    let mut sent = false;
    let mut quit = false;
    loop {
        // the prompt settles, then the command, then a quiet spell ends it
        match tokio::time::timeout(std::time::Duration::from_millis(2500), out_rx.recv()).await {
            Ok(Some(ShellOutput::Data(bytes))) => {
                // RouterOS asks the terminal where its cursor is (ESC[6n) to learn
                // the size; a real terminal (xterm.js in the app) answers, so do we
                if bytes.windows(4).any(|w| w == b"\x1b[6n") {
                    let _ = tx.send(ShellInput::Data(b"\x1b[40;1R".to_vec()));
                }
                print!("{}", String::from_utf8_lossy(&bytes));
            }
            Ok(Some(ShellOutput::Closed(reason))) => {
                println!("\n[session closed{}]", reason.map(|r| format!(": {r}")).unwrap_or_default());
                break;
            }
            Ok(None) => break,
            Err(_) if !sent => {
                let _ = tx.send(ShellInput::Data(format!("{command}\r").into_bytes()));
                sent = true;
            }
            Err(_) if !quit => {
                let _ = tx.send(ShellInput::Data(b"/quit\r".to_vec()));
                quit = true;
            }
            Err(_) => {
                let _ = tx.send(ShellInput::Close);
            }
        }
    }
    let _ = pump.await;
    Ok(())
}

/// the shell ⇄ stdin/stdout, raw bytes
async fn ssh_pipe(target: &SshTarget) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let size = |k: &str, d: u32| env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
    let shell = Shell::open(target, size("WINGOX_COLS", 120), size("WINGOX_ROWS", 40)).await.map_err(|e| e.to_string())?;
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut stdin = tokio::io::stdin();
        let mut buf = [0u8; 4096];
        loop {
            match stdin.read(&mut buf).await {
                Ok(0) | Err(_) => {
                    let _ = tx.send(ShellInput::Close);
                    break;
                }
                Ok(n) => {
                    let _ = tx.send(ShellInput::Data(buf[..n].to_vec()));
                }
            }
        }
    });
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel();
    let pump = tokio::spawn(shell.run(rx, move |o| { let _ = out_tx.send(o); }));
    let mut stdout = tokio::io::stdout();
    while let Some(o) = out_rx.recv().await {
        match o {
            ShellOutput::Data(bytes) => {
                let _ = stdout.write_all(&bytes).await;
                let _ = stdout.flush().await;
            }
            ShellOutput::Closed(reason) => {
                if let Some(r) = reason {
                    eprintln!("[session closed: {r}]");
                }
                break;
            }
        }
    }
    let _ = pump.await;
    Ok(())
}

/// a JSON scalar as a plain string (RouterOS mixes strings and bools)
fn render(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

struct Args {
    host: String,
    user: String,
    pass: String,
    port: Option<u16>,
    insecure: bool,
    http: bool,
    pin: Option<String>,
    ca: Option<String>,
    fetch_cert: bool,
    reach: bool,
    ssh_port: Option<u16>,
    host_key: Option<String>,
    fetch_host_key: bool,
    ssh_run: Option<String>,
    ssh_pipe: bool,
    proxy: Option<String>,
}

impl Args {
    fn parse() -> Result<Self, String> {
        let mut positional = Vec::new();
        let mut port: Option<u16> = None;
        let mut insecure = false;
        let mut http = false;
        let (mut pin, mut ca, mut fetch_cert, mut reach) = (None, None, false, false);
        let (mut ssh_port, mut host_key, mut fetch_host_key, mut ssh_run) = (None, None, false, None);
        let mut ssh_pipe = false;
        let mut proxy: Option<String> = None;

        let mut it = env::args().skip(1);
        while let Some(arg) = it.next() {
            match arg.as_str() {
                "--insecure" | "-k" => insecure = true,
                "--http" => http = true,
                "--pin" => pin = Some(next(&mut it, "--pin")?),
                "--ca" => ca = Some(next(&mut it, "--ca")?),
                "--fetch-cert" => fetch_cert = true,
                "--reach" => reach = true,
                "--ssh-port" => ssh_port = Some(next(&mut it, "--ssh-port")?.parse().map_err(|_| "bad --ssh-port")?),
                "--host-key" => host_key = Some(next(&mut it, "--host-key")?),
                "--fetch-host-key" => fetch_host_key = true,
                "--ssh-run" => ssh_run = Some(next(&mut it, "--ssh-run")?),
                "--ssh-pipe" => ssh_pipe = true,
                "--port" => port = Some(next(&mut it, "--port")?.parse().map_err(|_| "bad --port")?),
                "--proxy" => proxy = Some(next(&mut it, "--proxy")?),
                "-h" | "--help" => return Err(USAGE.to_string()),
                other if other.starts_with('-') => return Err(format!("unknown flag {other}\n{USAGE}")),
                other => positional.push(other.to_string()),
            }
        }

        let env_opt = |k: &str| env::var(k).ok().filter(|v| !v.is_empty());
        let host = positional.first().cloned().or_else(|| env_opt("WINGOX_HOST"));
        // --fetch-cert / --reach send no credentials, so they are optional there
        let no_login = fetch_cert || reach || fetch_host_key;
        let user = positional.get(1).cloned().or_else(|| env_opt("WINGOX_USER")).or(no_login.then(String::new));
        let pass = positional.get(2).cloned().or_else(|| env_opt("WINGOX_PASS")).or(no_login.then(String::new));
        if proxy.is_none() {
            proxy = env_opt("WINGOX_PROXY");
        }
        if port.is_none() {
            port = env_opt("WINGOX_PORT").and_then(|v| v.parse().ok());
        }
        if !insecure {
            insecure = env_opt("WINGOX_INSECURE").is_some();
        }
        if !http {
            http = env_opt("WINGOX_HTTP").is_some();
        }

        Ok(Args {
            host: host.ok_or_else(|| format!("missing host\n{USAGE}"))?,
            user: user.ok_or_else(|| format!("missing user\n{USAGE}"))?,
            pass: pass.ok_or_else(|| format!("missing password\n{USAGE}"))?,
            port,
            insecure,
            http,
            pin,
            ca,
            fetch_cert,
            reach,
            ssh_port,
            host_key,
            fetch_host_key,
            ssh_run,
            ssh_pipe,
            proxy,
        })
    }
}

fn next(it: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    it.next().ok_or_else(|| format!("{flag} needs a value"))
}

/// socks5://[user:pass@]host:port  or  http://[user:pass@]host:port
fn parse_proxy(url: &str) -> Result<ProxyConfig, String> {
    let (scheme, rest) = url.split_once("://").ok_or("proxy must be socks5://… or http://…")?;
    let kind = match scheme.to_ascii_lowercase().as_str() {
        "socks5" | "socks5h" | "socks" => ProxyKind::Socks5,
        "http" | "https" => ProxyKind::Http,
        other => return Err(format!("unknown proxy scheme {other}")),
    };
    let (auth, hostport) = match rest.rsplit_once('@') {
        Some((auth, hp)) => (Some(auth), hp),
        None => (None, rest),
    };
    let (host, port) = hostport.rsplit_once(':').ok_or("proxy needs host:port")?;
    let port: u16 = port.parse().map_err(|_| "bad proxy port")?;

    let mut proxy = ProxyConfig::new(kind, host, port);
    if let Some(auth) = auth {
        let (user, pass) = auth.split_once(':').unwrap_or((auth, ""));
        proxy = proxy.with_auth(user, pass);
    }
    Ok(proxy)
}

const USAGE: &str =
    "usage: wingox <host> [<user> <password>] [--port 443] [--insecure | --pin <sha256> | --ca <pem>] [--http] [--proxy socks5://host:port] [--fetch-cert] [--reach]";
