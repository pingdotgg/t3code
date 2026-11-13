//! One `/ws` connection. STUB: enough to answer `Ping` and run handlers. Track (a) replaces
//! it with the full session: the ack window, `Interrupt`, `Eof`, notifications, `discard`,
//! frame parts, auth.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use conn_wire::{
    Exit, FromClient, FromServer, Request, RequestId, decode_client_message, encode_server_frame,
};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::table::{CallContext, Handler, MethodTable, not_supported_exit};

pub async fn run(mut socket: WebSocket, table: Arc<MethodTable>) {
    let (out, mut outgoing) = mpsc::channel::<FromServer>(64);
    loop {
        tokio::select! {
            frame = outgoing.recv() => {
                let Some(frame) = frame else { break };
                if socket.send(Message::Text(encode_server_frame(&frame).into())).await.is_err() {
                    break;
                }
            }
            message = socket.recv() => {
                let text = match message {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => continue,
                };
                match decode_client_message(&text) {
                    Ok(frames) => {
                        for frame in frames {
                            handle(frame, &table, &out).await;
                        }
                    }
                    Err(error) => {
                        let defect = Value::String(format!("invalid frame: {error}"));
                        let _ = out.send(FromServer::Defect { defect }).await;
                    }
                }
            }
        }
    }
}

async fn handle(frame: FromClient, table: &MethodTable, out: &mpsc::Sender<FromServer>) {
    match frame {
        FromClient::Ping => {
            let _ = out.send(FromServer::Pong).await;
        }
        FromClient::Request(request) => call(request, table, out.clone()).await,
        FromClient::Ack { .. } | FromClient::Interrupt { .. } | FromClient::Eof => {}
    }
}

async fn call(request: Request, table: &MethodTable, out: mpsc::Sender<FromServer>) {
    let Request {
        id,
        tag,
        payload,
        headers,
        ..
    } = request;
    let ctx = CallContext { headers };
    match table.get(&tag).cloned() {
        None => {
            let _ = out.send(exit_frame(&id, not_supported_exit(&tag))).await;
        }
        Some(Handler::Unary(handler)) => {
            tokio::spawn(async move {
                let result = handler(ctx, payload).await;
                let _ = out
                    .send(exit_frame(
                        &id,
                        result.map_or_else(|f| f.into_exit(), Exit::success),
                    ))
                    .await;
            });
        }
        Some(Handler::Stream(handler)) => {
            tokio::spawn(async move {
                let mut items = match handler(ctx, payload).await {
                    Ok(items) => items,
                    Err(failure) => {
                        let _ = out.send(exit_frame(&id, failure.into_exit())).await;
                        return;
                    }
                };
                while let Some(item) = items.recv().await {
                    let frame = match item {
                        Ok(value) => FromServer::Chunk {
                            request_id: id.clone(),
                            values: vec![value],
                        },
                        Err(failure) => {
                            let _ = out.send(exit_frame(&id, failure.into_exit())).await;
                            return;
                        }
                    };
                    if out.send(frame).await.is_err() {
                        return;
                    }
                }
                // A stream's exit carries `Schema.Void`, which JSON-encodes as null.
                let _ = out.send(exit_frame(&id, Exit::success(Value::Null))).await;
            });
        }
    }
}

fn exit_frame(id: &RequestId, exit: Exit) -> FromServer {
    FromServer::Exit {
        request_id: id.clone(),
        exit,
    }
}
