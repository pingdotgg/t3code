//! How a `claude` process starts: executable, argv, environment.
//!
//! This reproduces what the TypeScript server passes today, through the Agent SDK 0.3.321:
//! - executable: `ClaudeSettings.binaryPath` (default `claude`, `~` expanded, found on PATH),
//!   passed as `pathToClaudeCodeExecutable` (`createClaudeAdapterV2`,
//!   `resolveClaudeSdkExecutablePath`).
//! - setting sources: none passed, so no `--setting-sources` flag: the CLI loads user, project
//!   and local settings, hooks included (`makeClaudeQueryOptions` never sets `settingSources`).
//! - environment: the host environment with T3's changes (`mergeClaudeProcessEnvironment` in
//!   `provider/Drivers/ClaudeHome.ts`, `claudeQueryEnvironment`, the query runner's `open`) and
//!   then the SDK's own (`ProcessTransport`, `query()`), listed in [`env_changes`].
//! - argv: the SDK's order and `--flag=value` form for T3's options (`makeClaudeQueryOptions`).
//!
//! No auth is set here. In an Orbit container the inherited environment points the CLI at the
//! AI router.

use std::{path::PathBuf, time::Duration};

use conn_provider_support::process::LaunchSpec;
use serde_json::json;

/// What `CLAUDE_HOST_SESSION_VARIABLES` in `ClaudeHome.ts` removes: a parent Claude Code
/// session's ids, messaging socket and token, and effort. Plus `ELECTRON_RUN_AS_NODE` (T3) and
/// `NODE_OPTIONS`, `DEBUG` (the SDK).
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
    "NODE_OPTIONS",
    "DEBUG",
];

/// The Agent SDK version T3 runs; the SDK exports it to the CLI.
pub const AGENT_SDK_VERSION: &str = "0.3.321";

/// `PortScanner.AGENT_THREAD_ENV`: jobs the agent starts inherit the thread id.
pub const AGENT_THREAD_ENV: &str = "T3CODE_THREAD_ID";

/// The Claude instance's settings that shape a launch (`ClaudeSettings` in contracts).
#[derive(Clone, Debug)]
pub struct ClaudeConfig {
    /// `binaryPath`. Default `claude`, resolved on PATH.
    pub binary: PathBuf,
    /// `homePath`: a custom `CLAUDE_CONFIG_DIR`. `None` keeps the inherited one.
    pub home_path: Option<PathBuf>,
    /// The provider instance's own environment entries, applied after T3's changes.
    pub instance_env: Vec<(String, String)>,
    /// Text T3 appends to Claude's system prompt (`buildRuntimeInstructions`). Sent in
    /// `initialize` as `appendSystemPrompt`, like the SDK does.
    pub append_system_prompt: Option<String>,
    /// Extra directory added with `--add-dir` (T3 adds its attachments directory). Also where
    /// attachments are read from, as `<dir>/<id><ext>` (T3's attachment store layout).
    pub attachments_dir: Option<PathBuf>,
    /// `--setting-sources`. `None` passes no flag, so the CLI loads user, project and local
    /// settings with their hooks and MCP helpers, as under T3. `Some(vec![])` loads none.
    pub setting_sources: Option<Vec<String>>,
    /// Ends an idle `claude` child after this long; the next turn resumes it. T3's session
    /// manager uses 30 minutes. `None` keeps the child until the session closes.
    pub idle_timeout: Option<Duration>,
    /// How long background work (a running subagent, a pending continuation) may keep an idle
    /// child alive. T3: 4 hours.
    pub idle_max_hold: Duration,
    /// Text appended to the system prompt when the session has a `t3-code` MCP server
    /// (`T3_CODE_ORCHESTRATION_INSTRUCTIONS` in TS).
    pub mcp_instructions: Option<String>,
}

/// T3's `DEFAULT_IDLE_TIMEOUT_MS`.
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// T3's `DEFAULT_MAX_IDLE_PIN_MS`.
pub const DEFAULT_IDLE_MAX_HOLD: Duration = Duration::from_secs(4 * 60 * 60);
/// The MCP server name whose tools T3 allows without asking.
pub const T3_MCP_SERVER: &str = "t3-code";

impl Default for ClaudeConfig {
    fn default() -> Self {
        Self {
            binary: PathBuf::from("claude"),
            home_path: None,
            instance_env: Vec::new(),
            append_system_prompt: Some(DEFAULT_APPEND_SYSTEM_PROMPT.into()),
            attachments_dir: None,
            setting_sources: None,
            idle_timeout: Some(DEFAULT_IDLE_TIMEOUT),
            idle_max_hold: DEFAULT_IDLE_MAX_HOLD,
            mcp_instructions: None,
        }
    }
}

/// `buildRuntimeInstructions({ harness: "Claude Code" })` at the pinned commit, without the
/// T3 MCP orchestration block (this server has no MCP endpoint yet).
pub const DEFAULT_APPEND_SYSTEM_PROMPT: &str = "<runtime_info>In case you're asked: you are running in T3 Code through the Claude Code harness. No need to mention this otherwise. You can embed images, video, and audio using Markdown image syntax with absolute file paths. Link every other file you cite or produce by its absolute path, as in [http.ts:42](/abs/path/http.ts:42), so the user can open it in T3 Code's files viewer.</runtime_info>";

/// Per-launch choices.
#[derive(Clone, Debug, PartialEq)]
pub struct LaunchInput {
    pub thread_id: String,
    pub native_thread_id: String,
    /// `--resume` (the conversation exists) instead of `--session-id` (a new one).
    pub resume: bool,
    pub model: String,
    pub effort: Option<String>,
    pub permission_mode: String,
    pub cwd: Option<String>,
    /// `--resume-session-at`: continue from this message (rollback).
    pub resume_at: Option<String>,
    /// Fork: resume this native session into `native_thread_id` with `--fork-session`.
    pub fork_from: Option<String>,
    /// `--allowedTools` (the T3 MCP tools).
    pub allowed_tools: Vec<String>,
}

pub fn launch_spec(config: &ClaudeConfig, input: &LaunchInput) -> LaunchSpec {
    let mut args: Vec<String> = [
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "stream-json",
        // thinking: { type: "adaptive", display: "summarized" }
        "--thinking=adaptive",
        "--thinking-display=summarized",
    ]
    .map(String::from)
    .to_vec();
    if let Some(effort) = &input.effort {
        args.push(format!("--effort={effort}"));
    }
    args.push(format!("--model={}", input.model));
    // canUseTool is always installed.
    args.push("--permission-prompt-tool=stdio".into());
    if let Some(source) = &input.fork_from {
        args.push(format!("--resume={source}"));
        args.push("--fork-session".into());
    } else if input.resume {
        args.push(format!("--resume={}", input.native_thread_id));
    }
    if let Some(at) = &input.resume_at {
        args.push(format!("--resume-session-at={at}"));
    }
    if !input.allowed_tools.is_empty() {
        args.push(format!("--allowedTools={}", input.allowed_tools.join(",")));
    }
    // tools: { type: "preset", preset: "claude_code" }
    args.push("--tools=default".into());
    args.push(format!("--permission-mode={}", input.permission_mode));
    if input.permission_mode == "bypassPermissions" {
        args.push("--allow-dangerously-skip-permissions".into());
    }
    args.push("--include-partial-messages".into());
    let dirs = input
        .cwd
        .iter()
        .map(String::as_str)
        .chain(config.attachments_dir.iter().filter_map(|p| p.to_str()));
    for dir in dirs {
        args.push(format!("--add-dir={dir}"));
    }
    if !input.resume || input.fork_from.is_some() {
        args.push(format!("--session-id={}", input.native_thread_id));
    }
    if let Some(sources) = &config.setting_sources {
        args.extend(["--setting-sources".into(), sources.join(",")]);
    }
    // extraArgs { "thinking-display": "summarized" }, then options.settings.
    args.extend(["--thinking-display".into(), "summarized".into()]);
    args.extend([
        "--settings".into(),
        json!({"showThinkingSummaries": true}).to_string(),
    ]);
    LaunchSpec {
        program: config.binary.clone(),
        args,
        cwd: input.cwd.clone(),
        env_remove: REMOVED_ENV.iter().map(|s| s.to_string()).collect(),
        env_set: env_changes(config, input, |key| std::env::var_os(key).is_some()),
    }
}

/// Variables set on top of the inherited environment, in order (later wins).
pub fn env_changes(
    config: &ClaudeConfig,
    input: &LaunchInput,
    inherited: impl Fn(&str) -> bool,
) -> Vec<(String, String)> {
    let mut env = vec![("CLAUDE_CODE_ENTRYPOINT".to_string(), "t3-code".to_string())];
    if let Some(home) = config.home_path.as_ref().and_then(|p| p.to_str()) {
        env.push(("CLAUDE_CONFIG_DIR".into(), home.into()));
    }
    env.extend(config.instance_env.iter().cloned());
    // A resumed session's first request otherwise goes out before its MCP servers connect.
    if input.resume
        && !inherited("MCP_CONNECTION_NONBLOCKING")
        && !config
            .instance_env
            .iter()
            .any(|(k, _)| k == "MCP_CONNECTION_NONBLOCKING")
    {
        env.push(("MCP_CONNECTION_NONBLOCKING".into(), "0".into()));
    }
    env.push((AGENT_THREAD_ENV.into(), input.thread_id.clone()));
    env.push(("CLAUDE_AGENT_SDK_VERSION".into(), AGENT_SDK_VERSION.into()));
    env.push(("CLAUDE_CODE_SDK_READS_SESSION_STATE".into(), "1".into()));
    env
}

/// The `initialize` control request the SDK sends first. `extra` is appended to the system
/// prompt, as TS appends its orchestration instructions when the thread has its MCP server.
pub fn initialize_request(
    config: &ClaudeConfig,
    title: Option<&str>,
    extra: Option<&str>,
) -> serde_json::Value {
    let mut request = json!({
        "subtype": "initialize",
        "promptSuggestions": false,
        "supportedDialogKinds": ["resume_return"],
    });
    let append: Vec<&str> = config
        .append_system_prompt
        .as_deref()
        .into_iter()
        .chain(extra)
        .collect();
    if !append.is_empty() {
        request["appendSystemPrompt"] = json!(append.join("\n\n"));
    }
    if let Some(title) = title {
        request["title"] = json!(title);
    }
    request
}

/// `permissionModeForClaudeRuntimePolicy` for the policy fields the trait carries
/// (no `approvalPolicy` or `sandboxPolicy`).
pub fn permission_mode(runtime_mode: &str, interaction_mode: &str) -> &'static str {
    if interaction_mode == "plan" {
        return "plan";
    }
    match runtime_mode {
        "approval-required" => "default",
        "auto-accept-edits" => "acceptEdits",
        "auto" => "auto",
        _ => "bypassPermissions",
    }
}

/// `requiresClaudeApproval`: whether a forwarded tool request asks the user.
/// `auto` alone lets the callback allow without asking.
pub fn asks_user(permission_mode: &str) -> bool {
    permission_mode != "auto"
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

    fn input(resume: bool) -> LaunchInput {
        LaunchInput {
            thread_id: "thread-1".into(),
            native_thread_id: "1979620e-79c0-42d3-94d7-6c559c0f8ed4".into(),
            resume,
            model: "claude-sonnet-4-6".into(),
            effort: Some("high".into()),
            permission_mode: "bypassPermissions".into(),
            cwd: Some("/workspace".into()),
            resume_at: None,
            fork_from: None,
            allowed_tools: Vec::new(),
        }
    }

    #[test]
    fn argv_matches_the_sdk_for_t3_options() {
        let config = ClaudeConfig {
            attachments_dir: Some("/attachments".into()),
            ..ClaudeConfig::default()
        };
        let spec = launch_spec(&config, &input(false));
        assert_eq!(
            spec.args,
            [
                "--output-format",
                "stream-json",
                "--verbose",
                "--input-format",
                "stream-json",
                "--thinking=adaptive",
                "--thinking-display=summarized",
                "--effort=high",
                "--model=claude-sonnet-4-6",
                "--permission-prompt-tool=stdio",
                "--tools=default",
                "--permission-mode=bypassPermissions",
                "--allow-dangerously-skip-permissions",
                "--include-partial-messages",
                "--add-dir=/workspace",
                "--add-dir=/attachments",
                "--session-id=1979620e-79c0-42d3-94d7-6c559c0f8ed4",
                "--thinking-display",
                "summarized",
                "--settings",
                r#"{"showThinkingSummaries":true}"#,
            ]
        );
        let resumed = launch_spec(&config, &input(true));
        assert!(
            resumed
                .args
                .contains(&"--resume=1979620e-79c0-42d3-94d7-6c559c0f8ed4".to_string())
        );
        assert!(!resumed.args.iter().any(|a| a.starts_with("--session-id")));
        assert!(
            !resumed
                .args
                .iter()
                .any(|a| a.starts_with("--setting-sources"))
        );
    }

    #[test]
    fn rollback_fork_and_setting_sources_reach_argv() {
        let config = ClaudeConfig {
            setting_sources: Some(vec![]),
            ..ClaudeConfig::default()
        };
        let mut fork = input(false);
        fork.fork_from = Some("source-id".into());
        fork.resume_at = Some("msg-uuid".into());
        fork.allowed_tools = vec!["mcp__t3-code__*".into()];
        let args = launch_spec(&config, &fork).args;
        for expected in [
            "--resume=source-id",
            "--fork-session",
            "--resume-session-at=msg-uuid",
            "--allowedTools=mcp__t3-code__*",
            "--session-id=1979620e-79c0-42d3-94d7-6c559c0f8ed4",
        ] {
            assert!(
                args.contains(&expected.to_string()),
                "{expected} in {args:?}"
            );
        }
        let at = args.iter().position(|a| a == "--setting-sources").unwrap();
        assert_eq!(args[at + 1], "");
    }

    #[test]
    fn env_drops_parent_session_and_sets_t3_entrypoint() {
        let config = ClaudeConfig {
            home_path: Some("/claude-home".into()),
            ..ClaudeConfig::default()
        };
        let env = env_changes(&config, &input(true), |_| false);
        let get = |k: &str| {
            env.iter()
                .rev()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(get("CLAUDE_CODE_ENTRYPOINT"), Some("t3-code"));
        assert_eq!(get("CLAUDE_CONFIG_DIR"), Some("/claude-home"));
        assert_eq!(get("MCP_CONNECTION_NONBLOCKING"), Some("0"));
        assert_eq!(get(AGENT_THREAD_ENV), Some("thread-1"));
        assert!(REMOVED_ENV.contains(&"CLAUDECODE"));
        let fresh = env_changes(&config, &input(false), |_| false);
        assert!(!fresh.iter().any(|(k, _)| k == "MCP_CONNECTION_NONBLOCKING"));
    }

    #[test]
    fn permission_modes_follow_the_runtime_policy() {
        assert_eq!(
            permission_mode("full-access", "default"),
            "bypassPermissions"
        );
        assert_eq!(permission_mode("approval-required", "default"), "default");
        assert_eq!(
            permission_mode("auto-accept-edits", "default"),
            "acceptEdits"
        );
        assert_eq!(permission_mode("auto", "default"), "auto");
        assert_eq!(permission_mode("full-access", "plan"), "plan");
    }
}
