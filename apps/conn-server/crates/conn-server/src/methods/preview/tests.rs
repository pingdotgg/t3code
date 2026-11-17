use super::*;
use crate::table::{CallContext, Handler};

async fn call(table: &MethodTable, tag: &str, input: Value) -> Result<Value, Failure> {
    let Some(Handler::Unary(handler)) = table.get(tag) else {
        panic!("missing {tag}")
    };
    handler(CallContext::default(), input).await
}
#[tokio::test]
async fn clients_and_agents_share_tabs_events_errors_and_render_settings() {
    let root = std::env::temp_dir().join(format!("conn-preview-rpc-{}", conn_support::uuid_v4()));
    let browser = conn_preview::tabs::Preview::with_fixture(
        root.clone(),
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../conn-preview/tests/fake-chrome.py"),
    );
    let mut table = MethodTable::new();
    register(
        &mut table,
        &Deps {
            preview: Some(browser.clone()),
            ..Deps::default()
        },
    );
    let Some(Handler::Stream(stream)) = table.get("subscribePreviewEvents") else {
        panic!("preview stream")
    };
    let mut stream = stream(CallContext::default(), json!({})).await.unwrap();
    assert!(
        matches!(call(&table,"preview.open",json!({"threadId":"thread","runtime":"server","url":"file:///refused"})).await,Err(Failure::Fail(v)) if v["_tag"]=="PreviewInvalidUrlError")
    );
    let tab = call(
        &table,
        "preview.open",
        json!({"threadId":"thread","runtime":"server"}),
    )
    .await
    .unwrap();
    let id = tab["tabId"].as_str().unwrap();
    let event = stream.recv().await.unwrap().unwrap();
    assert_eq!(event["type"], "opened");
    conn_contract::from_json::<conn_contract::PreviewEvent>(event).unwrap();
    assert_eq!(
        call(&table, "preview.list", json!({"threadId":"thread"}))
            .await
            .unwrap()["sessions"][0]["tabId"],
        id
    );
    assert!(tab.get("automationOwner").is_none());
    let resized=call(&table,"preview.resize",json!({"threadId":"thread","tabId":id,"viewport":{"_tag":"freeform","width":640,"height":480}})).await.unwrap();
    assert_eq!(resized["viewport"]["width"], 640);
    let adjusted = call(
        &table,
        "preview.adjust",
        json!({"threadId":"thread","tabId":id,"colorScheme":"dark","zoomFactor":1.25}),
    )
    .await
    .unwrap();
    assert_eq!(adjusted["colorScheme"], "dark");
    assert_eq!(adjusted["zoomFactor"], 1.25);
    assert!(
        matches!(call(&table,"preview.reportStatus",json!({"threadId":"thread","tabId":id,"navStatus":{"_tag":"Idle"},"canGoBack":false,"canGoForward":false})).await,Err(Failure::Fail(v)) if v["_tag"]=="PreviewControlRequiredError")
    );
    assert!(
        matches!(call(&table,"preview.resize",json!({"threadId":"thread","tabId":"missing","viewport":{"_tag":"fill"}})).await,Err(Failure::Fail(v)) if v["_tag"]=="PreviewSessionLookupError")
    );
    assert!(matches!(call(&table,"preview.resize",json!({"threadId":"thread","tabId":id,"viewport":{"_tag":"freeform","width":1000000,"height":480}})).await,Err(Failure::Die(_))));
    call(
        &table,
        "preview.close",
        json!({"threadId":"thread","tabId":id}),
    )
    .await
    .unwrap();
    call(
        &table,
        "preview.clearProfile",
        json!({"profileId":"never-opened"}),
    )
    .await
    .unwrap();
    browser.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}
