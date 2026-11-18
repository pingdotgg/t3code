//! One `/ws` connection: Effect RPC over WebSocket, as `RpcServer.make` runs it with T3's
//! socket protocol (`apps/server/src/ws.ts`).
//!
//! One loop owns the socket and the table of in-flight calls. Each call runs in its own task
//! and hands encoded frames back to the loop over one bounded channel, so a slow socket
//! stalls producers instead of buffering. Streams also wait for the client's `Ack`s
//! ([`Window`]): a slow client holds at most a window of chunks, never a growing queue.

use std::{
    collections::HashMap,
    collections::VecDeque,
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use conn_wire::{
    Exit, FromClient, FromServer, Request, RequestId, ack_window, ack_window::Window,
    decode_client_message, encode_server_frame, error_defect, frame_parts,
};
use serde_json::Value;
use tokio::{sync::mpsc, task::AbortHandle, time::Instant};

use crate::table::{CallContext, Failure, Handler, ItemStream, MethodTable, not_supported_exit};

/// Frames waiting for the socket, across all calls of one connection.
const OUTBOX: usize = 16;
/// Most values sent in one `Chunk`.
const MAX_CHUNK_VALUES: usize = 64;

pub const CLOSE_NORMAL: u16 = 1000;
pub const CLOSE_GOING_AWAY: u16 = 1001;
pub const CLOSE_TOO_LARGE: u16 = 1009;
/// The managed gate closed: the caller's grant was fenced, its token expired, or managed
/// authority was lost.
pub const CLOSE_POLICY: u16 = 1008;

/// What a gate allows now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateState {
    Open,
    /// Hold every dispatch and every frame; the session stays.
    Paused,
    /// End the session.
    Closed,
}

/// A check the session runs at every inbound dispatch and every outbound frame part, and a
/// signal that ends the session at once. Managed access (`managed/`) is the one gate today.
pub trait Gate: Send + Sync {
    fn state(&self) -> GateState;
    /// Resolves when the session must end.
    fn closed(&self) -> futures_core::future::BoxFuture<'static, ()>;
    /// Resolves when the state may have changed; a paused session looks again then.
    fn changed(&self) -> futures_core::future::BoxFuture<'static, ()>;
    fn open(&self) -> bool {
        self.state() == GateState::Open
    }
}

/// Waits while the gate is paused. `false` once it closed: the session must end.
pub async fn pass(gate: Option<&SessionGate>) -> bool {
    let Some(gate) = gate else {
        return true;
    };
    loop {
        match gate.0.state() {
            GateState::Open => return true,
            GateState::Closed => return false,
            GateState::Paused => {
                tokio::select! {
                    () = gate.0.changed() => {}
                    () = gate.0.closed() => return false,
                }
            }
        }
    }
}

/// Sends `text` only while the gate passes, checking before each part, and gives up the
/// moment it closes, even inside a stalled write. `false`: the socket must be dropped.
async fn write_gated<T: Transport>(
    socket: &mut T,
    text: String,
    frame_parts: bool,
    gate: Option<&SessionGate>,
) -> bool {
    let Some(gate) = gate else {
        return write(socket, text, frame_parts).await;
    };
    let parts: Vec<String> = if !frame_parts || text.len() <= frame_parts::PART_BYTES {
        vec![text]
    } else {
        frame_parts::split(&text, frame_parts::PART_BYTES)
    };
    for part in parts {
        if !pass(Some(gate)).await {
            return false;
        }
        let closed = gate.0.closed();
        tokio::select! {
            biased;
            () = closed => return false,
            sent = socket.send(part) => if !sent { return false },
        }
    }
    true
}

/// Closes the socket. With a gate, the close write is bounded and gives way to a fence: a
/// stalled peer cannot keep a fenced session registered.
async fn end<T: Transport>(
    socket: &mut T,
    code: u16,
    reason: &'static str,
    gate: Option<&SessionGate>,
) {
    let Some(gate) = gate else {
        socket.close(code, reason).await;
        return;
    };
    let closed = gate.0.closed();
    tokio::select! {
        biased;
        () = closed => {}
        _ = tokio::time::timeout(Duration::from_millis(100), socket.close(code, reason)) => {}
    }
}

/// Ends a session whose gate closed: a close frame if the socket takes it at once, else the
/// socket is just dropped, so nothing buffered for it can still be sent.
async fn revoke<T: Transport>(socket: &mut T) {
    let _ = tokio::time::timeout(
        Duration::from_millis(100),
        socket.close(CLOSE_POLICY, "access revoked"),
    )
    .await;
}

/// The gate of one session. Holding it keeps the managed handler registered; the session
/// drops it when it ends.
#[derive(Clone)]
pub struct SessionGate(pub Arc<dyn Gate>);

impl std::fmt::Debug for SessionGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SessionGate")
    }
}

#[derive(Clone, Debug)]
pub struct SessionOptions {
    /// Split large messages into parts (`/ws?frameParts`).
    pub frame_parts: bool,
    /// Largest client message accepted, joined from parts or whole.
    pub max_message_bytes: usize,
    /// Close a connection that sends nothing for this long. Conn pings every 5 s.
    pub idle_timeout: Duration,
    /// Passed to every handler.
    pub context: CallContext,
    /// Checked before every dispatch and every frame; its close ends the session.
    pub gate: Option<SessionGate>,
}

impl Default for SessionOptions {
    fn default() -> Self {
        Self {
            frame_parts: false,
            max_message_bytes: 16 * 1024 * 1024,
            idle_timeout: Duration::from_secs(60),
            context: CallContext::default(),
            gate: None,
        }
    }
}

/// What the session reads from the socket.
#[derive(Debug)]
pub enum Incoming {
    Text(String),
    /// A message larger than the socket allows.
    TooLarge,
    Closed,
}

/// The socket as the session needs it. Tests drive the session through channels.
pub trait Transport: Send {
    fn recv(&mut self) -> impl Future<Output = Incoming> + Send;
    /// `false` once the peer is gone.
    fn send(&mut self, text: String) -> impl Future<Output = bool> + Send;
    fn close(&mut self, code: u16, reason: &'static str) -> impl Future<Output = ()> + Send;
}

impl Transport for WebSocket {
    async fn recv(&mut self) -> Incoming {
        loop {
            return match WebSocket::recv(self).await {
                Some(Ok(Message::Text(text))) => Incoming::Text(text.as_str().to_owned()),
                // JSON serialization never sends binary; axum answers pings itself.
                Some(Ok(Message::Binary(_) | Message::Ping(_) | Message::Pong(_))) => continue,
                Some(Ok(Message::Close(_))) | None => Incoming::Closed,
                // axum hides tungstenite's error type; its capacity error reads like this.
                Some(Err(error)) if error.to_string().contains("too long") => Incoming::TooLarge,
                Some(Err(_)) => Incoming::Closed,
            };
        }
    }

    async fn send(&mut self, text: String) -> bool {
        WebSocket::send(self, Message::Text(text.into()))
            .await
            .is_ok()
    }

    async fn close(&mut self, code: u16, reason: &'static str) {
        let frame = CloseFrame {
            code,
            reason: reason.into(),
        };
        let _ = WebSocket::send(self, Message::Close(Some(frame))).await;
    }
}

/// A frame from a call task to the loop.
#[derive(Debug)]
enum Out {
    Chunk {
        id: RequestId,
        text: String,
    },
    Exit {
        id: RequestId,
        text: String,
    },
    /// A silent call (notification or discard) finished.
    Done {
        id: RequestId,
    },
}

struct Call {
    task: AbortHandle,
    acks: Option<mpsc::Sender<()>>,
    /// Notifications and acknowledged discards get no further reply.
    silent: bool,
}

/// In-flight calls. Dropping it stops them, so a disconnect ends every stream and the
/// handlers see their item receivers dropped.
#[derive(Default)]
struct Calls(HashMap<RequestId, Call>);

impl Drop for Calls {
    fn drop(&mut self) {
        for call in self.0.values() {
            call.task.abort();
        }
    }
}

/// The id of the next connection. Starts at 1 so zero stays "no session".
fn next_connection_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Runs one connection until the client leaves, ends with `Eof`, or goes idle. Every call
/// gets `options.context` with this connection's id.
pub async fn run<T: Transport>(mut socket: T, table: Arc<MethodTable>, options: SessionOptions) {
    let context = CallContext {
        connection_id: next_connection_id(),
        ..options.context.clone()
    };
    struct Disconnect(Arc<MethodTable>, u64);
    impl Drop for Disconnect {
        fn drop(&mut self) {
            self.0.disconnect(self.1);
        }
    }
    let _disconnect = Disconnect(table.clone(), context.connection_id);
    let (outbox, mut out) = mpsc::channel::<Out>(OUTBOX);
    let mut calls = Calls::default();
    let mut joiner = frame_parts::Joiner::new(options.max_message_bytes);
    let mut ended = false;
    let idle = tokio::time::sleep(options.idle_timeout);
    tokio::pin!(idle);
    let gate = options.gate.clone();
    let gate_closed = match &gate {
        Some(gate) => gate.0.closed(),
        None => Box::pin(std::future::pending()),
    };
    tokio::pin!(gate_closed);

    loop {
        if !pass(gate.as_ref()).await {
            // Calls drop with `calls`: their tasks abort and their queued frames go unsent.
            revoke(&mut socket).await;
            return;
        }
        if ended && calls.0.is_empty() {
            end(&mut socket, CLOSE_NORMAL, "", gate.as_ref()).await;
            return;
        }
        tokio::select! {
            Some(frame) = out.recv() => {
                let text = match frame {
                    // A call that was interrupted may still have frames queued: drop them.
                    Out::Chunk { id, text } if calls.0.contains_key(&id) => text,
                    Out::Exit { id, text } if calls.0.remove(&id).is_some() => text,
                    Out::Done { id } => {
                        calls.0.remove(&id);
                        continue;
                    }
                    _ => continue,
                };
                if !write_gated(&mut socket, text, options.frame_parts, gate.as_ref()).await {
                    return;
                }
            }
            incoming = socket.recv() => {
                idle.as_mut().reset(Instant::now() + options.idle_timeout);
                let text = match incoming {
                    Incoming::Text(text) => text,
                    Incoming::TooLarge => {
                        end(&mut socket, CLOSE_TOO_LARGE, "message too large", gate.as_ref()).await;
                        return;
                    }
                    Incoming::Closed => return,
                };
                let text = match joiner.push(&text) {
                    Ok(Some(text)) => text,
                    Ok(None) => continue,
                    Err(frame_parts::TooLarge) => {
                        end(&mut socket, CLOSE_TOO_LARGE, "message too large", gate.as_ref()).await;
                        return;
                    }
                };
                let frames = match decode_client_message(&text) {
                    Ok(frames) => frames,
                    Err(error) => {
                        // Effect answers an undecodable message with a connection Defect.
                        let defect = error_defect("ConnServerProtocolError", format!("invalid message: {error}"));
                        if !write_gated(&mut socket, encode_server_frame(&FromServer::Defect { defect }), options.frame_parts, gate.as_ref()).await {
                            return;
                        }
                        continue;
                    }
                };
                for frame in frames {
                    let reply = match frame {
                        FromClient::Ping => Some(FromServer::Pong),
                        FromClient::Eof => {
                            ended = true;
                            None
                        }
                        FromClient::Ack { request_id } => {
                            if let Some(acks) = calls.0.get(&request_id).and_then(|c| c.acks.as_ref()) {
                                let _ = acks.try_send(());
                            }
                            None
                        }
                        FromClient::Interrupt { request_id } => match calls.0.remove(&request_id) {
                            Some(call) => {
                                call.task.abort();
                                (!call.silent).then(|| exit_frame(&request_id, Exit::interrupt()))
                            }
                            // Effect answers an unknown id with an interrupt exit too.
                            None => Some(exit_frame(&request_id, Exit::interrupt())),
                        },
                        // Effect ignores requests after `Eof` and duplicates of a live id.
                        FromClient::Request(request) if ended || calls.0.contains_key(&request.id) => None,
                        FromClient::Request(request) => {
                            if !pass(gate.as_ref()).await {
                                revoke(&mut socket).await;
                                return;
                            }
                            start(request, &table, &context, &outbox, &mut calls, gate.as_ref())
                        }
                    };
                    if let Some(reply) = reply
                        && !write_gated(&mut socket, encode_server_frame(&reply), options.frame_parts, gate.as_ref()).await
                    {
                        return;
                    }
                }
            }
            _ = &mut idle => {
                end(&mut socket, CLOSE_GOING_AWAY, "idle", gate.as_ref()).await;
                return;
            }
            () = &mut gate_closed => {
                revoke(&mut socket).await;
                return;
            }
        }
    }
}

/// Starts a call. Returns a frame to send at once, if any.
fn start(
    request: Request,
    table: &MethodTable,
    context: &CallContext,
    outbox: &mpsc::Sender<Out>,
    calls: &mut Calls,
    gate: Option<&SessionGate>,
) -> Option<FromServer> {
    // Each call task holds the gate: the managed handler stays registered until the task
    // itself has ended, not just been asked to abort.
    let gate = gate.cloned();
    let Request {
        id,
        tag,
        payload,
        headers,
        is_notification,
        discard,
        ..
    } = request;
    let notification = is_notification == Some(true);
    let discard = !notification && discard == Some(true);
    let Some(handler) = table.get(&tag).cloned() else {
        return (!notification).then(|| exit_frame(&id, not_supported_exit(&tag)));
    };
    let silent = notification || discard;
    let mut ctx = context.clone();
    // Effect puts the upgrade headers first, then the request's own.
    ctx.headers.extend(headers);
    let outbox = outbox.clone();
    let (task, acks) = match handler {
        Handler::Unary(handler) => {
            let task_id = id.clone();
            let task = tokio::spawn(async move {
                let _gate = gate;
                let result = handler(ctx, payload).await;
                let _ = outbox.send(finish(task_id, silent, result)).await;
            });
            (task, None)
        }
        Handler::Stream(handler) => {
            let (ack_tx, ack_rx) = mpsc::channel(ack_window::MAX_PENDING_CHUNKS);
            let window = Window::for_tag(&tag);
            let task_id = id.clone();
            let task = tokio::spawn(async move {
                let _gate = gate;
                let result = match handler(ctx, payload).await {
                    Ok(items) => {
                        let acks = (!silent).then_some(ack_rx);
                        match stream(&task_id, items, &outbox, acks, window).await {
                            // A stream's exit carries `Schema.Void`; the client accepts null.
                            None => Ok(Value::Null),
                            Some(failure) => Err(failure),
                        }
                    }
                    Err(failure) => Err(failure),
                };
                let _ = outbox.send(finish(task_id, silent, result)).await;
            });
            (task, (!silent).then_some(ack_tx))
        }
    };
    let task = task.abort_handle();
    calls.0.insert(id.clone(), Call { task, acks, silent });
    // A discarded call is acknowledged once its handler starts, then never answered again.
    discard.then(|| exit_frame(&id, Exit::success(Value::Null)))
}

/// The last frame of a call.
fn finish(id: RequestId, silent: bool, result: Result<Value, Failure>) -> Out {
    if silent {
        return Out::Done { id };
    }
    let exit = result.map_or_else(Failure::into_exit, Exit::success);
    let text = encode_server_frame(&exit_frame(&id, exit));
    Out::Exit { id, text }
}

/// Sends a stream's items as chunks within the ack window. Returns the failure that ended
/// it, or `None` when the stream completed. A silent stream has no `acks` and sends nothing.
async fn stream(
    id: &RequestId,
    mut items: ItemStream,
    outbox: &mpsc::Sender<Out>,
    mut acks: Option<mpsc::Receiver<()>>,
    window: Window,
) -> Option<Failure> {
    let mut pending: VecDeque<usize> = VecDeque::new();
    // A value taken from `items` that did not fit the last chunk's byte budget.
    let mut held: Option<Value> = None;
    loop {
        if let Some(acks) = acks.as_mut() {
            while acks.try_recv().is_ok() {
                pending.pop_front();
            }
            while window.is_full(&pending) {
                // The loop drops the sender when the call ends; then nothing more is sent.
                acks.recv().await?;
                pending.pop_front();
            }
        }
        let first = match held.take() {
            Some(value) => value,
            None => match items.recv().await {
                None => return None,
                Some(Err(failure)) => return Some(failure),
                Some(Ok(value)) => value,
            },
        };
        // A byte-windowed chunk holds at most `MAX_PENDING_BYTES` of events, by T3's charge,
        // unless one event alone is larger (`takeBatch` in `OutputProtocol.ts`).
        let mut bytes = ack_window::queued_size(&first);
        let mut values = vec![first];
        let mut failure = None;
        while values.len() < MAX_CHUNK_VALUES {
            match items.try_recv() {
                Ok(Ok(value)) => {
                    if window == Window::Bytes {
                        let size = ack_window::queued_size(&value);
                        if bytes + size > ack_window::MAX_PENDING_BYTES {
                            held = Some(value);
                            break;
                        }
                        bytes += size;
                    }
                    values.push(value);
                }
                Ok(Err(error)) => {
                    failure = Some(error);
                    break;
                }
                Err(_) => break,
            }
        }
        if acks.is_some() {
            // T3 charges a byte-windowed chunk by its events (`chunkSize`), not its encoding.
            let size = (window == Window::Bytes).then(|| ack_window::chunk_size(&values));
            let text = encode_server_frame(&FromServer::Chunk {
                request_id: id.clone(),
                values,
            });
            pending.push_back(size.unwrap_or(text.len()));
            let chunk = Out::Chunk {
                id: id.clone(),
                text,
            };
            if outbox.send(chunk).await.is_err() {
                return None;
            }
        }
        if failure.is_some() {
            return failure;
        }
    }
}

fn exit_frame(id: &RequestId, exit: Exit) -> FromServer {
    FromServer::Exit {
        request_id: id.clone(),
        exit,
    }
}

async fn write<T: Transport>(socket: &mut T, text: String, frame_parts: bool) -> bool {
    if !frame_parts || text.len() <= frame_parts::PART_BYTES {
        return socket.send(text).await;
    }
    for part in frame_parts::split(&text, frame_parts::PART_BYTES) {
        if !socket.send(part).await {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests;
