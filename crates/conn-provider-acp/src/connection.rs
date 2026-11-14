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
    Closed(Option<ExitInfo>),
}

/// Why a request got no result.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum CallError {
    Rpc(RpcError),
    /// The agent exited or closed stdout before it replied.
    Closed,
}

impl CallError {
    pub(crate) fn detail(&self) -> String {
        match self {
            Self::Rpc(error) => error.message.clone(),
            Self::Closed => "the agent process exited".into(),
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
}

/// The writing half; cheap to clone.
#[derive(Clone)]
pub(crate) struct Connection {
    writer: mpsc::Sender<String>,
    pending: Arc<Mutex<Pending>>,
}

impl std::fmt::Debug for Connection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Connection").finish_non_exhaustive()
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
        mut events: mpsc::Receiver<ProcEvent>,
        capacity: usize,
    ) -> (Self, mpsc::Receiver<Incoming>) {
        let pending = Arc::new(Mutex::new(Pending {
            next_id: FIRST_REQUEST_ID,
            ..Pending::default()
        }));
        let (incoming_tx, incoming) = mpsc::channel(capacity);
        let routed = pending.clone();
        tokio::spawn(async move {
            let mut skipped = 0u32;
            let mut exit = None;
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
                pending.ordered.clear();
                std::mem::take(&mut pending.waiting)
            };
            for (_, reply) in waiting {
                let _ = reply.send(Err(CallError::Closed));
            }
            let _ = incoming_tx.send(Incoming::Closed(exit)).await;
        });
        (Self { writer, pending }, incoming)
    }

    /// Sends a request and waits for its reply.
    pub(crate) async fn call(&self, method: &str, params: J) -> Result<Value, CallError> {
        let (tx, rx) = oneshot::channel();
        let id = {
            let mut pending = crate::lock(&self.pending);
            if pending.closed {
                return Err(CallError::Closed);
            }
            let id = pending.next_id;
            pending.next_id += 1;
            pending.waiting.insert(id, tx);
            id
        };
        if self
            .writer
            .send(protocol::request(id, method, params))
            .await
            .is_err()
        {
            crate::lock(&self.pending).waiting.remove(&id);
            return Err(CallError::Closed);
        }
        rx.await.unwrap_or(Err(CallError::Closed))
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
