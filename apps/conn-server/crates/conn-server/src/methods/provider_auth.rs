//! `provider.auth.*`: the one in-app sign-in this server serves.
//!
//! In T3 only two providers carry a sign-in controller: managed Codex (ChatGPT through T3's
//! token broker) and Antigravity (`AntigravityAuth.ts`). Claude, Codex outside `managed` and
//! Grok have none, so every call for them answers T3's `ProviderSetupError` from
//! `ProviderAuthService.getController`, here too.
//!
//! Providers sign in through Orbit's AI router and this server holds no provider sign-in
//! (Nick, 2026-11-20). So of T3's two controllers only Antigravity's credential check is
//! served: with `authMethod` `gemini-api-key` or `agent-platform`, Connect starts `agy` with
//! the credentials the settings already hold, and the session proves them and lists the
//! models ([`conn_provider::Provider::credential_check`]). Left out, by that decision:
//! managed Codex, and Antigravity's Google sign-in (`oauth-personal`, `oauth-business`:
//! the authorization link, the redirect forward of `complete`, and `logout`, which signs the
//! CLI out of Google). Those instances answer as T3's instances without a controller, and
//! their entries say `setup.canAuthenticate: false`.
//!
//! A flow belongs to the provider instance that started it, as T3's controller does. A
//! settings change that replaces or removes the instance retires its flow: the check stops,
//! and the instance's subscriptions end (T3 closes the old controller and its streams).
//!
//! One difference by design: T3 stops the instance's running sessions before a check.
//! A credential check changes no credential (they come from the settings, and a settings change
//! rebuilds the instance), so running threads keep going here.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use conn_contract::{
    ProviderAuthCancelInput, ProviderAuthCompleteInput, ProviderAuthRespondInput,
    ProviderAuthStartInput, ProviderSetupError, ProviderSetupInput, lit,
};
use conn_provider::{CheckStep, CredentialCheck, Provider, ProviderSet};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc, watch};
use tokio::time::Instant;

use super::Deps;
use super::provider::ProviderStatus;
use crate::table::{CallContext, Failure, ItemStream, MethodTable};

/// `AUTH_TIMEOUT_MS`: a flow expires, and its check stops, this long after it started.
const AUTH_TIMEOUT: Duration = Duration::from_secs(300);
/// `STARTUP_HINT_MS` and `NO_RESPONSE_HINT_MS`.
const STARTUP_HINT: Duration = Duration::from_secs(90);
const NO_RESPONSE_HINT: Duration = Duration::from_secs(30);
/// `AntigravityAuth.ts` texts (`tools/check-copies.mjs`).
const CHECKING: &str = "Checking credentials.";
const VERIFYING: &str = "Checking Antigravity access and models.";
const CONNECTED: &str = "Connected to Antigravity.";
const IN_PROGRESS: &str = "Antigravity setup is already in progress.";
const NOT_ACTIVE: &str = "This sign-in is no longer active in this client.";
const EXPIRED: &str = "Google sign-in expired. Start sign-in again.";
const CANCELLED: &str = "Google sign-in was cancelled.";
const NO_LINK_YET: &str = "Wait for the Google sign-in link before you send a redirect URL.";
const OTHER_CLIENT: &str = "Sign-in is in progress in another client.";
const CHECK_FAILED: &str = "Antigravity could not authenticate with the configured credentials.";
const NOT_STARTED: &str = "Antigravity has not started after 90 seconds. Its runtime may be stuck starting on this machine.";
const NOT_RESPONDING: &str =
    "Antigravity did not respond. Its runtime may not run on this machine.";
const NO_RESPONSE: &str = "Antigravity has not reached Google after 30 seconds. Check this machine's network connection. Broken IPv6 is a common cause.";
const UNREACHABLE: &str = "Antigravity could not reach Google. Check this machine's network connection, then start sign-in again.";
/// Ours: T3 has no sign-out for credentials it does not hold either.
const SIGN_OUT_IN_SETTINGS: &str =
    "Remove the credentials in this provider's settings to sign out.";

/// Published states a slow subscriber may fall behind by before it reads the current state.
const EVENT_CAPACITY: usize = 16;

/// `ProviderAuthRemoveMethodInput` (not exported by the contract, so not generated).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveMethodInput {
    instance_id: String,
    /// Required, as in T3; no controller reads it.
    #[serde(rename = "methodId")]
    _method_id: String,
}

/// The flows, one per instance: its last state stays visible, as in T3.
#[derive(Clone)]
pub struct AuthFlows {
    flows: Arc<Mutex<HashMap<String, Flow>>>,
    /// Every state change, in order (T3's `SubscriptionRef.changes`).
    events: broadcast::Sender<Arc<Published>>,
}

impl Default for AuthFlows {
    fn default() -> Self {
        Self {
            flows: Arc::default(),
            events: broadcast::channel(EVENT_CAPACITY).0,
        }
    }
}

impl std::fmt::Debug for AuthFlows {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthFlows").finish_non_exhaustive()
    }
}

/// T3's `AuthSnapshot`: the state and the session that owns it (`None`: nobody's).
#[derive(Clone)]
struct Snapshot {
    owner: Option<String>,
    /// `ProviderAuthState` without `credentialOwner` and `interaction`.
    state: Value,
}

struct Published {
    instance_id: String,
    provider: Weak<dyn Provider>,
    snapshot: Snapshot,
}

struct Flow {
    /// The instance that started the flow; a flow never outlives it.
    provider: Weak<dyn Provider>,
    owner: String,
    state: Value,
    expires_at_ms: u64,
    /// Set to stop the check (cancel, timeout, or the instance went away).
    abort: Arc<watch::Sender<bool>>,
    /// The running check; `cancel` waits for it.
    task: Option<tokio::task::JoinHandle<()>>,
    /// T3's `operation: "cancel"`: a cancel waits for the check to stop.
    stopping: bool,
}

impl Flow {
    fn active(&self) -> bool {
        matches!(
            self.state["phase"].as_str(),
            Some("starting" | "waiting" | "verifying")
        )
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            owner: Some(self.owner.clone()),
            state: self.state.clone(),
        }
    }
}

fn same(weak: &Weak<dyn Provider>, provider: &Arc<dyn Provider>) -> bool {
    std::ptr::addr_eq(weak.as_ptr(), Arc::as_ptr(provider))
}

/// The instance `provider` is no longer the configured one for `instance_id`.
fn retired(providers: &ProviderSet, instance_id: &str, provider: &Weak<dyn Provider>) -> bool {
    providers
        .get(instance_id)
        .is_none_or(|current| !same(provider, &current))
}

fn setup_error(instance_id: &str, operation: &str, detail: &str) -> Failure {
    Failure::fail(&ProviderSetupError {
        tag: lit::ProviderSetupError,
        instance_id: instance_id.to_owned(),
        operation: operation.to_owned(),
        detail: detail.to_owned(),
        cause: None,
    })
}

/// `ProviderAuthService.getController` for an instance without a sign-in controller.
fn no_sign_in(deps: &Deps, instance_id: &str, operation: &str) -> Failure {
    let detail = if deps.providers.get(instance_id).is_some() {
        "This provider does not support sign-in in Conn."
    } else {
        "This provider instance is no longer available."
    };
    setup_error(instance_id, operation, detail)
}

/// `getController`: the provider when it serves the credential check.
fn controller(
    deps: &Deps,
    instance_id: &str,
    operation: &str,
) -> Result<Arc<dyn Provider>, Failure> {
    deps.providers
        .get(instance_id)
        .filter(|provider| provider.has_credential_check())
        .ok_or_else(|| no_sign_in(deps, instance_id, operation))
}

fn idle(instance_id: &str) -> Snapshot {
    Snapshot {
        owner: None,
        state: json!({"instanceId": instance_id, "phase": "idle", "flowId": null,
            "authorizationUrl": null, "expiresAt": null, "message": null}),
    }
}

/// `visibleSnapshot`: another client sees no flow id or expiry, and a busy flow as busy.
fn visible(snapshot: &Snapshot, viewer: &str) -> Value {
    let mut state = snapshot.state.clone();
    if snapshot
        .owner
        .as_deref()
        .is_some_and(|owner| owner != viewer)
    {
        state["flowId"] = Value::Null;
        state["authorizationUrl"] = Value::Null;
        state["expiresAt"] = Value::Null;
        if matches!(
            state["phase"].as_str(),
            Some("starting" | "waiting" | "verifying")
        ) {
            state["message"] = json!(OTHER_CLIENT);
        }
    }
    state
}

fn owner(ctx: &CallContext) -> String {
    ctx.principal
        .as_ref()
        .map(|p| p.session_id.clone())
        .unwrap_or_default()
}

fn now_ms() -> u64 {
    conn_support::time::now_ms()
}

/// What a running check needs besides the flows.
struct Check {
    providers: ProviderSet,
    provider: Arc<dyn Provider>,
    instance_id: String,
    flow_id: String,
    abort: Arc<watch::Sender<bool>>,
    status: ProviderStatus,
    /// Subscribed in `start`, before the worker runs, so no replacement slips between them.
    changes: watch::Receiver<u64>,
}

impl AuthFlows {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Flow>> {
        self.flows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn publish(&self, instance_id: &str, flow: &Flow) {
        // No subscriber is not an error.
        let _ = self.events.send(Arc::new(Published {
            instance_id: instance_id.to_owned(),
            provider: flow.provider.clone(),
            snapshot: flow.snapshot(),
        }));
    }

    /// Drops a flow whose instance was replaced or removed, and stops its check.
    fn retire_stale(flows: &mut HashMap<String, Flow>, providers: &ProviderSet, instance_id: &str) {
        if flows
            .get(instance_id)
            .is_some_and(|flow| retired(providers, instance_id, &flow.provider))
            && let Some(flow) = flows.remove(instance_id)
        {
            flow.abort.send_replace(true);
        }
    }

    /// The state of `provider`'s flow (idle when the flow belongs to another instance) and a
    /// cursor that sees every later change and no earlier one. Every publish holds the flows
    /// lock, so both are taken under it.
    fn current(
        &self,
        instance_id: &str,
        provider: &Weak<dyn Provider>,
    ) -> (Snapshot, broadcast::Receiver<Arc<Published>>) {
        let flows = self.lock();
        let snapshot = flows
            .get(instance_id)
            .filter(|flow| std::ptr::addr_eq(flow.provider.as_ptr(), provider.as_ptr()))
            .map_or_else(|| idle(instance_id), Flow::snapshot);
        (snapshot, self.events.subscribe())
    }

    /// Changes the running flow `flow_id`, if it is still the current one, and publishes it.
    fn update(&self, instance_id: &str, flow_id: &str, change: impl FnOnce(&mut Value)) {
        let mut flows = self.lock();
        let Some(flow) = flows
            .get_mut(instance_id)
            .filter(|f| f.active() && f.state["flowId"] == flow_id)
        else {
            return;
        };
        change(&mut flow.state);
        self.publish(instance_id, flow);
    }

    /// The flow that `owner` started, still running and not expired (`requireFlow`).
    fn require<'a>(
        flows: &'a mut HashMap<String, Flow>,
        instance_id: &str,
        owner: &str,
        flow_id: &str,
        operation: &str,
    ) -> Result<&'a mut Flow, Failure> {
        let Some(flow) = flows
            .get_mut(instance_id)
            .filter(|f| f.active() && f.owner == owner && f.state["flowId"] == flow_id)
        else {
            return Err(setup_error(instance_id, operation, NOT_ACTIVE));
        };
        if now_ms() >= flow.expires_at_ms {
            return Err(setup_error(instance_id, operation, EXPIRED));
        }
        Ok(flow)
    }

    /// `start`: the owner's running flow again, or a new check.
    fn start(&self, deps: &Deps, instance_id: &str, owner: &str) -> Result<Value, Failure> {
        let provider = controller(deps, instance_id, "start")?;
        let mut flows = self.lock();
        Self::retire_stale(&mut flows, &deps.providers, instance_id);
        if let Some(flow) = flows.get(instance_id) {
            if flow.stopping {
                return Err(setup_error(instance_id, "start", IN_PROGRESS));
            }
            if flow.active() {
                if flow.owner == owner {
                    return Ok(flow.state.clone());
                }
                return Err(setup_error(instance_id, "start", IN_PROGRESS));
            }
        }
        let flow_id = conn_support::uuid_v4();
        let expires_at_ms = now_ms() + AUTH_TIMEOUT.as_millis() as u64;
        let expires_at = i64::try_from(expires_at_ms)
            .map(conn_support::time::iso_from_millis)
            .unwrap_or_default();
        let state = json!({"instanceId": instance_id, "phase": "starting", "flowId": flow_id,
            "authorizationUrl": null, "expiresAt": expires_at, "message": CHECKING});
        let abort = Arc::new(watch::channel(false).0);
        let check = Check {
            providers: deps.providers.clone(),
            provider: provider.clone(),
            instance_id: instance_id.to_owned(),
            flow_id,
            abort: abort.clone(),
            status: deps.provider_status.clone(),
            changes: deps.providers.subscribe(),
        };
        let flow = Flow {
            provider: Arc::downgrade(&provider),
            owner: owner.to_owned(),
            state: state.clone(),
            expires_at_ms,
            abort,
            task: Some(tokio::spawn(self.clone().run(check))),
            stopping: false,
        };
        self.publish(instance_id, &flow);
        flows.insert(instance_id.to_owned(), flow);
        Ok(state)
    }

    /// `runSignIn`: the check, T3's hints while it starts, its timeout, and its result.
    async fn run(self, check: Check) {
        let Check {
            providers,
            provider,
            instance_id,
            flow_id,
            abort,
            status,
            mut changes,
        } = check;
        // Replaced before this worker first ran: never start the old instance's check.
        if retired(&providers, &instance_id, &Arc::downgrade(&provider)) {
            Self::retire_stale(&mut self.lock(), &providers, &instance_id);
            status.bump();
            return;
        }
        let mut aborted = abort.subscribe();
        let (step_tx, mut steps) = mpsc::channel(2);
        let running = provider.credential_check(CredentialCheck {
            abort: Box::pin(async move {
                let _ = aborted.wait_for(|stop| *stop).await;
            }),
            on_step: Box::new(move |step| {
                let _ = step_tx.try_send(step);
            }),
        });
        tokio::pin!(running);
        let (mut watching, mut stepping) = (true, true);
        let deadline = Instant::now() + AUTH_TIMEOUT;
        let mut hint = Some((Instant::now() + STARTUP_HINT, NOT_STARTED));
        let (mut initialized, mut verifying, mut timed_out) = (false, false, false);
        let step = |step, hint: &mut Option<(Instant, &'static str)>| match step {
            CheckStep::Initialized => {
                *hint = Some((Instant::now() + NO_RESPONSE_HINT, NO_RESPONSE));
            }
            CheckStep::Verifying => {
                *hint = None;
                self.update(&instance_id, &flow_id, |state| {
                    state["phase"] = json!("verifying");
                    state["authorizationUrl"] = Value::Null;
                    state["message"] = json!(VERIFYING);
                });
            }
        };
        let result = loop {
            let hint_at = hint.map_or(deadline, |(at, _)| at);
            // Steps first: a check that ends in the same poll as its last step still shows it.
            tokio::select! {
                biased;
                next = steps.recv(), if stepping => match next {
                    Some(next) => {
                        initialized |= next == CheckStep::Initialized;
                        verifying |= next == CheckStep::Verifying;
                        step(next, &mut hint);
                    }
                    None => stepping = false,
                },
                result = &mut running => break result,
                () = tokio::time::sleep_until(hint_at), if hint.is_some() => {
                    if let Some((_, message)) = hint.take() {
                        self.update(&instance_id, &flow_id, |state| {
                            if state["phase"] == "starting" {
                                state["message"] = json!(message);
                            }
                        });
                    }
                }
                () = tokio::time::sleep_until(deadline), if !timed_out => {
                    timed_out = true;
                    hint = None;
                    abort.send_replace(true);
                }
                changed = changes.changed(), if watching => {
                    if changed.is_err() {
                        watching = false;
                    } else if retired(&providers, &instance_id, &Arc::downgrade(&provider)) {
                        let mut flows = self.lock();
                        Self::retire_stale(&mut flows, &providers, &instance_id);
                    }
                }
            }
        };
        while let Ok(next) = steps.try_recv() {
            initialized |= next == CheckStep::Initialized;
            verifying |= next == CheckStep::Verifying;
            step(next, &mut hint);
        }
        let (phase, message) = match result {
            _ if timed_out => (
                "failed",
                if verifying {
                    EXPIRED
                } else if initialized {
                    UNREACHABLE
                } else {
                    NOT_RESPONDING
                }
                .to_owned(),
            ),
            Ok(()) => ("succeeded", CONNECTED.to_owned()),
            Err(conn_provider::ProviderError::Failed { detail, .. }) => ("failed", detail),
            Err(_) => ("failed", CHECK_FAILED.to_owned()),
        };
        {
            // `finishFlow`, only for the flow that is still current and still its instance's.
            let mut flows = self.lock();
            Self::retire_stale(&mut flows, &providers, &instance_id);
            if let Some(flow) = flows
                .get_mut(&instance_id)
                .filter(|f| f.active() && f.state["flowId"] == flow_id.as_str())
            {
                flow.state["phase"] = json!(phase);
                flow.state["authorizationUrl"] = Value::Null;
                flow.state["expiresAt"] = Value::Null;
                flow.state["message"] = json!(message);
                flow.task = None;
                self.publish(&instance_id, flow);
            }
            // The check has stopped and cleaned up: a cancel of this flow is over, even when
            // the client that sent it went away (T3's uninterruptible `stopFlow`).
            if let Some(flow) = flows
                .get_mut(&instance_id)
                .filter(|f| f.state["flowId"] == flow_id.as_str())
            {
                flow.stopping = false;
            }
        }
        status.bump();
    }

    /// `cancel` (`stopFlow`): shows the flow cancelled, then waits until the check has stopped
    /// its process and removed its files. A start meanwhile is refused, as in T3. The worker,
    /// not this call, ends that state, so a client that leaves mid-cancel changes nothing.
    async fn cancel(
        &self,
        deps: &Deps,
        instance_id: &str,
        owner: &str,
        flow_id: &str,
    ) -> Result<Value, Failure> {
        controller(deps, instance_id, "cancel")?;
        let (state, task) = {
            let mut flows = self.lock();
            Self::retire_stale(&mut flows, &deps.providers, instance_id);
            let flow = Self::require(&mut flows, instance_id, owner, flow_id, "cancel")?;
            flow.abort.send_replace(true);
            flow.stopping = true;
            flow.state["phase"] = json!("cancelled");
            flow.state["authorizationUrl"] = Value::Null;
            flow.state["expiresAt"] = Value::Null;
            flow.state["message"] = json!(CANCELLED);
            self.publish(instance_id, flow);
            (flow.state.clone(), flow.task.take())
        };
        if let Some(task) = task {
            let _ = task.await;
        }
        Ok(state)
    }

    /// `complete`: a credential check has no Google link, so there is never one to answer.
    fn complete(
        &self,
        deps: &Deps,
        instance_id: &str,
        owner: &str,
        flow_id: &str,
    ) -> Result<Value, Failure> {
        controller(deps, instance_id, "complete")?;
        let mut flows = self.lock();
        Self::retire_stale(&mut flows, &deps.providers, instance_id);
        Self::require(&mut flows, instance_id, owner, flow_id, "complete")?;
        Err(setup_error(instance_id, "complete", NO_LINK_YET))
    }

    /// `subscribe`: the state now, then each change, as `owner` sees it, with T3's
    /// `credentialOwner` and no interaction (a credential check asks nothing). The stream ends
    /// when `provider` stops being the instance's provider.
    fn subscribe(
        &self,
        instance_id: String,
        owner: String,
        provider: &Arc<dyn Provider>,
        providers: ProviderSet,
    ) -> ItemStream {
        let (tx, rx) = mpsc::channel(8);
        let mut changes = providers.subscribe();
        let provider = Arc::downgrade(provider);
        let (snapshot, mut events) = self.current(&instance_id, &provider);
        let mut next = Some(snapshot);
        let flows = self.clone();
        tokio::spawn(async move {
            let mut last = Value::Null;
            loop {
                if retired(&providers, &instance_id, &provider) {
                    return;
                }
                if let Some(snapshot) = next.take() {
                    let mut state = visible(&snapshot, &owner);
                    state["credentialOwner"] = json!("provider");
                    state["interaction"] = Value::Null;
                    if state != last {
                        if tx.send(Ok(state.clone())).await.is_err() {
                            return;
                        }
                        last = state;
                    }
                }
                tokio::select! {
                    event = events.recv() => match event {
                        Ok(event) => {
                            if event.instance_id == instance_id
                                && std::ptr::addr_eq(event.provider.as_ptr(), provider.as_ptr())
                            {
                                next = Some(event.snapshot.clone());
                            }
                        }
                        // Skip the stale backlog: the state now, then only newer changes.
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            let (snapshot, cursor) = flows.current(&instance_id, &provider);
                            next = Some(snapshot);
                            events = cursor;
                        }
                        Err(broadcast::error::RecvError::Closed) => return,
                    },
                    changed = changes.changed() => if changed.is_err() { return },
                    () = tx.closed() => return,
                }
            }
        });
        rx
    }
}

pub fn register(table: &mut MethodTable, deps: &Deps) {
    let d = deps.clone();
    table.unary(
        "provider.auth.start",
        move |ctx, input: ProviderAuthStartInput| {
            let result = d.provider_auth.start(&d, &input.instance_id, &owner(&ctx));
            async move { result }
        },
    );
    let d = deps.clone();
    table.unary(
        "provider.auth.cancel",
        move |ctx, input: ProviderAuthCancelInput| {
            let d = d.clone();
            async move {
                d.provider_auth
                    .cancel(&d, &input.instance_id, &owner(&ctx), &input.flow_id)
                    .await
            }
        },
    );
    let d = deps.clone();
    table.unary(
        "provider.auth.complete",
        move |ctx, input: ProviderAuthCompleteInput| {
            let result =
                d.provider_auth
                    .complete(&d, &input.instance_id, &owner(&ctx), &input.flow_id);
            async move { result }
        },
    );
    // T3's Antigravity controller has no `respond` and no `removeMethod`.
    let d = deps.clone();
    table.unary(
        "provider.auth.respond",
        move |_, input: ProviderAuthRespondInput| {
            let id = input.instance_id;
            let result = controller(&d, &id, "respond").and_then(|_| {
                Err(setup_error(
                    &id,
                    "respond",
                    "This provider does not accept this sign-in interaction.",
                ))
            });
            async move { result.map(|()| Value::Null) }
        },
    );
    let d = deps.clone();
    table.unary(
        "provider.auth.removeMethod",
        move |_, input: RemoveMethodInput| {
            let id = input.instance_id;
            let result = controller(&d, &id, "removeMethod").and_then(|_| {
                Err(setup_error(
                    &id,
                    "removeMethod",
                    "This provider does not support removing saved sign-in methods.",
                ))
            });
            async move { result.map(|()| Value::Null) }
        },
    );
    // T3's sign-out signs the CLI out of Google, the sign-in this server does not serve. A
    // credential instance's entry says `auth.canLogout: false`, so no client offers it.
    let d = deps.clone();
    table.unary(
        "provider.auth.logout",
        move |_, input: ProviderSetupInput| {
            let id = input.instance_id;
            let failure = match controller(&d, &id, "logout") {
                Ok(_) => setup_error(&id, "logout", SIGN_OUT_IN_SETTINGS),
                Err(failure) => failure,
            };
            async move { Err::<Value, _>(failure) }
        },
    );
    let d = deps.clone();
    table.stream(
        "provider.auth.subscribe",
        move |ctx, input: ProviderSetupInput| {
            let result = controller(&d, &input.instance_id, "subscribe").map(|provider| {
                d.provider_auth.subscribe(
                    input.instance_id,
                    owner(&ctx),
                    &provider,
                    d.providers.clone(),
                )
            });
            async move { result }
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::table::Handler;
    use tokio::sync::{Notify, Semaphore};

    /// A credential check that reports T3's steps, each after one permit of `gate`: the
    /// agent's `initialize`, then its session, then the result. On abort it waits for a
    /// permit of `cleanup` (its process and files going) before it returns.
    struct Script {
        fail: bool,
        gate: Semaphore,
        cleanup: Semaphore,
        aborted: Notify,
        ended: Notify,
        log: Mutex<Vec<&'static str>>,
    }

    impl Default for Script {
        fn default() -> Self {
            Self {
                fail: false,
                gate: Semaphore::new(0),
                cleanup: Semaphore::new(0),
                aborted: Notify::new(),
                ended: Notify::new(),
                log: Mutex::default(),
            }
        }
    }

    impl Script {
        fn log(&self, entry: &'static str) {
            self.log.lock().unwrap().push(entry);
        }
        fn logged(&self) -> Vec<&'static str> {
            self.log.lock().unwrap().clone()
        }
    }

    struct Checked {
        id: conn_contract::ProviderInstanceId,
        script: Arc<Script>,
    }

    fn checked(id: &str, script: &Arc<Script>) -> Arc<dyn Provider> {
        Arc::new(Checked {
            id: id.into(),
            script: script.clone(),
        })
    }

    impl Provider for Checked {
        fn instance_id(&self) -> &conn_contract::ProviderInstanceId {
            &self.id
        }
        fn driver(&self) -> &str {
            "antigravity"
        }
        fn capabilities(
            &self,
        ) -> conn_provider::BoxFuture<
            '_,
            conn_provider::ProviderResult<conn_contract::ProviderCapabilities>,
        > {
            Box::pin(async {
                Err(conn_provider::ProviderError::Unsupported {
                    operation: "capabilities",
                })
            })
        }
        fn open_session(
            &self,
            _input: conn_provider::OpenSessionInput,
        ) -> conn_provider::BoxFuture<'_, conn_provider::ProviderResult<conn_provider::OpenedSession>>
        {
            Box::pin(async {
                Err(conn_provider::ProviderError::Unsupported {
                    operation: "open_session",
                })
            })
        }
        fn has_credential_check(&self) -> bool {
            true
        }
        fn credential_check(
            &self,
            check: CredentialCheck,
        ) -> conn_provider::BoxFuture<'_, conn_provider::ProviderResult<()>> {
            let script = self.script.clone();
            Box::pin(async move {
                script.log("started");
                let CredentialCheck { abort, on_step } = check;
                let mut abort = abort;
                let steps = async {
                    for step in [
                        Some(CheckStep::Initialized),
                        Some(CheckStep::Verifying),
                        None,
                    ] {
                        script.gate.acquire().await.unwrap().forget();
                        if let Some(step) = step {
                            on_step(step);
                        }
                    }
                };
                let result = tokio::select! {
                    () = steps => if script.fail {
                        Err(conn_provider::ProviderError::Failed {
                            operation: "start",
                            detail: "The key was refused.".into(),
                        })
                    } else {
                        Ok(())
                    },
                    () = &mut abort => {
                        script.log("aborted");
                        script.aborted.notify_one();
                        script.cleanup.acquire().await.unwrap().forget();
                        script.log("cleaned");
                        Err(conn_provider::ProviderError::Failed {
                            operation: "start",
                            detail: "stopped".into(),
                        })
                    }
                };
                script.ended.notify_one();
                result
            })
        }
    }

    fn ctx(session: &str) -> CallContext {
        CallContext {
            principal: Some(Arc::new(crate::auth::Principal {
                session_id: session.into(),
                subject: "test".into(),
                scopes: vec!["providers:manage".into()],
                expires_at_ms: u64::MAX,
            })),
            ..CallContext::default()
        }
    }

    async fn call(
        table: &MethodTable,
        tag: &str,
        ctx: CallContext,
        input: Value,
    ) -> Result<Value, Failure> {
        match table.get(tag) {
            Some(Handler::Unary(call)) => call(ctx, input).await,
            _ => panic!("{tag} is not a unary method"),
        }
    }

    async fn subscribe(table: &MethodTable, ctx: CallContext, id: &str) -> ItemStream {
        match table.get("provider.auth.subscribe") {
            Some(Handler::Stream(call)) => call(ctx, json!({"instanceId": id})).await.unwrap(),
            _ => panic!("provider.auth.subscribe is not a stream"),
        }
    }

    async fn next(stream: &mut ItemStream) -> Value {
        stream.recv().await.unwrap().unwrap()
    }

    /// The phase and message of the next `count` states a stream sends, or fewer when one
    /// ends the flow.
    async fn steps(stream: &mut ItemStream, count: usize) -> Vec<(String, String)> {
        let mut seen = Vec::new();
        for _ in 0..count {
            let state = next(stream).await;
            let phase = state["phase"].as_str().unwrap_or("").to_owned();
            let done = matches!(phase.as_str(), "succeeded" | "failed" | "cancelled");
            seen.push((phase, state["message"].as_str().unwrap_or("").to_owned()));
            if done {
                break;
            }
        }
        seen
    }

    fn seq(steps: &[(&str, &str)]) -> Vec<(String, String)> {
        steps
            .iter()
            .map(|(phase, message)| ((*phase).to_owned(), (*message).to_owned()))
            .collect()
    }

    fn setup(id: &str, operation: &str, detail: &str) -> Result<Value, Failure> {
        Err(Failure::Fail(
            json!({"_tag": "ProviderSetupError", "instanceId": id,
            "operation": operation, "detail": detail}),
        ))
    }

    fn table(deps: &Deps) -> MethodTable {
        let mut table = MethodTable::new();
        register(&mut table, deps);
        table
    }

    /// T3's `AntigravityAuth` without a browser: Connect checks the configured credentials;
    /// one flow at a time, owned by the client that started it; another client sees it busy;
    /// every step reaches the stream in order (`starting`, `verifying`, the result); the
    /// result stays visible.
    #[tokio::test(flavor = "current_thread")]
    async fn a_credential_check_runs_as_t3s_antigravity_sign_in() {
        let good = Arc::new(Script::default());
        let bad = Arc::new(Script {
            fail: true,
            ..Script::default()
        });
        let deps = Deps {
            providers: vec![checked("agy", &good), checked("bad", &bad)].into(),
            ..Deps::default()
        };
        let table = table(&deps);
        let start = json!({"instanceId": "agy"});

        let mut mine = subscribe(&table, ctx("a"), "agy").await;
        let first = next(&mut mine).await;
        assert_eq!(first["phase"], "idle");
        assert_eq!(first["credentialOwner"], "provider");
        assert_eq!(first["interaction"], Value::Null);

        let started = call(&table, "provider.auth.start", ctx("a"), start.clone())
            .await
            .unwrap();
        assert_eq!(started["phase"], "starting");
        assert_eq!(started["message"], CHECKING);
        assert!(started["expiresAt"].is_string());
        let flow_id = started["flowId"].as_str().unwrap().to_owned();
        assert_eq!(next(&mut mine).await["flowId"], flow_id);
        // The same client gets its flow back; another is refused and sees it busy.
        let again = call(&table, "provider.auth.start", ctx("a"), start.clone()).await;
        assert_eq!(again.unwrap()["flowId"], flow_id);
        let other = call(&table, "provider.auth.start", ctx("b"), start.clone()).await;
        assert_eq!(other, setup("agy", "start", IN_PROGRESS));
        let mut theirs = subscribe(&table, ctx("b"), "agy").await;
        let busy = next(&mut theirs).await;
        assert_eq!(busy["flowId"], Value::Null);
        assert_eq!(busy["expiresAt"], Value::Null);
        assert_eq!(busy["message"], OTHER_CLIENT);
        // No Google link, ever; another client's flow is not this client's.
        let complete =
            json!({"instanceId": "agy", "flowId": flow_id, "callbackUrl": "http://x/cb"});
        let answer = call(&table, "provider.auth.complete", ctx("a"), complete.clone()).await;
        assert_eq!(answer, setup("agy", "complete", NO_LINK_YET));
        let answer = call(&table, "provider.auth.complete", ctx("b"), complete).await;
        assert_eq!(answer, setup("agy", "complete", NOT_ACTIVE));

        // `initialize` changes nothing visible; the open session is `verifying`.
        good.gate.add_permits(2);
        let verifying = next(&mut mine).await;
        assert_eq!(verifying["phase"], "verifying");
        assert_eq!(verifying["message"], VERIFYING);
        assert_eq!(verifying["flowId"], flow_id);
        assert_eq!(next(&mut theirs).await["phase"], "verifying");
        good.gate.add_permits(1);
        let done = next(&mut mine).await;
        assert_eq!(done["phase"], "succeeded");
        assert_eq!(done["message"], CONNECTED);
        assert_eq!(done["expiresAt"], Value::Null);
        let cancel = json!({"instanceId": "agy", "flowId": flow_id});
        let late = call(&table, "provider.auth.cancel", ctx("a"), cancel).await;
        assert_eq!(late, setup("agy", "cancel", NOT_ACTIVE));

        // A failed check: every step, then the provider's text.
        let mut stream = subscribe(&table, ctx("a"), "bad").await;
        next(&mut stream).await;
        call(
            &table,
            "provider.auth.start",
            ctx("a"),
            json!({"instanceId": "bad"}),
        )
        .await
        .unwrap();
        bad.gate.add_permits(3);
        assert_eq!(
            steps(&mut stream, 3).await,
            seq(&[
                ("starting", CHECKING),
                ("verifying", VERIFYING),
                ("failed", "The key was refused."),
            ])
        );

        // What T3's Antigravity controller lacks, and the sign-out that is not served.
        let respond = json!({"instanceId": "agy", "flowId": "f", "interactionId": "i",
            "response": {"type": "browser", "action": "accept"}});
        assert_eq!(
            call(&table, "provider.auth.respond", ctx("a"), respond).await,
            setup(
                "agy",
                "respond",
                "This provider does not accept this sign-in interaction."
            )
        );
        let remove = json!({"instanceId": "agy", "methodId": "m"});
        assert_eq!(
            call(&table, "provider.auth.removeMethod", ctx("a"), remove).await,
            setup(
                "agy",
                "removeMethod",
                "This provider does not support removing saved sign-in methods."
            )
        );
        let logout = json!({"instanceId": "agy"});
        assert_eq!(
            call(&table, "provider.auth.logout", ctx("a"), logout).await,
            setup("agy", "logout", SIGN_OUT_IN_SETTINGS)
        );
    }

    /// T3's delayed hints while a check starts (`publishStartingHint`), and its timeout texts
    /// (`runSignIn`): before `initialize` the agent "did not respond", after it the agent
    /// "could not reach Google". The check stops before the flow shows the failure.
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn a_stalled_check_shows_t3s_hints_and_times_out() {
        let slow = Arc::new(Script::default());
        let stuck = Arc::new(Script::default());
        slow.cleanup.add_permits(1);
        stuck.cleanup.add_permits(1);
        let deps = Deps {
            providers: vec![checked("slow", &slow), checked("stuck", &stuck)].into(),
            ..Deps::default()
        };
        let table = table(&deps);

        let mut stream = subscribe(&table, ctx("a"), "slow").await;
        next(&mut stream).await;
        call(
            &table,
            "provider.auth.start",
            ctx("a"),
            json!({"instanceId": "slow"}),
        )
        .await
        .unwrap();
        assert_eq!(
            steps(&mut stream, 2).await,
            seq(&[("starting", CHECKING), ("starting", NOT_STARTED),])
        );
        slow.gate.add_permits(1);
        assert_eq!(
            steps(&mut stream, 2).await,
            seq(&[("starting", NO_RESPONSE), ("failed", UNREACHABLE),])
        );
        assert_eq!(slow.logged(), ["started", "aborted", "cleaned"]);

        let mut stream = subscribe(&table, ctx("a"), "stuck").await;
        next(&mut stream).await;
        call(
            &table,
            "provider.auth.start",
            ctx("a"),
            json!({"instanceId": "stuck"}),
        )
        .await
        .unwrap();
        assert_eq!(
            steps(&mut stream, 3).await,
            seq(&[
                ("starting", CHECKING),
                ("starting", NOT_STARTED),
                ("failed", NOT_RESPONDING),
            ])
        );
        assert_eq!(stuck.logged(), ["started", "aborted", "cleaned"]);
    }

    /// `stopFlow`: cancel shows the flow cancelled, answers only after the check has stopped
    /// its process and removed its files, and refuses a new start until then.
    #[tokio::test(flavor = "current_thread")]
    async fn cancel_waits_for_the_check_to_clean_up() {
        let script = Arc::new(Script::default());
        let deps = Deps {
            providers: vec![checked("agy", &script)].into(),
            ..Deps::default()
        };
        let table = table(&deps);
        let start = json!({"instanceId": "agy"});
        let mut stream = subscribe(&table, ctx("a"), "agy").await;
        next(&mut stream).await;
        let started = call(&table, "provider.auth.start", ctx("a"), start.clone())
            .await
            .unwrap();
        next(&mut stream).await;

        let cancel = json!({"instanceId": "agy", "flowId": started["flowId"]});
        let cancelling = call(&table, "provider.auth.cancel", ctx("a"), cancel);
        tokio::pin!(cancelling);
        tokio::select! {
            biased;
            _ = &mut cancelling => panic!("cancel answered before the check stopped"),
            () = script.aborted.notified() => {}
        }
        let shown = next(&mut stream).await;
        assert_eq!(shown["phase"], "cancelled");
        assert_eq!(shown["message"], CANCELLED);
        let retry = call(&table, "provider.auth.start", ctx("a"), start.clone()).await;
        assert_eq!(retry, setup("agy", "start", IN_PROGRESS));

        script.cleanup.add_permits(1);
        let cancelled = cancelling.await.unwrap();
        assert_eq!(script.logged(), ["started", "aborted", "cleaned"]);
        assert_eq!(cancelled["phase"], "cancelled");
        assert_eq!(cancelled["message"], CANCELLED);
        let retry = call(&table, "provider.auth.start", ctx("a"), start)
            .await
            .unwrap();
        assert_eq!(retry["phase"], "starting");
        assert_ne!(retry["flowId"], started["flowId"]);
    }

    /// A key that replaces a working one starts clean: the old instance's flow and its
    /// subscriptions end with it, as T3 closes the old controller.
    #[tokio::test(flavor = "current_thread")]
    async fn a_replaced_key_does_not_keep_the_old_result() {
        let good = Arc::new(Script::default());
        let rejected = Arc::new(Script {
            fail: true,
            ..Script::default()
        });
        let deps = Deps {
            providers: vec![checked("agy", &good)].into(),
            ..Deps::default()
        };
        let table = table(&deps);
        let start = json!({"instanceId": "agy"});
        let mut old = subscribe(&table, ctx("a"), "agy").await;
        next(&mut old).await;
        call(&table, "provider.auth.start", ctx("a"), start.clone())
            .await
            .unwrap();
        good.gate.add_permits(3);
        assert_eq!(steps(&mut old, 3).await[2].0, "succeeded");

        deps.providers.replace(vec![checked("agy", &rejected)]);
        let mut fresh = subscribe(&table, ctx("a"), "agy").await;
        assert_eq!(next(&mut fresh).await["phase"], "idle");
        call(&table, "provider.auth.start", ctx("a"), start)
            .await
            .unwrap();
        assert!(old.recv().await.is_none(), "the old instance's stream ends");
        rejected.gate.add_permits(3);
        assert_eq!(
            steps(&mut fresh, 3).await,
            seq(&[
                ("starting", CHECKING),
                ("verifying", VERIFYING),
                ("failed", "The key was refused."),
            ])
        );
    }

    /// A key replaced while its check runs: the old check stops and its result never shows;
    /// the new instance can start at once.
    #[tokio::test(flavor = "current_thread")]
    async fn a_key_replaced_during_a_check_stops_it() {
        let good = Arc::new(Script::default());
        good.cleanup.add_permits(1);
        let rejected = Arc::new(Script {
            fail: true,
            ..Script::default()
        });
        let deps = Deps {
            providers: vec![checked("agy", &good)].into(),
            ..Deps::default()
        };
        let table = table(&deps);
        let start = json!({"instanceId": "agy"});
        let mut old = subscribe(&table, ctx("a"), "agy").await;
        next(&mut old).await;
        call(&table, "provider.auth.start", ctx("a"), start.clone())
            .await
            .unwrap();
        good.gate.add_permits(2);
        assert_eq!(steps(&mut old, 2).await[1].0, "verifying");

        deps.providers.replace(vec![checked("agy", &rejected)]);
        let mut fresh = subscribe(&table, ctx("a"), "agy").await;
        assert_eq!(next(&mut fresh).await["phase"], "idle");
        let started = call(&table, "provider.auth.start", ctx("a"), start).await;
        assert_eq!(started.unwrap()["phase"], "starting");
        assert!(old.recv().await.is_none(), "the old instance's stream ends");
        good.ended.notified().await;
        assert_eq!(good.logged(), ["started", "aborted", "cleaned"]);
        good.gate.add_permits(1);
        rejected.gate.add_permits(3);
        assert_eq!(
            steps(&mut fresh, 3).await,
            seq(&[
                ("starting", CHECKING),
                ("verifying", VERIFYING),
                ("failed", "The key was refused."),
            ])
        );
    }

    /// The client that sent a cancel goes away while the check cleans up: the cancel still
    /// ends, and the instance takes a new start (T3 runs `stopFlow` uninterruptibly).
    #[tokio::test(flavor = "current_thread")]
    async fn a_cancel_whose_client_leaves_still_ends() {
        let script = Arc::new(Script::default());
        let deps = Deps {
            providers: vec![checked("agy", &script)].into(),
            ..Deps::default()
        };
        let table = table(&deps);
        let start = json!({"instanceId": "agy"});
        let started = call(&table, "provider.auth.start", ctx("a"), start.clone())
            .await
            .unwrap();
        let mut status = deps.provider_status.subscribe();

        let cancel = json!({"instanceId": "agy", "flowId": started["flowId"]});
        let cancelling = call(&table, "provider.auth.cancel", ctx("a"), cancel);
        {
            tokio::pin!(cancelling);
            tokio::select! {
                biased;
                _ = &mut cancelling => panic!("cancel answered before the check stopped"),
                () = script.aborted.notified() => {}
            }
        }
        // The RPC is gone; the check finishes its cleanup on its own.
        script.cleanup.add_permits(1);
        status.changed().await.unwrap();
        assert_eq!(script.logged(), ["started", "aborted", "cleaned"]);
        let retry = call(&table, "provider.auth.start", ctx("a"), start).await;
        assert_eq!(retry.unwrap()["phase"], "starting");
    }

    /// The instance is replaced after `start` answered but before its check ever ran: that
    /// check never starts, and nothing waits for the 300 s timeout.
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn a_key_replaced_before_its_check_runs_never_starts_it() {
        let old = Arc::new(Script::default());
        let new = Arc::new(Script::default());
        let deps = Deps {
            providers: vec![checked("agy", &old)].into(),
            ..Deps::default()
        };
        let table = table(&deps);
        let start = json!({"instanceId": "agy"});
        let mut status = deps.provider_status.subscribe();
        // Lets the old check end at its timeout if it ever starts.
        old.cleanup.add_permits(1);
        call(&table, "provider.auth.start", ctx("a"), start.clone())
            .await
            .unwrap();
        // Same poll as `start`: the worker has not run yet.
        deps.providers.replace(vec![checked("agy", &new)]);
        status.changed().await.unwrap();
        assert_eq!(old.logged(), Vec::<&str>::new());
        let mut fresh = subscribe(&table, ctx("a"), "agy").await;
        assert_eq!(next(&mut fresh).await["phase"], "idle");
        let started = call(&table, "provider.auth.start", ctx("a"), start).await;
        assert_eq!(started.unwrap()["phase"], "starting");
    }

    /// A subscriber that falls behind gets the state now and then only newer changes: it never
    /// sees an older flow after a newer one (T3's `SubscriptionRef.changes` is ordered).
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn a_lagging_stream_never_goes_back() {
        let script = Arc::new(Script::default());
        let deps = Deps {
            providers: vec![checked("agy", &script)].into(),
            ..Deps::default()
        };
        let table = table(&deps);
        let start = json!({"instanceId": "agy"});
        // Never read until every flow is done: far more changes than the buffers hold.
        let mut slow = subscribe(&table, ctx("a"), "agy").await;
        let mut watch = subscribe(&table, ctx("a"), "agy").await;
        next(&mut watch).await;
        let mut flows = Vec::new();
        for _ in 0..20 {
            let started = call(&table, "provider.auth.start", ctx("a"), start.clone())
                .await
                .unwrap();
            flows.push(started["flowId"].as_str().unwrap().to_owned());
            script.gate.add_permits(3);
            assert_eq!(steps(&mut watch, 3).await[2].0, "succeeded");
        }
        let order = |state: &Value| flows.iter().position(|id| state["flowId"] == id.as_str());
        let mut seen = Vec::new();
        // On the paused clock the timeout fires only once every task is idle.
        while let Ok(Some(state)) = tokio::time::timeout(Duration::from_secs(1), slow.recv()).await
        {
            let state = state.unwrap();
            seen.extend(order(&state));
        }
        assert_eq!(seen.last(), Some(&(flows.len() - 1)));
        assert!(
            seen.windows(2).all(|pair| pair[0] <= pair[1]),
            "the stream went back: {seen:?}"
        );
    }
}
