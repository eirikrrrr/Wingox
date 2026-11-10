//! The user's local preferences (appearance, terminal, behaviour,
//! notifications), as one JSON document in the app's config directory. The
//! frontend owns the shape and its defaults; this only stores it, so adding a
//! preference needs no backend change. Saving tells every Wingox window, so a
//! detached window follows a change at once.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

fn file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

/// the saved preferences, or `{}` when there are none yet (or the file is unreadable)
pub fn load(app: &AppHandle) -> Result<Value, String> {
    let path = file(app)?;
    if !path.exists() {
        return Ok(Value::Object(Default::default()));
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str(&text).unwrap_or_else(|_| Value::Object(Default::default())))
}

pub fn save(app: &AppHandle, settings: Value) -> Result<(), String> {
    if !settings.is_object() {
        return Err("settings must be a JSON object".into());
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(file(app)?, text).map_err(|e| e.to_string())?;
    // every window (main and detached) applies the change
    let _ = app.emit("wingox-settings", settings);
    Ok(())
}
