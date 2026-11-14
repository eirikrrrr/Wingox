//! The router's own menu tree, read with `/console/inspect` (RouterOS 7): the
//! same tree the console and WinBox show, so the app offers exactly the menus
//! this device has — for its version and its installed packages — instead of a
//! fixed list.
//!
//! `console/inspect request=child path=ip,address` lists a menu's children:
//! sub-menus (`dir`/`path`) and commands (`cmd`: print, add, set, remove…).
//! There is no recursive request, so the tree is walked level by level: about
//! 450 requests on a CHR 7.23, ~12 s. Callers cache the result.

use futures_util::stream::{self, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};

use super::rest::RestClient;
use crate::error::{Error, Result};

/// One menu of the tree: its path (`ip/dhcp-server/lease`) and its commands.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MenuNode {
    pub path: String,
    pub cmds: Vec<String>,
}

/// Requests in flight at once. The router answers them nearly one at a time
/// anyway; a few in flight hide the round trip (and a proxy's).
const IN_FLIGHT: usize = 4;

/// The children of one menu: (sub-menus, commands).
async fn children(client: &RestClient, path: &[String]) -> Result<(Vec<String>, Vec<String>)> {
    let answer = client
        .post("console/inspect", &json!({ "request": "child", "path": path.join(",") }))
        .await?;
    let Value::Array(items) = answer else {
        return Err(Error::Other("console/inspect did not answer a list".into()));
    };
    let (mut dirs, mut cmds) = (Vec::new(), Vec::new());
    for item in items {
        if item.get("type").and_then(Value::as_str) != Some("child") {
            continue;
        }
        let Some(name) = item.get("name").and_then(Value::as_str) else { continue };
        match item.get("node-type").and_then(Value::as_str) {
            Some("dir" | "path") => dirs.push(name.to_string()),
            Some("cmd") => cmds.push(name.to_string()),
            _ => {}
        }
    }
    dirs.sort();
    cmds.sort();
    Ok((dirs, cmds))
}

/// Walk the whole menu tree. The root must answer (otherwise the router cannot
/// be inspected: RouterOS 6, or a user without the rights); a sub-menu that
/// fails is skipped, not fatal. Sorted by path.
pub async fn menu_tree(client: &RestClient) -> Result<Vec<MenuNode>> {
    let (root_dirs, _) = children(client, &[]).await?;
    let mut nodes = Vec::new();
    let mut level: Vec<Vec<String>> = root_dirs.into_iter().map(|d| vec![d]).collect();
    while !level.is_empty() {
        let answers: Vec<_> = stream::iter(level)
            .map(|path| async move {
                let kids = children(client, &path).await;
                (path, kids)
            })
            .buffer_unordered(IN_FLIGHT)
            .collect()
            .await;
        let mut next = Vec::new();
        for (path, kids) in answers {
            let Ok((dirs, cmds)) = kids else { continue };
            for d in dirs {
                let mut child = path.clone();
                child.push(d);
                next.push(child);
            }
            nodes.push(MenuNode { path: path.join("/"), cmds });
        }
        level = next;
    }
    nodes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(nodes)
}
