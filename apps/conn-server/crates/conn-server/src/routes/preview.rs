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

use crate::session::SessionGate;

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
    let can_operate = principal.has_scope("preview:operate")
        && query.get("interactive").is_none_or(|v| v != "false");
    upgrade_viewer(ws, preview, &thread, &tab, can_operate, &query, None).await
}

/// Attaches a viewer and upgrades to its stream. With a `gate` (managed access) the stream
/// checks it before every input and every frame, and ends when it closes.
pub(crate) async fn upgrade_viewer(
    ws: WebSocketUpgrade,
    preview: conn_preview::tabs::Preview,
    thread: &str,
    tab: &str,
    can_operate: bool,
    query: &HashMap<String, String>,
    gate: Option<SessionGate>,
) -> Response {
    let number = |key: &str, default: u64, max: u64| {
        query
            .get(key)
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(default)
            .min(max)
    };
    // A pause waits before the attachment; under the tab's lock the gate is asked again, so
    // a pause or fence that lands while it waits attaches nothing. A pause there is not a
    // closed tab: the attachment waits it out and tries again; only a fence refuses.
    let gate_for_attach = gate.clone();
    let admit = move || {
        gate_for_attach
            .as_ref()
            .is_none_or(|g| g.0.state() == crate::session::GateState::Open)
    };
    let viewer = loop {
        if !crate::session::pass(gate.as_ref()).await {
            return StatusCode::FORBIDDEN.into_response();
        }
        let attach = preview.attach_viewer_checked(
            thread,
            tab,
            can_operate,
            number("maxWidth", 1280, 7680),
            number("maxHeight", 800, 4320),
            number("quality", 70, 100),
            &admit,
        );
        let viewer = match &gate {
            // A fence while the attachment waits releases the handler at once.
            Some(gate) => tokio::select! {
                biased;
                () = gate.0.closed() => return StatusCode::FORBIDDEN.into_response(),
                viewer = attach => viewer,
            },
            None => attach.await,
        };
        match viewer {
            Err(error) if error.0 == conn_preview::tabs::ADMISSION_REFUSED => continue,
            viewer => break viewer,
        }
    };
    if !crate::session::pass(gate.as_ref()).await {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .max_write_buffer_size(8 * 1024 * 1024)
        .on_upgrade(move |mut socket| async move {
            match viewer {
                Ok(viewer) => drive(socket, viewer, gate).await,
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
/// `send`, but only while the gate passes, and abandoned the moment it closes.
async fn gated_send(socket: &mut WebSocket, message: Message, gate: &Option<SessionGate>) -> bool {
    let Some(gate) = gate else {
        return send(socket, message).await;
    };
    if !crate::session::pass(Some(gate)).await {
        return false;
    }
    let closed = gate.0.closed();
    tokio::select! {
        biased;
        () = closed => false,
        sent = send(socket, message) => sent,
    }
}

async fn drive(mut socket: WebSocket, mut viewer: Viewer, gate: Option<SessionGate>) {
    let open = |gate: &Option<SessionGate>| gate.as_ref().is_none_or(|g| g.0.open());
    let closed = match &gate {
        Some(gate) => gate.0.closed(),
        None => Box::pin(std::future::pending()),
    };
    tokio::pin!(closed);
    if !gated_send(
        &mut socket,
        Message::Text(viewer.control().to_string().into()),
        &gate,
    )
    .await
    {
        return;
    }
    let mut in_flight: Option<conn_preview::tabs::ViewerFrame> = None;
    let mut pending: Option<conn_preview::tabs::ViewerFrame> = None;
    loop {
        if !crate::session::pass(gate.as_ref()).await {
            break;
        }
        tokio::select! {
           () = &mut closed => break,
           message=socket.recv()=>{
               let Some(Ok(message))=message else{break;};
               let text=match message{Message::Text(text)=>text.as_bytes().to_vec(),Message::Binary(bytes)=>bytes.to_vec(),Message::Close(_)=>break,_=>continue};
               let Ok(message)=serde_json::from_slice::<Value>(&text)else{continue;};
               if message.get("type").and_then(Value::as_str)==Some("ack"){
                   if let Some(frame)=in_flight.take(){frame.release();}
                   if let Some(frame)=pending.take(){if !gated_send(&mut socket,Message::Binary(Bytes::from_owner(frame.data.clone())),&gate).await{break;}in_flight=Some(frame);}
               }else if open(&gate){let _=viewer.input(message).await;}
           },
           output=viewer.next()=>match output{
               Ok(ViewerOutput::Frame(frame))=>{if in_flight.is_some(){if let Some(old)=pending.replace(frame){old.release();}}else{if !gated_send(&mut socket,Message::Binary(Bytes::from_owner(frame.data.clone())),&gate).await{break;}in_flight=Some(frame);}},
               Ok(ViewerOutput::Message(message))=>if !gated_send(&mut socket,Message::Text(message.to_string().into()),&gate).await{break;},
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
