//! Generated browser behavior, decoded once on demand.
use crate::Error;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Spec {
    pub agent_tab_limit: usize,
    pub server_tab_limit: usize,
    pub agent_tab_idle_ms: u64,
    pub scripts: Scripts,
    pub viewport_limits: serde_json::Value,
    pub editing_commands: std::collections::HashMap<String, serde_json::Value>,
    pub error_templates: std::collections::HashMap<String, String>,
    pub non_web_schemes: Vec<String>,
    pub keys: std::collections::HashMap<String, serde_json::Value>,
    pub version: String,
    pub staging_stale_after_ms: u64,
    pub screencast_ack_pace_ms: u64,
    pub profiles: Vec<serde_json::Value>,
    pub presets: Vec<serde_json::Value>,
    pub platforms: std::collections::HashMap<String, String>,
    pub archives: std::collections::HashMap<String, Archive>,
    pub tab_args: Vec<String>,
    pub persistent_args: Vec<String>,
    /// Chrome's user agent per Node platform (`darwin`, `linux`, `win32`), for `__USER_AGENT__`.
    pub user_agents: std::collections::HashMap<String, String>,
    pub html: HtmlSpec,
    pub root_error: String,
}
#[derive(Debug, Deserialize)]
pub(crate) struct Scripts {
    pub snapshot: String,
    pub sensitive: String,
    pub dotted: String,
    pub mask: String,
    pub recorders: std::collections::HashMap<String, String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HtmlSpec {
    pub max_concurrent_browsers: usize,
    pub args: Vec<String>,
    pub unsandboxed_args: Vec<String>,
    pub fake_ip_template: String,
    pub default_width: u64,
    pub fragments: std::collections::HashMap<String, String>,
    pub settle: String,
    pub measure: String,
}
#[derive(Debug, Deserialize)]
pub(crate) struct Archive {
    pub bytes: u64,
    pub sha256: String,
}

pub(crate) fn spec() -> Result<&'static Spec, Error> {
    static SPEC: std::sync::OnceLock<Result<Spec, Error>> = std::sync::OnceLock::new();
    SPEC.get_or_init(|| serde_json::from_str(include_str!("spec.json")).map_err(crate::err))
        .as_ref()
        .map_err(Clone::clone)
}
