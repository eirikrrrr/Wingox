//! Saved workspaces: which devices were open, each tab's pane layout, the
//! active tab and the detached windows with their place on screen — so a set of
//! sessions can be reopened as it was. Kept as JSON documents (each with an
//! `id`) in workspaces.json in the app's config directory; the frontend owns
//! their shape. Never holds secrets: a tab refers to a saved profile by id.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Manager};

fn file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("workspaces.json"))
}

pub fn load(app: &AppHandle) -> Result<Vec<Value>, String> {
    let path = file(app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn id_of(v: &Value) -> Option<&str> {
    v.get("id").and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn save_all(app: &AppHandle, list: &[Value]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(file(app)?, text).map_err(|e| e.to_string())
}

/// insert or replace (by `id`)
pub fn upsert(app: &AppHandle, workspace: Value) -> Result<Value, String> {
    let id = id_of(&workspace).ok_or("a workspace needs an id")?.to_string();
    let mut list = load(app)?;
    match list.iter_mut().find(|w| id_of(w) == Some(id.as_str())) {
        Some(existing) => *existing = workspace.clone(),
        None => list.push(workspace.clone()),
    }
    save_all(app, &list)?;
    Ok(workspace)
}

pub fn delete(app: &AppHandle, id: &str) -> Result<(), String> {
    let mut list = load(app)?;
    list.retain(|w| id_of(w) != Some(id));
    save_all(app, &list)
}
