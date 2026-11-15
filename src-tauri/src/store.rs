//! Saved connection profiles — one per device, each with its own host, port,
//! credentials and proxy. Persisted as JSON in the app's config directory;
//! the passwords (RouterOS and proxy) live in the OS keychain (`secrets.rs`)
//! whenever it works, and only then are they left out of the file. Profiles
//! saved before that move there by themselves the first time they are loaded.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::secrets::{self, Kind};

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
    /// the passwords are in the OS keychain, not in this file
    #[serde(default)]
    pub keychain: bool,
}

/// The copy written to disk: the passwords go to the keychain when it takes
/// them (and reads them back identical); otherwise they stay in the file.
fn sealed(p: &Profile) -> Profile {
    let mut disk = p.clone();
    let proxy_password = p.proxy.as_ref().map(|x| x.password.as_str()).unwrap_or("");
    if secrets::put(&p.id, Kind::Password, &p.password) && secrets::put(&p.id, Kind::ProxyPassword, proxy_password) {
        disk.password.clear();
        if let Some(x) = disk.proxy.as_mut() {
            x.password.clear();
        }
        disk.keychain = true;
    } else {
        disk.keychain = false;
    }
    disk
}

/// The profile as the UI uses it: passwords filled in from the keychain.
fn revealed(mut p: Profile) -> Profile {
    if p.keychain {
        p.password = secrets::get(&p.id, Kind::Password).unwrap_or_default();
        if let Some(x) = p.proxy.as_mut() {
            x.password = secrets::get(&p.id, Kind::ProxyPassword).unwrap_or_default();
        }
    }
    p
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

/// the profiles as stored (passwords possibly in the keychain)
fn load_disk(app: &AppHandle) -> Result<Vec<Profile>, String> {
    let path = file(app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// The profiles with their passwords. Ones still holding passwords in the
/// file (saved before the keychain, or when it failed) are moved there now.
pub fn load(app: &AppHandle) -> Result<Vec<Profile>, String> {
    let mut list = load_disk(app)?;
    let mut moved = false;
    for p in list.iter_mut() {
        let has_secret = !p.password.is_empty() || p.proxy.as_ref().is_some_and(|x| !x.password.is_empty());
        if !p.keychain && has_secret {
            let disk = sealed(p);
            if disk.keychain {
                *p = disk;
                moved = true;
            }
        }
    }
    if moved {
        save_all(app, &list)?;
    }
    Ok(list.into_iter().map(revealed).collect())
}

fn save_all(app: &AppHandle, profiles: &[Profile]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(profiles).map_err(|e| e.to_string())?;
    fs::write(file(app)?, text).map_err(|e| e.to_string())
}

pub fn upsert(app: &AppHandle, mut profile: Profile) -> Result<Profile, String> {
    let mut list = load_disk(app)?;
    if profile.id.is_empty() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        profile.id = format!("p{now}");
    }
    let disk = sealed(&profile);
    profile.keychain = disk.keychain;
    match list.iter_mut().find(|p| p.id == profile.id) {
        Some(existing) => *existing = disk,
        None => list.push(disk),
    }
    save_all(app, &list)?;
    Ok(profile)
}

pub fn delete(app: &AppHandle, id: &str) -> Result<(), String> {
    let mut list = load_disk(app)?;
    list.retain(|p| p.id != id);
    save_all(app, &list)?;
    secrets::forget(id);
    Ok(())
}
