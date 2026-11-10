//! Saved connection profiles — one per device, each with its own host, port,
//! credentials and proxy. Persisted as JSON in the app's config directory.
//!
//! NOTE: secrets are kept in this file for now. Moving them to the OS keychain
//! (Windows Credential Manager / Keychain / Secret Service) is the next
//! hardening step; the metadata stays here, the secrets move out.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Proxy {
    pub kind: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub host: String,
    /// "https" or "http" (unencrypted); profiles saved before this field are https
    #[serde(default = "https")]
    pub scheme: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub insecure: bool,
    /// "pinned" | "ca" | "verify" | "insecure" (empty on older profiles: `insecure` decides)
    #[serde(default)]
    pub tls_mode: String,
    /// pinned SHA-256 fingerprint of the router's certificate
    #[serde(default)]
    pub pin: String,
    /// trusted CA (PEM) for "ca"
    #[serde(default)]
    pub ca_pem: String,
    /// SSH port for the terminal (22 when absent)
    #[serde(default = "ssh_port")]
    pub ssh_port: u16,
    /// pinned SSH host key fingerprint, `SHA256:…`
    #[serde(default)]
    pub ssh_host_key: String,
    /// watched by the reachability monitor
    #[serde(default)]
    pub monitor: bool,
    #[serde(default)]
    pub proxy: Option<Proxy>,
}

fn ssh_port() -> u16 {
    22
}

fn https() -> String {
    "https".into()
}

fn file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("profiles.json"))
}

pub fn load(app: &AppHandle) -> Result<Vec<Profile>, String> {
    let path = file(app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn save_all(app: &AppHandle, profiles: &[Profile]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(profiles).map_err(|e| e.to_string())?;
    fs::write(file(app)?, text).map_err(|e| e.to_string())
}

pub fn upsert(app: &AppHandle, mut profile: Profile) -> Result<Profile, String> {
    let mut list = load(app)?;
    if profile.id.is_empty() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        profile.id = format!("p{now}");
    }
    match list.iter_mut().find(|p| p.id == profile.id) {
        Some(existing) => *existing = profile.clone(),
        None => list.push(profile.clone()),
    }
    save_all(app, &list)?;
    Ok(profile)
}

pub fn delete(app: &AppHandle, id: &str) -> Result<(), String> {
    let mut list = load(app)?;
    list.retain(|p| p.id != id);
    save_all(app, &list)
}
