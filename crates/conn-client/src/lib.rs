#![forbid(unsafe_code)]

//! Effect RPC WebSocket and HTTP client for `conn-server`.
//!
//! Uses `conn-wire` for frame codecs and `conn-contract` for typed RPC payloads/responses.
//! Runs on its own Tokio runtime (GPUI's main thread has no Tokio) and bridges events to
//! `conn-app` via bounded channels.
//!
//! API contract (`conn-app` builds against these names; keep them stable):
//! - [`ServerConfig`]: where and how to connect.
//! - [`Connection::start`]: spawns the connection on a Tokio runtime handle and returns a
//!   cloneable [`Connection`] plus a receiver of [`ClientEvent`]s.
//! - [`Connection::subscribe_shell`], [`Connection::subscribe_thread`]: streams whose items
//!   arrive as [`ClientEvent::Shell`] / [`ClientEvent::Thread`].
//! - [`Connection::call`] / [`Connection::call_json`]: unary RPCs.

mod auth;
pub mod commands;
pub mod device_hub;
mod driver;
pub mod environments;
pub mod history;
pub mod perf;
mod wire;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

pub use crate::device_hub::{
    DEFAULT_DEVICE_HUB_BASE_PATH, DeviceHubAccess, DeviceHubVendor, mint_device_hub_access,
};
pub use crate::history::build_thread_history_url;

use conn_contract::{
    AttachmentCreateUploadUrlInput, AttachmentCreateUploadUrlInputFile,
    AttachmentCreateUploadUrlInputImage, AttachmentCreateUploadUrlInputImageMimeType,
    ChatAttachment, ChatFileAttachment, ChatImageAttachment, lit,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};

use crate::driver::Command;

/// Capacity of the bounded [`ClientEvent`] channel returned by [`Connection::start`].
const EVENT_CHANNEL_CAPACITY: usize = 1024;

/// Capacity of the bounded per-stream item channel returned by [`Connection::stream_json`].
const STREAM_CHANNEL_CAPACITY: usize = 256;

const TAG_DISPATCH_COMMAND: &str = "orchestration.dispatchCommand";

/// Errors returned by the `conn-server` transport layer.
#[derive(Debug, Error)]
pub enum ClientError {
    #[error("invalid server url: {0}")]
    InvalidUrl(#[from] url::ParseError),
    #[error("connection failed: {0}")]
    Connection(String),
    #[error("wire codec error: {0}")]
    Codec(#[from] serde_json::Error),
    #[error("auth failed: {0}")]
    Auth(String),
    /// The server ended the request with a failure exit (typed error or defect), as JSON.
    #[error("rpc failed: {0}")]
    Rpc(serde_json::Value),
    #[error("connection closed")]
    Closed,
}

/// How to reach and authenticate with a `conn-server`.
#[derive(Clone, Debug)]
pub struct ServerConfig {
    /// `http://127.0.0.1:3773`
    pub http_base_url: url::Url,
    pub credential: Credential,
}

/// What the client presents to the server.
#[derive(Clone)]
pub enum Credential {
    /// A single-use pairing code (the `#token=` part of the server's `pairingUrl`). Exchanged
    /// once at `POST /oauth/token` for a bearer token.
    PairingCode(String),
    /// A bearer access token from an earlier exchange.
    Bearer(String),
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PairingCode(_) => f.write_str("PairingCode(<redacted>)"),
            Self::Bearer(_) => f.write_str("Bearer(<redacted>)"),
        }
    }
}

/// Connection lifecycle as the UI shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConnectionStatus {
    Connecting,
    Connected,
    /// Lost; retrying after a backoff.
    Reconnecting {
        attempt: u32,
    },
    Failed(String),
}

/// Everything the connection reports to the UI.
#[derive(Clone, Debug)]
pub enum ClientEvent {
    Status(ConnectionStatus),
    /// The bearer token after a pairing-code exchange, so the app can persist it.
    BearerIssued(String),
    Shell(conn_contract::OrchestrationV2ShellStreamItem),
    /// One `subscribeServerConfig` event: the config snapshot, then provider, settings and
    /// keybinding changes. Auto-resubscribed on WebSocket reconnect, which sends a new snapshot.
    ServerConfig(Box<conn_contract::ServerConfigStreamEvent>),
    Thread {
        thread_id: String,
        item: conn_contract::OrchestrationV2ThreadStreamItem,
    },
    /// Server→desktop agent panel request (`panels.requests`: `panel_open`, `database_query`,
    /// `mcp_connect`, `mcp_call`). Auto-resubscribed on WebSocket reconnect.
    PanelRequest(conn_contract::AgentPanelRequest),
    /// Live project annotation queue snapshot (`annotations.subscribe`). Auto-resubscribed on
    /// WebSocket reconnect.
    Annotations {
        project_id: String,
        annotations: Vec<conn_contract::AnnotationRecord>,
    },
    /// A stream ended or failed; the UI may resubscribe.
    StreamEnded {
        tag: String,
        key: String,
        error: Option<String>,
    },
}

/// Opaque identifier for a generic RPC stream created by [`Connection::stream_json`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct StreamId(u64);

/// Handle to a running connection. Cheap to clone; every method is non-blocking.
#[derive(Clone)]
pub struct Connection {
    cmd_tx: mpsc::UnboundedSender<Command>,
    next_stream_id: Arc<AtomicU64>,
    http_base_url: url::Url,
    bearer: Arc<RwLock<Option<String>>>,
    http: reqwest::Client,
    rt: tokio::runtime::Handle,
}

impl std::fmt::Debug for Connection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Connection")
            .field("http_base_url", &self.http_base_url.as_str())
            .finish_non_exhaustive()
    }
}

impl Connection {
    /// Spawns the connection task on `rt` and returns a cloneable [`Connection`] handle plus a
    /// bounded receiver of [`ClientEvent`]s.
    #[must_use]
    pub fn start(
        config: ServerConfig,
        rt: &tokio::runtime::Handle,
    ) -> (Self, mpsc::Receiver<ClientEvent>) {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let (events_tx, events_rx) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
        let http_base_url = config.http_base_url.clone();
        let initial_bearer = match &config.credential {
            Credential::Bearer(token) => Some(token.clone()),
            Credential::PairingCode(_) => None,
        };
        let bearer = Arc::new(RwLock::new(initial_bearer));
        let http = reqwest::Client::new();
        rt.spawn(driver::run(
            config,
            Arc::clone(&bearer),
            http.clone(),
            cmd_rx,
            events_tx,
        ));
        let conn = Self {
            cmd_tx,
            next_stream_id: Arc::new(AtomicU64::new(1)),
            http_base_url,
            bearer,
            http,
            rt: rt.clone(),
        };
        (conn, events_rx)
    }

    /// Runs a Tokio-dependent future (such as `reqwest` I/O) directly when the caller is already
    /// inside a Tokio runtime, or dispatches it onto the connection's dedicated Tokio runtime when
    /// awaited from a non-Tokio executor (such as GPUI's main thread).
    pub(crate) async fn run_on_tokio<F, T>(
        &self,
        fut: F,
        task_label: &str,
    ) -> Result<T, ClientError>
    where
        F: std::future::Future<Output = Result<T, ClientError>> + Send + 'static,
        T: Send + 'static,
    {
        if tokio::runtime::Handle::try_current().is_ok() {
            fut.await
        } else {
            self.rt.spawn(fut).await.map_err(|err| {
                ClientError::Connection(format!("{task_label} task failed: {err}"))
            })?
        }
    }

    /// Mints a short-lived media ticket (`POST /api/auth/websocket-ticket/media`) for accessing
    /// the device hub proxy (`/api/device-hub/vendor/...`) over HTTP, SSE, and WebSockets.
    ///
    /// Safe to await from any async executor (including GPUI's main executor).
    ///
    /// # Errors
    ///
    /// Returns [`ClientError::Auth`] if no bearer token has been issued yet or the server rejects
    /// it, [`ClientError::InvalidUrl`] if URL construction fails, [`ClientError::Codec`] if the
    /// response JSON is invalid, or [`ClientError::Connection`] on transport errors.
    pub async fn mint_device_hub_access(
        &self,
        hub_base_path: &str,
        host_id: Option<&str>,
    ) -> Result<DeviceHubAccess, ClientError> {
        let token = self
            .bearer
            .read()
            .ok()
            .and_then(|guard| guard.clone())
            .ok_or_else(|| {
                ClientError::Auth("no bearer token available for device hub access yet".to_owned())
            })?;
        let http = self.http.clone();
        let http_base_url = self.http_base_url.clone();
        let hub_base_path = hub_base_path.to_owned();
        let host_id = host_id.map(str::to_owned);
        self.run_on_tokio(
            async move {
                mint_device_hub_access(
                    &http,
                    &http_base_url,
                    &token,
                    &hub_base_path,
                    host_id.as_deref(),
                )
                .await
            },
            "device hub access",
        )
        .await
    }

    /// Shared HTTP client for auxiliary requests against the connected server.
    #[must_use]
    pub fn http_client(&self) -> &reqwest::Client {
        &self.http
    }

    /// Allocates a signed upload URL via `attachments.createUploadUrl`, uploads `bytes` via HTTP
    /// POST, and returns the ready [`ChatAttachment`] descriptor for `message.dispatch` or
    /// `orchestration.launchThread`.
    ///
    /// Safe to await from any async executor (including GPUI's main executor).
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] if the RPC fails, URL resolution fails, or the HTTP upload returns
    /// a non-success status.
    pub async fn upload_chat_attachment(
        &self,
        name: String,
        mime_type: String,
        bytes: Vec<u8>,
    ) -> Result<ChatAttachment, ClientError> {
        let size_bytes = i64::try_from(bytes.len()).unwrap_or(i64::MAX);
        let image_mime = match mime_type.to_ascii_lowercase().as_str() {
            "image/png" => Some(AttachmentCreateUploadUrlInputImageMimeType::ImagePng),
            "image/jpeg" | "image/jpg" => {
                Some(AttachmentCreateUploadUrlInputImageMimeType::ImageJpeg)
            }
            "image/gif" => Some(AttachmentCreateUploadUrlInputImageMimeType::ImageGif),
            "image/webp" => Some(AttachmentCreateUploadUrlInputImageMimeType::ImageWebp),
            _ => None,
        };
        let payload = match image_mime {
            Some(img_mime) => {
                AttachmentCreateUploadUrlInput::Image(AttachmentCreateUploadUrlInputImage {
                    r#type: Some(lit::Image),
                    name: name.clone(),
                    mime_type: img_mime,
                    size_bytes,
                })
            }
            None => AttachmentCreateUploadUrlInput::File(AttachmentCreateUploadUrlInputFile {
                r#type: lit::File,
                name: name.clone(),
                mime_type: mime_type.clone(),
                size_bytes,
            }),
        };

        let prepared = self
            .call::<conn_contract::rpc::attachments::create_upload_url::Payload, conn_contract::rpc::attachments::create_upload_url::Success>(
                "attachments.createUploadUrl",
                &payload,
            )
            .await?;

        let upload_url = self.http_base_url.join(&prepared.relative_url)?;
        let http = self.http.clone();
        let bearer = self.bearer.read().ok().and_then(|g| g.clone());
        let upload_mime = mime_type.clone();

        self.run_on_tokio(
            async move {
                let mut req = http
                    .post(upload_url)
                    .header(reqwest::header::CONTENT_TYPE, upload_mime.as_str())
                    .body(bytes);
                if let Some(token) = bearer {
                    req = req.bearer_auth(token);
                }
                let resp = req
                    .send()
                    .await
                    .map_err(|err| ClientError::Connection(err.to_string()))?;
                if !resp.status().is_success() {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    return Err(ClientError::Connection(format!(
                        "attachment upload failed ({status}): {body}"
                    )));
                }
                Ok(())
            },
            "attachment upload",
        )
        .await?;

        if image_mime.is_some() {
            Ok(ChatAttachment::Image(ChatImageAttachment {
                r#type: lit::Image,
                id: prepared.attachment_id,
                name,
                mime_type,
                size_bytes,
                source: None,
            }))
        } else {
            Ok(ChatAttachment::File(ChatFileAttachment {
                r#type: lit::File,
                id: prepared.attachment_id,
                name,
                mime_type,
                size_bytes,
                source: None,
            }))
        }
    }

    /// Downloads a stored chat attachment (`assets.createUrl` for an `attachment` resource,
    /// then `GET` of the signed URL), as the web client does for message thumbnails.
    ///
    /// # Errors
    /// Returns [`ClientError`] if the RPC, URL resolution or the download fails.
    pub async fn fetch_attachment_bytes(
        &self,
        attachment_id: &str,
    ) -> Result<Vec<u8>, ClientError> {
        let payload = conn_contract::AssetCreateUrlInput {
            resource: conn_contract::AssetResource::Attachment(
                conn_contract::AssetResourceAttachment {
                    tag: lit::Attachment,
                    attachment_id: attachment_id.to_owned(),
                    file_name: None,
                    mime_type: None,
                    disposition: None,
                    render_intent: None,
                },
            ),
        };
        let created = self
            .call::<conn_contract::rpc::assets::create_url::Payload, conn_contract::rpc::assets::create_url::Success>(
                "assets.createUrl",
                &payload,
            )
            .await?;
        let url = self.http_base_url.join(&created.relative_url)?;
        let http = self.http.clone();
        let bearer = self.bearer.read().ok().and_then(|g| g.clone());
        self.run_on_tokio(
            async move {
                let mut req = http.get(url);
                if let Some(token) = bearer {
                    req = req.bearer_auth(token);
                }
                let resp = req
                    .send()
                    .await
                    .map_err(|err| ClientError::Connection(err.to_string()))?;
                if !resp.status().is_success() {
                    return Err(ClientError::Connection(format!(
                        "attachment download failed ({})",
                        resp.status()
                    )));
                }
                resp.bytes()
                    .await
                    .map(|bytes| bytes.to_vec())
                    .map_err(|err| ClientError::Connection(err.to_string()))
            },
            "attachment download",
        )
        .await
    }

    /// Asks the server for a signed URL to the workspace file `path` of thread `thread_id`
    /// (`assets.createUrl`, `workspace-file`), as web Conn's file previews do.
    ///
    /// # Errors
    /// Returns [`ClientError`] if the RPC or URL resolution fails.
    pub async fn workspace_file_url(
        &self,
        thread_id: &str,
        path: &str,
    ) -> Result<url::Url, ClientError> {
        let payload = conn_contract::AssetCreateUrlInput {
            resource: conn_contract::AssetResource::WorkspaceFile(
                conn_contract::AssetResourceWorkspaceFile {
                    tag: lit::WorkspaceFile,
                    thread_id: thread_id.to_owned(),
                    path: path.to_owned(),
                },
            ),
        };
        let created = self
            .call::<conn_contract::rpc::assets::create_url::Payload, conn_contract::rpc::assets::create_url::Success>(
                "assets.createUrl",
                &payload,
            )
            .await?;
        Ok(self.http_base_url.join(&created.relative_url)?)
    }

    /// Downloads the workspace file `path` of thread `thread_id` as bytes (an image, say), through
    /// a signed asset URL.
    ///
    /// # Errors
    /// Returns [`ClientError`] if the RPC, URL resolution or the download fails.
    pub async fn fetch_workspace_file_bytes(
        &self,
        thread_id: &str,
        path: &str,
    ) -> Result<Vec<u8>, ClientError> {
        let url = self.workspace_file_url(thread_id, path).await?;
        let http = self.http.clone();
        let bearer = self.bearer.read().ok().and_then(|g| g.clone());
        self.run_on_tokio(
            async move {
                let mut req = http.get(url);
                if let Some(token) = bearer {
                    req = req.bearer_auth(token);
                }
                let resp = req
                    .send()
                    .await
                    .map_err(|err| ClientError::Connection(err.to_string()))?;
                if !resp.status().is_success() {
                    return Err(ClientError::Connection(format!(
                        "file download failed ({})",
                        resp.status()
                    )));
                }
                resp.bytes()
                    .await
                    .map(|bytes| bytes.to_vec())
                    .map_err(|err| ClientError::Connection(err.to_string()))
            },
            "workspace file download",
        )
        .await
    }

    /// Subscribes to `orchestration.subscribeShell`.
    ///
    /// Items arrive as [`ClientEvent::Shell`]. Automatically resubscribes after reconnect using
    /// the last observed sequence as `afterSequence`.
    pub fn subscribe_shell(&self) {
        let _ = self.cmd_tx.send(Command::SubscribeShell);
    }

    /// Subscribes to `subscribeServerConfig`, which sends the server config and then every
    /// provider status change.
    ///
    /// Items arrive as [`ClientEvent::ServerConfig`]. Automatically resubscribes after reconnect;
    /// the server then sends a fresh snapshot.
    pub fn subscribe_server_config(&self) {
        let _ = self.cmd_tx.send(Command::SubscribeServerConfig);
    }

    /// Subscribes to `orchestration.subscribeThread` for `thread_id`.
    ///
    /// Items arrive as [`ClientEvent::Thread`]. Automatically resubscribes after reconnect using
    /// the last observed sequence as `afterSequence`.
    pub fn subscribe_thread(&self, thread_id: &str) {
        let _ = self
            .cmd_tx
            .send(Command::SubscribeThread(thread_id.to_owned()));
    }

    /// Interrupts and removes the thread subscription for `thread_id`.
    pub fn unsubscribe_thread(&self, thread_id: &str) {
        let _ = self
            .cmd_tx
            .send(Command::UnsubscribeThread(thread_id.to_owned()));
    }

    /// Subscribes to `panels.requests` as a first-class auto-resubscribed stream so agent panel
    /// calls (`panel_open`, `database_query`, `mcp_connect`, `mcp_call`) resume immediately on
    /// WebSocket reconnect with zero retry gap.
    pub fn subscribe_panel_requests(&self, device_name: Option<String>) {
        let _ = self
            .cmd_tx
            .send(Command::SubscribePanelRequests(device_name));
    }

    /// Stops listening to `panels.requests`.
    pub fn unsubscribe_panel_requests(&self) {
        let _ = self.cmd_tx.send(Command::UnsubscribePanelRequests);
    }

    /// Subscribes to `annotations.subscribe` for `project_id`, auto-resubscribing on reconnect.
    pub fn subscribe_annotations(&self, project_id: &str) {
        let _ = self
            .cmd_tx
            .send(Command::SubscribeAnnotations(project_id.to_owned()));
    }

    /// Stops listening to `annotations.subscribe` for `project_id`.
    pub fn unsubscribe_annotations(&self, project_id: &str) {
        let _ = self
            .cmd_tx
            .send(Command::UnsubscribeAnnotations(project_id.to_owned()));
    }

    /// Calls a unary RPC method with raw JSON payload and response.
    ///
    /// Safe to await from any async executor (including GPUI's main executor).
    ///
    /// # Errors
    ///
    /// Returns [`ClientError::Rpc`] if the server ends the request with a failure exit,
    /// [`ClientError::Connection`] if the socket disconnects mid-call, or [`ClientError::Closed`]
    /// if the connection task has shut down.
    pub async fn call_json(&self, tag: &str, payload: Value) -> Result<Value, ClientError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::Call {
                tag: tag.to_owned(),
                payload,
                reply: reply_tx,
            })
            .map_err(|_| ClientError::Closed)?;
        reply_rx.await.map_err(|_| ClientError::Closed)?
    }

    /// Calls a typed unary RPC method.
    ///
    /// Safe to await from any async executor (including GPUI's main executor).
    ///
    /// # Errors
    ///
    /// Returns [`ClientError::Codec`] if serialization or deserialization fails, or any transport
    /// or RPC error from [`Self::call_json`].
    pub async fn call<P: Serialize, R: DeserializeOwned>(
        &self,
        tag: &str,
        payload: &P,
    ) -> Result<R, ClientError> {
        let payload_json = serde_json::to_value(payload)?;
        let response_json = self.call_json(tag, payload_json).await?;
        Ok(serde_json::from_value(response_json)?)
    }

    /// Dispatches an orchestration v2 command via `orchestration.dispatchCommand`.
    ///
    /// Safe to await from any async executor (including GPUI's main executor).
    ///
    /// # Errors
    ///
    /// Returns [`ClientError::Codec`] if serialization fails, or any transport or RPC error from
    /// [`Self::call_json`].
    pub async fn dispatch_command(
        &self,
        command: conn_contract::OrchestrationV2Command,
    ) -> Result<Value, ClientError> {
        let payload = serde_json::to_value(&command)?;
        self.call_json(TAG_DISPATCH_COMMAND, payload).await
    }

    /// Starts a generic streaming RPC call, returning a [`StreamId`] and a bounded receiver of
    /// raw JSON items.
    ///
    /// Dropping the receiver or calling [`Self::cancel_stream`] sends a `FromClient::Interrupt`
    /// to the server.
    #[must_use]
    pub fn stream_json(&self, tag: &str, payload: Value) -> (StreamId, mpsc::Receiver<Value>) {
        let stream_id = StreamId(self.next_stream_id.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = mpsc::channel(STREAM_CHANNEL_CAPACITY);
        let _ = self.cmd_tx.send(Command::StartStream {
            stream_id,
            tag: tag.to_owned(),
            payload,
            tx,
        });
        (stream_id, rx)
    }

    /// Cancels an active stream started by [`Self::stream_json`].
    pub fn cancel_stream(&self, stream_id: StreamId) {
        let _ = self.cmd_tx.send(Command::CancelStream(stream_id));
    }

    /// Drops any current WebSocket session or reconnect backoff sleep and reconnects immediately,
    /// preserving subscriptions and stream sequence cursors.
    pub fn reconnect(&self) {
        let _ = self.cmd_tx.send(Command::Reconnect);
    }

    /// Cleanly closes the connection and stops its background task.
    pub fn close(&self) {
        let _ = self.cmd_tx.send(Command::Close);
    }
}

const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Connection>();
    assert_send_sync::<ClientError>();
    assert_send_sync::<ServerConfig>();
    assert_send_sync::<ClientEvent>();
    assert_send_sync::<StreamId>();
    assert_send_sync::<DeviceHubAccess>();
    assert_send_sync::<DeviceHubVendor>();
};

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use conn_wire::{Exit, FromClient, FromServer, RequestId, encode_server_frame, frame_parts};
    use futures::{SinkExt, StreamExt};
    use serde_json::json;
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;
    use tokio_tungstenite::tungstenite::Message;

    use super::*;

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    async fn sends_ack_for_split_chunks_handles_unary_and_interrupts_stream()
    -> Result<(), Box<dyn std::error::Error>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let (seen_tx, mut seen_rx) = mpsc::unbounded_channel::<FromClient>();

        let server_task = tokio::spawn(async move {
            let Ok((tcp, _)) = listener.accept().await else {
                return;
            };
            let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
                return;
            };

            while let Some(Ok(Message::Text(text))) = ws.next().await {
                let Ok(frames) = conn_wire::decode_client_message(&text) else {
                    continue;
                };
                for frame in frames {
                    let _ = seen_tx.send(frame.clone());
                    if let FromClient::Request(req) = frame {
                        match req.tag.as_str() {
                            "test.echo" => {
                                let reply = FromServer::Exit {
                                    request_id: req.id,
                                    exit: Exit::success(json!({ "ok": true, "in": req.payload })),
                                };
                                let _ = ws
                                    .send(Message::Text(encode_server_frame(&reply).into()))
                                    .await;
                            }
                            "test.fail" => {
                                let reply = FromServer::Exit {
                                    request_id: req.id,
                                    exit: Exit::fail(json!({ "_tag": "Boom" })),
                                };
                                let _ = ws
                                    .send(Message::Text(encode_server_frame(&reply).into()))
                                    .await;
                            }
                            "test.stream" => {
                                let big = "a".repeat(200);
                                let chunk = FromServer::Chunk {
                                    request_id: req.id,
                                    values: vec![json!({ "chunk": 1, "pad": big })],
                                };
                                let raw = encode_server_frame(&chunk);
                                for part in frame_parts::split(&raw, 64) {
                                    let _ = ws.send(Message::Text(part.into())).await;
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        });

        let config = ServerConfig {
            http_base_url: url::Url::parse(&format!("http://{addr}"))?,
            credential: Credential::Bearer("test-bearer".to_owned()),
        };
        let (conn, mut events) = Connection::start(config, &tokio::runtime::Handle::current());

        // Wait for Connected.
        let mut connected = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            if let Ok(Some(ClientEvent::Status(ConnectionStatus::Connected))) =
                tokio::time::timeout(Duration::from_secs(1), events.recv()).await
            {
                connected = true;
                break;
            }
        }
        assert!(connected, "client must reach Connected status");

        // Unary success.
        let echo = conn.call_json("test.echo", json!({ "n": 7 })).await?;
        assert_eq!(
            echo,
            json!({ "ok": true, "in": { "n": 7 } }),
            "unary call_json must return server success value"
        );

        // Unary failure.
        let err = conn.call_json("test.fail", json!({})).await;
        assert!(
            matches!(err, Err(ClientError::Rpc(_))),
            "failure exit must map to ClientError::Rpc, got {err:?}"
        );

        // Split stream chunk -> verify item arrives, Ack is sent, and cancel_stream sends Interrupt.
        let (stream_id, mut stream_rx) = conn.stream_json("test.stream", json!({}));
        let item = tokio::time::timeout(Duration::from_secs(5), stream_rx.recv())
            .await?
            .ok_or("stream closed before yielding item")?;
        assert_eq!(
            item["chunk"],
            json!(1),
            "reassembled split chunk item must reach stream receiver"
        );

        conn.cancel_stream(stream_id);

        let mut saw_ack = false;
        let mut saw_interrupt = false;
        let check_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < check_deadline && !(saw_ack && saw_interrupt) {
            if let Ok(Some(frame)) =
                tokio::time::timeout(Duration::from_millis(500), seen_rx.recv()).await
            {
                match frame {
                    FromClient::Ack {
                        request_id: RequestId::Number(_),
                    } => saw_ack = true,
                    FromClient::Interrupt {
                        request_id: RequestId::Number(_),
                    } => saw_interrupt = true,
                    _ => {}
                }
            }
        }
        assert!(saw_ack, "client must send Ack after receiving a Chunk");
        assert!(
            saw_interrupt,
            "client must send Interrupt when cancel_stream is called"
        );

        conn.close();
        let _ = tokio::time::timeout(Duration::from_secs(2), server_task).await;
        Ok(())
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    async fn preserves_after_sequence_across_thread_resubscribe_sets_bounded_flag_and_gets_turn_item()
    -> Result<(), Box<dyn std::error::Error>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let (sub_payloads_tx, mut sub_payloads_rx) = mpsc::unbounded_channel::<Value>();
        let (turn_item_req_tx, mut turn_item_req_rx) = mpsc::unbounded_channel::<Value>();

        let server_task = tokio::spawn(async move {
            let Ok((tcp, _)) = listener.accept().await else {
                return;
            };
            let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
                return;
            };

            let mut sub_count = 0usize;
            while let Some(Ok(Message::Text(text))) = ws.next().await {
                let Ok(frames) = conn_wire::decode_client_message(&text) else {
                    continue;
                };
                for frame in frames {
                    if let FromClient::Request(req) = frame {
                        match req.tag.as_str() {
                            "orchestration.subscribeThread" => {
                                sub_count += 1;
                                let _ = sub_payloads_tx.send(req.payload.clone());
                                if sub_count == 1 {
                                    // Send a minimal event advancing sequence to 42, then synchronized.
                                    let chunk = FromServer::Chunk {
                                        request_id: req.id,
                                        values: vec![
                                            json!({
                                                "kind": "event",
                                                "sequence": 42,
                                                "event": {
                                                    "type": "custom.noop",
                                                    "payload": null
                                                }
                                            }),
                                            json!({ "kind": "synchronized" }),
                                        ],
                                    };
                                    let _ = ws
                                        .send(Message::Text(encode_server_frame(&chunk).into()))
                                        .await;
                                } else {
                                    let chunk = FromServer::Chunk {
                                        request_id: req.id,
                                        values: vec![json!({ "kind": "synchronized" })],
                                    };
                                    let _ = ws
                                        .send(Message::Text(encode_server_frame(&chunk).into()))
                                        .await;
                                }
                            }
                            "orchestration.getTurnItem" => {
                                let _ = turn_item_req_tx.send(req.payload.clone());
                                let reply = FromServer::Exit {
                                    request_id: req.id,
                                    exit: Exit::success(json!({
                                        "item": {
                                            "id": "item-9",
                                            "threadId": "thread-1",
                                            "runId": "run-1",
                                            "nodeId": null,
                                            "providerThreadId": null,
                                            "providerTurnId": null,
                                            "nativeItemRef": null,
                                            "parentItemId": null,
                                            "ordinal": 1,
                                            "status": "completed",
                                            "title": null,
                                            "startedAt": "2026-11-22T10:00:00.000Z",
                                            "completedAt": "2026-11-22T10:00:01.000Z",
                                            "updatedAt": "2026-11-22T10:00:01.000Z",
                                            "type": "assistant_message",
                                            "messageId": "msg-9",
                                            "text": "Hydrated body",
                                            "streaming": false
                                        }
                                    })),
                                };
                                let _ = ws
                                    .send(Message::Text(encode_server_frame(&reply).into()))
                                    .await;
                            }
                            _ => {}
                        }
                    }
                }
            }
        });

        let config = ServerConfig {
            http_base_url: url::Url::parse(&format!("http://{addr}"))?,
            credential: Credential::Bearer("test-bearer".to_owned()),
        };
        let (conn, mut events) = Connection::start(config, &tokio::runtime::Handle::current());

        // Subscribe first time -> acceptBoundedSnapshot=true, no acceptDeferredWork, no afterSequence.
        conn.subscribe_thread("thread-1");
        let first_sub = tokio::time::timeout(Duration::from_secs(5), sub_payloads_rx.recv())
            .await?
            .ok_or("missing first subscribeThread payload")?;
        assert_eq!(first_sub["threadId"], json!("thread-1"));
        assert_eq!(
            first_sub["acceptBoundedSnapshot"],
            json!(true),
            "subscribeThread must set acceptBoundedSnapshot=true"
        );
        assert!(
            first_sub.get("acceptDeferredWork").is_none(),
            "acceptDeferredWork must remain unset for now"
        );
        assert!(
            first_sub.get("afterSequence").is_none(),
            "initial subscribeThread must omit afterSequence"
        );

        // Wait until the client observes the sequence=42 event and Synchronized.
        let mut saw_sync = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            if let Ok(Some(ClientEvent::Thread {
                thread_id,
                item: conn_contract::OrchestrationV2ThreadStreamItem::Synchronized(_),
            })) = tokio::time::timeout(Duration::from_secs(1), events.recv()).await
                && thread_id == "thread-1"
            {
                saw_sync = true;
                break;
            }
        }
        assert!(saw_sync, "client must receive Synchronized for thread-1");

        // Switch away and back -> must preserve afterSequence=42!
        conn.unsubscribe_thread("thread-1");
        conn.subscribe_thread("thread-1");
        let second_sub = tokio::time::timeout(Duration::from_secs(5), sub_payloads_rx.recv())
            .await?
            .ok_or("missing second subscribeThread payload")?;
        assert_eq!(
            second_sub["afterSequence"],
            json!(42),
            "resubscribing after unsubscribe must preserve last observed afterSequence"
        );
        assert_eq!(
            second_sub["acceptBoundedSnapshot"],
            json!(true),
            "resubscribe must keep acceptBoundedSnapshot=true"
        );

        // Typed orchestration.getTurnItem RPC.
        let item = conn
            .get_turn_item("thread-1", "item-9", Some("rev-1"))
            .await?;
        let req_payload = tokio::time::timeout(Duration::from_secs(5), turn_item_req_rx.recv())
            .await?
            .ok_or("missing getTurnItem payload")?;
        assert_eq!(
            req_payload,
            json!({
                "threadId": "thread-1",
                "itemId": "item-9",
                "revision": "rev-1"
            })
        );
        assert!(
            matches!(
                item,
                Some(conn_contract::OrchestrationV2TurnItem::AssistantMessage(ref m))
                    if m.id == "item-9" && m.text == "Hydrated body"
            ),
            "get_turn_item must decode assistant item, got {item:?}"
        );

        conn.close();
        let _ = tokio::time::timeout(Duration::from_secs(2), server_task).await;
        Ok(())
    }

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! while propagating setup errors with ?"
    )]
    fn upload_chat_attachment_succeeds_from_non_tokio_executor()
    -> Result<(), Box<dyn std::error::Error>> {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        // Mirrors GPUI: Connection runs on a dedicated Tokio runtime while the caller awaits
        // `upload_chat_attachment` from a thread with no Tokio runtime entered.
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;

        let (addr, upload_rx, server_handle) = rt.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await?;
            let addr = listener.local_addr()?;
            let (upload_tx, upload_rx) = oneshot::channel::<(String, Vec<u8>)>();
            let handle = tokio::spawn(async move {
                let mut upload_tx = Some(upload_tx);
                for _ in 0..4 {
                    let Ok((mut tcp, _)) = listener.accept().await else {
                        break;
                    };
                    let mut peek = [0u8; 64];
                    let Ok(n) = tcp.peek(&mut peek).await else {
                        continue;
                    };
                    let head = String::from_utf8_lossy(&peek[..n]);
                    if head.starts_with("POST /api/attachments/upload/tok-img ") {
                        let mut raw = Vec::new();
                        let mut buf = [0u8; 4096];
                        let header_end = loop {
                            let Ok(read) = tcp.read(&mut buf).await else {
                                return;
                            };
                            if read == 0 {
                                return;
                            }
                            raw.extend_from_slice(&buf[..read]);
                            if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                                break pos + 4;
                            }
                        };
                        let headers = String::from_utf8_lossy(&raw[..header_end]).into_owned();
                        let content_len: usize = headers
                            .lines()
                            .find_map(|line| {
                                let (k, v) = line.split_once(':')?;
                                k.eq_ignore_ascii_case("content-length")
                                    .then(|| v.trim().parse().ok())
                                    .flatten()
                            })
                            .unwrap_or(0);
                        while raw.len() < header_end + content_len {
                            let Ok(read) = tcp.read(&mut buf).await else {
                                break;
                            };
                            if read == 0 {
                                break;
                            }
                            raw.extend_from_slice(&buf[..read]);
                        }
                        let body = raw[header_end..header_end + content_len].to_vec();
                        if let Some(tx) = upload_tx.take() {
                            let _ = tx.send((headers, body));
                        }
                        let _ = tcp
                            .write_all(
                                b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
                            )
                            .await;
                        break;
                    }
                    // WebSocket upgrade for RPC (`attachments.createUploadUrl`).
                    tokio::spawn(async move {
                        let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
                            return;
                        };
                        while let Some(Ok(Message::Text(text))) = ws.next().await {
                            let Ok(frames) = conn_wire::decode_client_message(&text) else {
                                continue;
                            };
                            for frame in frames {
                                if let FromClient::Request(req) = frame
                                    && req.tag == "attachments.createUploadUrl"
                                {
                                    let reply = FromServer::Exit {
                                        request_id: req.id,
                                        exit: Exit::success(json!({
                                            "attachmentId": "att-img-1",
                                            "relativeUrl": "/api/attachments/upload/tok-img",
                                            "expiresAt": 1_900_000_000_000_i64
                                        })),
                                    };
                                    let _ = ws
                                        .send(Message::Text(encode_server_frame(&reply).into()))
                                        .await;
                                }
                            }
                        }
                    });
                }
            });
            Ok::<_, std::io::Error>((addr, upload_rx, handle))
        })?;

        let config = ServerConfig {
            http_base_url: url::Url::parse(&format!("http://{addr}"))?,
            credential: Credential::Bearer("test-bearer".to_owned()),
        };
        let (conn, mut events) = Connection::start(config, rt.handle());

        rt.block_on(async {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while tokio::time::Instant::now() < deadline {
                if let Ok(Some(ClientEvent::Status(ConnectionStatus::Connected))) =
                    tokio::time::timeout(Duration::from_secs(1), events.recv()).await
                {
                    return Ok(());
                }
            }
            Err("client did not reach Connected status")
        })?;

        // Poll on a non-Tokio executor (no Tokio reactor entered on this thread!).
        assert!(
            tokio::runtime::Handle::try_current().is_err(),
            "test thread must not have an entered Tokio runtime"
        );
        let png_bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        let attachment = futures::executor::block_on(conn.upload_chat_attachment(
            "screenshot.png".to_owned(),
            "image/png".to_owned(),
            png_bytes.clone(),
        ))?;

        match attachment {
            ChatAttachment::Image(img) => {
                assert_eq!(img.id, "att-img-1");
                assert_eq!(img.name, "screenshot.png");
                assert_eq!(img.mime_type, "image/png");
                assert_eq!(img.size_bytes, i64::try_from(png_bytes.len())?);
            }
            other => panic!("expected ChatAttachment::Image, got {other:?}"),
        }

        let (headers, body) = rt.block_on(async {
            Ok::<_, Box<dyn std::error::Error>>(
                tokio::time::timeout(Duration::from_secs(5), upload_rx).await??,
            )
        })?;
        assert_eq!(body, png_bytes, "uploaded image bytes must match");
        let lower_headers = headers.to_ascii_lowercase();
        assert!(
            lower_headers.contains("content-type: image/png"),
            "upload must send image/png Content-Type:\n{headers}"
        );
        assert!(
            lower_headers.contains("authorization: bearer test-bearer"),
            "upload must send bearer authorization:\n{headers}"
        );

        conn.close();
        let _ = rt
            .block_on(async { tokio::time::timeout(Duration::from_secs(2), server_handle).await });
        Ok(())
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! while propagating setup errors with ?"
    )]
    async fn reconnect_reestablishes_session_and_restores_subscriptions()
    -> Result<(), Box<dyn std::error::Error>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let (accept_tx, mut accept_rx) = mpsc::unbounded_channel::<usize>();

        let server = tokio::spawn(async move {
            for session_idx in 1..=2 {
                let Ok((tcp, _)) = listener.accept().await else {
                    return;
                };
                let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
                    return;
                };
                let _ = accept_tx.send(session_idx);
                while let Some(Ok(msg)) = ws.next().await {
                    if matches!(msg, Message::Close(_)) {
                        break;
                    }
                }
            }
        });

        let config = ServerConfig {
            http_base_url: url::Url::parse(&format!("http://{addr}"))?,
            credential: Credential::Bearer("test-bearer".to_owned()),
        };
        let (conn, mut events) = Connection::start(config, &tokio::runtime::Handle::current());
        conn.subscribe_shell();

        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), accept_rx.recv()).await?,
            Some(1),
            "first session should connect"
        );
        // Wait for Connected event from session 1.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            if let Ok(Some(ClientEvent::Status(ConnectionStatus::Connected))) =
                tokio::time::timeout(Duration::from_secs(1), events.recv()).await
            {
                break;
            }
        }

        conn.reconnect();

        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), accept_rx.recv()).await?,
            Some(2),
            "reconnect() must establish a fresh WebSocket session immediately"
        );

        let mut reconnected = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            if let Ok(Some(ClientEvent::Status(ConnectionStatus::Connected))) =
                tokio::time::timeout(Duration::from_secs(1), events.recv()).await
            {
                reconnected = true;
                break;
            }
        }
        assert!(
            reconnected,
            "reconnect() must emit Connected for the new session"
        );

        conn.close();
        let _ = tokio::time::timeout(Duration::from_secs(2), server).await;
        Ok(())
    }
}
