//! The user's test-login list and edit form, including explicit secret reveal.

use super::Deps;
use crate::table::{Failure, MethodTable};
use conn_contract::{SaveTestLoginInput, TestLoginSummaryCreatedBy, UpdateTestLoginInput, rpc};
use conn_features::test_logins::TestLoginError;

fn fail(error: TestLoginError) -> Failure {
    Failure::Fail(error.to_contract())
}

pub(super) fn register(table: &mut MethodTable, deps: &Deps) {
    let Some(store) = deps.test_logins.clone() else {
        return;
    };
    let list = store.clone();
    table.unary(
        "testLogins.list",
        move |_, _: rpc::test_logins::list::Payload| {
            let store = list.clone();
            async move { store.list().await.map_err(fail) }
        },
    );
    let save = store.clone();
    table.unary("testLogins.save", move |_, input: SaveTestLoginInput| {
        let store = save.clone();
        async move {
            store
                .save(input, TestLoginSummaryCreatedBy::User)
                .await
                .map_err(fail)
        }
    });
    let update = store.clone();
    table.unary(
        "testLogins.update",
        move |_, input: UpdateTestLoginInput| {
            let store = update.clone();
            async move { store.update(input).await.map_err(fail) }
        },
    );
    let remove = store.clone();
    table.unary(
        "testLogins.remove",
        move |_, input: rpc::test_logins::remove::Payload| {
            let store = remove.clone();
            async move { store.remove(&input.id).await.map_err(fail) }
        },
    );
    table.unary(
        "testLogins.reveal",
        move |_, input: rpc::test_logins::reveal::Payload| {
            let store = store.clone();
            async move { store.reveal(&input.id).await.map_err(fail) }
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::table::{CallContext, Handler};
    use serde_json::{Value, json};

    async fn call(table: &MethodTable, tag: &str, args: Value) -> Result<Value, Failure> {
        let Some(Handler::Unary(handler)) = table.get(tag) else {
            panic!("missing {tag}");
        };
        handler(CallContext::default(), args).await
    }
    #[tokio::test(flavor = "current_thread")]
    async fn rpc_crud_decodes_success_and_typed_errors_and_rejects_bad_inputs() {
        let dir = std::env::temp_dir().join(format!("conn-login-rpc-{}", conn_support::uuid_v4()));
        let mut table = MethodTable::new();
        register(
            &mut table,
            &Deps {
                test_logins: Some(conn_features::test_logins::TestLogins::new(&dir)),
                ..Deps::default()
            },
        );
        let reader = CallContext {
            principal: Some(std::sync::Arc::new(crate::auth::Principal {
                session_id: "reader".into(),
                subject: "reader".into(),
                scopes: vec!["orchestration:read".into()],
                expires_at_ms: u64::MAX,
            })),
            ..CallContext::default()
        };
        for tag in [
            "testLogins.list",
            "testLogins.save",
            "testLogins.update",
            "testLogins.remove",
            "testLogins.reveal",
        ] {
            let Some(Handler::Unary(handler)) = table.get(tag) else {
                panic!("missing {tag}");
            };
            let Failure::Fail(error) = handler(reader.clone(), json!({})).await.unwrap_err() else {
                panic!("expected scope failure");
            };
            assert_eq!(error["requiredPermission"], "settings:write");
        }
        assert_eq!(
            call(&table, "testLogins.list", json!({})).await.unwrap(),
            json!({"items":[]})
        );
        let saved = call(
            &table,
            "testLogins.save",
            json!({"url":" localhost ","username":"u","password":"p"}),
        )
        .await
        .unwrap();
        assert_eq!(saved["createdBy"], "user");
        assert_eq!(saved["url"], "localhost");
        assert_eq!(
            call(&table, "testLogins.reveal", json!({"id":saved["id"]}))
                .await
                .unwrap(),
            json!({"password":"p","otpSecret":null})
        );
        assert_eq!(
            call(
                &table,
                "testLogins.update",
                json!({"id":saved["id"],"label":"New"})
            )
            .await
            .unwrap()["label"],
            "New"
        );
        call(&table, "testLogins.remove", json!({"id":saved["id"]}))
            .await
            .unwrap();
        assert_eq!(
            call(&table, "testLogins.reveal", json!({"id":saved["id"]}))
                .await
                .unwrap_err(),
            Failure::Fail(json!({"_tag":"TestLoginNotFoundError","id":saved["id"]}))
        );
        for (tag, args) in [
            (
                "testLogins.save",
                json!({"url":"","username":"u","password":"p"}),
            ),
            (
                "testLogins.save",
                json!({"url":"u","username":"u","password":"x".repeat(1025)}),
            ),
            ("testLogins.update", json!({"id":saved["id"],"username":""})),
            ("testLogins.reveal", json!({"id":"invalid"})),
        ] {
            assert!(
                matches!(call(&table, tag, args).await, Err(Failure::Die(_))),
                "{tag}"
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
