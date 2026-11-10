//! The Tauri desktop shell. It exposes `wingox-core` to the React UI as
//! commands; no networking logic lives here.

mod store;

use serde::{Deserialize, Serialize};
use store::Profile;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::{Manager, State};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use wingox_core::{
    fetch_certificate, fetch_host_key, probe, CertificateInfo, ConnectionConfig, Error as CoreError, HostKeyInfo,
    ProbeReport, ProxyConfig, ProxyKind, RestClient, Scheme, Shell, ShellInput, ShellOutput, SshTarget, TlsMode,
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
    /// the SSH port (the monitor also probes it); 22 when absent
    #[serde(default)]
    ssh_port: Option<u16>,
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

/// Reachability "ping" for the monitor (web service, then SSH banner, along
/// the route; no credentials). Always a report: up / down / blocked by the proxy.
#[tauri::command]
async fn reach_device(args: ConnectArgs) -> ProbeReport {
    let ssh_port = args.ssh_port.unwrap_or(22);
    probe(&config(args), ssh_port, Duration::from_secs(8)).await
}

// ── SSH terminal ────────────────────────────────────────────────────────────

/// open shells: id → (window that owns it, input to the shell)
#[derive(Default)]
struct Sessions {
    map: Mutex<HashMap<String, (String, UnboundedSender<ShellInput>)>>,
    next: AtomicU64,
}

impl Sessions {
    fn send(&self, id: &str, input: ShellInput) -> Result<(), String> {
        let map = self.map.lock().map_err(|_| "session table poisoned")?;
        let (_, tx) = map.get(id).ok_or_else(|| format!("no SSH session {id}"))?;
        tx.send(input).map_err(|_| "the SSH session has ended".to_string())
    }

    /// end every shell of a window (it was closed)
    fn close_window(&self, label: &str) {
        if let Ok(mut map) = self.map.lock() {
            map.retain(|_, (owner, tx)| {
                if owner == label {
                    let _ = tx.send(ShellInput::Close);
                    false
                } else {
                    true
                }
            });
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SshArgs {
    host: String,
    ssh_port: u16,
    username: String,
    password: String,
    /// pinned `SHA256:…`; empty/absent = not trusted yet
    #[serde(default)]
    host_key: Option<String>,
    proxy: Option<ProxyArgs>,
}

fn ssh_target(args: SshArgs) -> SshTarget {
    SshTarget {
        host: args.host,
        port: args.ssh_port,
        username: args.username,
        password: args.password,
        proxy: args.proxy.map(proxy_config),
        host_key: args.host_key.filter(|k| !k.trim().is_empty()),
    }
}

/// an SSH failure the UI can act on (accept a key, show a changed key…)
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SshError {
    /// "hostKeyUnknown" | "hostKeyMismatch" | "other"
    kind: &'static str,
    message: String,
    got: Option<String>,
    expected: Option<String>,
    algorithm: Option<String>,
}

impl From<CoreError> for SshError {
    fn from(e: CoreError) -> Self {
        let message = e.to_string();
        match e {
            CoreError::HostKeyUnknown { got, algorithm } => SshError {
                kind: "hostKeyUnknown", message, got: Some(got), expected: None, algorithm: Some(algorithm),
            },
            CoreError::HostKeyMismatch { expected, got } => SshError {
                kind: "hostKeyMismatch", message, got: Some(got), expected: Some(expected), algorithm: None,
            },
            _ => SshError { kind: "other", message, got: None, expected: None, algorithm: None },
        }
    }
}

/// what a shell streams to its terminal
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum SshEvent {
    /// router output, base64 (a chunk may end mid UTF-8 character)
    Data { b64: String },
    Closed { reason: Option<String> },
}

/// Read the router's SSH host key (disconnects before logging in).
#[tauri::command]
async fn ssh_host_key(args: SshArgs) -> Result<HostKeyInfo, SshError> {
    fetch_host_key(&ssh_target(args)).await.map_err(SshError::from)
}

/// Open a shell (`cols`×`rows`); its output streams on `on_event`. Returns the
/// session id for ssh_write / ssh_resize / ssh_close.
#[tauri::command]
async fn ssh_open(
    app: tauri::AppHandle,
    window: tauri::Window,
    sessions: State<'_, Sessions>,
    args: SshArgs,
    cols: u32,
    rows: u32,
    on_event: Channel<SshEvent>,
) -> Result<String, SshError> {
    let shell = Shell::open(&ssh_target(args), cols, rows).await.map_err(SshError::from)?;
    let id = format!("ssh{}", sessions.next.fetch_add(1, Ordering::Relaxed));
    let (tx, rx) = unbounded_channel();
    if let Ok(mut map) = sessions.map.lock() {
        map.insert(id.clone(), (window.label().to_string(), tx));
    }
    let done = id.clone();
    tauri::async_runtime::spawn(async move {
        shell
            .run(rx, move |out| {
                let event = match out {
                    ShellOutput::Data(bytes) => SshEvent::Data { b64: wingox_core::net::base64(&bytes) },
                    ShellOutput::Closed(reason) => SshEvent::Closed { reason },
                };
                let _ = on_event.send(event);
            })
            .await;
        if let Ok(mut map) = app.state::<Sessions>().map.lock() {
            map.remove(&done);
        }
    });
    Ok(id)
}

#[tauri::command]
fn ssh_write(sessions: State<'_, Sessions>, id: String, data: String) -> Result<(), String> {
    sessions.send(&id, ShellInput::Data(data.into_bytes()))
}

#[tauri::command]
fn ssh_resize(sessions: State<'_, Sessions>, id: String, cols: u32, rows: u32) -> Result<(), String> {
    sessions.send(&id, ShellInput::Resize { cols, rows })
}

#[tauri::command]
fn ssh_close(sessions: State<'_, Sessions>, id: String) -> Result<(), String> {
    let _ = sessions.send(&id, ShellInput::Close);
    if let Ok(mut map) = sessions.map.lock() {
        map.remove(&id);
    }
    Ok(())
}

fn proxy_config(p: ProxyArgs) -> ProxyConfig {
    let kind = match p.kind.as_str() {
        "http" => ProxyKind::Http,
        _ => ProxyKind::Socks5,
    };
    let mut proxy = ProxyConfig::new(kind, p.host, p.port);
    if let Some(user) = p.username.filter(|u| !u.is_empty()) {
        proxy = proxy.with_auth(user, p.password.unwrap_or_default());
    }
    proxy
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
    cfg.proxy = args.proxy.map(proxy_config);
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
        .plugin(tauri_plugin_opener::init())
        .manage(Sessions::default())
        // a closed window takes its SSH sessions with it
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<Sessions>().close_window(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            connect,
            rest_get,
            tls_fetch,
            reach_device,
            ssh_host_key,
            ssh_open,
            ssh_write,
            ssh_resize,
            ssh_close,
            profiles_list,
            profile_save,
            profile_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
