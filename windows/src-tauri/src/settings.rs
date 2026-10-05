// Preferences, stored as plain JSON in %APPDATA%\Coucou\settings.json.
// No secret ever lands here — API keys live in the Windows Credential Manager.
// A side instance (COUCOU_INSTANCE, see instance.rs) uses Coucou-<instance>
// for both folders below instead.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    pub hooks_installed: bool,
    /// Claude model used by the chat. Changeable in the settings window.
    /// Defaulted explicitly so a settings.json written by an older build still loads.
    #[serde(default = "default_model")]
    pub model: String,
    /// Where the island sits along the top edge: its centre as a fraction of the
    /// display's width (0.5 = centred). None until the island is first dragged.
    /// Only the drag writes it — `save_settings` keeps whatever is stored, so a
    /// window holding an older copy of the settings can never move the island.
    #[serde(default)]
    pub island_x: Option<f64>,
    /// Who answers the island's chat: "claude-code" — the `claude` CLI on this
    /// PC, with its own login (chat_cc.rs, D-016) — or "api", the Anthropic API
    /// with the key in the Credential Manager (claude.rs).
    #[serde(default = "default_chat_engine")]
    pub chat_engine: String,
    /// Claude Code's working folder for the chat: the "hub", whose CLAUDE.md
    /// describes the user's projects.
    #[serde(default = "default_chat_hub")]
    pub chat_hub: String,
    /// Folders the chat may read besides the hub (`--add-dir`).
    #[serde(default = "default_chat_dirs")]
    pub chat_dirs: Vec<String>,
    /// `--model` for the Claude Code chat; empty = whatever the account uses.
    #[serde(default)]
    pub chat_model: String,
}

fn default_model() -> String {
    crate::claude::DEFAULT_MODEL.to_string()
}

fn default_chat_engine() -> String {
    "claude-code".into()
}

/// `%USERPROFILE%\Documents\GitHub`, where the user's repositories live.
fn github_dir() -> PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join("Documents").join("GitHub")
}

fn default_chat_hub() -> String {
    github_dir().join("hub").to_string_lossy().into_owned()
}

fn default_chat_dirs() -> Vec<String> {
    vec![github_dir().to_string_lossy().into_owned()]
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            absence_interval: 180.0,
            // None by default in this fork: the island's right card belongs to
            // the other Claude Code sessions, and an integration is opted into
            // in Settings. Must match DEFAULT_SETTINGS in src/core/state.ts.
            active_integrations: vec![],
            screen: "primary".into(),
            autostart: false,
            hooks_installed: false,
            model: default_model(),
            island_x: None,
            chat_engine: default_chat_engine(),
            chat_hub: default_chat_hub(),
            chat_dirs: default_chat_dirs(),
            chat_model: String::new(),
        }
    }
}

/// `Coucou`, or `Coucou-<instance>` for a side instance (see instance.rs).
fn folder_name() -> String {
    format!("Coucou{}", crate::instance::suffix('-'))
}

/// %APPDATA%\Coucou
pub fn config_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join(folder_name())
}

/// %LOCALAPPDATA%\Coucou — where coucou-hook.exe and the log live.
pub fn local_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join(folder_name())
}

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join("coucou-hook.exe")
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}
