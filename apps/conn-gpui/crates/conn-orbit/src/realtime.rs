//! Live Tasks updates: Orbit's Reverb (Pusher protocol 7) over a plain WebSocket, plus a 30 s poll.
//!
//! Port of `packages/client-runtime/src/orbitGateway/tasksRealtime.ts` and
//! `realtimeSubscription.ts`. The flow:
//!
//! 1. `GET /api/v1/realtime` (root call) gives `{ url, key }`; the socket opens at
//!    `{url}/app/{key}?protocol=7&client=conn&version=1`.
//! 2. On `pusher:connection_established`, `POST /api/v1/broadcasting/auth` signs
//!    `{ socket_id, channel_name: "private-orbit" }`; the socket then sends `pusher:subscribe`.
//! 3. Once `pusher_internal:subscription_succeeded` arrives the follower is `Live`, and task
//!    notices become [`TasksInvalidation`]s, coalesced over 250 ms.
//!
//! Notices only invalidate: the read that follows is authoritative. A full list refresh also runs
//! every 30 s, live or not, because metric-only changes emit no event. While not live, every
//! second tick tries to connect again.

use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde_json::{Map, Value, json};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until, timeout};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{
    Connector, MaybeTlsStream, WebSocketStream, connect_async_tls_with_config,
};
use url::Url;

use super::client::{OrbitTasksClient, TasksInvalidation};
use super::gateway::{GatewayMethod, GatewayRequest, GatewayTransport, platform_tls_config};

/// How often the follower reads the whole list again.
pub const ORBIT_TASKS_REFRESH: Duration = Duration::from_secs(30);
const BATCH: Duration = Duration::from_millis(250);
const HANDSHAKE: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const CHANNEL: &str = "private-orbit";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TasksLiveStatus {
    Connecting,
    Live,
    Polling,
}

/// App-wide Orbit Gateway realtime notice delivered over the shared `private-orbit` Reverb
/// WebSocket so Nodes, Instances, and profiles stay fresh in the background without polling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OrbitRealtimeEvent {
    /// A Node or Instance was created, updated, woken, stopped, deployed, or removed.
    FleetChanged,
    /// A Conn profile document changed on another device.
    ProfileChanged,
}

/// Classifies non-task `private-orbit` Reverb events into app-wide invalidations.
#[must_use]
pub fn orbit_realtime_event(event: &str) -> Option<OrbitRealtimeEvent> {
    match event {
        "node.created"
        | "node.updated"
        | "node.deleted"
        | "instance.created"
        | "instance.updated"
        | "instance.deleted"
        | "conn.environment.updated"
        | "conn.environment.registered"
        | "conn.environment.removed" => Some(OrbitRealtimeEvent::FleetChanged),
        "conn.profile.updated" | "profile.updated" => Some(OrbitRealtimeEvent::ProfileChanged),
        other if other.starts_with("deployment.") => Some(OrbitRealtimeEvent::FleetChanged),
        _ => None,
    }
}

/// A JSON object, also from a string that holds one (Pusher double-encodes `data`).
fn realtime_object(value: &Value) -> Option<Map<String, Value>> {
    match value {
        Value::String(text) => realtime_object(&serde_json::from_str(text).ok()?),
        Value::Object(map) => Some(map.clone()),
        _ => None,
    }
}

/// The invalidation a channel event asks for, if any.
pub fn orbit_task_notice(event: &str, data: &Value) -> Option<TasksInvalidation> {
    if event == "tasks.updated" {
        return Some(TasksInvalidation::List);
    }
    let payload = realtime_object(data)?;
    let id = match event {
        "agent_thread.updated" => payload.get("task_group_id"),
        "task_group.updated" | "task_group.created" => payload.get("id"),
        _ => None,
    }?;
    // `Number.isSafeInteger(id) && id > 0`.
    let id = id
        .as_i64()
        .filter(|id| *id > 0 && *id <= 9_007_199_254_740_991)?;
    Some(TasksInvalidation::Task(id))
}

/// A running follower. Dropping it stops the connection and the poll.
#[derive(Debug)]
pub struct TasksFollower {
    status: watch::Receiver<TasksLiveStatus>,
    events: broadcast::Sender<OrbitRealtimeEvent>,
    task: JoinHandle<()>,
}

impl TasksFollower {
    /// The current status, and changes to it.
    pub fn status(&self) -> watch::Receiver<TasksLiveStatus> {
        self.status.clone()
    }

    /// Subscribes to app-wide Orbit Gateway notices (`FleetChanged`, `ProfileChanged`) arriving
    /// on the shared `private-orbit` Reverb WebSocket.
    pub fn subscribe_events(&self) -> broadcast::Receiver<OrbitRealtimeEvent> {
        self.events.subscribe()
    }
}

impl Drop for TasksFollower {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Starts following Orbit's Tasks (and app-wide Fleet/Profile notices) on `runtime`.
/// Keep one follower per app, shared by all views.
pub fn follow_orbit_tasks(
    runtime: &tokio::runtime::Handle,
    client: OrbitTasksClient,
) -> TasksFollower {
    let (sender, status) = watch::channel(TasksLiveStatus::Connecting);
    let (events, _) = broadcast::channel(64);
    let task = runtime.spawn(run(client, sender, events.clone()));
    TasksFollower {
        status,
        events,
        task,
    }
}

pub(super) type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// `encodeURIComponent`.
fn encode_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// One root call; the `data` object of a 2xx answer (or the answer itself when it has none).
async fn request(
    transport: &dyn GatewayTransport,
    path: &str,
    body: Option<Value>,
) -> Option<Map<String, Value>> {
    let request = GatewayRequest {
        method: if body.is_some() {
            GatewayMethod::Post
        } else {
            GatewayMethod::Get
        },
        body: body.map(|body| body.to_string()),
        timeout: Some(REQUEST_TIMEOUT),
        ..GatewayRequest::get(path).at_root()
    };
    let response = transport.send(request).await.ok()?;
    if !(200..300).contains(&response.status) {
        return None;
    }
    let envelope = realtime_object(&Value::String(response.body))?;
    envelope
        .get("data")
        .and_then(realtime_object)
        .or(Some(envelope))
}

/// The socket URL from `GET /realtime`.
pub fn realtime_socket_url(config: &Map<String, Value>) -> Option<Url> {
    let base = config.get("url")?.as_str()?;
    let key = config.get("key")?.as_str()?;
    let mut url = Url::parse(base).ok()?;
    if !matches!(url.scheme(), "ws" | "wss") {
        return None;
    }
    url.set_path(&format!("/app/{}", encode_component(key)));
    url.set_query(Some("protocol=7&client=conn&version=1"));
    Some(url)
}

pub(super) async fn open_socket(transport: &dyn GatewayTransport) -> Option<Socket> {
    let config = request(transport, "/realtime", None).await?;
    let url = realtime_socket_url(&config)?;
    // Use the shared Apple/OS platform TLS verifier so `wss://` Reverb connections trust the Orbit
    // root CA on both macOS and iOS. `tokio-tungstenite` ignores the connector for plain `ws://`.
    let connector = Connector::Rustls(Arc::new(platform_tls_config().ok()?));
    let (socket, _) = timeout(
        HANDSHAKE,
        connect_async_tls_with_config(url.as_str(), None, false, Some(connector)),
    )
    .await
    .ok()?
    .ok()?;
    Some(socket)
}

async fn next_message(socket: &mut Option<Socket>) -> Option<Result<Message, ()>> {
    match socket {
        Some(socket) => socket.next().await.map(|item| item.map_err(|_| ())),
        None => std::future::pending().await,
    }
}

async fn sleep_until_some(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

struct Follow {
    client: OrbitTasksClient,
    transport: Arc<dyn GatewayTransport>,
    status: watch::Sender<TasksLiveStatus>,
    events: broadcast::Sender<OrbitRealtimeEvent>,
    socket: Option<Socket>,
    live: bool,
    handshake: Option<Instant>,
    batch: Option<TasksInvalidation>,
    fleet_dirty: bool,
    profile_dirty: bool,
    batch_at: Option<Instant>,
}

impl Follow {
    fn publish(&self, status: TasksLiveStatus) {
        self.status.send_replace(status);
    }

    fn enqueue(&mut self, target: TasksInvalidation) {
        self.batch = Some(match self.batch {
            None => target,
            Some(current) if current == target => current,
            Some(_) => TasksInvalidation::List,
        });
        if self.batch_at.is_none() {
            self.batch_at = Some(Instant::now() + BATCH);
        }
    }

    fn enqueue_orbit_event(&mut self, event: OrbitRealtimeEvent) {
        match event {
            OrbitRealtimeEvent::FleetChanged => self.fleet_dirty = true,
            OrbitRealtimeEvent::ProfileChanged => self.profile_dirty = true,
        }
        if self.batch_at.is_none() {
            self.batch_at = Some(Instant::now() + BATCH);
        }
    }

    fn flush(&mut self) {
        self.batch_at = None;
        if let Some(target) = self.batch.take() {
            self.client.invalidate(target);
        }
        if std::mem::take(&mut self.fleet_dirty) {
            let _ = self.events.send(OrbitRealtimeEvent::FleetChanged);
        }
        if std::mem::take(&mut self.profile_dirty) {
            let _ = self.events.send(OrbitRealtimeEvent::ProfileChanged);
        }
    }

    fn fallback(&mut self) {
        self.socket = None;
        self.live = false;
        self.handshake = None;
        self.publish(TasksLiveStatus::Polling);
    }

    async fn connect(&mut self) {
        if self.socket.is_some() {
            return;
        }
        match open_socket(&*self.transport).await {
            Some(socket) => {
                self.socket = Some(socket);
                self.handshake = Some(Instant::now() + HANDSHAKE);
            }
            None => self.fallback(),
        }
    }

    async fn send(&mut self, value: Value) {
        let sent = match &mut self.socket {
            Some(socket) => socket.send(Message::text(value.to_string())).await.is_ok(),
            None => return,
        };
        if !sent {
            self.fallback();
        }
    }

    async fn handle(&mut self, text: &str) {
        let Some(message) = realtime_object(&Value::String(text.to_owned())) else {
            return;
        };
        let event = message
            .get("event")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let channel = message.get("channel").and_then(Value::as_str);
        let raw_data = message.get("data").cloned().unwrap_or(Value::Null);
        let data = realtime_object(&raw_data);
        match event {
            "pusher:ping" => {
                self.send(json!({ "event": "pusher:pong", "data": {} }))
                    .await
            }
            "pusher:connection_established" => {
                let Some(socket_id) = data
                    .as_ref()
                    .and_then(|d| d.get("socket_id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                else {
                    return;
                };
                let body = json!({ "socket_id": socket_id, "channel_name": CHANNEL });
                let auth = request(&*self.transport, "/broadcasting/auth", Some(body)).await;
                match auth
                    .as_ref()
                    .and_then(|a| a.get("auth"))
                    .and_then(Value::as_str)
                {
                    Some(signature) => {
                        let subscribe = json!({
                            "event": "pusher:subscribe",
                            "data": { "channel": CHANNEL, "auth": signature },
                        });
                        self.send(subscribe).await;
                    }
                    None => self.fallback(),
                }
            }
            "pusher_internal:subscription_succeeded" if channel == Some(CHANNEL) => {
                self.handshake = None;
                self.live = true;
                self.publish(TasksLiveStatus::Live);
                self.enqueue(TasksInvalidation::List);
            }
            "pusher:error" | "pusher:subscription_error" => self.fallback(),
            _ if self.live && channel == Some(CHANNEL) && !event.is_empty() => {
                if let Some(target) = orbit_task_notice(event, &raw_data) {
                    self.enqueue(target);
                }
                if let Some(orbit_event) = orbit_realtime_event(event) {
                    self.enqueue_orbit_event(orbit_event);
                }
            }
            _ => {}
        }
    }
}

async fn run(
    client: OrbitTasksClient,
    status: watch::Sender<TasksLiveStatus>,
    events: broadcast::Sender<OrbitRealtimeEvent>,
) {
    let transport = client.transport();
    let mut follow = Follow {
        client,
        transport,
        status,
        events,
        socket: None,
        live: false,
        handshake: None,
        batch: None,
        fleet_dirty: false,
        profile_dirty: false,
        batch_at: None,
    };
    follow.publish(TasksLiveStatus::Connecting);
    follow.connect().await;
    let mut next_tick = Instant::now() + ORBIT_TASKS_REFRESH;
    let mut cycles: u64 = 0;
    loop {
        tokio::select! {
            message = next_message(&mut follow.socket) => match message {
                Some(Ok(Message::Text(text))) => follow.handle(text.as_str()).await,
                Some(Ok(Message::Close(_)) | Err(())) | None => follow.fallback(),
                Some(Ok(_)) => {}
            },
            () = sleep_until_some(follow.batch_at) => follow.flush(),
            () = sleep_until_some(follow.handshake) => follow.fallback(),
            () = sleep_until(next_tick) => {
                follow.enqueue(TasksInvalidation::List);
                follow.flush();
                cycles += 1;
                if !follow.live && cycles.is_multiple_of(2) {
                    follow.connect().await;
                }
                next_tick += ORBIT_TASKS_REFRESH;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    use super::super::gateway::{BoxFuture, GatewayError, GatewayResponse};
    use super::*;

    #[test]
    fn classifies_fleet_and_profile_reverb_events() {
        assert_eq!(
            orbit_realtime_event("node.updated"),
            Some(OrbitRealtimeEvent::FleetChanged)
        );
        assert_eq!(
            orbit_realtime_event("instance.updated"),
            Some(OrbitRealtimeEvent::FleetChanged)
        );
        assert_eq!(
            orbit_realtime_event("deployment.finished"),
            Some(OrbitRealtimeEvent::FleetChanged)
        );
        assert_eq!(
            orbit_realtime_event("conn.profile.updated"),
            Some(OrbitRealtimeEvent::ProfileChanged)
        );
        assert_eq!(orbit_realtime_event("tasks.updated"), None);
    }

    #[test]
    fn maps_only_task_notices_to_invalidations() {
        use TasksInvalidation::{List, Task};
        assert_eq!(
            orbit_task_notice("task_group.created", &json!({ "id": 1 })),
            Some(Task(1))
        );
        assert_eq!(
            orbit_task_notice("task_group.updated", &json!(json!({ "id": 2 }).to_string())),
            Some(Task(2))
        );
        assert_eq!(
            orbit_task_notice(
                "agent_thread.updated",
                &json!({ "id": 99, "task_group_id": 3, "task_id": 4 })
            ),
            Some(Task(3))
        );
        assert_eq!(
            orbit_task_notice("tasks.updated", &json!({ "enabled": false })),
            Some(List)
        );
        assert_eq!(
            orbit_task_notice("agent_thread.updated", &json!({ "task_id": 4 })),
            None
        );
        assert_eq!(orbit_task_notice("unrelated", &json!({ "id": 1 })), None);
        assert_eq!(
            orbit_task_notice("task_group.updated", &json!({ "id": "1" })),
            None
        );
    }

    #[test]
    fn builds_the_socket_url() {
        let config = realtime_object(&json!({ "url": "wss://reverb.orbit", "key": "a b" }));
        assert_eq!(
            config
                .as_ref()
                .and_then(realtime_socket_url)
                .map(|u| u.to_string())
                .as_deref(),
            Some("wss://reverb.orbit/app/a%20b?protocol=7&client=conn&version=1")
        );
        let http = realtime_object(&json!({ "url": "https://reverb.orbit", "key": "k" }));
        assert_eq!(http.as_ref().and_then(realtime_socket_url), None);
    }

    struct Reverb {
        url: String,
        seen: Mutex<Vec<GatewayRequest>>,
    }

    impl GatewayTransport for Reverb {
        fn send(
            &self,
            request: GatewayRequest,
        ) -> BoxFuture<'_, Result<GatewayResponse, GatewayError>> {
            let body = if request.path == "/realtime" {
                json!({ "data": { "url": self.url, "key": "test", "channel": "orbit" } })
            } else {
                json!({ "auth": "signed" })
            };
            if let Ok(mut seen) = self.seen.lock() {
                seen.push(request);
            }
            Box::pin(async move {
                Ok(GatewayResponse {
                    status: 200,
                    body: body.to_string(),
                })
            })
        }
    }

    fn frame(event: &str, data: Value, channel: Option<&str>) -> Message {
        let mut message = json!({ "event": event, "data": data.to_string() });
        if let Some(channel) = channel {
            message["channel"] = json!(channel);
        }
        Message::text(message.to_string())
    }

    #[tokio::test]
    async fn authenticates_the_private_channel_batches_bursts_and_disposes() {
        let Ok(listener) = TcpListener::bind("127.0.0.1:0").await else {
            panic!("bind");
        };
        let Ok(address) = listener.local_addr() else {
            panic!("address");
        };
        let (subscribed_tx, subscribed_rx) = tokio::sync::oneshot::channel::<Value>();
        let server = tokio::spawn(async move {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let Ok(mut socket) = accept_async(stream).await else {
                return;
            };
            let _ = socket
                .send(frame(
                    "pusher:connection_established",
                    json!({ "socket_id": "123.456" }),
                    None,
                ))
                .await;
            while let Some(Ok(message)) = socket.next().await {
                let Message::Text(text) = message else {
                    continue;
                };
                let value: Value = serde_json::from_str(text.as_str()).unwrap_or_default();
                if value["event"] == "pusher:subscribe" {
                    let _ = subscribed_tx.send(value);
                    break;
                }
            }
            let _ = socket
                .send(frame(
                    "pusher_internal:subscription_succeeded",
                    json!({}),
                    Some(CHANNEL),
                ))
                .await;
            for id in [7, 7, 8] {
                let _ = socket
                    .send(frame(
                        "task_group.updated",
                        json!({ "id": id }),
                        Some(CHANNEL),
                    ))
                    .await;
            }
            // Another channel's events never reach the board.
            let _ = socket
                .send(frame("tasks.updated", json!({}), Some("private-admin")))
                .await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        });

        let transport = Arc::new(Reverb {
            url: format!("ws://{address}"),
            seen: Mutex::new(Vec::new()),
        });
        let client = OrbitTasksClient::new(transport.clone());
        let mut invalidations = client.subscribe();
        let follower = follow_orbit_tasks(&tokio::runtime::Handle::current(), client.clone());
        let mut status = follower.status();

        let subscribe = timeout(Duration::from_secs(5), subscribed_rx).await;
        let subscribe = subscribe.ok().and_then(Result::ok).unwrap_or_default();
        assert_eq!(subscribe["data"]["channel"], CHANNEL);
        assert_eq!(subscribe["data"]["auth"], "signed");
        let seen = transport.seen.lock().map(|s| s.clone()).unwrap_or_default();
        assert_eq!(seen.len(), 2);
        assert_eq!((seen[0].path.as_str(), seen[0].root), ("/realtime", true));
        assert_eq!(seen[1].method, GatewayMethod::Post);
        assert_eq!(
            seen[1]
                .body
                .as_deref()
                .and_then(|b| serde_json::from_str::<Value>(b).ok()),
            Some(json!({ "socket_id": "123.456", "channel_name": CHANNEL }))
        );

        let live = timeout(
            Duration::from_secs(5),
            status.wait_for(|s| *s == TasksLiveStatus::Live),
        )
        .await;
        assert!(live.is_ok_and(|r| r.is_ok()));
        // The subscription's own list refresh and the burst of notices coalesce into one read.
        let first = timeout(Duration::from_secs(2), invalidations.recv()).await;
        assert_eq!(
            first.ok().and_then(Result::ok),
            Some(TasksInvalidation::List)
        );
        let quiet = timeout(Duration::from_millis(600), invalidations.recv()).await;
        assert!(quiet.is_err(), "{quiet:?}");

        drop(follower);
        server.abort();
    }

    #[tokio::test]
    async fn falls_back_to_polling_when_realtime_is_unavailable() {
        struct Refusing;
        impl GatewayTransport for Refusing {
            fn send(
                &self,
                _: GatewayRequest,
            ) -> BoxFuture<'_, Result<GatewayResponse, GatewayError>> {
                Box::pin(async {
                    Ok(GatewayResponse {
                        status: 403,
                        body: "{}".to_owned(),
                    })
                })
            }
        }
        let client = OrbitTasksClient::new(Arc::new(Refusing));
        let follower = follow_orbit_tasks(&tokio::runtime::Handle::current(), client);
        let mut status = follower.status();
        let polling = timeout(
            Duration::from_secs(2),
            status.wait_for(|s| *s == TasksLiveStatus::Polling),
        )
        .await;
        assert!(polling.is_ok_and(|r| r.is_ok()));
    }
}
