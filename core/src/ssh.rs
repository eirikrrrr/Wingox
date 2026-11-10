//! The device terminal: an SSH shell (PTY) on the router, through the same
//! route as everything else (direct, SOCKS5, HTTP CONNECT — see `net.rs`).
//!
//! The router's host key is pinned like OpenSSH's known_hosts, by its SHA-256
//! fingerprint (`SHA256:…`): the first contact shows it and the user accepts
//! it ([`fetch_host_key`] reads it and disconnects before authenticating, so
//! the password is never sent to an unverified host); after that only that key
//! is accepted and a different one is refused loudly.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handler};
use russh::keys::HashAlg;
use russh::ChannelMsg;
use serde::Serialize;
use tokio::sync::mpsc;

use crate::error::{Error, Result};
use crate::transport::ProxyConfig;

/// Where and as whom to open a shell.
#[derive(Debug, Clone)]
pub struct SshTarget {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub proxy: Option<ProxyConfig>,
    /// the pinned host key fingerprint (`SHA256:…`); `None` = not trusted yet
    pub host_key: Option<String>,
}

/// The router's SSH host key, shown before the user pins it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    /// e.g. `ssh-ed25519`, `rsa-sha2-512`
    pub algorithm: String,
    /// OpenSSH-style `SHA256:…` (what `ssh-keygen -lf` and `ssh` print)
    pub sha256: String,
}

/// `SHA256:abc=` and `abc` are the same fingerprint
fn same_fingerprint(a: &str, b: &str) -> bool {
    let clean = |s: &str| s.trim().trim_start_matches("SHA256:").trim_end_matches('=').to_string();
    !clean(a).is_empty() && clean(a) == clean(b)
}

struct Checker {
    expected: Option<String>,
    seen: Arc<Mutex<Option<HostKeyInfo>>>,
}

impl Handler for Checker {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        let key = key.public_key();
        let info = HostKeyInfo {
            algorithm: key.algorithm().to_string(),
            sha256: key.fingerprint(HashAlg::Sha256).to_string(),
        };
        let trusted = self.expected.as_deref().is_some_and(|e| same_fingerprint(e, &info.sha256));
        if let Ok(mut seen) = self.seen.lock() {
            *seen = Some(info);
        }
        Ok(trusted)
    }
}

fn config() -> Arc<client::Config> {
    Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 4,
        ..Default::default()
    })
}

/// SSH up to (and including) the host key check
async fn handshake(target: &SshTarget) -> Result<client::Handle<Checker>> {
    let stream = crate::net::connect(&target.host, target.port, target.proxy.as_ref()).await?;
    let seen: Arc<Mutex<Option<HostKeyInfo>>> = Arc::default();
    let checker = Checker { expected: target.host_key.clone(), seen: seen.clone() };
    match client::connect_stream(config(), stream, checker).await {
        Ok(handle) => Ok(handle),
        Err(e) => {
            let got = seen.lock().ok().and_then(|s| s.clone());
            Err(match (got, &target.host_key) {
                (Some(got), None) => Error::HostKeyUnknown { got: got.sha256, algorithm: got.algorithm },
                (Some(got), Some(expected)) if !same_fingerprint(expected, &got.sha256) => {
                    Error::HostKeyMismatch { expected: expected.clone(), got: got.sha256 }
                }
                _ => Error::Ssh(format!("SSH handshake with {}:{} failed: {e}", target.host, target.port)),
            })
        }
    }
}

/// Read the router's host key without trusting it; disconnects before any
/// authentication, so no password is sent.
pub async fn fetch_host_key(target: &SshTarget) -> Result<HostKeyInfo> {
    let mut probe = target.clone();
    probe.host_key = None;
    match handshake(&probe).await {
        Err(Error::HostKeyUnknown { got, algorithm }) => Ok(HostKeyInfo { algorithm, sha256: got }),
        Err(e) => Err(e),
        Ok(_) => Err(Error::Ssh("the server accepted no host key check".into())),
    }
}

/// What the UI sends to a shell.
#[derive(Debug)]
pub enum ShellInput {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

/// What a shell sends back.
#[derive(Debug)]
pub enum ShellOutput {
    Data(Vec<u8>),
    /// the session ended; `Some` with a reason when it was not a normal exit
    Closed(Option<String>),
}

/// An authenticated SSH session with an interactive shell on a PTY.
pub struct Shell {
    handle: client::Handle<Checker>,
    channel: russh::Channel<client::Msg>,
}

impl Shell {
    /// Connect, verify the pinned host key, log in with the password and open
    /// a `xterm-256color` shell of `cols`×`rows`.
    pub async fn open(target: &SshTarget, cols: u32, rows: u32) -> Result<Shell> {
        if target.host_key.is_none() {
            // never send a password to a host whose key nobody has accepted
            let key = fetch_host_key(target).await?;
            return Err(Error::HostKeyUnknown { got: key.sha256, algorithm: key.algorithm });
        }
        let mut handle = handshake(target).await?;
        let auth = handle
            .authenticate_password(target.username.clone(), target.password.clone())
            .await
            .map_err(|e| Error::Ssh(format!("SSH login failed: {e}")))?;
        if !auth.success() {
            return Err(Error::SshAuth { user: target.username.clone() });
        }
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| Error::Ssh(format!("cannot open an SSH session: {e}")))?;
        channel
            .request_pty(false, "xterm-256color", cols.max(20), rows.max(5), 0, 0, &[])
            .await
            .map_err(|e| Error::Ssh(format!("cannot get a terminal: {e}")))?;
        channel
            .request_shell(false)
            .await
            .map_err(|e| Error::Ssh(format!("cannot start the shell: {e}")))?;
        Ok(Shell { handle, channel })
    }

    /// Pump the shell until it ends or `Close` arrives: router output goes to
    /// `output`, `input` goes to the router.
    pub async fn run(mut self, mut input: mpsc::UnboundedReceiver<ShellInput>, mut output: impl FnMut(ShellOutput)) {
        let reason = loop {
            tokio::select! {
                msg = self.channel.wait() => match msg {
                    Some(ChannelMsg::Data { data }) => output(ShellOutput::Data(data.to_vec())),
                    Some(ChannelMsg::ExtendedData { data, .. }) => output(ShellOutput::Data(data.to_vec())),
                    Some(ChannelMsg::ExitStatus { exit_status }) if exit_status != 0 => {
                        break Some(format!("the shell exited with status {exit_status}"));
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break None,
                    Some(_) => {}
                },
                cmd = input.recv() => match cmd {
                    Some(ShellInput::Data(bytes)) => {
                        if let Err(e) = self.channel.data(&bytes[..]).await {
                            break Some(format!("cannot write to the router: {e}"));
                        }
                    }
                    Some(ShellInput::Resize { cols, rows }) => {
                        let _ = self.channel.window_change(cols.max(20), rows.max(5), 0, 0).await;
                    }
                    Some(ShellInput::Close) | None => {
                        let _ = self.channel.close().await;
                        break None;
                    }
                },
            }
        };
        let _ = self
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
        output(ShellOutput::Closed(reason));
    }
}
