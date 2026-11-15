//! Profile secrets (the RouterOS password and the proxy password) in the OS
//! keychain — Windows Credential Manager, macOS Keychain, Secret Service on
//! Linux — instead of profiles.json.
//!
//! Nothing is ever dropped on a hunch: a secret leaves the JSON file only after
//! it was written to the keychain *and read back identical*. If the keychain is
//! unavailable (no Secret Service running, a locked keychain…), the secret
//! stays in the file as before and the profile keeps working.

use keyring::Entry;

const SERVICE: &str = "wingox";

/// which secret of a profile
#[derive(Clone, Copy)]
pub enum Kind {
    Password,
    ProxyPassword,
}

fn entry(profile_id: &str, kind: Kind) -> keyring::Result<Entry> {
    let what = match kind {
        Kind::Password => "password",
        Kind::ProxyPassword => "proxy-password",
    };
    Entry::new(SERVICE, &format!("profile:{profile_id}:{what}"))
}

/// Store a secret and check it reads back the same. An empty secret removes
/// the entry. `true` = it is safely in the keychain.
pub fn put(profile_id: &str, kind: Kind, secret: &str) -> bool {
    let Ok(e) = entry(profile_id, kind) else { return false };
    if secret.is_empty() {
        return match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => true,
            Err(_) => false,
        };
    }
    e.set_password(secret).is_ok() && e.get_password().map(|got| got == secret).unwrap_or(false)
}

/// A stored secret; `None` when there is none (or the keychain cannot be read).
pub fn get(profile_id: &str, kind: Kind) -> Option<String> {
    entry(profile_id, kind).ok()?.get_password().ok()
}

/// Forget a profile's secrets (the profile was deleted).
pub fn forget(profile_id: &str) {
    for kind in [Kind::Password, Kind::ProxyPassword] {
        if let Ok(e) = entry(profile_id, kind) {
            let _ = e.delete_credential();
        }
    }
}
