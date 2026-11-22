//! How `codex app-server` starts and what the requests that shape a turn carry. Mirrors
//! `codexLaunchArgs.ts`, `codexAppServerEnvironment`, `buildCodexInitializeParams`,
//! `codexThreadRuntimeParams` and `buildCodexTurnStartParams`; see `PROTOCOL.md`.
//!
//! No auth is set here. In an Orbit container the inherited environment and `config.toml`
//! point Codex at the AI router.

use std::path::{Path, PathBuf};

use conn_contract::{ChatAttachment, ModelSelection, to_json};
use conn_provider::{McpServer, RuntimePolicy};
use conn_provider_support::instance::{self, InstanceEnv, InstanceEnvelope};
use conn_provider_support::{attachments, process::LaunchSpec};

use crate::context::{ToolAvailability, additional_context};
use serde_json::{Value, json};

/// `CODEX_CLIENT_NAME` in `CodexProvider.ts`. The backend tailors the model catalog to it.
pub const CLIENT_NAME: &str = "T3 Code";
/// Tells the Codex backend which client this is; it tailors the model catalog to it.
pub const ORIGINATOR_ENV: &str = "CODEX_INTERNAL_ORIGINATOR_OVERRIDE";
/// Launch args from the environment win over the instance setting (`resolveCodexLaunchArgs`).
pub const LAUNCH_ARGS_ENV: &str = "T3CODE_CODEX_LAUNCH_ARGS";
/// `PortScanner.AGENT_THREAD_ENV`, set per thread through shell config, not the process env.
pub const AGENT_THREAD_ENV: &str = "T3CODE_THREAD_ID";
/// The `version` sent in `initialize`: the T3 server sends its own package version, so this is
/// the pinned `apps/server` version, the one Conn Server reports as its server version.
pub const CLIENT_VERSION: &str = conn_contract::T3_SERVER_VERSION;

/// T3's `CODEX_STOP_CONFIRM_TIMEOUT_MS`.
pub const STOP_CONFIRM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// The Codex instance's settings that shape a launch (`CodexSettings` in contracts).
#[derive(Clone, Debug)]
pub struct CodexConfig {
    /// `binaryPath`. Default `codex`, resolved on PATH.
    pub binary: PathBuf,
    /// `homePath`: a custom `CODEX_HOME`. `None` keeps the inherited one.
    pub home_path: Option<PathBuf>,
    /// `launchArgs`, split like a shell.
    pub launch_args: String,
    /// The provider instance's own environment entries. Values may be secrets; its `Debug`
    /// prints names only.
    pub instance_env: InstanceEnv,
    /// T3's attachment store (`<state>/attachments`): attachments are read from
    /// `<dir>/<id><ext>`. `None`: attachments are listed as unavailable.
    pub attachments_dir: Option<PathBuf>,
    /// How long Stop waits for Codex to end the turn before it reports an interrupt timeout
    /// (T3's `CODEX_STOP_CONFIRM_TIMEOUT_MS`, 10 s). Tests shorten it.
    pub stop_confirm_timeout: std::time::Duration,
    /// How long the session waits for the answer to a `turn/start` that Stop abandoned after
    /// it was written (the request's own limit, 60 s). Tests shorten it.
    pub abandoned_start_timeout: std::time::Duration,
    /// Whether the status probe runs (`checkCodexProviderStatus`). Checks turn it off, so no
    /// check runs this machine's `codex`; the entry then stays T3's pending one.
    pub status_probe: bool,
    /// The folder the probe runs in: the server's working folder (T3's `process.cwd()`).
    /// `None`: this process's working folder.
    pub status_cwd: Option<PathBuf>,
}

impl Default for CodexConfig {
    fn default() -> Self {
        Self {
            binary: PathBuf::from("codex"),
            home_path: None,
            launch_args: String::new(),
            instance_env: InstanceEnv::default(),
            attachments_dir: None,
            stop_confirm_timeout: STOP_CONFIRM_TIMEOUT,
            abandoned_start_timeout: crate::client::REQUEST_TIMEOUT,
            status_probe: true,
            status_cwd: None,
        }
    }
}

impl CodexConfig {
    /// This configuration with the instance's `providerInstances[id]` entry applied, as the
    /// T3 server's Codex driver builds its adapter (`CodexDriver.ts` 188-221,
    /// `resolveCodexHomeLayout`): `binaryPath` trimmed with `~` expanded (`codex` when empty);
    /// `homePath`, or else a `CODEX_HOME` the instance or the server sets, expanded and made
    /// absolute; the instance environment; `launchArgs` trimmed. `None`: the defaults.
    #[must_use]
    pub fn with_instance(mut self, entry: Option<&Value>) -> Self {
        let envelope = InstanceEnvelope::parse(entry, true);
        self.binary = envelope.config_str("binaryPath").map_or_else(
            || PathBuf::from("codex"),
            |b| PathBuf::from(instance::expand_home(&b)),
        );
        let home = envelope.config_str("homePath").or_else(|| {
            envelope
                .environment
                .get("CODEX_HOME")
                .map(str::to_owned)
                .or_else(|| {
                    conn_support::login_env::var_os("CODEX_HOME")
                        .map(|h| h.to_string_lossy().into_owned())
                })
                .filter(|h| !h.trim().is_empty())
        });
        self.home_path = home.map(|h| absolute(&instance::expand_home(&h)));
        self.launch_args = envelope.config_str("launchArgs").unwrap_or_default();
        self.instance_env = envelope.environment;
        self
    }

    /// `resolveCodexLaunchArgs`: `T3CODE_CODEX_LAUNCH_ARGS` from the instance's environment
    /// over the server's (`mergeProviderInstanceEnvironment`), else the setting.
    pub fn launch_args_env(&self) -> Option<String> {
        self.instance_env
            .get(LAUNCH_ARGS_ENV)
            .map(str::to_owned)
            .or_else(|| std::env::var(LAUNCH_ARGS_ENV).ok())
    }

    /// The configured binary when it exists: a path is checked as is, a bare name on `PATH`.
    pub fn find_binary(&self) -> Option<PathBuf> {
        find_executable(
            &self.binary,
            conn_support::login_env::var_os("PATH").as_deref(),
        )
    }

    /// `CODEX_HOME` as the CLI will see it: the setting, the inherited variable, `~/.codex`.
    pub fn effective_home(&self) -> Option<PathBuf> {
        self.home_path
            .clone()
            .or_else(|| {
                self.instance_env
                    .iter()
                    .find(|(k, _)| k == "CODEX_HOME")
                    .map(|(_, v)| PathBuf::from(v))
            })
            .or_else(|| std::env::var_os("CODEX_HOME").map(PathBuf::from))
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".codex")))
    }
}

/// `path.resolve` against the server's working folder.
fn absolute(path: &str) -> PathBuf {
    let joined = std::env::current_dir().unwrap_or_default().join(path);
    let mut out = PathBuf::new();
    for part in joined.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

pub fn find_executable(binary: &Path, path_var: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let binary = expand_home(binary);
    if binary.components().count() > 1 {
        return is_executable(&binary).then_some(binary);
    }
    std::env::split_paths(path_var?)
        .map(|dir| dir.join(&binary))
        .find(|candidate| is_executable(candidate))
}

/// A file the process may run: on Unix, a file with an execute bit, as a `PATH` search
/// skips the rest.
fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        metadata.is_file()
    }
}

pub(crate) fn expand_home(path: &Path) -> PathBuf {
    match (path.strip_prefix("~"), std::env::var_os("HOME")) {
        (Ok(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => path.to_path_buf(),
    }
}

/// argv and environment for one app-server, given the launch-args variable as read from the
/// host environment.
pub fn launch_spec(
    config: &CodexConfig,
    launch_args_env: Option<&str>,
    host_has_originator: bool,
) -> LaunchSpec {
    let launch_args = launch_args_env
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(config.launch_args.trim());
    let mut args: Vec<String> = ["app-server", "-c", "thread_unload_delay_secs=0"]
        .map(String::from)
        .into();
    args.extend(tokenize_cli_args(launch_args));
    // `codexAppServerEnvironment`: the originator comes first, so the host or instance
    // environment can override it.
    let mut env_set = Vec::new();
    if !host_has_originator {
        env_set.push((ORIGINATOR_ENV.to_owned(), CLIENT_NAME.to_owned()));
    }
    env_set.extend(config.instance_env.iter().cloned());
    if let Some(home) = &config.home_path {
        env_set.push((
            "CODEX_HOME".to_owned(),
            expand_home(home).to_string_lossy().into_owned(),
        ));
    }
    LaunchSpec {
        program: expand_home(&config.binary),
        args,
        cwd: None,
        env_remove: Vec::new(),
        env_set,
    }
}

/// `tokenizeCliArgs` in `packages/shared/src/cliArgs.ts`.
pub fn tokenize_cli_args(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut quoted = false;
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
                quoted = true;
            } else if c == '\\' && q == '"' {
                match chars.peek() {
                    Some(&n) if matches!(n, '"' | '\\' | '$' | '`') => {
                        current.push(n);
                        chars.next();
                    }
                    _ => current.push(c),
                }
            } else {
                current.push(c);
            }
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
            quoted = true;
        } else if c.is_whitespace() {
            if !current.is_empty() || quoted {
                tokens.push(std::mem::take(&mut current));
                quoted = false;
            }
        } else if c == '\\' {
            match chars.peek() {
                Some(&n) if n.is_whitespace() || n == '\'' || n == '"' => {
                    current.push(n);
                    chars.next();
                }
                _ => current.push(c),
            }
        } else {
            current.push(c);
        }
    }
    if !current.is_empty() || quoted {
        tokens.push(current);
    }
    tokens
}

pub fn initialize_params() -> Value {
    json!({
        "clientInfo": {"name": CLIENT_NAME, "title": CLIENT_NAME, "version": CLIENT_VERSION},
        "capabilities": {
            "experimentalApi": true,
            "optOutNotificationMethods": ["turn/diff/updated"],
            "extensions": {
                "io.modelcontextprotocol/ui": {"mimeTypes": ["text/html;profile=mcp-app"]}
            },
        },
    })
}

/// T3 waits can block for an hour; Codex's own MCP timeout must stay above that.
const MCP_TOOL_TIMEOUT_SECS: u64 = 65 * 60;

/// `CODEX_THREAD_CONFIG`, the per-thread shell variable, and the session's MCP servers.
fn thread_config(app_thread_id: Option<&str>, mcp: &[McpServer]) -> Value {
    let mut config = json!({
        "tools.update_plan.enabled": true,
        "mcp_optional_startup_grace_ms": 10_000,
        "features.concurrent_reasoning_summaries": true,
    });
    if let Some(thread_id) = app_thread_id {
        config[format!("shell_environment_policy.set.{AGENT_THREAD_ENV}")] = json!(thread_id);
    }
    for (key, value) in mcp.iter().flat_map(mcp_server_config) {
        config[key] = value;
    }
    config
}

/// `CODEX_DIRECT_ONLY_T3_TOOLS`: Code Mode runs a blocking wait or delegate wait as a nested
/// call, and the model keeps polling it; the direct-only server makes it a plain tool call.
const DIRECT_ONLY_TOOLS: [&str; 2] = ["conn_thread_wait", "delegate_task"];

/// `mcp_servers.<name>` overrides for one server, as `codexThreadRuntimeParams` builds them.
/// T3's own server (`conn`) splits in two: [`DIRECT_ONLY_TOOLS`] go on a direct-only
/// server, out of code mode, so a wait never runs inside a script.
fn mcp_server_config(server: &McpServer) -> Vec<(String, Value)> {
    let entry = |extra: Value| {
        let mut entry = json!({
            "url": server.url,
            "tool_timeout_sec": MCP_TOOL_TIMEOUT_SECS,
            "http_headers": server
                .headers
                .iter()
                .map(|(k, v)| (k.clone(), json!(v)))
                .collect::<serde_json::Map<String, Value>>(),
        });
        if let (Some(entry), Value::Object(extra)) = (entry.as_object_mut(), extra) {
            entry.extend(extra);
        }
        entry
    };
    let name = &server.name;
    if name != "conn" {
        return vec![(format!("mcp_servers.{name}"), entry(json!({})))];
    }
    vec![
        (
            format!("mcp_servers.{name}"),
            entry(json!({ "disabled_tools": DIRECT_ONLY_TOOLS })),
        ),
        (
            format!("mcp_servers.{name}-direct"),
            entry(json!({
                "enabled_tools": DIRECT_ONLY_TOOLS,
                "omit_tools_from": ["code_mode", "deferred"],
            })),
        ),
    ]
}

/// `thread/start` and `thread/resume` share these (`codexThreadRuntimeParams`).
pub fn thread_params(
    app_thread_id: Option<&str>,
    cwd: Option<&str>,
    model: Option<&str>,
    mcp: &[McpServer],
) -> Value {
    let mut params = json!({ "config": thread_config(app_thread_id, mcp) });
    if let Some(cwd) = cwd {
        params["cwd"] = json!(cwd);
    }
    if let Some(model) = model {
        params["model"] = json!(model);
    }
    params
}

/// `codexRuntimeModeTurnDefaults`: approval policy, reviewer, sandbox.
pub fn runtime_mode_defaults(runtime_mode: &str) -> (Value, &'static str, Value) {
    match runtime_mode {
        "approval-required" => (json!("untrusted"), "user", json!({"type": "readOnly"})),
        "auto-accept-edits" => (
            json!("on-request"),
            "user",
            json!({"type": "workspaceWrite"}),
        ),
        "auto" => (
            json!("on-request"),
            "auto_review",
            json!({"type": "workspaceWrite"}),
        ),
        // `never` also rejects browser and app access prompts before the client sees them.
        _ => (
            json!({"granular": {
                "mcp_elicitations": true,
                "request_permissions": false,
                "rules": false,
                "sandbox_approval": false,
                "skill_approval": false,
            }}),
            "user",
            json!({"type": "dangerFullAccess"}),
        ),
    }
}

/// `V2TurnStartParams__SandboxPolicy` as the TS adapter decodes an override: the fields of
/// the policy's own type, the rest dropped. An unknown type passes as is (Codex rejects it).
fn decode_sandbox_policy(policy: &Value) -> Value {
    let keys: &[&str] = match policy["type"].as_str() {
        Some("dangerFullAccess") => &["type"],
        Some("readOnly") | Some("externalSandbox") => &["networkAccess", "type"],
        Some("workspaceWrite") => &[
            "excludeSlashTmp",
            "excludeTmpdirEnvVar",
            "networkAccess",
            "type",
            "writableRoots",
        ],
        _ => return policy.clone(),
    };
    let Some(object) = policy.as_object() else {
        return policy.clone();
    };
    Value::Object(
        object
            .iter()
            .filter(|(k, _)| keys.contains(&k.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    )
}

/// A string option on a model selection (`getModelSelectionStringOptionValue`).
pub fn selection_option(selection: &ModelSelection, id: &str) -> Option<String> {
    to_json(selection)["options"]
        .as_array()?
        .iter()
        .find(|o| o["id"] == id)
        .and_then(|o| o["value"].as_str())
        .filter(|v| !v.trim().is_empty())
        .map(str::to_owned)
}

fn selection_bool(selection: &ModelSelection, id: &str) -> Option<bool> {
    to_json(selection)["options"]
        .as_array()?
        .iter()
        .find(|o| o["id"] == id)
        .and_then(|o| o["value"].as_bool())
}

pub fn selection_model(selection: &ModelSelection) -> String {
    to_json(selection)["model"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

/// `normalizeCodexThreadLoadModelSelection`: Codex applies the effort on `turn/start`, so an
/// effort change alone does not reload the thread. The other options stay; none left drops
/// `options`.
pub fn thread_load_selection(selection: &ModelSelection) -> ModelSelection {
    let mut value = to_json(selection);
    if let Some(object) = value.as_object_mut() {
        let kept: Option<Vec<Value>> = object.get("options").and_then(Value::as_array).map(|o| {
            o.iter()
                .filter(|option| option["id"] != "reasoningEffort")
                .cloned()
                .collect()
        });
        match kept {
            Some(kept) if !kept.is_empty() => {
                object.insert("options".into(), Value::Array(kept));
            }
            _ => {
                object.remove("options");
            }
        }
    }
    conn_contract::from_json(value).unwrap_or_else(|_| selection.clone())
}

/// `turn/start` params (`buildCodexTurnStartParams`), without Cyber Access and app context.
/// `t3_tools` is set when the thread has T3's MCP server: the turn then carries T3's
/// `additionalContext`.
pub fn turn_start_params(
    native_thread_id: &str,
    input: Value,
    policy: &RuntimePolicy,
    selection: &ModelSelection,
    configured_summary: Option<&str>,
    t3_tools: Option<ToolAvailability>,
    app_context: &[conn_provider::AppContextEntry],
) -> Value {
    let runtime_mode = to_json(&policy.runtime_mode);
    let interaction_mode = to_json(&policy.interaction_mode);
    let (approval, reviewer, sandbox) =
        runtime_mode_defaults(runtime_mode.as_str().unwrap_or("full-access"));
    let approval = policy.approval_policy.clone().unwrap_or(approval);
    let sandbox = policy
        .sandbox_policy
        .as_ref()
        .map(decode_sandbox_policy)
        .unwrap_or(sandbox);
    let model = selection_model(selection);
    let effort = selection_option(selection, "reasoningEffort").or_else(|| {
        model
            .starts_with("gpt-6-astra")
            .then(|| "medium".to_owned())
    });
    let service_tier = selection_option(selection, "serviceTier").or_else(|| {
        (selection_bool(selection, "fastMode") == Some(true)).then(|| "fast".to_owned())
    });
    let mut settings = json!({ "model": model });
    if let Some(effort) = &effort {
        settings["reasoning_effort"] = json!(effort);
    }
    let mut params = json!({
        "threadId": native_thread_id,
        "input": input,
        "cwd": policy.cwd,
        "model": model,
        "summary": configured_summary.unwrap_or("auto"),
        "approvalsReviewer": reviewer,
        "approvalPolicy": approval,
        "sandboxPolicy": sandbox,
        "collaborationMode": {"mode": interaction_mode, "settings": settings},
    });
    // T3's context, then MCP app context as quoted user input (`kind: untrusted`).
    let mut context = t3_tools
        .map(|tools| additional_context(&model, effort.as_deref(), tools))
        .and_then(|c| c.as_object().cloned())
        .unwrap_or_default();
    for entry in app_context {
        context.insert(
            entry.key.clone(),
            json!({"kind": "untrusted", "value": entry.text}),
        );
    }
    if !context.is_empty() {
        params["additionalContext"] = Value::Object(context);
    }
    if let Some(effort) = effort {
        params["effort"] = json!(effort);
    }
    if let Some(tier) = service_tier {
        params["serviceTier"] = json!(tier);
    }
    params
}

/// The user input for `turn/start` and `turn/steer` (`toCodexInput`): the text, with a skill
/// typed with any currency sigil rewritten to `$name` (`codexSkillMentionText`) and a line per
/// attachment with its saved path; then each image a provider takes inline, as a data URL.
/// Errors are the TS adapter's protocol errors, safe to show.
pub fn user_input(
    text: &str,
    attachments: &[ChatAttachment],
    attachments_dir: Option<&Path>,
) -> Result<Value, String> {
    let attachments: Vec<Value> = attachments.iter().map(to_json).collect();
    let text = attachments::prompt_text(&skill_mention_text(text), &attachments, attachments_dir);
    let mut items = Vec::new();
    if !text.is_empty() {
        items.push(json!({ "type": "text", "text": text }));
    }
    for attachment in attachments
        .iter()
        .filter(|a| attachments::is_native_image(a))
    {
        let id = attachment["id"].as_str().unwrap_or_default();
        let path = attachments::saved_path(attachments_dir, attachment)
            .ok_or_else(|| format!("Invalid attachment id '{id}'"))?;
        let bytes =
            std::fs::read(&path).map_err(|_| format!("Failed to read attachment '{id}'."))?;
        let mime = attachment["mimeType"].as_str().unwrap_or_default();
        items.push(json!({
            "type": "image",
            "url": format!("data:{mime};base64,{}", conn_support::base64::encode(&bytes)),
        }));
    }
    if items.is_empty() {
        return Err("Turn requires non-empty text or attachments.".into());
    }
    Ok(Value::Array(items))
}

/// `SKILL_MENTION_PATTERN` (`composerInlineTokens.ts`): a whole word made of a currency sigil
/// and a skill name that holds a letter and is not an amount such as `5k`.
fn skill_mention_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut word_start = 0;
    for (i, c) in text.char_indices().chain([(text.len(), ' ')]) {
        if !c.is_whitespace() {
            continue;
        }
        let word = &text[word_start..i];
        match word.chars().next() {
            Some(sigil) if is_currency(sigil) && is_skill_name(&word[sigil.len_utf8()..]) => {
                out.push('$');
                out.push_str(&word[sigil.len_utf8()..]);
            }
            _ => out.push_str(word),
        }
        if i < text.len() {
            out.push(c);
        }
        word_start = i + c.len_utf8();
    }
    out
}

fn is_currency(c: char) -> bool {
    matches!(
        c,
        '$' | '€'
            | '£'
            | '¥'
            | '¢'
            | '₹'
            | '₩'
            | '₽'
            | '₺'
            | '₴'
            | '₦'
            | '₪'
            | '฿'
            | '₫'
            | '₱'
            | '₡'
            | '₲'
            | '₵'
            | '₸'
            | '₼'
            | '₾'
            | '₿'
    )
}

fn is_skill_name(name: &str) -> bool {
    let valid = name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-'))
        && name.chars().any(|c| c.is_ascii_alphabetic());
    valid && !is_amount(name)
}

/// `[0-9][0-9_]*` with an optional `k`/`m`/`b`/`t` or `e<digits>` suffix.
fn is_amount(name: &str) -> bool {
    let digits = name.trim_start_matches(|c: char| c.is_ascii_digit() || c == '_');
    if !name.starts_with(|c: char| c.is_ascii_digit()) {
        return false;
    }
    digits.is_empty()
        || matches!(digits, "k" | "K" | "m" | "M" | "b" | "B" | "t" | "T")
        || (digits.len() > 1
            && digits.starts_with(['e', 'E'])
            && digits[1..].chars().all(|c| c.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_instance_entry_shapes_the_launch() {
        let home = std::env::var("HOME").unwrap_or_default();
        let entry = json!({
            "driver": "codex",
            "config": {"binaryPath": "  ~/bin/codex ", "homePath": "~/codex-work/./x/..", "launchArgs": " --enable a "},
            "environment": [
                {"name": "SECRET", "value": "s3cret", "sensitive": true},
                {"name": "T3CODE_CODEX_LAUNCH_ARGS", "value": "--enable b"},
            ],
        });
        let config = CodexConfig::default().with_instance(Some(&entry));
        assert_eq!(config.binary, PathBuf::from(format!("{home}/bin/codex")));
        assert_eq!(
            config.home_path,
            Some(PathBuf::from(format!("{home}/codex-work")))
        );
        assert_eq!(config.launch_args, "--enable a");
        assert_eq!(config.launch_args_env().as_deref(), Some("--enable b"));
        assert!(!format!("{config:?}").contains("s3cret"));
        // No homePath: the instance's CODEX_HOME, expanded.
        let entry = json!({"environment": [{"name": "CODEX_HOME", "value": "~/ch"}]});
        let config = CodexConfig::default().with_instance(Some(&entry));
        assert_eq!(config.home_path, Some(PathBuf::from(format!("{home}/ch"))));
        assert_eq!(
            CodexConfig::default().with_instance(None).binary,
            PathBuf::from("codex")
        );
    }
    use conn_contract::from_json;

    /// A `PATH` search skips a file without an execute bit, as the shell does (review
    /// finding 10), and finds the runnable one after it.
    #[cfg(unix)]
    #[test]
    fn find_executable_skips_a_file_that_cannot_run() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("conn-codex-exec-{}", std::process::id()));
        let (plain, runnable) = (root.join("a"), root.join("b"));
        for dir in [&plain, &runnable] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(plain.join("codex"), "").unwrap();
        std::fs::write(runnable.join("codex"), "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(
            runnable.join("codex"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let path = std::env::join_paths([&plain, &runnable]).unwrap();
        assert_eq!(
            find_executable(Path::new("codex"), Some(&path)),
            Some(runnable.join("codex"))
        );
        assert_eq!(
            find_executable(&plain.join("codex"), None),
            None,
            "a path too"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn t3_code_splits_its_wait_tool_onto_a_direct_server() {
        let server = McpServer {
            device_tools: false,
            name: "conn".into(),
            url: "http://127.0.0.1:3773/mcp".into(),
            headers: vec![("Authorization".into(), "Bearer abc".into())],
        };
        let config = &thread_params(Some("t1"), None, None, &[server])["config"];
        let main = &config["mcp_servers.conn"];
        let direct = &config["mcp_servers.conn-direct"];
        assert_eq!(
            main["disabled_tools"],
            json!(["conn_thread_wait", "delegate_task"])
        );
        assert_eq!(
            direct["enabled_tools"],
            json!(["conn_thread_wait", "delegate_task"])
        );
        assert_eq!(direct["http_headers"]["Authorization"], "Bearer abc");
        assert_eq!(main["tool_timeout_sec"], MCP_TOOL_TIMEOUT_SECS);
    }

    #[test]
    fn the_thread_load_selection_drops_only_the_effort() {
        let selection: ModelSelection = conn_contract::from_json(json!({
            "instanceId": "codex",
            "model": "gpt-6-luna",
            "options": [
                {"id": "reasoningEffort", "value": "high"},
                {"id": "fastMode", "value": true}
            ]
        }))
        .unwrap();
        assert_eq!(
            to_json(&thread_load_selection(&selection)),
            json!({"instanceId": "codex", "model": "gpt-6-luna", "options": [{"id": "fastMode", "value": true}]})
        );
        let effort_only: ModelSelection = conn_contract::from_json(json!({
            "model": "gpt-6-luna",
            "options": [{"id": "reasoningEffort", "value": "low"}]
        }))
        .unwrap();
        assert_eq!(
            to_json(&thread_load_selection(&effort_only)),
            json!({"model": "gpt-6-luna"})
        );
    }

    #[test]
    fn argv_and_environment_match_the_ts_launch() {
        let config = CodexConfig {
            launch_args: "--enable foo -c 'model=\"x y\"'".into(),
            instance_env: vec![("OPENAI_BASE_URL".into(), "http://router".into())].into(),
            ..CodexConfig::default()
        };
        let spec = launch_spec(&config, None, false);
        assert_eq!(spec.program, PathBuf::from("codex"));
        assert_eq!(
            spec.args,
            [
                "app-server",
                "-c",
                "thread_unload_delay_secs=0",
                "--enable",
                "foo",
                "-c",
                "model=\"x y\""
            ]
        );
        assert_eq!(
            spec.env_set,
            [
                (
                    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE".into(),
                    "T3 Code".into()
                ),
                ("OPENAI_BASE_URL".into(), "http://router".into()),
            ]
        );
        assert!(
            spec.env_remove.is_empty(),
            "the host environment passes through"
        );
        let from_env = launch_spec(&config, Some("--disable bar"), true);
        assert_eq!(
            from_env.env_set,
            [("OPENAI_BASE_URL".into(), "http://router".into())],
            "a host originator wins, as the TS spread lets it"
        );
        assert_eq!(&from_env.args[3..], ["--disable", "bar"]);
    }

    /// `buildCodexTurnStartParams`: MCP app context goes in `additionalContext` as quoted user
    /// input, beside T3's own entries.
    #[test]
    fn app_context_is_untrusted_additional_context() {
        let policy: RuntimePolicy = from_json(
            json!({"runtimeMode": "full-access", "interactionMode": "default", "cwd": "/w"}),
        )
        .unwrap();
        let selection: ModelSelection =
            from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"})).unwrap();
        let entry = conn_provider::AppContextEntry {
            key: "mcp_app_item_1".into(),
            text: "chart shows 3".into(),
        };
        let params = turn_start_params("th", json!([]), &policy, &selection, None, None, &[entry]);
        assert_eq!(
            params["additionalContext"],
            json!({"mcp_app_item_1": {"kind": "untrusted", "value": "chart shows 3"}})
        );
        let params = turn_start_params("th", json!([]), &policy, &selection, None, None, &[]);
        assert!(params.get("additionalContext").is_none());
    }

    #[test]
    fn turn_start_matches_the_recorded_frame() {
        let policy: RuntimePolicy = from_json(
            json!({"runtimeMode": "full-access", "interactionMode": "default", "cwd": "<workspace>"}),
        )
        .unwrap();
        let selection: ModelSelection =
            from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"})).unwrap();
        let params = turn_start_params(
            "01a0d5eb-f0c0",
            user_input(
                "Respond with the following text: fixture simple ok",
                &[],
                None,
            )
            .unwrap(),
            &policy,
            &selection,
            None,
            None,
            &[],
        );
        assert_eq!(
            params,
            json!({
                "approvalPolicy": {"granular": {"mcp_elicitations": true, "request_permissions": false,
                    "rules": false, "sandbox_approval": false, "skill_approval": false}},
                "approvalsReviewer": "user", "cwd": "<workspace>",
                "input": [{"text": "Respond with the following text: fixture simple ok", "type": "text"}],
                "model": "gpt-6-luna", "sandboxPolicy": {"type": "dangerFullAccess"},
                "summary": "auto", "threadId": "01a0d5eb-f0c0",
                "collaborationMode": {"mode": "default", "settings": {"model": "gpt-6-luna"}},
            })
        );
    }

    #[test]
    fn tokenizer_follows_the_shared_one() {
        assert_eq!(
            tokenize_cli_args(r#"a "b c" 'd e' f\ g "" "x\"y""#),
            ["a", "b c", "d e", "f g", "", "x\"y"]
        );
        assert!(tokenize_cli_args("   ").is_empty());
    }

    #[test]
    fn skill_mentions_use_the_dollar_sigil() {
        assert_eq!(skill_mention_text("run €review now"), "run $review now");
        assert_eq!(skill_mention_text("£plan:fast\tok"), "$plan:fast\tok");
        assert_eq!(
            skill_mention_text("costs €5k or 5€ or €"),
            "costs €5k or 5€ or €"
        );
        assert_eq!(skill_mention_text("a €1e3 b"), "a €1e3 b");
    }
}
