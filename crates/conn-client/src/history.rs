//! On-demand thread history paging (`GET /api/orchestration/threads/:id/history`)
//! and single turn-item hydration (`orchestration.getTurnItem`).

use std::time::Duration;

use conn_contract::{
    ORCHESTRATION_PROTOCOL_VERSION, OrchestrationV2GetTurnItemInput,
    OrchestrationV2ThreadHistoryPage, OrchestrationV2TurnItem,
};
use reqwest::StatusCode;
use url::Url;

use crate::{ClientError, Connection};

const ORCHESTRATION_PROTOCOL_HEADER: &str = "x-t3-orchestration-protocol";
const HISTORY_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const TAG_GET_TURN_ITEM: &str = "orchestration.getTurnItem";

/// Builds `GET {http_base_url}/api/orchestration/threads/{thread_id}/history?cursor={cursor}`
/// with proper path-segment and query-value percent-encoding.
///
/// # Errors
///
/// Returns [`ClientError::Connection`] if `http_base_url` cannot be a base URL.
pub fn build_thread_history_url(
    http_base_url: &Url,
    thread_id: &str,
    cursor: &str,
) -> Result<Url, ClientError> {
    let mut url = http_base_url.clone();
    url.set_query(None);
    url.set_fragment(None);
    {
        let mut segments = url.path_segments_mut().map_err(|()| {
            ClientError::Connection(format!(
                "server url cannot be a base: {}",
                http_base_url.as_str()
            ))
        })?;
        segments.pop_if_empty();
        segments.extend(["api", "orchestration", "threads", thread_id, "history"]);
    }
    url.query_pairs_mut().append_pair("cursor", cursor);
    Ok(url)
}

impl Connection {
    /// Fetches one older page of timeline items for `thread_id` starting at `cursor` via
    /// `GET {base_url}/api/orchestration/threads/{thread_id}/history?cursor={urlencoded_cursor}`.
    ///
    /// Safe to await from any async executor (including GPUI's main executor).
    ///
    /// # Errors
    ///
    /// Returns [`ClientError::Auth`] if the server rejects credentials (`401`/`403`),
    /// [`ClientError::Codec`] if the response JSON cannot be decoded as
    /// [`OrchestrationV2ThreadHistoryPage`], or [`ClientError::Connection`] on URL, network,
    /// or non-success HTTP status errors.
    pub async fn fetch_thread_history_page(
        &self,
        thread_id: &str,
        cursor: &str,
    ) -> Result<OrchestrationV2ThreadHistoryPage, ClientError> {
        let url = build_thread_history_url(&self.http_base_url, thread_id, cursor)?;
        let http = self.http.clone();
        let bearer = self.bearer.read().ok().and_then(|g| g.clone());

        self.run_on_tokio(
            async move {
                let mut req = http
                    .get(url)
                    .timeout(HISTORY_REQUEST_TIMEOUT)
                    .header(reqwest::header::ACCEPT, "application/json")
                    .header(
                        ORCHESTRATION_PROTOCOL_HEADER,
                        ORCHESTRATION_PROTOCOL_VERSION.to_string(),
                    );
                if let Some(token) = bearer {
                    req = req.bearer_auth(token);
                }

                let resp = req.send().await.map_err(|err| {
                    ClientError::Connection(format!("thread history request: {err}"))
                })?;
                let status = resp.status();
                if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
                    let body = resp.text().await.unwrap_or_default();
                    let detail = if body.is_empty() {
                        format!("thread history unauthorized ({status})")
                    } else {
                        format!("thread history unauthorized ({status}): {body}")
                    };
                    return Err(ClientError::Auth(detail));
                }
                if !status.is_success() {
                    let body = resp.text().await.unwrap_or_default();
                    let detail = if body.is_empty() {
                        format!("thread history request failed ({status})")
                    } else {
                        format!("thread history request failed ({status}): {body}")
                    };
                    return Err(ClientError::Connection(detail));
                }

                let bytes = resp.bytes().await.map_err(|err| {
                    ClientError::Connection(format!("thread history body: {err}"))
                })?;
                Ok(serde_json::from_slice(&bytes)?)
            },
            "thread history",
        )
        .await
    }

    /// Fetches a single turn item (e.g., to hydrate a deferred or compacted item body) via
    /// the typed `orchestration.getTurnItem` RPC.
    ///
    /// # Errors
    ///
    /// Returns [`ClientError::Codec`] if payload/response serialization fails, or any RPC or
    /// transport error from [`Self::call`].
    pub async fn get_turn_item(
        &self,
        thread_id: &str,
        item_id: &str,
        revision: Option<&str>,
    ) -> Result<Option<OrchestrationV2TurnItem>, ClientError> {
        let payload = OrchestrationV2GetTurnItemInput {
            thread_id: thread_id.to_owned(),
            item_id: item_id.to_owned(),
            revision: revision.map(str::to_owned),
        };
        let result = self
            .call::<conn_contract::rpc::orchestration::get_turn_item::Payload, conn_contract::rpc::orchestration::get_turn_item::Success>(
                TAG_GET_TURN_ITEM,
                &payload,
            )
            .await?;
        Ok(result.item)
    }
}

#[cfg(test)]
mod tests {
    use conn_contract::{
        OrchestrationV2ProjectedTurnItemVisibility, OrchestrationV2ThreadProjectionTurnItemsItem,
    };
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;
    use crate::{Credential, ServerConfig};

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    fn encodes_thread_history_url_path_and_query() -> Result<(), Box<dyn std::error::Error>> {
        let base = Url::parse("http://127.0.0.1:3773")?;
        let url = build_thread_history_url(&base, "thread-1", "cur_abc")?;
        assert_eq!(
            url.as_str(),
            "http://127.0.0.1:3773/api/orchestration/threads/thread-1/history?cursor=cur_abc",
            "simple base url must produce exact history endpoint"
        );

        let prefixed = Url::parse("https://node.example.test/prefix/?ignored=1#frag")?;
        let encoded = build_thread_history_url(&prefixed, "t/a b?", "v1+2/3=4&x=y")?;
        assert_eq!(
            encoded.as_str(),
            "https://node.example.test/prefix/api/orchestration/threads/t%2Fa%20b%3F/history?cursor=v1%2B2%2F3%3D4%26x%3Dy",
            "thread_id and cursor must be safely percent-encoded and preserve base prefix"
        );
        Ok(())
    }

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    fn deserializes_history_page_with_known_and_unknown_items()
    -> Result<(), Box<dyn std::error::Error>> {
        let raw = json!({
            "snapshotSequence": 42,
            "items": [
                {
                    "position": 0,
                    "visibility": "local",
                    "sourceThreadId": "thread-1",
                    "sourceItemId": "item-u1",
                    "item": {
                        "id": "item-u1",
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
                        "completedAt": "2026-11-22T10:00:00.000Z",
                        "updatedAt": "2026-11-22T10:00:00.000Z",
                        "createdBy": "user",
                        "creationSource": "web",
                        "type": "user_message",
                        "messageId": "msg-u1",
                        "inputIntent": "turn_start",
                        "text": "Earlier question",
                        "attachments": []
                    }
                },
                {
                    "position": 1,
                    "visibility": "local",
                    "sourceThreadId": "thread-1",
                    "sourceItemId": "item-future",
                    "item": {
                        "type": "future_item_kind",
                        "extra": 123
                    }
                }
            ],
            "nextCursor": "cursor-page-2",
            "hasMoreHistory": true
        });

        let page: OrchestrationV2ThreadHistoryPage = serde_json::from_value(raw)?;
        assert_eq!(page.snapshot_sequence, 42);
        assert_eq!(page.next_cursor.as_deref(), Some("cursor-page-2"));
        assert!(page.has_more_history);
        assert_eq!(page.items.len(), 2);
        assert_eq!(
            page.items[0].visibility,
            OrchestrationV2ProjectedTurnItemVisibility::Local
        );
        assert!(matches!(
            page.items[0].item,
            OrchestrationV2ThreadProjectionTurnItemsItem::UserMessage(_)
        ));
        assert!(matches!(
            page.items[1].item,
            OrchestrationV2ThreadProjectionTurnItemsItem::Unknown(_)
        ));
        Ok(())
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    async fn fetch_thread_history_page_sends_auth_protocol_header_and_decodes_page()
    -> Result<(), Box<dyn std::error::Error>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let body_json = serde_json::to_string(&json!({
            "snapshotSequence": 15,
            "items": [],
            "nextCursor": null,
            "hasMoreHistory": false
        }))?;
        let body_for_server = body_json.clone();

        let server = tokio::spawn(async move {
            let mut captured_requests = Vec::new();
            while captured_requests.len() < 2 {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let mut buf = vec![0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let req_text = String::from_utf8_lossy(&buf[..n]).into_owned();

                let response = if req_text.starts_with(
                    "GET /api/orchestration/threads/thread-99/history?cursor=cur%2B1%2F2%3D3 ",
                ) {
                    captured_requests.push(req_text);
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        body_for_server.len(),
                        body_for_server
                    )
                } else if req_text
                    .starts_with("GET /api/orchestration/threads/thread-99/history?cursor=cur-2 ")
                {
                    captured_requests.push(req_text);
                    "HTTP/1.1 401 Unauthorized\r\ncontent-length: 12\r\nconnection: close\r\n\r\nunauthorized"
                        .to_owned()
                } else {
                    // Connection::start also attempts /ws in the background; reject cleanly.
                    "HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                        .to_owned()
                };
                let _ = stream.write_all(response.as_bytes()).await;
            }
            captured_requests
        });

        let config = ServerConfig {
            http_base_url: Url::parse(&format!("http://{addr}"))?,
            credential: Credential::Bearer("secret-token".to_owned()),
        };
        let (conn, _events) = Connection::start(config, &tokio::runtime::Handle::current());

        let page = conn
            .fetch_thread_history_page("thread-99", "cur+1/2=3")
            .await?;
        assert_eq!(page.snapshot_sequence, 15);
        assert_eq!(page.next_cursor, None);
        assert!(!page.has_more_history);

        let err = conn.fetch_thread_history_page("thread-99", "cur-2").await;
        assert!(
            matches!(err, Err(ClientError::Auth(_))),
            "401 response must map to ClientError::Auth, got {err:?}"
        );

        conn.close();
        let requests = server.await?;
        assert!(
            !requests.is_empty(),
            "mock server must receive history HTTP request"
        );
        let first_req = &requests[0];
        let first_lower = first_req.to_ascii_lowercase();
        assert!(
            first_req.starts_with(
                "GET /api/orchestration/threads/thread-99/history?cursor=cur%2B1%2F2%3D3 HTTP/1.1"
            ),
            "request line must target encoded thread history path & cursor, got:\n{first_req}"
        );
        assert!(
            first_lower.contains("authorization: bearer secret-token"),
            "request must include bearer auth header, got:\n{first_req}"
        );
        assert!(
            first_lower.contains("x-t3-orchestration-protocol: 2"),
            "request must include orchestration protocol header, got:\n{first_req}"
        );
        Ok(())
    }
}
