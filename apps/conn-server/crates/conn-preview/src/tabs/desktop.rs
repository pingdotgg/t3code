//! Desktop tabs: the Conn desktop shows the page in its own browser; the server keeps the
//! tab's record, as T3's `PreviewManager` does for `runtime: "desktop"`, and relays agent
//! calls to the desktop that registered it (`crate::relay`).
use super::{Error, Inner, Preview, State, base36, lock, normalize_url, now};
use crate::relay::{DesktopFeed, DesktopTab, RelayCall, RelayFailure, Relayed};
use serde_json::{Value, json};

/// Desktop tab records on one server. T3 has no bound; an open over it fails.
const MAX_DESKTOP_TABS: usize = 128;

#[derive(Debug)]
pub(super) struct DesktopSession {
    thread: String,
    id: String,
    snapshot: Value,
}

pub(super) fn sessions<'a>(state: &'a State, thread: &'a str) -> impl Iterator<Item = &'a Value> {
    state
        .desktop
        .iter()
        .filter(move |s| s.thread == thread)
        .map(|s| &s.snapshot)
}

pub(super) fn find<'a>(state: &'a State, thread: &str, id: &str) -> Option<&'a Value> {
    state
        .desktop
        .iter()
        .find(|s| s.thread == thread && s.id == id)
        .map(|s| &s.snapshot)
}

pub(super) fn close(inner: &Inner, state: &mut State, thread: &str, tab: Option<&str>) {
    let mut closed = vec![];
    state.desktop.retain(|s| {
        let close = s.thread == thread && tab.is_none_or(|id| id == s.id);
        if close {
            closed.push(s.snapshot.clone());
        }
        !close
    });
    for snapshot in closed {
        super::publish(inner, state, "closed", &snapshot);
    }
}

fn emit(inner: &Inner, state: &mut State, mut event: Value) {
    state.revision += 1;
    event["serverEpoch"] = json!(inner.epoch);
    event["revision"] = json!(state.revision);
    let _ = inner.events.send(event);
}

fn session<'a>(state: &'a mut State, thread: &str, id: &str) -> Option<&'a mut DesktopSession> {
    state
        .desktop
        .iter_mut()
        .find(|s| s.thread == thread && s.id == id)
}

impl Preview {
    /// `preview.open` for a tab the desktop shows (T3's `PreviewManager.open`).
    pub fn open_desktop(&self, thread: &str, input: &Value) -> Result<Value, Error> {
        let url = input
            .get("url")
            .and_then(Value::as_str)
            .map(normalize_url)
            .transpose()?;
        let mut state = lock(&self.0.state);
        if state.desktop.len() >= MAX_DESKTOP_TABS {
            return Err(Error("Too many desktop preview tabs are open.".into()));
        }
        state.sequence += 1;
        let id = format!("tab_{}_{}", base36(state.sequence), self.0.epoch);
        let mut snapshot = json!({
            "threadId": thread,
            "tabId": id,
            "navStatus": url.map_or_else(|| json!({"_tag":"Idle"}), |url| json!({"_tag":"Loading","url":url,"title":""})),
            "canGoBack": false,
            "canGoForward": false,
            "viewport": input.get("viewport").cloned().unwrap_or_else(|| json!({"_tag":"fill"})),
            "runtime": input.get("runtime").cloned().unwrap_or_else(|| json!("desktop")),
            "updatedAt": now(),
        });
        for key in ["profileId", "colorScheme", "zoomFactor", "reveal"] {
            if let Some(value) = input.get(key) {
                snapshot[key] = value.clone();
            }
        }
        state.desktop.push(DesktopSession {
            thread: thread.into(),
            id: id.clone(),
            snapshot: snapshot.clone(),
        });
        let created = snapshot["updatedAt"].clone();
        emit(
            &self.0,
            &mut state,
            json!({"type":"opened","threadId":thread,"tabId":id,"createdAt":created,"snapshot":snapshot}),
        );
        Ok(snapshot)
    }

    /// T3's `restoreDesktop`: a desktop that kept a tab across a server restart registers it
    /// again. True when the record exists for that thread or was added.
    pub fn restore_desktop(&self, snapshot: &Value) -> bool {
        if snapshot.get("runtime").and_then(Value::as_str) != Some("desktop") {
            return false;
        }
        let text = |key: &str| snapshot.get(key).and_then(Value::as_str).unwrap_or("");
        let (thread, id) = (text("threadId"), text("tabId"));
        let mut state = lock(&self.0.state);
        if let Some(existing) = state.tabs.iter().find(|t| t.id == id) {
            return existing.thread == thread
                && existing.snapshot.get("runtime").and_then(Value::as_str) == Some("desktop");
        }
        if let Some(existing) = state.desktop.iter().find(|s| s.id == id) {
            return existing.thread == thread;
        }
        // Ids with this server's epoch come only from its own allocator; an unknown one could
        // collide with a tab it opens later.
        if state.desktop.len() >= MAX_DESKTOP_TABS
            || id.is_empty()
            || id.ends_with(self.0.epoch.as_str())
        {
            return false;
        }
        // Host identity belongs to the live relay, never the page's saved state.
        let mut page = snapshot.clone();
        if let Some(page) = page.as_object_mut() {
            page.remove("host");
            page.remove("hostedHere");
        }
        state.desktop.push(DesktopSession {
            thread: thread.into(),
            id: id.into(),
            snapshot: page.clone(),
        });
        emit(
            &self.0,
            &mut state,
            json!({"type":"opened","threadId":thread,"tabId":id,"createdAt":snapshot.get("updatedAt"),"snapshot":page}),
        );
        true
    }

    /// `preview.reportStatus` for a desktop tab. `None` when no desktop tab has this id.
    pub fn report_desktop_status(&self, thread: &str, id: &str, input: &Value) -> Option<()> {
        let mut state = lock(&self.0.state);
        let session = session(&mut state, thread, id)?;
        let updated = now();
        let nav = input.get("navStatus").cloned().unwrap_or(Value::Null);
        session.snapshot["navStatus"] = nav.clone();
        for key in ["canGoBack", "canGoForward"] {
            session.snapshot[key] = input.get(key).cloned().unwrap_or(json!(false));
        }
        if session.snapshot.get("viewport").is_none() {
            session.snapshot["viewport"] = json!({"_tag":"fill"});
        }
        session.snapshot["updatedAt"] = json!(updated);
        let snapshot = session.snapshot.clone();
        let event = if nav.get("_tag").and_then(Value::as_str) == Some("LoadFailed") {
            let mut event =
                json!({"type":"failed","threadId":thread,"tabId":id,"createdAt":updated});
            for key in ["url", "title", "code", "description", "download"] {
                if let Some(value) = nav.get(key) {
                    event[key] = value.clone();
                }
            }
            event
        } else {
            json!({"type":"navigated","threadId":thread,"tabId":id,"createdAt":updated,"snapshot":snapshot})
        };
        emit(&self.0, &mut state, event);
        Some(())
    }

    pub(super) fn resize_desktop(
        &self,
        thread: &str,
        id: &str,
        setting: &Value,
    ) -> Option<Result<Value, Error>> {
        let mut state = lock(&self.0.state);
        let session = session(&mut state, thread, id)?;
        let updated = now();
        session.snapshot["viewport"] = setting.clone();
        session.snapshot["updatedAt"] = json!(updated);
        let snapshot = session.snapshot.clone();
        emit(
            &self.0,
            &mut state,
            json!({"type":"resized","threadId":thread,"tabId":id,"createdAt":updated,"snapshot":snapshot}),
        );
        Some(Ok(snapshot))
    }

    pub(super) fn adjust_desktop(&self, thread: &str, id: &str, input: &Value) -> Option<Value> {
        let mut state = lock(&self.0.state);
        let session = session(&mut state, thread, id)?;
        let updated = now();
        for key in ["colorScheme", "zoomFactor"] {
            if let Some(value) = input.get(key) {
                session.snapshot[key] = value.clone();
            }
        }
        session.snapshot["updatedAt"] = json!(updated);
        let snapshot = session.snapshot.clone();
        let mut event = json!({"type":"resized","threadId":thread,"tabId":id,"createdAt":updated,"snapshot":snapshot});
        let hard = input.get("hardReload").and_then(Value::as_bool) == Some(true);
        let clear = input.get("clear").filter(|c| !c.is_null());
        if hard || clear.is_some() {
            let mut request = json!({});
            if hard {
                request["hardReload"] = json!(true);
            }
            if let Some(clear) = clear {
                request["clear"] = clear.clone();
            }
            event["request"] = request;
        }
        emit(&self.0, &mut state, event);
        Some(snapshot)
    }

    /// T3's `DesktopTabRelay.register`: the binding must name this environment and a desktop
    /// tab record that matches it (restored when missing). Errors are the
    /// `DesktopTabRelayError` reason.
    pub fn desktop_register(
        &self,
        session_id: &str,
        environment_id: &str,
        binding: &Value,
    ) -> Result<String, &'static str> {
        let text =
            |value: &Value, key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
        let snapshot = binding.get("snapshot").cloned().unwrap_or(Value::Null);
        let (thread, tab) = (text(binding, "threadId"), text(binding, "tabId"));
        if text(binding, "environmentId").as_deref() != Some(environment_id)
            || text(&snapshot, "threadId") != thread
            || text(&snapshot, "tabId") != tab
            || !self.restore_desktop(&snapshot)
        {
            return Err("binding");
        }
        let (Some(thread), Some(tab)) = (thread, tab) else {
            return Err("binding");
        };
        let device = text(binding, "deviceName").unwrap_or_default();
        self.0
            .relay
            .register(session_id, environment_id, &thread, &tab, &device)
    }

    pub fn desktop_requests(
        &self,
        session_id: &str,
        connection_id: &str,
    ) -> Result<DesktopFeed, &'static str> {
        self.0.relay.requests(session_id, connection_id)
    }

    pub fn desktop_respond(&self, session_id: &str, response: &Value) {
        self.0.relay.respond(session_id, response);
    }

    pub fn desktop_tabs(&self, environment_id: &str, thread: &str) -> Vec<DesktopTab> {
        self.0.relay.tabs(environment_id, thread)
    }

    /// Sends an agent call to a desktop tab when T3 would. `None`: this server's browser
    /// takes it.
    pub async fn relay(&self, call: RelayCall<'_>) -> Option<Result<Relayed, RelayFailure>> {
        self.0.relay.invoke(call).await
    }
}
