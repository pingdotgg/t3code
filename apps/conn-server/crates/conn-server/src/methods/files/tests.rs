use std::sync::Arc;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;
use crate::{
    auth::{AuthStore, Principal},
    table::{CallContext, Handler, MethodTable},
};

struct Setup {
    dir: std::path::PathBuf,
    table: MethodTable,
    deps: Deps,
}

impl Drop for Setup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn setup(name: &str) -> Setup {
    let dir = std::env::temp_dir().join(format!("conn-server-files-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("project/img")).unwrap();
    let dir = std::fs::canonicalize(dir).unwrap();
    std::fs::write(dir.join("project/hello.txt"), "hi").unwrap();
    let deps = Deps {
        files: Some(Arc::new(
            conn_files::Files::open(&dir.join("state")).unwrap(),
        )),
        ..Deps::default()
    };
    let mut table = MethodTable::new();
    register(&mut table, &deps);
    Setup { dir, table, deps }
}

async fn call(
    table: &MethodTable,
    ctx: CallContext,
    tag: &str,
    input: Value,
) -> Result<Value, Failure> {
    let Some(Handler::Unary(handler)) = table.get(tag) else {
        panic!("{tag} is not registered")
    };
    handler(ctx, input).await
}

fn with_scopes(scopes: &[&str]) -> CallContext {
    CallContext {
        headers: Vec::new(),
        principal: Some(Arc::new(Principal {
            session_id: "s".into(),
            subject: "u".into(),
            scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
            expires_at_ms: u64::MAX,
        })),
        ..CallContext::default()
    }
}

#[tokio::test(flavor = "current_thread")]
async fn registers_the_area_and_checks_scopes() {
    let s = setup("scopes");
    for tag in [
        "projects.listEntries",
        "projects.listIgnoredFiles",
        "projects.readFile",
        "projects.writeFile",
        "projects.searchEntries",
        "projects.searchContents",
        "filesystem.browse",
        "filesystem.getMetadata",
        "shell.openInEditor",
        "assets.createUrl",
        "assets.persistChatAttachments",
        "attachments.createUploadUrl",
        "attachments.delete",
    ] {
        assert!(s.table.get(tag).is_some(), "{tag}");
    }
    let cwd = s.dir.join("project").to_string_lossy().into_owned();
    let read = json!({"cwd": cwd, "relativePath": "hello.txt"});
    let ok = call(
        &s.table,
        with_scopes(&["filesystem:read"]),
        "projects.readFile",
        read.clone(),
    )
    .await;
    assert_eq!(ok.unwrap()["contents"], "hi");
    let Err(Failure::Fail(error)) = call(
        &s.table,
        with_scopes(&["orchestration:read"]),
        "projects.readFile",
        read,
    )
    .await
    else {
        panic!("expected a typed failure")
    };
    assert_eq!(error["_tag"], "EnvironmentAuthorizationError");
    assert_eq!(error["requiredPermission"], "filesystem:read");

    // A host file asset needs filesystem:read; a favicon only orchestration:read.
    let media = json!({"resource": {"_tag": "media-file", "threadId": "t", "path": "/etc/hosts"}});
    let Err(Failure::Fail(error)) = call(
        &s.table,
        with_scopes(&["orchestration:read"]),
        "assets.createUrl",
        media,
    )
    .await
    else {
        panic!()
    };
    assert_eq!(error["requiredPermission"], "filesystem:read");

    // Contract limits the generated types do not check end as defects, never a panic.
    let long = json!({"cwd": cwd, "query": "x".repeat(300), "limit": 5,
        "caseSensitive": false, "wholeWord": false, "useRegex": true});
    assert!(matches!(
        call(
            &s.table,
            CallContext::default(),
            "projects.searchContents",
            long
        )
        .await,
        Err(Failure::Die(_))
    ));

    // No editor on a server host.
    let Err(Failure::Fail(error)) = call(
        &s.table,
        CallContext::default(),
        "shell.openInEditor",
        json!({"cwd": cwd, "editor": "cursor"}),
    )
    .await
    else {
        panic!()
    };
    assert_eq!(error["_tag"], "ExternalLauncherCommandNotFoundError");

    // Without an engine no project is known, so writes are refused.
    let Err(Failure::Fail(error)) = call(
        &s.table,
        CallContext::default(),
        "projects.writeFile",
        json!({"cwd": cwd, "relativePath": "x.txt", "contents": "x"}),
    )
    .await
    else {
        panic!()
    };
    assert_eq!(error["failure"], "workspace_path_outside_root");
}

/// One HTTP/1.1 request; returns status, headers and body bytes.
async fn http(addr: std::net::SocketAddr, head: &str, body: &[u8]) -> (u16, String, Vec<u8>) {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let request = format!(
        "{head}\r\nhost: {addr}\r\nconnection: close\r\ncontent-length: {}\r\n\r\n",
        body.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    // A refused upload is answered before its body is read; the reset that follows is fine.
    let _ = stream.write_all(body).await;
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 8192];
    while let Ok(n) = stream.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..n]);
    }
    let split = bytes.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let headers = String::from_utf8_lossy(&bytes[..split]).into_owned();
    let status = headers[9..12].parse().unwrap();
    (status, headers.to_lowercase(), bytes[split + 4..].to_vec())
}

#[tokio::test(flavor = "current_thread")]
async fn uploads_and_serves_attachments_over_http() {
    let s = setup("http");
    let state = crate::AppState {
        table: Arc::new(MethodTable::new()),
        auth: AuthStore::in_memory(),
        descriptor: Arc::new(json!({})),
        engine: None,
        deps: s.deps.clone(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, crate::router(state)).await });

    // A `file` upload of a PNG: the generated input union would pick the image member and fail.
    let file = call(
        &s.table,
        CallContext::default(),
        "attachments.createUploadUrl",
        json!({"type": "file", "name": "diagram.png", "mimeType": "image/png", "sizeBytes": 3}),
    )
    .await
    .unwrap();
    assert!(file["attachmentId"].as_str().unwrap().ends_with("-png"));
    let png = {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        b.extend_from_slice(&7u32.to_be_bytes());
        b.extend_from_slice(&9u32.to_be_bytes());
        b.extend_from_slice(&[1; 40]);
        b
    };
    let issued = call(
        &s.table,
        CallContext::default(),
        "attachments.createUploadUrl",
        json!({"name": "shot.png", "mimeType": "image/png", "sizeBytes": png.len()}),
    )
    .await
    .unwrap();
    let url = issued["relativeUrl"].as_str().unwrap();
    let id = issued["attachmentId"].as_str().unwrap();

    let (status, _, _) = http(addr, &format!("POST {url} HTTP/1.1"), &png[..10]).await;
    assert_eq!(status, 400, "a short body is refused");
    let (status, _, _) = http(addr, &format!("POST {url}x HTTP/1.1"), &png).await;
    assert_eq!(status, 404, "a forged token");
    let (status, _, _) = http(addr, &format!("POST {url} HTTP/1.1"), &png).await;
    assert_eq!(status, 204);
    let (status, _, _) = http(addr, &format!("POST {url} HTTP/1.1"), &png).await;
    assert_eq!(status, 204, "the same bytes again");

    let asset = call(
        &s.table,
        CallContext::default(),
        "assets.createUrl",
        json!({"resource": {"_tag": "attachment", "attachmentId": id}}),
    )
    .await
    .unwrap();
    assert_eq!(asset["imageDimensions"], json!({"width": 7, "height": 9}));
    let asset_url = asset["relativeUrl"].as_str().unwrap();
    let (status, headers, body) = http(addr, &format!("GET {asset_url} HTTP/1.1"), b"").await;
    assert_eq!((status, body.as_slice()), (200, png.as_slice()));
    assert!(headers.contains("content-type: image/png"), "{headers}");
    assert!(headers.contains("x-content-type-options: nosniff"));
    let (status, headers, body) = http(
        addr,
        &format!("GET {asset_url} HTTP/1.1\r\nrange: bytes=1-3"),
        b"",
    )
    .await;
    assert_eq!((status, body.as_slice()), (206, &png[1..4]));
    assert!(headers.contains(&format!("content-range: bytes 1-3/{}", png.len())));
    let (status, _, _) = http(
        addr,
        &format!("GET {asset_url} HTTP/1.1\r\nrange: bytes=999-"),
        b"",
    )
    .await;
    assert_eq!(status, 416);
    let (status, _, _) = http(addr, "GET /api/assets/forged.sig/x.png HTTP/1.1", b"").await;
    assert_eq!(status, 404);

    // Deleting the pending upload removes it; its URL then answers 404.
    call(
        &s.table,
        CallContext::default(),
        "attachments.delete",
        json!({"attachmentId": id}),
    )
    .await
    .unwrap();
    let (status, _, _) = http(addr, &format!("GET {asset_url} HTTP/1.1"), b"").await;
    assert_eq!(status, 404);
}

/// A worktree under `<state>/worktrees` reads like any workspace; the server's internal files
/// (T3's set plus `auth.json` and `terminals/`) stay out of reads, listings and searches,
/// even when the search root holds the state folder.
#[tokio::test(flavor = "current_thread")]
async fn worktrees_in_the_state_folder_read_and_internal_files_stay_hidden() {
    let s = setup("internal");
    let state = s.dir.join("state");
    let worktree = state.join("worktrees/project/t3-1");
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::write(worktree.join("main.rs"), "fn main() {}").unwrap();
    std::fs::write(worktree.join("pic.png"), b"\x89PNG\r\n\x1a\n").unwrap();
    for (path, body) in [
        ("auth.json", "needle-auth"),
        ("engine.sqlite", "needle-db"),
        ("terminals/t1.log", "needle-terminal"),
        ("settings.json", "{}"),
    ] {
        let path = state.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }
    let ctx = || with_scopes(&["filesystem:read"]);
    let text = |p: &std::path::Path| p.to_string_lossy().into_owned();

    let read = call(
        &s.table,
        ctx(),
        "projects.readFile",
        json!({"cwd": text(&worktree), "relativePath": "main.rs"}),
    )
    .await;
    assert_eq!(read.unwrap()["contents"], "fn main() {}");
    let meta = call(
        &s.table,
        ctx(),
        "filesystem.getMetadata",
        json!({"paths": [text(&worktree.join("main.rs"))]}),
    )
    .await
    .unwrap();
    assert!(meta["entries"][0]["kind"] == "file", "{meta}");
    let url = call(
        &s.table,
        ctx(),
        "assets.createUrl",
        json!({"resource": {
        "_tag": "draft-workspace-file", "cwd": text(&worktree), "path": "pic.png"}}),
    )
    .await;
    assert!(url.is_ok(), "{url:?}");

    for internal in [
        "secrets/asset-signing-key",
        "auth.json",
        "engine.sqlite",
        "terminals/t1.log",
    ] {
        let read = call(
            &s.table,
            ctx(),
            "projects.readFile",
            json!({"cwd": text(&state), "relativePath": internal}),
        )
        .await;
        assert!(read.is_err(), "{internal}");
        let meta = call(
            &s.table,
            ctx(),
            "filesystem.getMetadata",
            json!({"paths": [text(&state.join(internal))]}),
        )
        .await
        .unwrap();
        assert!(meta["entries"][0].is_null(), "{internal}: {meta}");
    }
    // As in T3, other state files are not internal.
    let settings = call(
        &s.table,
        ctx(),
        "projects.readFile",
        json!({"cwd": text(&state), "relativePath": "settings.json"}),
    )
    .await;
    assert!(settings.is_ok(), "{settings:?}");

    // A root inside the internal set is refused.
    for root in [state.join("secrets"), state.join("terminals")] {
        let search = call(
            &s.table,
            ctx(),
            "projects.searchContents",
            json!({"cwd": text(&root),
            "query": "needle", "limit": 50, "caseSensitive": false, "wholeWord": false,
            "useRegex": false}),
        )
        .await;
        assert!(search.is_err(), "{root:?}: {search:?}");
        let listed = call(
            &s.table,
            ctx(),
            "projects.listEntries",
            json!({"cwd": text(&root)}),
        )
        .await;
        assert!(listed.is_err(), "{root:?}");
        let found = call(
            &s.table,
            ctx(),
            "projects.searchEntries",
            json!({"cwd": text(&root), "query": "", "limit": 50}),
        )
        .await;
        assert!(found.is_err(), "{root:?}");
        let ignored = call(
            &s.table,
            ctx(),
            "projects.listIgnoredFiles",
            json!({"cwd": text(&root)}),
        )
        .await;
        assert!(ignored.is_err(), "{root:?}");
    }
    // A root that holds the state folder skips the internal files during the walk.
    for root in [state.clone(), s.dir.clone()] {
        let search = call(
            &s.table,
            ctx(),
            "projects.searchContents",
            json!({"cwd": text(&root),
            "query": "needle", "limit": 50, "caseSensitive": false, "wholeWord": false,
            "useRegex": false}),
        )
        .await
        .unwrap();
        assert_eq!(search["matches"], json!([]), "{root:?}");
        let key = call(
            &s.table,
            ctx(),
            "projects.searchContents",
            json!({"cwd": text(&root),
            "query": ".", "limit": 500, "caseSensitive": false, "wholeWord": false,
            "useRegex": true}),
        )
        .await
        .unwrap();
        assert!(!key.to_string().contains("asset-signing-key"), "{root:?}");
        for listing in [
            call(
                &s.table,
                ctx(),
                "projects.listEntries",
                json!({"cwd": text(&root)}),
            )
            .await
            .unwrap(),
            call(
                &s.table,
                ctx(),
                "projects.searchEntries",
                json!({"cwd": text(&root), "query": "", "limit": 500}),
            )
            .await
            .unwrap(),
        ] {
            let listing = listing.to_string();
            for hidden in ["asset-signing-key", "auth.json", "engine.sqlite", "t1.log"] {
                assert!(
                    !listing.contains(hidden),
                    "{root:?} lists {hidden}: {listing}"
                );
            }
            assert!(
                listing.contains("main.rs") && listing.contains("settings.json"),
                "{listing}"
            );
        }
    }
    let dir = call(
        &s.table,
        ctx(),
        "projects.listEntries",
        json!({"cwd": text(&state), "directoryPath": ""}),
    )
    .await
    .unwrap()
    .to_string();
    assert!(
        !dir.contains("secrets")
            && !dir.contains("auth.json")
            && !dir.contains("terminals")
            && dir.contains("worktrees"),
        "{dir}"
    );
}

/// `UploadChatImageAttachment` (`chatAttachment.ts`): an image type, at most 10 MiB, a data URL
/// of at most 14,000,000 characters, checked before anything is decoded or stored.
#[tokio::test(flavor = "current_thread")]
async fn persisted_attachments_keep_the_contract_limits() {
    let s = setup("persist-limits");
    let persist = |mime: &str, size: u64, data_url: String| {
        json!({"threadId": "thread-1", "messageId": "m1", "attachments": [{
            "type": "image", "name": "a", "mimeType": mime, "sizeBytes": size, "dataUrl": data_url}]})
    };
    let ok = call(
        &s.table,
        CallContext::default(),
        "assets.persistChatAttachments",
        persist("image/png", 2, "data:image/png;base64,aGk=".into()),
    )
    .await;
    assert!(ok.is_ok(), "{ok:?}");
    for (case, input) in [
        (
            "not an image",
            persist("text/html", 2, "data:text/html;base64,aGk=".into()),
        ),
        (
            "over 10 MiB",
            persist(
                "image/png",
                10 * 1024 * 1024 + 1,
                "data:image/png;base64,aGk=".into(),
            ),
        ),
        (
            "data URL too long",
            persist(
                "image/png",
                2,
                format!("data:image/png;base64,{}", "A".repeat(14_000_000)),
            ),
        ),
        (
            "mimeType too long",
            persist(
                &format!("image/{}", "x".repeat(100)),
                2,
                "data:image/png;base64,aGk=".into(),
            ),
        ),
        (
            "empty name",
            json!({"threadId": "thread-1", "messageId": "m1", "attachments": [{
            "type": "image", "name": "  ", "mimeType": "image/png", "sizeBytes": 2,
            "dataUrl": "data:image/png;base64,aGk="}]}),
        ),
    ] {
        let result = call(
            &s.table,
            CallContext::default(),
            "assets.persistChatAttachments",
            input,
        )
        .await;
        assert!(matches!(result, Err(Failure::Die(_))), "{case}: {result:?}");
    }
    let stored = std::fs::read_dir(s.dir.join("state/attachments"))
        .unwrap()
        .count();
    assert_eq!(stored, 1, "only the valid image is stored");
}

/// Path limits of `ProjectReadFileInput`, `ProjectWriteFileInput`, `FilesystemGetMetadataInput`
/// and `FilesystemBrowseInput`: non-empty, at most 512 UTF-16 units.
#[tokio::test(flavor = "current_thread")]
async fn file_paths_keep_the_contract_limits() {
    let s = setup("path-limits");
    let cwd = s.dir.join("project").to_string_lossy().into_owned();
    let long = "a".repeat(513);
    let ctx = CallContext::default;
    for (tag, input) in [
        (
            "projects.readFile",
            json!({"cwd": cwd, "relativePath": long}),
        ),
        ("projects.readFile", json!({"cwd": cwd, "relativePath": ""})),
        (
            "projects.writeFile",
            json!({"cwd": cwd, "relativePath": long, "contents": "x"}),
        ),
        (
            "filesystem.getMetadata",
            json!({"paths": [format!("/{long}")]}),
        ),
        ("filesystem.getMetadata", json!({"paths": ["  "]})),
        (
            "filesystem.browse",
            json!({"partialPath": format!("/{long}")}),
        ),
        (
            "filesystem.browse",
            json!({"partialPath": "/", "cwd": format!("/{long}")}),
        ),
    ] {
        let result = call(&s.table, ctx(), tag, input.clone()).await;
        assert!(
            matches!(result, Err(Failure::Die(_))),
            "{tag} {input}: {result:?}"
        );
    }
    let ok = call(&s.table, ctx(), "projects.readFile",
        json!({"cwd": cwd, "relativePath": format!("{}xy", "d/".repeat(255)), "allowMissing": true})).await;
    assert!(ok.is_ok(), "{ok:?}");
}
