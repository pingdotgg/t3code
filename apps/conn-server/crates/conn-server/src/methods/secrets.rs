//! The secret card answer: only its status reaches orchestration or the client.

use super::Deps;
use crate::table::{Failure, MethodTable};
use conn_contract::SecretRequestAnswerInput;

pub(super) fn register(table: &mut MethodTable, deps: &Deps) {
    let Some(secrets) = deps.secrets.clone() else {
        return;
    };
    table.unary(
        "secrets.answerRequest",
        move |_, mut input: SecretRequestAnswerInput| {
            let secrets = secrets.clone();
            async move {
                if let conn_contract::SecretRequestAnswerInputAnswer::Save(save) = &mut input.answer
                {
                    save.secret = save.secret.trim().to_owned();
                    if save.secret.is_empty() {
                        return Err(Failure::die("Expected a non-blank string at answer.secret"));
                    }
                }

                secrets
                    .answer(input)
                    .await
                    .map_err(|e| Failure::Fail(e.to_contract()))
            }
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::table::{CallContext, Handler};
    use serde_json::json;
    use std::sync::Arc;

    #[tokio::test(flavor = "current_thread")]
    async fn rpc_decodes_answers_and_keeps_failures_typed() {
        let dir = std::env::temp_dir().join(format!("conn-secret-rpc-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let engine = Arc::new(
            conn_engine::SqliteEngine::open(conn_engine::EngineConfig::new(
                dir.join("engine.sqlite"),
            ))
            .unwrap(),
        );
        let secrets = conn_features::secrets::SecretRequests::new(
            &dir,
            engine.clone(),
            Arc::new(conn_features::clock::SystemClock),
        );
        let mut table = MethodTable::new();
        register(
            &mut table,
            &Deps {
                secrets: Some(secrets),
                ..Deps::default()
            },
        );
        let Some(Handler::Unary(answer)) = table.get("secrets.answerRequest") else {
            panic!("answer method registered");
        };
        assert_eq!(
            answer(
                CallContext::default(),
                json!({"threadId":"missing","turnItemId":"missing","answer":{"type":"decline"}})
            )
            .await
            .unwrap_err(),
            Failure::Fail(json!({"_tag":"SecretRequestError","reason":"load_failed"}))
        );
        assert!(matches!(answer(CallContext::default(),json!({"threadId":"missing","turnItemId":"missing","answer":{"type":"save","secret":"   "}})).await, Err(Failure::Die(_))));
        for field in ["threadId", "turnItemId"] {
            let mut input =
                json!({"threadId":"missing","turnItemId":"missing","answer":{"type":"decline"}});
            input[field] = json!("   ");
            assert!(
                matches!(
                    answer(CallContext::default(), input).await,
                    Err(Failure::Die(_))
                ),
                "{field} must fail contract decoding"
            );
        }
        conn_engine::Engine::shutdown(engine.as_ref()).await;
        drop(table);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
