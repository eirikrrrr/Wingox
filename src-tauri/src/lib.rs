//! The Tauri desktop shell. It exposes `wingox-core` to the React UI as
//! commands; no networking logic lives here.

mod store;

use serde::{Deserialize, Serialize};
use store::Profile;
use std::time::Duration;

use wingox_core::{
    fetch_certificate, reach, CertificateInfo, ConnectionConfig, ProxyConfig, ProxyKind, RestClient, Scheme, TlsMode,
};

#[derive(Deserialize)]
struct ProxyArgs {
    kind: String,
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectArgs {
    host: String,
    /// "https" (default) or "http" — plain HTTP is unencrypted, the UI warns
    #[serde(default)]
    scheme: Option<String>,
    port: u16,
    username: String,
    password: String,
    insecure: bool,
    /// "pinned" | "ca" | "verify" | "insecure"; absent on older UIs → `insecure` decides
    #[serde(default)]
    tls_mode: Option<String>,
    /// SHA-256 fingerprint for "pinned"
    #[serde(default)]
    pin: Option<String>,
    /// PEM for "ca"
    #[serde(default)]
    ca_pem: Option<String>,
    proxy: Option<ProxyArgs>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Probe {
    identity: String,
    version: String,
    board: String,
    architecture: String,
    cpu_load: String,
    uptime: String,
    interfaces: Vec<serde_json::Value>,
}

/// Connect to a router over REST (optionally through a proxy) and read a few
/// facts: identity, version and interfaces.
#[tauri::command]
async fn connect(args: ConnectArgs) -> Result<Probe, String> {
    let client = RestClient::connect(&config(args)).map_err(|e| e.to_string())?;
    let identity = client.identity().await.map_err(|e| e.to_string())?;
    let res = client.system_resource().await.map_err(|e| e.to_string())?;
    let interfaces = client.interfaces().await.map_err(|e| e.to_string())?;

    Ok(Probe {
        identity: identity.name,
        version: res.version,
        board: res.board_name,
        architecture: res.architecture,
        cpu_load: res.cpu_load,
        uptime: res.uptime,
        interfaces,
    })
}

/// Read any RouterOS menu (e.g. `ip/address`) through the same route as the
/// connection; the menu sidebar opens each section with this.
#[tauri::command]
async fn rest_get(args: ConnectArgs, path: String) -> Result<serde_json::Value, String> {
    let client = RestClient::connect(&config(args)).map_err(|e| e.to_string())?;
    client.get(&path).await.map_err(|e| e.to_string())
}

/// Read the router's certificate (without trusting it, sending nothing else)
/// so the user can pin it.
#[tauri::command]
async fn tls_fetch(args: ConnectArgs) -> Result<CertificateInfo, String> {
    fetch_certificate(&config(args)).await.map_err(|e| e.to_string())
}

/// Reachability "ping" for the monitor: no credentials, returns milliseconds.
#[tauri::command]
async fn reach_device(args: ConnectArgs) -> Result<u64, String> {
    reach(&config(args), Duration::from_secs(8))
        .await
        .map(|d| d.as_millis() as u64)
        .map_err(|e| e.to_string())
}

/// the connection (TLS, optional proxy) the UI asked for
fn config(args: ConnectArgs) -> ConnectionConfig {
    let mut cfg = ConnectionConfig::new(args.host, args.username, args.password);
    if args.scheme.as_deref() == Some("http") {
        cfg.scheme = Scheme::Http;
    }
    cfg.port = args.port;
    cfg.tls = match args.tls_mode.as_deref() {
        Some("pinned") => TlsMode::Pinned(args.pin.unwrap_or_default()),
        Some("ca") => TlsMode::TrustedCa(args.ca_pem.unwrap_or_default()),
        Some("verify") => TlsMode::Verify,
        Some(_) => TlsMode::AcceptInvalid,
        None if args.insecure => TlsMode::AcceptInvalid,
        None => TlsMode::Verify,
    };
    if let Some(p) = args.proxy {
        let kind = match p.kind.as_str() {
            "http" => ProxyKind::Http,
            _ => ProxyKind::Socks5,
        };
        let mut proxy = ProxyConfig::new(kind, p.host, p.port);
        if let Some(user) = p.username.filter(|u| !u.is_empty()) {
            proxy = proxy.with_auth(user, p.password.unwrap_or_default());
        }
        cfg.proxy = Some(proxy);
    }
    cfg
}

#[tauri::command]
fn profiles_list(app: tauri::AppHandle) -> Result<Vec<Profile>, String> {
    store::load(&app)
}

#[tauri::command]
fn profile_save(app: tauri::AppHandle, profile: Profile) -> Result<Profile, String> {
    store::upsert(&app, profile)
}

#[tauri::command]
fn profile_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    store::delete(&app, &id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            connect,
            rest_get,
            tls_fetch,
            reach_device,
            profiles_list,
            profile_save,
            profile_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
