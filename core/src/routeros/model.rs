//! A few typed views over RouterOS REST responses — enough for the MVP. REST
//! keys are kebab-case; most scalar values come back as strings.

use serde::Deserialize;

/// `GET /rest/system/resource`
#[derive(Debug, Clone, Deserialize)]
pub struct SystemResource {
    #[serde(default)]
    pub version: String,
    #[serde(rename = "board-name", default)]
    pub board_name: String,
    #[serde(rename = "architecture-name", default)]
    pub architecture: String,
    #[serde(rename = "cpu-load", default)]
    pub cpu_load: String,
    #[serde(default)]
    pub uptime: String,
    #[serde(rename = "free-memory", default)]
    pub free_memory: String,
    #[serde(rename = "total-memory", default)]
    pub total_memory: String,
}

/// `GET /rest/system/identity`
#[derive(Debug, Clone, Deserialize)]
pub struct Identity {
    #[serde(default)]
    pub name: String,
}
