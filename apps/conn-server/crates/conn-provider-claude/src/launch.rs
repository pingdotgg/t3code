//! What a Claude query starts with: the `query()` option object and its environment.
//!
//! The SDK (in the helper, `helpers/sdk-host`) turns these into the CLI's argv, environment and
//! `initialize` request, as it does for the T3 server. This module builds the same option object
//! `makeClaudeQueryOptions` in `ClaudeAdapterV2.ts` builds, and the environment
//! `mergeClaudeProcessEnvironment`, `makeClaudeEnvironment` (`ClaudeHome.ts`),
//! `claudeQueryEnvironment` and the query runner's `open` build. The SDK adds its own
//! variables (`CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_CODE_SDK_READS_SESSION_STATE`, ...).
//!
//! No auth is set here. In an Orbit container the inherited environment points the CLI at the
//! AI router.

use std::{path::PathBuf, time::Duration};

use serde_json::{Map, Value, json};

use conn_provider_support::instance::{self, InstanceEnv, InstanceEnvelope};

use crate::helper::HelperCommand;
use crate::launch_args;

/// What `CLAUDE_HOST_SESSION_VARIABLES` in `ClaudeHome.ts` removes: a parent Claude Code
/// session's ids, messaging socket and token, and effort. Plus `ELECTRON_RUN_AS_NODE` (T3).
pub const REMOVED_ENV: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_HOST_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_DESKTOP_APP_VERSION",
    "CLAUDE_EFFORT",
    "CLAUDE_PID",
    "CLAUDE_AGENT_SDK_VERSION",
    "ELECTRON_RUN_AS_NODE",
];

/// `PortScanner.AGENT_THREAD_ENV`: jobs the agent starts inherit the thread id.
pub const AGENT_THREAD_ENV: &str = "T3CODE_THREAD_ID";

/// The Claude instance's settings that shape a query (`ClaudeSettings` in contracts).
#[derive(Clone, Debug)]
pub struct ClaudeConfig {
    /// `binaryPath`, passed as `pathToClaudeCodeExecutable`. Default `claude`, found on PATH.
    pub binary: PathBuf,
    /// `homePath`: a custom `CLAUDE_CONFIG_DIR`. `None` keeps the inherited one.
    pub home_path: Option<PathBuf>,
    /// The provider instance's own environment entries, applied after T3's changes. Values
    /// may be secrets; its `Debug` prints names only.
    pub instance_env: InstanceEnv,
    /// `launchArgs`, as stored (T3 does not trim them). Parsed per query
    /// (`makeClaudeQueryOptions`); probes and titles do not use them.
    pub launch_args: String,
    /// `buildRuntimeInstructions({ harness: "Claude Code" })`: the start of
    /// `systemPrompt.append`.
    pub append_system_prompt: Option<String>,
    /// Added to `additionalDirectories` (T3 adds its attachments directory). Also where
    /// attachments are read from, as `<dir>/<id><ext>` (T3's attachment store layout).
    pub attachments_dir: Option<PathBuf>,
    /// `settingSources`. `None` (as T3) passes none, so the CLI loads user, project and local
    /// settings with their hooks and MCP helpers. `Some(vec![])` loads none.
    pub setting_sources: Option<Vec<String>>,
    /// Ends an idle query after this long; the next turn resumes it. T3's session manager uses
    /// 30 minutes. `None` keeps the query until the session closes.
    pub idle_timeout: Option<Duration>,
    /// How long background work (a running subagent, a pending continuation) may keep an idle
    /// query alive. T3: 4 hours.
    pub idle_max_hold: Duration,
    /// Text appended to the system prompt when the session has a `t3-code` MCP server
    /// (`T3_CODE_ORCHESTRATION_INSTRUCTIONS` and the adapter's own texts in TS;
    /// `conn_mcp::CLAUDE_INSTRUCTIONS`).
    pub mcp_instructions: Option<String>,
    /// The SDK helper. Default: [`HelperCommand::discover`].
    pub helper: HelperCommand,
    /// Where the status probe runs the CLI (T3: its state folder). `None`: the server's cwd.
    pub status_cwd: Option<PathBuf>,
    /// Runs the status probe. Off, the entry stays T3's pending one: checks that start a
    /// server set `CONN_CLAUDE_STATUS_PROBE=off`, so they never run this machine's `claude`.
    pub status_probe: bool,
}

/// T3's `DEFAULT_IDLE_TIMEOUT_MS`.
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// T3's `DEFAULT_MAX_IDLE_PIN_MS`.
pub const DEFAULT_IDLE_MAX_HOLD: Duration = Duration::from_secs(4 * 60 * 60);
/// The MCP server name whose tools T3 allows without asking.
pub const T3_MCP_SERVER: &str = "t3-code";
/// `CLAUDE_T3_MCP_TOOL_WILDCARD`.
pub const T3_MCP_WILDCARD: &str = "mcp__t3-code__*";
/// `CLAUDE_READ_ONLY_ALLOWED_TOOLS`.
pub const READ_ONLY_TOOLS: &[&str] = &["Read", "Glob", "Grep"];
/// `CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS`: the `t3-code` tools annotated read-only.
pub const READ_ONLY_T3_MCP_TOOLS: &[&str] = &[
    "mcp__t3-code__orchestrator_capabilities",
    "mcp__t3-code__list_scheduled_tasks",
    "mcp__t3-code__t3_background_wait",
    "mcp__t3-code__t3_thread_list",
    "mcp__t3-code__t3_thread_wait",
    "mcp__t3-code__t3_worktree_status",
    "mcp__t3-code__t3_worktree_list",
    "mcp__t3-code__t3_project_list",
    "mcp__t3-code__t3_project_read",
    "mcp__t3-code__t3_thread_search",
    "mcp__t3-code__t3_preview_list",
    "mcp__t3-code__t3_environment_read",
    "mcp__t3-code__t3_environment_links",
    "mcp__t3-code__t3_theme_read",
    "mcp__t3-code__html_preview",
    "mcp__t3-code__html_render",
    "mcp__t3-code__send_to_user",
];

impl ClaudeConfig {
    /// This configuration with the instance's `providerInstances[id]` entry applied, as the
    /// T3 server's Claude driver builds its adapter (`ClaudeSettings`, `makeClaudeEnvironment`,
    /// `ClaudeAdapterV2` 13884-13890): `binaryPath` trimmed with `~` expanded (`claude` when
    /// empty), `homePath` expanded and made absolute, the instance environment, `launchArgs`.
    /// `None` is the default instance with no entry: the defaults.
    #[must_use]
    pub fn with_instance(mut self, entry: Option<&Value>) -> Self {
        let envelope = InstanceEnvelope::parse(entry, true);
        self.binary = envelope.config_str("binaryPath").map_or_else(
            || PathBuf::from("claude"),
            |b| PathBuf::from(instance::expand_home(&b)),
        );
        self.home_path = envelope
            .config_str("homePath")
            .map(|home| absolute(&instance::expand_home(&home)));
        self.instance_env = envelope.environment;
        self.launch_args = envelope.config["launchArgs"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        self
    }
}

/// `path.resolve` against the server's working folder.
pub(crate) fn absolute(path: &str) -> PathBuf {
    let path = PathBuf::from(path);
    let joined = if path.is_absolute() {
        path
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    // `path.resolve` also folds `.` and `..`.
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

impl Default for ClaudeConfig {
    fn default() -> Self {
        Self {
            binary: PathBuf::from("claude"),
            home_path: None,
            instance_env: InstanceEnv::default(),
            launch_args: String::new(),
            append_system_prompt: Some(default_append_system_prompt()),
            attachments_dir: None,
            setting_sources: None,
            idle_timeout: Some(DEFAULT_IDLE_TIMEOUT),
            idle_max_hold: DEFAULT_IDLE_MAX_HOLD,
            mcp_instructions: None,
            helper: HelperCommand::discover(),
            status_cwd: None,
            status_probe: true,
        }
    }
}

/// The `<runtime_info>` block of `buildRuntimeInstructions` at the pinned commit.
pub const RUNTIME_INFO: &str = "<runtime_info>In case you're asked: you are running in T3 Code through the Claude Code harness. No need to mention this otherwise. You can embed images, video, and audio using Markdown image syntax with absolute file paths. Link every other file you cite or produce by its absolute path, as in [http.ts:42](/abs/path/http.ts:42), so the user can open it in T3 Code's files viewer.</runtime_info>";

/// `PULL_REQUEST_LINKING_INSTRUCTIONS`. `buildRuntimeInstructions` adds it unless the caller
/// passes `pullRequestLinking: false`; the Claude adapter never does.
pub const PULL_REQUEST_LINKING_INSTRUCTIONS: &str = "<pull_request_linking>\nLink each PR you create, take over, or push to: link_pull_request, or link_pull_requests for several, full URL, every stack layer, as your next call. Host tools don't link for you. If linking fails, say so. Skip PRs you only read or review and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Finish any needed branch update and push first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch. When pull_request_* tools are listed, use them, not gh or cafe, to read, list, open, edit, review, reply on, close, or merge PRs, and ci_logs and ci_rerun for their checks. pull_request_create links for you.\nIf available, call link_issue for each issue you take on or file, even via CLI; skip issues you only read.\n</pull_request_linking>";

/// `buildRuntimeInstructions({ harness: "Claude Code" })` at the pinned commit.
pub fn default_append_system_prompt() -> String {
    format!("{RUNTIME_INFO}\n\n{PULL_REQUEST_LINKING_INSTRUCTIONS}")
}

/// `tools`: the Claude Code preset or an explicit list (read-only sandbox).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Tools {
    Preset,
    List(Vec<String>),
}

/// `ClaudeRuntimeQueryPolicy`: what the runtime policy asks of the query.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryPolicy {
    pub permission_mode: String,
    pub tools: Tools,
    pub allowed_tools: Option<Vec<String>>,
    pub allow_dangerously_skip_permissions: bool,
    pub install_permission_callback: bool,
    /// Bypass was asked for but settings forbid it.
    pub downgraded: bool,
}

/// The runtime policy fields T3 reads (`ProviderAdapterV2RuntimePolicy`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PolicyInput<'a> {
    pub runtime_mode: &'a str,
    pub interaction_mode: &'a str,
    pub approval_policy: Option<&'a str>,
    /// `sandboxPolicy.type`: `readOnly`, `workspaceWrite`, `dangerFullAccess`, `externalSandbox`.
    pub sandbox: Option<&'a str>,
    /// A `readOnly` sandbox with `access: fullAccess`.
    pub read_only_global_reads: bool,
}

/// `claudeBypassAvailability` over the settings sources.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BypassAvailability {
    pub bypass_disabled: bool,
    pub auto_disabled: bool,
}

/// `permissionModeForClaudeRuntimePolicy`.
pub fn permission_mode_for(policy: &PolicyInput<'_>) -> &'static str {
    if policy.interaction_mode == "plan" {
        return "plan";
    }
    let by_runtime = |mode: &str| match mode {
        "approval-required" => "default",
        "auto-accept-edits" => "acceptEdits",
        "auto" => "auto",
        _ => "bypassPermissions",
    };
    if policy.approval_policy == Some("never") {
        return match policy.sandbox {
            Some("readOnly") => "dontAsk",
            Some("dangerFullAccess" | "externalSandbox") => "bypassPermissions",
            _ => match policy.runtime_mode {
                "approval-required" => "dontAsk",
                "auto-accept-edits" => "acceptEdits",
                _ => "bypassPermissions",
            },
        };
    }
    if policy.approval_policy.is_some() {
        return "default";
    }
    match policy.sandbox {
        Some("readOnly") => return "dontAsk",
        Some("dangerFullAccess") => {
            return if policy.runtime_mode == "approval-required" {
                "default"
            } else {
                "bypassPermissions"
            };
        }
        _ => {}
    }
    by_runtime(policy.runtime_mode)
}

/// `claudeRuntimeQueryPolicyForRuntimePolicy`.
pub fn query_policy(policy: &PolicyInput<'_>, availability: BypassAvailability) -> QueryPolicy {
    let requested = permission_mode_for(policy);
    let downgraded = requested == "bypassPermissions" && availability.bypass_disabled;
    let permission_mode = if downgraded {
        if availability.auto_disabled {
            "default"
        } else {
            "auto"
        }
    } else {
        requested
    };
    let read_only = policy.sandbox == Some("readOnly");
    let tools = if read_only {
        Tools::List(READ_ONLY_TOOLS.iter().map(|s| s.to_string()).collect())
    } else {
        Tools::Preset
    };
    let allowed_tools = (read_only && policy.read_only_global_reads)
        .then(|| READ_ONLY_TOOLS.iter().map(|s| s.to_string()).collect());
    let install_permission_callback = downgraded
        || match policy.approval_policy {
            None => matches!(
                policy.runtime_mode,
                "approval-required" | "auto-accept-edits"
            ),
            Some(approval) => approval != "never",
        };
    if permission_mode == "plan" {
        return QueryPolicy {
            permission_mode: permission_mode.into(),
            tools,
            allowed_tools,
            allow_dangerously_skip_permissions: false,
            install_permission_callback: true,
            downgraded,
        };
    }
    QueryPolicy {
        permission_mode: permission_mode.into(),
        tools,
        allowed_tools,
        allow_dangerously_skip_permissions: permission_mode == "bypassPermissions",
        install_permission_callback,
        downgraded,
    }
}

/// `claudeMcpQueryOverrides`: the MCP pre-approvals added to `allowedTools`.
pub fn mcp_allowed_tools(
    policy: &QueryPolicy,
    t3_mcp: bool,
    read_only: bool,
) -> Option<Vec<String>> {
    if !t3_mcp {
        return policy.allowed_tools.clone();
    }
    let mut tools = policy.allowed_tools.clone().unwrap_or_default();
    let extra: Vec<String> = if read_only {
        READ_ONLY_T3_MCP_TOOLS
            .iter()
            .map(|s| s.to_string())
            .collect()
    } else {
        vec![T3_MCP_WILDCARD.to_string()]
    };
    for tool in extra {
        if !tools.contains(&tool) {
            tools.push(tool);
        }
    }
    Some(tools)
}

/// `requiresClaudeApproval`: whether a forwarded tool request asks the user.
pub fn asks_user(policy: &QueryPolicy) -> bool {
    policy.install_permission_callback || policy.permission_mode == "bypassPermissions"
}

/// The old rule, for a mapper with no policy: only `auto` lets a forwarded request through.
pub fn asks_user_mode(permission_mode: &str) -> bool {
    permission_mode != "auto"
}

/// Per-query choices.
#[derive(Clone, Debug, PartialEq)]
pub struct QueryInput {
    pub thread_id: String,
    pub native_thread_id: String,
    /// `resume` (the conversation exists) instead of `sessionId` (a new one).
    pub resume: bool,
    pub model: String,
    pub effort: Option<String>,
    /// The model selection's settings (`alwaysThinkingEnabled`, `fastMode`, `ultracode`).
    pub selection_settings: Map<String, Value>,
    pub policy: QueryPolicy,
    pub cwd: Option<String>,
    /// `resumeSessionAt`: continue from this message (rollback, fork).
    pub resume_at: Option<String>,
    pub title: Option<String>,
    /// The session has the `t3-code` MCP server (its servers go in by `setMcpServers`).
    pub t3_mcp: bool,
    /// `allowedTools` after the MCP pre-approvals.
    pub allowed_tools: Option<Vec<String>>,
    /// `promptSuggestions`. T3: off for delegated threads, else the user's setting.
    pub prompt_suggestions: bool,
}

/// The option object for `query()`, as `makeClaudeQueryOptions` builds it, without the
/// functions (`canUseTool`, `onUserDialog`, `onElicitation`), which the helper adds.
///
/// `launch` is the instance's `launchArgs` as [`crate::launch_args::apply`] read them.
pub fn query_options(
    config: &ClaudeConfig,
    input: &QueryInput,
    env: Map<String, Value>,
    launch: &launch_args::Applied,
) -> Value {
    let mut options = Map::new();
    options.insert("model".into(), json!(input.model));
    if let Some(title) = &input.title {
        options.insert("title".into(), json!(title));
    }
    options.insert(
        "tools".into(),
        match &input.policy.tools {
            Tools::Preset => json!({"type": "preset", "preset": "claude_code"}),
            Tools::List(list) => json!(list),
        },
    );
    // A launch argument's mode wins, then `--dangerously-skip-permissions`, then the policy.
    let permission_mode = launch.permission_mode.clone().unwrap_or_else(|| {
        if launch.skip_permissions {
            "bypassPermissions".into()
        } else {
            input.policy.permission_mode.clone()
        }
    });
    options.insert("permissionMode".into(), json!(permission_mode));
    options.insert("includePartialMessages".into(), json!(true));
    options.insert("promptSuggestions".into(), json!(input.prompt_suggestions));
    if let Some(effort) = &input.effort {
        options.insert("effort".into(), json!(effort));
    }
    if input.resume {
        options.insert("resume".into(), json!(input.native_thread_id));
    } else {
        options.insert("sessionId".into(), json!(input.native_thread_id));
    }
    if let Some(at) = &input.resume_at {
        options.insert("resumeSessionAt".into(), json!(at));
    }
    if let Some(tools) = &input.allowed_tools {
        options.insert("allowedTools".into(), json!(tools));
    }
    if input.policy.allow_dangerously_skip_permissions {
        options.insert("allowDangerouslySkipPermissions".into(), json!(true));
    }
    // Thinking summaries unless the selection turns thinking off or a launch argument asks
    // for `--thinking-display omitted`.
    let mut extra_args = launch.extra_args.clone();
    let thinking_display = extra_args
        .iter()
        .find(|(k, _)| k == "thinking-display")
        .map(|(_, v)| v.clone());
    let thinking_off = input.selection_settings.get("alwaysThinkingEnabled") == Some(&json!(false))
        || thinking_display == Some(Some("omitted".to_owned()));
    if !thinking_off && thinking_display.is_none() {
        extra_args.push(("thinking-display".into(), Some("summarized".into())));
    }
    // T3 pins an alias-named model to itself (`ANTHROPIC_DEFAULT_<ALIAS>_MODEL` in
    // settings.env) only after its model catalog resolved the alias; without the catalog a
    // bare alias goes to the CLI as is, which expands it the same way.
    let mut settings = input.selection_settings.clone();
    if !thinking_off {
        options.insert(
            "thinking".into(),
            json!({"type": "adaptive", "display": "summarized"}),
        );
        settings.insert("showThinkingSummaries".into(), json!(true));
    }
    match &launch.settings {
        // `--settings` lies beneath T3's keys, in its own order.
        Some(base) => {
            let mut merged = base.clone();
            let order = [
                "effortLevel",
                "alwaysThinkingEnabled",
                "fastMode",
                "ultracode",
                "showThinkingSummaries",
            ];
            let mut keys: Vec<&String> = settings.keys().collect();
            keys.sort_by_key(|k| order.iter().position(|o| o == k).unwrap_or(order.len()));
            for key in keys {
                if let Some(value) = settings.get(key) {
                    launch_args::set(&mut merged, key, launch_args::Json::from_value(value));
                }
            }
            options.insert(
                "settings".into(),
                crate::ordered::raw(launch_args::Json::Object(merged).to_text()),
            );
        }
        None if !settings.is_empty() => {
            options.insert("settings".into(), Value::Object(settings));
        }
        None => {}
    }
    options.insert("supportedDialogKinds".into(), json!(["resume_return"]));
    options.insert(
        "pathToClaudeCodeExecutable".into(),
        json!(config.binary.to_string_lossy()),
    );
    options.insert("env".into(), Value::Object(env));
    let mut append = config.append_system_prompt.clone().unwrap_or_default();
    if input.t3_mcp {
        append.push_str(config.mcp_instructions.as_deref().unwrap_or_default());
    }
    for text in &launch.append {
        append.push_str("\n\n");
        append.push_str(text);
    }
    options.insert(
        "systemPrompt".into(),
        json!({"type": "preset", "preset": "claude_code", "append": append}),
    );
    if launch.extra_args.is_empty() && !extra_args.is_empty() {
        options.insert(
            "extraArgs".into(),
            json!({"thinking-display": "summarized"}),
        );
    } else if !extra_args.is_empty() {
        // The user's flags, in their order.
        let object = launch_args::Json::Object(
            extra_args
                .into_iter()
                .map(|(k, v)| {
                    (
                        k,
                        v.map_or(launch_args::Json::Null, launch_args::Json::String),
                    )
                })
                .collect(),
        );
        options.insert("extraArgs".into(), crate::ordered::raw(object.to_text()));
    }
    if let Some(sources) = &config.setting_sources {
        options.insert("settingSources".into(), json!(sources));
    }
    let dirs: Vec<String> = input
        .cwd
        .iter()
        .cloned()
        .chain(
            config
                .attachments_dir
                .iter()
                .map(|p| p.to_string_lossy().into_owned()),
        )
        .chain(launch.add_dirs.iter().cloned())
        .collect();
    if !dirs.is_empty() {
        options.insert("additionalDirectories".into(), json!(dirs));
    }
    if let Some(cwd) = &input.cwd {
        options.insert("cwd".into(), json!(cwd));
    }
    Value::Object(options)
}

/// The CLI's environment (`options.env`), from the host's: T3's changes in order, then
/// `T3CODE_THREAD_ID`. `settings_entrypoint` is `env.CLAUDE_CODE_ENTRYPOINT` from Claude's user
/// or managed settings, which wins over `t3-code` (`mergeClaudeProcessEnvironment`).
pub fn query_env(
    config: &ClaudeConfig,
    thread_id: &str,
    resume: bool,
    host: impl IntoIterator<Item = (String, String)>,
    settings_entrypoint: Option<String>,
) -> Map<String, Value> {
    let mut env: Map<String, Value> = host.into_iter().map(|(k, v)| (k, json!(v))).collect();
    env.insert("CLAUDE_CODE_ENTRYPOINT".into(), json!("t3-code"));
    for key in REMOVED_ENV {
        env.remove(*key);
    }
    for (key, value) in &config.instance_env {
        let value = if key == "CLAUDE_CONFIG_DIR" {
            expand_home(value).to_string_lossy().into_owned()
        } else {
            value.clone()
        };
        env.insert(key.clone(), json!(value));
    }
    if let Some(entrypoint) = settings_entrypoint.filter(|e| !e.is_empty()) {
        env.insert("CLAUDE_CODE_ENTRYPOINT".into(), json!(entrypoint));
    }
    if let Some(home) = &config.home_path {
        env.insert("CLAUDE_CONFIG_DIR".into(), json!(home.to_string_lossy()));
    }
    // A resumed session's first request otherwise goes out before its MCP servers connect.
    if resume && !env.contains_key("MCP_CONNECTION_NONBLOCKING") {
        env.insert("MCP_CONNECTION_NONBLOCKING".into(), json!("0"));
    }
    env.insert(AGENT_THREAD_ENV.into(), json!(thread_id));
    env
}

/// `mergeClaudeProcessEnvironment`, then `makeClaudeEnvironment`: the Claude process
/// environment outside a turn (no thread id), as name and value pairs.
pub fn process_environment(
    config: &ClaudeConfig,
    host: impl IntoIterator<Item = (String, String)>,
    settings_entrypoint: Option<String>,
) -> Vec<(String, String)> {
    let mut env = query_env(config, "", false, host, settings_entrypoint);
    env.remove(AGENT_THREAD_ENV);
    env.into_iter()
        .filter_map(|(k, v)| Some((k, v.as_str()?.to_owned())))
        .collect()
}

/// The config directory T3 reads Claude's settings from (`resolveClaudeConfigDirPath`).
pub fn config_dir(config: &ClaudeConfig, env: &Map<String, Value>) -> PathBuf {
    if let Some(home) = &config.home_path {
        return home.clone();
    }
    match env
        .get("CLAUDE_CONFIG_DIR")
        .and_then(Value::as_str)
        .map(str::trim)
    {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => expand_home("~/.claude"),
    }
}

/// Claude's managed settings file (`claudeManagedSettingsPath`).
pub fn managed_settings_path() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        Some("/Library/Application Support/ClaudeCode/managed-settings.json".into())
    } else if cfg!(windows) {
        std::env::var_os("PROGRAMDATA").map(|d| {
            PathBuf::from(d)
                .join("ClaudeCode")
                .join("managed-settings.json")
        })
    } else {
        Some("/etc/claude-code/managed-settings.json".into())
    }
}

/// `readClaudeSettingsEnv(...).CLAUDE_CODE_ENTRYPOINT`: user then managed settings, later wins.
/// Blocking file reads; call off the runtime thread.
pub fn settings_entrypoint(config_dir: &std::path::Path) -> Option<String> {
    let mut found = None;
    let paths = std::iter::once(config_dir.join("settings.json")).chain(managed_settings_path());
    for path in paths {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if let Some(entry) = value["env"]["CLAUDE_CODE_ENTRYPOINT"].as_str() {
            found = Some(entry.to_string());
        }
    }
    found
}

/// `readClaudeSettingsEnv(...)[name]` for a string value: user then managed settings, later
/// wins. Blocking file reads; call off the runtime thread.
pub fn settings_env_value(config_dir: &std::path::Path, name: &str) -> Option<String> {
    let mut found = None;
    let paths = std::iter::once(config_dir.join("settings.json")).chain(managed_settings_path());
    for path in paths {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if let Some(entry) = value["env"][name].as_str() {
            found = Some(entry.to_string());
        }
    }
    found
}

/// `~` expansion for `binaryPath` and `homePath`.
pub fn expand_home(path: &str) -> PathBuf {
    match (path.strip_prefix("~/"), std::env::var_os("HOME")) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ if path == "~" => std::env::var_os("HOME").map_or_else(|| path.into(), PathBuf::from),
        _ => PathBuf::from(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_instance_entry_shapes_the_config() {
        let home = std::env::var("HOME").unwrap_or_default();
        let entry = json!({
            "driver": "claudeAgent",
            "config": {"binaryPath": " ~/bin/claude ", "homePath": "~/claude-low", "launchArgs": " --verbose "},
            "environment": [{"name": "SECRET", "value": "s3cret", "sensitive": true}],
        });
        let config = ClaudeConfig::default().with_instance(Some(&entry));
        assert_eq!(config.binary, PathBuf::from(format!("{home}/bin/claude")));
        assert_eq!(
            config.home_path,
            Some(PathBuf::from(format!("{home}/claude-low")))
        );
        // T3 does not trim Claude's launch arguments.
        assert_eq!(config.launch_args, " --verbose ");
        assert_eq!(config.instance_env.get("SECRET"), Some("s3cret"));
        assert!(!format!("{config:?}").contains("s3cret"));
        assert_eq!(
            ClaudeConfig::default().with_instance(None).binary,
            PathBuf::from("claude")
        );
    }

    fn policy(runtime: &str) -> QueryPolicy {
        query_policy(
            &PolicyInput {
                runtime_mode: runtime,
                interaction_mode: "default",
                ..PolicyInput::default()
            },
            BypassAvailability::default(),
        )
    }

    fn input(resume: bool) -> QueryInput {
        QueryInput {
            thread_id: "thread-1".into(),
            native_thread_id: "1979620e-79c0-42d3-94d7-6c559c0f8ed4".into(),
            resume,
            model: "claude-sonnet-4-6".into(),
            effort: Some("high".into()),
            selection_settings: Map::new(),
            policy: policy("full-access"),
            cwd: Some("/workspace".into()),
            resume_at: None,
            title: Some("A thread".into()),
            t3_mcp: false,
            allowed_tools: None,
            prompt_suggestions: false,
        }
    }

    fn config() -> ClaudeConfig {
        ClaudeConfig {
            attachments_dir: Some("/attachments".into()),
            helper: HelperCommand::from_path("/helper"),
            ..ClaudeConfig::default()
        }
    }

    #[test]
    fn options_match_make_claude_query_options() {
        let options = query_options(&config(), &input(false), Map::new(), &Default::default());
        assert_eq!(
            options,
            json!({
                "model": "claude-sonnet-4-6",
                "title": "A thread",
                "tools": {"type": "preset", "preset": "claude_code"},
                "permissionMode": "bypassPermissions",
                "includePartialMessages": true,
                "promptSuggestions": false,
                "effort": "high",
                "sessionId": "1979620e-79c0-42d3-94d7-6c559c0f8ed4",
                "allowDangerouslySkipPermissions": true,
                "thinking": {"type": "adaptive", "display": "summarized"},
                "settings": {"showThinkingSummaries": true},
                "supportedDialogKinds": ["resume_return"],
                "pathToClaudeCodeExecutable": "claude",
                "env": {},
                "systemPrompt": {
                    "type": "preset",
                    "preset": "claude_code",
                    "append": default_append_system_prompt(),
                },
                "extraArgs": {"thinking-display": "summarized"},
                "additionalDirectories": ["/workspace", "/attachments"],
                "cwd": "/workspace",
            })
        );
        let resumed = query_options(&config(), &input(true), Map::new(), &Default::default());
        assert_eq!(resumed["resume"], "1979620e-79c0-42d3-94d7-6c559c0f8ed4");
        assert!(resumed.get("sessionId").is_none());
    }

    #[test]
    fn mcp_text_follows_t3() {
        let mut with_mcp = input(false);
        with_mcp.t3_mcp = true;
        let config = ClaudeConfig {
            mcp_instructions: Some("\n\nMCP".into()),
            ..config()
        };
        let options = query_options(&config, &with_mcp, Map::new(), &Default::default());
        assert!(
            options["systemPrompt"]["append"]
                .as_str()
                .is_some_and(|a| a.ends_with("\n\nMCP"))
        );
    }

    #[test]
    fn env_drops_parent_session_and_sets_t3_entrypoint() {
        let config = ClaudeConfig {
            home_path: Some("/claude-home".into()),
            ..config()
        };
        let host = [
            ("CLAUDECODE".to_string(), "1".to_string()),
            ("PATH".to_string(), "/bin".to_string()),
            ("NODE_OPTIONS".to_string(), "--x".to_string()),
        ];
        let env = query_env(&config, "thread-1", true, host.clone(), None);
        assert_eq!(env["CLAUDE_CODE_ENTRYPOINT"], "t3-code");
        assert_eq!(env["CLAUDE_CONFIG_DIR"], "/claude-home");
        assert_eq!(env["MCP_CONNECTION_NONBLOCKING"], "0");
        assert_eq!(env[AGENT_THREAD_ENV], "thread-1");
        assert_eq!(env["PATH"], "/bin");
        // The SDK, not T3, decides about NODE_OPTIONS.
        assert_eq!(env["NODE_OPTIONS"], "--x");
        assert!(env.get("CLAUDECODE").is_none());
        let fresh = query_env(&config, "thread-1", false, host, Some("custom".into()));
        assert!(fresh.get("MCP_CONNECTION_NONBLOCKING").is_none());
        assert_eq!(fresh["CLAUDE_CODE_ENTRYPOINT"], "custom");
    }

    #[test]
    fn permission_modes_follow_the_runtime_policy() {
        assert_eq!(policy("full-access").permission_mode, "bypassPermissions");
        assert_eq!(policy("approval-required").permission_mode, "default");
        assert_eq!(policy("auto-accept-edits").permission_mode, "acceptEdits");
        assert_eq!(policy("auto").permission_mode, "auto");
        let plan = query_policy(
            &PolicyInput {
                runtime_mode: "full-access",
                interaction_mode: "plan",
                ..PolicyInput::default()
            },
            BypassAvailability::default(),
        );
        assert_eq!(plan.permission_mode, "plan");
        assert!(plan.install_permission_callback);
        let read_only = query_policy(
            &PolicyInput {
                runtime_mode: "full-access",
                interaction_mode: "default",
                sandbox: Some("readOnly"),
                ..PolicyInput::default()
            },
            BypassAvailability::default(),
        );
        assert_eq!(read_only.permission_mode, "dontAsk");
        assert_eq!(
            read_only.tools,
            Tools::List(vec!["Read".into(), "Glob".into(), "Grep".into()])
        );
    }

    #[test]
    fn bypass_downgrades_when_settings_forbid_it() {
        let input = PolicyInput {
            runtime_mode: "full-access",
            interaction_mode: "default",
            ..PolicyInput::default()
        };
        let auto = query_policy(
            &input,
            BypassAvailability {
                bypass_disabled: true,
                auto_disabled: false,
            },
        );
        assert_eq!(auto.permission_mode, "auto");
        assert!(auto.install_permission_callback);
        assert!(!auto.allow_dangerously_skip_permissions);
        let none = query_policy(
            &input,
            BypassAvailability {
                bypass_disabled: true,
                auto_disabled: true,
            },
        );
        assert_eq!(none.permission_mode, "default");
    }
}
