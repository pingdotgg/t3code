use std::time::Duration;

use conn_contract::{
    ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION,
    OrchestrationV2ShellStreamItem, OrchestrationV2ThreadStreamItem,
};
use conn_wire::{FromClient, FromServer, frame_parts};
use serde::Deserialize;
use serde_json::value::RawValue;
use url::Url;

use crate::ClientError;

/// Maximum reassembled WebSocket message size (512 MiB) so long threads with thousands of
/// items and embedded screenshots reassemble without disconnecting the session.
pub(crate) const MAX_JOINED_MESSAGE_BYTES: usize = 512 * 1024 * 1024;

/// Initial reconnect backoff delay.
pub(crate) const INITIAL_BACKOFF: Duration = Duration::from_millis(250);

/// Maximum reconnect backoff delay.
pub(crate) const MAX_BACKOFF: Duration = Duration::from_secs(10);

/// Encodes one client wire frame to JSON text.
pub(crate) fn encode_client_frame(frame: &FromClient) -> Result<String, serde_json::Error> {
    serde_json::to_string(frame)
}

/// Decoded server message with `Chunk` payloads kept as raw JSON slices so huge thread
/// snapshots deserialize directly from `&str` into typed contract structs in a single pass
/// (avoiding intermediate `serde_json::Value` DOM trees).
#[derive(Debug)]
pub(crate) enum IncomingServerFrame {
    Chunk {
        request_id: conn_wire::RequestId,
        values: Vec<Box<RawValue>>,
    },
    Other(FromServer),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawChunkEnvelope {
    #[serde(rename = "_tag")]
    tag: String,
    #[serde(default)]
    request_id: Option<conn_wire::RequestId>,
    #[serde(default)]
    values: Option<Vec<Box<RawValue>>>,
}

fn decode_one_raw_frame(raw: &str) -> Result<IncomingServerFrame, serde_json::Error> {
    // Fast-path `"Chunk"` frames without building a `serde_json::Value` DOM tree.
    if let Ok(env) = serde_json::from_str::<RawChunkEnvelope>(raw)
        && env.tag == "Chunk"
        && let (Some(request_id), Some(values)) = (env.request_id, env.values)
    {
        return Ok(IncomingServerFrame::Chunk { request_id, values });
    }
    Ok(IncomingServerFrame::Other(serde_json::from_str(raw)?))
}

/// Decodes one server WebSocket text message (single JSON frame or JSON array of frames)
/// in a single pass without building intermediate `serde_json::Value` trees for `Chunk`s.
pub(crate) fn decode_server_message_raw(
    text: &str,
) -> Result<Vec<IncomingServerFrame>, serde_json::Error> {
    if text.trim_start().starts_with('[') {
        let items: Vec<Box<RawValue>> = serde_json::from_str(text)?;
        items
            .into_iter()
            .map(|raw| decode_one_raw_frame(raw.get()))
            .collect()
    } else {
        Ok(vec![decode_one_raw_frame(text)?])
    }
}

/// Decodes one server WebSocket text message into [`FromServer`] frames (used by tests).
#[cfg(test)]
pub(crate) fn decode_server_message(text: &str) -> Result<Vec<FromServer>, serde_json::Error> {
    if text.trim_start().starts_with('[') {
        serde_json::from_str::<Vec<FromServer>>(text)
    } else {
        Ok(vec![serde_json::from_str::<FromServer>(text)?])
    }
}

/// Builds `ws(s)://host:port/ws?orchestrationProtocol=2&frameParts=1` from an HTTP(S) base URL.
pub(crate) fn build_ws_url(http_base_url: &Url) -> Result<Url, ClientError> {
    let mut ws_url = http_base_url.join("ws")?;
    let ws_scheme = match ws_url.scheme() {
        "http" | "ws" => "ws",
        "https" | "wss" => "wss",
        other => {
            return Err(ClientError::Connection(format!(
                "unsupported server url scheme: {other}"
            )));
        }
    };
    ws_url
        .set_scheme(ws_scheme)
        .map_err(|()| ClientError::Connection(format!("failed to set scheme {ws_scheme}")))?;
    ws_url
        .query_pairs_mut()
        .clear()
        .append_pair(
            ORCHESTRATION_PROTOCOL_QUERY_PARAM,
            &ORCHESTRATION_PROTOCOL_VERSION.to_string(),
        )
        .append_pair(frame_parts::QUERY_PARAM, "1");
    Ok(ws_url)
}

/// Extracts the latest sequence number from a shell stream item, if the item carries one.
pub(crate) fn extract_shell_sequence(item: &OrchestrationV2ShellStreamItem) -> Option<i64> {
    match item {
        OrchestrationV2ShellStreamItem::Snapshot(s) => Some(s.snapshot.snapshot_sequence),
        OrchestrationV2ShellStreamItem::ProjectUpdated(p) => Some(p.sequence),
        OrchestrationV2ShellStreamItem::ProjectRemoved(p) => Some(p.sequence),
        OrchestrationV2ShellStreamItem::ThreadUpdated(t) => Some(t.sequence),
        OrchestrationV2ShellStreamItem::ThreadRemoved(t) => Some(t.sequence),
        OrchestrationV2ShellStreamItem::Synchronized(_)
        | OrchestrationV2ShellStreamItem::SnapshotRequired(_) => None,
    }
}

/// Extracts the latest sequence number from a thread stream item, if the item carries one.
pub(crate) fn extract_thread_sequence(item: &OrchestrationV2ThreadStreamItem) -> Option<i64> {
    match item {
        OrchestrationV2ThreadStreamItem::Snapshot(s) => Some(s.snapshot_sequence),
        OrchestrationV2ThreadStreamItem::Event(e) => Some(e.sequence),
        OrchestrationV2ThreadStreamItem::Event2(e) => Some(e.sequence),
        OrchestrationV2ThreadStreamItem::Synchronized(_) => None,
    }
}

/// Exponential reconnect backoff starting at 250ms and capped at 10s.
#[derive(Debug, Clone)]
pub(crate) struct Backoff {
    attempt: u32,
}

impl Backoff {
    pub(crate) const fn new() -> Self {
        Self { attempt: 0 }
    }

    pub(crate) fn reset(&mut self) {
        self.attempt = 0;
    }

    /// Advances the attempt counter (starting at 1) and returns `(attempt, delay)`.
    pub(crate) fn next_delay(&mut self) -> (u32, Duration) {
        let shift = self.attempt.min(16);
        let multiplier = 1u32.checked_shl(shift).unwrap_or(u32::MAX);
        let delay = INITIAL_BACKOFF.saturating_mul(multiplier).min(MAX_BACKOFF);
        self.attempt = self.attempt.saturating_add(1);
        (self.attempt, delay)
    }
}

#[cfg(test)]
mod tests {
    use conn_wire::{Exit, Request, RequestId, frame_parts};
    use serde_json::{Value, json};

    use super::*;

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    fn encodes_and_decodes_client_and_server_frames() -> Result<(), Box<dyn std::error::Error>> {
        let req = FromClient::Request(Request {
            id: RequestId::Number(1),
            tag: "server.getConfig".to_owned(),
            payload: json!({}),
            headers: Vec::new(),
            is_notification: None,
            discard: None,
            trace_id: None,
            span_id: None,
            sampled: None,
        });
        let encoded = encode_client_frame(&req)?;
        let decoded_client = conn_wire::decode_client_message(&encoded)?;
        assert_eq!(
            decoded_client,
            vec![req],
            "encoded client request must round-trip through conn_wire"
        );

        let ack = FromClient::Ack {
            request_id: RequestId::Number(7),
        };
        let ack_json: Value = serde_json::from_str(&encode_client_frame(&ack)?)?;
        assert_eq!(
            ack_json,
            json!({"_tag": "Ack", "requestId": 7}),
            "ack frame must use camelCase requestId"
        );

        let single_server = r#"{"_tag":"Pong"}"#;
        assert_eq!(
            decode_server_message(single_server)?,
            vec![FromServer::Pong],
            "single server frame must decode"
        );

        let batch_server = r#"[
            {"_tag":"Chunk","requestId":1,"values":[{"kind":"synchronized"}]},
            {"_tag":"Exit","requestId":1,"exit":{"_tag":"Success","value":{}}}
        ]"#;
        let frames = decode_server_message(batch_server)?;
        assert_eq!(
            frames,
            vec![
                FromServer::Chunk {
                    request_id: RequestId::Number(1),
                    values: vec![json!({"kind": "synchronized"})],
                },
                FromServer::Exit {
                    request_id: RequestId::Number(1),
                    exit: Exit::success(json!({})),
                },
            ],
            "batched server frames array must decode in order"
        );
        Ok(())
    }

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    fn reassembles_split_server_frames() -> Result<(), Box<dyn std::error::Error>> {
        let large_text = "x".repeat(256);
        let chunk = FromServer::Chunk {
            request_id: RequestId::Number(42),
            values: vec![json!({"kind": "synchronized", "note": large_text})],
        };
        let raw = conn_wire::encode_server_frame(&chunk);
        let parts = frame_parts::split(&raw, 64);
        assert!(
            parts.len() > 2,
            "expected frame to split into multiple parts, got {}",
            parts.len()
        );

        let mut joiner = frame_parts::Joiner::new(MAX_JOINED_MESSAGE_BYTES);
        let mut reassembled = None;
        for (idx, part) in parts.iter().enumerate() {
            let out = joiner.push(part);
            assert!(
                out.is_ok(),
                "part {idx} should not exceed max joined message bytes"
            );
            if let Ok(some) = out {
                if idx + 1 < parts.len() {
                    assert!(
                        some.is_none(),
                        "intermediate part {idx} must not complete the frame"
                    );
                } else {
                    reassembled = some;
                }
            }
        }
        let Some(whole) = reassembled else {
            return Err("final part did not produce reassembled message".into());
        };
        let decoded = decode_server_message(&whole)?;
        assert_eq!(
            decoded,
            vec![chunk],
            "reassembled frame must decode back to original Chunk"
        );
        Ok(())
    }

    #[test]
    fn backoff_doubles_and_caps_at_ten_seconds() {
        let mut backoff = Backoff::new();
        let expected = [
            (1, Duration::from_millis(250)),
            (2, Duration::from_millis(500)),
            (3, Duration::from_secs(1)),
            (4, Duration::from_secs(2)),
            (5, Duration::from_secs(4)),
            (6, Duration::from_secs(8)),
            (7, Duration::from_secs(10)),
            (8, Duration::from_secs(10)),
        ];
        for (want_attempt, want_delay) in expected {
            let got = backoff.next_delay();
            assert_eq!(
                got,
                (want_attempt, want_delay),
                "backoff step {want_attempt} mismatch"
            );
        }
        backoff.reset();
        assert_eq!(
            backoff.next_delay(),
            (1, Duration::from_millis(250)),
            "backoff must restart from 250ms after reset"
        );
    }

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    fn builds_ws_url_for_http_and_https() -> Result<(), Box<dyn std::error::Error>> {
        let http = Url::parse("http://127.0.0.1:3773")?;
        assert_eq!(
            build_ws_url(&http)?.as_str(),
            "ws://127.0.0.1:3773/ws?orchestrationProtocol=2&frameParts=1",
            "http base url must map to ws with protocol=2 and frameParts=1"
        );

        let https = Url::parse("https://conn.example.com/sub/")?;
        assert_eq!(
            build_ws_url(&https)?.as_str(),
            "wss://conn.example.com/sub/ws?orchestrationProtocol=2&frameParts=1",
            "https base url with subpath must map to wss"
        );
        Ok(())
    }
}
