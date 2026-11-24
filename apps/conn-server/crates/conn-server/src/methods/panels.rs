//! Requests to show panels on the connected Conn desktops.

use super::Deps;
use crate::table::{Failure, MethodTable};
use conn_contract::{
    source::{DesktopPanelResponse, DesktopPanelSubscription},
    to_json,
};
use tokio::sync::mpsc;

pub(super) fn register(table: &mut MethodTable, deps: &Deps) {
    let Some(panels) = deps.panels.clone() else {
        return;
    };
    let broker = panels.clone();
    table.stream("panels.requests", move |ctx, input: DesktopPanelSubscription| {
        let broker = broker.clone();
        async move {
            let mut requests = broker.subscribe_for(ctx.connection_id, input.files_thread, input.files_only).map_err(|e| Failure::die(e.message))?;
            let (tx, rx) = mpsc::channel(1);
            tokio::spawn(async move {
                loop { tokio::select! {
                    () = tx.closed() => break,
                    request = requests.recv() => match request {
                        Some(request) => if tx.send(Ok(to_json(&request))).await.is_err() { break; },
                        None => break,
                    }
                } }
            });
            Ok(rx)
        }
    });
    table.unary("panels.respond", move |ctx, input: DesktopPanelResponse| {
        panels.respond_from(ctx.connection_id, input);
        std::future::ready(Ok(()))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::table::{CallContext, Handler};
    use serde_json::{Value, json};
    use std::time::Duration;

    #[tokio::test(flavor = "current_thread")]
    async fn files_actions_target_one_window_and_only_accept_its_reply() {
        use conn_contract::source::{DesktopPanelResponse, FilesAction};
        let broker = conn_features::panels::PanelBroker::default();
        let mut table = MethodTable::new();
        register(
            &mut table,
            &Deps {
                panels: Some(broker.clone()),
                ..Deps::default()
            },
        );
        let Some(Handler::Stream(subscribe)) = table.get("panels.requests") else {
            panic!("missing stream")
        };
        let Some(Handler::Unary(respond)) = table.get("panels.respond") else {
            panic!("missing respond")
        };
        let session = |id| CallContext {
            connection_id: id,
            ..Default::default()
        };
        let mut legacy = subscribe(session(1), json!({})).await.unwrap();
        let mut mac = subscribe(session(2), json!({"filesThread":"t","filesOnly":true}))
            .await
            .unwrap();
        let request = || {
            conn_contract::from_json(
                json!({"requestId":"pending","threadId":"t","panel":"files","focusWindow":false}),
            )
            .unwrap()
        };
        let (answer, ()) = tokio::join!(
            broker.show_action(
                request(),
                Some(FilesAction::Selection),
                Duration::from_secs(2)
            ),
            async {
                let shown = mac.recv().await.unwrap().unwrap();
                assert_eq!(shown["filesAction"]["kind"], "selection");
                let reply = |text: &str| json!({"ok":true,"requestId":shown["requestId"],"selection":{"path":"routes/web.php","startLine":2,"endLine":2,"text":text}});
                respond(session(1), reply("wrong")).await.unwrap();
                respond(session(2), reply("right")).await.unwrap();
            }
        );
        let DesktopPanelResponse { selection, .. } = answer.unwrap();
        assert_eq!(selection.unwrap().text, "right");
        assert!(legacy.try_recv().is_err());
        let (ordinary, ()) = tokio::join!(broker.show(request(), Duration::from_secs(2)), async {
            let shown = legacy.recv().await.unwrap().unwrap();
            respond(
                session(1),
                json!({"ok":true,"requestId":shown["requestId"]}),
            )
            .await
            .unwrap();
        });
        assert!(ordinary.unwrap().ok);
        assert!(
            mac.try_recv().is_err(),
            "linked Files subscription received a general panel request"
        );
        let _duplicate = subscribe(session(3), json!({"filesThread":"t"}))
            .await
            .unwrap();
        let err = broker
            .show_action(
                request(),
                Some(FilesAction::Selection),
                Duration::from_secs(2),
            )
            .await
            .unwrap_err();
        assert!(err.message.contains("multiple windows"));
        assert!(mac.try_recv().is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn responses_enforce_trimmed_ids_and_utf16_input_bounds() {
        let mut table = MethodTable::new();
        register(
            &mut table,
            &Deps {
                panels: Some(conn_features::panels::PanelBroker::default()),
                ..Deps::default()
            },
        );
        let Some(Handler::Unary(respond)) = table.get("panels.respond") else {
            panic!("response registered");
        };
        for (field, value) in [
            ("requestId", "   ".to_owned()),
            ("requestId", "😀".repeat(65)),
            ("deviceName", "x".repeat(201)),
            ("error", "x".repeat(8193)),
        ] {
            let mut input = json!({"requestId":"unknown","ok":true});
            input[field] = json!(value);
            assert!(
                matches!(
                    respond(CallContext::default(), input).await,
                    Err(Failure::Die(_))
                ),
                "{field} must fail contract decoding"
            );
        }
        assert!(respond(CallContext::default(),json!({"requestId":"😀".repeat(64),"ok":true,"deviceName":"x".repeat(200),"error":"x".repeat(8192)})).await.is_ok());
    }
    #[tokio::test(flavor = "current_thread")]
    async fn rpc_delivers_the_request_and_the_first_response_finishes_the_wait() {
        let broker = conn_features::panels::PanelBroker::default();
        let mut table = MethodTable::new();
        register(
            &mut table,
            &Deps {
                panels: Some(broker.clone()),
                ..Deps::default()
            },
        );
        let Some(Handler::Stream(subscribe)) = table.get("panels.requests") else {
            panic!("stream registered");
        };
        let mut stream = subscribe(CallContext::default(), json!({"deviceName":"Mac"}))
            .await
            .unwrap();
        let request = conn_contract::from_json(json!({"requestId":"pending","threadId":"thread","panel":"database","sql":"select 1", "focusWindow":false})).unwrap();
        let Some(Handler::Unary(respond)) = table.get("panels.respond") else {
            panic!("response registered");
        };
        let (shown, ()) = tokio::join!(broker.show(request, Duration::from_secs(15)), async {
            let request = stream.recv().await.unwrap().unwrap();
            assert_eq!(request["threadId"], "thread");
            assert_eq!(request["sql"], "select 1");
            assert_eq!(
                respond(
                    CallContext::default(),
                    json!({"requestId":request["requestId"],"ok":true,"deviceName":"Mac"})
                )
                .await
                .unwrap(),
                Value::Null
            );
        });
        assert_eq!(shown.unwrap().device_name, Some("Mac".into()));
        drop(stream);
    }
}
