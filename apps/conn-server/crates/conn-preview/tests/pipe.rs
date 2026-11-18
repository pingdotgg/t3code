use conn_preview::{Browser, Launch};
use serde_json::json;

#[tokio::test]
async fn launches_only_on_request_and_reads_split_nul_delimited_replies() {
    let root = std::env::temp_dir().join(format!("conn-preview-{}", conn_support::uuid_v4()));
    std::fs::create_dir(&root).unwrap();
    let executable = root.join("chrome");
    std::fs::write(&executable, "#!/usr/bin/python3 -B\nimport os,json\nr=os.fdopen(3,'rb',buffering=0); w=os.fdopen(4,'wb',buffering=0)\nwhile True:\n b=bytearray()\n while True:\n  c=r.read(1)\n  if not c: quit()\n  if c==b'\\0': break\n  b.extend(c)\n q=json.loads(b)\n if q['method']=='Browser.close': quit()\n data=json.dumps({'id':q['id'],'result':q['params']}).encode()+b'\\0'\n w.write(data[:3]); w.write(data[3:])\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let browser = Browser::launch(Launch {
        executable,
        args: vec![],
        directory: root.clone(),
    })
    .await
    .unwrap();
    assert_eq!(
        browser
            .send("Echo", json!({"unicode":"😀"}), None)
            .await
            .unwrap(),
        json!({"unicode":"😀"})
    );
    browser.close().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn native_target_budgets_are_independent_and_survive_forced_shutdown() {
    let root =
        std::env::temp_dir().join(format!("conn-preview-budget-{}", conn_support::uuid_v4()));
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("ignore-close"), "").unwrap();
    for _ in 0..2 {
        let mut hosts = vec![];
        for _ in 0..2 {
            let browser = Browser::launch(Launch {
                executable: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/fake-chrome.py"),
                args: vec![],
                directory: root.clone(),
            })
            .await
            .unwrap();
            browser
                .send("Fixture.targets", json!({}), None)
                .await
                .unwrap();
            assert_eq!(
                browser
                    .send("Fixture.counts", json!({}), None)
                    .await
                    .unwrap()["closed"],
                0
            );
            hosts.push(browser);
        }
        for browser in hosts {
            browser.close().await;
        }
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn frame_acks_reach_chrome_when_regular_commands_fill_the_pending_budget() {
    let root = std::env::temp_dir().join(format!(
        "conn-preview-ack-budget-{}",
        conn_support::uuid_v4()
    ));
    tokio::fs::create_dir(&root).await.unwrap();
    let browser = Browser::launch(Launch {
        executable: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fake-chrome.py"),
        args: vec![],
        directory: root.clone(),
    })
    .await
    .unwrap();
    let mut events = browser.events();
    let mut requests = vec![];
    for _ in 0..16 {
        let browser = browser.clone();
        requests.push(tokio::spawn(async move {
            browser.send("Fixture.hang", json!({}), None).await
        }));
    }
    for _ in 0..16 {
        assert_eq!(events.recv().await.unwrap()["method"], "Fixture.pending");
    }
    browser
        .send(
            "Page.screencastFrameAck",
            json!({"sessionId":1}),
            Some("cast"),
        )
        .await
        .unwrap();
    assert_eq!(events.recv().await.unwrap()["method"], "Fixture.acked");
    browser.close().await;
    for request in requests {
        assert!(request.await.unwrap().is_err());
    }
    tokio::fs::remove_dir_all(root).await.unwrap();
}
