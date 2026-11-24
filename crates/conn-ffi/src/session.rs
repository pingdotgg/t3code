//! The app's connection state machine, one per environment scope. It owns the current attempt
//! (its target, its connection and its status), decides which events still count, when a failure
//! re-pairs through Orbit, what Retry repeats, where a link belongs, and which thread is open.
//! Swift renders [`FfiSessionState`] and calls the actions.

use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde_json::Value;

use crate::OfflineReader;
use crate::core::{ConnCore, CoreListener};
use crate::orbit::{
    FfiOrbitConnectFailure, FfiOrbitConnectOutcome, FfiOrbitSession, OrbitCore,
    orbit_connect_failure,
};
use crate::types::{
    FfiConnectionStatus, FfiCredential, FfiError, FfiSavedSession, FfiShellSnapshot,
    FfiThreadSnapshot,
};

/// The cache directory's record of which server (identity) its contents belong to.
const IDENTITY_FILE: &str = "identity";

/// How long a link keeps trying a woken Instance: 12 tries, 5 s apart.
const LINK_TRIES: u32 = 12;
const LINK_RETRY_DELAY: Duration = Duration::from_secs(5);

const IDENTITY_CHANGED: &str =
    "This server's identity changed. Reconnect manually to replace its saved connection.";

/// What an attempt connects to; Retry repeats it.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum FfiSessionTarget {
    /// The primary `agent`-role Node, found through Orbit.
    PrimaryAgent,
    /// One Orbit environment (a linked scope).
    Environment { environment_id: String },
    /// A server paired by URL.
    Manual { server_url: String },
}

/// Where a thread link opens.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiLinkRoute {
    /// In this session: the link's environment is this session's known identity.
    Here,
    /// In the link environment's own scope.
    Elsewhere,
}

/// What the app shows.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum FfiSessionPhase {
    /// No attempt: the pairing form, with the last manual failure if any.
    Idle { message: Option<String> },
    /// Finding the server; no connection yet.
    Connecting { target: FfiSessionTarget },
    /// A connection exists: the workspace, with its status.
    Live { status: FfiConnectionStatus },
    /// The attempt ended. `retry` is what Try again repeats.
    Failed {
        message: String,
        detail: Option<String>,
        retry: FfiSessionTarget,
    },
}

/// The one observable state. `revision` grows with every change, so an older state that
/// arrives late can be dropped.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiSessionState {
    pub revision: u64,
    /// The current attempt; snapshots carry it.
    pub connection_id: u64,
    pub phase: FfiSessionPhase,
    pub server_url: Option<String>,
    /// The connected server's Conn environment id, once known.
    pub environment_id: Option<String>,
    /// The connection's offline thread cache is open; read it with [`ConnSession::offline_reader`].
    pub offline_ready: bool,
    /// This session has had a working connection since launch (or since the user last chose to
    /// connect manually). The app then keeps the workspace up through reconnects and re-pairs.
    pub has_connected: bool,
    /// Grows when this scope connects to a different server than before (an Orbit primary
    /// switch, say): the previous environment's threads are gone.
    pub identity_epoch: u64,
}

/// Implemented in Swift. Every method is called with no internal locks held.
#[uniffi::export(with_foreign)]
pub trait SessionListener: Send + Sync {
    fn on_state(&self, state: FfiSessionState);
    /// Store this session (or clear it with `None`) exactly as given.
    fn on_save(&self, session: Option<FfiSavedSession>);
    fn on_shell(&self, connection_id: u64, snapshot: FfiShellSnapshot);
    fn on_thread(&self, connection_id: u64, snapshot: FfiThreadSnapshot);
    fn on_error(&self, message: String);
    fn on_providers_changed(&self);
    /// The thread's stream reported `thread.deleted` on this connection.
    fn on_thread_deleted(&self, connection_id: u64, thread_id: String);
}

// ---------------------------------------------------------------------------
// The state machine (no I/O)
// ---------------------------------------------------------------------------

/// What the machine needs to know about a live connection.
pub(crate) trait SessionCore: Clone {
    fn auth_rejected(&self) -> bool;
    fn reused_bearer(&self) -> bool;
    fn identity_changed(&self) -> bool;
}

impl SessionCore for Arc<ConnCore> {
    fn auth_rejected(&self) -> bool {
        ConnCore::auth_rejected(self)
    }
    fn reused_bearer(&self) -> bool {
        ConnCore::reused_bearer(self)
    }
    fn identity_changed(&self) -> bool {
        ConnCore::identity_changed(self)
    }
}

/// Side effects the runner carries out for the machine.
#[derive(Debug)]
pub(crate) enum Effect<C> {
    Start {
        id: u64,
        target: FfiSessionTarget,
        saved: Option<FfiSavedSession>,
        credential: Option<FfiCredential>,
    },
    Disconnect(C),
    Reconnect(C),
    Save(Option<FfiSavedSession>),
    FetchEnvironment {
        id: u64,
        server_url: String,
    },
    /// Open the offline thread cache of the server identified by `identity`.
    PrepareOffline {
        id: u64,
        core: C,
        identity: String,
    },
    /// Delete the offline thread cache: the user paired anew or signed out.
    WipeCache,
    OpenThread {
        core: C,
        thread_id: String,
    },
    /// From now on, the connection sends its bearer only to this environment.
    ExpectEnvironment {
        core: C,
        environment_id: String,
    },
    CloseThread {
        core: C,
        thread_id: String,
    },
}

struct Attempt<C> {
    id: u64,
    target: FfiSessionTarget,
    core: Option<C>,
    status: FfiConnectionStatus,
    /// A `Failed` status that arrived before the connection was handed over.
    early_failure: Option<String>,
    /// The connection completed a handshake at least once.
    connected_once: bool,
    /// A rejected bearer may re-pair through Orbit. False for a re-pair attempt until it
    /// connects, so a fresh pairing that is rejected too can't loop.
    may_recover: bool,
    /// Which server this is (Orbit server id, or a manual server's environment id). The offline
    /// cache opens only once it is known, and belongs to it.
    identity: Option<String>,
    offline_ready: bool,
}

pub(crate) struct Machine<C> {
    revision: u64,
    next_id: u64,
    attempt: Option<Attempt<C>>,
    /// The phase while there is no attempt: `Idle` or `Failed`.
    rest: FfiSessionPhase,
    saved: Option<FfiSavedSession>,
    server_url: Option<String>,
    environment_id: Option<String>,
    /// The thread the user has open in this scope (one at a time, as the app shows it). It is
    /// subscribed on every connection this session attaches.
    open_thread: Option<String>,
    has_connected: bool,
    /// The server identity this scope last connected to, and how often it changed.
    last_identity: Option<String>,
    identity_epoch: u64,
}

impl<C> fmt::Debug for Machine<C> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Machine")
            .field("revision", &self.revision)
            .field("attempt", &self.attempt.as_ref().map(|a| a.id))
            .finish_non_exhaustive()
    }
}

type Effects<C> = Vec<Effect<C>>;

impl<C: SessionCore> Machine<C> {
    pub(crate) fn new() -> Self {
        Self {
            revision: 0,
            next_id: 1,
            attempt: None,
            rest: FfiSessionPhase::Idle { message: None },
            saved: None,
            server_url: None,
            environment_id: None,
            open_thread: None,
            has_connected: false,
            last_identity: None,
            identity_epoch: 0,
        }
    }

    pub(crate) fn state(&self) -> FfiSessionState {
        let phase = match &self.attempt {
            None => self.rest.clone(),
            Some(a) if a.core.is_none() => FfiSessionPhase::Connecting {
                target: a.target.clone(),
            },
            Some(a) => FfiSessionPhase::Live {
                status: a.status.clone(),
            },
        };
        FfiSessionState {
            revision: self.revision,
            connection_id: self.attempt.as_ref().map_or(0, |a| a.id),
            phase,
            server_url: self.server_url.clone(),
            environment_id: self.environment_id.clone(),
            offline_ready: self.attempt.as_ref().is_some_and(|a| a.offline_ready),
            has_connected: self.has_connected,
            identity_epoch: self.identity_epoch,
        }
    }

    fn is_current(&self, id: u64) -> bool {
        self.attempt.as_ref().is_some_and(|a| a.id == id)
    }

    fn core(&self) -> Option<C> {
        self.attempt.as_ref().and_then(|a| a.core.clone())
    }

    /// Ends the current attempt, if any.
    fn cancel(&mut self, fx: &mut Effects<C>) {
        if let Some(core) = self.attempt.take().and_then(|a| a.core) {
            fx.push(Effect::Disconnect(core));
        }
        self.server_url = None;
        self.environment_id = None;
    }

    fn begin(
        &mut self,
        target: FfiSessionTarget,
        credential: Option<FfiCredential>,
        may_recover: Recover,
    ) -> Effects<C> {
        let mut fx = Vec::new();
        self.cancel(&mut fx);
        let id = self.next_id;
        self.next_id += 1;
        // A manual server reconnects with its saved bearer.
        let credential = credential.or_else(|| match &target {
            FfiSessionTarget::Manual { server_url } => self
                .saved
                .as_ref()
                .filter(|s| s.orbit_server_id.is_none() && s.server_url == *server_url)
                .map(|s| FfiCredential::Bearer {
                    token: s.bearer.clone(),
                }),
            _ => None,
        });
        if let FfiSessionTarget::Manual { server_url } = &target {
            self.server_url = Some(server_url.clone());
        }
        self.attempt = Some(Attempt {
            id,
            target: target.clone(),
            core: None,
            status: FfiConnectionStatus::Connecting,
            early_failure: None,
            connected_once: false,
            may_recover: may_recover == Recover::Allowed,
            identity: None,
            offline_ready: false,
        });
        fx.push(Effect::Start {
            id,
            target,
            saved: self.saved.clone(),
            credential,
        });
        fx
    }

    /// The server identity this session already knows: its attempt's, the environment it
    /// targets (or failed to reach), or its saved session's.
    fn known_identity(&self) -> Option<String> {
        let attempt = self.attempt.as_ref();
        attempt
            .and_then(|a| a.identity.clone())
            .or_else(|| match attempt.map(|a| &a.target) {
                Some(FfiSessionTarget::Environment { environment_id }) => {
                    Some(environment_id.clone())
                }
                _ => None,
            })
            .or_else(|| match &self.rest {
                // A failed environment scope is still that environment.
                FfiSessionPhase::Failed {
                    retry: FfiSessionTarget::Environment { environment_id },
                    ..
                } => Some(environment_id.clone()),
                _ => None,
            })
            .or_else(|| {
                self.saved
                    .as_ref()
                    .and_then(|s| s.environment_id.clone().or(s.orbit_server_id.clone()))
            })
    }

    // -- user actions -------------------------------------------------------

    /// At launch: a manual session reconnects; anything else goes through Orbit.
    pub(crate) fn launch(&mut self, saved: Option<FfiSavedSession>) -> Effects<C> {
        self.saved = saved.clone();
        match saved {
            Some(s) if s.orbit_server_id.is_none() => self.begin(
                FfiSessionTarget::Manual {
                    server_url: s.server_url,
                },
                None,
                Recover::Allowed,
            ),
            _ => self.begin(FfiSessionTarget::PrimaryAgent, None, Recover::Allowed),
        }
    }

    /// A linked environment's session at launch: its saved environment or manual server.
    pub(crate) fn restore(&mut self, saved: Option<FfiSavedSession>) -> Effects<C> {
        self.saved = saved.clone();
        match saved {
            Some(FfiSavedSession {
                orbit_server_id: Some(environment_id),
                ..
            }) => self.connect_environment(environment_id),
            Some(s) => self.begin(
                FfiSessionTarget::Manual {
                    server_url: s.server_url,
                },
                None,
                Recover::Allowed,
            ),
            None => Vec::new(),
        }
    }

    pub(crate) fn connect_primary_agent(&mut self) -> Effects<C> {
        self.begin(FfiSessionTarget::PrimaryAgent, None, Recover::Allowed)
    }

    /// A linked scope opened for an Orbit environment.
    pub(crate) fn connect_environment(&mut self, environment_id: String) -> Effects<C> {
        self.begin(
            FfiSessionTarget::Environment { environment_id },
            None,
            Recover::Allowed,
        )
    }

    pub(crate) fn pair_manual(&mut self, server_url: String, pairing_code: String) -> Effects<C> {
        self.saved = None;
        let mut fx = vec![Effect::Save(None), Effect::WipeCache];
        fx.extend(self.begin(
            FfiSessionTarget::Manual { server_url },
            Some(FfiCredential::PairingCode { code: pairing_code }),
            Recover::Allowed,
        ));
        fx
    }

    /// "Connect manually": stop any attempt and show the pairing form.
    pub(crate) fn connect_manually(&mut self) -> Effects<C> {
        let mut fx = Vec::new();
        self.cancel(&mut fx);
        self.has_connected = false;
        self.last_identity = None;
        self.rest = FfiSessionPhase::Idle { message: None };
        fx
    }

    pub(crate) fn sign_out(&mut self) -> Effects<C> {
        let mut fx = self.connect_manually();
        self.saved = None;
        self.open_thread = None;
        fx.push(Effect::Save(None));
        fx.push(Effect::WipeCache);
        fx
    }

    /// Try again: repeat a failed attempt's target, or nudge a live connection.
    pub(crate) fn retry(&mut self) -> Effects<C> {
        match &self.attempt {
            Some(a) => a.core.clone().map(Effect::Reconnect).into_iter().collect(),
            None => match self.rest.clone() {
                FfiSessionPhase::Failed { retry, .. } => self.begin(retry, None, Recover::Allowed),
                _ => Vec::new(),
            },
        }
    }

    /// The app came back to the foreground.
    pub(crate) fn foreground(&mut self) -> Effects<C> {
        self.retry()
    }

    /// Where a link opens. Only a link for this session's already known identity stays here;
    /// any other opens in its environment's own scope. A link never changes this session.
    pub(crate) fn route_link(&self, environment_id: &str) -> FfiLinkRoute {
        if self.known_identity().as_deref() == Some(environment_id) {
            FfiLinkRoute::Here
        } else {
            FfiLinkRoute::Elsewhere
        }
    }

    /// A link arrived. Like [`Self::route_link`]; a link for this session while its last attempt
    /// failed tries again.
    pub(crate) fn open_link(&mut self, environment_id: &str) -> (FfiLinkRoute, Effects<C>) {
        let route = self.route_link(environment_id);
        let fx = if route == FfiLinkRoute::Here && self.attempt.is_none() {
            self.retry()
        } else {
            Vec::new()
        };
        (route, fx)
    }

    /// The user opened a thread. Like the app, a scope shows one thread at a time, so another
    /// open thread is closed. It is subscribed now if connected, and on every later connection.
    pub(crate) fn open_thread(&mut self, thread_id: String) -> Effects<C> {
        let mut fx = Vec::new();
        let previous = self.open_thread.replace(thread_id.clone());
        if let Some(core) = self.core() {
            if let Some(previous) = previous.filter(|p| *p != thread_id) {
                fx.push(Effect::CloseThread {
                    core: core.clone(),
                    thread_id: previous,
                });
            }
            fx.push(Effect::OpenThread { core, thread_id });
        }
        fx
    }

    /// The user left a thread: unsubscribe it.
    pub(crate) fn close_thread(&mut self, thread_id: String) -> Effects<C> {
        if self.open_thread.as_deref() == Some(thread_id.as_str()) {
            self.open_thread = None;
        }
        self.core()
            .map(|core| Effect::CloseThread { core, thread_id })
            .into_iter()
            .collect()
    }

    // -- events -------------------------------------------------------------

    /// The attempt's connection exists. `environment_id` is the Orbit server id for Orbit
    /// targets; a manual server's comes from its saved session, then from the server.
    pub(crate) fn attached(
        &mut self,
        id: u64,
        core: C,
        server_url: String,
        environment_id: Option<String>,
    ) -> Effects<C> {
        if !self.is_current(id) {
            return vec![Effect::Disconnect(core)];
        }
        let saved_identity = self
            .saved
            .as_ref()
            .filter(|s| s.server_url == server_url)
            .and_then(|s| s.environment_id.clone());
        let Some(attempt) = self.attempt.as_mut() else {
            return Vec::new();
        };
        attempt.core = Some(core.clone());
        if let Some(message) = attempt.early_failure.take() {
            return self.failed(id, message);
        }
        let manual = environment_id.is_none();
        self.server_url = Some(server_url.clone());
        // Identify first: another server than before drops the open thread.
        let mut fx = self.identified(id, environment_id.or(saved_identity));
        fx.extend(
            self.open_thread
                .clone()
                .map(|thread_id| Effect::OpenThread {
                    core: core.clone(),
                    thread_id,
                }),
        );
        if manual {
            fx.push(Effect::FetchEnvironment { id, server_url });
        }
        fx
    }

    /// The attempt could not produce a connection.
    pub(crate) fn start_failed(
        &mut self,
        id: u64,
        message: String,
        detail: Option<String>,
    ) -> Effects<C> {
        if !self.is_current(id) {
            return Vec::new();
        }
        let mut fx = Vec::new();
        let target = self.attempt.as_ref().map(|a| a.target.clone());
        self.cancel(&mut fx);
        self.rest = match target {
            Some(FfiSessionTarget::Manual { .. }) | None => FfiSessionPhase::Idle {
                message: Some(detail.unwrap_or(message)),
            },
            Some(retry) => FfiSessionPhase::Failed {
                message,
                detail,
                retry,
            },
        };
        fx
    }

    pub(crate) fn status(&mut self, id: u64, status: FfiConnectionStatus) -> Effects<C> {
        if !self.is_current(id) {
            return Vec::new();
        }
        let Some(attempt) = self.attempt.as_mut() else {
            return Vec::new();
        };
        if let FfiConnectionStatus::Failed { message } = status {
            if attempt.core.is_none() {
                attempt.early_failure = Some(message);
                return Vec::new();
            }
            return self.failed(id, message);
        }
        if status == FfiConnectionStatus::Connected {
            attempt.connected_once = true;
            attempt.may_recover = true;
            self.has_connected = true;
        }
        attempt.status = status;
        Vec::new()
    }

    /// The live connection ended for good.
    fn failed(&mut self, id: u64, message: String) -> Effects<C> {
        let Some(attempt) = self.attempt.as_ref() else {
            return Vec::new();
        };
        let target = attempt.target.clone();
        if attempt
            .core
            .as_ref()
            .is_some_and(SessionCore::identity_changed)
        {
            return self.identity_changed(message);
        }
        let rejected = attempt
            .core
            .as_ref()
            .is_some_and(SessionCore::auth_rejected);
        let reused = attempt
            .core
            .as_ref()
            .is_some_and(SessionCore::reused_bearer);
        let orbit = !matches!(target, FfiSessionTarget::Manual { .. });
        if orbit && rejected && attempt.may_recover && (attempt.connected_once || reused) {
            // The bearer is dead: forget it and pair again through Orbit, once.
            self.saved = None;
            let mut fx = vec![Effect::Save(None)];
            fx.extend(self.begin(target, None, Recover::AfterConnecting));
            return fx;
        }
        let headline = if rejected {
            "The server rejected this iPhone's sign-in."
        } else {
            "The connection to the server failed."
        };
        let (message, detail) = if orbit {
            (headline.to_owned(), Some(message))
        } else {
            (message, None)
        };
        self.start_failed(id, message, detail)
    }

    pub(crate) fn bearer(&mut self, id: u64, mut session: FfiSavedSession) -> Effects<C> {
        if !self.is_current(id) {
            return Vec::new();
        }
        if session.environment_id.is_none() {
            session.environment_id = self.attempt.as_ref().and_then(|a| a.identity.clone());
        }
        self.saved = Some(session.clone());
        vec![Effect::Save(Some(session))]
    }

    /// A manual server named its environment (`None`: it couldn't be asked).
    pub(crate) fn environment(&mut self, id: u64, environment_id: Option<String>) -> Effects<C> {
        if !self.is_current(id) {
            return Vec::new();
        }
        let Some(env) = environment_id else {
            return Vec::new();
        };
        match self.attempt.as_ref().and_then(|a| a.identity.clone()) {
            Some(known) if known == env => Vec::new(),
            Some(_) => self.identity_changed(format!("It now reports environment {env}.")),
            None => {
                let mut fx = self.identified(id, Some(env.clone()));
                if let Some(core) = self.core() {
                    // Reconnects of this pairing now go only to this environment.
                    fx.push(Effect::ExpectEnvironment {
                        core,
                        environment_id: env.clone(),
                    });
                }
                if let Some(saved) = self.saved.as_mut().filter(|s| s.environment_id.is_none()) {
                    saved.environment_id = Some(env);
                    fx.push(Effect::Save(Some(saved.clone())));
                }
                fx
            }
        }
    }

    /// Another server answers at this URL. Keep the saved identity and its cache; only a re-pair
    /// the user starts may replace them.
    fn identity_changed(&mut self, detail: String) -> Effects<C> {
        let mut fx = Vec::new();
        let target = self.attempt.as_ref().map(|a| a.target.clone());
        self.cancel(&mut fx);
        if let Some(retry) = target {
            self.rest = FfiSessionPhase::Failed {
                message: IDENTITY_CHANGED.to_owned(),
                detail: Some(detail),
                retry,
            };
        }
        fx
    }

    /// The attempt's server is now known: open its cache.
    fn identified(&mut self, id: u64, identity: Option<String>) -> Effects<C> {
        let Some(identity) = identity else {
            return Vec::new();
        };
        let Some(attempt) = self.attempt.as_mut().filter(|a| a.id == id) else {
            return Vec::new();
        };
        attempt.identity = Some(identity.clone());
        let core = attempt.core.clone();
        self.environment_id = Some(identity.clone());
        let mut fx = Vec::new();
        if self
            .last_identity
            .as_ref()
            .is_some_and(|last| *last != identity)
        {
            // Another server than this scope had: its threads and workspace don't carry over.
            self.has_connected = false;
            self.identity_epoch += 1;
            if let (Some(thread_id), Some(core)) = (self.open_thread.take(), core.clone()) {
                fx.push(Effect::CloseThread { core, thread_id });
            }
        }
        self.last_identity = Some(identity.clone());
        fx.extend(core.map(|core| Effect::PrepareOffline { id, core, identity }));
        fx
    }

    pub(crate) fn offline_ready(&mut self, id: u64) -> Effects<C> {
        if let Some(attempt) = self.attempt.as_mut().filter(|a| a.id == id) {
            attempt.offline_ready = true;
        }
        Vec::new()
    }

    fn bump(&mut self) {
        self.revision += 1;
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Recover {
    Allowed,
    AfterConnecting,
}

// ---------------------------------------------------------------------------
// The runner: ConnSession
// ---------------------------------------------------------------------------

/// UniFFI handle to the app's connection: one state machine plus the Orbit client it uses.
#[derive(uniffi::Object)]
pub struct ConnSession {
    orbit: Arc<OrbitCore>,
    listener: Arc<dyn SessionListener>,
    machine: Mutex<Machine<Arc<ConnCore>>>,
    /// Where this session keeps its offline thread cache, if anywhere.
    cache_dir: Option<PathBuf>,
    /// The current attempt's offline reader.
    offline: Mutex<Option<(u64, Arc<OfflineReader>)>>,
    this: Weak<ConnSession>,
}

impl fmt::Debug for ConnSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConnSession").finish_non_exhaustive()
    }
}

impl ConnSession {
    pub(crate) fn with_orbit(
        orbit: Arc<OrbitCore>,
        cache_dir: Option<PathBuf>,
        listener: Arc<dyn SessionListener>,
    ) -> Arc<Self> {
        Arc::new_cyclic(|this| Self {
            orbit,
            listener,
            machine: Mutex::new(Machine::new()),
            cache_dir,
            offline: Mutex::new(None),
            this: this.clone(),
        })
    }

    /// Runs one machine step, carries out its effects, then publishes the new state.
    fn step(&self, f: impl FnOnce(&mut Machine<Arc<ConnCore>>) -> Effects<Arc<ConnCore>>) {
        let (fx, state) = {
            let mut machine = self.machine.lock().unwrap_or_else(|e| e.into_inner());
            let fx = f(&mut machine);
            machine.bump();
            (fx, machine.state())
        };
        for effect in fx {
            self.apply(effect);
        }
        self.listener.on_state(state);
    }

    fn is_current(&self, id: u64) -> bool {
        self.machine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_current(id)
    }

    fn apply(&self, effect: Effect<Arc<ConnCore>>) {
        match effect {
            Effect::Disconnect(core) => core.disconnect(),
            Effect::Reconnect(core) => core.reconnect(),
            Effect::Save(session) => self.listener.on_save(session),
            Effect::Start {
                id,
                target,
                saved,
                credential,
            } => {
                let Some(this) = self.this.upgrade() else {
                    return;
                };
                self.orbit
                    .handle()
                    .spawn(async move { this.run_attempt(id, target, saved, credential).await });
            }
            Effect::FetchEnvironment { id, server_url } => {
                let Some(this) = self.this.upgrade() else {
                    return;
                };
                self.orbit.handle().spawn(async move {
                    let env = fetch_environment_id(&server_url).await;
                    this.step(|m| m.environment(id, env));
                });
            }
            Effect::PrepareOffline { id, core, identity } => {
                let (Some(this), Some(dir)) = (self.this.upgrade(), self.cache_dir.clone()) else {
                    return;
                };
                if !self.claim_cache(id, &dir, &identity) {
                    return;
                }
                self.orbit.handle().spawn(async move {
                    this.open_offline(id, &core, dir, identity).await;
                });
            }
            Effect::OpenThread { core, thread_id } => core.open_thread(thread_id),
            Effect::CloseThread { core, thread_id } => core.close_thread(thread_id),
            Effect::ExpectEnvironment {
                core,
                environment_id,
            } => core.expect_environment(environment_id),
            Effect::WipeCache => {
                *self.offline.lock().unwrap_or_else(|e| e.into_inner()) = None;
                if let Some(dir) = &self.cache_dir {
                    let _ = std::fs::remove_dir_all(dir);
                }
            }
        }
    }

    /// Makes the cache directory this attempt's server's, emptying it when it held another
    /// server's. Runs under the machine lock, so only the current attempt writes it.
    fn claim_cache(&self, id: u64, dir: &std::path::Path, identity: &str) -> bool {
        let machine = self.machine.lock().unwrap_or_else(|e| e.into_inner());
        if !machine.is_current(id) {
            return false;
        }
        claim_cache_dir(dir, identity).is_ok()
    }

    async fn open_offline(&self, id: u64, core: &ConnCore, dir: PathBuf, identity: String) {
        match core
            .prepare_offline(dir.to_string_lossy().into_owned(), identity)
            .await
        {
            Ok(reader) if self.is_current(id) => {
                *self.offline.lock().unwrap_or_else(|e| e.into_inner()) = Some((id, reader));
                self.step(|m| m.offline_ready(id));
            }
            Ok(_) => {}
            Err(err) => {
                if self.is_current(id) {
                    self.listener.on_error(err.to_string());
                }
            }
        }
    }

    fn listener_for(&self, id: u64) -> Arc<dyn CoreListener> {
        Arc::new(AttemptListener {
            session: self.this.clone(),
            id,
        })
    }

    async fn run_attempt(
        self: Arc<Self>,
        id: u64,
        target: FfiSessionTarget,
        saved: Option<FfiSavedSession>,
        credential: Option<FfiCredential>,
    ) {
        let listener = self.listener_for(id);
        match target {
            FfiSessionTarget::PrimaryAgent => {
                // Only a session saved for an Orbit environment can be reused here.
                let saved = saved.and_then(|s| {
                    s.orbit_server_id.map(|server_id| FfiOrbitSession {
                        server_id,
                        server_url: s.server_url,
                        bearer: s.bearer,
                    })
                });
                match self.orbit.connect_primary_agent(saved, listener).await {
                    FfiOrbitConnectOutcome::Connected {
                        core,
                        server_id,
                        server_url,
                        ..
                    } => self.step(|m| m.attached(id, core, server_url, Some(server_id))),
                    FfiOrbitConnectOutcome::Failed {
                        message, detail, ..
                    } => self.step(|m| m.start_failed(id, message, detail)),
                }
            }
            FfiSessionTarget::Environment { environment_id, .. } => {
                // A bearer saved for this environment is reused (and re-paired if refused).
                let cached = saved
                    .filter(|s| s.orbit_server_id.as_deref() == Some(environment_id.as_str()))
                    .map(|s| s.bearer);
                self.run_link(id, environment_id, cached, listener).await;
            }
            FfiSessionTarget::Manual { server_url } => {
                let Some(credential) = credential else {
                    self.step(|m| {
                        m.start_failed(id, "Paste a pairing URL to connect.".to_owned(), None)
                    });
                    return;
                };
                // A saved bearer goes only to the environment it was saved for.
                let expected = match &credential {
                    FfiCredential::Bearer { .. } => saved
                        .filter(|s| s.orbit_server_id.is_none() && s.server_url == server_url)
                        .and_then(|s| s.environment_id),
                    FfiCredential::PairingCode { .. } => None,
                };
                match ConnCore::start_checked(server_url, credential, listener, None, expected) {
                    Ok(core) => {
                        let url = core.server_url();
                        self.step(|m| m.attached(id, core, url, None));
                    }
                    Err(err) => self.step(|m| m.start_failed(id, err.to_string(), None)),
                }
            }
        }
    }

    /// Finds the link's environment in the fleet, wakes it if it sleeps, then connects.
    async fn run_link(
        &self,
        id: u64,
        environment_id: String,
        mut cached: Option<String>,
        listener: Arc<dyn CoreListener>,
    ) {
        let fail = |err: &FfiError| match orbit_connect_failure(
            err,
            FfiOrbitConnectFailure::PairingRefused,
        ) {
            FfiOrbitConnectOutcome::Failed {
                message, detail, ..
            } => (message, detail),
            FfiOrbitConnectOutcome::Connected { core, .. } => {
                core.disconnect();
                (String::new(), None)
            }
        };
        let fleet = match self.orbit.fleet().await {
            Ok(fleet) => fleet,
            Err(err) => {
                let (message, detail) = fail(&err);
                self.step(|m| m.start_failed(id, message, detail));
                return;
            }
        };
        let Some(target) = fleet.into_iter().find(|t| t.server_id == environment_id) else {
            self.step(|m| {
                m.start_failed(
                    id,
                    "Orbit doesn't list the environment of that thread.".to_owned(),
                    None,
                )
            });
            return;
        };
        if let Some(instance_id) = target.instance_id
            && target.power_state == Some(crate::orbit::FfiOrbitPowerState::Stopped)
            && let Err(err) = self.orbit.wake_instance(instance_id).await
        {
            let (message, detail) = fail(&err);
            self.step(|m| m.start_failed(id, message, detail));
            return;
        }
        let mut last = None;
        for _ in 0..LINK_TRIES {
            if !self.is_current(id) {
                return;
            }
            match self
                .orbit
                .connect_environment(environment_id.clone(), cached.take(), Arc::clone(&listener))
                .await
            {
                Ok(core) => {
                    let url = core.server_url();
                    let env = environment_id.clone();
                    self.step(|m| m.attached(id, core, url, Some(env)));
                    return;
                }
                Err(err) => {
                    last = Some(err);
                    // A woken Instance takes a little while to serve.
                    tokio::time::sleep(LINK_RETRY_DELAY).await;
                }
            }
        }
        if let Some(err) = last {
            let (_, detail) = fail(&err);
            self.step(|m| {
                m.start_failed(
                    id,
                    "Couldn't open that thread through Orbit.".to_owned(),
                    detail,
                )
            });
        }
    }
}

#[uniffi::export]
impl ConnSession {
    /// Creates the session over an Orbit Gateway client (`gateway_url`, or the default).
    ///
    /// # Errors
    ///
    /// Returns the [`FfiError`] of [`OrbitCore::new`].
    #[uniffi::constructor]
    pub fn new(
        gateway_url: Option<String>,
        cache_directory: Option<String>,
        listener: Arc<dyn SessionListener>,
    ) -> Result<Arc<Self>, FfiError> {
        Ok(Self::with_orbit(
            OrbitCore::new(gateway_url)?,
            cache_directory.map(PathBuf::from),
            listener,
        ))
    }

    /// The app's main session at launch: a saved manual server, else the primary agent.
    pub fn launch(&self, saved: Option<FfiSavedSession>) {
        self.step(|m| m.launch(saved));
    }

    /// A linked environment's session at launch: its saved Orbit environment or manual server.
    pub fn restore(&self, saved: Option<FfiSavedSession>) {
        self.step(|m| m.restore(saved));
    }

    /// The current connection's offline thread cache, once open.
    #[must_use]
    pub fn offline_reader(&self) -> Option<Arc<OfflineReader>> {
        let slot = self.offline.lock().unwrap_or_else(|e| e.into_inner());
        slot.as_ref()
            .filter(|(id, _)| self.is_current(*id))
            .map(|(_, reader)| Arc::clone(reader))
    }

    pub fn connect_primary_agent(&self) {
        self.step(Machine::connect_primary_agent);
    }

    pub fn pair_manual(&self, server_url: String, pairing_code: String) {
        self.step(|m| m.pair_manual(server_url, pairing_code));
    }

    pub fn connect_manually(&self) {
        self.step(Machine::connect_manually);
    }

    pub fn sign_out(&self) {
        self.step(Machine::sign_out);
    }

    pub fn retry(&self) {
        self.step(Machine::retry);
    }

    pub fn foreground(&self) {
        self.step(Machine::foreground);
    }

    /// Where a link for `environment_id` opens: here only when it is this session's already
    /// known server (trying again if its last attempt failed); otherwise in that environment's
    /// own scope.
    pub fn open_link(&self, environment_id: String) -> FfiLinkRoute {
        let mut route = FfiLinkRoute::Elsewhere;
        self.step(|m| {
            let (r, fx) = m.open_link(&environment_id);
            route = r;
            fx
        });
        route
    }

    /// A linked scope's session connects to its Orbit environment.
    pub fn connect_environment(&self, environment_id: String) {
        self.step(|m| m.connect_environment(environment_id));
    }

    /// The user opened this thread (closing the scope's other one); it stays subscribed across
    /// this session's connections.
    pub fn open_thread(&self, thread_id: String) {
        self.step(|m| m.open_thread(thread_id));
    }

    /// The user left this thread: unsubscribe it.
    pub fn close_thread(&self, thread_id: String) {
        self.step(|m| m.close_thread(thread_id));
    }

    /// The live connection, for thread and command calls.
    #[must_use]
    pub fn core(&self) -> Option<Arc<ConnCore>> {
        self.machine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .attempt
            .as_ref()
            .and_then(|a| a.core.clone())
    }

    #[must_use]
    pub fn state(&self) -> FfiSessionState {
        self.machine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .state()
    }
}

/// Feeds one attempt's connection events into the session; events of an older attempt are
/// dropped there.
struct AttemptListener {
    session: Weak<ConnSession>,
    id: u64,
}

impl AttemptListener {
    fn current(&self) -> Option<Arc<ConnSession>> {
        self.session.upgrade().filter(|s| s.is_current(self.id))
    }
}

impl CoreListener for AttemptListener {
    fn on_status(&self, status: FfiConnectionStatus) {
        if let Some(session) = self.session.upgrade() {
            session.step(|m| m.status(self.id, status));
        }
    }

    fn on_bearer_issued(&self, session: FfiSavedSession) {
        if let Some(s) = self.session.upgrade() {
            s.step(|m| m.bearer(self.id, session));
        }
    }

    fn on_shell(&self, snapshot: FfiShellSnapshot) {
        if let Some(s) = self.current() {
            s.listener.on_shell(self.id, snapshot);
        }
    }

    fn on_thread(&self, snapshot: FfiThreadSnapshot) {
        if let Some(s) = self.current() {
            s.listener.on_thread(self.id, snapshot);
        }
    }

    fn on_error(&self, message: String) {
        if let Some(s) = self.current() {
            s.listener.on_error(message);
        }
    }

    fn on_providers_changed(&self) {
        if let Some(s) = self.current() {
            s.listener.on_providers_changed();
        }
    }

    fn on_thread_deleted(&self, thread_id: String) {
        if let Some(s) = self.current() {
            s.listener.on_thread_deleted(self.id, thread_id);
        }
    }
}

/// Empties `dir` unless it already belongs to `identity`, then marks it as `identity`'s.
fn claim_cache_dir(dir: &std::path::Path, identity: &str) -> std::io::Result<()> {
    let marker = dir.join(IDENTITY_FILE);
    if std::fs::read_to_string(&marker).ok().as_deref() != Some(identity) && dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    std::fs::create_dir_all(dir)?;
    std::fs::write(marker, identity)
}

/// Reads a server's Conn environment id (`/.well-known/t3/environment`).
async fn fetch_environment_id(server_url: &str) -> Option<String> {
    let url = url::Url::parse(server_url)
        .ok()?
        .join(".well-known/t3/environment")
        .ok()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;
    let body: Value = client.get(url).send().await.ok()?.json().await.ok()?;
    body.get("environmentId")?.as_str().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use std::sync::Condvar;

    use conn_orbit::gateway::GatewayResponse;
    use serde_json::json;

    use super::*;
    use crate::orbit::tests::{MockGateway, spawn_mock_conn_server, spawn_rejecting_server};

    const AUTH: &str = "The server rejected this device's sign-in.";

    #[derive(Clone, Debug, Default)]
    struct FakeCore {
        rejected: bool,
        reused: bool,
        mismatch: bool,
    }

    impl SessionCore for FakeCore {
        fn auth_rejected(&self) -> bool {
            self.rejected
        }
        fn reused_bearer(&self) -> bool {
            self.reused
        }
        fn identity_changed(&self) -> bool {
            self.mismatch
        }
    }

    fn rejected() -> FakeCore {
        FakeCore {
            rejected: true,
            ..FakeCore::default()
        }
    }

    fn failed(message: &str) -> FfiConnectionStatus {
        FfiConnectionStatus::Failed {
            message: message.to_owned(),
        }
    }

    fn starts(fx: &[Effect<FakeCore>]) -> Vec<(u64, FfiSessionTarget)> {
        fx.iter()
            .filter_map(|e| match e {
                Effect::Start { id, target, .. } => Some((*id, target.clone())),
                _ => None,
            })
            .collect()
    }

    fn link() -> FfiSessionTarget {
        FfiSessionTarget::Environment {
            environment_id: "inst-7".to_owned(),
        }
    }

    fn opens(fx: &[Effect<FakeCore>]) -> Vec<String> {
        fx.iter()
            .filter_map(|e| match e {
                Effect::OpenThread { thread_id, .. } => Some(thread_id.clone()),
                _ => None,
            })
            .collect()
    }

    fn closes(fx: &[Effect<FakeCore>]) -> Vec<String> {
        fx.iter()
            .filter_map(|e| match e {
                Effect::CloseThread { thread_id, .. } => Some(thread_id.clone()),
                _ => None,
            })
            .collect()
    }

    fn saved(url: &str, orbit: Option<&str>, env: Option<&str>) -> FfiSavedSession {
        FfiSavedSession {
            server_url: url.to_owned(),
            bearer: "bearer".to_owned(),
            orbit_server_id: orbit.map(str::to_owned),
            environment_id: env.map(str::to_owned),
        }
    }

    #[test]
    fn a_rejection_before_the_connection_is_handed_over_still_ends_the_attempt() {
        let mut m = Machine::<FakeCore>::new();
        let _ = m.connect_primary_agent();
        assert!(
            m.status(1, failed(AUTH)).is_empty(),
            "nothing to do before the handover"
        );
        let fx = m.attached(
            1,
            rejected(),
            "http://agent/".to_owned(),
            Some("node-agent".to_owned()),
        );
        assert!(
            starts(&fx).is_empty(),
            "a fresh pairing that is rejected doesn't re-pair"
        );
        assert!(
            matches!(
                m.state().phase,
                FfiSessionPhase::Failed {
                    retry: FfiSessionTarget::PrimaryAgent,
                    ..
                }
            ),
            "the handover doesn't turn the failure back into connecting: {:?}",
            m.state().phase
        );

        // The same early rejection of a reused bearer re-pairs at once.
        let mut m = Machine::<FakeCore>::new();
        let _ = m.connect_primary_agent();
        let _ = m.status(1, failed(AUTH));
        let reused = FakeCore {
            rejected: true,
            reused: true,
            ..FakeCore::default()
        };
        let fx = m.attached(1, reused, "http://agent/".to_owned(), None);
        assert_eq!(
            starts(&fx),
            vec![(2, FfiSessionTarget::PrimaryAgent)],
            "a rejected reused bearer re-pairs through Orbit"
        );
    }

    #[test]
    fn a_manual_pair_supersedes_a_pending_environment_which_never_saves() {
        let mut m = Machine::<FakeCore>::new();
        assert_eq!(
            starts(&m.connect_environment("inst-7".to_owned())),
            vec![(1, link())],
            "the linked environment starts an attempt"
        );
        let fx = m.pair_manual("http://mac:3773".to_owned(), "code".to_owned());
        assert_eq!(
            starts(&fx).len(),
            1,
            "the manual pair starts its own attempt"
        );
        let fx = m.attached(
            1,
            rejected(),
            "http://inst/".to_owned(),
            Some("inst-7".to_owned()),
        );
        assert!(
            matches!(fx.as_slice(), [Effect::Disconnect(_)]),
            "the late connection is closed, not taken over"
        );
        assert!(
            m.bearer(1, saved("http://inst/", Some("inst-7"), Some("inst-7")))
                .is_empty(),
            "the late attempt never saves a bearer"
        );
        assert!(
            m.status(1, FfiConnectionStatus::Connected).is_empty(),
            "nor changes the status"
        );
        assert_eq!(
            m.state().connection_id,
            2,
            "the manual attempt stays current"
        );
    }

    #[test]
    fn retry_after_a_failed_environment_repeats_it_and_reopens_the_thread() {
        let mut m = Machine::<FakeCore>::new();
        let _ = m.connect_environment("inst-7".to_owned());
        let _ = m.open_thread("thread-1".to_owned());
        let _ = m.start_failed(1, "Couldn't reach it.".to_owned(), None);
        assert!(
            matches!(&m.state().phase, FfiSessionPhase::Failed { retry, .. } if *retry == link()),
            "the failure keeps the environment as its retry target"
        );
        assert_eq!(
            starts(&m.retry()),
            vec![(2, link())],
            "Try again opens the same Instance"
        );
        let fx = m.attached(
            2,
            rejected(),
            "http://inst/".to_owned(),
            Some("inst-7".to_owned()),
        );
        assert_eq!(
            opens(&fx),
            vec!["thread-1"],
            "the thread is subscribed once connected"
        );
    }

    #[test]
    fn a_linked_environment_restores_its_own_target() {
        let mut m = Machine::<FakeCore>::new();
        assert_eq!(
            starts(&m.restore(Some(saved("http://inst/", Some("inst-7"), Some("inst-7"))))),
            vec![(1, link())],
            "a linked environment reconnects to itself, not the primary agent"
        );
    }

    #[test]
    fn a_link_for_b_while_a_connects_and_fails_leaves_a_alone() {
        let mut m = Machine::<FakeCore>::new();
        let _ = m.launch(Some(saved("http://agent/", Some("node-a"), Some("node-a"))));
        assert_eq!(
            m.route_link("env-b"),
            FfiLinkRoute::Elsewhere,
            "B opens in its own scope while A is still connecting"
        );
        assert_eq!(
            m.route_link("node-a"),
            FfiLinkRoute::Here,
            "A's own link stays"
        );
        let fx = m.start_failed(1, "Gateway down".to_owned(), None);
        assert!(starts(&fx).is_empty(), "A's failure doesn't turn into B");
        assert!(
            !fx.iter()
                .any(|e| matches!(e, Effect::Save(_) | Effect::WipeCache)),
            "A's bearer and cache are untouched"
        );
        assert!(
            matches!(
                m.state().phase,
                FfiSessionPhase::Failed {
                    retry: FfiSessionTarget::PrimaryAgent,
                    ..
                }
            ),
            "A fails as itself"
        );

        // B's scope has its own session.
        let mut b = Machine::<FakeCore>::new();
        assert_eq!(
            starts(&b.connect_environment("env-b".to_owned())),
            vec![(
                1,
                FfiSessionTarget::Environment {
                    environment_id: "env-b".to_owned()
                }
            )],
            "B connects in its own scope"
        );
        assert_eq!(
            b.route_link("env-b"),
            FfiLinkRoute::Here,
            "and keeps B's links"
        );
    }

    #[test]
    fn links_still_open_for_a_legacy_session_without_an_environment_id() {
        let mut m = Machine::<FakeCore>::new();
        let _ = m.launch(Some(saved("http://agent/", Some("node-a"), None)));
        assert_eq!(
            m.route_link("node-a"),
            FfiLinkRoute::Here,
            "an Orbit session is known by its server id"
        );
        let mut manual = Machine::<FakeCore>::new();
        let _ = manual.launch(Some(saved("http://mac:3773/", None, None)));
        assert_eq!(
            manual.route_link("env-x"),
            FfiLinkRoute::Elsewhere,
            "an unknown manual server sends links to their own scope, which opens them"
        );
    }

    #[test]
    fn closing_the_visible_thread_leaves_nothing_subscribed() {
        let mut m = Machine::<FakeCore>::new();
        let _ = m.connect_environment("inst-7".to_owned());
        let _ = m.attached(
            1,
            rejected(),
            "http://inst/".to_owned(),
            Some("inst-7".to_owned()),
        );
        assert_eq!(
            opens(&m.open_thread("t1".to_owned())),
            vec!["t1"],
            "t1 opens"
        );
        let fx = m.open_thread("t2".to_owned());
        assert_eq!(
            closes(&fx),
            vec!["t1"],
            "a second link's thread replaces the first"
        );
        assert_eq!(opens(&fx), vec!["t2"], "and is subscribed");
        assert_eq!(
            closes(&m.close_thread("t2".to_owned())),
            vec!["t2"],
            "closing unsubscribes it"
        );

        // A later connection subscribes nothing.
        let _ = m.status(1, failed("lost"));
        let _ = m.retry();
        let fx = m.attached(
            2,
            rejected(),
            "http://inst/".to_owned(),
            Some("inst-7".to_owned()),
        );
        assert!(opens(&fx).is_empty(), "no thread is left subscribed");
    }

    #[test]
    fn an_open_thread_survives_a_re_pair_and_closes_on_the_new_connection() {
        let mut m = Machine::<FakeCore>::new();
        let _ = m.launch(Some(saved("http://mac:3773/", None, Some("env-a"))));
        let _ = m.open_thread("t1".to_owned());
        let fx = m.attached(1, rejected(), "http://mac:3773/".to_owned(), None);
        assert_eq!(opens(&fx), vec!["t1"], "the open thread is subscribed");
        let _ = m.pair_manual("http://mac:3773/".to_owned(), "code".to_owned());
        let fx = m.attached(2, rejected(), "http://mac:3773/".to_owned(), None);
        assert_eq!(
            opens(&fx),
            vec!["t1"],
            "the re-paired connection subscribes it again"
        );
        assert_eq!(
            m.state().connection_id,
            2,
            "snapshots now come from the new connection"
        );
        assert_eq!(
            closes(&m.close_thread("t1".to_owned())),
            vec!["t1"],
            "closing it unsubscribes it there"
        );
    }

    #[test]
    fn a_changed_identity_fails_without_touching_the_saved_identity_or_cache() {
        let mut m = Machine::<FakeCore>::new();
        let _ = m.launch(Some(saved("http://mac:3773/", None, Some("env-a"))));
        let fx = m.attached(1, rejected(), "http://mac:3773/".to_owned(), None);
        assert!(
            fx.iter().any(|e| matches!(
                e,
                Effect::PrepareOffline { identity, .. } if identity == "env-a"
            )),
            "A's cache opens"
        );

        // B now answers at A's URL.
        let fx = m.environment(1, Some("env-b".to_owned()));
        assert!(
            !fx.iter().any(|e| matches!(
                e,
                Effect::Save(_) | Effect::WipeCache | Effect::PrepareOffline { .. }
            )),
            "nothing is saved, emptied or opened for B: {fx:?}"
        );
        assert!(
            matches!(
                &m.state().phase,
                FfiSessionPhase::Failed { message, retry: FfiSessionTarget::Manual { .. }, .. }
                    if message == IDENTITY_CHANGED
            ),
            "the attempt fails with the reason, and Try again stays manual"
        );

        // A is back: Try again reconnects with the saved bearer and A's cache.
        let fx = m.retry();
        assert!(
            fx.iter().any(|e| matches!(
                e,
                Effect::Start {
                    credential: Some(FfiCredential::Bearer { .. }),
                    ..
                }
            )),
            "Try again reuses the saved bearer"
        );
        let fx = m.attached(2, rejected(), "http://mac:3773/".to_owned(), None);
        assert!(
            fx.iter().any(|e| matches!(
                e,
                Effect::PrepareOffline { identity, .. } if identity == "env-a"
            )),
            "A's cache is A's again, never emptied"
        );
        assert!(
            m.environment(2, Some("env-a".to_owned())).is_empty(),
            "A matches its saved identity"
        );
    }

    #[test]
    fn a_link_to_a_sleeping_environment_subscribes_its_thread_once_connected() {
        let mut m = Machine::<FakeCore>::new();
        let _ = m.connect_environment("inst-7".to_owned());
        assert!(
            opens(&m.open_thread("thread-1".to_owned())).is_empty(),
            "nothing to subscribe while the Instance wakes"
        );
        let fx = m.attached(
            1,
            rejected(),
            "http://inst/".to_owned(),
            Some("inst-7".to_owned()),
        );
        assert_eq!(
            opens(&fx),
            vec!["thread-1"],
            "subscribed as soon as it connects"
        );
    }

    #[test]
    fn a_bearer_revoked_after_success_re_pairs_exactly_once() {
        let mut m = Machine::<FakeCore>::new();
        let _ = m.connect_primary_agent();
        let _ = m.attached(
            1,
            rejected(),
            "http://agent/".to_owned(),
            Some("node-agent".to_owned()),
        );
        let _ = m.status(1, FfiConnectionStatus::Connected);

        // The bearer is revoked: the reconnect handshake gets 401.
        let fx = m.status(1, failed(AUTH));
        assert!(
            fx.iter().any(|e| matches!(e, Effect::Save(None))),
            "the dead bearer is forgotten"
        );
        assert!(
            fx.iter().any(|e| matches!(
                e,
                Effect::Start {
                    id: 2,
                    saved: None,
                    ..
                }
            )),
            "it pairs again through Orbit without the dead bearer"
        );

        // The fresh pairing is rejected too, before it ever connects: no second re-pair.
        let _ = m.attached(
            2,
            rejected(),
            "http://agent/".to_owned(),
            Some("node-agent".to_owned()),
        );
        assert!(
            starts(&m.status(2, failed(AUTH))).is_empty(),
            "no mint-then-reject loop"
        );
        assert!(
            matches!(m.state().phase, FfiSessionPhase::Failed { .. }),
            "it ends as failed, with Try again"
        );
    }

    #[derive(Default)]
    struct Recorder {
        states: Mutex<Vec<FfiSessionState>>,
        deleted: Mutex<Vec<(u64, String)>>,
        saves: Mutex<Vec<Option<FfiSavedSession>>>,
        notify: Condvar,
    }

    impl Recorder {
        fn wait_for(&self, pred: impl Fn(&FfiSessionState) -> bool) -> bool {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            let mut guard = self.states.lock().expect("states");
            loop {
                if guard.iter().any(&pred) {
                    return true;
                }
                let Some(rem) = deadline.checked_duration_since(std::time::Instant::now()) else {
                    return false;
                };
                guard = self.notify.wait_timeout(guard, rem).expect("wait").0;
            }
        }
    }

    impl SessionListener for Recorder {
        fn on_state(&self, state: FfiSessionState) {
            self.states.lock().expect("states").push(state);
            self.notify.notify_all();
        }
        fn on_save(&self, session: Option<FfiSavedSession>) {
            self.saves.lock().expect("saves").push(session);
        }
        fn on_shell(&self, _connection_id: u64, _snapshot: FfiShellSnapshot) {}
        fn on_thread(&self, _connection_id: u64, _snapshot: FfiThreadSnapshot) {}
        fn on_error(&self, _message: String) {}
        fn on_providers_changed(&self) {}
        fn on_thread_deleted(&self, connection_id: u64, thread_id: String) {
            self.deleted
                .lock()
                .expect("deleted")
                .push((connection_id, thread_id));
        }
    }

    #[test]
    fn a_delete_from_a_superseded_attempt_clears_nothing() {
        let gateway = MockGateway::new(|_| {
            Err(conn_orbit::gateway::GatewayError::Network(
                "offline".to_owned(),
            ))
        });
        let recorder = Arc::new(Recorder::default());
        let cache = tempfile::tempdir().expect("cache dir");
        let session = ConnSession::with_orbit(
            OrbitCore::with_transport(gateway).expect("orbit"),
            Some(cache.path().join("thread-cache")),
            recorder.clone(),
        );
        session.pair_manual("http://127.0.0.1:9".to_owned(), "old".to_owned());
        let old = session.state().connection_id;
        session.pair_manual("http://127.0.0.1:9".to_owned(), "new".to_owned());
        let new = session.state().connection_id;
        assert_ne!(old, new, "the second pair is a new attempt");

        let listener_of = |id| AttemptListener {
            session: Arc::downgrade(&session),
            id,
        };
        listener_of(old).on_thread_deleted("thread-1".to_owned());
        assert!(
            recorder.deleted.lock().expect("deleted").is_empty(),
            "a late delete from the old connection clears no draft"
        );
        listener_of(new).on_thread_deleted("thread-1".to_owned());
        assert_eq!(
            *recorder.deleted.lock().expect("deleted"),
            vec![(new, "thread-1".to_owned())],
            "the current connection's delete reaches its store, with its id"
        );
    }

    #[test]
    fn a_session_whose_server_refuses_ends_failed_not_connecting() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("test tokio rt");
        let gw_url = rt.block_on(spawn_rejecting_server());
        let gateway = MockGateway::new(move |req| {
            let body = match req.path.as_str() {
                "/environments" => json!({ "data": [{
                    "environment_id": "node-agent",
                    "label": "agent",
                    "url": gw_url,
                    "status": "registered",
                    "cleanup_pending": false,
                    "instance_id": null,
                    "roles": ["agent"]
                }]}),
                _ => json!({ "data": {
                    "pairing_url": format!("{gw_url}/pair#token=code"),
                    "pairing": { "environment_id": "node-agent" }
                }}),
            };
            Ok(GatewayResponse {
                status: 200,
                body: body.to_string(),
            })
        });
        let recorder = Arc::new(Recorder::default());
        let cache = tempfile::tempdir().expect("cache dir");
        let session = ConnSession::with_orbit(
            OrbitCore::with_transport(gateway).expect("orbit"),
            Some(cache.path().join("thread-cache")),
            recorder.clone(),
        );
        session.connect_primary_agent();
        assert!(
            recorder.wait_for(|s| matches!(s.phase, FfiSessionPhase::Failed { .. })),
            "a refused pairing ends as failed"
        );
        let last = session.state();
        assert!(
            matches!(
                last.phase,
                FfiSessionPhase::Failed {
                    retry: FfiSessionTarget::PrimaryAgent,
                    ..
                }
            ),
            "and stays failed, with Try again: {last:?}"
        );
        assert!(session.core().is_none(), "no connection is left behind");
    }

    #[test]
    fn a_superseded_environment_lookup_writes_nothing() {
        let mut m = Machine::<FakeCore>::new();
        let _ = m.pair_manual("http://a:3773".to_owned(), "code-a".to_owned());
        let fx = m.attached(1, rejected(), "http://a:3773/".to_owned(), None);
        assert!(
            fx.iter()
                .any(|e| matches!(e, Effect::FetchEnvironment { id: 1, .. })),
            "a manual server is asked for its environment"
        );
        assert!(
            !fx.iter()
                .any(|e| matches!(e, Effect::PrepareOffline { .. })),
            "no cache before the server's identity is known"
        );
        let _ = m.pair_manual("http://b:3773".to_owned(), "code-b".to_owned());
        assert!(
            m.environment(1, Some("env-a".to_owned())).is_empty(),
            "A's late answer opens, saves and writes nothing"
        );
        assert_eq!(m.state().environment_id, None, "B's environment isn't A's");
    }

    #[test]
    fn a_new_node_at_the_same_url_starts_with_an_empty_cache() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("test tokio rt");
        let (gw_url, server) = rt.block_on(spawn_mock_conn_server(
            "good",
            "code",
            "fresh",
            "/srv/workspace",
        ));
        let gateway = MockGateway::new(move |req| {
            let body = match req.path.as_str() {
                "/environments" => json!({ "data": [{
                    "environment_id": "node-new",
                    "label": "agent",
                    "url": gw_url,
                    "status": "registered",
                    "cleanup_pending": false,
                    "instance_id": null,
                    "roles": ["agent"]
                }]}),
                _ => json!({ "data": {
                    "pairing_url": format!("{gw_url}/pair#token=code"),
                    "pairing": { "environment_id": "node-new" }
                }}),
            };
            Ok(GatewayResponse {
                status: 200,
                body: body.to_string(),
            })
        });
        // The old Node at this URL left its cache behind.
        let cache = tempfile::tempdir().expect("cache dir");
        let dir = cache.path().join("thread-cache");
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(dir.join(IDENTITY_FILE), "node-old").expect("marker");
        std::fs::write(dir.join("shell.json"), "old node's inbox").expect("old shell");

        let recorder = Arc::new(Recorder::default());
        let session = ConnSession::with_orbit(
            OrbitCore::with_transport(gateway).expect("orbit"),
            Some(dir.clone()),
            recorder.clone(),
        );
        session.connect_primary_agent();
        assert!(
            recorder.wait_for(|s| s.offline_ready),
            "the new Node's cache opens"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join(IDENTITY_FILE))
                .expect("marker")
                .as_str(),
            "node-new",
            "the cache now belongs to the new Node"
        );
        assert!(
            !dir.join("shell.json").exists(),
            "nothing of the old Node's cache carries over"
        );
        if let Some(core) = session.core() {
            core.disconnect();
        }
        server.abort();
    }

    /// Answers its environment descriptor with `env` and anything else with 401; records whether
    /// any request carried an `Authorization` header.
    async fn server_named(env: &'static str) -> (String, Arc<std::sync::atomic::AtomicBool>) {
        use std::sync::atomic::{AtomicBool, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let saw_bearer = Arc::new(AtomicBool::new(false));
        let seen = Arc::clone(&saw_bearer);
        tokio::spawn(async move {
            while let Ok((mut tcp, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                let n = tcp.read(&mut buf).await.unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
                if head.contains("\r\nauthorization:") {
                    seen.store(true, Ordering::SeqCst);
                }
                let reply = if head.starts_with("get /.well-known/t3/environment") {
                    let body = format!(r#"{{"environmentId":"{env}"}}"#);
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                } else {
                    "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .to_owned()
                };
                let _ = tcp.write_all(reply.as_bytes()).await;
            }
        });
        (format!("http://{addr}/"), saw_bearer)
    }

    #[test]
    fn a_saved_manual_bearer_never_reaches_another_environment() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("test tokio rt");
        let (url, saw_bearer) = rt.block_on(server_named("env-b"));
        let gateway = MockGateway::new(|_| {
            Err(conn_orbit::gateway::GatewayError::Network(
                "unused".to_owned(),
            ))
        });
        let recorder = Arc::new(Recorder::default());
        let cache = tempfile::tempdir().expect("cache dir");
        let session = ConnSession::with_orbit(
            OrbitCore::with_transport(gateway).expect("orbit"),
            Some(cache.path().join("thread-cache")),
            recorder.clone(),
        );
        // A's saved session, but B answers at A's address.
        session.launch(Some(saved(&url, None, Some("env-a"))));
        assert!(
            recorder.wait_for(|s| matches!(
                &s.phase,
                FfiSessionPhase::Failed { message, .. } if message == IDENTITY_CHANGED
            )),
            "the attempt fails as an identity change"
        );
        assert!(
            !saw_bearer.load(std::sync::atomic::Ordering::SeqCst),
            "B never received an Authorization header"
        );
        assert!(
            recorder.saves.lock().expect("saves").is_empty(),
            "A's saved session is left as it is"
        );
    }

    #[test]
    fn a_re_pair_after_connecting_keeps_the_workspace_and_the_open_thread() {
        let mut m = Machine::<FakeCore>::new();
        let _ = m.connect_primary_agent();
        let _ = m.attached(
            1,
            rejected(),
            "http://agent/".to_owned(),
            Some("node-a".to_owned()),
        );
        let _ = m.status(1, FfiConnectionStatus::Connected);
        let _ = m.open_thread("t1".to_owned());
        assert!(
            m.state().has_connected,
            "the scope has connected this launch"
        );

        // The bearer is revoked: the session re-pairs on its own.
        let fx = m.status(1, failed(AUTH));
        assert_eq!(starts(&fx).len(), 1, "a re-pair starts");
        let state = m.state();
        assert!(
            matches!(state.phase, FfiSessionPhase::Connecting { .. }),
            "connecting again"
        );
        assert!(
            state.has_connected,
            "the workspace stays up: the scope connected before"
        );
        let fx = m.attached(
            2,
            rejected(),
            "http://agent/".to_owned(),
            Some("node-a".to_owned()),
        );
        assert_eq!(
            opens(&fx),
            vec!["t1"],
            "the visible thread is subscribed again"
        );

        // Choosing to connect manually starts the scope over.
        let _ = m.connect_manually();
        assert!(!m.state().has_connected, "the pairing screen shows again");
    }

    #[test]
    fn a_second_link_to_a_failed_environment_tries_again() {
        let mut m = Machine::<FakeCore>::new();
        let _ = m.connect_environment("inst-7".to_owned());
        let _ = m.start_failed(1, "Couldn't reach it.".to_owned(), None);
        let (route, fx) = m.open_link("inst-7");
        assert_eq!(route, FfiLinkRoute::Here, "the link belongs to this scope");
        assert_eq!(
            starts(&fx),
            vec![(2, link())],
            "and starts a new attempt for it"
        );
        let (_, fx) = m.open_link("inst-7");
        assert!(
            starts(&fx).is_empty(),
            "an attempt in progress is left alone"
        );
    }

    /// A server that is environment A (descriptor, pairing exchange, WebSocket) until `now_b` is
    /// set; then B answers at the same address and A's socket closes. Records whether any request
    /// after the switch carried an `Authorization` header.
    async fn server_taken_over() -> (
        String,
        Arc<std::sync::atomic::AtomicBool>,
        Arc<std::sync::atomic::AtomicBool>,
    ) {
        use std::sync::atomic::{AtomicBool, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let now_b = Arc::new(AtomicBool::new(false));
        let bearer_to_b = Arc::new(AtomicBool::new(false));
        let (switched, leaked) = (Arc::clone(&now_b), Arc::clone(&bearer_to_b));
        tokio::spawn(async move {
            while let Ok((mut tcp, _)) = listener.accept().await {
                let (switched, leaked) = (Arc::clone(&switched), Arc::clone(&leaked));
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let n = tcp.peek(&mut buf).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
                    let b = switched.load(Ordering::SeqCst);
                    if b && head.contains("\r\nauthorization:") {
                        leaked.store(true, Ordering::SeqCst);
                    }
                    if head.starts_with("get /ws") && !b {
                        let Ok(_ws) = tokio_tungstenite::accept_async(tcp).await else {
                            return;
                        };
                        // A's socket stays open until B takes over the address.
                        while !switched.load(Ordering::SeqCst) {
                            tokio::time::sleep(Duration::from_millis(20)).await;
                        }
                        return;
                    }
                    let _ = tcp.read(&mut buf).await;
                    let (status, body) = if head.starts_with("get /.well-known/t3/environment") {
                        let env = if b { "env-b" } else { "env-a" };
                        ("200 OK", format!(r#"{{"environmentId":"{env}"}}"#))
                    } else if head.starts_with("post /oauth/token") {
                        ("200 OK", r#"{"access_token":"paired-bearer"}"#.to_owned())
                    } else {
                        ("401 Unauthorized", String::new())
                    };
                    let reply = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = tcp.write_all(reply.as_bytes()).await;
                });
            }
        });
        (format!("http://{addr}/"), now_b, bearer_to_b)
    }

    #[test]
    fn a_new_pairing_sends_reconnects_only_to_the_environment_it_learned() {
        use std::sync::atomic::Ordering;
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("test tokio rt");
        let (url, now_b, bearer_to_b) = rt.block_on(server_taken_over());
        let gateway = MockGateway::new(|_| {
            Err(conn_orbit::gateway::GatewayError::Network(
                "unused".to_owned(),
            ))
        });
        let recorder = Arc::new(Recorder::default());
        let cache = tempfile::tempdir().expect("cache dir");
        let session = ConnSession::with_orbit(
            OrbitCore::with_transport(gateway).expect("orbit"),
            Some(cache.path().join("thread-cache")),
            recorder.clone(),
        );
        // A fresh pairing: no expected environment yet.
        session.pair_manual(url, "code".to_owned());
        assert!(
            recorder.wait_for(|s| {
                s.environment_id.as_deref() == Some("env-a")
                    && matches!(
                        s.phase,
                        FfiSessionPhase::Live {
                            status: FfiConnectionStatus::Connected
                        }
                    )
            }),
            "the pairing connects and the session learns A"
        );

        // B takes over the address; A's socket drops and the driver reconnects.
        now_b.store(true, Ordering::SeqCst);
        assert!(
            recorder.wait_for(|s| matches!(
                &s.phase,
                FfiSessionPhase::Failed { message, .. } if message == IDENTITY_CHANGED
            )),
            "the reconnect finds B and stops"
        );
        assert!(
            !bearer_to_b.load(Ordering::SeqCst),
            "B never received an Authorization header"
        );
    }

    #[test]
    fn a_switch_to_another_server_drops_the_old_thread_and_workspace() {
        let mut m = Machine::<FakeCore>::new();
        let _ = m.connect_primary_agent();
        let _ = m.attached(
            1,
            rejected(),
            "http://agent-a/".to_owned(),
            Some("node-a".to_owned()),
        );
        let _ = m.status(1, FfiConnectionStatus::Connected);
        let _ = m.open_thread("t1".to_owned());
        assert!(m.state().has_connected, "A connected");

        // A re-pair resolves to another primary Node.
        let _ = m.status(1, failed(AUTH));
        let fx = m.attached(
            2,
            rejected(),
            "http://agent-b/".to_owned(),
            Some("node-b".to_owned()),
        );
        assert!(opens(&fx).is_empty(), "A's thread is not subscribed on B");
        assert_eq!(m.open_thread, None, "the open thread is cleared");
        let state = m.state();
        assert!(
            !state.has_connected,
            "the connecting screen shows until B connects"
        );
        assert_eq!(state.identity_epoch, 1, "the app sees the switch");

        // The same Node again changes nothing.
        let _ = m.status(2, FfiConnectionStatus::Connected);
        let _ = m.open_thread("t2".to_owned());
        let _ = m.status(2, failed(AUTH));
        let fx = m.attached(
            3,
            rejected(),
            "http://agent-b/".to_owned(),
            Some("node-b".to_owned()),
        );
        assert_eq!(opens(&fx), vec!["t2"], "same server: the thread stays");
        assert!(m.state().has_connected, "and so does the workspace");
    }
}
