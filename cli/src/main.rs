//! Wingox headless test harness.
//!
//! Connects to a RouterOS device over REST — directly or through a proxy — and
//! prints its identity, version and interfaces. This is how we prove the core
//! idea (proxy connectivity) here on the Pi, before any UI.
//!
//! Usage:
//!   wingox <host> <user> <password> [--port 443] [--insecure] [--proxy <url>]
//!
//! <url> is socks5://[user:pass@]host:port or http://[user:pass@]host:port.
//! Values may also come from env: WINGOX_HOST, WINGOX_USER, WINGOX_PASS,
//! WINGOX_PORT, WINGOX_INSECURE, WINGOX_PROXY.

use std::env;

use wingox_core::{ConnectionConfig, ProxyConfig, ProxyKind, RestClient, TlsMode};

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
    cfg.port = args.port;
    if args.insecure {
        cfg.tls = TlsMode::AcceptInvalid;
    }
    if let Some(url) = args.proxy.as_deref() {
        cfg.proxy = Some(parse_proxy(url)?);
    }

    let via = match &cfg.proxy {
        Some(p) => format!("via {:?} {}:{}", p.kind, p.host, p.port),
        None => "directly".to_string(),
    };
    eprintln!("connecting to {}:{} {via}…", cfg.host, cfg.port);

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
    port: u16,
    insecure: bool,
    proxy: Option<String>,
}

impl Args {
    fn parse() -> Result<Self, String> {
        let mut positional = Vec::new();
        let mut port: Option<u16> = None;
        let mut insecure = false;
        let mut proxy: Option<String> = None;

        let mut it = env::args().skip(1);
        while let Some(arg) = it.next() {
            match arg.as_str() {
                "--insecure" | "-k" => insecure = true,
                "--port" => port = Some(next(&mut it, "--port")?.parse().map_err(|_| "bad --port")?),
                "--proxy" => proxy = Some(next(&mut it, "--proxy")?),
                "-h" | "--help" => return Err(USAGE.to_string()),
                other if other.starts_with('-') => return Err(format!("unknown flag {other}\n{USAGE}")),
                other => positional.push(other.to_string()),
            }
        }

        let env_opt = |k: &str| env::var(k).ok().filter(|v| !v.is_empty());
        let host = positional.first().cloned().or_else(|| env_opt("WINGOX_HOST"));
        let user = positional.get(1).cloned().or_else(|| env_opt("WINGOX_USER"));
        let pass = positional.get(2).cloned().or_else(|| env_opt("WINGOX_PASS"));
        if proxy.is_none() {
            proxy = env_opt("WINGOX_PROXY");
        }
        if port.is_none() {
            port = env_opt("WINGOX_PORT").and_then(|v| v.parse().ok());
        }
        if !insecure {
            insecure = env_opt("WINGOX_INSECURE").is_some();
        }

        Ok(Args {
            host: host.ok_or_else(|| format!("missing host\n{USAGE}"))?,
            user: user.ok_or_else(|| format!("missing user\n{USAGE}"))?,
            pass: pass.ok_or_else(|| format!("missing password\n{USAGE}"))?,
            port: port.unwrap_or(443),
            insecure,
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
    "usage: wingox <host> <user> <password> [--port 443] [--insecure] [--proxy socks5://host:port]";
