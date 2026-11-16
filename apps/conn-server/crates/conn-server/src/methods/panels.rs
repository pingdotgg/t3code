//! Requests to show panels on the connected Conn desktops.

use super::Deps;
use crate::table::{Failure, MethodTable};
use conn_contract::{AgentPanelResponse, AgentPanelSubscribeInput, to_json};
use tokio::sync::mpsc;

pub(super) fn register(table: &mut MethodTable, deps: &Deps) {
    let Some(panels) = deps.panels.clone() else {
        return;
    };
    let broker = panels.clone();
    table.stream("panels.requests", move |_, _: AgentPanelSubscribeInput| {
        let broker = broker.clone();
        async move {
            let mut requests = broker.subscribe().map_err(|e| Failure::die(e.message))?;
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
    table.unary("panels.respond", move |_, input: AgentPanelResponse| {
        panels.respond(input);
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
