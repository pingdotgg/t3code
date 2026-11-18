//! Managed access: the target side of Orbit's "Managed grant revocation" contract
//! (`docs/managed-access.md`).
//!
//! A managed target serves Orbit callers on a managed ingress, separate from the native one.
//! A caller presents a Gateway-issued `conn_mt_` token. The target checks it with the Gateway
//! at each transport admission, binds it to the caller's TCP peer, and admits it only against
//! the authority revision it has applied. When the Gateway removes the caller's direct Node
//! edge, the target fences that edge: every socket, stream and queued frame of it ends, and
//! new calls and reconnects are refused. Other edges keep running. When the target loses the
//! Gateway (a failed probe, an expired lease, a closed notice link) it fails closed for all
//! managed access until a fresh snapshot with a live lease.
//!
//! - [`authority`]: the state and its rules, without I/O.
//! - [`gateway`]: the Gateway's target routes over HTTPS with the lab CA.
//! - [`notices`]: the Reverb subscription that wakes the target on a removal.
//! - [`ingress`]: the managed HTTP and WebSocket routes.

pub mod authority;
pub mod conn;
pub mod gateway;
pub mod ingress;
pub mod notices;
pub mod provision;

use std::sync::{Arc, Mutex};

use futures_core::future::BoxFuture;
use serde::Deserialize;
use serde_json::Value;
use tokio::{
    sync::{Notify, watch},
    time::Instant,
};

use authority::{Authority, AuthorityReply, EdgeId, Effects, Loss, Notice, Refusal};
use gateway::{Gateway, GatewayError};

pub use provision::Provision;

/// The scopes of the `reader` purpose. The Gateway fixes them; the target admits a reader
/// only with exactly these.
pub const READER_SCOPES: [&str; 2] = ["orchestration:read", "terminal:read"];

/// The authority shared by the ingress, the probe loop, the notice link and every handler.
pub struct Shared {
    authority: Mutex<Authority>,
    /// Raised on every change, so waiters and the lease timer look again.
    changed: watch::Sender<u64>,
    wake_probe: Notify,
    wake_ack: Notify,
}

impl std::fmt::Debug for Shared {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Shared").finish_non_exhaustive()
    }
}

/// The verified claims of a managed token, as `/introspect` returns them.
#[derive(Clone, Debug, Deserialize)]
pub struct Claims {
    pub nonce: String,
    pub environment_id: String,
    pub generation: u64,
    pub token_id: Value,
    pub caller_node_id: u64,
    pub edge_id: EdgeId,
    pub scopes: Vec<String>,
    pub expires_at: String,
    pub revision: u64,
    /// Fields later contracts add (the task worker grant). Kept, never trusted unread.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/// An admitted managed caller.
#[derive(Clone, Debug)]
pub struct ManagedPrincipal {
    pub token_id: String,
    pub caller_node_id: u64,
    pub edge_id: EdgeId,
    pub scopes: Vec<String>,
    pub expires_ms: u64,
    pub claims: Arc<Claims>,
}

/// Why an admission failed. Each maps to one response; none falls through to native auth.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AdmitError {
    /// Not a managed token, or one the Gateway refused.
    Invalid,
    /// The token is valid but its edge is fenced, it expired, or its profile does not allow
    /// this ingress.
    Forbidden,
    /// Managed access is unavailable now (failed closed, recovering, Gateway unreachable).
    Unavailable,
}

fn random_nonce() -> String {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).expect("the OS random source is available");
    conn_support::base64::url_encode(&bytes)
}

fn now_ms() -> u64 {
    conn_support::time::now_ms()
}

impl Shared {
    pub fn new(environment_id: String, generation: u64) -> Arc<Self> {
        Arc::new(Self {
            authority: Mutex::new(Authority::new(environment_id, generation)),
            changed: watch::channel(0).0,
            wake_probe: Notify::new(),
            wake_ack: Notify::new(),
        })
    }

    /// Runs `f` on the authority under the lock, then wakes whoever its effects name.
    pub fn with<T>(&self, f: impl FnOnce(&mut Authority) -> (T, Effects)) -> T {
        let (value, effects) = {
            let mut authority = crate::lock(&self.authority);
            f(&mut authority)
        };
        self.changed.send_modify(|n| *n = n.wrapping_add(1));
        if effects.probe_now {
            self.wake_probe.notify_one();
        }
        if effects.ack {
            self.wake_ack.notify_one();
        }
        value
    }

    /// Reads the authority under the lock.
    pub fn read<T>(&self, f: impl FnOnce(&Authority) -> T) -> T {
        f(&crate::lock(&self.authority))
    }

    pub fn notice(&self, notice: &Notice) {
        self.with(|a| ((), a.notice(notice, Instant::now(), now_ms())));
    }

    pub fn set_notice_link(&self, up: bool) {
        self.with(|a| ((), a.set_notice_link(up)));
    }

    pub fn fail_closed(&self, loss: Loss) {
        self.with(|a| {
            a.fail_closed(loss);
            ((), Effects::default())
        });
    }

    fn wait_change(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    /// Starts the probe loop, the lease timer and the ACK loop. They run for the life of the
    /// process.
    pub fn spawn(self: &Arc<Self>, gateway: Arc<dyn Gateway>) {
        tokio::spawn(probe_loop(self.clone(), gateway.clone()));
        tokio::spawn(lease_timer(self.clone()));
        tokio::spawn(ack_loop(self.clone(), gateway));
    }

    /// Checks a managed bearer with the Gateway and admits it, registering its handler in
    /// the same step. `allowed` checks the claims' profile for the route. A redeemed ticket
    /// passes its binding, checked in that same step.
    pub async fn admit(
        self: &Arc<Self>,
        gateway: &Arc<dyn Gateway>,
        token: &str,
        peer_address: String,
        ticket: Option<authority::TicketBinding>,
        allowed: impl Fn(&Claims) -> bool,
    ) -> Result<(ManagedPrincipal, Handle), AdmitError> {
        if !provision::has_secret_shape(token, provision::MANAGED_TOKEN_PREFIX) {
            return Err(AdmitError::Invalid);
        }
        let (environment_id, generation) =
            self.read(|a| (a.environment_id().to_owned(), a.generation()));
        let mut changes = self.wait_change();
        // A barrier, a cleared fence or a reconcile asks for a fresh introspection. Callers
        // that arrive while the target recovers wait for it; the whole admission is bounded.
        let deadline = Instant::now() + authority::LEASE * 2;
        loop {
            if Instant::now() >= deadline {
                return Err(AdmitError::Unavailable);
            }
            let (epoch, available) = self.read(|a| (a.epoch(), a.available(Instant::now())));
            if !available {
                let wait = tokio::time::timeout_at(deadline, changes.changed()).await;
                if !matches!(wait, Ok(Ok(()))) {
                    return Err(AdmitError::Unavailable);
                }
                continue;
            }
            let nonce = random_nonce();
            // The call always gets its own full timeout, so a timeout is the Gateway's failure,
            // never one this caller's deadline cut short. The deadline is checked again where
            // the handler registers.
            let call_until = Instant::now() + gateway::CALL_TIMEOUT;
            let reply = tokio::time::timeout_at(
                call_until,
                gateway.introspect(nonce.clone(), token.to_owned(), peer_address.clone()),
            )
            .await;
            let reply = reply.unwrap_or_else(|_| Err(GatewayError::Transport("timeout".into())));
            // A barrier dropped this introspection: whatever came back, ask again. A
            // current-epoch failure is processed (it may fail everything closed) before the
            // caller's own deadline counts; registration checks the deadline again.
            if self.read(|a| a.epoch()) != epoch {
                if Instant::now() >= deadline {
                    return Err(AdmitError::Unavailable);
                }
                continue;
            }
            let claims = match reply {
                Ok(value) => match serde_json::from_value::<Claims>(value) {
                    Ok(claims) => claims,
                    Err(_) => {
                        self.fail_closed(Loss::ProbeFailed);
                        return Err(AdmitError::Unavailable);
                    }
                },
                Err(GatewayError::Refused { code, .. }) if is_caller_refusal(&code) => {
                    return Err(AdmitError::Invalid);
                }
                Err(_) => {
                    // The Gateway refused the target itself, or cannot answer: authority is
                    // lost for every caller.
                    self.fail_closed(Loss::ProbeFailed);
                    return Err(AdmitError::Unavailable);
                }
            };
            if claims.nonce != nonce {
                // Never sent or already consumed: drop it.
                return Err(AdmitError::Invalid);
            }
            if claims.environment_id != environment_id || claims.generation != generation {
                self.fail_closed(Loss::WrongIdentity);
                return Err(AdmitError::Unavailable);
            }
            // Every verified introspection teaches the target the Gateway's revision, before
            // any refusal of this caller: one it has not applied pauses everything.
            self.with(|a| ((), a.note_revision(claims.revision, Instant::now())));
            let Some(expires_ms) = conn_support::time::millis_from_iso(&claims.expires_at)
                .and_then(|ms| u64::try_from(ms).ok())
            else {
                return Err(AdmitError::Invalid);
            };
            if !allowed(&claims) {
                return Err(AdmitError::Forbidden);
            }
            let admitted = self.with(|a| {
                let now = Instant::now();
                if now >= deadline {
                    return (Err(Refusal::Unavailable), Effects::default());
                }
                let expires = a.local_deadline(expires_ms, now, now_ms());
                (
                    a.admit(
                        claims.edge_id,
                        claims.revision,
                        expires,
                        epoch,
                        ticket,
                        now,
                        now_ms(),
                    )
                    .inspect(|(id, _)| a.set_handler_expiry(*id, expires_ms))
                    .map(|(id, closed)| (id, closed, expires)),
                    Effects::default(),
                )
            });
            match admitted {
                Ok((id, closed, expires)) => {
                    let principal = ManagedPrincipal {
                        token_id: id_text(&claims.token_id),
                        caller_node_id: claims.caller_node_id,
                        edge_id: claims.edge_id,
                        scopes: claims.scopes.clone(),
                        expires_ms,
                        claims: Arc::new(claims),
                    };
                    let handle = Handle {
                        shared: self.clone(),
                        id,
                        expires,
                        closed,
                    };
                    return Ok((principal, handle));
                }
                Err(Refusal::Fenced | Refusal::Expired) => return Err(AdmitError::Forbidden),
                Err(Refusal::Stale | Refusal::Unavailable) => {
                    if Instant::now() >= deadline {
                        return Err(AdmitError::Unavailable);
                    }
                }
                Err(Refusal::Reconcile) => {
                    // The Gateway is ahead of us: reconcile first, then introspect again.
                    self.wake_probe.notify_one();
                    let target = claims.revision;
                    let caught_up = tokio::time::timeout_at(deadline, async {
                        loop {
                            if self.read(|a| a.applied().is_some_and(|r| r >= target)) {
                                return;
                            }
                            if changes.changed().await.is_err() {
                                return std::future::pending().await;
                            }
                        }
                    })
                    .await;
                    if caught_up.is_err() {
                        return Err(AdmitError::Unavailable);
                    }
                }
            }
        }
    }
}

/// Gateway refusals that concern only the presented token or its caller. Every other
/// refusal (target identity, generation, the switch, unknown codes) means the target lost
/// its authority.
fn is_caller_refusal(code: &str) -> bool {
    matches!(
        code,
        "conn.managed_token_invalid"
            | "conn.managed_peer_mismatch"
            | "conn.managed_direct_edge_required"
    )
}

/// A Gateway call that answers within [`gateway::CALL_TIMEOUT`], or a transport failure.
async fn bounded(
    call: BoxFuture<'static, Result<Value, GatewayError>>,
) -> Result<Value, GatewayError> {
    tokio::time::timeout(gateway::CALL_TIMEOUT, call)
        .await
        .unwrap_or_else(|_| Err(GatewayError::Transport("timeout".into())))
}

fn id_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// One registered managed handler: a socket, a stream or one HTTP request. It is the gate
/// that the RPC session and the media stream check at every boundary. Dropping it records
/// the close.
pub struct Handle {
    shared: Arc<Shared>,
    id: u64,
    /// The token's expiry as a target monotonic deadline, on the safe side of the clock
    /// offset.
    expires: Instant,
    closed: watch::Receiver<bool>,
}

impl std::fmt::Debug for Handle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Handle").field("id", &self.id).finish()
    }
}

impl Handle {
    /// What the handler may do now. Finds an expired lease itself, so a boundary never
    /// waits for the lease timer.
    pub fn state(&self) -> crate::session::GateState {
        use crate::session::GateState;
        if *self.closed.borrow() {
            return GateState::Closed;
        }
        let now = Instant::now();
        let expired_lease = self
            .shared
            .read(|a| a.is_open() && a.lease_until().is_none_or(|t| now >= t));
        if expired_lease {
            self.shared.with(|a| {
                a.check_lease(now);
                ((), Effects::default())
            });
        }
        match self
            .shared
            .read(|a| a.handler_state(self.id, self.expires, now))
        {
            authority::GateState::Open => GateState::Open,
            authority::GateState::Paused => GateState::Paused,
            authority::GateState::Closed => GateState::Closed,
        }
    }

    /// The token's expiry as a monotonic deadline.
    pub fn deadline(&self) -> Instant {
        self.expires
    }

    /// Whether the handler may send or dispatch now.
    pub fn open(&self) -> bool {
        self.state() == crate::session::GateState::Open
    }

    /// Resolves when the fence closes this handler or its token expires. The expiry timer
    /// re-arms whenever a verified probe moves the deadline.
    pub fn closed(&self) -> BoxFuture<'static, ()> {
        let mut closed = self.closed.clone();
        let (shared, id, admitted) = (self.shared.clone(), self.id, self.expires);
        Box::pin(async move {
            let mut changes = shared.wait_change();
            loop {
                let deadline = shared.read(|a| a.handler_deadline_of(id, admitted, Instant::now()));
                tokio::select! {
                    _ = closed.wait_for(|c| *c) => return,
                    () = tokio::time::sleep_until(deadline) => {
                        if Instant::now() >= deadline {
                            return;
                        }
                    }
                    _ = changes.changed() => {}
                }
            }
        })
    }

    /// Resolves at the next authority change, or within a short bound.
    pub fn changed(&self) -> BoxFuture<'static, ()> {
        let mut changes = self.shared.wait_change();
        Box::pin(async move {
            let _ = tokio::time::timeout(authority::PROBE_EVERY, changes.changed()).await;
        })
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        let id = self.id;
        self.shared.with(|a| ((), a.unregister(id, Instant::now())));
    }
}

impl crate::session::Gate for Handle {
    fn state(&self) -> crate::session::GateState {
        Handle::state(self)
    }

    fn closed(&self) -> BoxFuture<'static, ()> {
        Handle::closed(self)
    }

    fn changed(&self) -> BoxFuture<'static, ()> {
        Handle::changed(self)
    }
}

async fn probe_loop(shared: Arc<Shared>, gateway: Arc<dyn Gateway>) {
    loop {
        let now = Instant::now();
        let probe = shared.with(|a| {
            (
                a.begin_probe(random_nonce(), now, now_ms()),
                Effects::default(),
            )
        });
        let mut next = now + authority::PROBE_EVERY;
        if let Some(probe) = probe {
            next = probe.sent + authority::PROBE_EVERY;
            let result =
                bounded(gateway.authority(probe.nonce.clone(), probe.after_revision)).await;
            let reply = result
                .ok()
                .and_then(|value| serde_json::from_value::<AuthorityReply>(value).ok());
            let again = shared.with(|a| match &reply {
                Some(reply) => {
                    let mut effects = a.apply_reply(reply, Instant::now(), now_ms());
                    // A reply that did not match the probe renews nothing; the call is over,
                    // so the probe is retired and the next one goes out.
                    let retired = a.retire_probe(&probe.nonce);
                    effects.probe_now |= retired.probe_now;
                    (effects.probe_now, effects)
                }
                None => {
                    a.probe_failed(&probe.nonce);
                    (false, Effects::default())
                }
            });
            if again {
                continue;
            }
        }
        tokio::select! {
            () = tokio::time::sleep_until(next) => {}
            () = shared.wake_probe.notified() => {}
        }
    }
}

/// Fences at the end of the lease even when no frame or call looks.
async fn lease_timer(shared: Arc<Shared>) {
    let mut changes = shared.wait_change();
    loop {
        let until = shared.read(|a| a.is_open().then(|| a.lease_until()).flatten());
        match until {
            Some(until) => tokio::select! {
                () = tokio::time::sleep_until(until) => {
                    shared.with(|a| {
                        a.check_lease(Instant::now());
                        ((), Effects::default())
                    });
                }
                _ = changes.changed() => {}
            },
            None => {
                if changes.changed().await.is_err() {
                    return;
                }
            }
        }
    }
}

/// The `/ack` request body: every time key is present, `null` where the kind has none, as
/// the Gateway's `ConnManagedTargetRequest` requires.
pub fn ack_body(ack: &authority::Ack) -> Value {
    let iso = |ms: Option<u64>| ms.map(conn_support::time::iso_from_ms);
    serde_json::json!({
        "revision": ack.revision,
        "kind": match ack.kind {
            authority::AckKind::Observed => "observed",
            authority::AckKind::Recovered => "recovered",
        },
        "notice_received_at": iso(ack.notice_received_ms),
        "fenced_at": iso(ack.fenced_ms),
        "handlers_closed_at": iso(ack.handlers_closed_ms),
        "recovered_at": iso(ack.recovered_ms),
    })
}

async fn ack_loop(shared: Arc<Shared>, gateway: Arc<dyn Gateway>) {
    loop {
        let ack = shared.with(|a| {
            let ack = a.next_ack();
            if let Some(ack) = &ack {
                a.ack_started(ack.revision);
            }
            (ack, Effects::default())
        });
        let Some(ack) = ack else {
            tokio::select! {
                () = shared.wake_ack.notified() => {}
                () = tokio::time::sleep(authority::PROBE_EVERY) => {}
            }
            continue;
        };
        let body = ack_body(&ack);
        let result = bounded(gateway.ack(body)).await;
        // A refusal of the target itself (rotated credential or generation, unknown target,
        // switch off) is lost authority, at once, whichever route saw it first.
        if let Err(GatewayError::Refused { code, .. }) = &result
            && matches!(
                code.as_str(),
                "conn.managed_generation_mismatch"
                    | "conn.managed_target_identity"
                    | "conn.managed_target_unknown"
                    | "conn.managed_disabled"
                    | "peer.identity_unknown"
            )
        {
            shared.fail_closed(Loss::WrongIdentity);
        }
        // An ACK the Gateway does not know is not owed: stop sending it. A lost one stays owed.
        let ok = match &result {
            Ok(_) => true,
            Err(GatewayError::Refused { code, .. }) => code == "conn.managed_ack_unknown",
            Err(GatewayError::Transport(_)) => false,
        };
        shared.with(|a| ((), a.ack_finished(ack.revision, ok)));
        if !ok {
            tokio::time::sleep(authority::PROBE_EVERY).await;
        }
    }
}

#[cfg(test)]
mod tests;
