use conn_preview::tabs::Preview;
use serde_json::json;

#[tokio::test]
async fn an_empty_status_does_not_install_or_start_chrome() {
    let root = std::env::temp_dir().join(format!("conn-preview-tabs-{}", conn_support::uuid_v4()));
    let preview = Preview::new(root.clone());
    let status = preview
        .invoke("thread", "agent", "status", json!({}))
        .await
        .unwrap();
    assert_eq!(status["available"], false);
    assert_eq!(status["tabId"], serde_json::Value::Null);
    assert_eq!(status["profiles"][0]["id"], "default");
    assert!(
        !root.exists(),
        "reads must not create state or install a browser"
    );
    let error = preview
        .invoke("thread", "agent", "evaluate", json!({"expression":"0"}))
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "No server preview tab is open for this thread. Call preview_open first."
    );
}

#[tokio::test]
async fn tabs_enforce_session_limits_ownership_and_shared_render_settings() {
    let root = std::env::temp_dir().join(format!("conn-preview-owned-{}", conn_support::uuid_v4()));
    let preview = Preview::with_fixture(
        root.clone(),
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fake-chrome.py"),
    );
    let first = preview
        .invoke("thread", "agent", "open", json!({"url":"localhost:3000"}))
        .await
        .unwrap();
    assert_eq!(first["title"], "Fixture");
    assert_eq!(preview.list("thread")["sessions"][0]["reveal"], true);
    assert_eq!(
        preview.list("thread")["sessions"][0]["revealRequest"]["force"],
        false
    );
    assert_eq!(first["url"], "http://localhost:3000/");
    let id = first["tabId"].as_str().unwrap();
    let other = preview
        .invoke("thread", "other", "open", json!({}))
        .await
        .unwrap();
    assert_ne!(
        other["tabId"], first["tabId"],
        "implicit reuse must stay inside the agent session"
    );
    assert!(
        preview
            .invoke("thread", "other", "open", json!({"tabId":id}))
            .await
            .is_err()
    );
    preview
        .close("thread", other["tabId"].as_str())
        .await
        .unwrap();
    assert_eq!(
        preview
            .invoke("thread", "agent", "evaluate", json!({"expression":"1+1"}))
            .await
            .unwrap(),
        json!(2)
    );
    assert!(
        preview
            .invoke(
                "thread",
                "other",
                "evaluate",
                json!({"tabId":id,"expression":"1+1"})
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("another agent")
    );
    let resized = preview
        .invoke(
            "thread",
            "agent",
            "resize",
            json!({"mode":"preset","preset":"iphone-se","orientation":"landscape"}),
        )
        .await
        .unwrap();
    assert_eq!(resized["viewport"], json!({"width":667,"height":375}));
    assert_eq!(
        preview
            .invoke(
                "thread",
                "agent",
                "setColorScheme",
                json!({"colorScheme":"dark"})
            )
            .await
            .unwrap()["colorScheme"],
        "dark"
    );
    assert!(
        preview
            .invoke("thread", "agent", "cdpEndpoint", json!({}))
            .await
            .unwrap_err()
            .to_string()
            .starts_with("Not supported on server tabs:")
    );
    for _ in 1..8 {
        preview
            .invoke("thread", "agent", "open", json!({"reuseExistingTab":false}))
            .await
            .unwrap();
    }
    assert!(
        preview
            .invoke("thread", "agent", "open", json!({"reuseExistingTab":false}))
            .await
            .unwrap_err()
            .to_string()
            .starts_with("Too many server browser tabs")
    );
    assert!(
        preview
            .invoke("thread", "agent", "evaluate", json!({"expression":"0"}))
            .await
            .unwrap_err()
            .to_string()
            .starts_with("Multiple browser tabs")
    );
    assert_eq!(
        preview
            .invoke(
                "thread",
                "agent",
                "evaluate",
                json!({"tabId":id,"expression":"1+1"})
            )
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        preview.status("thread", "agent", None)["tabId"],
        id,
        "status follows the most recently used owned tab"
    );
    assert_eq!(
        preview.list("thread")["sessions"].as_array().unwrap().len(),
        8
    );
    preview.close("thread", None).await.unwrap();
    assert!(
        preview.list("thread")["sessions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    preview.shutdown().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn profiles_merge_disconnect_and_restart_without_losing_the_saved_catalog() {
    let root =
        std::env::temp_dir().join(format!("conn-preview-profiles-{}", conn_support::uuid_v4()));
    let preview = Preview::new(root.clone());
    preview
        .report_profiles(
            1,
            vec![json!({"id":"work/team","name":"Work","kind":"persistent"})],
            "work/team".into(),
            Some(60),
        )
        .await
        .unwrap();
    preview
        .report_profiles(
            2,
            vec![json!({"id":"home","name":"Home","kind":"incognito"})],
            "home".into(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        preview.status("t", "a", None)["profiles"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
    preview.disconnect_client(2);
    assert_eq!(
        preview.status("t", "a", None)["defaultProfileId"],
        "work/team"
    );
    preview.disconnect_client(1);
    let restarted = Preview::new(root.clone());
    let status = restarted
        .invoke("t", "a", "status", json!({}))
        .await
        .unwrap();
    assert_eq!(status["defaultProfileId"], "home");
    assert_eq!(status["profiles"].as_array().unwrap().len(), 4);
    assert!(
        status["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == "home")
            .unwrap()
            .get("incognito")
            .is_none()
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn viewers_take_and_release_control_resize_fill_and_enforce_a_per_tab_bound() {
    let root =
        std::env::temp_dir().join(format!("conn-preview-viewer-{}", conn_support::uuid_v4()));
    let preview = Preview::with_fixture(
        root.clone(),
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fake-chrome.py"),
    );
    let opened = preview.invoke("t", "a", "open", json!({})).await.unwrap();
    let tab = opened["tabId"].as_str().unwrap();
    let mut viewer = preview
        .attach_viewer("t", tab, true, 1280, 800, 70)
        .await
        .unwrap();
    assert_eq!(viewer.control()["controller"], "agent");
    assert!(
        matches!(viewer.next().await.unwrap(),conn_preview::tabs::ViewerOutput::Message(v) if v["type"]=="viewport")
    );
    assert!(
        matches!(viewer.next().await.unwrap(),conn_preview::tabs::ViewerOutput::Frame(v) if v.data.as_ref()==b"fixture")
    );
    viewer.input(json!({"type":"takeControl"})).await.unwrap();
    assert_eq!(viewer.control()["controller"], "you");
    assert_eq!(
        preview.status("t", "a", Some(tab))["tabs"][0]["owner"],
        "human"
    );
    assert!(
        preview
            .invoke("t", "a", "evaluate", json!({"expression":"0"}))
            .await
            .unwrap_err()
            .to_string()
            .contains("human controls")
    );
    viewer
        .input(json!({"type":"resize","width":720,"height":500}))
        .await
        .unwrap();
    assert_eq!(
        preview.status("t", "a", Some(tab))["viewport"],
        json!({"width":720,"height":500})
    );
    assert!(viewer.input(json!({"type":"viewport","setting":{"_tag":"freeform","width":1000000,"height":480}})).await.is_err());
    viewer
        .input(json!({"type":"viewport","setting":{"_tag":"freeform","width":640,"height":480}}))
        .await
        .unwrap();
    viewer
        .input(json!({"type":"viewport","setting":{"_tag":"fill"}}))
        .await
        .unwrap();
    assert_eq!(
        preview.status("t", "a", Some(tab))["viewport"],
        json!({"width":720,"height":500})
    );
    let mut observers = Vec::new();
    for _ in 0..7 {
        observers.push(
            preview
                .attach_viewer("t", tab, false, 1280, 800, 70)
                .await
                .unwrap(),
        );
    }
    assert!(
        preview
            .attach_viewer("t", tab, false, 1280, 800, 70)
            .await
            .is_err()
    );
    drop(viewer);
    assert_eq!(
        preview
            .invoke("t", "a", "evaluate", json!({"expression":"1+1"}))
            .await
            .unwrap(),
        2
    );
    drop(observers);
    preview.shutdown().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn locator_and_chooser_uploads_reject_relative_paths_before_touching_the_dom() {
    let root =
        std::env::temp_dir().join(format!("conn-preview-upload-{}", conn_support::uuid_v4()));
    let preview = Preview::with_fixture(
        root.clone(),
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fake-chrome.py"),
    );
    preview.invoke("t", "a", "open", json!({})).await.unwrap();
    for locator in [None, Some("#file")] {
        let mut args = json!({"paths":["relative.txt"]});
        if let Some(locator) = locator {
            args["locator"] = json!(locator);
        }
        assert_eq!(
            preview
                .invoke("t", "a", "upload", args)
                .await
                .unwrap_err()
                .0,
            "Upload paths must be absolute: relative.txt"
        );
    }
    preview.shutdown().await;
    std::fs::remove_dir_all(root).unwrap();
}
