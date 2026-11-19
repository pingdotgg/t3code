//! This machine as a device host (`LocalDeviceHost.ts`): iOS Simulators on a Mac with Xcode,
//! Android Emulators where the SDK is. The hub and the agent-device daemon run as children of
//! the server, from the npm installs in `<base>/tools`.

use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};

use crate::{
    generated::DEVICE_HUB_VERSION,
    host::{
        AgentEndpoint, Helpers, HostError, HostErrorKind, OnPhase, Ready, RunOptions, RunResult,
        Runner,
    },
    http,
    model::{Availability, HostSummary, LOCAL_HOST_ID, LOCAL_HOST_LABEL},
    process::{Run, find_on_path, is_executable},
    tools::{self, InstallError, Tool, blocking, install_message},
};

const HUB_READY_TIMEOUT: Duration = Duration::from_secs(30);
/// How long the hub gets after SIGTERM before it is killed.
const HUB_STOP_GRACE: Duration = Duration::from_secs(5);
const DAEMON_READY_TIMEOUT_MS: u64 = 30_000;

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Sdk {
    pub(crate) root: Option<PathBuf>,
    pub(crate) adb: bool,
    pub(crate) emulator: bool,
    pub(crate) avdmanager: bool,
    pub(crate) legacy_avdmanager: bool,
}

/// Where the server runs and keeps its files.
#[derive(Clone, Debug)]
pub(crate) struct LocalEnv {
    pub(crate) cwd: PathBuf,
    /// The T3 home: tools install under `<base>/tools`.
    pub(crate) base_dir: PathBuf,
    pub(crate) state_dir: PathBuf,
}

impl LocalEnv {
    fn env(name: &str) -> Option<String> {
        std::env::var(name).ok()
    }

    /// `androidSdk`. Blocking: stats files.
    pub(crate) fn sdk(&self) -> Sdk {
        let inspect = |root: &Path| Sdk {
            root: Some(root.to_path_buf()),
            adb: root.join("platform-tools/adb").exists(),
            emulator: root.join("emulator/emulator").exists(),
            avdmanager: root.join("cmdline-tools/latest/bin/avdmanager").exists(),
            legacy_avdmanager: !root.join("cmdline-tools/latest/bin/avdmanager").exists()
                && root.join("tools/bin/avdmanager").exists(),
        };
        let explicit: Vec<PathBuf> = ["ANDROID_HOME", "ANDROID_SDK_ROOT"]
            .iter()
            .filter_map(|name| Self::env(name))
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .collect();
        let home = PathBuf::from(Self::env("HOME").unwrap_or_default());
        let local_app_data = Self::env("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"));
        let candidates = explicit.iter().cloned().chain([
            home.join("Library").join("Android").join("sdk"),
            home.join("Android").join("Sdk"),
            local_app_data.join("Android").join("Sdk"),
        ]);
        for root in candidates {
            let sdk = inspect(&root);
            if sdk.adb || sdk.emulator {
                return sdk;
            }
        }
        for dir in Self::env("PATH").unwrap_or_default().split(':') {
            if dir.is_empty() {
                continue;
            }
            let adb = Path::new(dir).join("adb");
            if !adb.exists() {
                continue;
            }
            let resolved = std::fs::canonicalize(&adb).unwrap_or(adb);
            if let Some(root) = resolved.parent().and_then(Path::parent) {
                let sdk = inspect(root);
                if sdk.adb || sdk.emulator {
                    return sdk;
                }
            }
        }
        explicit
            .first()
            .map_or_else(Sdk::default, |root| inspect(root))
    }

    /// `deviceHostEnvironment`: `ANDROID_HOME` and the SDK tools first on `PATH`.
    fn host_env(sdk: &Sdk) -> Vec<(String, Option<String>)> {
        let Some(root) = &sdk.root else {
            return Vec::new();
        };
        let path = format!(
            "{}:{}:{}",
            root.join("platform-tools").display(),
            root.join("emulator").display(),
            Self::env("PATH").unwrap_or_default()
        );
        vec![
            ("ANDROID_HOME".into(), Some(root.display().to_string())),
            ("PATH".into(), Some(path)),
        ]
    }

    pub(crate) async fn run(
        &self,
        command: &str,
        args: &[String],
        options: RunOptions,
    ) -> RunResult {
        let this = self.clone();
        let sdk = blocking(move || this.sdk()).await;
        let program = match (&sdk.root, command) {
            (Some(root), "emulator") => root.join("emulator/emulator").display().to_string(),
            _ => command.to_owned(),
        };
        let mut run = Run::new(program, args.to_vec())
            .cwd(&self.cwd)
            .timeout(Duration::from_millis(options.timeout_ms.unwrap_or(20_000)));
        run.env = Self::host_env(&sdk);
        run.stdin = options.stdin;
        run.max_output = options.max_output;
        let out = run.output().await;
        if let Some(error) = out.spawn_error {
            return RunResult {
                stdout: String::new(),
                stderr: error,
                code: 127,
            };
        }
        RunResult {
            stdout: out.stdout,
            stderr: out.stderr,
            code: if out.timed_out {
                124
            } else {
                i64::from(out.code.unwrap_or(127))
            },
        }
    }

    fn agent_state_dir(&self) -> PathBuf {
        self.state_dir.join("device").join("agent-device")
    }

    /// `resolveNodeExecutable` for a server that is not itself Node: `node` on `PATH`.
    fn node(&self, sdk: &Sdk) -> Option<PathBuf> {
        let path = Self::host_env(sdk)
            .into_iter()
            .find(|(name, _)| name == "PATH")
            .and_then(|(_, value)| value);
        let found = find_on_path("node", path.as_deref())?;
        std::fs::canonicalize(&found).ok().or(Some(found))
    }
}

/// `platformReason`.
fn platform_reason(platform: &str, sdk: &Sdk) -> Option<String> {
    if platform == "ios" {
        if !cfg!(target_os = "macos") {
            return Some("iOS Simulators need macOS with Xcode.".into());
        }
        if find_on_path("xcrun", None).is_none() {
            return Some("Xcode command line tools were not found.".into());
        }
        return None;
    }
    let Some(root) = &sdk.root else {
        return Some("Android SDK was not found. Install it with Android Studio or set ANDROID_HOME to your SDK directory.".into());
    };
    let root = root.display();
    if !sdk.adb {
        return Some(format!(
            "Android SDK Platform-Tools are missing from {root}. Install them in Android Studio's SDK Manager."
        ));
    }
    if !sdk.emulator {
        return Some(format!(
            "Android Emulator is missing from {root}. Install it in Android Studio's SDK Manager."
        ));
    }
    if !sdk.avdmanager {
        if sdk.legacy_avdmanager {
            return Some(format!(
                "The Android SDK command-line tools in {root} appear to be an older, unsupported version. Install Android SDK Command-line Tools (latest) in Android Studio's SDK Manager under SDK Tools."
            ));
        }
        return Some(format!(
            "Android SDK Command-line Tools (latest) are missing from {root}. Install them in Android Studio's SDK Manager."
        ));
    }
    None
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HubFile {
    pid: u32,
    port: u16,
    entry_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonFile {
    http_port: u16,
    token: String,
    pid: Option<u32>,
    version: Option<String>,
}

struct HubProcess {
    origin: String,
    node: String,
    exited: tokio::sync::watch::Receiver<bool>,
    _stop: tokio::sync::oneshot::Sender<()>,
}

struct Running {
    hub: Arc<HubProcess>,
    agent: Option<AgentEndpoint>,
    helpers: Helpers,
}

pub(crate) struct LocalHost {
    env: Arc<LocalEnv>,
    lock: tokio::sync::Mutex<()>,
    running: Mutex<Option<Running>>,
}

impl std::fmt::Debug for LocalHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalHost")
            .field("env", &self.env)
            .finish_non_exhaustive()
    }
}

fn process_alive(pid: u32) -> bool {
    i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
        .is_some_and(|pid| rustix::process::test_kill_process(pid).is_ok())
}

fn terminate(pid: u32) {
    if let Some(pid) = i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
    {
        let _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
    }
}

impl LocalHost {
    pub(crate) fn new(env: LocalEnv) -> Arc<Self> {
        Arc::new(Self {
            env: Arc::new(env),
            lock: tokio::sync::Mutex::new(()),
            running: Mutex::new(None),
        })
    }

    async fn sdk(&self) -> Sdk {
        let env = self.env.clone();
        blocking(move || env.sdk()).await
    }

    pub(crate) async fn platform_availability(&self, platform: &str) -> Availability {
        let sdk = self.sdk().await;
        let platform_owned = platform.to_owned();
        let reason = blocking(move || platform_reason(&platform_owned, &sdk)).await;
        Availability {
            platform: platform.to_owned(),
            available: reason.is_none(),
            reason,
        }
    }

    fn hub_alive(&self) -> Option<Arc<HubProcess>> {
        crate::lock(&self.running)
            .as_ref()
            .map(|r| r.hub.clone())
            .filter(|hub| !*hub.exited.borrow())
    }

    pub(crate) async fn summary(&self) -> HostSummary {
        let ios = self.platform_availability("ios").await;
        let android = self.platform_availability("android").await;
        let hub_alive = self.hub_alive().is_some();
        let has_agent = crate::lock(&self.running)
            .as_ref()
            .is_some_and(|r| r.agent.is_some());
        let env = self.env.clone();
        let (hub_installed, agent_installed, tools) = blocking(move || {
            let base = &env.base_dir;
            let daemon: Option<DaemonFile> = has_agent
                .then(|| std::fs::read_to_string(env.agent_state_dir().join("daemon.json")).ok())
                .flatten()
                .and_then(|text| serde_json::from_str(&text).ok());
            let agent_running = daemon
                .as_ref()
                .filter(|d| d.pid.is_some_and(process_alive))
                .and_then(|d| d.version.clone());
            (
                tools::is_installed(
                    &tools::paths(base, Tool::Hub, Tool::Hub.version()),
                    Tool::Hub.version(),
                ),
                tools::is_installed(
                    &tools::paths(base, Tool::Agent, Tool::Agent.version()),
                    Tool::Agent.version(),
                ),
                tools::versions(
                    base,
                    hub_alive.then_some(DEVICE_HUB_VERSION),
                    agent_running.as_deref(),
                ),
            )
        })
        .await;
        HostSummary {
            id: LOCAL_HOST_ID.into(),
            label: LOCAL_HOST_LABEL.into(),
            kind: "local",
            platforms: vec![ios, android],
            tools: Some(tools),
            tool_inspection_error: None,
            hub_installed,
            agent_device_installed: agent_installed,
        }
    }

    pub(crate) fn current(&self) -> Option<Ready> {
        crate::lock(&self.running)
            .as_ref()
            .map(|running| self.to_ready(running))
    }

    fn to_ready(&self, running: &Running) -> Ready {
        Ready {
            host_id: LOCAL_HOST_ID.into(),
            hub_origin: running.hub.origin.clone(),
            node_path: running.hub.node.clone(),
            agent: running.agent.clone(),
            helpers: running.helpers.clone(),
            runner: Runner::Local(self.env.clone()),
        }
    }

    fn error(step: &str, kind: HostErrorKind) -> HostError {
        HostError::new(LOCAL_HOST_ID, step, kind)
    }

    async fn ensure_hub(&self, on_phase: &OnPhase<'_>) -> Result<(), HostError> {
        if self.hub_alive().is_some() {
            return Ok(());
        }
        let sdk = self.sdk().await;
        let env = self.env.clone();
        let node = blocking(move || env.node(&sdk))
            .await
            .ok_or_else(|| Self::error("resolving Node", HostErrorKind::NodeMissing))?;
        let base = self.env.base_dir.clone();
        let installed = blocking(move || {
            tools::is_installed(
                &tools::paths(&base, Tool::Hub, Tool::Hub.version()),
                Tool::Hub.version(),
            )
        })
        .await;
        if !installed {
            let summary = self.summary().await;
            on_phase(
                "installing",
                Some(install_message(
                    "device hub",
                    summary.tools.as_ref().and_then(|t| t.get("hub")),
                )),
            );
        }
        let hub_tool = tools::ensure(&self.env.base_dir, Tool::Hub)
            .await
            .map_err(|e| install_error("installing device support", &e))?;
        on_phase("starting", None);
        let hub = self.spawn_hub(&hub_tool, &node).await?;
        let serve_sim = hub_tool
            .install_dir
            .join("node_modules/expo-device-hub/vendor/serve-sim/dist");
        let (ax, cli) = (
            serve_sim.join("simax/serve-sim-ax-settings"),
            serve_sim.join("serve-sim.js"),
        );
        let helpers = blocking(move || Helpers {
            ax_settings: ax.exists().then(|| ax.display().to_string()),
            sim_cli: cli.exists().then(|| cli.display().to_string()),
        })
        .await;
        let mut running = crate::lock(&self.running);
        let agent = running.as_ref().and_then(|r| r.agent.clone());
        *running = Some(Running {
            hub: Arc::new(hub),
            agent,
            helpers,
        });
        Ok(())
    }

    pub(crate) async fn ensure_ready(&self, on_phase: &OnPhase<'_>) -> Result<Ready, HostError> {
        let _guard = self.lock.lock().await;
        self.ensure_hub(on_phase).await?;
        self.current().ok_or_else(|| {
            Self::error(
                "starting the device hub",
                HostErrorKind::Other("stopped".into()),
            )
        })
    }

    pub(crate) async fn ensure_agent_ready(
        &self,
        on_phase: &OnPhase<'_>,
    ) -> Result<Ready, HostError> {
        let _guard = self.lock.lock().await;
        self.ensure_hub(on_phase).await?;
        let (existing, node) = {
            let running = crate::lock(&self.running);
            let running = running.as_ref();
            (
                running.and_then(|r| r.agent.clone()),
                running.map(|r| r.hub.node.clone()).unwrap_or_default(),
            )
        };
        let entry = match existing {
            Some(agent) => agent.entry_path,
            None => {
                let base = self.env.base_dir.clone();
                let installed = blocking(move || {
                    tools::is_installed(
                        &tools::paths(&base, Tool::Agent, Tool::Agent.version()),
                        Tool::Agent.version(),
                    )
                })
                .await;
                if !installed {
                    let summary = self.summary().await;
                    on_phase(
                        "installing",
                        Some(install_message(
                            "agent tools",
                            summary.tools.as_ref().and_then(|t| t.get("agent")),
                        )),
                    );
                }
                let tool = tools::ensure(&self.env.base_dir, Tool::Agent)
                    .await
                    .map_err(|e| install_error("installing agent tools", &e))?;
                on_phase("starting", None);
                tool.entry.display().to_string()
            }
        };
        let agent = self.start_daemon(&entry, &node).await?;
        let mut running = crate::lock(&self.running);
        if let Some(running) = running.as_mut() {
            running.agent = Some(agent);
        }
        running.as_ref().map(|r| self.to_ready(r)).ok_or_else(|| {
            Self::error(
                "starting agent tools",
                HostErrorKind::Other("stopped".into()),
            )
        })
    }

    async fn spawn_hub(
        &self,
        hub_tool: &tools::ToolPaths,
        node: &Path,
    ) -> Result<HubProcess, HostError> {
        let state = self.env.agent_state_dir();
        let hub_file = state.join("hub.json");
        let reap = hub_file.clone();
        blocking(move || reap_stale_hub(&reap)).await;
        let port = std::net::TcpListener::bind(("127.0.0.1", 0))
            .and_then(|l| l.local_addr())
            .map(|a| a.port())
            .map_err(|e| {
                Self::error(
                    "reserving a port for the device hub",
                    HostErrorKind::Other(e.to_string()),
                )
            })?;
        let origin = format!("http://127.0.0.1:{port}");
        let mut args = vec![
            hub_tool.entry.display().to_string(),
            "--port".into(),
            port.to_string(),
            "--host".into(),
            "127.0.0.1".into(),
            "--hide-sidebar".into(),
            "--hide-boot-device".into(),
        ];
        if !cfg!(target_os = "macos") {
            args.extend(["--platform".into(), "android".into()]);
        }
        let sdk = self.sdk().await;
        let mut run = Run::new(node.display().to_string(), args).cwd(&self.env.cwd);
        run.env = hub_env(&self.env, &sdk).await;
        let mut command = run.command();
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|e| {
            Self::error(
                "starting the device hub",
                HostErrorKind::Other(e.to_string()),
            )
        })?;
        let pid = child.id();
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
        let (exited_tx, exited_rx) = tokio::sync::watch::channel(false);
        tokio::spawn(async move {
            tokio::select! {
                _ = stop_rx => crate::process::terminate(&mut child, HUB_STOP_GRACE).await,
                _ = child.wait() => {}
            }
            let _ = exited_tx.send(true);
        });
        let hub = HubProcess {
            origin: origin.clone(),
            node: node.display().to_string(),
            exited: exited_rx,
            _stop: stop_tx,
        };
        if !http::wait_ready(&format!("{origin}/readyz"), HUB_READY_TIMEOUT).await {
            return Err(Self::error(
                "waiting for the device hub to answer",
                HostErrorKind::Other("The device hub did not answer.".into()),
            ));
        }
        if let Some(pid) = pid {
            let record = HubFile {
                pid,
                port,
                entry_path: hub_tool.entry.display().to_string(),
            };
            blocking(move || {
                let _ = std::fs::create_dir_all(&state);
                if let Ok(text) = serde_json::to_vec(&record) {
                    let _ = conn_support::fs::write_atomic(&hub_file, &text, 0o644);
                }
            })
            .await;
        }
        Ok(hub)
    }

    async fn start_daemon(&self, entry: &str, node: &str) -> Result<AgentEndpoint, HostError> {
        let state = self.env.agent_state_dir();
        let daemon_file = state.join("daemon.json");
        let read = {
            let file = daemon_file.clone();
            move || -> Option<DaemonFile> {
                std::fs::read_to_string(&file)
                    .ok()
                    .and_then(|t| serde_json::from_str(&t).ok())
            }
        };
        let endpoint = |file: DaemonFile| AgentEndpoint {
            base_url: format!("http://127.0.0.1:{}", file.http_port),
            token: file.token,
            entry_path: entry.to_owned(),
        };
        let make_dir = state.clone();
        blocking(move || std::fs::create_dir_all(make_dir))
            .await
            .ok();
        let reader = read.clone();
        if let Some(existing) = blocking(reader).await {
            if http::ok(
                &format!("http://127.0.0.1:{}/health", existing.http_port),
                Duration::from_secs(2),
            )
            .await
            {
                return Ok(endpoint(existing));
            }
            let remove = daemon_file.clone();
            blocking(move || std::fs::remove_file(remove)).await.ok();
        }
        let sdk = self.sdk().await;
        let mut run = Run::new(node, [entry, "devices", "--json"])
            .timeout(Duration::from_millis(DAEMON_READY_TIMEOUT_MS));
        run.env = LocalEnv::host_env(&sdk);
        let state_text = state.display().to_string();
        run = run
            .env("AGENT_DEVICE_STATE_DIR", &state_text)
            .env("AGENT_DEVICE_DAEMON_SERVER_MODE", "http")
            .env("AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS", "0")
            .env("AGENT_DEVICE_NO_UPDATE_NOTIFIER", "1")
            .env("FORCE_COLOR", "0")
            .env("NO_COLOR", "1");
        let out = run.output().await;
        let reader = read.clone();
        if let Some(started) = blocking(reader).await {
            return Ok(endpoint(started));
        }
        if let Some(error) = out.spawn_error {
            return Err(Self::error(
                "starting agent tools",
                HostErrorKind::Other(error),
            ));
        }
        if out.timed_out {
            return Err(Self::error(
                "starting agent tools",
                HostErrorKind::Timeout(DAEMON_READY_TIMEOUT_MS),
            ));
        }
        if out.code != Some(0) {
            return Err(Self::error(
                "starting agent tools",
                HostErrorKind::AgentStart(agent_start_message(&out.stdout, out.code, &state_text)),
            ));
        }
        let deadline = tokio::time::Instant::now() + Duration::from_millis(DAEMON_READY_TIMEOUT_MS);
        loop {
            let reader = read.clone();
            if let Some(file) = blocking(reader).await {
                return Ok(endpoint(file));
            }
            if tokio::time::Instant::now() > deadline {
                return Err(Self::error(
                    "starting agent tools",
                    HostErrorKind::Timeout(DAEMON_READY_TIMEOUT_MS),
                ));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    async fn stop_daemon(&self) {
        let state = self.env.agent_state_dir();
        let base = self.env.base_dir.clone();
        let sdk = self.sdk().await;
        let env = self.env.clone();
        let plan = blocking(move || -> Option<(PathBuf, String)> {
            let file = state.join("daemon.json");
            let text = std::fs::read_to_string(&file).ok()?;
            let recorded: Option<DaemonFile> = serde_json::from_str(&text).ok();
            if let Some(pid) = recorded.as_ref().and_then(|r| r.pid)
                && !process_alive(pid)
            {
                let _ = std::fs::remove_file(&file);
                return None;
            }
            let versions = recorded
                .and_then(|r| r.version)
                .into_iter()
                .chain([Tool::Agent.version().to_owned()]);
            let entry = versions
                .map(|v| tools::paths(&base, Tool::Agent, &v))
                .find(|p| p.entry.exists() && is_executable_or_file(&p.entry))?
                .entry;
            let node = env.node(&sdk)?;
            Some((node, entry.display().to_string()))
        })
        .await;
        let Some((node, entry)) = plan else { return };
        let mut run = Run::new(
            node.display().to_string(),
            [
                entry,
                "daemon".into(),
                "stop".into(),
                "--state-dir".into(),
                self.env.agent_state_dir().display().to_string(),
            ],
        )
        .timeout(Duration::from_secs(10))
        .env("AGENT_DEVICE_NO_UPDATE_NOTIFIER", "1");
        run.env.extend(LocalEnv::host_env(&self.sdk().await));
        let _ = run.output().await;
    }

    pub(crate) async fn stop_agent(&self) {
        let _guard = self.lock.lock().await;
        self.stop_daemon().await;
        if let Some(running) = crate::lock(&self.running).as_mut() {
            running.agent = None;
        }
    }

    pub(crate) async fn stop(&self) {
        let _guard = self.lock.lock().await;
        let running = crate::lock(&self.running).take();
        // Dropping the hub's handle asks it to stop (SIGTERM, then SIGKILL); wait for its exit.
        if let Some(running) = running {
            let mut exited = running.hub.exited.clone();
            drop(running);
            let _ = tokio::time::timeout(
                HUB_STOP_GRACE + Duration::from_secs(1),
                exited.wait_for(|e| *e),
            )
            .await;
        }
        let hub_file = self.env.agent_state_dir().join("hub.json");
        blocking(move || std::fs::remove_file(hub_file)).await.ok();
        self.stop_daemon().await;
    }
}

fn is_executable_or_file(path: &Path) -> bool {
    is_executable(path) || path.is_file()
}

fn install_error(step: &str, error: &InstallError) -> HostError {
    HostError::new(
        LOCAL_HOST_ID,
        step,
        match error {
            InstallError::NpmMissing => HostErrorKind::NpmMissing,
            InstallError::Failed { step, .. } => HostErrorKind::Other(step.clone()),
        },
    )
}

/// Stops a hub an earlier server left running, when its pid still runs that hub.
fn reap_stale_hub(hub_file: &Path) {
    let Some(previous) = std::fs::read_to_string(hub_file)
        .ok()
        .and_then(|t| serde_json::from_str::<HubFile>(&t).ok())
    else {
        return;
    };
    if process_alive(previous.pid) {
        let command = std::process::Command::new("ps")
            .args(["-o", "command=", "-p", &previous.pid.to_string()])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default();
        if command.contains(&previous.entry_path) {
            terminate(previous.pid);
        }
    }
    let _ = std::fs::remove_file(hub_file);
}

/// `hubEnvironment`: no colour, the SDK, emulated cameras where the emulator lacks image files.
async fn hub_env(env: &LocalEnv, sdk: &Sdk) -> Vec<(String, Option<String>)> {
    let mut vars = LocalEnv::host_env(sdk);
    vars.push(("FORCE_COLOR".into(), Some("0".into())));
    vars.push(("NO_COLOR".into(), Some("1".into())));
    if let Some(root) = &sdk.root {
        let emulator = root.join("emulator/emulator").display().to_string();
        let mut overrides = Vec::new();
        for facing in ["front", "back"] {
            let mut run = Run::new(&emulator, [format!("-help-camera-{facing}")])
                .timeout(Duration::from_secs(5));
            run.env = vars.clone();
            let out = run.output().await;
            let help = format!("{}\n{}", out.stdout, out.stderr);
            let has = |word: &str| {
                help.split(|c: char| !c.is_alphanumeric() && c != '_')
                    .any(|w| w == word)
            };
            if out.ok() && has("emulated") && !has("imagefile") {
                overrides.push(format!("-camera-{facing} emulated"));
            }
        }
        if !overrides.is_empty() {
            let mut value = overrides.join(" ");
            if let Ok(extra) = std::env::var("EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS")
                && !extra.is_empty()
            {
                value = format!("{value} {extra}");
            }
            vars.push(("EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS".into(), Some(value)));
        }
    }
    let _ = env;
    vars
}

/// `AgentDeviceStartError.message`.
fn agent_start_message(stdout: &str, code: Option<i32>, state_dir: &str) -> String {
    let details = serde_json::from_str::<serde_json::Value>(stdout)
        .ok()
        .and_then(|v| v.pointer("/error/details").cloned());
    let reason = details
        .as_ref()
        .and_then(|d| d.get("reason"))
        .and_then(serde_json::Value::as_str);
    let inspection = details
        .as_ref()
        .and_then(|d| d.pointer("/inspection/reason"))
        .and_then(serde_json::Value::as_str);
    let reason = match (reason, inspection) {
        (Some("daemon_registration_unproven"), Some("non-directory")) => {
            "daemon_lock_not_directory"
        }
        (Some("daemon_registration_unproven"), _) => "daemon_registration_unproven",
        (Some("daemon_retirement_unconfirmed"), _) => "daemon_retirement_unconfirmed",
        _ => "command_failed",
    };
    let exit = code
        .map(|c| format!(" (exit code {c})"))
        .unwrap_or_default();
    let detail = match reason {
        "daemon_lock_not_directory" => {
            "Daemon registration ownership could not be verified: daemon.lock is not a directory."
        }
        "daemon_registration_unproven" => "Daemon registration ownership could not be verified.",
        "daemon_retirement_unconfirmed" => "Daemon replacement could not be confirmed.",
        _ => "The AgentDevice startup command failed.",
    };
    let recovery = if reason == "command_failed" {
        format!("Inspect daemon diagnostics in {state_dir}.")
    } else {
        format!(
            "Inspect daemon.lock and daemon diagnostics in {state_dir}. Stop older clients and daemons with their original CLI before manually repairing retained state."
        )
    };
    format!("Agent tools failed to start{exit}. {detail} {recovery}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_start_messages_follow_t3() {
        assert_eq!(
            agent_start_message("", Some(2), "/s"),
            "Agent tools failed to start (exit code 2). The AgentDevice startup command failed. Inspect daemon diagnostics in /s.",
            "command failed"
        );
        let stdout = r#"{"error":{"details":{"reason":"daemon_registration_unproven","inspection":{"reason":"non-directory"}}}}"#;
        assert!(
            agent_start_message(stdout, Some(1), "/s").contains("daemon.lock is not a directory"),
            "lock"
        );
    }
}
