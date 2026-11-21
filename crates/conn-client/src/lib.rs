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
pub mod device_hub;
mod driver;
mod wire;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

pub use crate::device_hub::{
    DEFAULT_DEVICE_HUB_BASE_PATH, DeviceHubAccess, DeviceHubVendor, mint_device_hub_access,
};

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
    Thread {
        thread_id: String,
        item: conn_contract::OrchestrationV2ThreadStreamItem,
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
        };
        (conn, events_rx)
    }

    /// Mints a short-lived media ticket (`POST /api/auth/websocket-ticket/media`) for accessing
    /// the device hub proxy (`/api/device-hub/vendor/...`) over HTTP, SSE, and WebSockets.
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
        mint_device_hub_access(
            &self.http,
            &self.http_base_url,
            &token,
            hub_base_path,
            host_id,
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

        let mut req = self
            .http
            .post(upload_url)
            .header(reqwest::header::CONTENT_TYPE, mime_type.as_str())
            .body(bytes);
        if let Some(token) = self.bearer.read().ok().and_then(|g| g.clone()) {
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

    /// Subscribes to `orchestration.subscribeShell`.
    ///
    /// Items arrive as [`ClientEvent::Shell`]. Automatically resubscribes after reconnect using
    /// the last observed sequence as `afterSequence`.
    pub fn subscribe_shell(&self) {
        let _ = self.cmd_tx.send(Command::SubscribeShell);
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
}
