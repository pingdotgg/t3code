//! Text generation through `codex exec`, as `CodexTextGeneration.ts` (`runCodexJson`) runs it:
//! one short-lived CLI process per request, not the shared app-server.
//!
//! 1. `codex <profile and config launch args> --config features.plugins=false --config
//!    features.apps=false mcp list --json` (10 s) names the enabled MCP servers, so the exec
//!    turns them off: a user's MCP server could act on the prompt.
//! 2. `codex exec … --ephemeral --skip-git-repo-check -s read-only --model <m> --config
//!    model_reasoning_effort="<e>" --config features.codex_hooks=false --config
//!    features.hooks=false [--config service_tier="<t>"] --output-schema <file>
//!    --output-last-message <file> [--image <path>]… -` reads the prompt on stdin and writes
//!    its last message, a JSON object, to the output file (180 s).
//!
//! The environment is the server's, the instance's entries, and `CODEX_HOME` when a home is
//! set, after the originator (`codexAppServerEnvironment`, #38464), which the server's or the
//! instance's environment overrides. The schema and output
//! files sit in their own temporary folders, named as T3 names them, and are removed after.

use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use conn_contract::{ModelSelection, to_json};
use conn_provider::{ProviderError, TextGenerationRequest};
use serde_json::Value;
use tokio::{io::AsyncReadExt, io::AsyncWriteExt, process::Command};

use crate::launch::{self, CodexConfig};

/// `CODEX_TIMEOUT_MS`.
pub const EXEC_TIMEOUT: Duration = Duration::from_secs(180);
/// `CODEX_MCP_LIST_TIMEOUT_MS`.
pub const MCP_LIST_TIMEOUT: Duration = Duration::from_secs(10);
/// `forceKillAfter: "1 second"`: SIGTERM, then SIGKILL after this.
const FORCE_KILL_AFTER: Duration = Duration::from_secs(1);
/// `DEFAULT_TEXT_GENERATION_REASONING_EFFORT`.
const DEFAULT_EFFORT: &str = "low";
/// `CODEX_NO_PLUGIN_ARGS`: plugins and apps add MCP servers.
const NO_PLUGIN_ARGS: [&str; 4] = [
    "--config",
    "features.plugins=false",
    "--config",
    "features.apps=false",
];
/// The most of stdout or stderr kept from one CLI run; T3 keeps all of it.
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

fn failed(detail: impl Into<String>) -> ProviderError {
    ProviderError::Failed {
        operation: "generate_text",
        detail: detail.into(),
    }
}

/// Which launch args a command keeps (`LaunchArgFilter` in `codexLaunchArgs.ts`).
struct ArgFilter {
    switches: &'static [&'static str],
    value_flags: &'static [&'static str],
    inline_prefixes: &'static [&'static str],
}

/// `MCP_LIST_FILTER`.
const MCP_LIST_FILTER: ArgFilter = ArgFilter {
    switches: &[],
    value_flags: &["--config", "-c", "--enable", "--disable", "--profile", "-p"],
    inline_prefixes: &[
        "--config=",
        "-c=",
        "--enable=",
        "--disable=",
        "--profile=",
        "-p=",
    ],
};

/// `EXEC_FILTER`.
const EXEC_FILTER: ArgFilter = ArgFilter {
    switches: &["--strict-config", "--oss"],
    value_flags: &[
        "--config",
        "-c",
        "--enable",
        "--disable",
        "--local-provider",
        "--profile",
        "-p",
    ],
    inline_prefixes: &[
        "--config=",
        "-c=",
        "--enable=",
        "--disable=",
        "--local-provider=",
        "--profile=",
        "-p=",
    ],
};

/// `filterLaunchArgs`.
fn filter_launch_args(launch_args: &str, filter: &ArgFilter) -> Vec<String> {
    let args = launch::tokenize_cli_args(launch_args);
    let mut kept = Vec::new();
    let mut iter = args.into_iter().peekable();
    while let Some(arg) = iter.next() {
        if filter.switches.contains(&arg.as_str()) {
            kept.push(arg);
        } else if filter.value_flags.contains(&arg.as_str()) {
            if let Some(value) = iter.next_if(|v| !v.starts_with('-')) {
                kept.push(arg);
                kept.push(value);
            }
        } else if filter.inline_prefixes.iter().any(|p| arg.starts_with(p)) {
            kept.push(arg);
        }
    }
    kept
}

/// `codexMcpServersOff`: `mcp_servers={...}` merges, so each named server is turned off.
fn mcp_servers_off(names: &[String]) -> Option<String> {
    if names.is_empty() {
        return None;
    }
    let entries: Vec<String> = names
        .iter()
        .map(|name| format!("{}={{enabled=false}}", Value::String(name.clone())))
        .collect();
    Some(format!("mcp_servers={{{}}}", entries.join(",")))
}

/// `codexMcpServerOffFlags`: dotted flags only for names Codex does not split.
fn mcp_server_off_flags(names: &[String]) -> Vec<String> {
    names
        .iter()
        .filter(|name| !name.contains('.') && !name.contains('='))
        .flat_map(|name| {
            [
                "--config".to_owned(),
                format!("mcp_servers.{name}.enabled=false"),
            ]
        })
        .collect()
}

/// `codexModelFamily`.
fn model_family(slug: &str) -> &str {
    if slug.starts_with("openai.gpt-") {
        slug.strip_prefix("openai.").unwrap_or(slug)
    } else {
        slug
    }
}

/// The model `codex exec` runs: the requested one when the catalog lists it, else one of its
/// family, else the catalog's first; and whether that fell back (the selection's options then
/// do not apply).
pub fn exec_model(requested: &str, models: &[(String, String)]) -> (String, bool) {
    let family = model_family(requested);
    let matched = models
        .iter()
        .find(|(slug, _)| slug == requested)
        .or_else(|| models.iter().find(|(slug, _)| model_family(slug) == family))
        .map(|(slug, _)| slug.clone());
    match matched {
        Some(model) => (model, false),
        None => {
            let model = models
                .first()
                .map_or_else(|| requested.to_owned(), |(slug, _)| slug.clone());
            let fell_back = model != requested;
            (model, fell_back)
        }
    }
}

/// The launch args: `T3CODE_CODEX_LAUNCH_ARGS` of the instance or the server, else the
/// setting (`resolveCodexLaunchArgs` over the merged environment).
fn launch_args(config: &CodexConfig) -> String {
    let from_instance = config
        .instance_env
        .iter()
        .rev()
        .find(|(key, _)| key == launch::LAUNCH_ARGS_ENV)
        .map(|(_, value)| value.clone());
    from_instance
        .or_else(|| {
            conn_support::login_env::var_os(launch::LAUNCH_ARGS_ENV)
                .and_then(|v| v.into_string().ok())
        })
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| config.launch_args.trim().to_owned())
}

/// The environment the CLI gets on top of the server's: the originator (T3's
/// `codexAppServerEnvironment`, unless the server's environment sets one), the instance's
/// entries, then `CODEX_HOME` when a home is set.
fn env_set(config: &CodexConfig) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if conn_support::login_env::var_os(launch::ORIGINATOR_ENV).is_none() {
        env.push((
            launch::ORIGINATOR_ENV.to_owned(),
            launch::CLIENT_NAME.to_owned(),
        ));
    }
    env.extend(config.instance_env.0.iter().cloned());
    if let Some(home) = &config.home_path {
        env.push((
            "CODEX_HOME".to_owned(),
            launch::expand_home(home).to_string_lossy().into_owned(),
        ));
    }
    env
}

/// The `codex exec` argv after the binary.
#[expect(clippy::too_many_arguments, reason = "every input of T3's argv")]
pub fn exec_args(
    launch_args: &str,
    enabled_mcp: &[String],
    model: &str,
    effort: &str,
    service_tier: Option<&str>,
    schema_path: &Path,
    output_path: &Path,
    image_paths: &[PathBuf],
) -> Vec<String> {
    let off = mcp_servers_off(enabled_mcp);
    let exec_launch = exec_launch_args(launch_args);
    let launch_sets_table = exec_launch.iter().any(|arg| {
        arg.match_indices("mcp_servers").any(|(at, _)| {
            let before_ok = arg[..at]
                .chars()
                .next_back()
                .is_none_or(|c| !(c.is_alphanumeric() || c == '_'));
            let rest = arg[at + "mcp_servers".len()..].trim_start();
            before_ok && rest.starts_with('=')
        })
    });
    let mut args = vec!["exec".to_owned()];
    if let Some(off) = &off {
        args.extend(["--config".to_owned(), off.clone()]);
    }
    args.extend(exec_launch);
    args.extend(NO_PLUGIN_ARGS.map(str::to_owned));
    if let Some(off) = off.as_ref().filter(|_| launch_sets_table) {
        args.extend(["--config".to_owned(), off.clone()]);
    }
    args.extend(mcp_server_off_flags(enabled_mcp));
    args.extend(
        [
            "--ephemeral",
            "--skip-git-repo-check",
            "-s",
            "read-only",
            "--model",
        ]
        .map(str::to_owned),
    );
    args.push(model.to_owned());
    args.push("--config".to_owned());
    args.push(format!("model_reasoning_effort=\"{effort}\""));
    // Current Codex gives hooks precedence over the historical codex_hooks alias.
    args.extend(
        [
            "--config",
            "features.codex_hooks=false",
            "--config",
            "features.hooks=false",
        ]
        .map(str::to_owned),
    );
    if let Some(tier) = service_tier {
        args.push("--config".to_owned());
        args.push(format!("service_tier=\"{tier}\""));
    }
    args.push("--output-schema".to_owned());
    args.push(schema_path.to_string_lossy().into_owned());
    args.push("--output-last-message".to_owned());
    args.push(output_path.to_string_lossy().into_owned());
    for image in image_paths {
        args.push("--image".to_owned());
        args.push(image.to_string_lossy().into_owned());
    }
    args.push("-".to_owned());
    args
}

/// A selection option's string value.
fn option(selection: &ModelSelection, id: &str) -> Option<String> {
    to_json(selection)["options"]
        .as_array()?
        .iter()
        .find(|o| o["id"] == id)
        .and_then(|o| o["value"].as_str().map(str::to_owned))
}

/// `getCodexServiceTierOptionValue`: `serviceTier`, or `fast` for `fastMode`.
fn service_tier(selection: &ModelSelection) -> Option<String> {
    option(selection, "serviceTier").or_else(|| {
        let fast = to_json(selection)["options"]
            .as_array()?
            .iter()
            .any(|o| o["id"] == "fastMode" && o["value"] == true);
        fast.then(|| "fast".to_owned())
    })
}

/// What one CLI run ended with.
struct Ran {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Reads at most [`MAX_OUTPUT_BYTES`] of a pipe, then drains the rest.
async fn read_bounded(mut pipe: impl tokio::io::AsyncRead + Unpin) -> String {
    let mut kept = Vec::new();
    // On the heap: a buffer held across an await would make every caller's future large.
    let mut chunk = vec![0u8; 8192];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = MAX_OUTPUT_BYTES.saturating_sub(kept.len());
                kept.extend_from_slice(chunk.get(..n.min(room)).unwrap_or_default());
            }
        }
    }
    String::from_utf8_lossy(&kept).into_owned()
}

/// Runs one CLI command in its own process group: `stdin` written whole, then closed.
/// `Ok(None)` when `timeout` passed; the group then gets SIGTERM, and SIGKILL a second later.
async fn run(
    program: &Path,
    args: &[String],
    env: &[(String, String)],
    cwd: &str,
    stdin: Option<&str>,
    timeout: Duration,
) -> Result<Option<Ran>, std::io::Error> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .envs(conn_support::login_env::vars());
    #[cfg(unix)]
    command.process_group(0);
    for (key, value) in env {
        command.env(key, value);
    }
    conn_support::spawn_guard::check(command.as_std());
    let mut child = command.spawn()?;
    let pid = child.id().unwrap_or(0);
    let input = child.stdin.take();
    let prompt = stdin.map(str::to_owned);
    let writer = async move {
        if let (Some(mut pipe), Some(prompt)) = (input, prompt) {
            let _ = pipe.write_all(prompt.as_bytes()).await;
            let _ = pipe.shutdown().await;
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let work = async {
        let (_, out, err, status) = tokio::join!(
            writer,
            async {
                match stdout {
                    Some(pipe) => read_bounded(pipe).await,
                    None => String::new(),
                }
            },
            async {
                match stderr {
                    Some(pipe) => read_bounded(pipe).await,
                    None => String::new(),
                }
            },
            child.wait(),
        );
        (out, err, status)
    };
    match tokio::time::timeout(timeout, work).await {
        Ok((stdout, stderr, status)) => Ok(Some(Ran {
            code: status.ok().and_then(|s| s.code()),
            stdout,
            stderr,
        })),
        Err(_) => {
            #[cfg(unix)]
            conn_provider_support::process::signal_group(pid, rustix::process::Signal::TERM);
            if tokio::time::timeout(FORCE_KILL_AFTER, child.wait())
                .await
                .is_err()
            {
                let _ = child.kill().await;
            }
            #[cfg(not(unix))]
            let _ = pid;
            Ok(None)
        }
    }
}

/// `listEnabledMcpServers`: the enabled MCP servers' names, or none when the list fails.
async fn enabled_mcp_servers(
    binary: &Path,
    launch_args: &str,
    env: &[(String, String)],
    cwd: &str,
) -> Vec<String> {
    let mut args = filter_launch_args(launch_args, &MCP_LIST_FILTER);
    args.extend(NO_PLUGIN_ARGS.map(str::to_owned));
    args.extend(["mcp", "list", "--json"].map(str::to_owned));
    let ran = match run(binary, &args, env, cwd, None, MCP_LIST_TIMEOUT).await {
        Ok(Some(ran)) => ran,
        Ok(None) => {
            eprintln!(
                "conn-provider-codex: codex mcp list timed out; text generation keeps its MCP servers"
            );
            return Vec::new();
        }
        Err(_) => return Vec::new(),
    };
    if ran.code != Some(0) {
        eprintln!(
            "conn-provider-codex: codex mcp list failed; text generation keeps its MCP servers"
        );
        return Vec::new();
    }
    let Ok(Value::Array(servers)) = serde_json::from_str::<Value>(&ran.stdout) else {
        eprintln!(
            "conn-provider-codex: codex mcp list failed; text generation keeps its MCP servers"
        );
        return Vec::new();
    };
    servers
        .iter()
        .filter(|s| s["enabled"] == true)
        .filter_map(|s| s["name"].as_str().map(str::to_owned))
        .collect()
}

/// `makeTempFile({prefix})`: an empty file named with 12 hex digits in a new folder
/// `<tmp>/<prefix><6 characters>` (Node's `mkdtemp`).
fn temp_file(prefix: &str, content: &str) -> std::io::Result<PathBuf> {
    let base = std::env::temp_dir();
    let random: String = conn_support::uuid_v4()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    let dir_suffix: String = random.chars().take(6).collect();
    let name: String = random.chars().skip(6).take(12).collect();
    let dir = base.join(format!("{prefix}{dir_suffix}"));
    std::fs::create_dir(&dir)?;
    let file = dir.join(name);
    if let Err(e) = std::fs::write(&file, content) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
    Ok(file)
}

fn remove_temp_dir(file: &Path) {
    if let Some(dir) = file.parent() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// `runCodexJson`: the request's answer, a JSON object.
pub async fn generate(
    config: &CodexConfig,
    models: &[(String, String)],
    request: TextGenerationRequest,
) -> Result<Value, ProviderError> {
    let schema = request.output_schema.clone();
    let pid = std::process::id();
    let files = tokio::task::spawn_blocking(move || {
        let schema_path = temp_file(&format!("t3code-codex-schema-{pid}-"), &schema)?;
        match temp_file(&format!("t3code-codex-output-{pid}-"), "") {
            Ok(output_path) => Ok((schema_path, output_path)),
            Err(e) => {
                remove_temp_dir(&schema_path);
                Err(e)
            }
        }
    })
    .await
    .map_err(|_| failed("Failed to write temp file"))?
    .map_err(|_| failed("Failed to write temp file"))?;
    let (schema_path, output_path) = files;
    let result = run_exec(config, models, &request, &schema_path, &output_path).await;
    let cleanup = (schema_path, output_path.clone());
    let output = match result {
        Ok(()) => tokio::task::spawn_blocking(move || std::fs::read_to_string(&output_path))
            .await
            .ok()
            .and_then(Result::ok)
            .ok_or_else(|| failed("Failed to read Codex output file.")),
        Err(e) => Err(e),
    };
    let _ = tokio::task::spawn_blocking(move || {
        remove_temp_dir(&cleanup.0);
        remove_temp_dir(&cleanup.1);
    })
    .await;
    match serde_json::from_str::<Value>(&output?) {
        Ok(value) if value.is_object() => Ok(value),
        _ => Err(failed("Codex returned invalid structured output.")),
    }
}

async fn run_exec(
    config: &CodexConfig,
    models: &[(String, String)],
    request: &TextGenerationRequest,
    schema_path: &Path,
    output_path: &Path,
) -> Result<(), ProviderError> {
    let requested = launch::selection_model(&request.model_selection);
    let (model, fell_back) = exec_model(&requested, models);
    let effort = (!fell_back)
        .then(|| option(&request.model_selection, "reasoningEffort"))
        .flatten()
        .unwrap_or_else(|| DEFAULT_EFFORT.to_owned());
    let tier = (!fell_back)
        .then(|| service_tier(&request.model_selection))
        .flatten();
    let launch_args = launch_args(config);
    let env = env_set(config);
    let binary = if config.binary.as_os_str().is_empty() {
        PathBuf::from("codex")
    } else {
        launch::expand_home(&config.binary)
    };
    let enabled = enabled_mcp_servers(&binary, &launch_args, &env, &request.cwd).await;
    let args = exec_args(
        &launch_args,
        &enabled,
        &model,
        &effort,
        tier.as_deref(),
        schema_path,
        output_path,
        &request.image_paths,
    );
    let timeout = request.timeout.unwrap_or(EXEC_TIMEOUT);
    let ran = match run(
        &binary,
        &args,
        &env,
        &request.cwd,
        Some(&request.prompt),
        timeout,
    )
    .await
    {
        Ok(Some(ran)) => ran,
        Ok(None) => return Err(failed("Codex CLI request timed out.")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(failed(
                "Codex CLI (`codex`) is required but not available on PATH.",
            ));
        }
        Err(_) => return Err(failed("Failed to spawn Codex CLI process")),
    };
    if ran.code != Some(0) {
        let stderr = ran.stderr.trim();
        let detail = if stderr.is_empty() {
            ran.stdout.trim()
        } else {
            stderr
        };
        return Err(failed(if detail.is_empty() {
            format!(
                "Codex CLI command failed with code {}.",
                ran.code
                    .map_or_else(|| "null".to_owned(), |c| c.to_string())
            )
        } else {
            format!("Codex CLI command failed: {detail}")
        }));
    }
    Ok(())
}

/// `codexExecLaunchArgs`: the exec filter, without a launch arg that enables hooks. Feature
/// toggles beat config overrides, so a launch arg's hook enable would undo ours.
fn exec_launch_args(launch_args: &str) -> Vec<String> {
    const HOOK_FEATURES: [&str; 2] = ["hooks", "codex_hooks"];
    let args = filter_launch_args(launch_args, &EXEC_FILTER);
    let hook = |name: Option<&String>| name.is_some_and(|n| HOOK_FEATURES.contains(&n.as_str()));
    args.iter()
        .enumerate()
        .filter(|&(index, arg)| {
            if let Some(feature) = arg.strip_prefix("--enable=") {
                return !HOOK_FEATURES.contains(&feature);
            }
            if arg == "--enable" {
                return !hook(args.get(index + 1));
            }
            let after_enable = index
                .checked_sub(1)
                .and_then(|i| args.get(i))
                .is_some_and(|a| a == "--enable");
            !(after_enable && HOOK_FEATURES.contains(&arg.as_str()))
        })
        .map(|(_, arg)| arg.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_launch_args_drop_a_hook_enable() {
        let args = "--enable hooks --enable=codex_hooks --enable x --enable=y -c a=1";
        assert_eq!(
            exec_launch_args(args),
            ["--enable", "x", "--enable=y", "-c", "a=1"]
        );
    }

    #[test]
    fn launch_args_are_filtered_as_t3() {
        let args = "--profile work -c a=1 --oss --search --enable x --config=b=2 --model y -p";
        assert_eq!(
            filter_launch_args(args, &EXEC_FILTER),
            [
                "--profile",
                "work",
                "-c",
                "a=1",
                "--oss",
                "--enable",
                "x",
                "--config=b=2"
            ]
        );
        assert_eq!(
            filter_launch_args(args, &MCP_LIST_FILTER),
            [
                "--profile",
                "work",
                "-c",
                "a=1",
                "--enable",
                "x",
                "--config=b=2"
            ]
        );
    }

    #[test]
    fn mcp_servers_are_turned_off_as_t3() {
        let names = ["t3-code".to_owned(), "a.b".to_owned()];
        assert_eq!(
            mcp_servers_off(&names).as_deref(),
            Some(r#"mcp_servers={"t3-code"={enabled=false},"a.b"={enabled=false}}"#)
        );
        assert_eq!(
            mcp_server_off_flags(&names),
            ["--config", "mcp_servers.t3-code.enabled=false"]
        );
    }

    #[test]
    fn the_exec_model_falls_back_as_t3() {
        let models = [
            ("gpt-6-luna".to_owned(), "GPT-6-Luna".to_owned()),
            ("gpt-6-astra".to_owned(), "GPT-6-Astra".to_owned()),
        ];
        assert_eq!(
            exec_model("gpt-6-astra", &models),
            ("gpt-6-astra".into(), false)
        );
        assert_eq!(
            exec_model("openai.gpt-6-astra", &models),
            ("gpt-6-astra".into(), false)
        );
        assert_eq!(exec_model("other", &models), ("gpt-6-luna".into(), true));
        assert_eq!(exec_model("other", &[]), ("other".into(), false));
    }
}
