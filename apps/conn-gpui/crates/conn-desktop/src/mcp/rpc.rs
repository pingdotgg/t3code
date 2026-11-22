//! JSON-RPC 2.0 over a transport: request ids, pending answers, timeouts, and the dispatcher
//! that logs every inbound message and answers the server's own requests.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Mutex, PoisonError, Weak};
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};

use super::events::Emitter;
use super::transport::{Inbound, Transport};
use super::types::McpEventKind;

/// The SDK's `ConnectionClosed` error, for requests the closing session leaves unanswered.
pub(crate) const CONNECTION_CLOSED: &str = "MCP error -32000: Connection closed";
const REQUEST_TIMED_OUT: &str = "MCP error -32001: Request timed out";
const METHOD_NOT_FOUND: i64 = -32_601;

type Answer = Result<Value, String>;

/// One session's JSON-RPC client.
#[derive(Debug)]
pub(crate) struct Rpc {
    pub(crate) transport: Transport,
    emitter: Emitter,
    pending: Mutex<HashMap<i64, oneshot::Sender<Answer>>>,
    next_id: AtomicI64,
    closed: AtomicBool,
}

impl Rpc {
    pub(crate) fn new(transport: Transport, emitter: Emitter) -> Self {
        Self {
            transport,
            emitter,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicI64::new(0),
            closed: AtomicBool::new(false),
        }
    }

    pub(crate) fn emitter(&self) -> &Emitter {
        &self.emitter
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<i64, oneshot::Sender<Answer>>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Logs the message as sent, then writes it.
    async fn send(&self, message: Value) -> Result<(), String> {
        if self.is_closed() {
            return Err("Not connected".into());
        }
        self.emitter
            .emit(McpEventKind::Send {
                message: message.clone(),
            })
            .await;
        self.transport.send(&message).await
    }

    /// Sends a request and waits up to `timeout` for its answer.
    pub(crate) async fn request(
        &self,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending().insert(id, tx);
        let mut message = Map::new();
        message.insert("jsonrpc".into(), json!("2.0"));
        message.insert("id".into(), json!(id));
        message.insert("method".into(), json!(method));
        if let Some(params) = params {
            message.insert("params".into(), params);
        }
        if let Err(error) = self.send(Value::Object(message)).await {
            self.pending().remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err(CONNECTION_CLOSED.into()),
            Err(_) => {
                self.pending().remove(&id);
                let _ = self
                    .notify(
                        "notifications/cancelled",
                        Some(json!({ "requestId": id, "reason": REQUEST_TIMED_OUT })),
                    )
                    .await;
                Err(REQUEST_TIMED_OUT.into())
            }
        }
    }

    pub(crate) async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), String> {
        let mut message = Map::new();
        message.insert("jsonrpc".into(), json!("2.0"));
        message.insert("method".into(), json!(method));
        if let Some(params) = params {
            message.insert("params".into(), params);
        }
        self.send(Value::Object(message)).await
    }

    /// Marks the session closed and fails every unanswered request.
    pub(crate) fn fail_pending(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.pending().clear();
    }

    async fn receive(&self, message: Value) {
        self.emitter
            .emit(McpEventKind::Receive {
                message: message.clone(),
            })
            .await;
        let method = message.get("method").and_then(Value::as_str);
        let id = message.get("id").filter(|id| !id.is_null());
        match (method, id) {
            (None, Some(id)) => {
                let Some(id) = id.as_i64() else { return };
                let Some(tx) = self.pending().remove(&id) else {
                    return;
                };
                let answer = match message.get("error") {
                    Some(error) => Err(rpc_error_text(error)),
                    None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = tx.send(answer);
            }
            (Some(method), Some(id)) => {
                // The panel offers no client features; it answers pings only.
                let reply = if method == "ping" {
                    json!({ "jsonrpc": "2.0", "id": id, "result": {} })
                } else {
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": METHOD_NOT_FOUND, "message": "Method not found" }
                    })
                };
                let _ = self.send(reply).await;
            }
            _ => {}
        }
    }
}

/// `MCP error <code>: <message>`, as the SDK's `McpError` reads.
fn rpc_error_text(error: &Value) -> String {
    let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Unknown error");
    format!("MCP error {code}: {message}")
}

/// Reads inbound messages until the transport closes, then fails pending requests and calls
/// `on_close`. Holds the client weakly, so dropping the session drops the transport.
pub(crate) async fn dispatch(
    rpc: Weak<Rpc>,
    mut inbound: mpsc::UnboundedReceiver<Inbound>,
    on_close: impl FnOnce(),
) {
    while let Some(Inbound::Message(message)) = inbound.recv().await {
        let Some(rpc) = rpc.upgrade() else { return };
        rpc.receive(message).await;
    }
    if let Some(rpc) = rpc.upgrade() {
        rpc.fail_pending();
        on_close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_errors_like_the_sdk() {
        assert_eq!(
            rpc_error_text(&json!({"code": -32602, "message": "Unknown tool: x"})),
            "MCP error -32602: Unknown tool: x",
            "error text"
        );
    }
}
