//! The device service (`DeviceService.ts`): the hosts, the published state, and the methods the
//! Device panel and the tools call. One state, behind one lock; every change bumps `revision`
//! and replaces the value subscribers read (a watch channel: a slow subscriber skips states, it
//! never queues them).

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde_json::{Map, Value, json};
use tokio::sync::watch;

use crate::{
    actions, agent,
    errors::DeviceError,
    host::{Host, HostError, Ready},
    hub::{self, HubDevice},
    local::{LocalEnv, LocalHost},
    model::{Device, HostStatus, HostSummary, LOCAL_HOST_ID, LOCAL_HOST_LABEL, Session, State},
    ssh::{self, SshConfig, SshHost},
    tools::{self, Tool, blocking},
};

pub type BoxFuture<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// The server settings the device service reads and writes.
pub trait SettingsAccess: Send + Sync {
    /// The settings with their secrets, sparse: a missing key has its default.
    fn read(&self) -> Map<String, Value>;
    /// Applies a `ServerSettingsPatch` and saves it.
    fn update(&self, patch: Value) -> BoxFuture<'static, Result<(), String>>;
    /// Ticks after each change.
    fn changes(&self) -> watch::Receiver<u64>;
}

pub struct Config {
    pub state_dir: PathBuf,
    /// The T3 home; tools install under `<base>/tools`.
    pub base_dir: PathBuf,
    pub cwd: PathBuf,
    pub environment_id: String,
    pub settings: Arc<dyn SettingsAccess>,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("state_dir", &self.state_dir)
            .field("base_dir", &self.base_dir)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug)]
struct DeviceSettings {
    enabled: bool,
    agent_access: bool,
    onboarding: bool,
}

fn flag(settings: &Map<String, Value>, key: &str) -> bool {
    settings.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// `agentAccessSettings(...).device`: support on, and agent access for the project or machine.
pub fn agent_device_access(settings: &Map<String, Value>, project_id: Option<&str>) -> bool {
    let project = project_id.and_then(|id| {
        settings
            .get("projectSettingsOverrides")?
            .get(id)?
            .get("enableAgentDeviceAccess")?
            .as_bool()
    });
    flag(settings, "enableDeviceSupport")
        && project.unwrap_or_else(|| flag(settings, "enableAgentDeviceAccess"))
}

pub(crate) struct Inner {
    config: Config,
    local: Arc<LocalHost>,
    state: Mutex<State>,
    published: watch::Sender<Value>,
    hosts: Mutex<Vec<Host>>,
    configured: Mutex<Vec<SshConfig>>,
    lifecycle: tokio::sync::Mutex<()>,
    discovery_details: Mutex<HashMap<String, String>>,
    /// Launchers bound since start, by agent-device session.
    launchers: Mutex<HashMap<String, String>>,
    /// Held while launchers are bound, released or pruned, as T3's `launcherLock`: each reads
    /// the live sessions only after taking it, so a prune never deletes a new launcher.
    launcher_lock: tokio::sync::Mutex<()>,
    /// The bound on one launcher's `close`; tests shorten it.
    release_timeout: Mutex<std::time::Duration>,
    /// `environment-id` as the file holds it: T3 hashes the raw text into a host's owner.
    environment_file: std::sync::OnceLock<String>,
    /// Turns true once the first `reconcile` added the saved hosts. T3 builds its service
    /// only after that reconcile, so no request sees a saved host missing.
    hosts_loaded: watch::Sender<bool>,
}

/// The device service. Cheap to clone.
#[derive(Clone)]
pub struct Devices(pub(crate) Arc<Inner>);

impl std::fmt::Debug for Devices {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Devices")
            .field("config", &self.0.config)
            .finish_non_exhaustive()
    }
}

fn unavailable(host: &Host, reason: impl Into<String>) -> DeviceError {
    DeviceError::host(host.id(), Some(host.label()), reason)
}

impl Devices {
    /// Builds the service and starts following `deviceHosts` in the settings.
    pub fn start(config: Config) -> Self {
        let settings = read_settings(config.settings.as_ref());
        let local = LocalHost::new(LocalEnv {
            cwd: config.cwd.clone(),
            base_dir: config.base_dir.clone(),
            state_dir: config.state_dir.clone(),
        });
        let state = State {
            hosts: vec![HostSummary::empty(LOCAL_HOST_ID, LOCAL_HOST_LABEL, "local")],
            host_status: if settings.enabled { "idle" } else { "disabled" }.into(),
            onboarding_completed: settings.onboarding,
            agent_access_enabled: settings.agent_access,
            supports_tool_update: true,
            ..State::default()
        };
        let (published, _) = watch::channel(state.to_json());
        let devices = Self(Arc::new(Inner {
            local: local.clone(),
            hosts: Mutex::new(vec![Host::Local(local)]),
            config,
            state: Mutex::new(state),
            published,
            configured: Mutex::new(Vec::new()),
            lifecycle: tokio::sync::Mutex::new(()),
            discovery_details: Mutex::new(HashMap::new()),
            launchers: Mutex::new(HashMap::new()),
            launcher_lock: tokio::sync::Mutex::new(()),
            release_timeout: Mutex::new(agent::RELEASE_TIMEOUT),
            environment_file: std::sync::OnceLock::new(),
            hosts_loaded: watch::Sender::new(false),
        }));
        let this = devices.clone();
        tokio::spawn(async move {
            // Sessions live in memory: launchers a previous run left behind go.
            let state_dir = this.0.config.state_dir.clone();
            let raw = {
                let _guard = this.0.launcher_lock.lock().await;
                let live = this.live_session_names();
                blocking(move || {
                    agent::prune_launchers(&state_dir, &live);
                    std::fs::read_to_string(state_dir.join("environment-id")).ok()
                })
                .await
            };
            if let Some(raw) = raw {
                let _ = this.0.environment_file.set(raw);
            }
            let summaries = this.summaries().await;
            this.publish(|s| s.hosts = summaries);
            let mut changes = this.0.config.settings.changes();
            loop {
                this.reconcile().await;
                this.0.hosts_loaded.send_replace(true);
                if changes.changed().await.is_err() {
                    return;
                }
            }
        });
        devices
    }

    /// Waits until the saved hosts are in the host list (`hosts_loaded`).
    async fn loaded(&self) {
        let mut loaded = self.0.hosts_loaded.subscribe();
        let _ = loaded.wait_for(|done| *done).await;
    }

    fn settings(&self) -> DeviceSettings {
        read_settings(self.0.config.settings.as_ref())
    }

    pub fn state_dir(&self) -> &std::path::Path {
        &self.0.config.state_dir
    }

    /// The current state, as clients decode it.
    pub fn state(&self) -> Value {
        self.0.published.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<Value> {
        self.0.published.subscribe()
    }

    fn snapshot(&self) -> State {
        crate::lock(&self.0.state).clone()
    }

    fn hosts(&self) -> Vec<Host> {
        crate::lock(&self.0.hosts).clone()
    }

    fn find_host(&self, id: &str) -> Option<Host> {
        self.hosts().into_iter().find(|h| h.id() == id)
    }

    fn resolve_host(&self, id: Option<&str>) -> Result<Host, DeviceError> {
        let id = id.unwrap_or(LOCAL_HOST_ID);
        self.find_host(id)
            .ok_or_else(|| DeviceError::host(id, None, "Unknown host."))
    }

    fn still_current(&self, host: &Host) -> bool {
        self.find_host(host.id()).is_some_and(|h| h.same(host))
    }

    async fn summaries(&self) -> Vec<HostSummary> {
        let mut out = Vec::new();
        for host in self.hosts() {
            out.push(host.summary().await);
        }
        out
    }

    fn publish(&self, update: impl FnOnce(&mut State)) {
        let retired = {
            let mut state = crate::lock(&self.0.state);
            let before = state.sessions.clone();
            update(&mut state);
            state.revision += 1;
            self.0.published.send_replace(state.to_json());
            before.iter().any(|s| !state.sessions.contains(s))
        };
        if retired {
            let this = self.clone();
            tokio::spawn(async move { this.prune_launchers().await });
        }
    }

    /// `setHostStatus`.
    /// `setHostStatus` with a status that names no detail.
    pub(crate) fn set_host_status(&self, host_id: &str, status: &str, detail: Option<String>) {
        self.set_host_status_keyed(host_id, status, detail, false);
    }

    /// `setHostStatus`. `keyed`: the status names a `detail`, maybe without a value, which T3
    /// then sends as `null`.
    pub(crate) fn set_host_status_keyed(
        &self,
        host_id: &str,
        status: &str,
        detail: Option<String>,
        keyed: bool,
    ) {
        if self.find_host(host_id).is_none() {
            return;
        }
        let remembered = crate::lock(&self.0.discovery_details).get(host_id).cloned();
        self.publish(|state| {
            let previous = state
                .host_statuses
                .get(host_id)
                .cloned()
                .unwrap_or_default();
            let detail = detail.or_else(|| {
                (status == "ready"
                    && (!previous.incomplete_platforms.is_empty() || previous.android_incomplete))
                    .then_some(remembered)
                    .flatten()
            });
            if host_id == LOCAL_HOST_ID {
                state.host_status = status.to_owned();
                state.host_status_detail = Some(detail.clone());
            }
            state.host_statuses.insert(
                host_id.to_owned(),
                HostStatus {
                    status: status.to_owned(),
                    detail_null: keyed,
                    detail,
                    android_incomplete: previous.android_incomplete,
                    incomplete_platforms: previous.incomplete_platforms,
                },
            );
        });
    }

    fn on_phase(&self, host_id: &str) -> impl Fn(&str, Option<String>) + Send + Sync + '_ {
        let host_id = host_id.to_owned();
        move |phase, detail| self.set_host_status_keyed(&host_id, phase, detail, true)
    }

    /// `readiness`.
    pub(crate) async fn readiness(&self, host_id: Option<&str>) -> Result<Ready, DeviceError> {
        self.loaded().await;
        let host = self.resolve_host(host_id)?;
        let _guard = self.0.lifecycle.lock().await;
        if !self.settings().enabled {
            return Err(unavailable(
                &host,
                "Device support is off. Enable it in the Device panel before installing or starting device tools.",
            ));
        }
        let ready = host
            .ensure_ready(&self.on_phase(host.id()))
            .await
            .map_err(|error| self.host_failed(&host, &error, false))?;
        if !self.still_current(&host) {
            return Err(unavailable(
                &host,
                "Host configuration changed. Retry the operation.",
            ));
        }
        if self
            .snapshot()
            .host_statuses
            .get(host.id())
            .is_none_or(|s| s.status != "ready")
        {
            self.set_host_status(host.id(), "ready", None);
        }
        Ok(ready)
    }

    fn host_failed(&self, host: &Host, error: &HostError, agent: bool) -> DeviceError {
        self.set_host_status_keyed(host.id(), "failed", Some(error.detail()), true);
        unavailable(host, error.reason(agent))
    }

    async fn readiness_if_supported(
        &self,
        host_id: Option<&str>,
    ) -> Result<Option<Ready>, DeviceError> {
        if !self.settings().enabled {
            return Ok(None);
        }
        let host = self.resolve_host(host_id)?;
        if matches!(host, Host::Local(_))
            && !host.summary().await.platforms.iter().any(|p| p.available)
        {
            return Ok(None);
        }
        self.readiness(Some(host.id())).await.map(Some)
    }

    /// `agentReadinessIfSupported`.
    pub(crate) async fn agent_readiness_if_supported(
        &self,
        host_id: Option<&str>,
    ) -> Result<Option<Ready>, DeviceError> {
        self.loaded().await;
        // The lock covers the settings check too: a disable that lands while this waits must
        // stop it, as T3 runs the whole call under `lifecycleLock`.
        let _guard = self.0.lifecycle.lock().await;
        let settings = self.settings();
        if !settings.enabled || !settings.agent_access {
            return Ok(None);
        }
        let host = self.resolve_host(host_id)?;
        if matches!(host, Host::Local(_))
            && !host.summary().await.platforms.iter().any(|p| p.available)
        {
            return Ok(None);
        }
        let ready = host
            .ensure_agent_ready(&self.on_phase(host.id()))
            .await
            .map_err(|error| self.host_failed(&host, &error, true))?;
        let summaries = self.summaries().await;
        self.publish(|s| s.hosts = summaries);
        self.set_host_status(host.id(), "ready", None);
        Ok(Some(ready))
    }

    fn current_readiness(&self, host_id: &str) -> Option<Ready> {
        self.find_host(host_id).and_then(|h| h.current())
    }

    /// The running hub of a host, for the stream proxy.
    pub fn hub_origin(&self, host_id: Option<&str>) -> Option<(String, String)> {
        let id = host_id.unwrap_or(LOCAL_HOST_ID);
        self.current_readiness(id)
            .map(|r| (r.host_id, r.hub_origin))
    }

    async fn refresh(&self, ready: &Ready) -> Result<State, DeviceError> {
        let host = self.find_host(&ready.host_id);
        let listing = match &host {
            Some(host) => hub::list(ready, host).await?,
            None => return Ok(self.snapshot()),
        };
        let summaries = self.summaries().await;
        let _guard = self.0.lifecycle.lock().await;
        let host = host.unwrap_or(Host::Local(self.0.local.clone()));
        if !self.settings().enabled || !self.still_current(&host) {
            return Ok(self.snapshot());
        }
        {
            let mut details = crate::lock(&self.0.discovery_details);
            match &listing.detail {
                Some(detail)
                    if !listing.incomplete_platforms.is_empty() || listing.android_incomplete =>
                {
                    details.insert(ready.host_id.clone(), detail.clone());
                }
                _ => {
                    details.remove(&ready.host_id);
                }
            }
        }
        let host_id = ready.host_id.clone();
        self.publish(|state| {
            state.hosts = summaries;
            if host_id == LOCAL_HOST_ID {
                state.host_status_detail = Some(listing.detail.clone());
            }
            let incomplete = &listing.incomplete_platforms;
            state
                .devices
                .retain(|d| d.host_id != host_id || incomplete.contains(&d.platform));
            state.devices.extend(
                listing
                    .devices
                    .iter()
                    .filter(|d| !incomplete.contains(&d.platform))
                    .map(|d| to_device(&host_id, d)),
            );
            state.host_statuses.insert(
                host_id.clone(),
                HostStatus {
                    status: "ready".into(),
                    detail_null: false,
                    detail: listing.detail.clone(),
                    android_incomplete: listing.android_incomplete,
                    incomplete_platforms: incomplete.clone(),
                },
            );
        });
        Ok(self.snapshot())
    }

    /// `list`.
    pub async fn list(&self) -> Value {
        self.loaded().await;
        if !self.settings().enabled {
            return self.state();
        }
        for host in self.hosts() {
            let result = async {
                if let Some(ready) = self.readiness_if_supported(Some(host.id())).await? {
                    self.refresh(&ready).await?;
                }
                Ok::<(), DeviceError>(())
            }
            .await;
            if let Err(error) = result {
                self.set_host_status(host.id(), "failed", Some(failure_detail(&error)));
            }
        }
        self.state()
    }

    /// `inspect`: tool versions, without starting anything.
    pub async fn inspect(&self) -> Value {
        self.loaded().await;
        for host in self.hosts() {
            let result = host.inspect().await;
            if !self.still_current(&host) {
                continue;
            }
            let id = host.id().to_owned();
            self.publish(|state| {
                if let Some(summary) = state.hosts.iter_mut().find(|h| h.id == id) {
                    match result {
                        Ok(value) => *summary = value,
                        Err(_) => {
                            summary.tool_inspection_error = Some("Cannot check versions. Reconnect the host and check again. Installed tools have not been changed.".into());
                        }
                    }
                }
            });
        }
        self.state()
    }

    /// `updateTool`: installs the pinned tool on this machine.
    pub async fn update_tool(&self, tool: &str) -> Result<Value, DeviceError> {
        self.loaded().await;
        let tool = if tool == "hub" {
            Tool::Hub
        } else {
            Tool::Agent
        };
        {
            let _guard = self.0.lifecycle.lock().await;
            tools::ensure(&self.0.config.base_dir, tool)
                .await
                .map_err(|e| match e {
                    tools::InstallError::NpmMissing => DeviceError::operation(
                        "update device tool",
                        "package_manager_missing",
                        e.message(tool),
                    ),
                    tools::InstallError::Failed { exit_code, .. } => DeviceError::Operation {
                        operation: "update device tool".into(),
                        reason: "command_failed",
                        exit_code,
                        cause: e.message(tool),
                    },
                })?;
        }
        Ok(self.inspect().await)
    }

    /// `retryHost`.
    pub async fn retry_host(&self, host_id: &str) -> Result<Value, DeviceError> {
        self.loaded().await;
        self.resolve_host(Some(host_id))?;
        if !self.settings().enabled {
            return Ok(self.state());
        }
        let result = async {
            let ready = match self.agent_readiness_if_supported(Some(host_id)).await? {
                Some(ready) => Some(ready),
                None => self.readiness_if_supported(Some(host_id)).await?,
            };
            if let Some(ready) = ready {
                self.refresh(&ready).await?;
            }
            Ok::<(), DeviceError>(())
        }
        .await;
        if let Err(error) = result {
            self.set_host_status(host_id, "failed", Some(failure_detail(&error)));
        }
        Ok(self.state())
    }

    /// `configure`.
    pub async fn configure(&self, input: &Value) -> Result<Value, DeviceError> {
        self.loaded().await;
        let current = self.settings();
        let enabled = input["enabled"].as_bool();
        let agent_access = input["agentAccessEnabled"].as_bool();
        let onboarding = input["onboardingCompleted"].as_bool();
        let next_enabled = enabled.unwrap_or(current.enabled);
        let next_agent = agent_access.unwrap_or(current.agent_access);
        {
            let _guard = self.0.lifecycle.lock().await;
            let mut patch = Map::new();
            if let Some(v) = enabled {
                patch.insert("enableDeviceSupport".into(), json!(v));
            }
            if let Some(v) = agent_access {
                patch.insert("enableAgentDeviceAccess".into(), json!(v));
            }
            if let Some(v) = onboarding {
                patch.insert("deviceOnboardingCompleted".into(), json!(v));
            }
            self.0
                .config
                .settings
                .update(Value::Object(patch))
                .await
                .map_err(|cause| DeviceError::operation("configure", "settings_failed", cause))?;
            if !next_enabled {
                for host in self.hosts() {
                    host.stop().await;
                }
            } else if agent_access == Some(false) {
                for host in self.hosts() {
                    host.stop_agent().await;
                }
            }
            self.publish(|state| {
                state.host_status = if next_enabled { "idle" } else { "disabled" }.into();
                state.host_status_detail = Some(None);
                state.host_statuses.clear();
                if !next_enabled {
                    state.devices.clear();
                    state.sessions.clear();
                    state.booting = Some(Vec::new());
                }
                state.agent_access_enabled = next_agent;
                if let Some(v) = onboarding {
                    state.onboarding_completed = v;
                }
            });
        }
        if next_enabled && next_agent && agent_access == Some(true) {
            self.agent_readiness_if_supported(None).await?;
        }
        Ok(self.list().await)
    }

    fn find_device(state: &State, host_id: &str, device_id: &str) -> Option<Device> {
        state
            .devices
            .iter()
            .find(|d| d.host_id == host_id && d.id == device_id)
            .cloned()
    }

    /// `open`.
    pub async fn open(&self, input: &Value) -> Result<Session, DeviceError> {
        self.loaded().await;
        let thread_id = input["threadId"].as_str().unwrap_or_default().to_owned();
        let device_id = input["deviceId"].as_str().unwrap_or_default().to_owned();
        let platform = input["platform"].as_str().unwrap_or_default().to_owned();
        let host = self.resolve_host(input["hostId"].as_str())?;
        let availability = host.platform_availability(&platform).await;
        if !availability.available {
            return Err(DeviceError::PlatformUnavailable {
                host_id: host.id().into(),
                platform,
                reason: availability
                    .reason
                    .unwrap_or_else(|| "Platform toolchain missing.".into()),
            });
        }
        let ready = self.readiness(Some(host.id())).await?;
        let state = self.refresh(&ready).await?;
        let mut device = Self::find_device(&state, host.id(), &device_id).ok_or_else(|| {
            DeviceError::NotFound {
                host_id: host.id().into(),
                device_id: device_id.clone(),
            }
        })?;
        if device.platform == "android" && !device.physical {
            check_android_video(&ready, host.id()).await?;
        }
        if !device.booted && input["boot"].as_bool() != Some(false) {
            let booting = (device.clone(), thread_id.clone());
            self.publish(|s| {
                let list = s.booting.get_or_insert_with(Vec::new);
                list.retain(|(d, _)| !(d.host_id == booting.0.host_id && d.id == booting.0.id));
                list.push(booting.clone());
            });
            let result = hub::boot(&ready, &to_hub(&device)).await;
            let (h, d) = (device.host_id.clone(), device.id.clone());
            self.publish(|s| {
                if let Some(list) = s.booting.as_mut() {
                    list.retain(|(x, _)| !(x.host_id == h && x.id == d));
                }
            });
            let booted_id = result?;
            let state = self.refresh(&ready).await?;
            let incomplete = state
                .host_statuses
                .get(host.id())
                .is_some_and(|s| s.incomplete_platforms.contains(&device.platform));
            device = (!incomplete)
                .then(|| {
                    Self::find_device(&state, host.id(), &booted_id)
                        .or_else(|| Self::find_device(&state, host.id(), &device.id))
                })
                .flatten()
                .ok_or_else(|| DeviceError::NotFound {
                    host_id: host.id().into(),
                    device_id: booted_id.clone(),
                })?;
        } else if device.booted {
            hub::attach(&ready, &to_hub(&device)).await?;
        }
        if !self.still_current(&host) {
            return Err(unavailable(
                &host,
                "Host configuration changed. Retry the operation.",
            ));
        }
        let session = Session {
            thread_id,
            host_id: host.id().into(),
            device_id: device.id.clone(),
            platform: device.platform.clone(),
            opened_at: conn_support::time::now_iso(),
        };
        let _guard = self.0.lifecycle.lock().await;
        if !self.settings().enabled {
            return Err(unavailable(
                &host,
                "Device support was turned off while the device was opening.",
            ));
        }
        let added = session.clone();
        self.publish(|s| {
            s.sessions.retain(|e| {
                !(e.thread_id == added.thread_id
                    && e.host_id == added.host_id
                    && e.device_id == added.device_id)
            });
            s.sessions.push(added);
        });
        Ok(session)
    }

    async fn shutdown_device(
        &self,
        ready: &Ready,
        device_id: &str,
        platform: &str,
    ) -> Result<(), DeviceError> {
        let host = self.resolve_host(Some(&ready.host_id))?;
        hub::shutdown(ready, &host, device_id, platform).await?;
        let (h, d) = (ready.host_id.clone(), device_id.to_owned());
        self.publish(|s| {
            for device in &mut s.devices {
                if device.host_id == h && device.id == d {
                    device.booted = false;
                }
            }
        });
        Ok(())
    }

    /// `close`.
    pub async fn close(&self, input: &Value) -> Result<(), DeviceError> {
        self.loaded().await;
        let thread_id = input["threadId"].as_str().unwrap_or_default();
        let host_id = input["hostId"].as_str();
        let device_id = input["deviceId"].as_str();
        let shutdown = input["shutdown"].as_bool() == Some(true);
        let closing = {
            let _guard = self.0.lifecycle.lock().await;
            let state = self.snapshot();
            let closing: Vec<Session> = state
                .sessions
                .iter()
                .filter(|s| {
                    s.thread_id == thread_id
                        && host_id.is_none_or(|h| s.host_id == h)
                        && device_id.is_none_or(|d| s.device_id == d)
                })
                .cloned()
                .collect();
            let ending: Vec<Session> = if shutdown {
                state
                    .sessions
                    .iter()
                    .filter(|s| {
                        closing
                            .iter()
                            .any(|c| c.host_id == s.host_id && c.device_id == s.device_id)
                    })
                    .cloned()
                    .collect()
            } else {
                closing.clone()
            };
            for session in &ending {
                let host = self.resolve_host(Some(&session.host_id))?;
                let ready = host.current();
                if ready.is_none() && host.is_ssh() {
                    return Err(unavailable(
                        &host,
                        "Device host is reconnecting. Retry close after it reconnects.",
                    ));
                }
                if let Some(agent) = ready.as_ref().and_then(|r| r.agent.as_ref()) {
                    let name = agent::session_name(
                        &session.thread_id,
                        &session.host_id,
                        &session.device_id,
                    );
                    agent::release_session(agent, &name)
                        .await
                        .map_err(|cause| {
                            DeviceError::operation("close", "request_failed", cause)
                        })?;
                }
            }
            if shutdown {
                self.release_launchers(&ending).await;
                for session in &closing {
                    let Some(ready) = self.current_readiness(&session.host_id) else {
                        return Err(DeviceError::host(
                            &session.host_id,
                            None,
                            "Device host is not running. Reconnect before retrying close.",
                        ));
                    };
                    self.shutdown_device(&ready, &session.device_id, &session.platform)
                        .await?;
                }
            }
            self.publish(|s| s.sessions.retain(|x| !ending.contains(x)));
            closing
        };
        if shutdown {
            for session in &closing {
                if let Some(ready) = self.current_readiness(&session.host_id) {
                    let _ = self.refresh(&ready).await;
                }
            }
        }
        Ok(())
    }

    /// `shutdown`: the sessions retire first, while agent-device can still close the app.
    pub async fn shutdown(&self, input: &Value) -> Result<(), DeviceError> {
        self.loaded().await;
        let host = self.resolve_host(input["hostId"].as_str())?;
        let device_id = input["deviceId"].as_str().unwrap_or_default().to_owned();
        let platform = input["platform"].as_str().unwrap_or_default().to_owned();
        let (h, d) = (host.id().to_owned(), device_id.clone());
        self.publish(|s| s.sessions.retain(|x| !(x.host_id == h && x.device_id == d)));
        let ready = self.readiness(Some(host.id())).await?;
        self.shutdown_device(&ready, &device_id, &platform).await?;
        let _ = self.refresh(&ready).await;
        Ok(())
    }

    async fn resolve_device(
        &self,
        host_id: Option<&str>,
        device_id: &str,
    ) -> Result<(Ready, Device), DeviceError> {
        let host = self.resolve_host(host_id)?;
        let ready = self.readiness(Some(host.id())).await?;
        let found = match Self::find_device(&self.snapshot(), host.id(), device_id) {
            Some(device) => Some(device),
            None => Self::find_device(&self.refresh(&ready).await?, host.id(), device_id),
        };
        let device = found.ok_or_else(|| DeviceError::NotFound {
            host_id: host.id().into(),
            device_id: device_id.into(),
        })?;
        Ok((ready, device))
    }

    /// `detail`.
    pub async fn detail(&self, input: &Value) -> Result<Value, DeviceError> {
        self.loaded().await;
        let (ready, device) = self
            .resolve_device(
                input["hostId"].as_str(),
                input["deviceId"].as_str().unwrap_or_default(),
            )
            .await?;
        let read = actions::read(&ready, &device.platform, &device.id).await;
        Ok(json!({
            "hostId": ready.host_id,
            "deviceId": device.id,
            "settings": read["settings"],
            "foregroundApp": read["foregroundApp"],
            "readAt": conn_support::time::now_iso(),
        }))
    }

    /// `action`: runs it, then reads the detail again.
    pub async fn action(&self, input: &Value) -> Result<Value, DeviceError> {
        self.loaded().await;
        let (ready, device) = self
            .resolve_device(
                input["hostId"].as_str(),
                input["deviceId"].as_str().unwrap_or_default(),
            )
            .await?;
        actions::run(&ready, &device.platform, input).await?;
        self.detail(&json!({ "hostId": ready.host_id, "deviceId": device.id }))
            .await
    }

    /// `screenshot`: a complete PNG of the device's screen.
    pub async fn screenshot(
        &self,
        host_id: Option<&str>,
        device_id: &str,
    ) -> Result<(Device, Vec<u8>), DeviceError> {
        self.loaded().await;
        let (ready, device) = self.resolve_device(host_id, device_id).await?;
        let bytes = hub::screenshot(&ready, &to_hub(&device)).await?;
        let Some(png) = hub::extract_png(&bytes) else {
            return Err(DeviceError::operation(
                "screenshot",
                "hub_rejected",
                format!(
                    "The hub returned {} bytes without a complete PNG.",
                    bytes.len()
                ),
            ));
        };
        Ok((device, png.to_vec()))
    }

    /// `testHost`: probes an SSH host before it is saved.
    pub async fn test_host(&self, config: SshConfig) -> Result<Value, DeviceError> {
        if crate::loopback::is_local_ssh_host(&config).await {
            return Ok(self.0.local.summary().await.to_json());
        }
        let owner = self.owner(&config.id);
        ssh::probe(&config, &owner)
            .await
            .map(|summary| summary.to_json())
            .map_err(|error| match &error.kind {
                crate::host::HostErrorKind::Ssh(_)
                | crate::host::HostErrorKind::SshConnect(_)
                | crate::host::HostErrorKind::SshWindows => DeviceError::host(
                    &config.id,
                    Some(&config.label),
                    ssh::probe_failure_message(&error.kind),
                ),
                _ => DeviceError::operation("probe host", "request_failed", error.message()),
            })
    }

    /// The remote state folder of a host: T3 hashes the environment id as its file holds it,
    /// read once at start (`environment_file`), else the id the server loaded.
    fn owner(&self, host_id: &str) -> String {
        let environment = self
            .0
            .environment_file
            .get()
            .cloned()
            .unwrap_or_else(|| self.0.config.environment_id.clone());
        ssh::owner(
            &environment,
            &self.0.config.state_dir.display().to_string(),
            host_id,
        )
    }

    pub fn sessions_for_thread(&self, thread_id: &str) -> Vec<Session> {
        self.snapshot()
            .sessions
            .into_iter()
            .filter(|s| s.thread_id == thread_id)
            .collect()
    }

    /// Closes every device session of a closed thread, one at a time. Each is tried whatever
    /// the others did; the first failure comes back, so the caller tries again.
    pub async fn cleanup_thread(&self, thread_id: &str) -> Result<(), DeviceError> {
        let mut failed = None;
        for session in self.sessions_for_thread(thread_id) {
            let closed = self
                .close(&json!({ "threadId": thread_id, "hostId": session.host_id, "deviceId": session.device_id }))
                .await;
            if let Err(error) = closed {
                failed.get_or_insert(error);
            }
        }
        failed.map_or(Ok(()), Err)
    }

    /// `agentTarget`: the agent-device flags that reach the device.
    pub(crate) async fn agent_target(
        &self,
        thread_id: &str,
        host_id: &str,
        device_id: &str,
    ) -> Result<(String, String, Vec<String>), DeviceError> {
        self.loaded().await;
        let host = self.resolve_host(Some(host_id))?;
        let Some(ready) = self.agent_readiness_if_supported(Some(host_id)).await? else {
            return Err(unavailable(
                &host,
                "Agent device access requires enabled device support, agent access, and an available simulator platform on this host.",
            ));
        };
        let config_path = {
            let _guard = self.0.lifecycle.lock().await;
            if !self.still_current(&host) {
                return Err(unavailable(
                    &host,
                    "Host configuration changed. Retry the operation.",
                ));
            }
            let Some(agent) = ready.agent.clone() else {
                return Err(unavailable(&host, "This host has no agent-device daemon."));
            };
            self.write_agent_config(host_id, &agent)
                .await
                .map_err(|cause| {
                    DeviceError::operation("configure agent", "settings_failed", cause)
                })?
        };
        let session = agent::session_name(thread_id, host_id, device_id);
        Ok((
            device_id.to_owned(),
            session.clone(),
            vec!["--config".into(), config_path, "--session".into(), session],
        ))
    }

    pub(crate) async fn write_agent_config(
        &self,
        host_id: &str,
        agent: &crate::host::AgentEndpoint,
    ) -> Result<String, String> {
        let file = agent::config_path(&self.0.config.state_dir, host_id);
        let endpoint = agent.clone();
        let path = file.clone();
        blocking(move || agent::write_config(&path, &endpoint))
            .await
            .map_err(|e| e.to_string())?;
        Ok(file.display().to_string())
    }

    fn live_session_names(&self) -> Vec<String> {
        self.snapshot()
            .sessions
            .iter()
            .map(|s| agent::session_name(&s.thread_id, &s.host_id, &s.device_id))
            .collect()
    }

    /// `agentLauncher`: the command agents run for one session; `None` once it closed.
    pub(crate) async fn agent_launcher(
        &self,
        thread_id: &str,
        host_id: &str,
        device_id: &str,
        target_args: Vec<String>,
    ) -> Result<Option<String>, DeviceError> {
        let local = |reason: &str| DeviceError::host(LOCAL_HOST_ID, Some(LOCAL_HOST_LABEL), reason);
        let session = agent::session_name(thread_id, host_id, device_id);
        let node = blocking(|| {
            crate::process::find_on_path("node", None)
                .map(|p| std::fs::canonicalize(&p).unwrap_or(p))
        })
        .await
        .ok_or_else(|| local(&crate::host::node_missing("Device automation")))?;
        let tool = tools::ensure(&self.0.config.base_dir, Tool::Agent)
            .await
            .map_err(|e| {
                DeviceError::operation(
                    "install agent CLI",
                    "command_failed",
                    e.message(Tool::Agent),
                )
            })?;
        // The session is checked under the launcher lock, so a prune that runs meanwhile either
        // sees it live or finishes before the launcher is written.
        let _guard = self.0.launcher_lock.lock().await;
        if !self.live_session_names().contains(&session) {
            return Ok(None);
        }
        let (state_dir, node_text, entry) = (
            self.0.config.state_dir.clone(),
            node.display().to_string(),
            tool.entry.display().to_string(),
        );
        let bound_session = session.clone();
        let launcher = blocking(move || {
            agent::bind_launcher(&state_dir, &node_text, &entry, &bound_session, &target_args)
        })
        .await
        .map_err(|_| local("Could not prepare the agent-device launcher."))?;
        crate::lock(&self.0.launchers).insert(session, launcher.clone());
        Ok(Some(launcher))
    }

    /// Ends the agent-device sessions behind `launchers` all at once, as T3 does
    /// (`concurrency: "unbounded"`): a launcher lock held for the releases lasts one close
    /// timeout, however many hang.
    async fn release_all(&self, launchers: Vec<String>) {
        if launchers.is_empty() {
            return;
        }
        let Some(node) = blocking(|| crate::process::find_on_path("node", None)).await else {
            return;
        };
        let node = node.display().to_string();
        let timeout = *crate::lock(&self.0.release_timeout);
        let mut releasing = tokio::task::JoinSet::new();
        for launcher in launchers {
            let node = node.clone();
            releasing
                .spawn(async move { agent::release_launcher(&node, &launcher, timeout).await });
        }
        while releasing.join_next().await.is_some() {}
    }

    async fn release_launchers(&self, sessions: &[Session]) {
        let _guard = self.0.launcher_lock.lock().await;
        let launchers: Vec<String> = {
            let mut bound = crate::lock(&self.0.launchers);
            sessions
                .iter()
                .filter_map(|session| {
                    bound.remove(&agent::session_name(
                        &session.thread_id,
                        &session.host_id,
                        &session.device_id,
                    ))
                })
                .collect()
        };
        self.release_all(launchers).await;
    }

    /// Ends the agent-device sessions of retired device sessions and removes their launchers.
    /// The live sessions are read after the launcher lock is taken.
    async fn prune_launchers(&self) {
        let _guard = self.0.launcher_lock.lock().await;
        let live = self.live_session_names();
        let retired: Vec<String> = {
            let mut launchers = crate::lock(&self.0.launchers);
            let gone: Vec<String> = launchers
                .keys()
                .filter(|session| !live.contains(session))
                .cloned()
                .collect();
            gone.iter()
                .filter_map(|session| launchers.remove(session))
                .collect()
        };
        self.release_all(retired).await;
        // Sessions opened while the releases ran are live too.
        let live = self.live_session_names();
        let state_dir = self.0.config.state_dir.clone();
        blocking(move || agent::prune_launchers(&state_dir, &live)).await;
    }

    /// Follows `deviceHosts`: removed or changed hosts stop, new ones are added.
    async fn reconcile(&self) {
        let wanted = configured_hosts(&self.0.config.settings.read());
        let mut next = Vec::new();
        for config in wanted {
            if !crate::loopback::is_local_ssh_host(&config).await {
                next.push(config);
            }
        }
        let removed: Vec<Host> = {
            let _guard = self.0.lifecycle.lock().await;
            let mut configured = crate::lock(&self.0.configured);
            let mut hosts = crate::lock(&self.0.hosts);
            let keep: Vec<SshConfig> = configured
                .iter()
                .filter(|c| next.iter().any(|n| n.id == c.id && same_connection(n, c)))
                .cloned()
                .collect();
            let removed: Vec<Host> = hosts
                .iter()
                .filter(|h| h.is_ssh() && !keep.iter().any(|k| k.id == h.id()))
                .cloned()
                .collect();
            hosts.retain(|h| !h.is_ssh() || keep.iter().any(|k| k.id == h.id()));
            *configured = keep;
            removed
        };
        if !removed.is_empty() {
            self.refresh_hosts(
                &removed
                    .iter()
                    .map(|h| h.id().to_owned())
                    .collect::<Vec<_>>(),
            )
            .await;
        }
        for host in &removed {
            host.stop().await;
            let file = agent::config_path(&self.0.config.state_dir, host.id());
            blocking(move || std::fs::remove_file(file)).await.ok();
        }
        let added = {
            let _guard = self.0.lifecycle.lock().await;
            let mut added = false;
            for config in next {
                if crate::lock(&self.0.configured)
                    .iter()
                    .any(|c| c.id == config.id)
                {
                    continue;
                }
                added = true;
                let host = self.make_ssh_host(config.clone());
                crate::lock(&self.0.hosts).push(Host::Ssh(host));
                crate::lock(&self.0.configured).push(config);
            }
            added
        };
        if added || !removed.is_empty() {
            let ids: Vec<String> = removed.iter().map(|h| h.id().to_owned()).collect();
            self.refresh_hosts(&ids).await;
        }
    }

    fn make_ssh_host(&self, config: SshConfig) -> Arc<SshHost> {
        let owner = self.owner(&config.id);
        let weak = Arc::downgrade(&self.0);
        let status_weak = weak.clone();
        let id = config.id.clone();
        let status_id = id.clone();
        ssh::SshHost::new(
            config,
            owner,
            ssh::Hooks {
                status: Box::new(move |status, detail| {
                    if let Some(inner) = status_weak.upgrade() {
                        Devices(inner).set_host_status(&status_id, status, detail);
                    }
                }),
                agent_ready: Box::new(move |endpoint| {
                    let file = weak
                        .upgrade()
                        .map(|inner| agent::config_path(&inner.config.state_dir, &id));
                    Box::pin(async move {
                        let Some(file) = file else { return Ok(()) };
                        blocking(move || agent::write_config(&file, &endpoint))
                            .await
                            .map_err(|e| e.to_string())
                    })
                }),
            },
        )
    }

    /// `refreshHosts`: new summaries; removed hosts' statuses, devices and sessions go.
    async fn refresh_hosts(&self, removed: &[String]) {
        let summaries = self.summaries().await;
        self.publish(|state| {
            state.hosts = summaries;
            state.host_statuses.retain(|id, _| !removed.contains(id));
            state.devices.retain(|d| !removed.contains(&d.host_id));
            state.sessions.retain(|s| !removed.contains(&s.host_id));
        });
    }

    /// Stops every host's helpers, as the T3 server's finalizers do.
    /// Every host stops at once, so one unreachable host cannot hold up the others; the caller
    /// bounds the whole.
    pub async fn stop_all(&self) {
        let mut stopping = tokio::task::JoinSet::new();
        for host in self.hosts() {
            stopping.spawn(async move { host.stop().await });
        }
        while stopping.join_next().await.is_some() {}
    }
}

fn read_settings(settings: &dyn SettingsAccess) -> DeviceSettings {
    let raw = settings.read();
    DeviceSettings {
        enabled: flag(&raw, "enableDeviceSupport"),
        agent_access: flag(&raw, "enableAgentDeviceAccess"),
        onboarding: flag(&raw, "deviceOnboardingCompleted"),
    }
}

fn configured_hosts(settings: &Map<String, Value>) -> Vec<SshConfig> {
    let mut out: Vec<SshConfig> = Vec::new();
    for host in settings
        .get("deviceHosts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Ok(config) = serde_json::from_value::<SshConfig>(host.clone())
            && !out.iter().any(|c| c.id == config.id)
        {
            out.push(config);
        }
    }
    out
}

fn same_connection(a: &SshConfig, b: &SshConfig) -> bool {
    a.label == b.label
        && a.target == b.target
        && a.port == b.port
        && a.identity_file == b.identity_file
}

fn failure_detail(error: &DeviceError) -> String {
    match error {
        DeviceError::HostUnavailable { reason, .. } => reason.clone(),
        other => other.message(),
    }
}

fn to_device(host_id: &str, d: &HubDevice) -> Device {
    Device {
        host_id: host_id.to_owned(),
        id: d.id.clone(),
        platform: d.platform.clone(),
        name: d.name.clone(),
        version: d.version.clone(),
        booted: d.booted,
        physical: d.physical,
    }
}

fn to_hub(d: &Device) -> HubDevice {
    HubDevice {
        id: d.id.clone(),
        name: d.name.clone(),
        version: d.version.clone(),
        platform: d.platform.clone(),
        booted: d.booted,
        physical: d.physical,
    }
}

const FFMPEG_CHECK: &str = r#"const { spawnSync } = require("node:child_process");
  const result = spawnSync(process.env.SERVE_EMU_FFMPEG?.trim() || "ffmpeg", ["-hide_banner", "-encoders"], {
    stdio: "inherit", timeout: 10000, killSignal: "SIGKILL",
  });
  process.exitCode = result.error ? 1 : (result.status ?? 1);"#;

/// Android emulator video needs ffmpeg with libx264 on the device host.
async fn check_android_video(ready: &Ready, host_id: &str) -> Result<(), DeviceError> {
    let encoders = ready
        .run(
            &ready.node_path,
            &["-e".into(), FFMPEG_CHECK.into()],
            crate::host::RunOptions::default(),
        )
        .await;
    let fail = |reason: &str| DeviceError::PlatformUnavailable {
        host_id: host_id.into(),
        platform: "android".into(),
        reason: reason.into(),
    };
    if encoders.code != 0 {
        return Err(fail(
            "Android emulator video needs working ffmpeg with the libx264 encoder. Install it on the device host's PATH or set SERVE_EMU_FFMPEG there, then retry opening the emulator. After changing PATH or SERVE_EMU_FFMPEG, turn device support off and on for SSH hosts, or restart the local environment server.",
        ));
    }
    let text = format!("{}\n{}", encoders.stdout, encoders.stderr);
    let has = text.lines().any(|line| {
        let line = line.trim_start();
        let mut words = line.split([' ', '\t']).filter(|w| !w.is_empty());
        matches!((words.next(), words.next()), (Some(flags), Some("libx264")) if flags.starts_with('V'))
    });
    if !has {
        return Err(fail(
            "Android emulator video needs the libx264 encoder. Install an ffmpeg build that includes libx264 on the device host, then retry opening the emulator. After changing PATH or SERVE_EMU_FFMPEG, turn device support off and on for SSH hosts, or restart the local environment server.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestSettings(watch::Sender<u64>);

    impl SettingsAccess for TestSettings {
        fn read(&self) -> Map<String, Value> {
            Map::new()
        }
        fn update(&self, _patch: Value) -> BoxFuture<'static, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
        fn changes(&self) -> watch::Receiver<u64> {
            self.0.subscribe()
        }
    }

    fn devices(name: &str) -> (Devices, PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("conn-devices-{name}-{}", conn_support::uuid_v4()));
        let state_dir = dir.join("userdata");
        std::fs::create_dir_all(&state_dir).unwrap_or_default();
        let devices = Devices::start(Config {
            base_dir: dir.clone(),
            cwd: dir.clone(),
            environment_id: "env-1".into(),
            settings: Arc::new(TestSettings(watch::Sender::new(0))),
            state_dir,
        });
        (devices, dir)
    }

    fn session(thread: &str) -> Session {
        Session {
            thread_id: thread.into(),
            host_id: "mac".into(),
            device_id: "SIM".into(),
            platform: "ios".into(),
            opened_at: "2026-11-19T00:00:00.000Z".into(),
        }
    }

    /// A prune that waits for the launcher lock while a device opens reads the sessions after
    /// it gets the lock, so the new launcher stays. A prune that read them first (before the
    /// lock, or before awaiting releases) would delete it.
    #[tokio::test(flavor = "current_thread")]
    async fn a_waiting_prune_keeps_a_launcher_bound_meanwhile() {
        let (devices, dir) = devices("prune");
        // Let the start task finish its own prune.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let guard = devices.0.launcher_lock.lock().await;
        let pruning = tokio::spawn({
            let devices = devices.clone();
            async move { devices.prune_launchers().await }
        });
        tokio::task::yield_now().await;
        let opened = session("thread-new");
        devices.publish(|s| s.sessions.push(opened.clone()));
        let name = agent::session_name(&opened.thread_id, &opened.host_id, &opened.device_id);
        let launcher = agent::bind_launcher(devices.state_dir(), "/node", "/entry.mjs", &name, &[])
            .unwrap_or_default();
        crate::lock(&devices.0.launchers).insert(name.clone(), launcher.clone());
        drop(guard);
        let _ = pruning.await;
        assert!(
            std::path::Path::new(&launcher).exists(),
            "the new launcher stays"
        );
        assert!(
            crate::lock(&devices.0.launchers).contains_key(&name),
            "still bound"
        );
        // Once its session retires, the launcher goes.
        devices.publish(|s| s.sessions.clear());
        devices.prune_launchers().await;
        assert!(
            !std::path::Path::new(&launcher).exists(),
            "a retired launcher goes"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Retired launchers whose `close` hangs are released together: a `device_open` waiting for
    /// the launcher lock waits about one close timeout, not one per launcher.
    #[tokio::test(flavor = "current_thread")]
    async fn hanging_closes_hold_the_launcher_lock_for_one_timeout() {
        if crate::process::find_on_path("node", None).is_none() {
            eprintln!("no node on PATH: skipped");
            return;
        }
        let (devices, dir) = devices("hang");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let timeout = std::time::Duration::from_millis(600);
        *crate::lock(&devices.0.release_timeout) = timeout;
        for n in 0..4 {
            let name = format!("t3-hanging{n}");
            let launcher =
                agent::bind_launcher(devices.state_dir(), "/node", "/entry.mjs", &name, &[])
                    .unwrap_or_default();
            // `close` never ends: the release waits out its timeout.
            let script =
                std::path::Path::new(&launcher).with_file_name("agent-device-launcher.mjs");
            std::fs::write(script, "setInterval(() => {}, 1000);\n").unwrap_or_default();
            crate::lock(&devices.0.launchers).insert(name, launcher);
        }
        let pruning = tokio::spawn({
            let devices = devices.clone();
            async move { devices.prune_launchers().await }
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let started = std::time::Instant::now();
        let guard = devices.0.launcher_lock.lock().await;
        let waited = started.elapsed();
        drop(guard);
        let _ = pruning.await;
        assert!(
            waited < timeout * 2,
            "waited {waited:?} for the lock; four closes in a row would take {:?}",
            timeout * 4
        );
        assert!(crate::lock(&devices.0.launchers).is_empty(), "all released");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Settings a test can change while the service runs.
    struct MutableSettings(Mutex<Map<String, Value>>, watch::Sender<u64>);

    impl SettingsAccess for MutableSettings {
        fn read(&self) -> Map<String, Value> {
            crate::lock(&self.0).clone()
        }
        fn update(&self, _patch: Value) -> BoxFuture<'static, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
        fn changes(&self) -> watch::Receiver<u64> {
            self.1.subscribe()
        }
    }

    /// A service with one saved SSH host, `mac`, at an address nothing answers on.
    fn devices_with_saved_host(
        name: &str,
        enabled: bool,
    ) -> (Devices, Arc<MutableSettings>, PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("conn-devices-{name}-{}", conn_support::uuid_v4()));
        let state_dir = dir.join("userdata");
        std::fs::create_dir_all(&state_dir).unwrap_or_default();
        let raw = json!({
            "enableDeviceSupport": enabled,
            "enableAgentDeviceAccess": enabled,
            "deviceHosts": [{ "id": "mac", "label": "Mac", "target": "192.0.2.10" }],
        });
        let settings = Arc::new(MutableSettings(
            Mutex::new(raw.as_object().cloned().unwrap_or_default()),
            watch::Sender::new(0),
        ));
        let devices = Devices::start(Config {
            base_dir: dir.clone(),
            cwd: dir.clone(),
            environment_id: "env-1".into(),
            settings: settings.clone(),
            state_dir,
        });
        (devices, settings, dir)
    }

    /// The first request after a start finds a saved host: requests wait for the first host
    /// list, as T3 builds its service only after it.
    #[tokio::test(flavor = "current_thread")]
    async fn the_first_request_finds_a_saved_host() {
        let (devices, _settings, dir) = devices_with_saved_host("saved", false);
        let retried = devices.retry_host("mac").await;
        assert!(retried.is_ok(), "{:?}", retried.err().map(|e| e.message()));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A retry that waits for the lifecycle lock while the user turns device support off must
    /// not start agent tools after the lock frees.
    #[tokio::test(flavor = "current_thread")]
    async fn a_waiting_agent_start_honours_a_disable() {
        let (devices, settings, dir) = devices_with_saved_host("disable", true);
        devices.loaded().await;
        let guard = devices.0.lifecycle.lock().await;
        let starting = tokio::spawn({
            let devices = devices.clone();
            async move {
                devices
                    .agent_readiness_if_supported(Some("mac"))
                    .await
                    .map(|ready| ready.is_some())
                    .map_err(|e| e.message())
            }
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        crate::lock(&settings.0).insert("enableDeviceSupport".into(), Value::Bool(false));
        drop(guard);
        let started = tokio::time::timeout(std::time::Duration::from_secs(5), starting).await;
        assert!(
            matches!(started, Ok(Ok(Ok(false)))),
            "started agent tools after the disable: {started:?}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A closed thread's device on an SSH host that is reconnecting cannot be released: the
    /// cleanup says so, so the effect that asked tries again, and the session stays.
    #[tokio::test(flavor = "current_thread")]
    async fn a_thread_cleanup_reports_a_device_it_could_not_close() {
        let (devices, _settings, dir) = devices_with_saved_host("cleanup", false);
        devices.loaded().await;
        devices.publish(|s| s.sessions.push(session("thread-1")));
        let Err(error) = devices.cleanup_thread("thread-1").await else {
            panic!("a device that stayed open was reported closed");
        };
        assert!(
            error.message().contains("reconnecting"),
            "{}",
            error.message()
        );
        assert_eq!(devices.sessions_for_thread("thread-1").len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The SSH host writes the daemon config through the async hook, off the runtime thread.
    #[tokio::test(flavor = "current_thread")]
    async fn the_agent_hook_writes_the_config() {
        let (devices, dir) = devices("hook");
        let host = devices.make_ssh_host(SshConfig {
            id: "mac".into(),
            label: "Mac".into(),
            target: "192.0.2.10".into(),
            identity_file: None,
            port: None,
        });
        let endpoint = crate::host::AgentEndpoint {
            base_url: "http://127.0.0.1:9".into(),
            token: "t".into(),
            entry_path: "/e".into(),
        };
        let written = (host.hooks.agent_ready)(endpoint).await;
        assert!(written.is_ok(), "{written:?}");
        let file = agent::config_path(devices.state_dir(), "mac");
        let text = std::fs::read_to_string(file).unwrap_or_default();
        assert_eq!(
            text, r#"{"daemonAuthToken":"t","daemonBaseUrl":"http://127.0.0.1:9"}"#,
            "config"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
