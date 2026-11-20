//! Asset, attachment and file download routes. Owner: the files track.
//!
//! - `GET /api/assets/<token>/<name>`: a file `assets.createUrl` signed. The token is the
//!   credential, as in `apps/server/src/http.ts`; no bearer. Streams the file, with `Range`.
//! - `POST /api/attachments/upload/<token>`: the bytes of an upload `attachments.createUploadUrl`
//!   signed. Streams to a `.part` file, never holding the body in memory.

use std::{
    io::SeekFrom,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};

use axum::{
    Router,
    body::{Body, Bytes},
    extract::{Path, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use conn_files::{Files, Served, assets, attachments};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, ReadBuf};

use crate::AppState;

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/assets/{token}/{*name}", get(asset))
        .route("/api/attachments/upload/{token}", post(upload))
}

fn files(state: &AppState) -> Option<Arc<Files>> {
    state.deps.files.clone()
}

fn text(status: StatusCode, body: &'static str) -> Response {
    (status, body).into_response()
}

async fn asset(
    State(state): State<AppState>,
    uri: Uri,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let Some(files) = files(&state) else {
        return text(StatusCode::NOT_FOUND, "Not Found");
    };
    // The raw path: the name is percent-decoded once, by `resolve_asset`.
    let Some((token, name)) = uri
        .path()
        .strip_prefix("/api/assets/")
        .and_then(|rest| rest.split_once('/'))
        .map(|(token, name)| (token.to_owned(), name.to_owned()))
    else {
        return text(StatusCode::NOT_FOUND, "Not Found");
    };
    let resolved = tokio::task::spawn_blocking(move || {
        files.resolve_asset(&token, &name, attachments::now_ms())
    })
    .await
    .ok()
    .flatten();
    match resolved {
        None => text(StatusCode::NOT_FOUND, "Not Found"),
        Some(Served::Bytes { bytes, mime_type }) => (
            [
                (header::CONTENT_TYPE, mime_type),
                (header::CACHE_CONTROL, "private, max-age=3600"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            bytes,
        )
            .into_response(),
        Some(Served::File {
            path,
            download,
            file_name,
            mime_type,
            render_intent,
            identity,
        }) => {
            if render_intent.is_some() && !download {
                return serve_mcp_app_html(
                    &path,
                    file_name.as_deref(),
                    mime_type.as_deref(),
                    method == Method::HEAD,
                )
                .await
                .unwrap_or_else(|| {
                    text(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
                });
            }
            let range = (method == Method::GET && !headers.contains_key(header::IF_RANGE))
                .then(|| headers.get(header::RANGE).and_then(|v| v.to_str().ok()))
                .flatten()
                .map(str::to_owned);
            serve_file(
                &path,
                download,
                file_name,
                mime_type,
                identity,
                range,
                method == Method::HEAD,
            )
            .await
            .unwrap_or_else(|| text(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"))
        }
    }
}

async fn serve_mcp_app_html(
    path: &std::path::Path,
    name: Option<&str>,
    mime: Option<&str>,
    head: bool,
) -> Option<Response> {
    let file = tokio::fs::File::open(path).await.ok()?;
    let mut bytes = Vec::new();
    const PREVIEW_LIMIT: usize = 5 * 1024 * 1024 + 128 * 1024;
    file.take((PREVIEW_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .ok()?;
    if bytes.len() > PREVIEW_LIMIT {
        return Some(text(
            StatusCode::PAYLOAD_TOO_LARGE,
            "MCP app is too large to preview.",
        ));
    }
    let html = conn_files::mcp_apps::bootstrap(&String::from_utf8_lossy(&bytes));
    let mut headers = HeaderMap::new();
    for (name, value) in assets::response_headers(path, assets::Disposition::Inline, name, mime) {
        headers.insert(name, HeaderValue::from_str(&value).ok()?);
    }
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(html.len()));
    Some(
        (
            StatusCode::OK,
            headers,
            if head { String::new() } else { html },
        )
            .into_response(),
    )
}

#[cfg(target_os = "linux")]
const NONBLOCK: i32 = 0o4000;
#[cfg(all(unix, not(target_os = "linux")))]
const NONBLOCK: i32 = 0x0004;

async fn serve_file(
    path: &std::path::Path,
    download: bool,
    file_name: Option<String>,
    mime_type: Option<String>,
    identity: Option<(u64, u64)>,
    range: Option<String>,
    head: bool,
) -> Option<Response> {
    let mut options = tokio::fs::OpenOptions::new();
    options.read(true);
    // A FIFO swapped in after the checks must not hold the request open (T3: `O_NONBLOCK`).
    #[cfg(unix)]
    options.custom_flags(NONBLOCK);
    let mut file = options.open(path).await.ok()?;
    let meta = file.metadata().await.ok()?;
    if !meta.is_file() {
        return Some(text(StatusCode::NOT_FOUND, "Not Found"));
    }
    #[cfg(unix)]
    if let Some((device, inode)) = identity {
        use std::os::unix::fs::MetadataExt;
        if meta.dev() != device || meta.ino() != inode {
            return Some(text(StatusCode::NOT_FOUND, "Not Found"));
        }
        // A pinned file is served only from its canonical path, checked after the open: a
        // parent folder swapped for a link is refused, as in T3's `openMediaFile`.
        if tokio::fs::canonicalize(path).await.ok().as_deref() != Some(path) {
            return Some(text(StatusCode::NOT_FOUND, "Not Found"));
        }
    }
    let size = meta.len();
    let mut response_headers = HeaderMap::new();
    for (name, value) in assets::response_headers(
        path,
        if download {
            assets::Disposition::Download
        } else {
            assets::Disposition::Inline
        },
        file_name.as_deref(),
        mime_type.as_deref(),
    ) {
        if let Ok(value) = HeaderValue::from_str(&value) {
            response_headers.insert(name, value);
        }
    }
    response_headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    let media = response_headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| {
            let t = t.to_ascii_lowercase();
            t.starts_with("audio/") || t.starts_with("video/")
        });
    if media {
        response_headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-store"),
        );
    }
    let mut status = StatusCode::OK;
    let (mut offset, mut length) = (0, size);
    if let Some(range) = range {
        match assets::byte_range(&range, size) {
            Err(assets::Unsatisfiable) => {
                if let Ok(v) = HeaderValue::from_str(&format!("bytes */{size}")) {
                    response_headers.insert(header::CONTENT_RANGE, v);
                }
                return Some((StatusCode::RANGE_NOT_SATISFIABLE, response_headers).into_response());
            }
            Ok(Some((start, len))) => {
                status = StatusCode::PARTIAL_CONTENT;
                (offset, length) = (start, len);
                let range = format!("bytes {start}-{}/{size}", start + len - 1);
                response_headers.insert(header::CONTENT_RANGE, HeaderValue::from_str(&range).ok()?);
            }
            Ok(None) => {}
        }
    }
    response_headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    if head || length == 0 {
        return Some((status, response_headers).into_response());
    }
    if offset > 0 {
        file.seek(SeekFrom::Start(offset)).await.ok()?;
    }
    let body = Body::from_stream(FileStream {
        file,
        remaining: length,
    });
    Some((status, response_headers, body).into_response())
}

/// Reads a file in 64 KiB chunks as the response body; one chunk is in memory at a time.
struct FileStream {
    file: tokio::fs::File,
    remaining: u64,
}

impl futures_core::Stream for FileStream {
    type Item = std::io::Result<Bytes>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.remaining == 0 {
            return Poll::Ready(None);
        }
        let mut chunk = vec![0u8; self.remaining.min(64 * 1024) as usize];
        let mut buf = ReadBuf::new(&mut chunk);
        match Pin::new(&mut self.file).poll_read(cx, &mut buf) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(e)) => Poll::Ready(Some(Err(e))),
            Poll::Ready(Ok(())) => {
                let n = buf.filled().len();
                if n == 0 {
                    // The file shrank under us; end rather than send a short body silently.
                    self.remaining = 0;
                    return Poll::Ready(Some(Err(std::io::ErrorKind::UnexpectedEof.into())));
                }
                self.remaining -= n as u64;
                chunk.truncate(n);
                Poll::Ready(Some(Ok(Bytes::from(chunk))))
            }
        }
    }
}

async fn upload(
    State(state): State<AppState>,
    Path(token): Path<String>,
    request: Request,
) -> Response {
    let Some(files) = files(&state) else {
        return text(StatusCode::NOT_FOUND, "Not Found");
    };
    let Some(claims) =
        files
            .attachments
            .verify_upload(&files.signer, &token, attachments::now_ms())
    else {
        return text(StatusCode::NOT_FOUND, "Not Found");
    };
    if let Some(length) = request.headers().get(header::CONTENT_LENGTH)
        && length.to_str().ok().and_then(|l| l.parse::<u64>().ok()) != Some(claims.size_bytes)
    {
        return text(
            StatusCode::BAD_REQUEST,
            "Content-Length must match the upload size.",
        );
    }
    let Some((part, target)) = files.attachments.upload_paths(&claims) else {
        return text(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to resolve attachment path.",
        );
    };
    let received = match receive(request.into_body(), &part, claims.size_bytes).await {
        Ok(received) => received,
        Err(_) => {
            let _ = tokio::fs::remove_file(&part).await;
            return text(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to persist upload.",
            );
        }
    };
    let expected = claims.size_bytes;
    let outcome = tokio::task::spawn_blocking(move || {
        files
            .attachments
            .publish_upload(&part, &target, received, expected)
    })
    .await;
    match outcome {
        Ok(attachments::UploadOutcome::Stored) => StatusCode::NO_CONTENT.into_response(),
        Ok(attachments::UploadOutcome::Rejected { status, detail }) => (
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            detail,
        )
            .into_response(),
        Err(_) => text(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to persist upload.",
        ),
    }
}

/// Writes the body to `part`, stopping once it exceeds `limit`. Returns the bytes received
/// (more than `limit` means too many).
async fn receive(body: Body, part: &std::path::Path, limit: u64) -> std::io::Result<u64> {
    use futures_core::Stream;
    let mut stream = body.into_data_stream();
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(part)
        .await?;
    let mut received = 0u64;
    while let Some(chunk) = std::future::poll_fn(|cx| Pin::new(&mut stream).poll_next(cx)).await {
        let chunk = chunk.map_err(std::io::Error::other)?;
        received += chunk.len() as u64;
        if received > limit {
            break;
        }
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok(received)
}

#[cfg(test)]
mod mcp_app_asset_tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn app_assets_keep_csp_add_bootstraps_and_bound_reads_for_get_and_head() {
        let dir = std::env::temp_dir().join(format!("conn-app-asset-{}", conn_support::uuid_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("app.html");
        tokio::fs::write(&path,"<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'\"><h1>App</h1>").await.unwrap();
        let response = serve_mcp_app_html(&path, None, Some("text/html"), false)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!response.headers().contains_key(header::ACCEPT_RANGES));
        assert_eq!(
            response.headers()[header::CONTENT_SECURITY_POLICY],
            "sandbox allow-scripts allow-forms allow-popups allow-downloads"
        );
        let length = response.headers()[header::CONTENT_LENGTH].clone();
        let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let body = String::from_utf8(body.to_vec()).unwrap();
        assert!(body.find("Content-Security-Policy").unwrap() < body.find("<script>").unwrap());
        assert!(body.contains("document.cookie"));
        assert!(body.contains("t3-color-scheme"));
        let head = serve_mcp_app_html(&path, None, Some("text/html"), true)
            .await
            .unwrap();
        assert_eq!(head.headers()[header::CONTENT_LENGTH], length);
        assert!(
            axum::body::to_bytes(head.into_body(), 1)
                .await
                .unwrap()
                .is_empty()
        );
        let source = "a".repeat(5 * 1024 * 1024);
        let store = conn_files::AttachmentStore::new(dir.clone());
        let reference = tokio::task::spawn_blocking(move || {
            store.snapshot_mcp_app(
                "thread",
                "server",
                "tool",
                "ui://app",
                &serde_json::json!([{"mimeType":"text/html;profile=mcp-app","text":source}]),
            )
        })
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        let snapshot = dir.join(format!(
            "{}.html",
            reference["attachmentId"].as_str().unwrap()
        ));
        assert_eq!(
            serve_mcp_app_html(&snapshot, None, Some("text/html"), true)
                .await
                .unwrap()
                .status(),
            StatusCode::OK,
            "a max-sized snapshot includes CSP overhead"
        );
        let file = tokio::fs::File::create(&path).await.unwrap();
        file.set_len(5 * 1024 * 1024 + 128 * 1024 + 1)
            .await
            .unwrap();
        assert_eq!(
            serve_mcp_app_html(&path, None, Some("text/html"), false)
                .await
                .unwrap()
                .status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }
}
