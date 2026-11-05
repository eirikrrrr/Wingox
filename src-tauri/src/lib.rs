//! The Tauri desktop shell. It exposes `wingox-core` to the React UI as
//! commands; no networking logic lives here.

use serde::{Deserialize, Serialize};
use wingox_core::{ConnectionConfig, ProxyConfig, ProxyKind, RestClient, TlsMode};

#[derive(Deserialize)]
struct ProxyArgs {
    kind: String,
    host: String,
    port: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectArgs {
    host: String,
    port: u16,
    username: String,
    password: String,
    insecure: bool,
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
    let mut cfg = ConnectionConfig::new(args.host, args.username, args.password);
    cfg.port = args.port;
    if args.insecure {
        cfg.tls = TlsMode::AcceptInvalid;
    }
    if let Some(p) = args.proxy {
        let kind = match p.kind.as_str() {
            "http" => ProxyKind::Http,
            _ => ProxyKind::Socks5,
        };
        cfg.proxy = Some(ProxyConfig::new(kind, p.host, p.port));
    }

    let client = RestClient::connect(&cfg).map_err(|e| e.to_string())?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![connect])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
