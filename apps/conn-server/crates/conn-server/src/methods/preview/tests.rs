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

#[tokio::test]
async fn desktop_tabs_are_records_and_their_desktop_hosts_them_for_agents() {
    let root =
        std::env::temp_dir().join(format!("conn-preview-desktop-{}", conn_support::uuid_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let environment = std::sync::Arc::new(
        crate::environment::Environment::load(&root, None, root.clone(), Default::default())
            .unwrap(),
    );
    let browser = conn_preview::tabs::Preview::new(root.join("browser"));
    let mut table = MethodTable::new();
    register(
        &mut table,
        &Deps {
            preview: Some(browser.clone()),
            environment: Some(environment.clone()),
            ..Deps::default()
        },
    );
    let Some(Handler::Stream(events)) = table.get("subscribePreviewEvents") else {
        panic!("preview stream")
    };
    let mut events = events(CallContext::default(), json!({})).await.unwrap();
    // T3's default runtime is the desktop: a record, no browser here.
    let tab = call(
        &table,
        "preview.open",
        json!({"threadId":"thread","url":"http://localhost:3000"}),
    )
    .await
    .unwrap();
    assert_eq!(tab["runtime"], "desktop");
    assert_eq!(
        tab["navStatus"],
        json!({"_tag":"Loading","url":"http://localhost:3000/","title":""})
    );
    let id = tab["tabId"].as_str().unwrap().to_owned();
    let opened = events.recv().await.unwrap().unwrap();
    conn_contract::from_json::<conn_contract::PreviewEvent>(opened).unwrap();
    call(&table, "preview.reportStatus", json!({"threadId":"thread","tabId":id,"navStatus":{"_tag":"Success","url":"http://localhost:3000/","title":"Home"},"canGoBack":true,"canGoForward":false})).await.unwrap();
    let navigated = events.recv().await.unwrap().unwrap();
    assert_eq!(navigated["type"], "navigated");
    assert_eq!(navigated["snapshot"]["canGoBack"], true);
    conn_contract::from_json::<conn_contract::PreviewEvent>(navigated).unwrap();
    let adjusted = call(
        &table,
        "preview.adjust",
        json!({"threadId":"thread","tabId":id,"colorScheme":"dark","hardReload":true}),
    )
    .await
    .unwrap();
    assert_eq!(adjusted["colorScheme"], "dark");
    let resized = events.recv().await.unwrap().unwrap();
    assert_eq!(resized["request"], json!({"hardReload":true}));
    conn_contract::from_json::<conn_contract::PreviewEvent>(resized).unwrap();
    let viewport = json!({"_tag":"freeform","width":640,"height":480});
    let resized = call(
        &table,
        "preview.resize",
        json!({"threadId":"thread","tabId":id,"viewport":viewport}),
    )
    .await
    .unwrap();
    assert_eq!(resized["viewport"], viewport);
    let _ = events.recv().await.unwrap().unwrap();

    let environment_id = environment.environment_id().to_owned();
    let binding = json!({"environmentId":environment_id,"threadId":"thread","tabId":id,"deviceName":"Mac","snapshot":resized});
    let wrong = json!({"environmentId":"elsewhere","threadId":"thread","tabId":id,"deviceName":"Mac","snapshot":resized});
    assert!(
        matches!(call(&table, "preview.desktopRegister", wrong).await, Err(Failure::Fail(v)) if v == json!({"_tag":"DesktopTabRelayError","reason":"binding"}))
    );
    let registered = call(&table, "preview.desktopRegister", binding.clone())
        .await
        .unwrap();
    let connection = registered["connectionId"].as_str().unwrap().to_owned();
    assert!(
        matches!(call(&table, "preview.desktopRegister", binding).await, Err(Failure::Fail(v)) if v["reason"] == "conflict")
    );
    let Some(Handler::Stream(requests)) = table.get("preview.desktopRequests") else {
        panic!("desktop requests")
    };
    let mut feed = requests(CallContext::default(), json!({"connectionId":connection}))
        .await
        .unwrap();
    let connected = feed.recv().await.unwrap().unwrap();
    conn_contract::from_json::<conn_contract::PreviewAutomationStreamEvent>(connected).unwrap();
    // An agent call that names the tab reaches the desktop; its answer comes back.
    let agent = browser.clone();
    let env = environment_id.clone();
    let tab_id = id.clone();
    let snapshot = tokio::spawn(async move {
        agent
            .relay(conn_preview::relay::RelayCall {
                environment_id: &env,
                thread: "thread",
                agent: "agent",
                operation: "snapshot",
                input: json!({"pixelsRequired":false}),
                tab: Some(&tab_id),
                timeout_ms: None,
                update_current_tab: true,
            })
            .await
    });
    let event = feed.recv().await.unwrap().unwrap();
    conn_contract::from_json::<conn_contract::PreviewAutomationStreamEvent>(event.clone()).unwrap();
    assert_eq!(event["request"]["operation"], "snapshot");
    call(&table, "preview.desktopRespond", json!({"clientId":"desktop","connectionId":connection,"requestId":event["request"]["requestId"],"ok":true,"result":{"url":"http://localhost:3000/"}})).await.unwrap();
    let answered = snapshot.await.unwrap().unwrap().unwrap();
    assert_eq!(answered.value["url"], "http://localhost:3000/");
    // Closing the record publishes `closed`; the desktop drops its page on it.
    call(
        &table,
        "preview.close",
        json!({"threadId":"thread","tabId":id}),
    )
    .await
    .unwrap();
    assert_eq!(events.recv().await.unwrap().unwrap()["type"], "closed");
    assert_eq!(
        call(&table, "preview.list", json!({"threadId":"thread"}))
            .await
            .unwrap()["sessions"],
        json!([])
    );
    drop(feed);
    browser.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn a_desktop_cannot_restore_an_id_from_this_servers_allocator() {
    let root =
        std::env::temp_dir().join(format!("conn-preview-restore-{}", conn_support::uuid_v4()));
    let browser = conn_preview::tabs::Preview::new(root.clone());
    let opened = browser.open_desktop("thread", &json!({})).unwrap();
    let id = opened["tabId"].as_str().unwrap();
    let epoch = id.rsplit_once('_').unwrap().1;
    let mut forged = opened.clone();
    forged["tabId"] = json!(format!("tab_zz_{epoch}"));
    assert!(!browser.restore_desktop(&forged));
    // A tab from an earlier server run is restored.
    forged["tabId"] = json!("tab_1_earlier-epoch");
    assert!(browser.restore_desktop(&forged));
    assert!(browser.restore_desktop(&opened));
    let _ = std::fs::remove_dir_all(root);
}
