//! A Mac (or Linux machine) reached over SSH: the main path for a server in a Linux container.
//! Follows `SshDeviceHost.ts`: a Node bootstrap on the host installs and starts the hub and the
//! agent-device daemon in `~/.t3/device/hosts/<owner>`, and one `ssh -L` forwards both to
//! loopback here. Every ssh argv and stdin is T3's (the conformance check compares them).

use std::{
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::Deserialize;
use serde_json::Value;
use tokio::io::AsyncReadExt as _;

use crate::{
    generated,
    host::{AgentEndpoint, Helpers, HostError, HostErrorKind, OnPhase, Ready, RunResult, Runner},
    http,
    model::{Availability, HostSummary},
    process::Run,
    tools::install_message,
};

const UNHEALTHY_PROBE_LIMIT: u32 = 3;
const DEFAULT_SSH_TIMEOUT_MS: u64 = 60_000;
const NODE_BOOTSTRAP: &str = r#"command -v node >/dev/null 2>&1 || { echo "Node is missing from the non-interactive SSH PATH" >&2; exit 1; }; exec node"#;
const NODE_MISSING: &str = "Node is missing from the non-interactive SSH PATH";

/// `SshDeviceHostConfig`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub id: String,
    pub label: String,
    pub target: String,
    #[serde(default)]
    pub identity_file: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
}

/// `quoteRemoteArg`.
pub(crate) fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn command_args(script: &str) -> Vec<String> {
    vec![
        "sh".into(),
        "-c".into(),
        quote(&format!("{}{script}", generated::REMOTE_ENVIRONMENT)),
    ]
}

/// `remoteDeviceScript(owner, mode)`.
pub(crate) fn remote_script(owner: &str, mode: &str) -> String {
    generated::REMOTE_SCRIPT
        .replacen("\"@@OWNER@@\"", &Value::from(owner).to_string(), 1)
        .replacen("\"@@MODE@@\"", &Value::from(mode).to_string(), 1)
}

/// `baseSshArgs`.
fn base_args(config: &SshConfig) -> Vec<String> {
    let mut args: Vec<String> = [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "RemoteCommand=none",
        "-o",
        "RequestTTY=no",
    ]
    .map(String::from)
    .to_vec();
    if let Some(port) = config.port {
        args.extend(["-p".into(), port.to_string()]);
    }
    args
}

fn identity_args(config: &SshConfig) -> Vec<String> {
    config
        .identity_file
        .iter()
        .flat_map(|file| ["-i".to_owned(), file.clone()])
        .collect()
}

/// What `runSshCommand` failed with.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SshFailure {
    /// `None` for a timeout or a spawn failure.
    pub(crate) exit_code: Option<i32>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) message: String,
}

/// `runSshCommand`: `ssh <base> -o ServerAliveInterval=15 … <pre> -- <target> <remote>`.
pub(crate) async fn run_ssh(
    config: &SshConfig,
    pre_host: &[String],
    remote: &[String],
    stdin: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<(String, String), SshFailure> {
    let mut args = base_args(config);
    args.extend(
        [
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
        ]
        .map(String::from),
    );
    args.extend(pre_host.iter().cloned());
    args.push("--".into());
    args.push(config.target.trim().to_owned());
    args.extend(remote.iter().cloned());
    let timeout = timeout_ms.unwrap_or(DEFAULT_SSH_TIMEOUT_MS);
    let mut run = Run::new("ssh", args).timeout(Duration::from_millis(timeout));
    // T3 always opens stdin for ssh; empty when it sends nothing.
    run.stdin = Some(stdin.unwrap_or_default());
    let out = run.output().await;
    if out.timed_out {
        return Err(SshFailure {
            exit_code: None,
            stdout: out.stdout,
            stderr: out.stderr,
            message: format!("SSH command timed out after {timeout}ms."),
        });
    }
    if let Some(error) = &out.spawn_error {
        return Err(SshFailure {
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            message: error.clone(),
        });
    }
    match out.code {
        Some(0) => Ok((out.stdout, out.stderr)),
        code => {
            let message = if !out.stderr.trim().is_empty() {
                out.stderr.trim().to_owned()
            } else if !out.stdout.trim().is_empty() {
                out.stdout.trim().to_owned()
            } else {
                format!(
                    "SSH command failed for {} (exit {}).",
                    config.target.trim(),
                    code.unwrap_or(-1)
                )
            };
            Err(SshFailure {
                exit_code: code,
                stdout: out.stdout,
                stderr: out.stderr,
                message,
            })
        }
    }
}

/// Why ssh itself refused before the bootstrap ran (`SshConnectError`), from exit 255.
fn connect_failure(config: &SshConfig, failure: &SshFailure) -> Option<String> {
    if failure.exit_code != Some(255) {
        return None;
    }
    let lines: Vec<&str> = failure.stderr.lines().map(str::trim).collect();
    let find =
        |test: &dyn Fn(&str) -> bool| lines.iter().find(|l| test(l)).map(|l| (*l).to_owned());
    let here = "the machine running this T3 Code server";
    let target = &config.target;
    if find(&|l| l.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")).is_some() {
        return Some(format!(
            "SSH encountered a changed host key while connecting to {target} from {here}. Connect once with ssh from there to identify the affected host. If the change is expected, remove that host's old key with `ssh-keygen -R`, then verify and accept its new key."
        ));
    }
    if find(&|l| l == "Host key verification failed.").is_some() {
        return Some(format!(
            "SSH encountered an untrusted host key while connecting to {target} from {here}. Connect once with ssh from there to identify the host and verify its key before accepting it."
        ));
    }
    let auth = find(&|l| {
        let mut words = l.splitn(2, ": ");
        let first = words.next().unwrap_or_default();
        let rest = words.next().unwrap_or_default();
        (!first.is_empty()
            && !first.contains(char::is_whitespace)
            && (rest.starts_with("Permission denied (")
                || rest.starts_with("No supported authentication methods")))
            || l.ends_with(": Too many authentication failures")
    });
    if let Some(detail) = auth {
        return Some(format!(
            "SSH login failed while connecting to {target}: {}. SSH from {here} must log in without a prompt.",
            detail.trim_end_matches('.')
        ));
    }
    if let Some(detail) = find(&|l| l.starts_with("ssh: Could not resolve hostname ")) {
        return Some(format!(
            "Could not resolve the host name {target} from {here}: {}.",
            detail.trim_end_matches('.')
        ));
    }
    if let Some(detail) = find(&|l| l.starts_with("ssh: connect to host ")) {
        return Some(format!(
            "Could not reach {target} from {here}: {}. Check that the host is on, its SSH server is running, and the address and port are right.",
            detail.trim_end_matches('.')
        ));
    }
    None
}

const WINDOWS_HOST: &str = "Connected over SSH, but this host runs Windows, and SSH device hosts currently need macOS or Linux. To use this machine's devices, run T3 Code on it and connect to that environment.";

fn remote_exit(failure: &SshFailure) -> bool {
    matches!(failure.exit_code, Some(code) if (1..=254).contains(&code) || code == 9009)
}

/// `explainWindowsHost`: two cheap checks after a failed bootstrap.
async fn is_windows(config: &SshConfig) -> bool {
    let identity = identity_args(config);
    if let Ok((stdout, _)) = run_ssh(
        config,
        &identity,
        &["echo %OS% $env:OS".to_owned()],
        None,
        Some(15_000),
    )
    .await
        && stdout.split_whitespace().any(|w| w == "Windows_NT")
    {
        return true;
    }
    matches!(
        run_ssh(
            config,
            &identity,
            &["node".into(), "-p".into(), "process.platform".into()],
            None,
            Some(15_000),
        )
        .await,
        Ok((stdout, _)) if stdout.trim() == "win32"
    )
}

/// `sshProbeFailureMessage`.
pub(crate) fn probe_failure_message(kind: &HostErrorKind) -> String {
    match kind {
        HostErrorKind::SshConnect(message) => message.clone(),
        HostErrorKind::SshWindows => WINDOWS_HOST.into(),
        HostErrorKind::Ssh(failure) => {
            if !remote_exit(failure) {
                return "Could not connect to this host over SSH.".into();
            }
            if failure.exit_code == Some(1)
                && failure.stderr.lines().any(|l| l.trim() == NODE_MISSING)
            {
                return "Connected over SSH, but Node is not on this host's PATH for non-interactive SSH commands.".into();
            }
            format!(
                "Connected over SSH, but the device host check failed (exit code {}).",
                failure.exit_code.unwrap_or_default()
            )
        }
        _ => "Could not connect to this host over SSH.".into(),
    }
}

async fn bootstrap(config: &SshConfig, owner: &str, mode: &str) -> Result<String, HostError> {
    let timeout = if matches!(mode, "start" | "agent-start") {
        1_300_000
    } else {
        45_000
    };
    run_ssh(
        config,
        &identity_args(config),
        &command_args(NODE_BOOTSTRAP),
        Some(remote_script(owner, mode)),
        Some(timeout),
    )
    .await
    .map(|(stdout, _)| stdout)
    .map_err(|failure| HostError::new(&config.id, mode, HostErrorKind::Ssh(Box::new(failure))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Probe {
    #[serde(rename = "nodePath")]
    _node_path: String,
    tools: Option<Value>,
    platforms: Vec<Availability>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Started {
    node_path: String,
    tools: Option<Value>,
    platforms: Vec<Availability>,
    hub_port: u16,
    daemon_port: Option<u16>,
    token: Option<String>,
    entry_path: Option<String>,
    helpers: StartedHelpers,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartedHelpers {
    serve_sim_ax_settings: Option<String>,
    serve_sim_cli: Option<String>,
}

fn installed(tools: Option<&Value>, key: &str) -> bool {
    tools.and_then(|t| t.get(key)).is_some_and(|tool| {
        let required = tool.get("requiredVersion");
        tool.get("installedVersions")
            .and_then(Value::as_array)
            .is_some_and(|list| required.is_some_and(|r| list.contains(r)))
    })
}

/// `SshDeviceHost.probe`: what the host can run, without starting anything.
pub(crate) async fn probe(config: &SshConfig, owner: &str) -> Result<HostSummary, HostError> {
    let stdout = match bootstrap(config, owner, "probe").await {
        Ok(stdout) => stdout,
        Err(error) => return Err(explain(config, error).await),
    };
    let value: Probe = serde_json::from_str(stdout.trim()).map_err(|e| {
        HostError::new(
            &config.id,
            "reading probe result",
            HostErrorKind::Other(e.to_string()),
        )
    })?;
    Ok(HostSummary {
        id: config.id.clone(),
        label: config.label.clone(),
        kind: "ssh",
        hub_installed: installed(value.tools.as_ref(), "hub"),
        agent_device_installed: installed(value.tools.as_ref(), "agent"),
        tools: value.tools,
        tool_inspection_error: None,
        platforms: value.platforms,
    })
}

async fn explain(config: &SshConfig, error: HostError) -> HostError {
    let HostErrorKind::Ssh(failure) = &error.kind else {
        return error;
    };
    if let Some(message) = connect_failure(config, failure) {
        return HostError::new(&config.id, &error.step, HostErrorKind::SshConnect(message));
    }
    if remote_exit(failure) && is_windows(config).await {
        return HostError::new(&config.id, &error.step, HostErrorKind::SshWindows);
    }
    error
}

/// `ownerFor`: one remote state folder per environment, state folder and host.
pub(crate) fn owner(environment_id: &str, state_dir: &str, host_id: &str) -> String {
    let digest =
        conn_support::hmac::sha256(format!("{environment_id}\0{state_dir}\0{host_id}").as_bytes());
    let mut hex = conn_support::hex::hex(&digest);
    hex.truncate(24);
    hex
}

/// Runs a command in the host's state folder (`run` in `SshDeviceHost.ts`).
pub(crate) async fn run_remote(
    config: &SshConfig,
    owner: &str,
    command: &str,
    args: &[String],
    stdin: Option<String>,
    timeout_ms: Option<u64>,
) -> RunResult {
    let words: Vec<String> = std::iter::once(command)
        .chain(args.iter().map(String::as_str))
        .map(quote)
        .collect();
    let script = format!(
        "cd \"$HOME/.t3/device/hosts/{owner}\" && exec {}",
        words.join(" ")
    );
    match run_ssh(
        config,
        &identity_args(config),
        &command_args(&script),
        stdin,
        timeout_ms,
    )
    .await
    {
        Ok((stdout, stderr)) => RunResult {
            stdout,
            stderr,
            code: 0,
        },
        Err(failure) => RunResult {
            stdout: failure.stdout,
            stderr: failure.message,
            code: i64::from(failure.exit_code.unwrap_or(127)),
        },
    }
}

fn reserve_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

/// The ssh forward that carries the hub and the daemon. Dropping it ends the ssh process.
struct Tunnel {
    generation: u64,
    _stop: tokio::sync::oneshot::Sender<()>,
}

pub(crate) type StatusHook = Box<dyn Fn(&str, Option<String>) + Send + Sync>;
/// Writes the daemon's config file off the runtime thread.
pub(crate) type AgentReadyHook =
    Box<dyn Fn(AgentEndpoint) -> crate::BoxFuture<'static, Result<(), String>> + Send + Sync>;

/// Callbacks into the device service.
pub(crate) struct Hooks {
    /// `onStatus`: `starting`, `ready` or `failed`, with a detail.
    pub(crate) status: StatusHook,
    /// `onReady`: writes the agent-device config for a shared daemon.
    pub(crate) agent_ready: AgentReadyHook,
}

struct Inner {
    stopped: bool,
    activated: bool,
    wants_agent: bool,
    ready: Option<Ready>,
    tunnel: Option<Tunnel>,
    generation: u64,
    summary: HostSummary,
}

pub(crate) struct SshHost {
    pub(crate) config: SshConfig,
    owner: String,
    pub(crate) hooks: Hooks,
    lock: tokio::sync::Mutex<()>,
    inner: Mutex<Inner>,
}

impl std::fmt::Debug for SshHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshHost")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl SshHost {
    pub(crate) fn new(config: SshConfig, owner: String, hooks: Hooks) -> Arc<Self> {
        let summary = HostSummary::empty(&config.id, &config.label, "ssh");
        Arc::new(Self {
            config,
            owner,
            hooks,
            lock: tokio::sync::Mutex::new(()),
            inner: Mutex::new(Inner {
                stopped: false,
                activated: false,
                wants_agent: false,
                ready: None,
                tunnel: None,
                generation: 0,
                summary,
            }),
        })
    }

    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        crate::lock(&self.inner)
    }

    pub(crate) fn summary(&self) -> HostSummary {
        self.inner().summary.clone()
    }

    pub(crate) fn current(&self) -> Option<Ready> {
        self.inner().ready.clone()
    }

    pub(crate) async fn inspect(&self) -> Result<HostSummary, HostError> {
        let summary = probe(&self.config, &self.owner).await?;
        self.inner().summary = summary.clone();
        Ok(summary)
    }

    pub(crate) async fn platform_availability(&self, platform: &str) -> Availability {
        match probe(&self.config, &self.owner).await {
            Ok(value) => {
                let found = value
                    .platforms
                    .iter()
                    .find(|p| p.platform == platform)
                    .cloned();
                self.inner().summary.platforms = value.platforms;
                found.unwrap_or(Availability {
                    platform: platform.into(),
                    available: false,
                    reason: None,
                })
            }
            Err(_) => Availability {
                platform: platform.into(),
                available: false,
                reason: Some(
                    "Cannot reach device host. Test its SSH connection in Settings.".into(),
                ),
            },
        }
    }

    /// Keeps probing a negative report, so tools installed after connecting are found.
    pub(crate) async fn platform_available(&self, platform: &str) -> bool {
        if self.summary().available(platform) {
            return true;
        }
        self.platform_availability(platform).await.available
    }

    pub(crate) async fn ensure_ready(
        self: &Arc<Self>,
        on_phase: &OnPhase<'_>,
    ) -> Result<Ready, HostError> {
        let _guard = self.lock.lock().await;
        self.inner().stopped = false;
        if let Some(ready) = self.current() {
            return Ok(ready);
        }
        let summary = probe(&self.config, &self.owner).await?;
        self.inner().summary = summary.clone();
        if summary.hub_installed {
            on_phase("starting", None);
        } else {
            on_phase(
                "installing",
                Some(install_message(
                    "device hub",
                    summary.tools.as_ref().and_then(|t| t.get("hub")),
                )),
            );
        }
        self.connect().await
    }

    pub(crate) async fn ensure_agent_ready(
        self: &Arc<Self>,
        on_phase: &OnPhase<'_>,
    ) -> Result<Ready, HostError> {
        self.ensure_ready(on_phase).await?;
        let summary = self.summary();
        if summary.agent_device_installed {
            on_phase("starting", None);
        } else {
            on_phase(
                "installing",
                Some(install_message(
                    "agent tools",
                    summary.tools.as_ref().and_then(|t| t.get("agent")),
                )),
            );
        }
        let ready = self.change_agent(true).await?;
        match ready {
            Some(ready) if ready.agent.is_some() => Ok(ready),
            _ => Err(HostError::new(
                &self.config.id,
                "starting agent tools",
                HostErrorKind::Other("Daemon endpoint missing".into()),
            )),
        }
    }

    pub(crate) async fn stop_agent(self: &Arc<Self>) {
        let _ = self.change_agent(false).await;
    }

    async fn change_agent(self: &Arc<Self>, enabled: bool) -> Result<Option<Ready>, HostError> {
        let _guard = self.lock.lock().await;
        let current = {
            let mut inner = self.inner();
            inner.wants_agent = enabled;
            inner.ready.clone()
        };
        match (&current, enabled) {
            (Some(ready), true) if ready.agent.is_some() => return Ok(current),
            (Some(ready), false) if ready.agent.is_none() => return Ok(None),
            (None, false) => return Ok(None),
            _ => {}
        }
        self.close_tunnel();
        if !enabled {
            bootstrap(&self.config, &self.owner, "stop-agent").await?;
        }
        match self.connect().await {
            Ok(ready) => Ok(Some(ready)),
            Err(error) => {
                self.close_tunnel();
                if enabled {
                    let _ = bootstrap(&self.config, &self.owner, "stop-agent").await;
                }
                Err(error)
            }
        }
    }

    pub(crate) async fn stop(&self) {
        let _guard = self.lock.lock().await;
        let activated = {
            let mut inner = self.inner();
            inner.stopped = true;
            inner.ready = None;
            inner.tunnel = None;
            let activated = inner.activated;
            inner.activated = false;
            inner.wants_agent = false;
            activated
        };
        if activated {
            let _ = bootstrap(&self.config, &self.owner, "stop").await;
        }
    }

    fn close_tunnel(&self) {
        let mut inner = self.inner();
        inner.ready = None;
        inner.tunnel = None;
    }

    /// `connect`: up to three tries when a forward lost its port to another process.
    fn connect(self: &Arc<Self>) -> crate::BoxFuture<'_, Result<Ready, HostError>> {
        Box::pin(async move {
            let mut attempt = 0;
            loop {
                match self.connect_once().await {
                    Ok(ready) => return Ok(ready),
                    Err(error) => {
                        self.close_tunnel();
                        let retry = matches!(
                            error.step.as_str(),
                            "forwarding ports" | "waiting for SSH forward"
                        );
                        if attempt >= 2 || !retry {
                            return Err(error);
                        }
                        attempt += 1;
                    }
                }
            }
        })
    }

    async fn connect_once(self: &Arc<Self>) -> Result<Ready, HostError> {
        let id = &self.config.id;
        let wants_agent = {
            let mut inner = self.inner();
            inner.activated = true;
            inner.wants_agent
        };
        let stdout = bootstrap(
            &self.config,
            &self.owner,
            if wants_agent { "agent-start" } else { "start" },
        )
        .await?;
        (self.hooks.status)("starting", None);
        let remote: Started = serde_json::from_str(stdout.trim()).map_err(|e| {
            HostError::new(
                id,
                "reading host endpoints",
                HostErrorKind::Other(e.to_string()),
            )
        })?;
        {
            let mut inner = self.inner();
            let agent_installed = wants_agent || inner.summary.agent_device_installed;
            inner.summary.platforms = remote.platforms.clone();
            inner.summary.tools = remote.tools.clone();
            inner.summary.hub_installed = true;
            inner.summary.agent_device_installed = agent_installed;
        }
        let hub_port = reserve_port().map_err(|e| {
            HostError::new(
                id,
                "reserving hub port",
                HostErrorKind::Other(e.to_string()),
            )
        })?;
        let daemon_port = reserve_port().map_err(|e| {
            HostError::new(
                id,
                "reserving daemon port",
                HostErrorKind::Other(e.to_string()),
            )
        })?;
        let mut args = base_args(&self.config);
        args.extend(identity_args(&self.config));
        args.extend(
            [
                "-o",
                "ExitOnForwardFailure=yes",
                "-o",
                "ControlMaster=no",
                "-o",
                "ControlPath=none",
                "-o",
                "ControlPersist=no",
                "-o",
                "ServerAliveInterval=10",
                "-o",
                "ServerAliveCountMax=3",
                "-T",
                "-L",
            ]
            .map(String::from),
        );
        args.push(format!(
            "127.0.0.1:{hub_port}:127.0.0.1:{}",
            remote.hub_port
        ));
        if let Some(port) = remote.daemon_port {
            args.push("-L".into());
            args.push(format!("127.0.0.1:{daemon_port}:127.0.0.1:{port}"));
        }
        args.push(self.config.target.clone());
        args.push("sh".into());
        args.push("-c".into());
        args.push(quote("exec cat >/dev/null"));
        let mut command = Run::new("ssh", args).command();
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|e| {
            HostError::new(id, "forwarding ports", HostErrorKind::Other(e.to_string()))
        })?;
        let stderr_tail = Arc::new(Mutex::new(String::new()));
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
        let (exit_tx, exit_rx) = tokio::sync::watch::channel(false);
        let generation = {
            let mut inner = self.inner();
            inner.generation += 1;
            let generation = inner.generation;
            inner.tunnel = Some(Tunnel {
                generation,
                _stop: stop_tx,
            });
            generation
        };
        // The server holds the only write end of ssh's stdin; when it goes, the remote `cat`
        // sees EOF and ssh exits.
        let stdin = child.stdin.take();
        let mut stderr = child.stderr.take();
        let tail = stderr_tail.clone();
        tokio::spawn(async move {
            let _stdin = stdin;
            let read = async {
                let Some(stderr) = stderr.as_mut() else {
                    return std::future::pending::<()>().await;
                };
                let mut chunk = [0u8; 4096];
                loop {
                    match stderr.read(&mut chunk).await {
                        Ok(0) | Err(_) => return std::future::pending::<()>().await,
                        Ok(n) => {
                            let mut tail = crate::lock(&tail);
                            tail.push_str(&String::from_utf8_lossy(
                                chunk.get(..n).unwrap_or_default(),
                            ));
                            let excess = tail.len().saturating_sub(2000);
                            if excess > 0 {
                                let cut = (excess..tail.len())
                                    .find(|i| tail.is_char_boundary(*i))
                                    .unwrap_or(0);
                                tail.drain(..cut);
                            }
                        }
                    }
                }
            };
            tokio::select! {
                _ = stop_rx => {}
                _ = child.wait() => {}
                () = read => {}
            }
            let _ = child.start_kill();
            let _ = exit_tx.send(true);
        });
        let hub_origin = format!("http://127.0.0.1:{hub_port}");
        let agent = match (remote.daemon_port, &remote.token, &remote.entry_path) {
            (Some(_), Some(token), Some(entry)) => Some(AgentEndpoint {
                base_url: format!("http://127.0.0.1:{daemon_port}"),
                token: token.clone(),
                entry_path: entry.clone(),
            }),
            _ => None,
        };
        let mut checks = vec![format!("{hub_origin}/readyz")];
        if let Some(agent) = &agent {
            checks.push(format!("{}/health", agent.base_url));
        }
        for url in checks {
            if !http::wait_ready(&url, Duration::from_secs(15)).await {
                let tail = crate::lock(&stderr_tail).clone();
                return Err(HostError::new(
                    id,
                    "waiting for SSH forward",
                    HostErrorKind::Other(if tail.is_empty() {
                        "Forwarded endpoint did not answer.".into()
                    } else {
                        tail
                    }),
                ));
            }
        }
        if let Some(agent) = &agent {
            (self.hooks.agent_ready)(agent.clone()).await.map_err(|e| {
                HostError::new(id, "configuring agent access", HostErrorKind::Other(e))
            })?;
        }
        let ready = Ready {
            host_id: id.clone(),
            hub_origin: hub_origin.clone(),
            node_path: remote.node_path,
            agent,
            helpers: Helpers {
                ax_settings: remote.helpers.serve_sim_ax_settings,
                sim_cli: remote.helpers.serve_sim_cli,
            },
            runner: Runner::Ssh {
                config: self.config.clone(),
                owner: self.owner.clone(),
            },
        };
        self.inner().ready = Some(ready.clone());
        (self.hooks.status)("ready", None);
        let host = Arc::downgrade(self);
        tokio::spawn(watch(host, generation, ready.clone(), exit_rx));
        Ok(ready)
    }

    fn live(&self, generation: u64) -> bool {
        let inner = self.inner();
        !inner.stopped
            && inner
                .tunnel
                .as_ref()
                .is_some_and(|t| t.generation == generation)
    }
}

/// Reconnects when ssh exits or the forward misses three health probes in a row; a loaded host
/// can miss one or two while still working.
async fn watch(
    host: std::sync::Weak<SshHost>,
    generation: u64,
    ready: Ready,
    mut exited: tokio::sync::watch::Receiver<bool>,
) {
    let unhealthy = async {
        let mut misses = 0;
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            let alive = http::ok(
                &format!("{}/readyz", ready.hub_origin),
                Duration::from_secs(5),
            )
            .await;
            let daemon = match &ready.agent {
                Some(agent) => {
                    http::ok(
                        &format!("{}/health", agent.base_url),
                        Duration::from_secs(5),
                    )
                    .await
                }
                None => true,
            };
            misses = if alive && daemon { 0 } else { misses + 1 };
            if misses >= UNHEALTHY_PROBE_LIMIT {
                return;
            }
        }
    };
    tokio::select! {
        _ = exited.wait_for(|e| *e) => {}
        () = unhealthy => {}
    }
    let Some(this) = host.upgrade() else { return };
    if !this.live(generation) {
        return;
    }
    this.close_tunnel();
    (this.hooks.status)("starting", Some("Reconnecting to device host…".into()));
    drop(this);
    let mut delay = 1000;
    loop {
        tokio::time::sleep(Duration::from_millis(delay)).await;
        let Some(this) = host.upgrade() else { return };
        let _guard = this.lock.lock().await;
        let (stopped, connected) = {
            let inner = this.inner();
            (inner.stopped, inner.ready.is_some())
        };
        if stopped || connected {
            return;
        }
        match this.connect().await {
            Ok(_) => return,
            Err(error) => (this.hooks.status)("failed", Some(error.message())),
        }
        delay = (delay * 2).min(30_000);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_like_t3() {
        assert_eq!(quote("a'b"), "'a'\"'\"'b'", "quote");
    }

    #[test]
    fn the_script_takes_owner_and_mode() {
        let script = remote_script("abc", "probe");
        assert!(script.contains("const owner = \"abc\";"), "owner");
        assert!(script.contains("const mode = \"probe\";"), "mode");
        assert!(!script.contains("@@"), "no placeholder left");
    }

    #[test]
    fn explains_ssh_refusals() {
        let config = SshConfig {
            id: "mac".into(),
            label: "Mac".into(),
            target: "mac.local".into(),
            identity_file: None,
            port: None,
        };
        let failure = |stderr: &str| SshFailure {
            exit_code: Some(255),
            stdout: String::new(),
            stderr: stderr.into(),
            message: String::new(),
        };
        assert!(
            connect_failure(&config, &failure("nick@mac.local: Permission denied (publickey)."))
                .is_some_and(|m| m.starts_with("SSH login failed while connecting to mac.local: nick@mac.local: Permission denied (publickey)")),
            "auth"
        );
        assert!(
            connect_failure(
                &config,
                &failure("ssh: connect to host mac.local port 22: Connection refused")
            )
            .is_some_and(|m| m.starts_with("Could not reach mac.local")),
            "connect"
        );
        assert_eq!(
            probe_failure_message(&HostErrorKind::Ssh(Box::new(SshFailure {
                exit_code: Some(1),
                stdout: String::new(),
                stderr: format!("{NODE_MISSING}\n"),
                message: String::new(),
            }))),
            "Connected over SSH, but Node is not on this host's PATH for non-interactive SSH commands.",
            "node missing"
        );
    }
}
