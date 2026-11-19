//! `/api/device-hub/*`: the Device panel's streams, input and screenshots, proxied to the hub of
//! the device host (`DeviceHubProxy.ts`). The hub listens on loopback only and runs shell
//! commands for whoever reaches it, so only the allow-listed paths pass: streams with
//! `orchestration:read`, input and stream tuning with `orchestration:operate`. A media ticket
//! is used up here and never forwarded. Bodies stream through with backpressure: nothing is
//! buffered beyond one chunk and, for MJPEG, the last frame.

use std::{collections::HashMap, time::Duration};

use axum::{
    Router,
    body::{Body, Bytes},
    extract::{
        FromRequestParts, State, WebSocketUpgrade,
        ws::{CloseFrame, Message as ClientMessage},
    },
    http::{HeaderMap, HeaderValue, Request, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use conn_devices::proxy::{self, Decision, PartTracker};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt as _;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{self, Message as HubMessage, client::IntoClientRequest};

use crate::AppState;

const PREFIX: &str = conn_devices::model::HUB_BASE_PATH;
const STILL_FRAME_DELAY: Duration = Duration::from_millis(100);

pub(super) fn router() -> Router<AppState> {
    Router::new().route(&format!("{PREFIX}/{{*rest}}"), any(handle))
}

fn text(status: StatusCode, body: &'static str) -> Response {
    (status, [(header::CONTENT_TYPE, "text/plain")], body).into_response()
}

/// The query the hub gets: the ticket and the host stay here. Names are matched decoded, as
/// auth reads them (`URLSearchParams.delete`), so `ws%54icket` is consumed too.
fn upstream_search(raw_query: &str) -> String {
    let kept: Vec<&str> = raw_query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .filter(|pair| {
            let name = conn_support::url::form_decode(pair.split('=').next().unwrap_or_default());
            name != "wsTicket" && name != "hostId"
        })
        .collect();
    if kept.is_empty() {
        String::new()
    } else {
        format!("?{}", kept.join("&"))
    }
}

async fn handle(State(state): State<AppState>, request: Request<Body>) -> Response {
    let Some(devices) = state.deps.devices.clone() else {
        return text(StatusCode::NOT_FOUND, "Not Found");
    };
    let path = request.uri().path().to_owned();
    let hub_path = match path.strip_prefix(PREFIX) {
        Some("") | None => "/".to_owned(),
        Some(rest) => rest.to_owned(),
    };
    let upgrade = request
        .headers()
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    let method = request.method().as_str().to_owned();
    let operate = match proxy::decide(&hub_path, &method, upgrade) {
        Decision::NotFound => return text(StatusCode::NOT_FOUND, "Not Found"),
        Decision::MethodNotAllowed => {
            return text(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed");
        }
        Decision::Forward { operate } => operate,
    };
    let raw_query = request.uri().query().unwrap_or_default().to_owned();
    let query: HashMap<String, String> = conn_support::url::search_params(&raw_query)
        .into_iter()
        .collect();
    let Some(principal) =
        crate::http::authenticate_upgrade(&state, &query, request.headers(), "media")
    else {
        let reason = if query.contains_key("wsTicket")
            || request.headers().contains_key(header::AUTHORIZATION)
        {
            "invalid_credential"
        } else {
            "missing_credential"
        };
        return crate::http::auth_invalid(reason);
    };
    let scope = if operate {
        "orchestration:operate"
    } else {
        "orchestration:read"
    };
    if !principal.has_scope(scope) {
        return crate::http::scope_required(scope);
    }
    let session_id = principal.session_id.clone();
    let Some((host_id, origin)) = devices.hub_origin(query.get("hostId").map(String::as_str))
    else {
        return text(StatusCode::SERVICE_UNAVAILABLE, "Device hub is not running");
    };
    let search = upstream_search(&raw_query);
    if let Some(device) = query.get("device").filter(|_| {
        hub_path == "/vendor/serve-sim/api/screenshot"
            || hub_path == "/vendor/serve-emu/api/screenshot"
    }) {
        return match devices.screenshot(Some(&host_id), device).await {
            Ok((_, png)) => Response::builder()
                .header(header::CONTENT_TYPE, "image/png")
                .header(header::CACHE_CONTROL, "no-store, no-transform")
                .body(Body::from(png))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
            Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.message()).into_response(),
        };
    }
    let upstream = format!("{origin}{hub_path}{search}");
    let auth = state.auth.clone();
    let revoked = async move { crate::http::revoked(&auth, &session_id).await };
    if upgrade {
        let (mut parts, _) = request.into_parts();
        let Ok(ws) = WebSocketUpgrade::from_request_parts(&mut parts, &()).await else {
            return text(StatusCode::BAD_REQUEST, "Bad Request");
        };
        return proxy_ws(ws, upstream.replacen("http", "ws", 1), revoked);
    }
    proxy_http(request, &origin, &upstream, revoked).await
}

async fn proxy_http(
    request: Request<Body>,
    origin: &str,
    upstream: &str,
    revoked: impl std::future::Future<Output = ()> + Send + 'static,
) -> Response {
    let (parts, body) = request.into_parts();
    let read_only = parts.method == "GET" || parts.method == "HEAD";
    let mut builder = Request::builder()
        .method(parts.method.clone())
        .uri(upstream);
    for (name, value) in &parts.headers {
        if proxy::drops_request_header(name.as_str()) {
            continue;
        }
        if name == header::ORIGIN {
            // serve-emu refuses mutations whose Origin differs from the request origin.
            builder = builder.header(name, origin);
            continue;
        }
        builder = builder.header(name, value);
    }
    builder = builder.header(header::HOST, origin.trim_start_matches("http://"));
    let body = if read_only { Body::empty() } else { body };
    let Ok(upstream_request) = builder.body(body) else {
        return text(StatusCode::BAD_REQUEST, "Bad Request");
    };
    let response = match conn_devices::http::send(upstream_request).await {
        Ok(response) => response,
        Err(_) => return text(StatusCode::BAD_GATEWAY, "Bad Gateway"),
    };
    let status = response.status();
    let mut headers = HeaderMap::new();
    for (name, value) in response.headers() {
        if !proxy::drops_response_header(name.as_str()) {
            headers.append(name.clone(), value.clone());
        }
    }
    // Long MJPEG and AVCC answers must not be buffered by compression.
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-transform"),
    );
    let mjpeg = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("multipart/x-mixed-replace"));
    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(1);
    tokio::spawn(pump(response.into_body(), tx, mjpeg, revoked));
    let mut out = Response::new(Body::from_stream(Chunks(rx)));
    *out.status_mut() = status;
    *out.headers_mut() = headers;
    out
}

struct Chunks(mpsc::Receiver<Result<Bytes, std::io::Error>>);

impl futures_core::Stream for Chunks {
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        self.0.poll_recv(cx)
    }
}

/// Copies the hub's body to the client, one chunk at a time. For MJPEG it sends the last frame
/// again once the stream is quiet for 100 ms: a browser paints a part only when the next one
/// starts, and the hub writes one only when the screen changes.
async fn pump(
    mut body: hyper::body::Incoming,
    tx: mpsc::Sender<Result<Bytes, std::io::Error>>,
    mjpeg: bool,
    revoked: impl std::future::Future<Output = ()> + Send,
) {
    tokio::pin!(revoked);
    let mut tracker = mjpeg.then(PartTracker::default);
    loop {
        let still = tracker.as_ref().and_then(|t| t.still.clone());
        let next = tokio::select! {
            () = &mut revoked => return,
            () = tx.closed() => return,
            frame = body.frame() => Some(frame),
            () = tokio::time::sleep(STILL_FRAME_DELAY), if still.is_some() => None,
        };
        let Some(frame) = next else {
            if let (Some(tracker), Some(parts)) = (tracker.as_mut(), still) {
                tracker.still = None;
                for part in parts {
                    if tx.send(Ok(part)).await.is_err() {
                        return;
                    }
                }
            }
            continue;
        };
        match frame {
            None => return,
            Some(Err(error)) => {
                let _ = tx.send(Err(std::io::Error::other(error.to_string()))).await;
                return;
            }
            Some(Ok(frame)) => {
                let Ok(data) = frame.into_data() else {
                    continue;
                };
                if let Some(tracker) = tracker.as_mut() {
                    tracker.feed(&data);
                }
                if tx.send(Ok(data)).await.is_err() {
                    return;
                }
            }
        }
    }
}

fn proxy_ws(
    ws: WebSocketUpgrade,
    upstream: String,
    revoked: impl std::future::Future<Output = ()> + Send + 'static,
) -> Response {
    ws.max_message_size(16 * 1024 * 1024)
        .max_frame_size(16 * 1024 * 1024)
        .on_upgrade(move |client| async move {
            let Ok(request) = upstream.as_str().into_client_request() else {
                return;
            };
            let address = upstream
                .trim_start_matches("ws://")
                .split('/')
                .next()
                .unwrap_or_default()
                .to_owned();
            let connected = tokio::time::timeout(Duration::from_secs(10), async {
                let stream = tokio::net::TcpStream::connect(&address).await.ok()?;
                tokio_tungstenite::client_async(request, stream).await.ok()
            })
            .await
            .ok()
            .flatten();
            let Some((hub, _)) = connected else {
                return;
            };
            let (mut client_tx, mut client_rx) = client.split();
            let (mut hub_tx, mut hub_rx) = hub.split();
            let down = async {
                while let Some(Ok(message)) = hub_rx.next().await {
                    let Some(message) = to_client(message) else {
                        continue;
                    };
                    if client_tx.send(message).await.is_err() {
                        break;
                    }
                }
            };
            let up = async {
                while let Some(Ok(message)) = client_rx.next().await {
                    let Some(message) = to_hub(message) else {
                        continue;
                    };
                    if hub_tx.send(message).await.is_err() {
                        break;
                    }
                }
            };
            tokio::select! {
                () = down => {}
                () = up => {}
                () = revoked => {}
            }
        })
}

fn to_client(message: HubMessage) -> Option<ClientMessage> {
    Some(match message {
        HubMessage::Text(text) => ClientMessage::Text(text.as_str().into()),
        HubMessage::Binary(data) => ClientMessage::Binary(data),
        HubMessage::Ping(data) => ClientMessage::Ping(data),
        HubMessage::Pong(data) => ClientMessage::Pong(data),
        HubMessage::Close(frame) => ClientMessage::Close(frame.map(|f| CloseFrame {
            code: f.code.into(),
            reason: f.reason.as_str().into(),
        })),
        HubMessage::Frame(_) => return None,
    })
}

fn to_hub(message: ClientMessage) -> Option<HubMessage> {
    Some(match message {
        ClientMessage::Text(text) => HubMessage::Text(text.as_str().into()),
        ClientMessage::Binary(data) => HubMessage::Binary(data),
        ClientMessage::Ping(data) => HubMessage::Ping(data),
        ClientMessage::Pong(data) => HubMessage::Pong(data),
        ClientMessage::Close(frame) => {
            HubMessage::Close(frame.map(|f| tungstenite::protocol::CloseFrame {
                code: f.code.into(),
                reason: f.reason.as_str().into(),
            }))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Auth decodes parameter names, so the strip must too: an encoded `wsTicket` name
    /// authenticates and must not reach the hub.
    #[test]
    fn strips_credentials_by_their_decoded_names() {
        assert_eq!(
            upstream_search("device=A&ws%54icket=secret&host%49d=mac&wsTicket=s2&a+b=1"),
            "?device=A&a+b=1",
            "decoded names"
        );
        assert_eq!(upstream_search("wsTicket=secret"), "", "only credentials");
    }
}
