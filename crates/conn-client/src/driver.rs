use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use conn_contract::{
    AnnotationList, AnnotationProjectInput, OrchestrationV2ShellStreamItem,
    OrchestrationV2SubscribeShellInput, OrchestrationV2SubscribeThreadInput,
    OrchestrationV2ThreadStreamItem, ServerConfigStreamEvent, SubscribeServerConfigPayload,
    source::DesktopPanelSubscription,
};
use conn_wire::{Exit, FromClient, FromServer, Request, RequestId, frame_parts};
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use serde_json::value::RawValue;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, MissedTickBehavior};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tracing::{debug, warn};

use crate::auth::{TokenExchangeError, exchange_pairing_code};
use crate::wire::{
    Backoff, IncomingServerFrame, MAX_JOINED_MESSAGE_BYTES, build_ws_url,
    decode_server_message_raw, decode_thread_stream_item, encode_client_frame,
    extract_shell_sequence, extract_thread_sequence,
};
use crate::{ClientError, ClientEvent, ConnectionStatus, Credential, ServerConfig, StreamId};

const TAG_SUBSCRIBE_SHELL: &str = "orchestration.subscribeShell";
const TAG_SUBSCRIBE_THREAD: &str = "orchestration.subscribeThread";
const TAG_PANELS_REQUESTS: &str = "panels.requests";
const TAG_ANNOTATIONS_SUBSCRIBE: &str = "annotations.subscribe";
const TAG_SUBSCRIBE_SERVER_CONFIG: &str = "subscribeServerConfig";
const PING_INTERVAL: Duration = Duration::from_secs(5);
const MAX_MISSED_PONGS: u8 = 2;

pub(crate) enum Command {
    SubscribeShell {
        include_idle_subagents: bool,
    },
    SubscribeServerConfig,
    SubscribeThread(String),
    RefreshThread(String),
    UnsubscribeThread(String),
    SubscribePanelRequests(DesktopPanelSubscription),
    UnsubscribePanelRequests,
    SubscribeAnnotations(String),
    UnsubscribeAnnotations(String),
    Call {
        tag: String,
        payload: Value,
        reply: oneshot::Sender<Result<Value, ClientError>>,
    },
    StartStream {
        stream_id: StreamId,
        tag: String,
        payload: Value,
        tx: mpsc::Sender<Value>,
    },
    CancelStream(StreamId),
    Reconnect,
    Close,
}

struct ThreadSubState {
    after_sequence: Option<i64>,
    request_id: Option<RequestId>,
    /// When the current `subscribeThread` request went out (for `CONN_GPUI_PERF_LOG`).
    subscribed_at: Option<std::time::Instant>,
}

enum ActiveStream {
    Shell,
    ServerConfig,
    Thread(String),
    PanelRequests,
    Annotations(String),
    Generic {
        stream_id: StreamId,
        tx: mpsc::Sender<Value>,
    },
}

struct PendingCall {
    tag: String,
    payload: Value,
    reply: oneshot::Sender<Result<Value, ClientError>>,
}

struct PendingStream {
    stream_id: StreamId,
    tag: String,
    payload: Value,
    tx: mpsc::Sender<Value>,
}

struct DriverState {
    config: ServerConfig,
    shared_bearer: Arc<RwLock<Option<String>>>,
    http: reqwest::Client,
    backoff: Backoff,
    next_request_id: i64,
    shell_subscribed: bool,
    include_idle_subagents: bool,
    shell_after_sequence: Option<i64>,
    shell_request_id: Option<RequestId>,
    server_config_subscribed: bool,
    server_config_request_id: Option<RequestId>,
    thread_subs: HashMap<String, ThreadSubState>,
    /// Last observed stream sequence per thread, preserved across `UnsubscribeThread` ->
    /// `SubscribeThread` so switching back replays deltas instead of re-downloading a snapshot.
    thread_last_sequences: HashMap<String, i64>,
    panel_subscription: Option<DesktopPanelSubscription>,
    panel_request_id: Option<RequestId>,
    annotation_subs: HashMap<String, Option<RequestId>>,
    pending_calls: Vec<PendingCall>,
    pending_streams: Vec<PendingStream>,
    in_flight_unary: HashMap<RequestId, oneshot::Sender<Result<Value, ClientError>>>,
    in_flight_streams: HashMap<RequestId, ActiveStream>,
    generic_stream_ids: HashMap<StreamId, RequestId>,
    closed: bool,
}

impl DriverState {
    fn new(
        config: ServerConfig,
        shared_bearer: Arc<RwLock<Option<String>>>,
        http: reqwest::Client,
    ) -> Self {
        Self {
            config,
            shared_bearer,
            http,
            backoff: Backoff::new(),
            next_request_id: 1,
            shell_subscribed: false,
            include_idle_subagents: false,
            shell_after_sequence: None,
            shell_request_id: None,
            server_config_subscribed: false,
            server_config_request_id: None,
            thread_subs: HashMap::new(),
            thread_last_sequences: HashMap::new(),
            panel_subscription: None,
            panel_request_id: None,
            annotation_subs: HashMap::new(),
            pending_calls: Vec::new(),
            pending_streams: Vec::new(),
            in_flight_unary: HashMap::new(),
            in_flight_streams: HashMap::new(),
            generic_stream_ids: HashMap::new(),
            closed: false,
        }
    }

    fn alloc_request_id(&mut self) -> RequestId {
        let id = self.next_request_id;
        self.next_request_id = self.next_request_id.saturating_add(1);
        RequestId::Number(id)
    }

    fn fail_in_flight_calls(&mut self, reason: &str) {
        for (_, reply) in self.in_flight_unary.drain() {
            let _ = reply.send(Err(ClientError::Connection(reason.to_owned())));
        }
    }

    fn fail_all_calls(&mut self, make_err: impl Fn() -> ClientError) {
        for (_, reply) in self.in_flight_unary.drain() {
            let _ = reply.send(Err(make_err()));
        }
        for pending in self.pending_calls.drain(..) {
            let _ = pending.reply.send(Err(make_err()));
        }
    }

    fn clear_active_streams(&mut self) {
        self.in_flight_streams.clear();
        self.generic_stream_ids.clear();
        self.shell_request_id = None;
        self.server_config_request_id = None;
        self.panel_request_id = None;
        for sub in self.thread_subs.values_mut() {
            sub.request_id = None;
        }
        for req_id in self.annotation_subs.values_mut() {
            *req_id = None;
        }
    }

    fn reset_thread(&mut self, thread_id: &str) -> Option<RequestId> {
        self.thread_last_sequences.remove(thread_id);
        self.thread_subs
            .insert(
                thread_id.to_owned(),
                ThreadSubState {
                    after_sequence: None,
                    request_id: None,
                    subscribed_at: None,
                },
            )
            .and_then(|sub| sub.request_id)
    }

    fn handle_offline_command(&mut self, cmd: Command) {
        match cmd {
            Command::SubscribeShell {
                include_idle_subagents,
            } => {
                self.include_idle_subagents = include_idle_subagents;
                self.shell_subscribed = true;
            }
            Command::SubscribeServerConfig => {
                self.server_config_subscribed = true;
            }
            Command::RefreshThread(thread_id) => {
                self.reset_thread(&thread_id);
            }
            Command::SubscribeThread(thread_id) => {
                let last_seq = self.thread_last_sequences.get(&thread_id).copied();
                self.thread_subs.entry(thread_id).or_insert(ThreadSubState {
                    after_sequence: last_seq,
                    request_id: None,
                    subscribed_at: None,
                });
            }
            Command::UnsubscribeThread(thread_id) => {
                if let Some(sub) = self.thread_subs.remove(&thread_id)
                    && let Some(seq) = sub.after_sequence
                {
                    self.thread_last_sequences.insert(thread_id, seq);
                }
            }
            Command::SubscribePanelRequests(subscription) => {
                self.panel_subscription = Some(subscription);
            }
            Command::UnsubscribePanelRequests => {
                self.panel_subscription = None;
            }
            Command::SubscribeAnnotations(project_id) => {
                self.annotation_subs.entry(project_id).or_insert(None);
            }
            Command::UnsubscribeAnnotations(project_id) => {
                self.annotation_subs.remove(&project_id);
            }
            Command::Call {
                tag,
                payload,
                reply,
            } => {
                self.pending_calls.push(PendingCall {
                    tag,
                    payload,
                    reply,
                });
            }
            Command::StartStream {
                stream_id,
                tag,
                payload,
                tx,
            } => {
                self.pending_streams.push(PendingStream {
                    stream_id,
                    tag,
                    payload,
                    tx,
                });
            }
            Command::CancelStream(stream_id) => {
                self.pending_streams.retain(|s| s.stream_id != stream_id);
            }
            Command::Reconnect => {
                self.backoff.reset();
            }
            Command::Close => {
                self.closed = true;
            }
        }
    }
}

pub(crate) async fn run(
    config: ServerConfig,
    shared_bearer: Arc<RwLock<Option<String>>>,
    http: reqwest::Client,
    mut cmd_rx: mpsc::UnboundedReceiver<Command>,
    events_tx: mpsc::Sender<ClientEvent>,
) {
    let mut state = DriverState::new(config, shared_bearer, http);

    if events_tx
        .send(ClientEvent::Status(ConnectionStatus::Connecting))
        .await
        .is_err()
    {
        return;
    }

    loop {
        drain_pending_commands(&mut state, &mut cmd_rx);
        if state.closed {
            break;
        }

        let token = match resolve_bearer(&mut state, &events_tx).await {
            Ok(token) => token,
            Err(ResolveError::Fatal(msg)) => {
                warn!("conn-client fatal auth failure: {msg}");
                state.fail_all_calls(|| ClientError::Auth(msg.clone()));
                let _ = events_tx
                    .send(ClientEvent::Status(ConnectionStatus::Failed(msg)))
                    .await;
                return;
            }
            Err(ResolveError::Retryable(msg)) => {
                debug!("conn-client retryable auth error: {msg}");
                if !wait_backoff(&mut state, &mut cmd_rx, &events_tx).await {
                    break;
                }
                continue;
            }
        };

        let ws_request = match build_ws_request(&state.config.http_base_url, &token) {
            Ok(req) => req,
            Err(err) => {
                let msg = err.to_string();
                state.fail_all_calls(|| ClientError::Connection(msg.clone()));
                let _ = events_tx
                    .send(ClientEvent::Status(ConnectionStatus::Failed(msg)))
                    .await;
                return;
            }
        };

        let ws_config = WebSocketConfig::default()
            .max_message_size(Some(MAX_JOINED_MESSAGE_BYTES))
            .max_frame_size(Some(MAX_JOINED_MESSAGE_BYTES));

        // `disable_nagle = true` (TCP_NODELAY): every client frame is a small Ack or Request. With
        // Nagle on, a `subscribeThread` sent right after an Ack waits for the server's delayed
        // TCP ACK (up to ~200 ms on macOS) before it leaves the socket.
        match tokio_tungstenite::connect_async_with_config(ws_request, Some(ws_config), true).await
        {
            Ok((ws_stream, _response)) => {
                state.backoff.reset();
                if events_tx
                    .send(ClientEvent::Status(ConnectionStatus::Connected))
                    .await
                    .is_err()
                {
                    break;
                }

                let session_result = run_session(&mut state, ws_stream, &mut cmd_rx, &events_tx);
                let outcome = Box::pin(session_result).await;
                state.fail_in_flight_calls("connection closed");
                state.clear_active_streams();

                match outcome {
                    SessionOutcome::Closed => break,
                    SessionOutcome::ReconnectNow => {
                        state.backoff.reset();
                        if events_tx
                            .send(ClientEvent::Status(ConnectionStatus::Connecting))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        continue;
                    }
                    SessionOutcome::Disconnected(reason) => {
                        debug!("conn-client disconnected: {reason}");
                    }
                }
            }
            Err(err) => {
                debug!("conn-client websocket connect failed: {err}");
            }
        }

        if state.closed {
            break;
        }
        if !wait_backoff(&mut state, &mut cmd_rx, &events_tx).await {
            break;
        }
    }

    state.fail_all_calls(|| ClientError::Closed);
}

enum ResolveError {
    Fatal(String),
    Retryable(String),
}

async fn resolve_bearer(
    state: &mut DriverState,
    events_tx: &mpsc::Sender<ClientEvent>,
) -> Result<String, ResolveError> {
    match &state.config.credential {
        Credential::Bearer(token) => Ok(token.clone()),
        Credential::PairingCode(code) => {
            let code = code.clone();
            match exchange_pairing_code(&state.http, &state.config.http_base_url, &code).await {
                Ok(token) => {
                    state.config.credential = Credential::Bearer(token.clone());
                    if let Ok(mut guard) = state.shared_bearer.write() {
                        *guard = Some(token.clone());
                    }
                    let _ = events_tx
                        .send(ClientEvent::BearerIssued(token.clone()))
                        .await;
                    Ok(token)
                }
                Err(TokenExchangeError::Rejected(msg)) => Err(ResolveError::Fatal(msg)),
                Err(TokenExchangeError::Retryable(msg)) => Err(ResolveError::Retryable(msg)),
            }
        }
    }
}

fn build_ws_request(
    http_base_url: &url::Url,
    bearer_token: &str,
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, ClientError> {
    let ws_url = build_ws_url(http_base_url)?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|err| ClientError::Connection(format!("invalid websocket request: {err}")))?;
    let auth_header = HeaderValue::from_str(&format!("Bearer {bearer_token}"))
        .map_err(|err| ClientError::Auth(format!("invalid bearer token header: {err}")))?;
    request.headers_mut().insert(
        tokio_tungstenite::tungstenite::http::header::AUTHORIZATION,
        auth_header,
    );
    Ok(request)
}

fn drain_pending_commands(state: &mut DriverState, cmd_rx: &mut mpsc::UnboundedReceiver<Command>) {
    while let Ok(cmd) = cmd_rx.try_recv() {
        state.handle_offline_command(cmd);
    }
}

/// Sleeps for the next backoff interval while continuing to accept commands.
/// Returns `false` if the client was closed or the event receiver was dropped.
async fn wait_backoff(
    state: &mut DriverState,
    cmd_rx: &mut mpsc::UnboundedReceiver<Command>,
    events_tx: &mpsc::Sender<ClientEvent>,
) -> bool {
    let (attempt, delay) = state.backoff.next_delay();
    if events_tx
        .send(ClientEvent::Status(ConnectionStatus::Reconnecting {
            attempt,
        }))
        .await
        .is_err()
    {
        return false;
    }

    let sleep = tokio::time::sleep(delay);
    tokio::pin!(sleep);
    loop {
        tokio::select! {
            () = &mut sleep => return true,
            maybe_cmd = cmd_rx.recv() => match maybe_cmd {
                Some(Command::Reconnect) => {
                    state.backoff.reset();
                    return true;
                }
                Some(cmd) => {
                    state.handle_offline_command(cmd);
                    if state.closed {
                        return false;
                    }
                }
                None => {
                    state.closed = true;
                    return false;
                }
            }
        }
    }
}

enum SessionOutcome {
    Closed,
    ReconnectNow,
    Disconnected(String),
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn run_session(
    state: &mut DriverState,
    ws_stream: WsStream,
    cmd_rx: &mut mpsc::UnboundedReceiver<Command>,
    events_tx: &mpsc::Sender<ClientEvent>,
) -> SessionOutcome {
    let (mut ws_write, mut ws_read) = ws_stream.split();
    let mut joiner = frame_parts::Joiner::new(MAX_JOINED_MESSAGE_BYTES);
    // When the first part of the message being joined arrived (`CONN_GPUI_PERF_LOG`).
    let mut message_started_at: Option<std::time::Instant> = None;

    // Resubscribe desired shell and thread streams and flush any queued calls/streams.
    if let Err(err) = restore_subscriptions_and_pending(state, &mut ws_write).await {
        return SessionOutcome::Disconnected(err);
    }

    let mut ping_interval = tokio::time::interval_at(Instant::now() + PING_INTERVAL, PING_INTERVAL);
    ping_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut missed_pongs: u8 = 0;

    loop {
        tokio::select! {
            maybe_msg = ws_read.next() => {
                match maybe_msg {
                    Some(Ok(Message::Text(text))) => {
                        // Receiving any text frame (including multi-part snapshot chunks) proves
                        // the server connection is live; don't let keepalive drop a huge snapshot
                        // mid-transfer while the server is busy streaming frame parts.
                        missed_pongs = 0;
                        let part_at = std::time::Instant::now();
                        let started_at = *message_started_at.get_or_insert(part_at);
                        let whole = match joiner.push(&text) {
                            Ok(Some(whole)) => {
                                message_started_at = None;
                                whole
                            }
                            Ok(None) => continue,
                            Err(frame_parts::TooLarge) => {
                                eprintln!(
                                    "conn-client: reassembled frame exceeded max size ({MAX_JOINED_MESSAGE_BYTES} bytes)"
                                );
                                return SessionOutcome::Disconnected(
                                    "reassembled frame exceeded max size".to_owned(),
                                );
                            }
                        };
                        let timing = MessageTiming {
                            started_at,
                            bytes: whole.len(),
                        };
                        let frames = match decode_server_message_raw(&whole) {
                            Ok(frames) => frames,
                            Err(err) => {
                                eprintln!("conn-client failed to decode server frame: {err}");
                                warn!("conn-client failed to decode server frame: {err}");
                                continue;
                            }
                        };
                        for frame in frames {
                            if let Err(outcome) = handle_incoming_frame(
                                state,
                                frame,
                                &mut ws_write,
                                events_tx,
                                &mut missed_pongs,
                                timing,
                            ).await {
                                return outcome;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if let Err(err) = ws_write.send(Message::Pong(payload)).await {
                            return SessionOutcome::Disconnected(format!("ws pong send failed: {err}"));
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        return SessionOutcome::Disconnected("server closed websocket".to_owned());
                    }
                    Some(Ok(Message::Binary(_) | Message::Pong(_) | Message::Frame(_))) => {}
                    Some(Err(err)) => {
                        return SessionOutcome::Disconnected(format!("ws read error: {err}"));
                    }
                }
            }
            _ = ping_interval.tick() => {
                if missed_pongs >= MAX_MISSED_PONGS {
                    return SessionOutcome::Disconnected("missed 2 keepalive pongs".to_owned());
                }
                missed_pongs = missed_pongs.saturating_add(1);
                if let Err(err) = send_client_frame(&mut ws_write, &FromClient::Ping).await {
                    return SessionOutcome::Disconnected(err);
                }
            }
            maybe_cmd = cmd_rx.recv() => {
                match maybe_cmd {
                    Some(Command::Close) | None => {
                        state.closed = true;
                        let _ = send_client_frame(&mut ws_write, &FromClient::Eof).await;
                        let _ = ws_write.send(Message::Close(None)).await;
                        return SessionOutcome::Closed;
                    }
                    Some(Command::Reconnect) => {
                        let _ = ws_write.send(Message::Close(None)).await;
                        return SessionOutcome::ReconnectNow;
                    }
                    Some(cmd) => {
                        if let Err(err) = handle_online_command(state, cmd, &mut ws_write).await {
                            return SessionOutcome::Disconnected(err);
                        }
                    }
                }
            }
        }
    }
}

async fn restore_subscriptions_and_pending<S>(
    state: &mut DriverState,
    ws_write: &mut S,
) -> Result<(), String>
where
    S: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    if state.shell_subscribed && state.shell_request_id.is_none() {
        send_shell_subscribe(state, ws_write).await?;
    }

    if state.server_config_subscribed && state.server_config_request_id.is_none() {
        send_server_config_subscribe(state, ws_write).await?;
    }

    let thread_ids: Vec<String> = state.thread_subs.keys().cloned().collect();
    for thread_id in thread_ids {
        send_thread_subscribe(state, &thread_id, ws_write).await?;
    }

    if state.panel_subscription.is_some() && state.panel_request_id.is_none() {
        send_panel_requests_subscribe(state, ws_write).await?;
    }

    let project_ids: Vec<String> = state.annotation_subs.keys().cloned().collect();
    for project_id in project_ids {
        send_annotations_subscribe(state, &project_id, ws_write).await?;
    }

    let pending_calls = std::mem::take(&mut state.pending_calls);
    for call in pending_calls {
        send_unary_call(state, call.tag, call.payload, call.reply, ws_write).await?;
    }

    let pending_streams = std::mem::take(&mut state.pending_streams);
    for stream in pending_streams {
        send_generic_stream(
            state,
            stream.stream_id,
            stream.tag,
            stream.payload,
            stream.tx,
            ws_write,
        )
        .await?;
    }

    Ok(())
}

async fn handle_online_command<S>(
    state: &mut DriverState,
    cmd: Command,
    ws_write: &mut S,
) -> Result<(), String>
where
    S: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    match cmd {
        Command::SubscribeShell {
            include_idle_subagents,
        } => {
            state.include_idle_subagents = include_idle_subagents;
            state.shell_subscribed = true;
            if state.shell_request_id.is_none() {
                send_shell_subscribe(state, ws_write).await?;
            }
        }
        Command::SubscribeServerConfig => {
            state.server_config_subscribed = true;
            if state.server_config_request_id.is_none() {
                send_server_config_subscribe(state, ws_write).await?;
            }
        }
        Command::RefreshThread(thread_id) => {
            if let Some(request_id) = state.reset_thread(&thread_id) {
                state.in_flight_streams.remove(&request_id);
                send_client_frame(ws_write, &FromClient::Interrupt { request_id }).await?;
            }
            send_thread_subscribe(state, &thread_id, ws_write).await?;
        }
        Command::SubscribeThread(thread_id) => {
            let needs_send = match state.thread_subs.get(&thread_id) {
                Some(existing) => existing.request_id.is_none(),
                None => {
                    let last_seq = state.thread_last_sequences.get(&thread_id).copied();
                    state.thread_subs.insert(
                        thread_id.clone(),
                        ThreadSubState {
                            after_sequence: last_seq,
                            request_id: None,
                            subscribed_at: None,
                        },
                    );
                    true
                }
            };
            if needs_send {
                send_thread_subscribe(state, &thread_id, ws_write).await?;
            }
        }
        Command::UnsubscribeThread(thread_id) => {
            if let Some(sub) = state.thread_subs.remove(&thread_id) {
                if let Some(seq) = sub.after_sequence {
                    state.thread_last_sequences.insert(thread_id, seq);
                }
                if let Some(request_id) = sub.request_id {
                    state.in_flight_streams.remove(&request_id);
                    send_client_frame(ws_write, &FromClient::Interrupt { request_id }).await?;
                }
            }
        }
        Command::SubscribePanelRequests(subscription) => {
            let next = Some(subscription);
            if state.panel_subscription != next {
                if let Some(request_id) = state.panel_request_id.take() {
                    state.in_flight_streams.remove(&request_id);
                    send_client_frame(ws_write, &FromClient::Interrupt { request_id }).await?;
                }
                state.panel_subscription = next;
            }
            if state.panel_request_id.is_none() {
                send_panel_requests_subscribe(state, ws_write).await?;
            }
        }
        Command::UnsubscribePanelRequests => {
            state.panel_subscription = None;
            if let Some(request_id) = state.panel_request_id.take() {
                state.in_flight_streams.remove(&request_id);
                send_client_frame(ws_write, &FromClient::Interrupt { request_id }).await?;
            }
        }
        Command::SubscribeAnnotations(project_id) => {
            let needs_send = match state.annotation_subs.get(&project_id) {
                Some(existing) => existing.is_none(),
                None => {
                    state.annotation_subs.insert(project_id.clone(), None);
                    true
                }
            };
            if needs_send {
                send_annotations_subscribe(state, &project_id, ws_write).await?;
            }
        }
        Command::UnsubscribeAnnotations(project_id) => {
            if let Some(Some(request_id)) = state.annotation_subs.remove(&project_id) {
                state.in_flight_streams.remove(&request_id);
                send_client_frame(ws_write, &FromClient::Interrupt { request_id }).await?;
            }
        }
        Command::Call {
            tag,
            payload,
            reply,
        } => {
            send_unary_call(state, tag, payload, reply, ws_write).await?;
        }
        Command::StartStream {
            stream_id,
            tag,
            payload,
            tx,
        } => {
            send_generic_stream(state, stream_id, tag, payload, tx, ws_write).await?;
        }
        Command::CancelStream(stream_id) => {
            if let Some(request_id) = state.generic_stream_ids.remove(&stream_id) {
                state.in_flight_streams.remove(&request_id);
                send_client_frame(ws_write, &FromClient::Interrupt { request_id }).await?;
            }
        }
        Command::Reconnect => {}
        Command::Close => {
            state.closed = true;
        }
    }
    Ok(())
}

async fn send_shell_subscribe<S>(state: &mut DriverState, ws_write: &mut S) -> Result<(), String>
where
    S: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let input = OrchestrationV2SubscribeShellInput {
        after_sequence: state.shell_after_sequence,
        http_snapshot_fallback: None,
        known_project_identities: None,
        request_completion_marker: Some(true),
        omit_idle_subagents: Some(!state.include_idle_subagents),
        omit_older_settled: Some(true),
    };
    let payload = serde_json::to_value(&input)
        .map_err(|err| format!("failed to encode subscribeShell payload: {err}"))?;
    let request_id = state.alloc_request_id();
    state.shell_request_id = Some(request_id.clone());
    state
        .in_flight_streams
        .insert(request_id.clone(), ActiveStream::Shell);
    send_request(ws_write, request_id, TAG_SUBSCRIBE_SHELL, payload).await
}

/// `subscribeServerConfig`: the config snapshot, then provider, settings and keybinding changes.
/// Asks for `providerStatusDeltas`, which leave out the models, slash commands and skills the
/// client holds; the other opt-ins stay off because this client reads none of what they add.
async fn send_server_config_subscribe<S>(
    state: &mut DriverState,
    ws_write: &mut S,
) -> Result<(), String>
where
    S: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let input = SubscribeServerConfigPayload {
        environment_themes: None,
        usage_limit_sources: None,
        usage_limits_command: None,
        workspace_snapshots_on_demand: None,
        provider_catalogs_on_demand: None,
        provider_catalog_digests: None,
        provider_status_deltas: Some(true),
    };
    let payload = serde_json::to_value(&input)
        .map_err(|err| format!("failed to encode subscribeServerConfig payload: {err}"))?;
    let request_id = state.alloc_request_id();
    state.server_config_request_id = Some(request_id.clone());
    state
        .in_flight_streams
        .insert(request_id.clone(), ActiveStream::ServerConfig);
    send_request(ws_write, request_id, TAG_SUBSCRIBE_SERVER_CONFIG, payload).await
}

async fn send_thread_subscribe<S>(
    state: &mut DriverState,
    thread_id: &str,
    ws_write: &mut S,
) -> Result<(), String>
where
    S: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let after_sequence = state
        .thread_subs
        .get(thread_id)
        .and_then(|s| s.after_sequence)
        .or_else(|| state.thread_last_sequences.get(thread_id).copied());
    let input = OrchestrationV2SubscribeThreadInput {
        thread_id: thread_id.to_owned(),
        after_sequence,
        // T3 always asks for `synchronized`: it ends "Loading thread…" for threads whose
        // snapshot has no rows, and marks the end of an `afterSequence` replay.
        request_completion_marker: Some(true),
        // Opt in to bounded snapshots (newest ~75 items / 10 turns) with on-demand `/history`
        // paging; servers that don't support bounded snapshots ignore this flag safely.
        // `acceptDeferredWork` and `acceptCompactIds` stay off until lazy body fetch & idTable
        // decoding are wired.
        accept_bounded_snapshot: Some(true),
        accept_deferred_work: None,
        accept_compact_turn_items: Some(true),
        accept_deduped_bodies: Some(true),
        accept_compact_ids: None,
    };
    let payload = serde_json::to_value(&input)
        .map_err(|err| format!("failed to encode subscribeThread payload: {err}"))?;
    let request_id = state.alloc_request_id();
    if let Some(sub) = state.thread_subs.get_mut(thread_id) {
        sub.request_id = Some(request_id.clone());
        sub.subscribed_at = Some(std::time::Instant::now());
    }
    state.in_flight_streams.insert(
        request_id.clone(),
        ActiveStream::Thread(thread_id.to_owned()),
    );
    let result = send_request(ws_write, request_id, TAG_SUBSCRIBE_THREAD, payload).await;
    crate::perf_log!("client.subscribe_sent thread={thread_id} after_sequence={after_sequence:?}");
    result
}

async fn send_panel_requests_subscribe<S>(
    state: &mut DriverState,
    ws_write: &mut S,
) -> Result<(), String>
where
    S: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let Some(input) = &state.panel_subscription else {
        return Ok(());
    };
    let payload = serde_json::to_value(input)
        .map_err(|err| format!("failed to encode panels.requests payload: {err}"))?;
    let request_id = state.alloc_request_id();
    state.panel_request_id = Some(request_id.clone());
    state
        .in_flight_streams
        .insert(request_id.clone(), ActiveStream::PanelRequests);
    send_request(ws_write, request_id, TAG_PANELS_REQUESTS, payload).await
}

async fn send_annotations_subscribe<S>(
    state: &mut DriverState,
    project_id: &str,
    ws_write: &mut S,
) -> Result<(), String>
where
    S: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let input = AnnotationProjectInput {
        project_id: project_id.to_owned(),
    };
    let payload = serde_json::to_value(&input)
        .map_err(|err| format!("failed to encode annotations.subscribe payload: {err}"))?;
    let request_id = state.alloc_request_id();
    if let Some(slot) = state.annotation_subs.get_mut(project_id) {
        *slot = Some(request_id.clone());
    }
    state.in_flight_streams.insert(
        request_id.clone(),
        ActiveStream::Annotations(project_id.to_owned()),
    );
    send_request(ws_write, request_id, TAG_ANNOTATIONS_SUBSCRIBE, payload).await
}

async fn send_unary_call<S>(
    state: &mut DriverState,
    tag: String,
    payload: Value,
    reply: oneshot::Sender<Result<Value, ClientError>>,
    ws_write: &mut S,
) -> Result<(), String>
where
    S: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let request_id = state.alloc_request_id();
    state.in_flight_unary.insert(request_id.clone(), reply);
    send_request(ws_write, request_id, &tag, payload).await
}

async fn send_generic_stream<S>(
    state: &mut DriverState,
    stream_id: StreamId,
    tag: String,
    payload: Value,
    tx: mpsc::Sender<Value>,
    ws_write: &mut S,
) -> Result<(), String>
where
    S: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let request_id = state.alloc_request_id();
    state
        .generic_stream_ids
        .insert(stream_id, request_id.clone());
    state
        .in_flight_streams
        .insert(request_id.clone(), ActiveStream::Generic { stream_id, tx });
    send_request(ws_write, request_id, &tag, payload).await
}

async fn send_request<S>(
    ws_write: &mut S,
    id: RequestId,
    tag: &str,
    payload: Value,
) -> Result<(), String>
where
    S: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let frame = FromClient::Request(Request {
        id,
        tag: tag.to_owned(),
        payload,
        headers: Vec::new(),
        is_notification: None,
        discard: None,
        trace_id: None,
        span_id: None,
        sampled: None,
    });
    send_client_frame(ws_write, &frame).await
}

async fn send_client_frame<S>(ws_write: &mut S, frame: &FromClient) -> Result<(), String>
where
    S: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let text = encode_client_frame(frame)
        .map_err(|err| format!("failed to serialize client frame: {err}"))?;
    ws_write
        .send(Message::Text(text.into()))
        .await
        .map_err(|err| format!("ws send failed: {err}"))
}

/// When a whole server message started arriving and how big it was (`CONN_GPUI_PERF_LOG`).
#[derive(Clone, Copy)]
struct MessageTiming {
    started_at: std::time::Instant,
    bytes: usize,
}

async fn handle_incoming_frame<S>(
    state: &mut DriverState,
    frame: IncomingServerFrame,
    ws_write: &mut S,
    events_tx: &mpsc::Sender<ClientEvent>,
    missed_pongs: &mut u8,
    timing: MessageTiming,
) -> Result<(), SessionOutcome>
where
    S: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    match frame {
        IncomingServerFrame::Chunk { request_id, values } => {
            handle_chunk_raw(state, request_id, values, ws_write, events_tx, timing).await?;
        }
        IncomingServerFrame::Other(FromServer::Pong) => {
            *missed_pongs = 0;
        }
        IncomingServerFrame::Other(FromServer::Chunk { request_id, values }) => {
            let raw_values: Vec<Box<RawValue>> = values
                .into_iter()
                .filter_map(|v| {
                    serde_json::to_string(&v)
                        .ok()
                        .and_then(|s| RawValue::from_string(s).ok())
                })
                .collect();
            handle_chunk_raw(state, request_id, raw_values, ws_write, events_tx, timing).await?;
        }
        IncomingServerFrame::Other(FromServer::Exit { request_id, exit }) => {
            handle_exit(state, request_id, exit, events_tx).await?;
        }
        IncomingServerFrame::Other(FromServer::Defect { defect }) => {
            for (_, reply) in state.in_flight_unary.drain() {
                let _ = reply.send(Err(ClientError::Rpc(defect.clone())));
            }
        }
        IncomingServerFrame::Other(FromServer::ClientProtocolError { error, request_ids }) => {
            match request_ids {
                Some(ids) => {
                    for id in ids {
                        if let Some(reply) = state.in_flight_unary.remove(&id) {
                            let _ = reply.send(Err(ClientError::Rpc(error.clone())));
                        }
                    }
                }
                None => {
                    for (_, reply) in state.in_flight_unary.drain() {
                        let _ = reply.send(Err(ClientError::Rpc(error.clone())));
                    }
                }
            }
        }
        IncomingServerFrame::Other(FromServer::Request(_)) => {}
    }
    Ok(())
}

async fn handle_chunk_raw<S>(
    state: &mut DriverState,
    request_id: RequestId,
    values: Vec<Box<RawValue>>,
    ws_write: &mut S,
    events_tx: &mpsc::Sender<ClientEvent>,
    timing: MessageTiming,
) -> Result<(), SessionOutcome>
where
    S: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    // Always acknowledge chunks immediately so server streams never stall.
    send_client_frame(
        ws_write,
        &FromClient::Ack {
            request_id: request_id.clone(),
        },
    )
    .await
    .map_err(SessionOutcome::Disconnected)?;

    let mut drop_generic_stream: Option<StreamId> = None;

    match state.in_flight_streams.get(&request_id) {
        Some(ActiveStream::Shell) => {
            for raw in values {
                match serde_json::from_str::<OrchestrationV2ShellStreamItem>(raw.get()) {
                    Ok(item) => {
                        if matches!(item, OrchestrationV2ShellStreamItem::SnapshotRequired(_)) {
                            state.shell_after_sequence = None;
                        } else if let Some(seq) = extract_shell_sequence(&item) {
                            state.shell_after_sequence = Some(seq);
                        }
                        if events_tx.send(ClientEvent::Shell(item)).await.is_err() {
                            return Err(SessionOutcome::Closed);
                        }
                    }
                    Err(err) => {
                        eprintln!("conn-client failed to decode shell stream item: {err}");
                        warn!("conn-client failed to decode shell stream item: {err}");
                    }
                }
            }
        }
        Some(ActiveStream::ServerConfig) => {
            for raw in values {
                match serde_json::from_str::<ServerConfigStreamEvent>(raw.get()) {
                    Ok(event) => {
                        if events_tx
                            .send(ClientEvent::ServerConfig(Box::new(event)))
                            .await
                            .is_err()
                        {
                            return Err(SessionOutcome::Closed);
                        }
                    }
                    Err(err) => {
                        warn!("conn-client failed to decode subscribeServerConfig item: {err}");
                    }
                }
            }
        }
        Some(ActiveStream::Thread(thread_id)) => {
            let thread_id = thread_id.clone();
            for raw in values {
                let decode_start = std::time::Instant::now();
                match decode_thread_stream_item(raw.get()) {
                    Ok(item) => {
                        if crate::perf::enabled() {
                            log_thread_item_decoded(state, &thread_id, &item, timing, decode_start);
                        }
                        if let Some(seq) = extract_thread_sequence(&item) {
                            state.thread_last_sequences.insert(thread_id.clone(), seq);
                            if let Some(sub) = state.thread_subs.get_mut(&thread_id) {
                                sub.after_sequence = Some(seq);
                            }
                        }
                        if events_tx
                            .send(ClientEvent::Thread {
                                thread_id: thread_id.clone(),
                                item,
                            })
                            .await
                            .is_err()
                        {
                            return Err(SessionOutcome::Closed);
                        }
                    }
                    Err(err) => {
                        eprintln!(
                            "conn-client failed to decode thread stream item ({thread_id}): {err}"
                        );
                        warn!("conn-client failed to decode thread stream item: {err}");
                    }
                }
            }
        }
        Some(ActiveStream::PanelRequests) => {
            for raw in values {
                match serde_json::from_str::<conn_contract::source::DesktopPanelRequest>(raw.get())
                {
                    Ok(request) => {
                        if events_tx
                            .send(ClientEvent::PanelRequest(request))
                            .await
                            .is_err()
                        {
                            return Err(SessionOutcome::Closed);
                        }
                    }
                    Err(err) => {
                        warn!("conn-client failed to decode panels.requests item: {err}");
                    }
                }
            }
        }
        Some(ActiveStream::Annotations(project_id)) => {
            let project_id = project_id.clone();
            for raw in values {
                match serde_json::from_str::<AnnotationList>(raw.get()) {
                    Ok(list) => {
                        if events_tx
                            .send(ClientEvent::Annotations {
                                project_id: project_id.clone(),
                                annotations: list.annotations,
                            })
                            .await
                            .is_err()
                        {
                            return Err(SessionOutcome::Closed);
                        }
                    }
                    Err(err) => {
                        warn!("conn-client failed to decode annotations.subscribe item: {err}");
                    }
                }
            }
        }
        Some(ActiveStream::Generic { stream_id, tx }) => {
            let stream_id = *stream_id;
            let tx = tx.clone();
            for raw in values {
                let Ok(value) = serde_json::from_str::<Value>(raw.get()) else {
                    continue;
                };
                if tx.send(value).await.is_err() {
                    drop_generic_stream = Some(stream_id);
                    break;
                }
            }
        }
        None => {}
    }

    if let Some(stream_id) = drop_generic_stream {
        state.in_flight_streams.remove(&request_id);
        state.generic_stream_ids.remove(&stream_id);
        let _ = send_client_frame(ws_write, &FromClient::Interrupt { request_id }).await;
    }

    Ok(())
}

fn log_thread_item_decoded(
    state: &DriverState,
    thread_id: &str,
    item: &OrchestrationV2ThreadStreamItem,
    timing: MessageTiming,
    decode_start: std::time::Instant,
) {
    let kind = match item {
        OrchestrationV2ThreadStreamItem::Snapshot(_) => "snapshot",
        OrchestrationV2ThreadStreamItem::Synchronized(_) => "synchronized",
        OrchestrationV2ThreadStreamItem::Event(_) | OrchestrationV2ThreadStreamItem::Event2(_) => {
            "event"
        }
    };
    let since_subscribe = state
        .thread_subs
        .get(thread_id)
        .and_then(|sub| sub.subscribed_at)
        .map_or(f64::NAN, crate::perf::ms_since);
    crate::perf_log!(
        "client.decoded thread={thread_id} kind={kind} message_bytes={} receive_ms={:.1} decode_ms={:.1} +{since_subscribe:.1}ms",
        timing.bytes,
        decode_start.duration_since(timing.started_at).as_secs_f64() * 1000.0,
        crate::perf::ms_since(decode_start),
    );
}

async fn handle_exit(
    state: &mut DriverState,
    request_id: RequestId,
    exit: Exit,
    events_tx: &mpsc::Sender<ClientEvent>,
) -> Result<(), SessionOutcome> {
    if let Some(reply) = state.in_flight_unary.remove(&request_id) {
        let result = match exit {
            Exit::Success { value } => Ok(value),
            Exit::Failure { cause } => {
                let cause_json = serde_json::to_value(&cause).unwrap_or(Value::Null);
                Err(ClientError::Rpc(cause_json))
            }
        };
        let _ = reply.send(result);
        return Ok(());
    }

    if let Some(stream) = state.in_flight_streams.remove(&request_id) {
        let error = match exit {
            Exit::Success { .. } => None,
            Exit::Failure { cause } => Some(
                serde_json::to_string(&cause)
                    .unwrap_or_else(|_| "stream exited with failure".to_owned()),
            ),
        };
        match stream {
            ActiveStream::Shell => {
                if state.shell_request_id.as_ref() == Some(&request_id) {
                    state.shell_request_id = None;
                }
                if events_tx
                    .send(ClientEvent::StreamEnded {
                        tag: TAG_SUBSCRIBE_SHELL.to_owned(),
                        key: String::new(),
                        error,
                    })
                    .await
                    .is_err()
                {
                    return Err(SessionOutcome::Closed);
                }
            }
            ActiveStream::ServerConfig => {
                if state.server_config_request_id.as_ref() == Some(&request_id) {
                    state.server_config_request_id = None;
                }
                if events_tx
                    .send(ClientEvent::StreamEnded {
                        tag: TAG_SUBSCRIBE_SERVER_CONFIG.to_owned(),
                        key: String::new(),
                        error,
                    })
                    .await
                    .is_err()
                {
                    return Err(SessionOutcome::Closed);
                }
            }
            ActiveStream::Thread(thread_id) => {
                if let Some(sub) = state.thread_subs.get_mut(&thread_id)
                    && sub.request_id.as_ref() == Some(&request_id)
                {
                    sub.request_id = None;
                }
                if events_tx
                    .send(ClientEvent::StreamEnded {
                        tag: TAG_SUBSCRIBE_THREAD.to_owned(),
                        key: thread_id,
                        error,
                    })
                    .await
                    .is_err()
                {
                    return Err(SessionOutcome::Closed);
                }
            }
            ActiveStream::PanelRequests => {
                if state.panel_request_id.as_ref() == Some(&request_id) {
                    state.panel_request_id = None;
                }
                if events_tx
                    .send(ClientEvent::StreamEnded {
                        tag: TAG_PANELS_REQUESTS.to_owned(),
                        key: String::new(),
                        error,
                    })
                    .await
                    .is_err()
                {
                    return Err(SessionOutcome::Closed);
                }
            }
            ActiveStream::Annotations(project_id) => {
                if let Some(slot) = state.annotation_subs.get_mut(&project_id)
                    && slot.as_ref() == Some(&request_id)
                {
                    *slot = None;
                }
                if events_tx
                    .send(ClientEvent::StreamEnded {
                        tag: TAG_ANNOTATIONS_SUBSCRIBE.to_owned(),
                        key: project_id,
                        error,
                    })
                    .await
                    .is_err()
                {
                    return Err(SessionOutcome::Closed);
                }
            }
            ActiveStream::Generic { stream_id, .. } => {
                state.generic_stream_ids.remove(&stream_id);
            }
        }
    }

    Ok(())
}
