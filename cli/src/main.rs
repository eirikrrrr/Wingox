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
//! --http talks to the router's plain-HTTP `www` service (port 80) instead of
//! `www-ssl`: NOTHING is encrypted, the RouterOS password travels in clear text.
//! Only for routers whose www-ssl has no certificate.
//!
//! <url> is socks5://[user:pass@]host:port or http://[user:pass@]host:port.
//! Values may also come from env: WINGOX_HOST, WINGOX_USER, WINGOX_PASS,
//! WINGOX_PORT, WINGOX_INSECURE, WINGOX_HTTP, WINGOX_PROXY.

use std::env;

use wingox_core::{fetch_certificate, reach, ConnectionConfig, ProxyConfig, ProxyKind, RestClient, Scheme, TlsMode};

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
        let rtt = reach(&cfg, std::time::Duration::from_secs(8)).await.map_err(|e| e.to_string())?;
        println!("reachable — {} ms", rtt.as_millis());
        return Ok(());
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
    proxy: Option<String>,
}

impl Args {
    fn parse() -> Result<Self, String> {
        let mut positional = Vec::new();
        let mut port: Option<u16> = None;
        let mut insecure = false;
        let mut http = false;
        let (mut pin, mut ca, mut fetch_cert, mut reach) = (None, None, false, false);
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
        let no_login = fetch_cert || reach;
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
