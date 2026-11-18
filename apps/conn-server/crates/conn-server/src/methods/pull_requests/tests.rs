use super::*;
use crate::table::{CallContext, Handler};
use conn_contract::{
    Command, DispatchCommandError, DispatchCommandResult, GetShellSnapshotError,
    GetThreadProjectionError, ShellStreamItem, SubscribeShellInput, SubscribeThreadInput,
    ThreadStreamItem,
};
use conn_engine::{BoxFuture, EngineError, Subscription};
use std::os::unix::fs::PermissionsExt;
struct TestDir(PathBuf);
impl TestDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "conn-pr-panel-{}-{}",
            std::process::id(),
            conn_support::uuid_v4()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        Self(dir)
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Shell {
    snapshot: Mutex<Value>,
    live: tokio::sync::broadcast::Sender<ShellStreamItem>,
}
impl Engine for Shell {
    fn dispatch(
        &self,
        _: Command,
    ) -> BoxFuture<'_, Result<DispatchCommandResult, EngineError<DispatchCommandError>>> {
        Box::pin(async { Err(EngineError::Internal("not called".into())) })
    }
    fn subscribe_thread(
        &self,
        _: SubscribeThreadInput,
    ) -> BoxFuture<
        '_,
        Result<
            Subscription<ThreadStreamItem, GetThreadProjectionError>,
            EngineError<GetThreadProjectionError>,
        >,
    > {
        Box::pin(async { Err(EngineError::Internal("not called".into())) })
    }
    fn shell_snapshot(&self) -> BoxFuture<'_, Result<Value, EngineError<GetShellSnapshotError>>> {
        Box::pin(async { Ok(self.snapshot.lock().expect("snapshot").clone()) })
    }
    fn call(&self, tag: &str, _: Value) -> BoxFuture<'_, Result<Value, EngineError<Value>>> {
        let archived = tag == "orchestration.getArchivedShellSnapshot";
        Box::pin(async move {
            if archived {
                Ok(json!({"threads":[]}))
            } else {
                Err(EngineError::Internal("unexpected call".into()))
            }
        })
    }
    fn subscribe_shell(
        &self,
        input: SubscribeShellInput,
    ) -> BoxFuture<
        '_,
        Result<
            Subscription<ShellStreamItem, GetShellSnapshotError>,
            EngineError<GetShellSnapshotError>,
        >,
    > {
        let mut live = self.live.subscribe();
        Box::pin(async move {
            assert_eq!(
                input.request_completion_marker,
                Some(true),
                "need the synchronization marker"
            );
            let (tx, rx) = mpsc::channel(2);
            tx.send(Ok(
                from_json(json!({"kind":"synchronized"})).expect("marker")
            ))
            .await
            .expect("marker delivered");
            tokio::spawn(async move {
                while let Ok(item) = live.recv().await {
                    if tx.send(Ok(item)).await.is_err() {
                        return;
                    }
                }
            });
            Ok(rx)
        })
    }
}

fn shell(root: &std::path::Path) -> Arc<Shell> {
    Arc::new(Shell {
        snapshot: Mutex::new(
            json!({"projects":[{"id":"p1","title":"Repo","workspaceRoot":root,"repositoryIdentity":{"locator":{"remoteUrl":"git@github.com:a/b.git"}}}],"threads":[]}),
        ),
        live: tokio::sync::broadcast::channel(8).0,
    })
}
fn panel(engine: Arc<Shell>, dir: &TestDir, endpoint: &str) -> Arc<Panel> {
    let gh = dir.0.join("gh");
    std::fs::write(&gh, "#!/bin/sh\nprintf '%s\\n' fake-pr-token\n").expect("stub gh");
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).expect("executable");
    let mut path = dir.0.as_os_str().to_os_string();
    path.push(":");
    path.push(std::env::var_os("PATH").unwrap_or_default());
    Arc::new(Panel {
        engine,
        environment: None,
        cache: TtlCache::new(32),
        identities: TtlCache::new(8),
        endpoints: Endpoints {
            github_rest: Some(endpoint.into()),
        },
        host_environment: Environment::fixed([]),
        child_env: vec![("PATH", path), ("HOME", dir.0.clone().into_os_string())],
        credentials: Mutex::new(VecDeque::new()),
        next_scope: AtomicU64::new(1),
        refreshes: watch::channel(0).0,
        linked: watch::channel(0).0,
        monitor: OnceCell::new(),
        reports: Mutex::new(VecDeque::new()),
    })
}
async fn call(table: &MethodTable, tag: &str, input: Value) -> Result<Value, Failure> {
    match table.get(tag) {
        Some(Handler::Unary(call)) => call(CallContext::default(), input).await,
        _ => panic!("{tag} is registered"),
    }
}
fn reference() -> Value {
    json!({"projectId":"p1","host":"github.com","repository":"a/b","number":7})
}

#[test]
fn panel_capabilities_follow_t3_except_the_explicitly_unserved_features() {
    let mut expected: Value = serde_json::from_str(include_str!(
        "../../../../conn-source-control/src/pull_requests/capabilities.json"
    ))
    .expect("T3 capabilities");
    let fields = expected.as_object_mut().expect("capabilities");
    fields.insert("actions".into(), json!([]));
    fields.insert("mergeMethods".into(), json!([]));
    for key in [
        "deleteBranch",
        "updateMethods",
        "stackActions",
        "withheldFileDiff",
    ] {
        fields.remove(key);
    }
    assert_eq!(
        capabilities(),
        expected,
        "each capability follows T3 or has an explicit unsupported decision"
    );
}

#[tokio::test]
async fn github_actions_register_and_fail_unsigned_as_t3_does() {
    let dir = TestDir::new();
    let panel = panel(shell(&dir.0), &dir, "http://127.0.0.1:1");
    std::fs::write(dir.0.join("gh"), "#!/bin/sh\nexit 1\n").expect("signed-out gh");
    let mut table = MethodTable::new();
    register_panel(&mut table, panel);
    for (method, fields) in [
        ("comment", json!({"body":"hello"})),
        ("replyToThread", json!({"threadId":"thread","body":"hello"})),
        (
            "updateComment",
            json!({"commentId":"comment","kind":"issue-comment","body":"hello"}),
        ),
        ("setReaction", json!({"content":"heart","reacted":true})),
        (
            "setThreadResolution",
            json!({"threadId":"thread","resolved":true}),
        ),
        (
            "submitReview",
            json!({"verdict":"approve","body":"","comments":[]}),
        ),
        (
            "requestReviewers",
            json!({"reviewers":[{"id":"reviewer","kind":"user"}],"requested":true}),
        ),
        ("reviewerCandidates", json!({})),
        ("labelCandidates", json!({})),
        ("setLabels", json!({"labels":["bug"],"applied":true})),
        ("update", json!({"body":"new body"})),
        ("stack", json!({})),
        ("reviewGuide", json!({})),
    ] {
        let mut input = reference();
        input
            .as_object_mut()
            .expect("ref")
            .extend(fields.as_object().expect("fields").clone());
        let error = call(&table, &format!("pullRequests.{method}"), input)
            .await
            .expect_err(method);
        assert!(
            matches!(error, Failure::Fail(ref value) if value["_tag"] == "PullRequestUnavailableError" && value["reason"] == "cli-unauthenticated"),
            "{method}: {error:?}"
        );
    }
    let mut routed = reference();
    routed["expectedAccountId"] = json!("12");
    routed["body"] = json!("hello");
    let error = call(&table, "pullRequests.comment", routed)
        .await
        .expect_err("account unavailable");
    assert!(
        matches!(error, Failure::Fail(ref value) if value["_tag"] == "PullRequestOperationError" && value["operation"] == "routeIdentity" && value["detail"] == "The signed-in account could not be verified before starting the operation."),
        "{error:?}"
    );
}

async fn api() -> (String, tokio::task::JoinHandle<()>, Arc<AtomicU64>) {
    let (base, task, calls, _) = counted_api(axum::http::StatusCode::OK).await;
    (base, task, calls)
}
async fn counted_api(
    status: axum::http::StatusCode,
) -> (
    String,
    tokio::task::JoinHandle<()>,
    Arc<AtomicU64>,
    Arc<AtomicU64>,
) {
    use axum::{Json, Router, routing::get};
    let calls = Arc::new(AtomicU64::new(0));
    let counter = calls.clone();
    let identities = Arc::new(AtomicU64::new(0));
    let identity_calls = identities.clone();
    let router=Router::new().route("/user",get(move || { identity_calls.fetch_add(1,Ordering::Relaxed); async move { (status,Json(json!({"id":12,"login":"nick"}))) } })).route("/graphql",axum::routing::post(move |Json(body):Json<Value>|{let counter=counter.clone();
async move {
        counter.fetch_add(1,Ordering::Relaxed);
let query=text(&body,"query");
let mut pr:Value=serde_json::from_str(include_str!("../../../../conn-source-control/src/pull_requests/sample.json")).expect("sample");

        let data=if query.contains("RoutingIdentityViewer") { json!({"viewer":{"databaseId":12,"login":"nick"}}) }
        else if query.contains("PullRequestStats") && body["variables"].get("_0_owner").is_some() {json!({"_0_repository":{"pullRequest":{"additions":10,"deletions":2}}})}
        else if query.starts_with("mutation ") {
            if body["variables"]["body"] == "fail" {return Json(json!({"errors":[{"message":"refused"}]}));}
            json!({})
        }
        else if query.contains("PullRequestSubject") {json!({"repository":{"pullRequest":{"id":"PR7"}},"node":{"__typename":"IssueComment","id":"C7","pullRequest":{"id":"PR7"}}})}
        else if query.contains("ReviewerCandidates") {json!({"repository":{"assignableUsers":{"nodes":[{"login":"reader","name":null,"avatarUrl":null}],"pageInfo":{"hasNextPage":false}},"pullRequest":{"author":{"login":"author"},"reviewRequests":{"nodes":[]}}}})}
        else if query.contains("LabelCandidates") {json!({"repository":{"labels":{"nodes":[{"name":"bug","color":"abcdef","description":null}],"pageInfo":{"hasNextPage":false}},"pullRequest":{"labels":{"nodes":[]}}}})}
        else if query.contains("PullRequestSearch") {json!({"search":{"nodes":[pr],"pageInfo":{"hasNextPage":false}}})}
        else if query.contains("RepositoryLabels"){json!({"repository":{"labels":{"nodes":[{"name":"bug","color":"abcdef"}],"pageInfo":{"hasNextPage":false}}}})}
        else if query.contains("PullRequestFilesViewed")||query.contains("PullRequestFileStats"){json!({"repository":{"pullRequest":{"files":{"nodes":[{"path":"file.rs","viewerViewedState":"VIEWED","additions":7,"deletions":2}],"pageInfo":{"hasNextPage":false}}}}})}
        else if query.contains("SetFileViewed"){json!({"markFileAsViewed":{"clientMutationId":null}})}
        else if query.contains("PullRequestNodeId"){json!({"repository":{"pullRequest":{"id":"PR7"}}})}
        else {pr["comments"]=json!({"nodes":[],"pageInfo":{"hasNextPage":false}});
pr["reviews"]=json!({"nodes":[],"pageInfo":{"hasNextPage":false}});
pr["reviewThreads"]=json!({"nodes":[],"pageInfo":{"hasNextPage":false}});
pr["reviewDismissals"]=json!({"nodes":[],"pageInfo":{"hasNextPage":false}});
pr["commits"]=json!({"nodes":[]});
json!({"viewer":{"login":"nick"},"repository":{"pullRequest":pr,"mergeCommitAllowed":true,"squashMergeAllowed":true,"rebaseMergeAllowed":true,"autoMergeAllowed":true,"viewerPermission":"WRITE"}})};
        Json(json!({"data":data}))
    }})).route("/repos/a/b/stacks",get(||async {Json(json!([]))})).fallback(||async {axum::http::StatusCode::NO_CONTENT});

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.expect("stub API");
    });
    (base, task, calls, identities)
}

#[tokio::test]
async fn panel_reads_decode_and_refreshes_replace_cached_reads() {
    let dir = TestDir::new();
    let shell = shell(&dir.0);
    let (base, task, count) = api().await;
    let panel = panel(shell, &dir, &base);
    let mut table = MethodTable::new();
    register_panel(&mut table, panel.clone());
    for tag in [
        "pullRequests.summary",
        "pullRequests.detail",
        "pullRequests.preview",
        "pullRequests.checks",
        "pullRequests.activity",
        "pullRequests.filesViewed",
        "pullRequests.changeBreakdown",
        "pullRequests.routing",
    ] {
        let result = call(&table, tag, reference()).await.expect(tag);
        assert!(!result.is_null(), "{tag} decodes a value");
    }
    let list = call(&table, "pullRequests.list", json!({"state":"open"}))
        .await
        .expect("list");
    assert_eq!(
        list["entries"].as_array().expect("entries").len(),
        1,
        "listed"
    );
    assert_eq!(
        list["providers"][0]["detail"],
        Value::Null,
        "configured host has no error"
    );
    let stats = call(
        &table,
        "pullRequests.listStats",
        json!({"refs":[reference()]}),
    )
    .await
    .expect("stats");
    assert_eq!(stats["stats"][0]["additions"], 10, "stats");
    let options = call(
        &table,
        "pullRequests.filterOptions",
        json!({"kind":"labels"}),
    )
    .await
    .expect("options");
    assert_eq!(options["labels"][0]["name"], "bug", "labels");
    assert_eq!(
        call(
            &table,
            "pullRequests.routingIdentity",
            json!({"host":"github.com"})
        )
        .await
        .expect("identity")["accountId"],
        "12",
        "stable account id"
    );
    let previous = count.load(Ordering::Relaxed);
    call(&table, "pullRequests.summary", reference())
        .await
        .expect("cached");
    assert_eq!(
        count.load(Ordering::Relaxed),
        previous,
        "warm cache shares a read"
    );
    call(
        &table,
        "pullRequests.invalidate",
        json!({"reference":reference()}),
    )
    .await
    .expect("invalidated");
    call(&table, "pullRequests.summary", reference())
        .await
        .expect("fresh");
    assert_eq!(
        count.load(Ordering::Relaxed),
        previous + 1,
        "refresh hits GitHub"
    );
    call(&table,"pullRequests.setFilesViewed",json!({"projectId":"p1","host":"github.com","repository":"a/b","number":7,"files":[{"path":"file.rs","viewed":false}]})).await.expect("unviewed");
    task.abort();
}

#[tokio::test]
async fn actions_decode_and_success_notifies_but_failure_still_invalidates() {
    let dir = TestDir::new();
    let (base, task, count) = api().await;
    let panel = panel(shell(&dir.0), &dir, &base);
    let mut table = MethodTable::new();
    register_panel(&mut table, panel.clone());
    for (method, fields) in [
        ("comment", json!({"body":"comment"})),
        ("replyToThread", json!({"threadId":"T7","body":"reply"})),
        (
            "updateComment",
            json!({"commentId":"C7","kind":"issue-comment","body":"edit"}),
        ),
        (
            "setReaction",
            json!({"subjectId":"C7","content":"heart","reacted":false}),
        ),
        (
            "setThreadResolution",
            json!({"threadId":"T7","resolved":false}),
        ),
        (
            "submitReview",
            json!({"verdict":"approve","body":"","comments":[]}),
        ),
        (
            "requestReviewers",
            json!({"reviewers":[{"id":"reader","kind":"user"}],"requested":false}),
        ),
        ("setLabels", json!({"labels":["bug"],"applied":false})),
        ("update", json!({"body":"","maintainerCanModify":false})),
    ] {
        call(&table, "pullRequests.summary", reference())
            .await
            .expect("warm cache");
        let before = *panel.refreshes.borrow();
        let mut input = reference();
        input
            .as_object_mut()
            .expect("ref")
            .extend(fields.as_object().expect("fields").clone());
        assert_eq!(
            call(&table, &format!("pullRequests.{method}"), input)
                .await
                .expect(method),
            Value::Null,
            "{method}"
        );
        assert_eq!(
            *panel.refreshes.borrow(),
            before + 1,
            "{method} notifies the existing refresh stream"
        );
        assert!(panel.cache.is_empty(), "{method} invalidates its reads");
    }
    for method in ["reviewerCandidates", "labelCandidates"] {
        let before = *panel.refreshes.borrow();
        let result = call(&table, &format!("pullRequests.{method}"), reference())
            .await
            .expect(method);
        assert_eq!(
            result["candidates"].as_array().expect("candidates").len(),
            1,
            "{method} decodes"
        );
        assert_eq!(
            *panel.refreshes.borrow(),
            before,
            "candidate reads do not notify"
        );
    }
    assert_eq!(
        call(&table, "pullRequests.stack", reference())
            .await
            .expect("stack"),
        Value::Null,
        "no stack decodes"
    );
    call(&table, "pullRequests.summary", reference())
        .await
        .expect("cache");
    let before = *panel.refreshes.borrow();
    let mut input = reference();
    input["body"] = json!("fail");
    let error = call(&table, "pullRequests.comment", input)
        .await
        .expect_err("failed write");
    assert!(
        matches!(error,Failure::Fail(ref value) if value["_tag"]=="PullRequestOperationError"&&value["operation"]=="comment"),
        "{error:?}"
    );
    assert_eq!(
        *panel.refreshes.borrow(),
        before,
        "failed writes do not announce success"
    );
    assert!(
        panel.cache.is_empty(),
        "failed writes discard possibly stale answers"
    );
    let before = count.load(Ordering::Relaxed);
    call(&table, "pullRequests.summary", reference())
        .await
        .expect("reread");
    assert_eq!(
        count.load(Ordering::Relaxed),
        before + 1,
        "next read reaches GitHub after failure"
    );
    let before = count.load(Ordering::Relaxed);
    let cached = panel.cache.len();
    for (method, fields) in [
        ("comment", json!({"body":"do not send"})),
        ("comment", json!({"body":" \n"})),
        ("runAction", json!({"action":"close"})),
        ("generateReviewGuide", json!({})),
    ] {
        let mut input = reference();
        input["expectedAccountId"] = json!("wrong");
        input
            .as_object_mut()
            .expect("input")
            .extend(fields.as_object().expect("fields").clone());
        let error = call(&table, &format!("pullRequests.{method}"), input)
            .await
            .expect_err("wrong account");
        assert!(
            matches!(error, Failure::Fail(ref value) if value["operation"] == "routeIdentity"),
            "routing precedes validation: {error:?}"
        );
        assert_eq!(
            panel.cache.len(),
            cached,
            "wrong accounts do not invalidate reads"
        );
    }
    assert_eq!(
        count.load(Ordering::Relaxed),
        before,
        "mismatched routing sends no mutation or permissions read"
    );
    for (method, fields, detail) in [
        (
            "comment",
            json!({"body":" \n"}),
            "A comment cannot be empty.",
        ),
        (
            "replyToThread",
            json!({"threadId":"T7","body":" \n"}),
            "A reply cannot be empty.",
        ),
        (
            "updateComment",
            json!({"commentId":"C7","kind":"review-comment","body":" \n"}),
            "A comment cannot be empty.",
        ),
        ("update", json!({}), "Nothing was changed."),
        (
            "submitReview",
            json!({"verdict":"comment","body":" \n","comments":[]}),
            "A review needs a summary or at least one comment.",
        ),
    ] {
        let mut input = reference();
        input
            .as_object_mut()
            .expect("ref")
            .extend(fields.as_object().expect("fields").clone());
        let error = call(&table, &format!("pullRequests.{method}"), input)
            .await
            .expect_err(method);
        assert!(
            matches!(error,Failure::Fail(ref v) if v["detail"]==detail),
            "{method}: {error:?}"
        );
    }
    task.abort();
}

#[tokio::test]
async fn unavailable_actions_and_guide_generation_return_typed_refusals() {
    let dir = TestDir::new();
    let mut panel = panel(shell(&dir.0), &dir, "http://127.0.0.1:1");
    let environment = Arc::new(
        ServerEnvironment::load(
            &dir.0,
            Some("Refusals".into()),
            dir.0.clone(),
            Default::default(),
        )
        .expect("environment"),
    );
    Arc::get_mut(&mut panel).expect("new panel").environment = Some(environment.clone());
    let mut table = MethodTable::new();
    register_panel(&mut table, panel.clone());
    for enabled in [false, true] {
        environment
            .settings
            .update(json!({"reviewGuidesEnabled":enabled}), None)
            .expect("settings");
        let error = call(&table, "pullRequests.generateReviewGuide", reference())
            .await
            .expect_err("generation refused");
        let detail = if enabled {
            "This server cannot generate review guides yet."
        } else {
            "Review guides are off. Turn them on in Settings → Source control & issues."
        };
        assert!(
            matches!(error, Failure::Fail(ref value) if value["_tag"] == "PullRequestOperationError" && value["operation"] == "generateReviewGuide" && value["detail"] == detail),
            "{error:?}"
        );
    }
    for action in [
        "merge",
        "ready",
        "draft",
        "close",
        "reopen",
        "delete-branch",
        "update-branch",
        "enable-auto-merge",
        "disable-auto-merge",
        "revert",
        "approve-workflows",
    ] {
        let mut input = reference();
        input["action"] = json!(action);
        let error = call(&table, "pullRequests.runAction", input)
            .await
            .expect_err("action refused");
        let detail = if action == "delete-branch" {
            "This host cannot delete a change request's source branch.".into()
        } else {
            format!("This host cannot {action} a change request.")
        };
        assert!(
            matches!(error, Failure::Fail(ref value) if value["_tag"] == "PullRequestOperationError" && value["operation"] == "runAction" && value["detail"] == detail),
            "{action}: {error:?}"
        );
    }
    let mut stack = reference();
    stack["action"] = json!("merge");
    stack["stackNumber"] = json!(1);
    let error = call(&table, "pullRequests.runAction", stack)
        .await
        .expect_err("stack action refused");
    assert!(
        matches!(error, Failure::Fail(ref value) if value["operation"] == "runAction" && value["detail"] == "This stack action is not supported or has no expected head revision."),
        "{error:?}"
    );
    assert_eq!(
        *panel.refreshes.borrow(),
        0,
        "refusals never announce success"
    );
}

#[tokio::test]
async fn cancelling_a_write_discards_reads_started_while_it_was_in_flight() {
    use axum::{Json, Router, routing::post};
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let observed = started.clone();
    let resume = release.clone();
    let router=Router::new().route("/graphql",post(move |Json(body):Json<Value>| {
        let observed=observed.clone();
        let resume=resume.clone();
        async move {
            if text(&body,"query").starts_with("mutation ") {
                observed.notify_one();
                resume.notified().await;
            }
            Json(json!({"data":{"repository":{"viewerPermission":"WRITE","pullRequest":{"id":"PR7","viewerDidAuthor":false}}}}))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("address"));
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.expect("API");
    });
    let dir = TestDir::new();
    let panel = panel(shell(&dir.0), &dir, &base);
    let mut input = reference();
    input["body"] = json!("write");
    let mut write = Box::pin(panel.call("comment", input));
    tokio::select! {
        ()=started.notified()=>{},
        result=&mut write=>panic!("write ended before gate: {result:?}"),
    }
    let key = ReadKey {
        scope: 1,
        method: "summary".into(),
        host: "github.com".into(),
        repo: "a/b".into(),
        number: Some(7),
        input: reference().to_string(),
    };
    panel
        .cache
        .get_with(
            key,
            |_| Duration::from_secs(60),
            || async { Ok(json!({"old":true})) },
        )
        .await
        .expect("cached read");
    assert_eq!(
        panel.cache.len(),
        1,
        "a read can finish while the write is running"
    );
    drop(write);
    assert!(
        panel.cache.is_empty(),
        "cancellation runs the post-write invalidation too"
    );
    assert_eq!(
        *panel.refreshes.borrow(),
        0,
        "cancelled write does not announce success"
    );
    release.notify_one();
    task.abort();
}

#[tokio::test]
async fn review_guide_reads_t3_storage_keeps_stale_head_and_survives_restart() {
    let dir = TestDir::new();
    let fixture: Value =
        serde_json::from_str(include_str!("guide-fixture.json")).expect("T3 guide recording");
    assert_eq!(
        guides::load(
            dir.0.join("statev2.sqlite"),
            "github.com".into(),
            "a/b".into(),
            7
        )
        .await
        .expect("absent database"),
        Value::Null,
        "fresh servers have no stored guide"
    );
    assert!(
        !dir.0.join("statev2.sqlite").exists(),
        "reading does not create T3's database"
    );
    let database =
        rusqlite::Connection::open(dir.0.join("statev2.sqlite")).expect("guide database");
    database
        .execute_batch(text(&fixture, "schema"))
        .expect("T3 table");
    database.execute("INSERT INTO pull_request_review_guides (host,repository,number,guide_json) VALUES ('github.com','a/b',7,?1)",[text(&fixture,"stored")]).expect("T3 stored row");
    let (base, task, _) = api().await;
    for _ in 0..2 {
        let mut panel = panel(shell(&dir.0), &dir, &base);
        Arc::get_mut(&mut panel).expect("new panel").environment = Some(Arc::new(
            ServerEnvironment::load(
                &dir.0,
                Some("Guide test".into()),
                dir.0.clone(),
                Default::default(),
            )
            .expect("environment"),
        ));
        let mut table = MethodTable::new();
        register_panel(&mut table, panel);
        let result = call(&table, "pullRequests.reviewGuide", reference())
            .await
            .expect("stored guide");
        assert_eq!(
            result["guide"], fixture["guide"],
            "T3's actual stored JSON decodes with every section intact"
        );
        assert_eq!(result["run"], Value::Null, "no guide generation is running");
        let raw: Value = serde_json::from_str(include_str!(
            "../../../../conn-source-control/src/pull_requests/sample.json"
        ))
        .expect("sample");
        assert_eq!(
            result["currentHeadSha"], raw["headRefOid"],
            "current head is read from GitHub; stale guide keeps its own head"
        );
        let mut missing = reference();
        missing["number"] = json!(8);
        assert_eq!(
            call(&table, "pullRequests.reviewGuide", missing)
                .await
                .expect("missing guide")["guide"],
            Value::Null,
            "absence is null"
        );
        let mut wrong = reference();
        wrong["projectId"] = json!("missing");
        let error = call(&table, "pullRequests.reviewGuide", wrong)
            .await
            .expect_err("unknown project");
        assert!(
            matches!(error,Failure::Fail(ref v) if v["operation"]=="reviewGuide"&&v["detail"]=="Could not identify this pull request's host."),
            "{error:?}"
        );
    }
    let mut panel = panel(shell(&dir.0), &dir, &base);
    Arc::get_mut(&mut panel).expect("new panel").environment = Some(Arc::new(
        ServerEnvironment::load(
            &dir.0,
            Some("Guide test".into()),
            dir.0.clone(),
            Default::default(),
        )
        .expect("environment"),
    ));
    let mut table = MethodTable::new();
    register_panel(&mut table, panel);
    let mut bad_line = fixture["guide"].clone();
    bad_line["stops"][0]["excerpts"][0]["start"] = json!(0);
    let mut blank = fixture["guide"].clone();
    blank["headSha"] = json!("  ");
    let mut missing_attention = fixture["guide"].clone();
    missing_attention["stops"][0]
        .as_object_mut()
        .expect("stop")
        .remove("attention");
    for corrupt in [
        "broken".into(),
        bad_line.to_string(),
        blank.to_string(),
        missing_attention.to_string(),
        "x".repeat(8 * 1024 * 1024 + 1),
    ] {
        database
            .execute(
                "UPDATE pull_request_review_guides SET guide_json=?1",
                [corrupt],
            )
            .expect("corrupt row");
        let error = call(&table, "pullRequests.reviewGuide", reference())
            .await
            .expect_err("corrupt data");
        assert!(
            matches!(error,Failure::Fail(ref v) if v["operation"]=="reviewGuide"&&v["detail"]=="Could not read the stored review guide."),
            "{error:?}"
        );
    }
    task.abort();
}

#[tokio::test]
async fn routing_rejects_a_changed_account_before_reading_and_cache_is_bounded() {
    let dir = TestDir::new();
    let (base, task, count) = api().await;
    let panel = panel(shell(&dir.0), &dir, &base);
    let mut table = MethodTable::new();
    register_panel(&mut table, panel.clone());
    let mut input = reference();
    input["expectedAccountId"] = json!("13");
    let error = call(&table, "pullRequests.summary", input)
        .await
        .expect_err("wrong account");
    assert!(
        matches!(error,Failure::Fail(ref v) if v["operation"]=="routeIdentity"),
        "typed routing error"
    );
    assert_eq!(
        count.load(Ordering::Relaxed),
        0,
        "no PR read under another account"
    );
    let before = resident_kib();
    for number in 1..=40 {
        let mut input = reference();
        input["number"] = json!(number);
        call(&table, "pullRequests.summary", input)
            .await
            .expect("summary");
    }
    assert_eq!(panel.cache.len(), 32, "cache has a fixed capacity");
    println!(
        "PR panel cache: before {} KiB RSS, after {} KiB RSS, 40 reads, {} retained entries",
        before,
        resident_kib(),
        panel.cache.len()
    );
    task.abort();
}

#[tokio::test]
async fn linked_threads_exclude_side_chats_and_dismissed_links_and_keep_archived_state() {
    let dir = TestDir::new();
    let engine = shell(&dir.0);
    let link = json!({"host":"GitHub.com","repository":"A/B","number":7,"source":"agent"});
    engine.snapshot.lock().expect("snapshot")["threads"] = json!([
        {"id":"first","projectId":"p2","title":"First","archivedAt":null,"settledAt":null,"settledOverride":null,"updatedAt":"2026-11-16T00:00:00Z","pullRequests":[link.clone()]},
        {"id":"side","lineage":{"sideChat":true},"pullRequests":[link.clone()]},
        {"id":"dismissed","pullRequests":[{"host":"github.com","repository":"a/b","number":7,"source":"stack-dismissed"}]},
        {"id":"second","projectId":"p1","title":"Second","archivedAt":"2026-11-15T00:00:00Z","settledAt":null,"settledOverride":"settled","updatedAt":"2026-11-15T00:00:00Z","pullRequests":[link]}
    ]);
    let panel = panel(engine, &dir, "http://127.0.0.1:1");
    let mut table = MethodTable::new();
    register_panel(&mut table, panel);
    let result = call(&table, "pullRequests.linkedThreads", reference())
        .await
        .expect("linked");
    assert_eq!(
        result["threads"].as_array().expect("threads").len(),
        2,
        "visible links only"
    );
    assert_eq!(result["threads"][0]["id"], "first", "newest first");
    assert_eq!(result["threads"][1]["settled"], true, "settled override");
}

#[tokio::test]
async fn both_refresh_streams_deliver_initial_values_and_live_changes() {
    let dir = TestDir::new();
    let engine = shell(&dir.0);
    let panel = panel(engine.clone(), &dir, "http://127.0.0.1:1");
    let mut table = MethodTable::new();
    register_panel(&mut table, panel);
    let Some(Handler::Stream(open)) = table.get("pullRequests.subscribeRefreshes") else {
        panic!("refresh stream")
    };
    let mut refresh = open(CallContext::default(), json!({}))
        .await
        .expect("subscribe");
    assert_eq!(
        refresh.recv().await.expect("initial").expect("value"),
        json!(0),
        "initial refresh revision"
    );
    call(&table, "pullRequests.invalidate", json!({}))
        .await
        .expect("invalidate");
    assert_eq!(
        refresh.recv().await.expect("refreshed").expect("value"),
        json!(1),
        "refresh revision"
    );
    let Some(Handler::Stream(open)) = table.get("pullRequests.subscribeLinkedThreadRefreshes")
    else {
        panic!("linked stream")
    };
    let mut linked = open(CallContext::default(), json!({}))
        .await
        .expect("subscribe");
    assert_eq!(
        linked.recv().await.expect("initial").expect("value"),
        json!(0),
        "initial linked revision"
    );
    engine
        .live
        .send(
            from_json(
                json!({"kind":"thread.removed","sequence":1,"location":"active","threadId":"t1"}),
            )
            .expect("event"),
        )
        .expect("monitor subscribed");
    assert_eq!(
        linked.recv().await.expect("changed").expect("value"),
        json!(1),
        "link changes reach readers"
    );
}

#[tokio::test(start_paused = true)]
async fn state_reports_dedupe_the_same_state_but_keep_transitions_and_expire() {
    let dir = TestDir::new();
    let panel = panel(shell(&dir.0), &dir, "http://127.0.0.1:1");
    let mut table = MethodTable::new();
    register_panel(&mut table, panel.clone());
    let report = |state: &str| json!({"reference":reference(),"state":state,"isDraft":false});
    call(&table, "pullRequests.reportState", report("open"))
        .await
        .expect("first");
    let first = *panel.refreshes.borrow();
    call(&table, "pullRequests.reportState", report("open"))
        .await
        .expect("duplicate");
    assert_eq!(
        *panel.refreshes.borrow(),
        first,
        "a repeat report spends no refresh"
    );
    call(&table, "pullRequests.reportState", report("closed"))
        .await
        .expect("transition");
    assert_eq!(
        *panel.refreshes.borrow(),
        first + 1,
        "state transitions notify"
    );
    call(&table, "pullRequests.reportState", report("open"))
        .await
        .expect("reopened");
    assert_eq!(
        *panel.refreshes.borrow(),
        first + 2,
        "a previous state may come back"
    );
    tokio::time::advance(Duration::from_secs(5 * 60)).await;
    call(&table, "pullRequests.reportState", report("open"))
        .await
        .expect("expired");
    assert_eq!(
        *panel.refreshes.borrow(),
        first + 3,
        "reports expire after five minutes"
    );
    for number in 1..=2050 {
        let mut value = report("open");
        value["reference"]["number"] = json!(number);
        call(&table, "pullRequests.reportState", value)
            .await
            .expect("bounded report");
    }
    assert_eq!(
        panel.reports.lock().expect("reports").len(),
        2048,
        "reported-state memory is bounded"
    );
}

#[tokio::test]
async fn viewed_only_invalidation_keeps_other_reads_and_writes_require_the_write_scope() {
    let dir = TestDir::new();
    let (base, task, count) = api().await;
    let panel = panel(shell(&dir.0), &dir, &base);
    let mut table = MethodTable::new();
    register_panel(&mut table, panel.clone());
    call(&table, "pullRequests.summary", reference())
        .await
        .expect("summary");
    call(&table, "pullRequests.filesViewed", reference())
        .await
        .expect("viewed");
    let before = count.load(Ordering::Relaxed);
    call(
        &table,
        "pullRequests.invalidate",
        json!({"reference":reference(),"filesViewedOnly":true}),
    )
    .await
    .expect("invalidate viewed");
    call(&table, "pullRequests.summary", reference())
        .await
        .expect("held summary");
    assert_eq!(
        count.load(Ordering::Relaxed),
        before,
        "summary stays cached"
    );
    call(&table, "pullRequests.filesViewed", reference())
        .await
        .expect("fresh viewed");
    assert_eq!(
        count.load(Ordering::Relaxed),
        before + 1,
        "viewed list is refreshed"
    );
    let Some(Handler::Unary(write)) = table.get("pullRequests.setFilesViewed") else {
        panic!("write")
    };
    let context = CallContext {
        principal: Some(Arc::new(crate::auth::Principal {
            session_id: "test".into(),
            subject: "test".into(),
            scopes: vec!["orchestration:read".into()],
            expires_at_ms: u64::MAX,
        })),
        ..CallContext::default()
    };
    let mut input = reference();
    input["files"] = json!([]);
    let error = write(context, input).await.expect_err("read-only client");
    assert!(
        matches!(error,Failure::Fail(ref v) if v["_tag"]=="EnvironmentAuthorizationError"),
        "typed permission error"
    );
    assert_eq!(
        count.load(Ordering::Relaxed),
        before + 1,
        "authorization fails before any mutation"
    );
    task.abort();
}

fn resident_kib() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines().find_map(|l| {
                l.strip_prefix("VmRSS:")
                    .and_then(|n| n.split_whitespace().next())
                    .and_then(|n| n.parse().ok())
            })
        })
        .unwrap_or(0)
}

#[tokio::test]
async fn declared_github_repository_identity_routes_an_enterprise_checkout() {
    let dir = TestDir::new();
    let engine = shell(&dir.0);
    engine.snapshot.lock().expect("snapshot")["projects"][0]["repositoryIdentity"] =
        json!({"provider":"github","locator":{"remoteUrl":"git@github.example:a/b.git"}});
    let panel = panel(engine, &dir, "http://127.0.0.1:1");
    let projects = panel.projects(&json!({})).await.expect("projects");
    assert_eq!(projects.len(), 1, "known GitHub identity is reused");
    assert_eq!(projects[0].host, "github.example", "Enterprise host");
}

#[tokio::test]
async fn viewed_mutations_only_evict_the_references_viewed_files() {
    let dir = TestDir::new();
    let (base, task, count) = api().await;
    let panel = panel(shell(&dir.0), &dir, &base);
    let mut other = reference();
    other["number"] = json!(8);
    for input in [reference(), other.clone()] {
        panel.call("summary", input.clone()).await.expect("summary");
        panel.call("filesViewed", input).await.expect("viewed");
    }
    let mut input = reference();
    input["files"] = json!([{"path":"file.rs","viewed":false}]);
    panel.call("setFilesViewed", input).await.expect("mutation");
    assert_eq!(
        *panel.refreshes.borrow(),
        0,
        "a viewed toggle is not a PR refresh"
    );
    let before = count.load(Ordering::Relaxed);
    panel
        .call("summary", reference())
        .await
        .expect("summary remains warm");
    panel
        .call("filesViewed", other)
        .await
        .expect("other PR remains warm");
    assert_eq!(
        count.load(Ordering::Relaxed),
        before,
        "unrelated entries remain cached"
    );
    panel
        .call("filesViewed", reference())
        .await
        .expect("fresh viewed files");
    assert_eq!(
        count.load(Ordering::Relaxed),
        before + 1,
        "only the changed PR is fetched"
    );
    task.abort();
}

#[tokio::test]
async fn list_and_stats_share_reads_until_refresh() {
    let dir = TestDir::new();
    let (base, task, count) = api().await;
    let panel = panel(shell(&dir.0), &dir, &base);
    for (method, input) in [
        ("list", json!({"state":"open"})),
        ("listStats", json!({"refs":[reference()]})),
    ] {
        let reads = count.load(Ordering::Relaxed);
        let (first, second) = tokio::join!(
            panel.call(method, input.clone()),
            panel.call(method, input.clone())
        );
        assert_eq!(
            first.expect("first"),
            second.expect("second"),
            "coalesced results"
        );
        assert_eq!(
            count.load(Ordering::Relaxed),
            reads + 1,
            "{method} coalesces"
        );
        let before = count.load(Ordering::Relaxed);
        panel.call(method, input.clone()).await.expect("warm");
        assert_eq!(count.load(Ordering::Relaxed), before, "{method} stays warm");
        panel
            .call("invalidate", json!({"reference":reference()}))
            .await
            .expect("refresh");
        panel.call(method, input.clone()).await.expect("fresh");
        assert_eq!(
            count.load(Ordering::Relaxed),
            before + 1,
            "{method} refreshes"
        );
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(if method == "list" { 30 } else { 60 })).await;
        tokio::time::resume();
        panel.call(method, input.clone()).await.expect("expired");
        assert_eq!(
            count.load(Ordering::Relaxed),
            before + 2,
            "{method} expires at T3's TTL"
        );
        std::fs::write(
            dir.0.join("gh"),
            "#!/bin/sh\nprintf '%s\\n' changed-pr-token\n",
        )
        .expect("switch login");
        panel.call(method, input).await.expect("changed credential");
        assert_eq!(
            count.load(Ordering::Relaxed),
            before + 3,
            "{method} never reuses another credential's cache"
        );
        std::fs::write(
            dir.0.join("gh"),
            "#!/bin/sh\nprintf '%s\\n' fake-pr-token\n",
        )
        .expect("restore login");
    }
    task.abort();
}

#[tokio::test]
async fn repository_list_errors_use_t3s_repository_text_and_access_hint() {
    use axum::{
        Json, Router,
        routing::{get, post},
    };
    let status = Arc::new(AtomicU64::new(404));
    let response_status = status.clone();
    let router = Router::new()
        .route(
            "/user",
            get(|| async { Json(json!({"id":12,"login":"nick"})) }),
        )
        .route(
            "/graphql",
            post(move || {
                let status = response_status.load(Ordering::Relaxed) as u16;
                async move {
                    (
                        axum::http::StatusCode::from_u16(status).expect("status"),
                        Json(json!({"message":"failed read"})),
                    )
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.expect("serve");
    });
    let dir = TestDir::new();
    let panel = panel(shell(&dir.0), &dir, &base);
    let result = panel
        .call("list", json!({"state":"open"}))
        .await
        .expect("partial list");
    assert_eq!(
        result["errors"][0]["message"],
        "a/b could not be read. Your gh login can't see it. Give it access, or save a token in Settings → Source control & issues."
    );
    status.store(503, Ordering::Relaxed);
    panel
        .call("invalidate", json!({}))
        .await
        .expect("invalidate");
    let result = panel
        .call("list", json!({"state":"open"}))
        .await
        .expect("failed repository");
    assert_eq!(
        result["errors"][0]["message"], "a/b could not be read.",
        "no raw provider error without an access hint"
    );
    task.abort();
}

#[tokio::test]
async fn http_diff_shares_the_rpc_panels_cache_and_skips_account_verification() {
    use axum::{Router, routing::get};
    use conn_source_control::http::{self, HttpRequest, Method};
    let count = Arc::new(AtomicU64::new(0));
    let counter = count.clone();
    let api = Router::new().route(
        "/repos/a/b/pulls/7",
        get(move || {
            counter.fetch_add(1, Ordering::Relaxed);
            async { "diff --git a/file b/file\n" }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind api");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    let api_task = tokio::spawn(async move {
        axum::serve(listener, api).await.expect("api");
    });
    let dir = TestDir::new();
    let engine = shell(&dir.0);
    let panel = panel(engine.clone(), &dir, &base);
    let deps = Deps {
        engine: Some(engine),
        ..Deps::default()
    };
    assert!(
        deps.pull_requests.0.set(panel).is_ok(),
        "inject shared service"
    );
    let mut table = MethodTable::new();
    register(&mut table, &deps);
    let table = Arc::new(table);
    let auth = crate::auth::AuthStore::in_memory();
    let session = auth
        .issue_session(crate::auth::SessionRequest {
            scopes: vec!["orchestration:read".into()],
            label: None,
            subject: None,
            ttl_ms: crate::auth::SESSION_TTL_MS,
        })
        .expect("session");
    let state = crate::AppState {
        table: table.clone(),
        auth,
        descriptor: Arc::new(json!({})),
        engine: deps.engine.clone(),
        deps,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind server");
    let url = format!(
        "http://{}/api/pull-requests/diff",
        listener.local_addr().expect("addr")
    );
    let server_task = tokio::spawn(async move {
        axum::serve(listener, crate::http::router(state))
            .await
            .expect("server");
    });
    let mut input = reference();
    input["expectedAccountId"] = json!("different-account");
    let request = || {
        HttpRequest::new(Method::Post, url.clone())
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {}", session.token))
            .body(input.to_string().into_bytes())
    };
    let (first, second) = tokio::join!(http::send(request()), http::send(request()));
    for response in [first.expect("first"), second.expect("second")] {
        assert_eq!(response.status, 200, "{}", response.text());
        assert_eq!(
            serde_json::from_slice::<Value>(&response.body).expect("JSON")["patch"],
            "diff --git a/file b/file\n"
        );
    }
    assert_eq!(count.load(Ordering::Relaxed), 1, "HTTP callers coalesce");
    http::send(request()).await.expect("warm");
    assert_eq!(
        count.load(Ordering::Relaxed),
        1,
        "HTTP requests share the cache"
    );
    call(
        &table,
        "pullRequests.invalidate",
        json!({"reference":reference()}),
    )
    .await
    .expect("RPC refresh");
    http::send(request()).await.expect("fresh");
    assert_eq!(
        count.load(Ordering::Relaxed),
        2,
        "RPC refresh evicts the HTTP diff"
    );
    server_task.abort();
    api_task.abort();
}

#[tokio::test]
async fn identity_is_shared_by_credential_expires_and_routes_through_forbidden_user() {
    let dir = TestDir::new();
    let (base, task, _, identities) = counted_api(axum::http::StatusCode::FORBIDDEN).await;
    let engine = shell(&dir.0);
    let mut second = engine.snapshot.lock().expect("snapshot")["projects"][0].clone();
    second["id"] = json!("p2");
    second["repositoryIdentity"]["locator"]["remoteUrl"] = json!("git@github.com:a/c.git");
    engine.snapshot.lock().expect("snapshot")["projects"]
        .as_array_mut()
        .expect("projects")
        .push(second);
    let panel = panel(engine, &dir, &base);
    let (routing, identity) = tokio::join!(
        panel.call("routing", reference()),
        panel.call("routingIdentity", json!({"host":"github.com"}))
    );
    routing.expect("routing fallback");
    identity.expect("identity fallback");
    panel
        .call("list", json!({"state":"open"}))
        .await
        .expect("both repositories");
    panel.call("detail", reference()).await.expect("detail");
    let mut expected = reference();
    expected["expectedAccountId"] = json!("12");
    panel
        .call("summary", expected)
        .await
        .expect("verified read");
    assert_eq!(
        identities.load(Ordering::Relaxed),
        1,
        "all readers share the pinned identity"
    );
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(599)).await;
    tokio::time::resume();
    panel
        .call("routing", reference())
        .await
        .expect("warm identity");
    assert_eq!(identities.load(Ordering::Relaxed), 1);
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(1)).await;
    tokio::time::resume();
    panel
        .call("routing", reference())
        .await
        .expect("expired identity");
    assert_eq!(identities.load(Ordering::Relaxed), 2, "ten-minute TTL");
    std::fs::write(dir.0.join("gh"), "#!/bin/sh\necho switched-token\n")
        .expect("switch credential");
    panel
        .call("routing", reference())
        .await
        .expect("new credential");
    assert_eq!(
        identities.load(Ordering::Relaxed),
        3,
        "another credential cannot reuse the identity"
    );
    let before = resident_kib();
    for n in 0..10 {
        std::fs::write(dir.0.join("gh"), format!("#!/bin/sh\necho identity-{n}\n"))
            .expect("credential");
        panel
            .call("routing", reference())
            .await
            .expect("bounded identity");
    }
    assert_eq!(
        panel.identities.len(),
        8,
        "identity cache stays bounded with credential scopes"
    );
    println!(
        "identity cache RSS: {before} -> {} KiB; {} retained",
        resident_kib(),
        panel.identities.len()
    );
    task.abort();
}

#[test]
fn observed_threads_evict_the_oldest_observation_and_keep_completion_together() {
    let mut views = VecDeque::new();
    for id in std::iter::once("z-oldest".into()).chain((0..2047).map(|n| format!("a-{n}"))) {
        remember_view(
            &mut views,
            ObservedThread::new(&json!({"id":id,"latestRunCompletedAt":"done"})),
        );
    }
    remember_view(&mut views, ObservedThread::new(&json!({"id":"new"})));
    assert_eq!(views.len(), 2048);
    assert!(
        !views.iter().any(|v| v.id == "z-oldest"),
        "evict by observation order, not identifier"
    );
    assert!(
        views.iter().any(|v| v.id == "a-0" && v.completed == "done"),
        "newer state remains intact"
    );
}
