use conn_preview::{Browser, Launch};
use serde_json::json;

#[tokio::test]
async fn launches_only_on_request_and_reads_split_nul_delimited_replies() {
    let root = std::env::temp_dir().join(format!("conn-preview-{}", conn_support::uuid_v4()));
    std::fs::create_dir(&root).unwrap();
    let executable = root.join("chrome");
    std::fs::write(&executable, "#!/usr/bin/python3\nimport os,json\nr=os.fdopen(3,'rb',buffering=0); w=os.fdopen(4,'wb',buffering=0)\nwhile True:\n b=bytearray()\n while True:\n  c=r.read(1)\n  if not c: quit()\n  if c==b'\\0': break\n  b.extend(c)\n q=json.loads(b)\n if q['method']=='Browser.close': quit()\n data=json.dumps({'id':q['id'],'result':q['params']}).encode()+b'\\0'\n w.write(data[:3]); w.write(data[3:])\n").unwrap();
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
