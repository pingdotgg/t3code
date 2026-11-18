//! Server-owned browser tabs: lazy hosts, bounded sessions and idle cleanup.
use crate::{Browser, Error, Launch, install::Installer, spec::spec};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, broadcast, watch};
use tokio::time::Instant;

mod profiles;
mod viewer;
pub use crate::screencast::Frame as ViewerFrame;
pub use viewer::{ADMISSION_REFUSED, Output as ViewerOutput, Viewer};

const HOST_IDLE: Duration = Duration::from_secs(5 * 60);

#[derive(Debug)]
struct Host {
    key: String,
    browser: Browser,
    empty_since: Instant,
}
#[derive(Debug)]
struct Tab {
    thread: String,
    id: String,
    owner: Option<String>,
    host: String,
    target: String,
    session: String,
    context: Option<String>,
    url: Option<String>,
    title: Option<String>,
    loading: bool,
    dialog: Value,
    viewers: Vec<String>,
    cast: Option<crate::screencast::Screencast>,
    controller: Option<String>,
    generation: u64,
    control: watch::Sender<Value>,
    viewport: Value,
    fill_size: Option<Value>,
    appearance: String,
    console_entries: std::collections::VecDeque<Value>,
    network_entries: std::collections::VecDeque<Value>,
    timeline: std::collections::VecDeque<Value>,
    snapshot: Value,
    used: Instant,
    action: Arc<AsyncMutex<()>>,
    chooser: Option<FileChooser>,
    recording: Option<crate::recording::Recording>,
    loaded: watch::Sender<String>,
    browser: Browser,
}
#[derive(Debug)]
struct FileChooser {
    node: u64,
    multiple: bool,
    accept: String,
}
#[derive(Debug)]
struct State {
    tabs: Vec<Tab>,
    hosts: Vec<Host>,
    revision: u64,
    sequence: u64,
    profiles: Vec<Value>,
    profile_reports: Vec<(u64, Vec<Value>, String)>,
    default_profile: Option<String>,
    recording_rate: u64,
    pending_popups: Vec<(String, String, Option<String>)>,
}
#[derive(Debug)]
struct Inner {
    state: Mutex<State>,
    open: AsyncMutex<()>,
    profiles_loaded: tokio::sync::OnceCell<()>,
    profiles_save: AsyncMutex<()>,
    installer: Arc<Installer>,
    html_preview: crate::html::HtmlPreview,
    directory: PathBuf,
    epoch: String,
    events: broadcast::Sender<Value>,
    fixture: Option<PathBuf>,
    recording_slots: Arc<tokio::sync::Semaphore>,
}
/// A server's browser state. Constructing it does not create files or launch a process.
#[derive(Clone, Debug)]
pub struct Preview(Arc<Inner>);
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
impl Preview {
    pub fn new(directory: PathBuf) -> Self {
        Self::build(directory, None)
    }
    pub fn with_fixture(directory: PathBuf, executable: PathBuf) -> Self {
        Self::build(directory, Some(executable))
    }
    fn build(directory: PathBuf, fixture: Option<PathBuf>) -> Self {
        let installer = Arc::new(Installer::new(
            if directory.file_name().is_some_and(|n| n == "userdata") {
                directory.parent().unwrap_or(&directory).to_path_buf()
            } else {
                directory.clone()
            },
        ));
        let (events, _) = broadcast::channel(128);
        let result = Self(Arc::new(Inner {
            state: Mutex::new(State {
                tabs: vec![],
                hosts: vec![],
                revision: 0,
                sequence: 0,
                profiles: spec().map(|s| s.profiles.clone()).unwrap_or_default(),
                default_profile: None,
                recording_rate: 30,
                profile_reports: vec![],
                pending_popups: vec![],
            }),
            open: AsyncMutex::new(()),
            profiles_loaded: tokio::sync::OnceCell::new(),
            profiles_save: AsyncMutex::new(()),
            html_preview: crate::html::HtmlPreview::with_installer(installer.clone()),
            installer,
            directory,
            epoch: conn_support::uuid_v4(),
            events,
            fixture,
            recording_slots: Arc::new(tokio::sync::Semaphore::new(2)),
        }));
        let weak = Arc::downgrade(&result.0);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let Some(inner) = weak.upgrade() else {
                    break;
                };
                Self(inner).sweep().await;
            }
        });
        result
    }
    pub fn html_preview(&self) -> &crate::html::HtmlPreview {
        &self.0.html_preview
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.0.events.subscribe()
    }
    pub fn list(&self, thread: &str) -> Value {
        let state = lock(&self.0.state);
        json!({"sessions":state.tabs.iter().filter(|t|t.thread==thread).map(|t|t.snapshot.clone()).collect::<Vec<_>>(),"serverEpoch":self.0.epoch,"revision":state.revision})
    }
    pub async fn close(&self, thread: &str, tab: Option<&str>) -> Result<(), Error> {
        let removed = {
            let mut state = lock(&self.0.state);
            let mut removed = vec![];
            let mut kept = vec![];
            for tab_state in state.tabs.drain(..) {
                if tab_state.thread == thread && tab.is_none_or(|id| id == tab_state.id) {
                    removed.push(tab_state);
                } else {
                    kept.push(tab_state);
                }
            }
            state.tabs = kept;
            for tab in &removed {
                publish(&self.0, &mut state, "closed", &tab.snapshot);
            }
            removed
        };
        for mut tab in removed {
            if let Some(recording) = tab.recording.take() {
                recording.discard().await;
            }
            if let Some(context) = tab.context.filter(|context| {
                !lock(&self.0.state)
                    .tabs
                    .iter()
                    .any(|t| t.context.as_ref() == Some(context))
            }) {
                let _ = tab
                    .browser
                    .send(
                        "Target.disposeBrowserContext",
                        json!({"browserContextId":context}),
                        None,
                    )
                    .await;
            } else {
                let _ = tab
                    .browser
                    .send("Target.closeTarget", json!({"targetId":tab.target}), None)
                    .await;
            }
        }
        Ok(())
    }
    pub async fn shutdown(&self) {
        let _open = self.0.open.lock().await;
        let hosts = {
            let mut state = lock(&self.0.state);
            state.tabs.clear();
            std::mem::take(&mut state.hosts)
        };
        for host in hosts {
            host.browser.close().await;
        }
    }
    async fn sweep(&self) {
        let _open = self.0.open.lock().await;
        let Ok(spec) = spec() else { return };
        let stale = {
            let state = lock(&self.0.state);
            state
                .tabs
                .iter()
                .filter(|t| {
                    t.viewers.is_empty()
                        && t.used.elapsed() >= Duration::from_millis(spec.agent_tab_idle_ms)
                })
                .map(|t| (t.thread.clone(), t.id.clone()))
                .collect::<Vec<_>>()
        };
        for (thread, id) in stale {
            let _ = self.close(&thread, Some(&id)).await;
        }
        let retired = {
            let mut state = lock(&self.0.state);
            let active = state
                .tabs
                .iter()
                .map(|t| t.host.clone())
                .collect::<Vec<_>>();
            let mut retired = vec![];
            state.hosts.retain_mut(|host| {
                if active.contains(&host.key) {
                    host.empty_since = Instant::now();
                    true
                } else if host.empty_since.elapsed() >= HOST_IDLE {
                    retired.push(host.browser.clone());
                    false
                } else {
                    true
                }
            });
            retired
        };
        for browser in retired {
            browser.close().await;
        }
    }
    pub async fn invoke(
        &self,
        thread: &str,
        agent: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, Error> {
        self.load_profiles().await;
        if operation == "open" {
            return self.open(thread, agent, input).await;
        }
        if operation == "status" {
            return Ok(self.status(thread, agent, input.get("tabId").and_then(Value::as_str)));
        }
        let explicit = input.get("tabId").and_then(Value::as_str);
        if operation == "recordingStop" {
            let state = lock(&self.0.state);
            if state
                .tabs
                .iter()
                .filter(|t| t.thread == thread && t.owner.as_deref() == Some(agent))
                .count()
                > 1
                && explicit.is_none()
            {
                return Err(Error("Multiple browser tabs belong to this session. Pass a tabId from preview_open or from the tabs listed by preview_status.".into()));
            }
            if !state.tabs.iter().any(|t| {
                t.thread == thread && t.recording.is_some() && explicit.is_none_or(|id| id == t.id)
            }) {
                return Err(Error("No recording is active for this thread.".into()));
            }
        }
        let (id, browser, session, mut loaded, action, chooser) = {
            let mut state = lock(&self.0.state);
            let owned = state
                .tabs
                .iter()
                .filter(|t| t.thread == thread && t.owner.as_deref() == Some(agent))
                .count();
            if explicit.is_none() && owned > 1 {
                return Err(Error("Multiple browser tabs belong to this session. Pass a tabId from preview_open or from the tabs listed by preview_status.".into()));
            }
            let tab = find_tab(&mut state, thread, agent, explicit).ok_or_else(|| {
                Error(
                    "No server preview tab is open for this thread. Call preview_open first."
                        .into(),
                )
            })?;
            if !matches!(operation, "snapshot" | "waitFor")
                && tab.owner.is_some()
                && tab.owner.as_deref() != Some(agent)
            {
                return Err(Error("This tab belongs to another agent session. Open your own tab with preview_open.".into()));
            }
            if !tab.dialog.is_null() && operation != "dialog" && operation != "close" {
                return Err(Error("A browser dialog is pending. Read preview_status and resolve it with preview_dialog.".into()));
            }
            if !matches!(operation, "snapshot" | "waitFor" | "dialog") && tab.controller.is_some() {
                return Err(Error(
                    "A human controls this browser tab. Wait until they release control.".into(),
                ));
            }
            if operation == "close" && tab.owner.is_none() {
                return Err(Error(
                    "This tab has no agent owner. Ask the user to close it in the browser panel."
                        .into(),
                ));
            }
            tab.used = Instant::now();
            (
                tab.id.clone(),
                tab.browser.clone(),
                tab.session.clone(),
                tab.loaded.subscribe(),
                tab.action.clone(),
                tab.chooser.as_ref().map(|chooser| chooser.node),
            )
        };
        let _action = if matches!(operation, "dialog" | "close") {
            None
        } else {
            Some(action.lock().await)
        };
        {
            let state = lock(&self.0.state);
            let tab = state
                .tabs
                .iter()
                .find(|t| t.id == id)
                .ok_or_else(|| Error("The preview tab is closed.".into()))?;
            if tab.controller.is_some() && !matches!(operation, "snapshot" | "waitFor") {
                return Err(Error("A human controls this tab.".into()));
            }
        }
        let send =
            |method: &'static str, params: Value| browser.send(method, params, Some(&session));
        let trace = if (operation == "navigate"
            && input.get("_fromOpen").and_then(Value::as_bool) != Some(true))
            || matches!(
                operation,
                "click" | "hover" | "type" | "select" | "press" | "scroll" | "drag" | "upload"
            ) {
            Some(ActionTrace::new(self, thread, &id, operation))
        } else {
            None
        };
        let mut handoff = {
            let state = lock(&self.0.state);
            state
                .tabs
                .iter()
                .find(|t| t.id == id)
                .map(|t| t.control.subscribe())
                .ok_or_else(|| Error("The preview tab is closed.".into()))?
        };
        let control_generation = handoff.borrow().get("generation").cloned();
        let mut dialogs = handoff.clone();
        let operation_future = async {
            match operation {
                "close" => {
                    self.close(thread, Some(&id)).await?;
                    Ok(json!({}))
                }
                "cdpEndpoint" => Err(Error(
                    "Not supported on server tabs: temporary CDP endpoints. Use a desktop tab."
                        .into(),
                )),
                "navigate" => {
                    let url = navigation_url(&input)?;
                    loaded.borrow_and_update();
                    let result = send("Page.navigate", json!({"url":url})).await?;
                    if let Some(reason) = result.get("errorText").and_then(Value::as_str) {
                        return Err(Error(format!("Navigation to {url} failed: {reason}")));
                    }
                    let readiness = input
                        .get("readiness")
                        .and_then(Value::as_str)
                        .unwrap_or("load");
                    if readiness != "none" {
                        wait_loaded(
                            &mut loaded,
                            readiness,
                            input
                                .get("timeoutMs")
                                .and_then(Value::as_u64)
                                .unwrap_or(15_000),
                        )
                        .await?;
                    }
                    self.refresh_title(thread, &id, &browser, &session).await;
                    Ok(self.status(thread, agent, Some(&id)))
                }
                "recordingStart" => {
                    {
                        let state = lock(&self.0.state);
                        if let Some(recording) = state
                            .tabs
                            .iter()
                            .find(|t| t.id == id)
                            .and_then(|t| t.recording.as_ref())
                        {
                            return Ok(
                                json!({"tabId":id,"recording":true,"startedAt":recording.started}),
                            );
                        }
                    }
                    let slot =
                        self.0
                            .recording_slots
                            .clone()
                            .try_acquire_owned()
                            .map_err(|_| {
                                Error("Too many recordings are active (2 per server).".into())
                            })?;
                    let target = lock(&self.0.state)
                        .tabs
                        .iter()
                        .find(|t| t.id == id)
                        .map(|t| t.target.clone())
                        .ok_or_else(|| {
                            Error("This browser tab is closed. Call preview_open.".into())
                        })?;
                    let rate = lock(&self.0.state).recording_rate;
                    let recording =
                        crate::recording::Recording::start(browser.clone(), &target, slot, rate)
                            .await?;
                    let started = recording.started.clone();
                    let mut state = lock(&self.0.state);
                    if let Some(tab) = state.tabs.iter_mut().find(|t| t.id == id) {
                        tab.recording = Some(recording);
                    }
                    Ok(json!({"tabId":id,"recording":true,"startedAt":started}))
                }
                "recordingStop" => {
                    let recording = lock(&self.0.state)
                        .tabs
                        .iter_mut()
                        .find(|t| t.id == id)
                        .and_then(|t| t.recording.take())
                        .ok_or_else(|| Error("No recording is active for this thread.".into()))?;
                    recording.finish(thread, &id, &self.0.directory).await
                }
                "snapshot" => {
                    let generation = conn_support::uuid_v4().replace('-', "");
                    let mut snapshot = tokio::time::timeout(
                        Duration::from_secs(10),
                        crate::page::snapshot(&browser, &session, &input, &generation),
                    )
                    .await
                    .map_err(|_| {
                        Error(
                            "Snapshot capture timed out after 10000ms. Try the snapshot again."
                                .into(),
                        )
                    })??;
                    {
                        let state = lock(&self.0.state);
                        if let Some(tab) = state.tabs.iter().find(|t| t.id == id) {
                            snapshot["consoleEntries"] = json!(tab.console_entries);
                            snapshot["networkEntries"] = json!(
                                tab.network_entries
                                    .iter()
                                    .map(|entry| {
                                        let mut entry = entry.clone();
                                        entry.as_object_mut().map(|e| e.remove("_id"));
                                        entry
                                    })
                                    .collect::<Vec<_>>()
                            );
                            snapshot["actionTimeline"] = json!(tab.timeline);
                        }
                    }
                    let hidden = crate::page::secrets(&browser, &session).await?;
                    let full_image = snapshot
                        .as_object_mut()
                        .and_then(|o| o.remove("fullScreenshot"));
                    let image = snapshot
                        .as_object_mut()
                        .and_then(|o| o.remove("screenshot"));
                    crate::page::redact(&mut snapshot, &hidden);
                    if let Some(full_image) = full_image {
                        snapshot["fullScreenshot"] = full_image;
                    }
                    if let Some(image) = image {
                        snapshot["screenshot"] = image;
                    }
                    Ok(snapshot)
                }
                "waitFor" => crate::page::wait_for(&browser, &session, &input).await,
                "click" | "hover" | "type" | "select" | "press" | "scroll" | "drag" | "upload" => {
                    let mut input = input.clone();
                    if operation == "upload" {
                        crate::page::upload_paths(&input)?;
                    }
                    if operation == "upload"
                        && input.get("locator").is_none()
                        && input.get("selector").is_none()
                    {
                        let node=chooser.ok_or_else(||Error("No file chooser is open. Click an upload control first, or pass a locator.".into()))?;
                        let paths = input.get("paths");
                        browser
                            .send(
                                "DOM.setFileInputFiles",
                                json!({"backendNodeId":node,"files":paths}),
                                Some(&session),
                            )
                            .await?;
                        if let Some(tab) = lock(&self.0.state).tabs.iter_mut().find(|t| t.id == id)
                        {
                            tab.chooser = None;
                        }
                        return Ok(json!({}));
                    }
                    input.as_object_mut().map(|args| args.remove("action"));
                    let timeout = input
                        .get("timeoutMs")
                        .and_then(Value::as_u64)
                        .unwrap_or(15_000);
                    let encoder = lock(&self.0.state)
                        .tabs
                        .iter()
                        .find(|t| t.id == id)
                        .and_then(|t| t.recording.as_ref())
                        .map(|r| r.encoder.clone());
                    match tokio::time::timeout(
                        Duration::from_millis(timeout),
                        crate::page::action(
                            &browser,
                            &session,
                            operation,
                            &input,
                            encoder.as_deref(),
                        ),
                    )
                    .await
                    {
                        Ok(result) => result,
                        Err(_) => {
                            let reason = if operation == "click" {
                                crate::page::target_timeout(&browser, &session, &input).await
                            } else {
                                String::new()
                            };
                            Err(Error(format!(
                                "Preview automation {operation} timed out after {timeout}ms.{reason}"
                            )))
                        }
                    }
                }
                "evaluate" => {
                    let timeout = input
                        .get("timeoutMs")
                        .and_then(Value::as_u64)
                        .unwrap_or(15_000);
                    let params = json!({"expression":input.get("expression").cloned().unwrap_or(Value::Null),"awaitPromise":input.get("awaitPromise").and_then(Value::as_bool).unwrap_or(true),"returnByValue":true});
                    let mut result = match tokio::time::timeout(
                        Duration::from_millis(timeout),
                        send("Runtime.evaluate", params.clone()),
                    )
                    .await
                    {
                        Ok(result) => result?,
                        Err(_) => {
                            let _ = send("Runtime.terminateExecution", json!({})).await;
                            return Err(Error(format!(
                                "Preview automation evaluate timed out after {timeout}ms."
                            )));
                        }
                    };
                    if result
                        .pointer("/exceptionDetails/exception/className")
                        .and_then(Value::as_str)
                        == Some("SyntaxError")
                        && result.pointer("/exceptionDetails/scriptId").is_some()
                        && result.pointer("/exceptionDetails/stackTrace").is_none()
                        && input
                            .get("expression")
                            .and_then(Value::as_str)
                            .is_some_and(|s| s.contains("await"))
                    {
                        let mut params = params;
                        params["replMode"] = json!(true);
                        result = send("Runtime.evaluate", params).await?;
                    }
                    if let Some(details) = result.get("exceptionDetails") {
                        return Err(Error(format!(
                            "Preview automation evaluate failed: {}",
                            details
                                .pointer("/exception/description")
                                .or_else(|| details.get("text"))
                                .and_then(Value::as_str)
                                .unwrap_or("JavaScript failed.")
                        )));
                    }
                    let mut value = result
                        .pointer("/result/value")
                        .cloned()
                        .or_else(|| result.pointer("/result/description").cloned())
                        .unwrap_or(Value::Null);
                    if serde_json::to_vec(&value).map_err(crate::err)?.len() > 64_000 {
                        return Err(Error(
                        "Preview automation evaluate produced a result larger than 64000 bytes."
                            .into(),
                    ));
                    }
                    let hidden = crate::page::secrets(&browser, &session).await?;
                    crate::page::redact(&mut value, &hidden);
                    Ok(value)
                }
                "dialog" => {
                    if lock(&self.0.state)
                        .tabs
                        .iter()
                        .find(|t| t.id == id)
                        .is_some_and(|t| t.dialog.is_null())
                    {
                        return Err(Error(
                            "Preview automation dialog failed: No dialog is pending.".into(),
                        ));
                    }
                    send("Page.handleJavaScriptDialog",json!({"accept":input.get("accept").and_then(Value::as_bool).unwrap_or(false),"promptText":input.get("promptText").and_then(Value::as_str).unwrap_or_default()})).await?;
                    if let Some(tab) = lock(&self.0.state).tabs.iter_mut().find(|t| t.id == id) {
                        tab.dialog = Value::Null;
                        let _ = tab.control.send(viewer::control_message(tab));
                    }
                    let _ = crate::page::utility(
                        &browser,
                        &session,
                        "globalThis.__connRefGeneration=null;return null;",
                    )
                    .await;
                    Ok(self.status(thread, agent, Some(&id)))
                }
                "resize" => {
                    let setting = resolve_viewport(&input)?;
                    self.resize(thread, &id, setting.clone()).await?;
                    let viewport = lock(&self.0.state)
                        .tabs
                        .iter()
                        .find(|t| t.id == id)
                        .map(|t| t.viewport.clone())
                        .unwrap_or(Value::Null);
                    Ok(json!({"tabId":id,"setting":setting,"viewport":viewport}))
                }
                "setColorScheme" => {
                    let color = input
                        .get("colorScheme")
                        .and_then(Value::as_str)
                        .unwrap_or("system");
                    self.appearance(thread, &id, color).await?;
                    Ok(json!({"tabId":id,"colorScheme":color}))
                }
                _ => Err(Error(format!(
                    "The server browser does not serve {operation}."
                ))),
            }
        };
        let result = if matches!(operation, "dialog" | "close") {
            operation_future.await
        } else {
            tokio::select! {
                result = operation_future => result,
                () = async {
                    loop {
                        if dialogs.borrow().get("dialog").is_some_and(|v| !v.is_null()) { break; }
                        if dialogs.changed().await.is_err() { break; }
                    }
                }, if operation == "click" => Ok(json!({})),
                () = async {
                    loop {
                        if handoff.changed().await.is_err() { break; }
                        if handoff.borrow().get("generation") != control_generation.as_ref() { break; }
                    }
                } => Err(Error("A human controls this tab.".into())),
            }
        };
        if let Some(trace) = trace {
            trace.complete(&result);
        }
        result
    }
    pub fn status(&self, thread: &str, agent: &str, explicit: Option<&str>) -> Value {
        let mut state = lock(&self.0.state);
        let profile = profiles(&state);
        let Some(tab) = find_tab(&mut state, thread, agent, explicit) else {
            let mut status = json!({"available":false,"visible":false,"tabId":null,"url":null,"title":null,"loading":false,"profiles":profile.0});
            if let Some(default) = profile.1 {
                status["defaultProfileId"] = json!(default);
            }
            return status;
        };
        let mut status = json!({"available":true,"visible":!tab.viewers.is_empty(),"tabId":tab.id,"url":tab.url,"title":if tab.dialog.is_null(){tab.title.clone()}else{None},"loading":tab.loading,"control":{"owner":if tab.controller.is_some(){"human"}else if tab.owner.is_some(){"agent"}else{"unclaimed"},"ownedByCaller":tab.owner.as_deref()==Some(agent),"generation":tab.generation},"dialog":tab.dialog,"fileChooser":tab.chooser.as_ref().map(|chooser|json!({"multiple":chooser.multiple,"accept":chooser.accept})),"viewportSetting":tab.snapshot.get("viewport"),"viewport":tab.viewport,"downloads":[],"profiles":profile.0});
        if let Some(default) = profile.1 {
            status["defaultProfileId"] = json!(default);
        }
        status["tabs"]=json!(state.tabs.iter().filter(|t|t.thread==thread).map(|t|json!({"tabId":t.id,"url":t.url,"owner":if t.controller.is_some(){"human"}else if t.owner.is_some(){"agent"}else{"unclaimed"},"ownedByCaller":t.owner.as_deref()==Some(agent),"visible":!t.viewers.is_empty()})).collect::<Vec<_>>());
        status
    }
    async fn open(&self, thread: &str, agent: &str, input: Value) -> Result<Value, Error> {
        if let Some(url) = input.get("url").and_then(Value::as_str) {
            normalize_url(url)?;
        }
        let _gate = self.0.open.lock().await;
        let reuse = input
            .get("reuseExistingTab")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let explicit = input.get("tabId").and_then(Value::as_str);
        if !reuse && explicit.is_some() {
            return Err(Error(
                "tabId cannot be combined with reuseExistingTab=false.".into(),
            ));
        }
        let existing = {
            let mut state = lock(&self.0.state);
            let count = state
                .tabs
                .iter()
                .filter(|t| t.thread == thread && t.owner.as_deref() == Some(agent))
                .count();
            if reuse && explicit.is_none() && count > 1 {
                return Err(Error("Multiple browser tabs belong to this session. Pass a tabId from preview_open or from the tabs listed by preview_status.".into()));
            }
            if reuse {
                find_tab(&mut state, thread, agent, explicit)
                    .filter(|t| explicit.is_some() || t.owner.as_deref() == Some(agent))
                    .map(|t| t.id.clone())
            } else {
                None
            }
        };
        if let Some(id) = existing {
            {
                let state = lock(&self.0.state);
                let tab = state.tabs.iter().find(|t| t.id == id).ok_or_else(|| {
                    Error("The requested server preview tab does not exist.".into())
                })?;
                if tab.owner.as_deref().is_some_and(|owner| owner != agent) {
                    return Err(Error("This tab belongs to another agent session. Open your own tab with preview_open.".into()));
                }
                if !tab.dialog.is_null() {
                    return Err(Error("A browser dialog is pending. Read preview_status and resolve it with preview_dialog.".into()));
                }
                if tab.controller.is_some() {
                    return Err(Error(
                        "A human controls this browser tab. Wait until they release control."
                            .into(),
                    ));
                }
            }
            if input.get("url").is_some() || input.get("target").is_some() {
                let mut navigation = input.clone();
                navigation["tabId"] = json!(id);
                navigation["_fromOpen"] = json!(true);
                Box::pin(self.invoke(thread, agent, "navigate", navigation)).await?;
            }
            self.reveal(thread, &id, &input);
            return Ok(self.status(thread, agent, Some(&id)));
        }
        if explicit.is_some() {
            return Err(Error(
                "The requested server preview tab does not exist.".into(),
            ));
        }
        {
            let state = lock(&self.0.state);
            if state.tabs.len() >= spec()?.server_tab_limit
                || state
                    .tabs
                    .iter()
                    .filter(|t| t.thread == thread && t.owner.as_deref() == Some(agent))
                    .count()
                    >= spec()?.agent_tab_limit
            {
                return Err(Error("Too many server browser tabs are open. Close one with t3_preview_close, or reuse a tabId from preview_status tabs.".into()));
            }
        }
        // Explicit persistent profiles need separate Chrome processes to preserve their on-disk partition.
        let profile = {
            let state = lock(&self.0.state);
            let requested = input
                .get("profileId")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| state.default_profile.clone());
            if let Some(requested) = requested {
                Some(
                    state
                        .profiles
                        .iter()
                        .find(|p| {
                            p.get("id").and_then(Value::as_str) == Some(&requested)
                                || p.get("name")
                                    .and_then(Value::as_str)
                                    .is_some_and(|n| n.eq_ignore_ascii_case(&requested))
                        })
                        .and_then(|p| p.get("id").and_then(Value::as_str))
                        .ok_or_else(|| {
                            Error(format!(
                                "No browser profile is named \"{requested}\". Use one of: {}.",
                                state
                                    .profiles
                                    .iter()
                                    .map(|p| format!(
                                        "{} (id {})",
                                        p.get("name").and_then(Value::as_str).unwrap_or_default(),
                                        p.get("id").and_then(Value::as_str).unwrap_or_default()
                                    ))
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            ))
                        })?
                        .to_owned(),
                )
            } else {
                None
            }
        };
        let key = profile
            .as_deref()
            .filter(|p| *p != "incognito")
            .map(|p| format!("profile:{p}"))
            .unwrap_or_else(|| {
                if input.get("_unclaimed").and_then(Value::as_bool) == Some(true) {
                    "profile:default".into()
                } else {
                    "__shared".into()
                }
            });
        let browser = self.host(&key).await?;
        let context = if key == "__shared" {
            let result = browser
                .send(
                    "Target.createBrowserContext",
                    json!({"disposeOnDetach":true}),
                    None,
                )
                .await?;
            Some(
                result
                    .get("browserContextId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| Error("Chrome returned no context.".into()))?
                    .to_owned(),
            )
        } else {
            None
        };
        browser.deny_downloads(context.as_deref()).await?;
        let mut params = json!({"url":"about:blank"});
        if let Some(context) = &context {
            params["browserContextId"] = json!(context);
        }
        let target = browser.send("Target.createTarget", params, None).await?;
        let target = target
            .get("targetId")
            .and_then(Value::as_str)
            .ok_or_else(|| Error("Chrome returned no target.".into()))?
            .to_owned();
        let attached = browser
            .send(
                "Target.attachToTarget",
                json!({"targetId":target,"flatten":true}),
                None,
            )
            .await?;
        let session = attached
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| Error("Chrome returned no session.".into()))?
            .to_owned();
        initialize_page(&browser, &session).await?;
        let id = {
            let mut state = lock(&self.0.state);
            state.sequence += 1;
            let id = format!("tab_{}_{}", base36(state.sequence), self.0.epoch);
            let (loaded, _) = watch::channel(String::new());
            let mut snapshot = json!({"threadId":thread,"tabId":id,"navStatus":{"_tag":"Idle"},"canGoBack":false,"canGoForward":false,"runtime":"server","headless":true,"viewport":{"_tag":"fill"},"automationOwner":agent,"updatedAt":now()});
            if input.get("_unclaimed").and_then(Value::as_bool) != Some(true) {
                snapshot["reveal"] = json!(false);
            } else if let Some(reveal) = input.get("reveal") {
                snapshot["reveal"] = reveal.clone();
            }
            if input.get("_unclaimed").and_then(Value::as_bool) == Some(true) {
                snapshot
                    .as_object_mut()
                    .map(|s| s.remove("automationOwner"));
            }
            if let Some(profile) = &profile {
                snapshot["profileId"] = json!(profile);
            }
            state.tabs.push(Tab {
                thread: thread.into(),
                id: id.clone(),
                owner: if input.get("_unclaimed").and_then(Value::as_bool)==Some(true){None}else{Some(agent.into())},
                host: key,
                target,
                session: session.clone(),
                context,
                url: None,
                title: None,
                loading: false,
                dialog: Value::Null,
                viewers:vec![],cast:None,
                controller:None,
                generation:0,
                control:watch::channel(json!({"type":"control","canOperate":true,"controller":"agent","generation":0,"dialog":null})).0,
                fill_size:None,
                viewport: json!({"width":1280,"height":800}),
                appearance: "system".into(),
                console_entries:std::collections::VecDeque::new(),
                network_entries:std::collections::VecDeque::new(),
                timeline:std::collections::VecDeque::new(),
                snapshot: snapshot.clone(),
                used: Instant::now(),
                action:Arc::new(AsyncMutex::new(())),
                chooser:None,
                recording:None,
                loaded,
                browser: browser.clone(),
            });
            publish(&self.0, &mut state, "opened", &snapshot);
            id
        };
        if input.get("url").is_some() || input.get("target").is_some() {
            let mut navigation = input.clone();
            navigation["tabId"] = json!(&id);
            navigation["_fromOpen"] = json!(true);
            if let Err(error) = Box::pin(self.invoke(thread, agent, "navigate", navigation)).await {
                let _ = self.close(thread, Some(&id)).await;
                return Err(error);
            }
        }
        self.reveal(thread, &id, &input);
        Ok(self.status(thread, agent, Some(&id)))
    }
    async fn host(&self, key: &str) -> Result<Browser, Error> {
        {
            let mut state = lock(&self.0.state);
            state.hosts.retain(|host| !host.browser.is_closed());
            if let Some(host) = state.hosts.iter_mut().find(|h| h.key == key) {
                host.empty_since = Instant::now();
                return Ok(host.browser.clone());
            }
            if state.hosts.len() >= 4 {
                return Err(Error("The server browser profile limit (4) is reached. Close another profile's tabs first.".into()));
            }
        }
        let executable = if let Some(path) = &self.0.fixture {
            path.clone()
        } else {
            self.0.installer.executable().await?
        };
        let directory = self
            .0
            .directory
            .join("server-browser/profiles")
            .join(profile_directory(
                key.strip_prefix("profile:").unwrap_or(key),
            ));
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(crate::err)?;
        let spec = spec()?;
        let mut args = if key == "__shared" {
            &spec.tab_args
        } else {
            &spec.persistent_args
        }
        .iter()
        .map(|arg| arg.replace("__PROFILE__", &directory.to_string_lossy()))
        .collect::<Vec<_>>();
        if std::env::var("T3CODE_SERVER_BROWSER_SANDBOX").as_deref() == Ok("0") {
            args.push("--no-sandbox".into());
        }
        let browser = Browser::launch(Launch {
            executable,
            args,
            directory,
        })
        .await?;
        let mut events = browser.events();
        browser
            .send("Target.setDiscoverTargets", json!({"discover":true}), None)
            .await?;
        let weak = Arc::downgrade(&self.0);
        let host_key = key.to_owned();
        tokio::spawn(async move {
            loop {
                let event = match events.recv().await {
                    Ok(event) => event,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                };
                let Some(inner) = weak.upgrade() else {
                    break;
                };
                if event.get("method").and_then(Value::as_str) == Some("Target.targetCreated") {
                    if let Some(info) = event.pointer("/params/targetInfo")
                        && info.get("type").and_then(Value::as_str) == Some("page")
                        && info.get("openerId").is_some()
                    {
                        Preview(inner.clone())
                            .adopt_popup(&host_key, info.clone())
                            .await;
                    }
                    continue;
                }
                let title_read = event.get("method").and_then(Value::as_str)
                    == Some("Page.lifecycleEvent")
                    && event.pointer("/params/name").and_then(Value::as_str) == Some("load");
                let session = event
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let chooser = read_file_chooser(&inner, &host_key, &event).await;
                let title_target = {
                    let mut state = lock(&inner.state);
                    handle_event(&inner, &mut state, &host_key, event, chooser);
                    if title_read {
                        state
                            .tabs
                            .iter()
                            .find(|t| Some(&t.session) == session.as_ref())
                            .map(|t| {
                                (
                                    t.thread.clone(),
                                    t.id.clone(),
                                    t.browser.clone(),
                                    t.session.clone(),
                                )
                            })
                    } else {
                        None
                    }
                };
                if let Some((thread, id, browser, session)) = title_target {
                    Preview(inner.clone())
                        .refresh_title(&thread, &id, &browser, &session)
                        .await;
                }
            }
        });
        lock(&self.0.state).hosts.push(Host {
            key: key.into(),
            browser: browser.clone(),
            empty_since: Instant::now(),
        });
        Ok(browser)
    }
    async fn refresh_title(&self, thread: &str, id: &str, browser: &Browser, session: &str) {
        let result = tokio::time::timeout(
            Duration::from_millis(250),
            browser.send(
                "Runtime.evaluate",
                json!({"expression":"document.title","returnByValue":true}),
                Some(session),
            ),
        )
        .await;
        let history = browser
            .send("Page.getNavigationHistory", json!({}), Some(session))
            .await
            .ok();
        if let Ok(Ok(value)) = result {
            let mut state = lock(&self.0.state);
            if let Some(tab) = state
                .tabs
                .iter_mut()
                .find(|t| t.thread == thread && t.id == id)
            {
                tab.title = value
                    .pointer("/result/value")
                    .and_then(Value::as_str)
                    .filter(|v| !v.is_empty())
                    .map(str::to_owned);
                if let Some(history) = &history {
                    let current = history
                        .get("currentIndex")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    let count = history
                        .get("entries")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len);
                    tab.snapshot["canGoBack"] = json!(current > 0);
                    tab.snapshot["canGoForward"] = json!(current + 1 < count as u64);
                }
                let snapshot = update_snapshot(tab);
                publish(&self.0, &mut state, "navigated", &snapshot);
            }
        }
    }
    pub async fn resize(&self, thread: &str, id: &str, setting: Value) -> Result<Value, Error> {
        let (browser, session, width, height) = {
            let state = lock(&self.0.state);
            let tab = state
                .tabs
                .iter()
                .find(|t| t.thread == thread && t.id == id)
                .ok_or_else(|| Error("The preview tab does not exist.".into()))?;
            let (width, height) = viewport_dimensions(&setting, tab.fill_size.as_ref())?;
            (tab.browser.clone(), tab.session.clone(), width, height)
        };
        browser
            .send(
                "Emulation.setDeviceMetricsOverride",
                json!({"width":width,"height":height,"deviceScaleFactor":2,"mobile":false}),
                Some(&session),
            )
            .await?;
        let mut state = lock(&self.0.state);
        let tab = state
            .tabs
            .iter_mut()
            .find(|t| t.thread == thread && t.id == id)
            .ok_or_else(|| Error("The preview tab does not exist.".into()))?;
        tab.viewport = json!({"width":width,"height":height});
        tab.snapshot["viewport"] = setting;
        let snapshot = update_snapshot(tab);
        publish(&self.0, &mut state, "resized", &snapshot);
        Ok(snapshot)
    }
    pub async fn appearance(&self, thread: &str, id: &str, color: &str) -> Result<Value, Error> {
        let (browser, session) = {
            let state = lock(&self.0.state);
            let tab = state
                .tabs
                .iter()
                .find(|t| t.thread == thread && t.id == id)
                .ok_or_else(|| Error("The preview tab does not exist.".into()))?;
            (tab.browser.clone(), tab.session.clone())
        };
        browser.send("Emulation.setEmulatedMedia",json!({"features":if color=="system"{vec![]}else{vec![json!({"name":"prefers-color-scheme","value":color})]}}),Some(&session)).await?;
        let mut state = lock(&self.0.state);
        let tab = state
            .tabs
            .iter_mut()
            .find(|t| t.thread == thread && t.id == id)
            .ok_or_else(|| Error("The preview tab does not exist.".into()))?;
        tab.appearance = color.into();
        tab.snapshot["colorScheme"] = json!(color);
        let snapshot = update_snapshot(tab);
        publish(&self.0, &mut state, "resized", &snapshot);
        Ok(snapshot)
    }
}
fn viewport_dimensions(setting: &Value, fill: Option<&Value>) -> Result<(u64, u64), Error> {
    let invalid = || Error("Invalid preview viewport setting.".into());
    let tag = setting
        .get("_tag")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    if tag == "fill" {
        return Ok((
            fill.and_then(|v| v.get("width"))
                .and_then(Value::as_u64)
                .unwrap_or(1280),
            fill.and_then(|v| v.get("height"))
                .and_then(Value::as_u64)
                .unwrap_or(800),
        ));
    }
    let limits = &spec()?.viewport_limits;
    if !matches!(tag, "freeform" | "preset") {
        return Err(invalid());
    }
    if tag == "preset"
        && !limits
            .get("presetIds")
            .and_then(Value::as_array)
            .is_some_and(|ids| ids.iter().any(|id| Some(id) == setting.get("presetId")))
    {
        return Err(invalid());
    }
    let width = setting
        .get("width")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)?;
    let height = setting
        .get("height")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)?;
    let minimum = limits
        .get("minimum")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)?;
    let maximum = limits
        .get("maximum")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)?;
    let area = limits
        .get("area")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)?;
    if !(minimum..=maximum).contains(&width)
        || !(minimum..=maximum).contains(&height)
        || width.saturating_mul(height) > area
    {
        return Err(invalid());
    }
    Ok((width, height))
}

fn now() -> String {
    conn_support::time::iso_from_ms(conn_support::time::now_ms())
}
fn profiles(state: &State) -> (Vec<Value>, Option<String>) {
    (
        state
            .profiles
            .iter()
            .map(|p| {
                let mut profile = json!({"id":p.get("id"),"name":p.get("name")});
                if p.get("kind").and_then(Value::as_str) == Some("incognito") {
                    profile["incognito"] = json!(true);
                }
                profile
            })
            .collect(),
        state.default_profile.clone(),
    )
}
fn find_tab<'a>(
    state: &'a mut State,
    thread: &str,
    agent: &str,
    explicit: Option<&str>,
) -> Option<&'a mut Tab> {
    if let Some(id) = explicit {
        state
            .tabs
            .iter_mut()
            .find(|t| t.thread == thread && t.id == id)
    } else {
        let own = state
            .tabs
            .iter()
            .any(|t| t.thread == thread && t.owner.as_deref() == Some(agent));
        let index = state
            .tabs
            .iter()
            .enumerate()
            .filter(|(_, t)| t.thread == thread && (!own || t.owner.as_deref() == Some(agent)))
            .max_by_key(|(_, t)| (!t.viewers.is_empty(), t.used))
            .map(|(index, _)| index)?;
        state.tabs.get_mut(index)
    }
}
fn update_snapshot(tab: &mut Tab) -> Value {
    tab.snapshot["navStatus"] = match &tab.url {
        None => json!({"_tag":"Idle"}),
        Some(url) => {
            json!({"_tag":if tab.loading{"Loading"}else{"Success"},"url":url,"title":tab.title.clone().unwrap_or_default()})
        }
    };
    tab.snapshot["updatedAt"] = json!(now());
    tab.snapshot.clone()
}
fn publish(inner: &Inner, state: &mut State, kind: &str, snapshot: &Value) {
    state.revision += 1;
    let mut event = json!({"type":kind,"threadId":snapshot.get("threadId"),"tabId":snapshot.get("tabId"),"createdAt":now(),"serverEpoch":inner.epoch,"revision":state.revision});
    if kind != "closed" {
        event["snapshot"] = snapshot.clone();
    }
    let _ = inner.events.send(event);
}
async fn read_file_chooser(inner: &Inner, host: &str, event: &Value) -> Option<FileChooser> {
    if event.get("method").and_then(Value::as_str) != Some("Page.fileChooserOpened") {
        return None;
    }
    let node = event.pointer("/params/backendNodeId")?.as_u64()?;
    let session = event.get("sessionId")?.as_str()?;
    let browser = lock(&inner.state)
        .tabs
        .iter()
        .find(|tab| tab.host == host && tab.session == session)?
        .browser
        .clone();
    let description = browser
        .send(
            "DOM.describeNode",
            json!({"backendNodeId":node}),
            Some(session),
        )
        .await
        .ok();
    let accept = description
        .as_ref()
        .and_then(|value| value.pointer("/node/attributes"))
        .and_then(Value::as_array)
        .and_then(|attributes| {
            attributes
                .as_chunks::<2>()
                .0
                .iter()
                .find(|[name, _]| name.as_str() == Some("accept"))
                .and_then(|[_, value]| value.as_str())
        })
        .unwrap_or_default()
        .chars()
        .take(1024)
        .collect();
    Some(FileChooser {
        node,
        multiple: event.pointer("/params/mode").and_then(Value::as_str) == Some("selectMultiple"),
        accept,
    })
}

fn handle_event(
    inner: &Inner,
    state: &mut State,
    host: &str,
    event: Value,
    chooser: Option<FileChooser>,
) {
    let Some(tab) = state.tabs.iter_mut().find(|t| {
        t.host == host && event.get("sessionId").and_then(Value::as_str) == Some(&t.session)
    }) else {
        return;
    };
    let params = event.get("params").unwrap_or(&Value::Null);
    let mut changed = false;
    match event
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "Page.frameNavigated" if params.pointer("/frame/parentId").is_none() => {
            tab.url = params
                .pointer("/frame/url")
                .and_then(Value::as_str)
                .filter(|v| *v != "about:blank")
                .map(short_url);
            tab.title = None;
            tab.loading = true;
            changed = true;
        }
        "Page.lifecycleEvent" => {
            if let Some(name) = params.get("name").and_then(Value::as_str) {
                if matches!(name, "DOMContentLoaded" | "load") {
                    let _ = tab.loaded.send(name.into());
                }
                if name == "load" {
                    tab.loading = false;
                    changed = true;
                }
            }
        }
        "Runtime.consoleAPICalled" | "Runtime.exceptionThrown" | "Log.entryAdded" => {
            if let Some(mut entry) = crate::html::console_message(
                event
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                params,
            ) {
                entry["timestamp"] = json!(now());
                push_diagnostic(&mut tab.console_entries, entry, 200);
            }
        }
        "Runtime.bindingCalled"
            if params.get("name").and_then(Value::as_str) == Some("__connPreviewTitle") =>
        {
            tab.title = params
                .get("payload")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(|s| s.chars().take(512).collect());
            changed = true;
        }
        "Network.requestWillBeSent" => {
            let url = params
                .pointer("/request/url")
                .and_then(Value::as_str)
                .unwrap_or_default();
            push_diagnostic(
                &mut tab.network_entries,
                json!({"_id":params.get("requestId"),"url":short_url(url),"method":params.pointer("/request/method").and_then(Value::as_str).unwrap_or_default(),"status":null,"failed":false,"timestamp":now()}),
                200,
            );
        }
        "Network.responseReceived" => {
            if let Some(entry) = tab
                .network_entries
                .iter_mut()
                .rev()
                .find(|e| e.get("_id") == params.get("requestId"))
            {
                entry["status"] = params
                    .pointer("/response/status")
                    .cloned()
                    .unwrap_or(Value::Null);
            }
        }
        "Network.loadingFailed" => {
            if let Some(entry) = tab
                .network_entries
                .iter_mut()
                .rev()
                .find(|e| e.get("_id") == params.get("requestId"))
            {
                entry["failed"] = json!(true);
                entry["errorText"] = json!(
                    params
                        .get("errorText")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .chars()
                        .take(1000)
                        .collect::<String>()
                );
            }
        }
        "Page.fileChooserOpened" => {
            tab.chooser = chooser;
        }
        "Page.javascriptDialogOpening" => {
            tab.dialog = json!({"type":params.get("type"),"message":params.get("message"),"defaultValue":params.get("defaultPrompt").and_then(Value::as_str).unwrap_or_default()});
        }
        "Page.javascriptDialogClosed" => {
            tab.dialog = Value::Null;
        }
        _ => {}
    }
    let _ = tab.control.send(viewer::control_message(tab));
    if changed {
        let snapshot = update_snapshot(tab);
        publish(inner, state, "navigated", &snapshot);
    }
}
async fn wait_loaded(
    loaded: &mut watch::Receiver<String>,
    readiness: &str,
    millis: u64,
) -> Result<(), Error> {
    tokio::time::timeout(Duration::from_millis(millis), async {
        loop {
            loaded.changed().await.map_err(crate::err)?;
            let name = loaded.borrow().clone();
            if name == "load" || (readiness == "domContentLoaded" && name == "DOMContentLoaded") {
                return Ok(());
            }
        }
    })
    .await
    .map_err(|_| Error(format!("Navigation did not finish within {millis}ms.")))?
}
fn navigation_url(input: &Value) -> Result<String, Error> {
    if let Some(raw) = input.get("url").and_then(Value::as_str) {
        return normalize_url(raw);
    }
    let target = input
        .get("target")
        .ok_or_else(|| Error("Provide exactly one of url or target.".into()))?;
    if let Some(url) = target.get("url").and_then(Value::as_str) {
        return normalize_url(url);
    }
    let port = target
        .get("port")
        .and_then(Value::as_u64)
        .filter(|v| *v > 0 && *v < 65536)
        .ok_or_else(|| Error("Invalid browser target port.".into()))?;
    let protocol = target
        .get("protocol")
        .and_then(Value::as_str)
        .unwrap_or("http");
    let path = target.get("path").and_then(Value::as_str).unwrap_or("/");
    normalize_url(&format!(
        "{protocol}://localhost:{port}{}{path}",
        if path.starts_with('/') { "" } else { "/" }
    ))
}
/// Invalid URLs report their length and protocol without disclosing their contents.
#[derive(Debug, thiserror::Error)]
#[error(
    "Invalid preview URL ({reason}{protocol_display}; input length {length}). Use an http(s) URL or a schemeless host such as localhost:5173. With preview_open, omit url when creating a new tab to open a blank tab."
)]
pub struct UrlFailure {
    pub reason: &'static str,
    pub protocol: Option<String>,
    pub length: usize,
    protocol_display: String,
}
pub fn preview_url(raw: &str) -> Result<String, UrlFailure> {
    let trimmed = raw.trim();
    let explicit = trimmed
        .split_once(':')
        .map(|(p, _)| p)
        .filter(|p| {
            !p.is_empty()
                && p.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
        })
        .map(|s| format!("{}:", s.to_ascii_lowercase()));
    let failure = |reason, protocol: Option<String>| UrlFailure {
        reason,
        protocol_display: protocol
            .as_ref()
            .map(|p| format!(": {p}"))
            .unwrap_or_default(),
        protocol,
        length: raw.encode_utf16().count(),
    };
    if trimmed.is_empty() {
        return Err(failure("empty", None));
    }
    if explicit
        .as_ref()
        .is_some_and(|p| spec().is_ok_and(|s| s.non_web_schemes.contains(p)))
    {
        return Err(failure("unsupported-protocol", explicit));
    }
    let host = trimmed.split(['/', ':']).next().unwrap_or_default();
    let local = matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "0.0.0.0"
    ) || trimmed.starts_with("[::1]")
        || trimmed.starts_with("[::]");
    let has_scheme = explicit.is_some() && trimmed.contains("://");
    let candidate = if has_scheme {
        trimmed.to_owned()
    } else {
        format!("{}://{trimmed}", if local { "http" } else { "https" })
    };
    let url = url::Url::parse(&candidate)
        .map_err(|_| failure("parse", Some(if local { "http:" } else { "https:" }.into())))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(failure(
            "unsupported-protocol",
            Some(format!("{}:", url.scheme())),
        ));
    }
    if !has_scheme
        && !local
        && url.host_str().is_some_and(|h| {
            h.eq_ignore_ascii_case("localhost")
                || h.trim_end_matches('.').eq_ignore_ascii_case("localhost")
                || h.parse::<std::net::Ipv4Addr>()
                    .is_ok_and(|ip| ip.is_loopback())
        })
    {
        return url::Url::parse(&format!("http://{trimmed}"))
            .map(|u| u.to_string())
            .map_err(|_| failure("parse", Some("http:".into())));
    }
    Ok(url.to_string())
}
fn normalize_url(raw: &str) -> Result<String, Error> {
    preview_url(raw).map_err(crate::err)
}

fn resolve_viewport(input: &Value) -> Result<Value, Error> {
    let mode = input
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if mode == "fill" {
        return Ok(json!({"_tag":"fill"}));
    }
    if mode == "freeform" {
        return Ok(
            json!({"_tag":"freeform","width":input.get("width"),"height":input.get("height")}),
        );
    }
    let spec = spec()?;
    let name = input
        .get("preset")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let preset = spec
        .presets
        .iter()
        .find(|p| p.get("id").and_then(Value::as_str) == Some(name))
        .ok_or_else(|| Error("Unknown viewport preset.".into()))?;
    let (mut width, mut height) = (
        preset.get("width").cloned().unwrap_or(Value::Null),
        preset.get("height").cloned().unwrap_or(Value::Null),
    );
    if input.get("orientation").and_then(Value::as_str) == Some("landscape") {
        std::mem::swap(&mut width, &mut height);
    }
    Ok(json!({"_tag":"preset","presetId":name,"width":width,"height":height}))
}

impl Preview {
    /// Opens a server tab for a client, without granting it an agent owner.
    pub async fn open_client(&self, thread: &str, mut input: Value) -> Result<Value, Error> {
        self.load_profiles().await;
        input["reuseExistingTab"] = json!(false);
        input["_unclaimed"] = json!(true);
        let status = self.open(thread, "", input.clone()).await?;
        let id = status
            .get("tabId")
            .and_then(Value::as_str)
            .ok_or_else(|| Error("The server preview tab could not open.".into()))?;
        if let Some(viewport) = input.get("viewport") {
            self.resize(thread, id, viewport.clone()).await?;
        }
        if let Some(color) = input.get("colorScheme").and_then(Value::as_str) {
            self.appearance(thread, id, color).await?;
        }
        if input.get("zoomFactor").is_some() {
            self.adjust(thread, id, &input).await?;
        }
        self.snapshot_for(thread, id)
            .ok_or_else(|| Error("The server preview tab does not exist.".into()))
    }
    fn reveal(&self, thread: &str, id: &str, input: &Value) {
        if input.get("_unclaimed").and_then(Value::as_bool) == Some(true)
            || input
                .get("open")
                .or_else(|| input.get("show"))
                .and_then(Value::as_bool)
                == Some(false)
        {
            return;
        }
        let force = input
            .get("open")
            .or_else(|| input.get("show"))
            .and_then(Value::as_bool)
            == Some(true);
        let mut state = lock(&self.0.state);
        if let Some(tab) = state
            .tabs
            .iter_mut()
            .find(|t| t.thread == thread && t.id == id)
        {
            tab.snapshot["reveal"] = json!(true);
            tab.snapshot["revealRequest"] = json!({"id":conn_support::uuid_v4(),"force":force});
            let snapshot = update_snapshot(tab);
            publish(&self.0, &mut state, "navigated", &snapshot);
        }
    }
    pub fn snapshot_for(&self, thread: &str, id: &str) -> Option<Value> {
        lock(&self.0.state)
            .tabs
            .iter()
            .find(|t| t.thread == thread && t.id == id)
            .map(|t| t.snapshot.clone())
    }
    pub async fn adjust(&self, thread: &str, id: &str, input: &Value) -> Result<Value, Error> {
        if let Some(color) = input.get("colorScheme").and_then(Value::as_str) {
            self.appearance(thread, id, color).await?;
        }
        let (browser, session, viewport) = {
            let state = lock(&self.0.state);
            let tab = state
                .tabs
                .iter()
                .find(|t| t.thread == thread && t.id == id)
                .ok_or_else(|| Error("The preview tab does not exist.".into()))?;
            (
                tab.browser.clone(),
                tab.session.clone(),
                tab.viewport.clone(),
            )
        };
        if let Some(zoom) = input.get("zoomFactor").and_then(Value::as_f64) {
            let width = viewport
                .get("width")
                .and_then(Value::as_f64)
                .unwrap_or(1280.);
            let height = viewport
                .get("height")
                .and_then(Value::as_f64)
                .unwrap_or(800.);
            browser.send("Emulation.setDeviceMetricsOverride",json!({"width":(width/zoom).round().max(1.) as u64,"height":(height/zoom).round().max(1.) as u64,"deviceScaleFactor":2.*zoom,"mobile":false}),Some(&session)).await?;
            if let Some(tab) = lock(&self.0.state)
                .tabs
                .iter_mut()
                .find(|t| t.thread == thread && t.id == id)
            {
                tab.snapshot["zoomFactor"] = json!(zoom);
            }
        }
        if let Some(clear) = input.get("clear").and_then(Value::as_str) {
            browser
                .send(
                    if clear == "cookies" {
                        "Network.clearBrowserCookies"
                    } else {
                        "Network.clearBrowserCache"
                    },
                    json!({}),
                    Some(&session),
                )
                .await?;
        }
        if input.get("hardReload").and_then(Value::as_bool) == Some(true) {
            browser
                .send("Page.reload", json!({"ignoreCache":true}), Some(&session))
                .await?;
        }
        let mut state = lock(&self.0.state);
        let tab = state
            .tabs
            .iter_mut()
            .find(|t| t.thread == thread && t.id == id)
            .ok_or_else(|| Error("The preview tab does not exist.".into()))?;
        let snapshot = update_snapshot(tab);
        publish(&self.0, &mut state, "resized", &snapshot);
        Ok(snapshot)
    }
    pub async fn clear_profile(&self, profile: &str) -> Result<(), Error> {
        let _open = self.0.open.lock().await;
        if profile == "incognito" {
            return Ok(());
        }
        let tabs = {
            let state = lock(&self.0.state);
            state
                .tabs
                .iter()
                .filter(|t| {
                    t.snapshot.get("profileId").and_then(Value::as_str) == Some(profile)
                        || (profile == "default"
                            && t.owner.is_none()
                            && t.snapshot.get("profileId").is_none())
                })
                .map(|t| (t.thread.clone(), t.id.clone()))
                .collect::<Vec<_>>()
        };
        for (thread, id) in tabs {
            self.close(&thread, Some(&id)).await?;
        }
        let browser = {
            let mut state = lock(&self.0.state);
            let key = format!("profile:{profile}");
            state
                .hosts
                .iter()
                .position(|h| h.key == key)
                .map(|at| state.hosts.remove(at).browser)
        };
        if let Some(browser) = browser {
            browser.close().await;
        }
        let folder = self
            .0
            .directory
            .join("server-browser/profiles")
            .join(profile_directory(profile));
        match tokio::fs::remove_dir_all(folder).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(crate::err(error)),
        }
    }
    /// Saves a screenshot for the agent; callers supply only bytes captured from this service.
    pub async fn save_screenshot(&self, url: &str, data: String) -> Result<String, Error> {
        let slug = url::Url::parse(url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .unwrap_or_else(|| "site".into())
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .take(40)
            .collect::<String>();
        let directory = self.0.directory.join("browser-artifacts");
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(crate::err)?;
        let path = directory.join(format!(
            "browser-screenshot-{}-{}-{}.png",
            slug.trim_matches('-'),
            conn_support::time::now_ms(),
            conn_support::uuid_v4()
        ));
        let bytes = tokio::task::spawn_blocking(move || conn_support::base64::decode(&data))
            .await
            .map_err(crate::err)?
            .ok_or_else(|| {
                Error("Preview snapshot did not contain requested PNG pixels.".into())
            })?;
        tokio::fs::write(&path, bytes).await.map_err(crate::err)?;
        Ok(path.to_string_lossy().into_owned())
    }
}
fn profile_directory(id: &str) -> String {
    if id == "." || id == ".." {
        id.replace('.', "%2E")
    } else {
        conn_support::ids::encode_component(id)
    }
}

impl Preview {
    async fn adopt_popup(&self, host: &str, info: Value) {
        let Ok(spec) = spec() else { return };
        let Some(target) = info.get("targetId").and_then(Value::as_str) else {
            return;
        };
        let Some(opener) = info.get("openerId").and_then(Value::as_str) else {
            return;
        };
        let setup = {
            let mut state = lock(&self.0.state);
            if state.tabs.iter().any(|t| t.target == target)
                || state.pending_popups.iter().any(|p| p.0 == target)
            {
                return;
            }
            let Some(parent) = state.tabs.iter().find(|t| t.target == opener) else {
                return;
            };
            let capacity = state.tabs.len() + state.pending_popups.len() < spec.server_tab_limit
                && state
                    .tabs
                    .iter()
                    .filter(|t| t.thread == parent.thread && t.owner == parent.owner)
                    .count()
                    + state
                        .pending_popups
                        .iter()
                        .filter(|p| p.1 == parent.thread && p.2 == parent.owner)
                        .count()
                    < spec.agent_tab_limit;
            let setup = (
                parent.thread.clone(),
                parent.owner.clone(),
                parent.context.clone(),
                parent.snapshot.get("profileId").cloned(),
                parent.browser.clone(),
                parent.appearance.clone(),
                capacity,
            );
            if capacity {
                state
                    .pending_popups
                    .push((target.to_owned(), setup.0.clone(), setup.1.clone()));
            }
            setup
        };
        let (thread, owner, context, profile, browser, appearance, capacity) = setup;
        if !capacity {
            let _ = browser
                .send("Target.closeTarget", json!({"targetId":target}), None)
                .await;
            return;
        }
        let result = async {
            let response = browser.send("Target.attachToTarget", json!({"targetId":target,"flatten":true}), None).await?;
            let session = response.get("sessionId").and_then(Value::as_str).ok_or_else(|| Error("The popup session is missing.".into()))?.to_owned();
            initialize_page(&browser, &session).await?;
            browser.send("Emulation.setEmulatedMedia",json!({"features":if appearance=="system"{vec![]}else{vec![json!({"name":"prefers-color-scheme","value":appearance})]}}),Some(&session)).await?;
            let page = browser.send("Runtime.evaluate", json!({"expression":"({url:location.href,title:document.title,loading:document.readyState!=='complete'})","returnByValue":true}), Some(&session)).await?;
            let page = page.pointer("/result/value").cloned().unwrap_or(Value::Null);
            let mut state = lock(&self.0.state);
            state.sequence += 1;
            let id = format!("tab_{}_{}", base36(state.sequence), self.0.epoch);
            let mut snapshot = json!({
                "threadId":thread,"tabId":id,"navStatus":{"_tag":"Idle"},
                "canGoBack":false,"canGoForward":false,"runtime":"server",
                "headless":true,"viewport":{"_tag":"fill"},"colorScheme":appearance,"updatedAt":now()
            });
            if let Some(profile) = profile { snapshot["profileId"] = profile; }
            if let Some(owner) = &owner {
                snapshot["automationOwner"] = json!(owner);
                snapshot["reveal"] = json!(false);
            }
            let mut tab = Tab {
                thread:thread.clone(), id, owner, host:host.into(), target:target.into(), session, context,
                url:page.get("url").and_then(Value::as_str).filter(|s| *s!="about:blank").map(str::to_owned),
                title:page.get("title").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned),
                loading:page.get("loading").and_then(Value::as_bool).unwrap_or(false),
                dialog:Value::Null,
                viewers:vec![],cast:None,
                controller:None,
                generation:0,
                control:watch::channel(json!({"type":"control","canOperate":true,"controller":"agent","generation":0,"dialog":null})).0,
                viewport:json!({"width":1280,"height":800}),
                fill_size:None,
                appearance:"system".into(),
                console_entries:std::collections::VecDeque::new(),
                network_entries:std::collections::VecDeque::new(),
                timeline:std::collections::VecDeque::new(),
                snapshot,
                used:Instant::now(),
                action:Arc::new(AsyncMutex::new(())),
                chooser:None,
                recording:None,
                loaded:watch::channel(String::new()).0,
                browser:browser.clone(),
            };
            let snapshot = update_snapshot(&mut tab);
            state.tabs.push(tab);
            publish(&self.0, &mut state, "opened", &snapshot);
            Ok::<_,Error>(())
        }.await;
        lock(&self.0.state).pending_popups.retain(|p| p.0 != target);
        if result.is_err() {
            let _ = browser
                .send("Target.closeTarget", json!({"targetId":target}), None)
                .await;
        }
    }
}
fn push_diagnostic(entries: &mut std::collections::VecDeque<Value>, entry: Value, limit: usize) {
    if entries.len() == limit {
        entries.pop_front();
    }
    entries.push_back(entry);
}
fn short_url(url: &str) -> String {
    if url
        .trim_start()
        .get(..5)
        .is_some_and(|s| s.eq_ignore_ascii_case("data:"))
    {
        let media = url
            .split_once(':')
            .and_then(|(_, rest)| rest.split([',', ';']).next())
            .unwrap_or_default();
        let media = if media
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".+-/".contains(c))
            && media.len() <= 129
        {
            media
        } else {
            ""
        };
        format!("data:{media},…")
    } else {
        url.chars().take(2048).collect()
    }
}
async fn install_title_watch(browser: &Browser, session: &str) -> Result<(), Error> {
    browser
        .send(
            "Runtime.addBinding",
            json!({"name":"__connPreviewTitle","executionContextName":"t3-preview-title"}),
            Some(session),
        )
        .await?;
    browser.send("Page.addScriptToEvaluateOnNewDocument",json!({"worldName":"t3-preview-title","source":"(()=>{let previous=null;const report=()=>{let title=document.title;let end=512;if(title.charCodeAt(end-1)>=0xd800&&title.charCodeAt(end-1)<=0xdbff)end--;title=title.slice(0,end);if(title!==previous){previous=title;globalThis.__connPreviewTitle(title);}};const watch=()=>{report();if(document.head)new MutationObserver(report).observe(document.head,{subtree:true,childList:true,characterData:true});};if(document.readyState==='loading')addEventListener('DOMContentLoaded',watch,{once:true});else watch();})()"}),Some(session)).await?;
    Ok(())
}
struct ActionTrace {
    inner: std::sync::Weak<Inner>,
    thread: String,
    tab: String,
    id: String,
    finished: bool,
}
impl ActionTrace {
    fn new(preview: &Preview, thread: &str, tab: &str, action: &str) -> Self {
        let id = conn_support::uuid_v4();
        if let Some(tab) = lock(&preview.0.state)
            .tabs
            .iter_mut()
            .find(|t| t.thread == thread && t.id == tab)
        {
            push_diagnostic(
                &mut tab.timeline,
                json!({"id":id,"action":action,"status":"running","startedAt":now()}),
                50,
            );
        }
        Self {
            inner: Arc::downgrade(&preview.0),
            thread: thread.into(),
            tab: tab.into(),
            id,
            finished: false,
        }
    }
    fn complete(mut self, result: &Result<Value, Error>) {
        self.finish(
            if result.is_ok() {
                "succeeded"
            } else {
                "failed"
            },
            result.as_ref().err().map(ToString::to_string),
        );
        self.finished = true;
    }
    fn finish(&self, status: &str, error: Option<String>) {
        if let Some(inner) = self.inner.upgrade()
            && let Some(entry) = lock(&inner.state)
                .tabs
                .iter_mut()
                .find(|t| t.thread == self.thread && t.id == self.tab)
                .and_then(|t| {
                    t.timeline
                        .iter_mut()
                        .find(|e| e.get("id").and_then(Value::as_str) == Some(&self.id))
                })
        {
            entry["status"] = json!(status);
            entry["completedAt"] = json!(now());
            if let Some(error) = error {
                entry["error"] = json!(error.chars().take(1000).collect::<String>());
            }
        }
    }
}
impl Drop for ActionTrace {
    fn drop(&mut self) {
        if !self.finished {
            self.finish("interrupted", None);
        }
    }
}

fn base36(mut value: u64) -> String {
    if value == 0 {
        return "0".into();
    }
    let mut digits = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        digits.push(char::from(if digit < 10 {
            b'0' + digit
        } else {
            b'a' + digit - 10
        }));
        value /= 36;
    }
    digits.into_iter().rev().collect()
}

async fn initialize_page(browser: &Browser, session: &str) -> Result<(), Error> {
    for method in [
        "Page.enable",
        "Runtime.enable",
        "DOM.enable",
        "Network.enable",
    ] {
        browser.send(method, json!({}), Some(session)).await?;
    }
    install_title_watch(browser, session).await?;
    browser
        .send(
            "Page.setInterceptFileChooserDialog",
            json!({"enabled":true}),
            Some(session),
        )
        .await?;
    browser
        .send(
            "Page.setLifecycleEventsEnabled",
            json!({"enabled":true}),
            Some(session),
        )
        .await?;
    browser
        .send(
            "Emulation.setDeviceMetricsOverride",
            json!({"width":1280,"height":800,"deviceScaleFactor":2,"mobile":false}),
            Some(session),
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn file_chooser_status_reports_input_metadata_and_clears_after_cancel() {
        let root =
            std::env::temp_dir().join(format!("conn-preview-chooser-{}", conn_support::uuid_v4()));
        let preview = Preview::with_fixture(
            root.clone(),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fake-chrome.py"),
        );
        preview.invoke("t", "a", "open", json!({})).await.unwrap();
        let (browser, session, mut control) = {
            let state = lock(&preview.0.state);
            let tab = state.tabs.first().unwrap();
            (
                tab.browser.clone(),
                tab.session.clone(),
                tab.control.subscribe(),
            )
        };
        for (mode, multiple) in [("selectSingle", false), ("selectMultiple", true)] {
            control.borrow_and_update();
            browser
                .send("Fixture.fileChooser", json!({"mode":mode}), Some(&session))
                .await
                .unwrap();
            control.changed().await.unwrap();
            assert_eq!(
                preview.status("t", "a", None)["fileChooser"],
                json!({"multiple":multiple,"accept":"image/png,image/jpeg"})
            );
            preview
                .invoke("t", "a", "upload", json!({"paths":[]}))
                .await
                .unwrap();
            assert!(preview.status("t", "a", None)["fileChooser"].is_null());
        }
        preview.shutdown().await;
        let _ = tokio::fs::remove_dir_all(root).await;
    }
    #[tokio::test]
    async fn unserved_downloads_cannot_accumulate_in_default_or_private_contexts() {
        let root =
            std::env::temp_dir().join(format!("conn-preview-download-{}", conn_support::uuid_v4()));
        let preview = Preview::with_fixture(
            root.clone(),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fake-chrome.py"),
        );
        for profile in ["default", "incognito"] {
            let opened = preview
                .invoke(
                    "t",
                    "a",
                    "open",
                    json!({"profileId":profile,"reuseExistingTab":false}),
                )
                .await
                .unwrap();
            let (browser, context) = {
                let state = lock(&preview.0.state);
                let tab = state.tabs.iter().find(|t| t.id == opened["tabId"]).unwrap();
                (tab.browser.clone(), tab.context.clone())
            };
            let counts = browser
                .send("Fixture.counts", json!({}), None)
                .await
                .unwrap();
            assert!(
                counts["downloads"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v["behavior"] == "deny"
                        && v.get("browserContextId").and_then(Value::as_str) == context.as_deref())
            );
        }
        preview.shutdown().await;
        let _ = tokio::fs::remove_dir_all(root).await;
    }
    #[tokio::test]
    async fn expires_tabs_then_stops_empty_browsers_without_starting_a_replacement() {
        let root =
            std::env::temp_dir().join(format!("conn-preview-idle-{}", conn_support::uuid_v4()));
        let preview = Preview::with_fixture(
            root.clone(),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fake-chrome.py"),
        );
        preview.invoke("t", "a", "open", json!({})).await.unwrap();
        let browser = lock(&preview.0.state)
            .hosts
            .first()
            .unwrap()
            .browser
            .clone();
        {
            let mut state = lock(&preview.0.state);
            for tab in &mut state.tabs {
                tab.used =
                    Instant::now() - Duration::from_millis(spec().unwrap().agent_tab_idle_ms);
            }
            for host in &mut state.hosts {
                host.empty_since = Instant::now() - HOST_IDLE;
            }
        }
        preview.sweep().await;
        assert!(preview.list("t")["sessions"].as_array().unwrap().is_empty());
        assert!(browser.is_closed());
        assert!(lock(&preview.0.state).hosts.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn reusing_an_idle_host_renews_its_retirement_deadline() {
        let root =
            std::env::temp_dir().join(format!("conn-preview-reuse-{}", conn_support::uuid_v4()));
        let preview = Preview::with_fixture(
            root.clone(),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fake-chrome.py"),
        );
        let gate = preview.0.open.lock().await;
        let browser = preview.host("__shared").await.unwrap();
        lock(&preview.0.state)
            .hosts
            .first_mut()
            .unwrap()
            .empty_since = Instant::now() - HOST_IDLE;
        preview.host("__shared").await.unwrap();
        assert!(
            lock(&preview.0.state)
                .hosts
                .first()
                .unwrap()
                .empty_since
                .elapsed()
                < HOST_IDLE
        );
        drop(gate);
        preview.sweep().await;
        assert!(!browser.is_closed());
        browser
            .send("Fixture.counts", json!({}), None)
            .await
            .unwrap();
        preview.shutdown().await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn closed_hosts_do_not_consume_the_browser_budget() {
        let root =
            std::env::temp_dir().join(format!("conn-preview-closed-{}", conn_support::uuid_v4()));
        let preview = Preview::with_fixture(
            root.clone(),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fake-chrome.py"),
        );
        let gate = preview.0.open.lock().await;
        for key in ["__shared", "one", "two", "three"] {
            preview.host(key).await.unwrap().close().await;
        }
        preview.host("replacement").await.unwrap();
        assert_eq!(lock(&preview.0.state).hosts.len(), 1);
        drop(gate);
        preview.shutdown().await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn shutdown_and_profile_clear_wait_for_the_open_gate() {
        for operation in ["shutdown", "clear", "sweep"] {
            let root =
                std::env::temp_dir().join(format!("conn-preview-gate-{}", conn_support::uuid_v4()));
            let preview = Preview::with_fixture(
                root.clone(),
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fake-chrome.py"),
            );
            preview
                .invoke("t", "a", "open", json!({"profileId":"default"}))
                .await
                .unwrap();
            let gate = preview.0.open.lock().await;
            let mut pending = std::pin::pin!(async {
                match operation {
                    "clear" => preview.clear_profile("default").await.unwrap(),
                    "sweep" => preview.sweep().await,
                    _ => preview.shutdown().await,
                }
            });
            std::future::poll_fn(|cx| {
                assert!(std::future::Future::poll(pending.as_mut(), cx).is_pending());
                assert_eq!(lock(&preview.0.state).tabs.len(), 1);
                std::task::Poll::Ready(())
            })
            .await;
            drop(gate);
            pending.await;
            preview.shutdown().await;
            let _ = tokio::fs::remove_dir_all(root).await;
        }
    }
    #[test]
    fn normalizes_schemeless_loopback_ipv6_and_public_hosts_and_rejects_non_web_urls() {
        for (input, expected) in [
            ("localhost:5173", "http://localhost:5173/"),
            ("[::1]:3000", "http://[::1]:3000/"),
            ("127.0.0.2:80", "http://127.0.0.2/"),
            ("example.org", "https://example.org/"),
        ] {
            assert_eq!(preview_url(input).unwrap(), expected);
        }
        for (input, reason) in [
            (" ", "empty"),
            ("file:///secret", "unsupported-protocol"),
            ("https://[bad", "parse"),
        ] {
            assert_eq!(preview_url(input).unwrap_err().reason, reason);
        }
        assert_eq!(profile_directory(".."), "%2E%2E");
        assert_eq!(profile_directory("work/team"), "work%2Fteam");
    }
}
