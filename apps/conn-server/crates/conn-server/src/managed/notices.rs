//! The Reverb subscription that wakes the target on a removal: the Pusher protocol over a
//! TLS WebSocket that trusts the lab Orbit CA only, on the private channel of the current
//! generation, signed through the Gateway's target-only `/broadcasting/auth`.
//!
//! A notice only restricts access: it fences the named edges provisionally and asks for a
//! probe. It never renews the lease or admits anything. Managed access stays closed while this
//! link is down: a closed link fails closed, and recovery needs the link and a fresh snapshot
//! (the fail-closed reading of the contract's "closed control connection").

use std::{sync::Arc, time::Duration};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

use super::{
    Shared,
    authority::Notice,
    gateway::{Gateway, connect_tls},
};

/// Wait before reconnecting after the link drops.
const RECONNECT_AFTER: Duration = Duration::from_secs(1);
/// The longest wait for the handshake and the subscription.
const SUBSCRIBE_TIMEOUT: Duration = Duration::from_secs(5);
pub const EVENT: &str = "conn.authority.revoked";

/// Runs the link for the life of the process.
pub async fn run(
    shared: Arc<Shared>,
    gateway: Arc<dyn Gateway>,
    tls: Arc<rustls::ClientConfig>,
    generation: u64,
) {
    loop {
        let result = link(&shared, &gateway, &tls, generation).await;
        shared.set_notice_link(false);
        if let Err(reason) = result {
            eprintln!("conn-server: managed notice link closed: {reason}");
        }
        tokio::time::sleep(RECONNECT_AFTER).await;
    }
}

/// Whether `channel` is a target channel of `generation`.
pub fn is_target_channel(channel: &str, generation: u64) -> bool {
    channel
        .strip_prefix("private-conn-target.")
        .and_then(|rest| rest.rsplit_once('.'))
        .is_some_and(|(target, g)| {
            !target.is_empty()
                && target.bytes().all(|b| b.is_ascii_digit())
                && g == generation.to_string()
        })
}

/// The `data` of a Pusher message: a JSON string, or JSON already.
fn data(message: &Value) -> Option<Value> {
    match message.get("data")? {
        Value::String(text) => serde_json::from_str(text).ok(),
        other => Some(other.clone()),
    }
}

async fn link(
    shared: &Arc<Shared>,
    gateway: &Arc<dyn Gateway>,
    tls: &Arc<rustls::ClientConfig>,
    generation: u64,
) -> Result<(), String> {
    let realtime = gateway.realtime().await.map_err(|e| e.to_string())?;
    let text = |key: &str| {
        realtime
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| format!("realtime has no {key}"))
    };
    let (url, key, channel) = (text("url")?, text("key")?, text("channel")?);
    if !is_target_channel(&channel, generation) {
        return Err("realtime named another generation's channel".into());
    }
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "wss" | "https") {
        return Err("realtime must be TLS".into());
    }
    let host = parsed.host_str().ok_or("realtime has no host")?.to_owned();
    let port = parsed.port_or_known_default().unwrap_or(443);
    let path = format!(
        "wss://{host}:{port}{}/app/{key}?protocol=7&client=conn-server&version=1&flash=false",
        parsed.path().trim_end_matches('/')
    );
    let request = path.into_client_request().map_err(|e| e.to_string())?;
    // One deadline for TCP, TLS and the WebSocket handshake: a peer that stalls any of them
    // cannot hold the reconnect loop.
    let (mut socket, _) = tokio::time::timeout(SUBSCRIBE_TIMEOUT, async {
        let stream = connect_tls(&host, port, tls.clone())
            .await
            .map_err(|e| e.to_string())?;
        tokio_tungstenite::client_async(request, stream)
            .await
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "handshake timeout".to_owned())??;

    let next_json = |message: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>| -> Result<Option<Value>, String> {
        match message {
            Some(Ok(Message::Text(text))) => Ok(serde_json::from_str(text.as_str()).ok()),
            Some(Ok(Message::Close(_))) | None => Err("closed".into()),
            Some(Ok(_)) => Ok(None),
            Some(Err(e)) => Err(e.to_string()),
        }
    };
    let subscribe = async {
        let mut activity = 30u64;
        loop {
            let Some(message) = next_json(socket.next().await)? else {
                continue;
            };
            match message.get("event").and_then(Value::as_str) {
                Some("pusher:connection_established") => {
                    let established = data(&message).ok_or("no connection data")?;
                    let socket_id = established
                        .get("socket_id")
                        .and_then(Value::as_str)
                        .ok_or("no socket id")?
                        .to_owned();
                    activity = established
                        .get("activity_timeout")
                        .and_then(Value::as_u64)
                        .unwrap_or(30)
                        .clamp(5, 120);
                    let auth = gateway
                        .broadcasting_auth(socket_id, channel.clone())
                        .await
                        .map_err(|e| e.to_string())?;
                    let auth = auth
                        .get("auth")
                        .and_then(Value::as_str)
                        .ok_or("no channel auth")?
                        .to_owned();
                    let frame = json!({
                        "event": "pusher:subscribe",
                        "data": { "channel": channel, "auth": auth },
                    });
                    socket
                        .send(Message::Text(frame.to_string().into()))
                        .await
                        .map_err(|e| e.to_string())?;
                }
                Some("pusher_internal:subscription_succeeded")
                    if message.get("channel").and_then(Value::as_str) == Some(&channel) =>
                {
                    return Ok::<u64, String>(activity);
                }
                Some("pusher:error") => return Err("reverb refused".to_owned()),
                _ => {}
            }
        }
    };
    let activity = tokio::time::timeout(SUBSCRIBE_TIMEOUT, subscribe)
        .await
        .map_err(|_| "subscribe timeout".to_owned())??;
    shared.set_notice_link(true);

    let mut ping = crate::http::check_every(Duration::from_secs(activity));
    ping.tick().await;
    let mut awaiting_pong = false;
    loop {
        tokio::select! {
            message = socket.next() => {
                let Some(message) = next_json(message)? else { continue };
                match message.get("event").and_then(Value::as_str) {
                    Some(EVENT) if message.get("channel").and_then(Value::as_str) == Some(&channel) => {
                        if let Some(notice) = data(&message).and_then(|d| serde_json::from_value::<Notice>(d).ok()) {
                            shared.notice(&notice);
                        }
                    }
                    Some("pusher:ping") => {
                        let pong = json!({"event": "pusher:pong", "data": {}});
                        socket.send(Message::Text(pong.to_string().into())).await.map_err(|e| e.to_string())?;
                    }
                    Some("pusher:pong") => awaiting_pong = false,
                    Some("pusher:error") => return Err("reverb error".into()),
                    _ => {}
                }
            }
            _ = ping.tick() => {
                if awaiting_pong {
                    return Err("reverb stopped answering".into());
                }
                awaiting_pong = true;
                let frame = json!({"event": "pusher:ping", "data": {}});
                socket.send(Message::Text(frame.to_string().into())).await.map_err(|e| e.to_string())?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels_of_the_current_generation_only() {
        assert!(is_target_channel("private-conn-target.7.3", 3));
        assert!(!is_target_channel("private-conn-target.7.2", 3));
        assert!(!is_target_channel("private-conn-target..3", 3));
        assert!(!is_target_channel("private-orbit.7.3", 3));
    }
}
