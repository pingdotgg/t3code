//! One agent connection: our request ids, the replies to them, and everything else the agent
//! sends, in order, on one bounded channel.
//!
//! Request ids count from 2^30 per connection, as T3's Effect RPC client writes them.
//! The pending map holds one entry per request in flight and is emptied when the agent exits.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use conn_provider_support::lines::Line;
use conn_provider_support::process::{ExitInfo, ProcEvent};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::ordered::J;
use crate::protocol::{self, Inbound, RequestId, RpcError};

/// What the agent sent that is not a reply to us, plus its exit. Always ends with `Closed`.
#[derive(Debug)]
pub(crate) enum Incoming {
    Request {
        id: RequestId,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    /// The reply to a request sent with [`Connection::send`], in order with the frames
    /// around it (a prompt's reply must not overtake the updates the agent sent before it).
    Reply {
        id: i64,
        result: Result<Value, CallError>,
    },
    /// The agent's exit, and the failure that ended the connection ([`Signal`]), if any.
    Closed {
        exit: Option<ExitInfo>,
        failure: Option<conn_provider::ProviderError>,
    },
    /// [`Connection::barrier`]: everything forwarded before it has been handled.
    Barrier(oneshot::Sender<()>),
}

/// A line that is not JSON-RPC but ends the connection with this failure (Antigravity's
/// sign-in URL on stdout). Pending calls fail with it.
pub(crate) type Signal = fn(&str) -> Option<conn_provider::ProviderError>;

/// Why a request got no result.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum CallError {
    Rpc(RpcError),
    /// The agent exited or closed stdout before it replied.
    Closed,
    /// The agent's output ended the connection with this failure ([`Signal`]).
    Provider(conn_provider::ProviderError),
}

impl CallError {
    pub(crate) fn detail(&self) -> String {
        match self {
            Self::Rpc(error) => error.message.clone(),
            Self::Closed => "the agent process exited".into(),
            Self::Provider(error) => error.to_string(),
        }
    }
}

type Reply = oneshot::Sender<Result<Value, CallError>>;

#[derive(Default)]
struct Pending {
    next_id: i64,
    waiting: HashMap<i64, Reply>,
    /// Requests whose reply goes to the incoming channel.
    ordered: std::collections::HashSet<i64>,
    closed: bool,
    /// What ended the connection ([`Signal`]); calls after the close fail with it.
    failure: Option<conn_provider::ProviderError>,
}

impl Pending {
    /// Why a call on the closed connection gets no result.
    fn closed_error(&self) -> CallError {
        self.failure
            .clone()
            .map_or(CallError::Closed, CallError::Provider)
    }
}

/// The writing half; cheap to clone.
#[derive(Clone)]
pub(crate) struct Connection {
    writer: mpsc::Sender<String>,
    pending: Arc<Mutex<Pending>>,
    /// The incoming channel, for [`Connection::barrier`].
    incoming: mpsc::Sender<Incoming>,
}

impl std::fmt::Debug for Connection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Connection").finish_non_exhaustive()
    }
}

/// A call's place in `waiting`, removed on drop.
struct Waiting<'a> {
    pending: &'a Mutex<Pending>,
    id: i64,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        crate::lock(self.pending).waiting.remove(&self.id);
    }
}

/// Effect's RPC client numbers requests from 2^30 (seen in T3's stdin, conformance check).
const FIRST_REQUEST_ID: i64 = 1 << 30;

/// Unknown lines are counted, not kept; the first few are logged.
const LOGGED_SKIPS: u32 = 5;

impl Connection {
    /// Starts routing `events` (the agent's stdout lines and exit). Returns the connection and
    /// the channel of everything that is not a reply.
    pub(crate) fn start(
        writer: mpsc::Sender<String>,
        events: mpsc::Receiver<ProcEvent>,
        capacity: usize,
    ) -> (Self, mpsc::Receiver<Incoming>) {
        Self::start_with_signal(writer, events, capacity, None)
    }

    /// [`Connection::start`] with a [`Signal`] checked on every stdout line.
    pub(crate) fn start_with_signal(
        writer: mpsc::Sender<String>,
        mut events: mpsc::Receiver<ProcEvent>,
        capacity: usize,
        signal: Option<Signal>,
    ) -> (Self, mpsc::Receiver<Incoming>) {
        let pending = Arc::new(Mutex::new(Pending {
            next_id: FIRST_REQUEST_ID,
            ..Pending::default()
        }));
        let (incoming_tx, incoming) = mpsc::channel(capacity);
        let barrier_tx = incoming_tx.clone();
        let routed = pending.clone();
        tokio::spawn(async move {
            let mut skipped = 0u32;
            let mut exit = None;
            let mut failure = None;
            while let Some(event) = events.recv().await {
                let line = match event {
                    ProcEvent::Line(Line::Text(line)) => line,
                    ProcEvent::Line(Line::Oversized(bytes)) => {
                        skipped += 1;
                        if skipped <= LOGGED_SKIPS {
                            eprintln!("acp: skipped an agent line of {bytes} bytes (over the cap)");
                        }
                        continue;
                    }
                    ProcEvent::Exited(info) => {
                        exit = Some(info);
                        break;
                    }
                };
                if let Some(error) = signal.and_then(|signal| signal(&line)) {
                    failure = Some(error);
                    break;
                }
                let Some(frame) = Inbound::parse(&line) else {
                    skipped += 1;
                    if skipped <= LOGGED_SKIPS {
                        eprintln!("acp: skipped a line that is not JSON-RPC");
                    }
                    continue;
                };
                let forward = match frame {
                    Inbound::Response { id, result } => {
                        let (reply, ordered) = {
                            let mut pending = crate::lock(&routed);
                            (pending.waiting.remove(&id), pending.ordered.remove(&id))
                        };
                        if let Some(reply) = reply {
                            let _ = reply.send(result.map_err(CallError::Rpc));
                            continue;
                        }
                        if !ordered {
                            continue;
                        }
                        Incoming::Reply {
                            id,
                            result: result.map_err(CallError::Rpc),
                        }
                    }
                    Inbound::Request { id, method, params } => {
                        Incoming::Request { id, method, params }
                    }
                    Inbound::Notification { method, params } => {
                        Incoming::Notification { method, params }
                    }
                };
                if incoming_tx.send(forward).await.is_err() {
                    break;
                }
            }
            let waiting = {
                let mut pending = crate::lock(&routed);
                pending.closed = true;
                pending.failure = failure.clone();
                pending.ordered.clear();
                std::mem::take(&mut pending.waiting)
            };
            let error = failure
                .clone()
                .map_or(CallError::Closed, CallError::Provider);
            for (_, reply) in waiting {
                let _ = reply.send(Err(error.clone()));
            }
            let _ = incoming_tx.send(Incoming::Closed { exit, failure }).await;
        });
        (
            Self {
                writer,
                pending,
                incoming: barrier_tx,
            },
            incoming,
        )
    }

    /// The failure that ended the connection ([`Signal`]), once the reader has recorded it.
    pub(crate) fn failure(&self) -> Option<conn_provider::ProviderError> {
        crate::lock(&self.pending).failure.clone()
    }

    /// Sends a request and waits for its reply.
    pub(crate) async fn call(&self, method: &str, params: J) -> Result<Value, CallError> {
        let (tx, rx) = oneshot::channel();
        let id = {
            let mut pending = crate::lock(&self.pending);
            if pending.closed {
                return Err(pending.closed_error());
            }
            let id = pending.next_id;
            pending.next_id += 1;
            pending.waiting.insert(id, tx);
            id
        };
        // Frees the id when the call ends, also when its caller stops waiting.
        let _waiting = Waiting {
            pending: &self.pending,
            id,
        };
        if self
            .writer
            .send(protocol::request(id, method, params))
            .await
            .is_err()
        {
            return Err(crate::lock(&self.pending).closed_error());
        }
        match rx.await {
            Ok(result) => result,
            Err(_) => Err(crate::lock(&self.pending).closed_error()),
        }
    }

    /// Sends a request whose reply arrives as [`Incoming::Reply`]. `None` when closed.
    pub(crate) async fn send(&self, method: &str, params: J) -> Option<i64> {
        let id = {
            let mut pending = crate::lock(&self.pending);
            if pending.closed {
                return None;
            }
            let id = pending.next_id;
            pending.next_id += 1;
            pending.ordered.insert(id);
            id
        };
        if self
            .writer
            .send(protocol::request(id, method, params))
            .await
            .is_err()
        {
            crate::lock(&self.pending).ordered.remove(&id);
            return None;
        }
        Some(id)
    }

    /// Resolves once the reader of the incoming channel has handled everything forwarded so
    /// far (T3's `drainEvents` barrier), or right away when the connection is gone.
    pub(crate) async fn barrier(&self) {
        let (done_tx, done) = oneshot::channel();
        if self.incoming.send(Incoming::Barrier(done_tx)).await.is_ok() {
            let _ = done.await;
        }
    }

    pub(crate) async fn notify(&self, method: &str, params: J) -> bool {
        self.writer
            .send(protocol::notification(method, params))
            .await
            .is_ok()
    }

    pub(crate) async fn reply(&self, id: &RequestId, result: J) -> bool {
        self.writer
            .send(protocol::response(id, result))
            .await
            .is_ok()
    }

    pub(crate) async fn reply_error(&self, id: &RequestId, code: i64, message: &str) -> bool {
        self.writer
            .send(protocol::error_response(id, code, message))
            .await
            .is_ok()
    }
}

#[cfg(test)]
mod waiting_tests {
    use super::*;

    /// Finding 9: a call whose caller stops waiting leaves no id in `waiting`.
    #[tokio::test(flavor = "current_thread")]
    async fn a_cancelled_call_frees_its_id() {
        let (writer, mut written) = mpsc::channel(4);
        let (_events_tx, events) = mpsc::channel(4);
        let (connection, _incoming) = Connection::start(writer, events, 4);
        let call = {
            let connection = connection.clone();
            tokio::spawn(async move {
                connection
                    .call("session/prompt", J::V(serde_json::Value::Null))
                    .await
            })
        };
        assert!(written.recv().await.is_some(), "the request went out");
        assert_eq!(crate::lock(&connection.pending).waiting.len(), 1);
        call.abort();
        assert!(call.await.is_err(), "cancelled");
        assert!(crate::lock(&connection.pending).waiting.is_empty());
    }

    /// T3's `drainEvents`: the barrier resolves only after the reader of the incoming channel
    /// handled what the agent sent before it.
    #[tokio::test(flavor = "current_thread")]
    async fn a_barrier_waits_for_the_updates_before_it() {
        let (writer, _written) = mpsc::channel(4);
        let (events_tx, events) = mpsc::channel(4);
        let (connection, mut incoming) = Connection::start(writer, events, 4);
        let update = r#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#;
        events_tx
            .send(ProcEvent::Line(Line::Text(update.into())))
            .await
            .unwrap();
        while incoming.is_empty() {
            tokio::task::yield_now().await;
        }
        let barrier = tokio::spawn({
            let connection = connection.clone();
            async move { connection.barrier().await }
        });
        tokio::task::yield_now().await;
        assert!(!barrier.is_finished(), "nothing was handled yet");
        assert!(matches!(
            incoming.recv().await,
            Some(Incoming::Notification { .. })
        ));
        assert!(!barrier.is_finished(), "the barrier is not handled yet");
        let Some(Incoming::Barrier(done)) = incoming.recv().await else {
            panic!("the barrier comes after the update");
        };
        done.send(()).unwrap();
        barrier.await.unwrap();
    }

    fn sign_in(line: &str) -> Option<conn_provider::ProviderError> {
        (line == "SIGN IN").then(|| conn_provider::ProviderError::Failed {
            operation: "sign-in-required",
            detail: "Sign in".into(),
        })
    }

    /// A signal line right behind a reply: the reply still answers its call, and every later
    /// call fails with the signal's error, not as a plain close.
    #[tokio::test(flavor = "current_thread")]
    async fn a_signal_behind_a_reply_fails_later_calls() {
        let (writer, mut written) = mpsc::channel(4);
        let (events_tx, events) = mpsc::channel(4);
        let (connection, _incoming) =
            Connection::start_with_signal(writer, events, 4, Some(sign_in));
        let call = tokio::spawn({
            let connection = connection.clone();
            async move { connection.call("initialize", J::V(Value::Null)).await }
        });
        assert!(written.recv().await.is_some(), "the request went out");
        let reply = format!(r#"{{"jsonrpc":"2.0","id":{FIRST_REQUEST_ID},"result":{{}}}}"#);
        for line in [reply.as_str(), "SIGN IN"] {
            events_tx
                .send(ProcEvent::Line(Line::Text(line.into())))
                .await
                .unwrap();
        }
        assert_eq!(call.await.unwrap(), Ok(serde_json::json!({})));
        while !crate::lock(&connection.pending).closed {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            connection.call("authenticate", J::V(Value::Null)).await,
            Err(CallError::Provider(sign_in("SIGN IN").unwrap()))
        );
    }
}
