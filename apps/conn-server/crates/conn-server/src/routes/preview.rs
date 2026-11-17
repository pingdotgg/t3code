//! The same authenticated live browser stream for desktop and iOS clients.
use crate::AppState;
use axum::{
    Router,
    body::Bytes,
    extract::{
        Query, State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use conn_preview::tabs::{Viewer, ViewerOutput};
use serde_json::Value;
use std::collections::HashMap;

// Viewer file transfer and clipboard messages are not served yet.
pub(super) fn router() -> Router<AppState> {
    Router::new().route("/api/preview-stream/ws", get(upgrade))
}
async fn upgrade(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let principal = crate::http::authenticate_upgrade(&state, &query, &headers, "media");
    let Some(principal) = principal else {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Bearer")],
            "Unauthorized",
        )
            .into_response();
    };
    if !principal.has_scope("orchestration:read") {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }
    let Some(preview) = state.deps.preview.clone() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let (thread, tab) = (
        query.get("threadId").cloned().unwrap_or_default(),
        query.get("tabId").cloned().unwrap_or_default(),
    );
    if thread.is_empty() || tab.is_empty() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let number = |key: &str, default: u64, max: u64| {
        query
            .get(key)
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(default)
            .min(max)
    };
    let can_operate = principal.has_scope("preview:operate")
        && query.get("interactive").is_none_or(|v| v != "false");
    let viewer = preview
        .attach_viewer(
            &thread,
            &tab,
            can_operate,
            number("maxWidth", 1280, 7680),
            number("maxHeight", 800, 4320),
            number("quality", 70, 100),
        )
        .await;
    ws.max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .max_write_buffer_size(8 * 1024 * 1024)
        .on_upgrade(move |mut socket| async move {
            match viewer {
                Ok(viewer) => drive(socket, viewer).await,
                Err(_) => {
                    let _ = socket
                        .send(Message::Close(Some(CloseFrame {
                            code: 4404,
                            reason: "tab closed".into(),
                        })))
                        .await;
                }
            }
        })
}
async fn send(socket: &mut WebSocket, message: Message) -> bool {
    matches!(
        tokio::time::timeout(std::time::Duration::from_secs(5), socket.send(message)).await,
        Ok(Ok(()))
    )
}
async fn drive(mut socket: WebSocket, mut viewer: Viewer) {
    if !send(
        &mut socket,
        Message::Text(viewer.control().to_string().into()),
    )
    .await
    {
        return;
    }
    let mut in_flight: Option<conn_preview::tabs::ViewerFrame> = None;
    let mut pending: Option<conn_preview::tabs::ViewerFrame> = None;
    loop {
        tokio::select! {
           message=socket.recv()=>{
               let Some(Ok(message))=message else{break;};
               let text=match message{Message::Text(text)=>text.as_bytes().to_vec(),Message::Binary(bytes)=>bytes.to_vec(),Message::Close(_)=>break,_=>continue};
               let Ok(message)=serde_json::from_slice::<Value>(&text)else{continue;};
               if message.get("type").and_then(Value::as_str)==Some("ack"){
                   if let Some(frame)=in_flight.take(){frame.release();}
                   if let Some(frame)=pending.take(){if !send(&mut socket,Message::Binary(Bytes::from_owner(frame.data.clone()))).await{break;}in_flight=Some(frame);}
               }else{let _=viewer.input(message).await;}
           },
           output=viewer.next()=>match output{
               Ok(ViewerOutput::Frame(frame))=>{if in_flight.is_some(){if let Some(old)=pending.replace(frame){old.release();}}else{if !send(&mut socket,Message::Binary(Bytes::from_owner(frame.data.clone()))).await{break;}in_flight=Some(frame);}},
               Ok(ViewerOutput::Message(message))=>if !send(&mut socket,Message::Text(message.to_string().into())).await{break;},
               _=>{let _=send(&mut socket,Message::Close(Some(CloseFrame{code:4404,reason:"tab closed".into()}))).await;break;}
           }
        }
    }
    if let Some(frame) = in_flight {
        frame.release();
    }
    if let Some(frame) = pending {
        frame.release();
    }
}
