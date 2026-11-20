//! The desktop tab relay: a Conn desktop hosts one of its own browser tabs for agents on this
//! server (`preview.desktopRegister`, `preview.desktopRequests`, `preview.desktopRespond`).
//!
//! It follows the desktop part of the T3 server's `PreviewAutomationBroker`: a desktop
//! registers one tab, takes its request stream, and answers each request. An agent call
//! goes to a desktop tab when it names that tab, or when its last call there made the tab
//! its current one; `preview_open` without such a tab stays on the server's own browser.
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex, MutexGuard, Weak},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

/// Registered desktop tabs. T3 has no bound; a registration over it is refused.
const MAX_HOSTS: usize = 64;
/// Requests waiting for a desktop answer, across all desktops.
const MAX_PENDING: usize = 256;
/// Agents whose current tab is a desktop tab; the oldest goes first.
const MAX_ASSIGNMENTS: usize = 256;
/// Requests queued for one desktop that its stream has not taken yet.
const QUEUE: usize = 64;
/// A registration without its request stream is released after this (as in T3).
const REGISTRATION_GRACE: Duration = Duration::from_secs(30);
/// The desktop's own timer starts on delivery; allow its timeout answer first.
const HOST_RESPONSE_GRACE_MS: u64 = 1_000;
const DEFAULT_TIMEOUT_MS: u64 = 15_000;

/// The desktop tab's failure as T3's MCP layer reports it: the error's tag and message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelayFailure {
    pub tag: &'static str,
    pub message: String,
}

/// One agent call that may go to a desktop tab.
#[derive(Clone, Debug)]
pub struct RelayCall<'a> {
    pub environment_id: &'a str,
    pub thread: &'a str,
    pub agent: &'a str,
    pub operation: &'a str,
    /// The operation's input as the desktop receives it, without `tabId`.
    pub input: Value,
    pub tab: Option<&'a str>,
    pub timeout_ms: Option<u64>,
    /// False for background reads that must not change the agent's current tab.
    pub update_current_tab: bool,
}

/// A desktop's answer and the tab the request targeted (T3's `onTargetTab`).
#[derive(Clone, Debug)]
pub struct Relayed {
    pub value: Value,
    pub tab: Option<String>,
}

/// A registered desktop tab, for `preview_status`.
#[derive(Clone, Debug)]
pub struct DesktopTab {
    pub tab: String,
    pub device: String,
    pub session_id: String,
}

#[derive(Debug)]
enum Outcome {
    Ok(Value),
    Remote(Option<Value>),
    Disconnected,
}

#[derive(Debug)]
struct Host {
    client_id: String,
    connection_id: String,
    environment_id: String,
    session_id: String,
    thread: String,
    tab: String,
    device: String,
    sender: mpsc::Sender<Value>,
    receiver: Option<mpsc::Receiver<Value>>,
    subscribed: bool,
}

#[derive(Debug)]
struct Pending {
    client_id: String,
    connection_id: String,
    reply: oneshot::Sender<Outcome>,
}

#[derive(Debug)]
struct Assignment {
    key: String,
    connection_id: String,
    tab: Option<String>,
    sequence: Option<u64>,
}

#[derive(Debug, Default)]
struct State {
    hosts: Vec<Host>,
    pending: Vec<(String, Pending)>,
    assignments: Vec<Assignment>,
    sequence: u64,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Relay(Arc<Mutex<State>>);

/// The request stream of one registration. Dropping it releases the registration, as the
/// end of T3's `preview.desktopRequests` stream does.
#[derive(Debug)]
pub struct DesktopFeed {
    pub receiver: mpsc::Receiver<Value>,
    state: Weak<Mutex<State>>,
    connection_id: String,
}

impl Drop for DesktopFeed {
    fn drop(&mut self) {
        if let Some(state) = self.state.upgrade() {
            disconnect(&mut lock(&state), &self.connection_id);
        }
    }
}

fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Removes a host with its assignments and fails its pending requests.
fn disconnect(state: &mut State, connection_id: &str) {
    state.hosts.retain(|h| h.connection_id != connection_id);
    state
        .assignments
        .retain(|a| a.connection_id != connection_id);
    let mut kept = Vec::with_capacity(state.pending.len());
    for (id, pending) in state.pending.drain(..) {
        if pending.connection_id == connection_id {
            let _ = pending.reply.send(Outcome::Disconnected);
        } else {
            kept.push((id, pending));
        }
    }
    state.pending = kept;
}

fn agent_key(environment_id: &str, agent: &str, thread: &str) -> String {
    format!("{environment_id}\u{0}{agent}\u{0}{thread}")
}

impl Relay {
    /// T3's `registerDesktop`, after the binding checks. Returns the connection id or the
    /// `DesktopTabRelayError` reason.
    pub(crate) fn register(
        &self,
        session_id: &str,
        environment_id: &str,
        thread: &str,
        tab: &str,
        device: &str,
    ) -> Result<String, &'static str> {
        let mut state = lock(&self.0);
        if state
            .hosts
            .iter()
            .any(|h| h.tab == tab && h.environment_id == environment_id)
        {
            return Err("conflict");
        }
        if state.hosts.len() >= MAX_HOSTS {
            return Err("binding");
        }
        let connection_id = conn_support::uuid_v4();
        let (sender, receiver) = mpsc::channel(QUEUE);
        let _ = sender.try_send(json!({"type":"connected","connectionId":connection_id}));
        state.hosts.push(Host {
            client_id: format!("desktop-{}", conn_support::uuid_v4()),
            connection_id: connection_id.clone(),
            environment_id: environment_id.into(),
            session_id: session_id.into(),
            thread: thread.into(),
            tab: tab.into(),
            device: device.into(),
            sender,
            receiver: Some(receiver),
            subscribed: false,
        });
        drop(state);
        // Registration and its stream are separate calls: a client that goes away between
        // them must not hold the tab.
        let weak = Arc::downgrade(&self.0);
        let id = connection_id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(REGISTRATION_GRACE).await;
            let Some(state) = weak.upgrade() else { return };
            let mut state = lock(&state);
            if state
                .hosts
                .iter()
                .any(|h| h.connection_id == id && !h.subscribed)
            {
                disconnect(&mut state, &id);
            }
        });
        Ok(connection_id)
    }

    /// T3's `desktopRequests`: one stream per registration, from the session that made it.
    pub(crate) fn requests(
        &self,
        session_id: &str,
        connection_id: &str,
    ) -> Result<DesktopFeed, &'static str> {
        let mut state = lock(&self.0);
        let host = state
            .hosts
            .iter_mut()
            .find(|h| h.connection_id == connection_id && h.session_id == session_id)
            .filter(|h| !h.subscribed)
            .ok_or("session")?;
        let receiver = host.receiver.take().ok_or("session")?;
        host.subscribed = true;
        Ok(DesktopFeed {
            receiver,
            state: Arc::downgrade(&self.0),
            connection_id: connection_id.into(),
        })
    }

    /// T3's `respondDesktop`: an answer from a retired connection is dropped.
    pub(crate) fn respond(&self, session_id: &str, response: &Value) {
        let text = |key: &str| response.get(key).and_then(Value::as_str).unwrap_or("");
        let (connection_id, request_id) = (text("connectionId"), text("requestId"));
        let mut state = lock(&self.0);
        let Some(client_id) = state
            .hosts
            .iter()
            .find(|h| h.connection_id == connection_id && h.session_id == session_id)
            .map(|h| h.client_id.clone())
        else {
            return;
        };
        let Some(index) = state.pending.iter().position(|(id, p)| {
            id == request_id && p.client_id == client_id && p.connection_id == connection_id
        }) else {
            return;
        };
        let (_, pending) = state.pending.swap_remove(index);
        let outcome = if response.get("ok").and_then(Value::as_bool) == Some(true) {
            Outcome::Ok(response.get("result").cloned().unwrap_or(Value::Null))
        } else {
            Outcome::Remote(response.get("error").cloned())
        };
        let _ = pending.reply.send(outcome);
    }

    /// T3's `desktopTabs`: the registered tabs of one thread.
    pub(crate) fn tabs(&self, environment_id: &str, thread: &str) -> Vec<DesktopTab> {
        lock(&self.0)
            .hosts
            .iter()
            .filter(|h| h.environment_id == environment_id && h.thread == thread)
            .map(|h| DesktopTab {
                tab: h.tab.clone(),
                device: h.device.clone(),
                session_id: h.session_id.clone(),
            })
            .collect()
    }

    /// Sends the call to a desktop tab when T3's broker would. `None`: the server's own
    /// browser takes it.
    pub(crate) async fn invoke(
        &self,
        call: RelayCall<'_>,
    ) -> Option<Result<Relayed, RelayFailure>> {
        let key = agent_key(call.environment_id, call.agent, call.thread);
        let (receiver, context) = {
            let mut guard = lock(&self.0);
            let state = &mut *guard;
            let hosts = &state.hosts;
            state
                .assignments
                .retain(|a| hosts.iter().any(|h| h.connection_id == a.connection_id));
            let assigned = state.assignments.iter().position(|a| a.key == key);
            let assigned_host = assigned
                .and_then(|i| state.assignments.get(i))
                .and_then(|a| hosts.iter().find(|h| h.connection_id == a.connection_id))
                .filter(|h| {
                    h.environment_id == call.environment_id
                        && h.thread == call.thread
                        && call.operation != "open"
                });
            let explicit = call.tab.and_then(|tab| {
                hosts.iter().find(|h| {
                    h.tab == tab
                        && h.thread == call.thread
                        && h.environment_id == call.environment_id
                })
            });
            // An explicit tab that no desktop hosts is the server's own: never send it to the
            // current desktop tab (T3 does, and the desktop then refuses it).
            let current = if call.tab.is_some() {
                None
            } else {
                assigned_host
            };
            let Some(host) = explicit.or(current) else {
                if call.update_current_tab
                    && let Some(i) = assigned
                {
                    state.assignments.remove(i);
                }
                return None;
            };
            let (client_id, connection_id, sender) = (
                host.client_id.clone(),
                host.connection_id.clone(),
                host.sender.clone(),
            );
            let timeout_ms = call.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
            let reused = assigned
                .and_then(|i| state.assignments.get(i))
                .filter(|a| a.connection_id == connection_id);
            let (reused_tab, reused_sequence) = reused
                .map(|a| (a.tab.clone(), a.sequence))
                .unwrap_or_default();
            if call.update_current_tab {
                if let Some(i) = assigned {
                    state.assignments.remove(i);
                }
                if state.assignments.len() >= MAX_ASSIGNMENTS {
                    state.assignments.remove(0);
                }
                state.assignments.push(Assignment {
                    key: key.clone(),
                    connection_id: connection_id.clone(),
                    tab: reused_tab.clone(),
                    sequence: reused_sequence,
                });
            }
            let sequence = state.sequence;
            state.sequence += 1;
            let request_id = format!("preview-{sequence}");
            let tab = call.tab.map(str::to_owned).or(reused_tab);
            let context = Context {
                operation: call.operation.to_owned(),
                environment_id: call.environment_id.to_owned(),
                client_id,
                connection_id: connection_id.clone(),
                request_id: request_id.clone(),
                tab: tab.clone(),
                timeout_ms,
                selector: selector(&call.input),
                sequence,
            };
            if matches!(call.operation, "recordingStart" | "recordingStop") {
                return Some(Err(RelayFailure {
                    tag: "PreviewAutomationExecutionError",
                    message: format!(
                        "Preview automation {} failed: Recording is not supported on desktop tabs.",
                        call.operation
                    ),
                }));
            }
            if state.pending.len() >= MAX_PENDING {
                return Some(Err(context.queue_closed()));
            }
            let mut request = json!({
                "requestId": request_id,
                "threadId": call.thread,
                "tabIdExplicit": call.tab.is_some(),
                "agentSessionId": key,
                "operation": call.operation,
                "input": call.input,
                "timeoutMs": timeout_ms,
            });
            if let Some(tab) = &tab {
                request["tabId"] = json!(tab);
            }
            let (reply, receiver) = oneshot::channel();
            if sender
                .try_send(json!({"type":"request","connectionId":connection_id,"request":request}))
                .is_err()
            {
                return Some(Err(context.queue_closed()));
            }
            state.pending.push((
                request_id,
                Pending {
                    client_id: context.client_id.clone(),
                    connection_id,
                    reply,
                },
            ));
            (receiver, context)
        };
        // A cancelled call (the agent's request went away) must not leave its entry behind.
        let _pending = PendingGuard {
            state: Arc::downgrade(&self.0),
            request_id: context.request_id.clone(),
        };
        let wait = if call.update_current_tab {
            context.timeout_ms.saturating_add(HOST_RESPONSE_GRACE_MS)
        } else {
            context.timeout_ms
        };
        let outcome = tokio::time::timeout(Duration::from_millis(wait), receiver).await;
        let mut state = lock(&self.0);
        state.pending.retain(|(id, _)| *id != context.request_id);
        let outcome = match outcome {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => Outcome::Disconnected,
            Err(_) => {
                // Never replay an action that may have run; a slow read keeps the host.
                if call.update_current_tab {
                    disconnect(&mut state, &context.connection_id);
                }
                return Some(Err(context.timeout(None)));
            }
        };
        let result = match outcome {
            Outcome::Ok(result) => result,
            Outcome::Remote(error) => return Some(Err(context.classify(error.as_ref()))),
            Outcome::Disconnected => {
                return Some(Err(RelayFailure {
                    tag: "PreviewAutomationClientDisconnectedError",
                    message: format!(
                        "Preview automation client {} disconnected during {}.",
                        context.client_id, context.operation
                    ),
                }));
            }
        };
        if call.update_current_tab {
            let reported =
                result
                    .as_object()
                    .and_then(|o| o.get("tabId"))
                    .and_then(|tab| match tab {
                        Value::Null => Some(None),
                        Value::String(id) if valid_tab_id(id) => Some(Some(id.clone())),
                        _ => None,
                    });
            let tab = reported.or_else(|| call.tab.map(|t| Some(t.to_owned())));
            if let Some(tab) = tab
                && let Some(assignment) = state.assignments.iter_mut().find(|a| {
                    a.key == key
                        && a.connection_id == context.connection_id
                        && a.sequence.is_none_or(|s| s <= context.sequence)
                })
            {
                assignment.tab = tab;
                assignment.sequence = Some(context.sequence);
            }
        }
        Some(Ok(Relayed {
            value: result,
            tab: context.tab,
        }))
    }
}

struct PendingGuard {
    state: Weak<Mutex<State>>,
    request_id: String,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Some(state) = self.state.upgrade() {
            lock(&state)
                .pending
                .retain(|(id, _)| *id != self.request_id);
        }
    }
}

fn valid_tab_id(id: &str) -> bool {
    !id.is_empty() && id.trim() == id && id.encode_utf16().count() <= 128
}

fn selector(input: &Value) -> Option<(&'static str, usize)> {
    for kind in ["locator", "selector"] {
        if let Some(text) = input.get(kind).and_then(Value::as_str) {
            return Some((kind, text.encode_utf16().count()));
        }
    }
    None
}

#[derive(Debug)]
struct Context {
    operation: String,
    environment_id: String,
    client_id: String,
    connection_id: String,
    request_id: String,
    tab: Option<String>,
    timeout_ms: u64,
    selector: Option<(&'static str, usize)>,
    sequence: u64,
}

const CONTROL_REASONS: [&str; 8] = [
    "agentMismatch",
    "unclaimedTab",
    "humanControl",
    "tabRequired",
    "closed",
    "interrupted",
    "dialogPending",
    "tabLimit",
];
const SNAPSHOT_STAGES: [&str; 5] = [
    "metrics",
    "frames",
    "page state",
    "screenshot",
    "accessibility tree",
];

impl Context {
    fn failure(tag: &'static str, message: String) -> RelayFailure {
        RelayFailure { tag, message }
    }
    fn queue_closed(&self) -> RelayFailure {
        Self::failure(
            "PreviewAutomationRequestQueueClosedError",
            format!(
                "Preview automation client {} stopped accepting {} requests.",
                self.client_id, self.operation
            ),
        )
    }
    fn timeout(&self, detail: Option<&Value>) -> RelayFailure {
        let remote = detail
            .and_then(|d| d.get("timeoutMs"))
            .and_then(Value::as_u64)
            .filter(|ms| *ms > 0);
        let timeout = remote.map_or(self.timeout_ms, |ms| ms.min(self.timeout_ms));
        let stages = detail.and_then(|d| {
            d.get("timeoutMs")
                .and_then(Value::as_u64)
                .filter(|ms| *ms > 0)?;
            let stages = d.get("pendingStages")?.as_array()?;
            if stages.len() > 5 {
                return None;
            }
            stages
                .iter()
                .map(|s| s.as_str().filter(|s| SNAPSHOT_STAGES.contains(s)))
                .collect::<Option<Vec<_>>>()
        });
        let mut message = format!(
            "Preview automation {} timed out after {timeout}ms.",
            self.operation
        );
        if let Some(stages) = stages.filter(|s| !s.is_empty()) {
            message.push_str(&format!(" Waiting for: {}.", stages.join(", ")));
        }
        Self::failure("PreviewAutomationTimeoutError", message)
    }
    /// T3's `classifyResponseError` with each error's message.
    fn classify(&self, error: Option<&Value>) -> RelayFailure {
        let op = &self.operation;
        let client = &self.client_id;
        let Some(error) = error.filter(|e| e.get("_tag").and_then(Value::as_str).is_some()) else {
            return Self::failure(
                "PreviewAutomationMalformedResponseError",
                format!(
                    "Preview automation client {client} returned a malformed response for {op}."
                ),
            );
        };
        let detail = error.get("detail");
        let detail_str = |key: &str| detail.and_then(|d| d.get(key)).and_then(Value::as_str);
        let detail_len = |key: &str| {
            detail
                .and_then(|d| d.get(key))
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
        };
        match error.get("_tag").and_then(Value::as_str).unwrap_or_default() {
            "PreviewAutomationRecordingDesktopUpdateRequiredError" => Self::failure(
                "PreviewAutomationRecordingDesktopUpdateRequiredError",
                "Update the desktop app to transfer recordings. The recording remains on the desktop.".into(),
            ),
            "PreviewAutomationRecordingTooLargeError" => Self::failure(
                "PreviewAutomationRecordingTooLargeError",
                "The recording exceeds 50 MiB. Make a shorter recording.".into(),
            ),
            "PreviewAutomationRecordingDeadlineExpiredError" => Self::failure(
                "PreviewAutomationRecordingDeadlineExpiredError",
                "The recording transfer deadline expired.".into(),
            ),
            "PreviewAutomationRecordingTransferError" => Self::failure(
                "PreviewAutomationRecordingTransferError",
                "Preview recording could not be saved to the agent environment.".into(),
            ),
            "PreviewAutomationNoAvailableHostError" => Self::failure(
                "PreviewAutomationNoAvailableHostError",
                format!("No preview automation host is available for {op} in environment {}. The server-owned browser may be starting or reconnecting. Retry preview_status, then call preview_open if no tab is available. If it remains unavailable, report the browser connection failure.", self.environment_id),
            ),
            "PreviewAutomationUnsupportedClientError" => Self::failure(
                "PreviewAutomationUnsupportedClientError",
                format!("Preview automation client {client} does not support {op}."),
            ),
            "PreviewAutomationTabNotFoundError" => Self::failure(
                "PreviewAutomationTabNotFoundError",
                match &self.tab {
                    Some(tab) => format!("Preview tab {tab} was not found for {op}. Omit tabId to use the current tab, or call preview_open."),
                    None => format!("No active preview tab was found for {op}. Call preview_open first."),
                },
            ),
            "PreviewAutomationTimeoutError" => self.timeout(detail),
            "PreviewAutomationControlInterruptedError" => Self::failure(
                "PreviewAutomationControlInterruptedError",
                match detail.and_then(Value::as_str).filter(|r| CONTROL_REASONS.contains(r)) {
                    Some("agentMismatch") => "This browser tab belongs to another agent session or a human. Open your own tab.".into(),
                    Some("unclaimedTab") => "This tab has no agent owner. Ask the user to close it in the browser panel.".into(),
                    Some("humanControl") => "A human controls this browser tab. Wait until they release control.".into(),
                    Some("tabRequired") => "Multiple browser tabs belong to this session. Pass a tabId from preview_open or from the tabs listed by preview_status.".into(),
                    Some("dialogPending") => "A browser dialog is pending. Read preview_status and resolve it with preview_dialog.".into(),
                    Some("tabLimit") => "Too many server browser tabs are open. Close one with t3_preview_close, or reuse a tabId from preview_status tabs.".into(),
                    Some("closed") => "This browser tab is closed. Call preview_open.".into(),
                    Some("interrupted") => "Browser control changed. Take a fresh snapshot before trying again.".into(),
                    _ => format!("Preview automation {op} was interrupted on client {client}."),
                },
            ),
            "PreviewAutomationInvalidSelectorError" => Self::failure(
                "PreviewAutomationInvalidSelectorError",
                if detail.and_then(|d| d.get("staleRef")).and_then(Value::as_bool) == Some(true) {
                    "This element ref is stale. Navigation, dialogs, and new snapshots replace refs; take a fresh snapshot and use its refs.".into()
                } else if let Some((kind, length)) = self.selector {
                    let guidance = if kind == "locator" {
                        "Use aria-ref=<ref> from the latest snapshot or a Playwright role/text selector; put CSS in selector."
                    } else {
                        "selector takes CSS; use locator for aria-ref=<ref>, role, or text targets."
                    };
                    format!("Preview automation {op} received an invalid {kind} ({length} characters). {guidance}")
                } else {
                    format!("Preview automation {op} received an invalid selector.")
                },
            ),
            "PreviewAutomationTargetNotEditableError" => {
                let kind = detail_str("selectorKind")
                    .filter(|k| matches!(*k, "focused-element" | "locator" | "selector"))
                    .or(self.selector.map(|s| s.0));
                let length = detail_len("selectorLength").or(self.selector.map(|s| s.1));
                Self::failure(
                    "PreviewAutomationTargetNotEditableError",
                    match (kind, length) {
                        (Some("focused-element"), _) => format!("Preview automation {op} requires an editable focused element."),
                        (Some(kind), Some(length)) => format!("Preview automation {op} requires an editable {kind} ({length} characters)."),
                        _ => format!("Preview automation {op} requires an editable target."),
                    },
                )
            }
            "PreviewAutomationResultTooLargeError" => Self::failure(
                "PreviewAutomationResultTooLargeError",
                match detail_len("maximumBytes").filter(|n| *n > 0) {
                    Some(bytes) => format!("Preview automation {op} produced a result larger than {bytes} bytes."),
                    None => format!("Preview automation {op} produced a result that is too large."),
                },
            ),
            "PreviewAutomationUnavailableError" => Self::failure(
                "PreviewAutomationRemoteUnavailableError",
                format!("Preview automation {op} is unavailable on client {client}."),
            ),
            _ => Self::failure(
                "PreviewAutomationExecutionError",
                format!("Preview automation {op} failed on client {client}."),
            ),
        }
    }
}

#[cfg(test)]
mod tests;
