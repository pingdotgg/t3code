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
    /// What the watch loop sent as `thread.pull-request-watch.sync`.
    syncs: Mutex<Vec<Value>>,
    /// What the link sweep dispatched.
    dispatched: Mutex<Vec<Value>>,
}
impl Engine for Shell {
    fn dispatch(
        &self,
        command: Command,
    ) -> BoxFuture<'_, Result<DispatchCommandResult, EngineError<DispatchCommandError>>> {
        self.dispatched
            .lock()
            .expect("dispatched")
            .push(to_json(&command));
        Box::pin(async {
            from_json(json!({"sequence": 1})).map_err(|e| EngineError::Internal(e.to_string()))
        })
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
    fn sync_pull_request_watch(&self, command: Value) -> BoxFuture<'_, Result<(), String>> {
        self.syncs.lock().expect("syncs").push(command);
        Box::pin(async { Ok(()) })
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
        syncs: Mutex::new(Vec::new()),
        dispatched: Mutex::new(Vec::new()),
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
        activity: Default::default(),
        providers: conn_provider::ProviderSet::default(),
        text_generators: None,
        guide_runs: guide_writer::Runs::default(),
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
    // Not built: deleting the source branch, approving fork workflows, stack actions.
    let actions: Vec<Value> = fields["actions"]
        .as_array()
        .expect("actions")
        .iter()
        .filter(|a| !matches!(a.as_str(), Some("delete-branch" | "approve-workflows")))
        .cloned()
        .collect();
    fields.insert("actions".into(), json!(actions));
    for key in ["deleteBranch", "stackActions", "withheldFileDiff"] {
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
    // Turned on, a run starts (`guide_writer` tests); turned off, it is refused.
    for enabled in [false] {
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
    for action in ["delete-branch", "approve-workflows"] {
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
            vec![dir.0.join("statev2.sqlite")],
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
        descriptor: crate::environment::fixed_descriptor(json!({})),
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

/// A stub GitHub whose pull request 7 has the checks and comments in `state`.
async fn watched_api(state: Arc<Mutex<Value>>) -> (String, tokio::task::JoinHandle<()>) {
    use axum::{Json, Router, routing::get};
    let router = Router::new()
        .route("/user", get(|| async { Json(json!({"id": 12, "login": "nick"})) }))
        .route(
            "/graphql",
            axum::routing::post(move |Json(body): Json<Value>| {
                let state = state.clone();
                async move {
                    let query = text(&body, "query");
                    let now = state.lock().expect("state").clone();
                    let mut pr: Value = serde_json::from_str(include_str!(
                        "../../../../conn-source-control/src/pull_requests/sample.json"
                    ))
                    .expect("sample");
                    pr["headRefOid"] = now["head"].clone();
                    pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"] =
                        json!({"nodes": now["contexts"], "pageInfo": {"hasNextPage": false, "endCursor": null}});
                    pr["comments"] = json!({"nodes": now["comments"], "pageInfo": {"hasNextPage": false}});
                    pr["reviews"] = json!({"nodes": [], "pageInfo": {"hasNextPage": false}});
                    pr["reviewThreads"] = json!({"nodes": [], "pageInfo": {"hasNextPage": false}});
                    pr["reviewDismissals"] = json!({"nodes": [], "pageInfo": {"hasNextPage": false}});
                    let data = if query.contains("RoutingIdentityViewer") {
                        json!({"viewer": {"databaseId": 12, "login": "nick"}})
                    } else {
                        json!({"viewer": {"login": "nick"}, "repository": {"pullRequest": pr,
                            "mergeCommitAllowed": true, "squashMergeAllowed": true,
                            "rebaseMergeAllowed": true, "autoMergeAllowed": true,
                            "viewerPermission": "WRITE"}})
                    };
                    Json(json!({"data": data}))
                }
            }),
        )
        .fallback(|| async { axum::http::StatusCode::NO_CONTENT });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.expect("stub API");
    });
    (base, task)
}

/// The watch loop reads a watched pull request through `gh`'s login and the panel's client,
/// and sends the engine the watch's next state; a change in the checks or a new comment sends
/// T3's wake text (`PullRequestWatchReactor`), and a quiet read sends nothing.
#[tokio::test]
async fn a_watched_pull_request_wakes_its_thread_when_its_checks_or_comments_change() {
    let dir = TestDir::new();
    let shell = shell(&dir.0);
    let state = Arc::new(Mutex::new(json!({
        "head": "1111111111111111111111111111111111111111",
        "contexts": [{"__typename": "StatusContext", "context": "ci", "state": "PENDING",
            "targetUrl": "https://ci.example/ci"}],
        "comments": [],
    })));
    let (base, task) = watched_api(state.clone()).await;
    let started = "2026-11-16T00:00:00.000Z";
    let watch = json!({"startedAt": started, "headSha": null, "failedChecks": [], "passed": false,
        "passedChecks": [], "conflicting": false, "awaitingBaseline": "all",
        "remarksThrough": started, "remarkIds": [], "wakes": 0});
    let thread = |watch: &Value| {
        json!({"id": "t1", "projectId": "p1", "title": "T", "settledAt": null,
            "settledOverride": null, "lineage": {"relationshipToParent": null},
            "pullRequests": [{"host": "github.com", "repository": "a/b", "number": 7,
                "url": "https://github.com/a/b/pull/7", "source": "agent",
                "linkedAt": started, "snapshot": null, "stack": null, "watch": watch}]})
    };
    shell.snapshot.lock().expect("snapshot")["threads"] = json!([thread(&watch)]);
    let panel = panel(shell.clone(), &dir, &base);
    let mut watcher = watches::Watcher::new(panel);

    // The first read is the baseline: the watch remembers the head, nothing wakes.
    watcher.pass(None).await;
    let baseline = shell
        .syncs
        .lock()
        .expect("syncs")
        .pop()
        .expect("baseline sync");
    assert!(baseline.get("wake").is_none(), "{baseline}");
    assert_eq!(baseline["startedAt"], started);
    assert_eq!(baseline["host"], "github.com");
    let next = baseline["watch"].clone();
    assert_eq!(next["headSha"], "1111111111111111111111111111111111111111");
    assert!(next.get("awaitingBaseline").is_none(), "{next}");
    shell.snapshot.lock().expect("snapshot")["threads"] = json!([thread(&next)]);

    // CI fails and a reviewer comments: one wake with both, in T3's words.
    {
        let mut now = state.lock().expect("state");
        now["contexts"][0]["state"] = json!("FAILURE");
        now["comments"] = json!([{"id": "C1", "body": "Please <b>rename</b> this.",
            "createdAt": "2030-01-01T00:00:00Z", "url": "https://github.com/a/b/pull/7#c1",
            "author": {"login": "reviewer"}}]);
    }
    watcher.pass(None).await;
    let woke = shell.syncs.lock().expect("syncs").pop().expect("wake sync");
    let wake = &woke["wake"];
    assert_eq!(
        wake["text"],
        "Update on pull request #7 (https://github.com/a/b/pull/7), which Conn is watching for you:\n\
         - Checks failed on 1111111:\n  - ci https://ci.example/ci\n\
         - 1 new comment:\n  - reviewer: \"Please rename this.\" https://github.com/a/b/pull/7#c1\n\n\
         Look into each item and act on it as your task requires. This PR stays linked and watched, so do not link, watch, or list it again. End your turn when you are done, and Conn wakes you on the next change. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox."
    );
    assert_eq!(
        wake["notification"],
        json!({"source": {"kind": "monitor"}, "outcome": "failed",
            "summary": "#7: checks failed, new comments"})
    );
    assert_eq!(wake["includesRemarks"], true);
    assert!(
        wake["messageId"]
            .as_str()
            .is_some_and(|id| id.starts_with("message:pr-watch:"))
    );
    assert_eq!(woke["watch"]["failedChecks"], json!(["ci"]));

    // A pass with nothing new sends nothing.
    shell.snapshot.lock().expect("snapshot")["threads"] = json!([thread(&woke["watch"])]);
    watcher.pass(None).await;
    assert!(
        shell.syncs.lock().expect("syncs").is_empty(),
        "a quiet pull request is left alone"
    );

    // A merged pull request ends the watch without a wake.
    {
        let mut snapshot = shell.snapshot.lock().expect("snapshot");
        snapshot["threads"][0]["pullRequests"][0]["snapshot"] = json!({"state": "merged"});
    }
    watcher.pass(None).await;
    let ended = shell.syncs.lock().expect("syncs").pop().expect("end sync");
    assert_eq!(ended["watch"], Value::Null);
    assert!(ended.get("wake").is_none());
    task.abort();
}

/// A stub GitHub for the link sweep. Pull request 7 (`sample.json`, head `feature`) lives in
/// `head_repository`; head lookups are recorded and can be held open; summaries can fail.
struct HeadStub {
    head_repository: String,
    asked: Mutex<Vec<String>>,
    reads: Mutex<Vec<String>>,
    fail_summary: bool,
    /// Held head lookups wait for `release`; `entered` tells that one is held.
    hold: bool,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

impl HeadStub {
    fn new(head_repository: &str) -> Arc<Self> {
        Arc::new(Self {
            head_repository: head_repository.into(),
            asked: Mutex::new(Vec::new()),
            reads: Mutex::new(Vec::new()),
            fail_summary: false,
            hold: false,
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        })
    }
}

async fn head_api(stub: Arc<HeadStub>) -> (String, tokio::task::JoinHandle<()>) {
    use axum::{Json, Router, routing::get, routing::post};
    let router = Router::new()
        .route(
            "/user",
            get(|| async { Json(json!({"id": 12, "login": "nick"})) }),
        )
        .route(
            "/graphql",
            post(move |Json(body): Json<Value>| {
                let stub = stub.clone();
                async move {
                    let query = text(&body, "query").to_owned();
                    let mut pr: Value = serde_json::from_str(include_str!(
                        "../../../../conn-source-control/src/pull_requests/sample.json"
                    ))
                    .expect("sample");
                    pr["updatedAt"] = json!("2030-01-01T00:00:00Z");
                    pr["headRepository"]["nameWithOwner"] = json!(stub.head_repository);
                    let owner = stub.head_repository.split('/').next().unwrap_or_default();
                    pr["headRepositoryOwner"]["login"] = json!(owner);
                    pr["isCrossRepository"] = json!(stub.head_repository != "a/b");
                    if query.starts_with("query PullRequestsByHead") {
                        stub.reads
                            .lock()
                            .expect("reads")
                            .push("PullRequestsByHead".into());
                        if stub.hold {
                            stub.entered.notify_one();
                            stub.release.notified().await;
                        }
                        let mut data = serde_json::Map::new();
                        for index in 0.. {
                            let Some(head) = body["variables"][format!("_{index}_head")].as_str()
                            else {
                                break;
                            };
                            stub.asked.lock().expect("asked").push(head.to_owned());
                            let nodes = if head == "feature" {
                                json!([pr])
                            } else {
                                json!([])
                            };
                            data.insert(
                                format!("_{index}_repository"),
                                json!({"pullRequests": {"nodes": nodes}}),
                            );
                        }
                        return Json(json!({"data": data}));
                    }
                    let name = query
                        .split_whitespace()
                        .nth(1)
                        .and_then(|n| n.split('(').next())
                        .unwrap_or_default()
                        .to_owned();
                    stub.reads.lock().expect("reads").push(name.clone());
                    if name == "PullRequestSummary" && stub.fail_summary {
                        return Json(json!({"errors": [{"type": "INTERNAL", "message": "boom"}]}));
                    }
                    if name != "PullRequestSummary" {
                        let empty = json!({"nodes": [], "pageInfo": {"hasNextPage": false}});
                        for key in ["comments", "reviews", "reviewThreads", "reviewDismissals"] {
                            pr[key] = empty.clone();
                        }
                    }
                    let data = if name == "RoutingIdentityViewer" {
                        json!({"viewer": {"databaseId": 12, "login": "nick"}})
                    } else {
                        json!({"viewer": {"login": "nick"}, "repository": {"pullRequest": pr,
                            "mergeCommitAllowed": true, "squashMergeAllowed": true,
                            "rebaseMergeAllowed": true, "autoMergeAllowed": true,
                            "viewerPermission": "WRITE"}})
                    };
                    Json(json!({"data": data}))
                }
            }),
        )
        .fallback(|| async { axum::http::StatusCode::NOT_FOUND });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.expect("stub API");
    });
    (base, task)
}

fn branch_thread(id: &str, branch: &str) -> Value {
    json!({"id": id, "projectId": "p1", "title": "T", "branch": branch,
        "worktreePath": null, "createdAt": "2026-11-16T00:00:00.000Z",
        "updatedAt": "2026-11-16T00:00:00.000Z", "archivedAt": null, "settledAt": null,
        "settledOverride": null, "lineage": {"relationshipToParent": null}, "pullRequests": []})
}

fn foreground(panel: &Panel) {
    panel
        .activity
        .report_activity(&json!({"clientId": "web-1", "visible": true,
        "focused": true, "recentlyInteracted": false, "scopes": []}));
}

/// The link sweep reads a linked pull request through `gh`'s login and writes its snapshot
/// (`thread.pull-request-link.sync`), and looks the thread's branch up and writes its pull
/// request (`thread.pull-request.sync`), as T3's `PullRequestSyncReactor` and
/// `ThreadPullRequestService` do. The minute sweeps after that look branches up only while a
/// client is in the foreground (`shouldRunOpportunisticWork`); the link reads go on.
#[tokio::test]
async fn the_link_sweep_writes_link_snapshots_and_the_branch_pull_request() {
    let dir = TestDir::new();
    let shell = shell(&dir.0);
    let stub = HeadStub::new("a/b");
    let (base, task) = head_api(stub.clone()).await;
    let mut thread = branch_thread("t1", "feature");
    thread["pullRequests"] = json!([{"host": "github.com", "repository": "a/b", "number": 7,
        "url": "https://github.com/a/b/pull/7", "source": "manual",
        "linkedAt": "2026-11-16T00:00:00.000Z", "snapshot": null, "stack": null}]);
    shell.snapshot.lock().expect("snapshot")["threads"] = json!([thread]);
    let panel = panel(shell.clone(), &dir, &base);
    let mut links = links::Links::new(panel.clone(), links::Settles::default());
    links.tick().await;
    let dispatched = std::mem::take(&mut *shell.dispatched.lock().expect("dispatched"));
    let [link_sync, branch_sync] = dispatched.as_slice() else {
        panic!("two commands: {dispatched:?}")
    };
    assert_eq!(link_sync["type"], "thread.pull-request-link.sync");
    assert_eq!(link_sync["threadId"], "t1");
    let snapshot = &link_sync["snapshot"];
    assert_eq!(snapshot["title"], "A change", "{snapshot}");
    assert_eq!(snapshot["state"], "open");
    assert_eq!(snapshot["reviewDecision"], "approved");
    assert!(snapshot["syncedAt"].is_string());
    assert_eq!(link_sync["stack"], Value::Null);
    assert_eq!(branch_sync["type"], "thread.pull-request.sync");
    assert_eq!(
        branch_sync["branchPullRequest"],
        json!({"projectId": "p1", "repository": "a/b", "number": 7,
            "url": "https://github.com/a/b/pull/7"})
    );
    assert_eq!(branch_sync["expected"]["branch"], "feature");
    assert_eq!(branch_sync["expected"]["branchPullRequest"], Value::Null);
    let take = |m: &Mutex<Vec<String>>| std::mem::take(&mut *m.lock().expect("reads"));
    assert_eq!(
        take(&stub.reads),
        ["PullRequestSummary", "PullRequestsByHead"]
    );
    {
        let mut state = shell.snapshot.lock().expect("snapshot");
        state["threads"][0]["pullRequests"][0]["snapshot"] = snapshot.clone();
        state["threads"][0]["branchPullRequest"] = branch_sync["branchPullRequest"].clone();
    }
    // No client: the open, recently updated link is read again, the branch is not.
    links.tick().await;
    assert_eq!(take(&stub.reads), ["PullRequestSummary"]);
    // A client in the foreground: both, and nothing changed.
    foreground(&panel);
    links.tick().await;
    assert_eq!(
        take(&stub.reads),
        ["PullRequestSummary", "PullRequestsByHead"]
    );
    assert!(shell.dispatched.lock().expect("dispatched").is_empty());
    task.abort();
}

/// Branches of several threads share one GitHub document (T3 batches its background head
/// lookups), and a checkout of a fork's pull request is looked up by the head it pushes to:
/// local `t3code/pr-7/feature`, upstream `fork`'s `feature`, in `forker/b`.
#[tokio::test]
async fn a_fork_checkout_is_looked_up_by_its_published_head_in_one_batch() {
    let dir = TestDir::new();
    let git = |args: &[&str]| {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(&dir.0)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?}");
    };
    git(&["init", "-q"]);
    git(&["config", "branch.t3code/pr-7/feature.remote", "fork"]);
    git(&[
        "config",
        "branch.t3code/pr-7/feature.merge",
        "refs/heads/feature",
    ]);
    git(&[
        "config",
        "remote.fork.url",
        "https://github.com/forker/b.git",
    ]);
    let shell = shell(&dir.0);
    let stub = HeadStub::new("forker/b");
    let (base, task) = head_api(stub.clone()).await;
    shell.snapshot.lock().expect("snapshot")["threads"] = json!([
        branch_thread("t1", "t3code/pr-7/feature"),
        branch_thread("t2", "other"),
    ]);
    let panel = panel(shell.clone(), &dir, &base);
    let mut links = links::Links::new(panel, links::Settles::default());
    links.tick().await;
    assert_eq!(*stub.reads.lock().expect("reads"), ["PullRequestsByHead"]);
    assert_eq!(*stub.asked.lock().expect("asked"), ["feature", "other"]);
    let dispatched = shell.dispatched.lock().expect("dispatched").clone();
    let [found] = dispatched.as_slice() else {
        panic!("one command: {dispatched:?}")
    };
    assert_eq!(found["threadId"], "t1");
    assert_eq!(found["branchPullRequest"]["number"], 7);
    task.abort();
}

/// A thread keeps its saved pull request when the lookup finds none and the saved one cannot
/// be read; T3 then leaves the thread as it is and tries again later.
#[tokio::test]
async fn a_failed_read_of_the_saved_pull_request_clears_nothing() {
    let dir = TestDir::new();
    let shell = shell(&dir.0);
    let stub = Arc::new(HeadStub {
        fail_summary: true,
        ..Arc::try_unwrap(HeadStub::new("a/b"))
            .ok()
            .expect("one owner")
    });
    let (base, task) = head_api(stub.clone()).await;
    let mut thread = branch_thread("t1", "gone");
    thread["branchPullRequest"] = json!({"projectId": "p1", "repository": "a/b", "number": 9,
        "url": "https://github.com/a/b/pull/9"});
    shell.snapshot.lock().expect("snapshot")["threads"] = json!([thread]);
    let panel = panel(shell.clone(), &dir, &base);
    let mut links = links::Links::new(panel, links::Settles::default());
    links.tick().await;
    assert_eq!(
        *stub.reads.lock().expect("reads"),
        ["PullRequestsByHead", "PullRequestSummary"]
    );
    assert!(
        shell.dispatched.lock().expect("dispatched").is_empty(),
        "the saved pull request stays"
    );
    task.abort();
}

/// A new watch's first read does not wait for a branch lookup that GitHub holds open: the
/// link sweep runs beside the watch loop, so CI that ends during the lookup is not taken as
/// the baseline (#146).
#[tokio::test]
async fn a_new_watch_is_read_while_a_branch_lookup_is_held_open() {
    let dir = TestDir::new();
    let shell = shell(&dir.0);
    let stub = Arc::new(HeadStub {
        hold: true,
        ..Arc::try_unwrap(HeadStub::new("a/b"))
            .ok()
            .expect("one owner")
    });
    let (base, task) = head_api(stub.clone()).await;
    shell.snapshot.lock().expect("snapshot")["threads"] = json!([branch_thread("t1", "feature")]);
    let panel = panel(shell.clone(), &dir, &base);
    let loop_task = tokio::spawn(watches::run(panel));
    tokio::time::timeout(Duration::from_secs(10), stub.entered.notified())
        .await
        .expect("the branch lookup is held");
    // The thread gets a watch on pull request 7 while the lookup is held.
    let line = include_str!("../../../../conn-contract/tests/fixtures/sampled.jsonl")
        .lines()
        .find(|l| l.contains(r#""key":"rpc::orchestration::subscribe_shell::Item","value":{"kind":"thread.updated""#))
        .expect("a sampled thread update");
    let mut item: Value = serde_json::from_str::<Value>(line).expect("sample")["value"].clone();
    let started = "2026-11-16T00:00:00.000Z";
    let thread = &mut item["thread"];
    for (key, value) in [
        ("id", json!("t1")),
        ("projectId", json!("p1")),
        ("settledAt", Value::Null),
        ("settledOverride", Value::Null),
        ("archivedAt", Value::Null),
        ("branch", json!("feature")),
        ("worktreePath", Value::Null),
    ] {
        thread[key] = value;
    }
    thread["lineage"]["relationshipToParent"] = Value::Null;
    thread["pullRequests"] = json!([{"host": "github.com", "repository": "a/b", "number": 7,
        "url": "https://github.com/a/b/pull/7", "source": "agent", "linkedAt": started,
        "snapshot": null, "stack": null,
        "watch": {"startedAt": started, "headSha": null, "failedChecks": [], "passed": false,
            "passedChecks": [], "conflicting": false, "awaitingBaseline": "all",
            "remarksThrough": started, "remarkIds": [], "wakes": 0}}]);
    shell.snapshot.lock().expect("snapshot")["threads"] = json!([item["thread"].clone()]);
    shell
        .live
        .send(from_json(item).expect("a shell item"))
        .expect("the listener is subscribed");
    let read = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if !shell.syncs.lock().expect("syncs").is_empty() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    stub.release.notify_waiters();
    loop_task.abort();
    task.abort();
    read.expect("the watch was read while the lookup was held");
    let sync = shell.syncs.lock().expect("syncs")[0].clone();
    assert_eq!(sync["startedAt"], started, "{sync}");
}

/// The shell listener asks the link sweep for what T3's reactors react to: a new link without a
/// snapshot, a new thread on a branch, a run's end, a changed branch, and a settle.
#[test]
fn thread_updates_ask_the_link_sweep_for_what_t3_reacts_to() {
    use links::Request;
    use watches::{Observed, link_requests};
    let link = json!({"host": "github.com", "repository": "a/b", "number": 7,
        "url": "https://github.com/a/b/pull/7", "source": "manual", "snapshot": null,
        "stack": null});
    let base = json!({"id": "t1", "projectId": "p1", "branch": "feature", "worktreePath": null,
        "settledAt": null, "settledOverride": null, "latestRunCompletedAt": null,
        "pullRequests": []});
    let ask = |before: Option<&Value>, now: &Value| {
        let observed = before.map(Observed::new);
        link_requests(now, observed.as_ref(), &Observed::new(now))
    };
    assert_eq!(
        ask(None, &base),
        [Request::Branch("t1".into())],
        "a new thread"
    );
    assert!(ask(Some(&base), &base).is_empty(), "nothing changed");
    let mut linked = base.clone();
    linked["pullRequests"] = json!([link]);
    assert_eq!(
        ask(Some(&base), &linked),
        [Request::Unsynced {
            project_id: "p1".into(),
            link
        }]
    );
    assert!(ask(Some(&linked), &linked).is_empty(), "asked once");
    let mut ended = linked.clone();
    ended["latestRunCompletedAt"] = json!("2026-11-19T10:00:00.000Z");
    assert_eq!(ask(Some(&linked), &ended), [Request::Branch("t1".into())]);
    let mut synced = ended.clone();
    synced["pullRequests"][0]["snapshot"] = json!({"state": "open"});
    let mut settled = synced.clone();
    settled["settledAt"] = json!("2026-11-19T10:01:00.000Z");
    assert_eq!(
        ask(Some(&synced), &settled),
        [Request::Settled(vec!["github.com/a/b#7".into()])]
    );
}

/// Codex finding 4: a settle refresh that finds the request channel full is not lost. The
/// next minute sweep reads the settled thread's open link, which a plain sweep skips.
#[test]
fn a_settle_refresh_survives_a_full_request_channel() {
    use conn_source_control::pull_requests::link_sync::{LinkSync, Scope};
    use links::{Request, Settles, route, take_settles};
    let (tx, _rx) = tokio::sync::mpsc::channel::<Request>(1);
    assert!(tx.try_send(Request::Branch("other".into())).is_ok());
    let settles = Settles::default();
    let key = "github.com/a/b#7".to_owned();
    assert!(
        !route(Request::Settled(vec![key]), &tx, &settles),
        "the channel is full"
    );
    let thread = json!({"id": "t1", "projectId": "p1", "settledAt": "2027-01-15T08:00:00.000Z",
        "settledOverride": null, "pullRequests": [{"host": "github.com", "repository": "a/b",
        "number": 7, "url": "https://github.com/a/b/pull/7", "source": "manual", "stack": null,
        "snapshot": {"state": "open", "updatedAt": "2027-01-15T08:00:00.000Z"}}]});
    let now = 1_800_000_000_000.0;
    let mut plain = LinkSync::default();
    assert!(
        plain
            .begin(std::slice::from_ref(&thread), Scope::All, now)
            .is_empty(),
        "a plain sweep skips a settled thread"
    );
    let mut sync = LinkSync::default();
    take_settles(&settles, &mut sync);
    assert_eq!(
        sync.begin(std::slice::from_ref(&thread), Scope::All, now)
            .len(),
        1,
        "the overflowed settle refresh is read"
    );
}

/// A scratch repository with GitHub-looking remotes that push to local bare repositories
/// (`url.<bare>.insteadOf`), as T3's `configureVisibleRemoteUrlWithLocalRewrite`.
struct HeadRepo {
    dir: TestDir,
}

impl HeadRepo {
    fn new(remotes: &[(&str, &str)]) -> Self {
        let dir = TestDir::new();
        let repo = Self { dir };
        let work = repo.dir.0.join("work");
        std::fs::create_dir_all(&work).expect("work dir");
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.name", "Test"]);
        repo.git(&["config", "user.email", "test@example.com"]);
        repo.git(&["commit", "-q", "--allow-empty", "-m", "Initial"]);
        for (name, repository) in remotes {
            let bare = repo.dir.0.join(format!("{name}.git"));
            let status = std::process::Command::new("git")
                .args(["init", "-q", "--bare"])
                .arg(&bare)
                .status()
                .expect("git");
            assert!(status.success());
            let url = format!("git@github.com:{repository}.git");
            repo.git(&["remote", "add", name, &url]);
            let rewrite = format!("url.{}.insteadOf", bare.display());
            repo.git(&["config", &rewrite, &url]);
        }
        repo
    }

    fn work(&self) -> PathBuf {
        self.dir.0.join("work")
    }

    fn git(&self, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(self.work())
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?}");
    }

    fn project(&self) -> Project {
        Project {
            id: "p1".into(),
            title: "r".into(),
            root: self.work(),
            host: "github.com".into(),
            repository: "o/r".into(),
            remote_url: String::new(),
            remote_name: None,
        }
    }
}

/// Codex finding 1 (T3 GitManager.test.ts "status finds a PR pushed under the branch's own
/// name despite a default upstream"): `feature` made from `origin/main` and pushed without
/// `-u` still tracks `origin/main`; its head is `feature`, not the base `main`.
#[tokio::test]
async fn a_branch_tracking_its_base_is_looked_up_by_its_own_name() {
    let repo = HeadRepo::new(&[("origin", "o/r")]);
    repo.git(&["push", "-q", "-u", "origin", "main"]);
    repo.git(&["remote", "set-head", "origin", "main"]);
    repo.git(&["checkout", "-q", "-b", "feature", "origin/main"]);
    let project = repo.project();
    // Not pushed yet: its upstream is its base, so there is nothing to look up.
    assert!(
        links::head_of(&project, &repo.work(), "feature")
            .await
            .is_none()
    );
    repo.git(&["push", "-q", "origin", "feature"]);
    let query = links::head_of(&project, &repo.work(), "feature")
        .await
        .expect("looked up");
    assert_eq!(query.head.name, "feature");
    assert_eq!(query.head.repository, "o/r");
    assert!(!query.head.cross_repository);
    assert_eq!(query.default_branch.as_deref(), Some("main"));
}

/// Codex round 2: the fork head is still found after the local branch is deleted, through the
/// one remote that tracks it (T3's `branchPullRequest.remoteTrackingRefs`).
#[tokio::test]
async fn a_deleted_local_branch_is_looked_up_in_the_remote_that_tracks_it() {
    let repo = HeadRepo::new(&[("origin", "o/r"), ("fork", "contributor/r")]);
    repo.git(&["push", "-q", "-u", "origin", "main"]);
    repo.git(&["checkout", "-q", "-b", "feature"]);
    repo.git(&["commit", "-q", "--allow-empty", "-m", "Feature"]);
    repo.git(&["push", "-q", "fork", "feature"]);
    repo.git(&["checkout", "-q", "main"]);
    repo.git(&["branch", "-q", "-D", "feature"]);
    let project = repo.project();
    let query = links::head_of(&project, &repo.work(), "feature")
        .await
        .expect("looked up");
    assert_eq!(query.head.name, "feature");
    assert_eq!(query.head.repository, "contributor/r");
    assert!(query.head.cross_repository);
}

/// Codex finding 2 (T3 GitManager.test.ts "finds a fork PR for a branch pushed without an
/// upstream"): `git push fork feature` without `-u` publishes the head in the fork.
#[tokio::test]
async fn a_branch_pushed_to_a_fork_without_upstream_is_looked_up_in_the_fork() {
    let repo = HeadRepo::new(&[("origin", "o/r"), ("fork", "contributor/r")]);
    repo.git(&["push", "-q", "-u", "origin", "main"]);
    repo.git(&["checkout", "-q", "-b", "feature"]);
    repo.git(&["commit", "-q", "--allow-empty", "-m", "Feature"]);
    repo.git(&["push", "-q", "fork", "feature"]);
    let project = repo.project();
    let query = links::head_of(&project, &repo.work(), "feature")
        .await
        .expect("looked up");
    assert_eq!(query.head.name, "feature");
    assert_eq!(query.head.repository, "contributor/r");
    assert!(query.head.cross_repository);
    // Still found after a local commit on top of the pushed one.
    repo.git(&["commit", "-q", "--allow-empty", "-m", "Continue"]);
    let query = links::head_of(&project, &repo.work(), "feature")
        .await
        .expect("looked up");
    assert_eq!(query.head.repository, "contributor/r");
    // The fork's pull request is the branch's, not another fork's with the same name.
    let node = |n: u64, owner: &str| {
        json!({"number": n, "url": format!("https://github.com/o/r/pull/{n}"),
            "state": "OPEN", "headRefName": "feature", "isCrossRepository": true,
            "updatedAt": "2027-01-15T00:00:00Z",
            "headRepository": {"nameWithOwner": format!("{owner}/r")},
            "headRepositoryOwner": {"login": owner}})
    };
    let found = conn_source_control::pull_requests::link_sync::branch_pull_request(
        &[node(40, "someone-else"), node(41, "contributor")],
        &query.head,
        query.default_branch.as_deref(),
    )
    .expect("found");
    assert_eq!(found["number"], 41);
}

/// A review guide model that waits for the test before it answers, and keeps each request.
struct GuideModel {
    id: conn_contract::ProviderInstanceId,
    answer: Result<Value, String>,
    gate: tokio::sync::Semaphore,
    requests: Mutex<Vec<conn_provider::TextGenerationRequest>>,
    /// Whether the checkout existed while the model ran.
    saw_checkout: Mutex<Vec<bool>>,
}
impl conn_provider::Provider for GuideModel {
    fn instance_id(&self) -> &conn_contract::ProviderInstanceId {
        &self.id
    }
    fn driver(&self) -> &str {
        "codex"
    }
    fn server_provider_entry(&self, _: &str) -> Option<Value> {
        Some(
            json!({"enabled": true, "installed": true, "status": "ready", "auth": {"status": "authenticated"}}),
        )
    }
    fn capabilities(
        &self,
    ) -> conn_provider::BoxFuture<
        '_,
        conn_provider::ProviderResult<conn_contract::ProviderCapabilities>,
    > {
        Box::pin(async { Err(conn_provider::ProviderError::SessionStopped) })
    }
    fn open_session(
        &self,
        _: conn_provider::OpenSessionInput,
    ) -> conn_provider::BoxFuture<'_, conn_provider::ProviderResult<conn_provider::OpenedSession>>
    {
        Box::pin(async { Err(conn_provider::ProviderError::SessionStopped) })
    }
    fn generate_text(
        &self,
        request: conn_provider::TextGenerationRequest,
    ) -> conn_provider::BoxFuture<'_, conn_provider::ProviderResult<Value>> {
        Box::pin(async move {
            let _permit = self.gate.acquire().await.expect("gate");
            self.saw_checkout
                .lock()
                .expect("seen")
                .push(std::path::Path::new(&request.cwd).join("a.rs").exists());
            self.requests.lock().expect("requests").push(request);
            self.answer
                .clone()
                .map_err(|detail| conn_provider::ProviderError::Failed {
                    operation: "generate_text",
                    detail,
                })
        })
    }
}

fn git_in(dir: &std::path::Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// A project checkout of `git@github.com:a/b.git` whose ssh is a local script serving a bare
/// repository, with `main` and a pushed `feature` (the pull request's head).
fn guide_repo(dir: &TestDir) -> (PathBuf, String) {
    let work = dir.0.join("work");
    let bare = dir.0.join("b.git");
    std::fs::create_dir_all(&work).expect("work");
    git_in(&dir.0, &["init", "-q", "--bare", "b.git"]);
    let ssh = dir.0.join("ssh");
    std::fs::write(
        &ssh,
        format!("#!/bin/sh\nexec git-upload-pack '{}'\n", bare.display()),
    )
    .expect("ssh stub");
    std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).expect("executable");
    git_in(&work, &["init", "-q", "-b", "main"]);
    for (key, value) in [
        ("user.name", "Test"),
        ("user.email", "test@example.com"),
        ("core.sshCommand", ssh.to_str().expect("path")),
    ] {
        git_in(&work, &["config", key, value]);
    }
    git_in(
        &work,
        &["remote", "add", "origin", "git@github.com:a/b.git"],
    );
    std::fs::write(work.join("a.rs"), "one\ntwo\nthree\n").expect("a.rs");
    git_in(&work, &["add", "."]);
    git_in(&work, &["commit", "-qm", "base"]);
    let push = |refspec: &str| {
        git_in(
            &dir.0,
            &[
                "--git-dir",
                bare.to_str().expect("bare"),
                "fetch",
                "-q",
                work.to_str().expect("work"),
                refspec,
            ],
        );
    };
    push("main:refs/heads/main");
    git_in(&work, &["checkout", "-qb", "feature"]);
    std::fs::write(work.join("a.rs"), "one\nTWO\nthree\nfour\n").expect("a.rs");
    std::fs::write(work.join("b.rs"), "new\n").expect("b.rs");
    git_in(&work, &["add", "."]);
    git_in(&work, &["commit", "-qm", "feature"]);
    let head = git_in(&work, &["rev-parse", "HEAD"]);
    push("feature:refs/heads/feature");
    git_in(&work, &["checkout", "-q", "main"]);
    // The feature commit lives only in the remote: the run must fetch it.
    git_in(&work, &["branch", "-qD", "feature"]);
    git_in(&work, &["reflog", "expire", "--expire=now", "--all"]);
    git_in(&work, &["gc", "-q", "--prune=now"]);
    (work, head)
}

async fn guide_api(head: String) -> (String, tokio::task::JoinHandle<()>) {
    use axum::{Json, Router, routing::get};
    let router = Router::new()
        .route(
            "/graphql",
            axum::routing::post(move |Json(body): Json<Value>| {
                let head = head.clone();
                async move {
                    let query = text(&body, "query");
                    let mut pr: Value = serde_json::from_str(include_str!(
                        "../../../../conn-source-control/src/pull_requests/sample.json"
                    ))
                    .expect("sample");
                    pr["headRefOid"] = json!(head);
                    pr["body"] = json!("Adds four.");
                    pr["comments"] = json!({"nodes":[],"pageInfo":{"hasNextPage":false}});
                    pr["reviews"] = json!({"nodes":[],"pageInfo":{"hasNextPage":false}});
                    pr["reviewThreads"] = json!({"nodes":[{"id":"T1","path":"a.rs","isResolved":true,"isOutdated":false,"line":2,"originalLine":2,"diffSide":"RIGHT","startLine":null,"originalStartLine":null,"startDiffSide":null,"subjectType":"LINE","viewerCanResolve":true,"viewerCanUnresolve":true,"viewerCanReply":true,"resolvedBy":null,"comments":{"nodes":[{"id":"C1","databaseId":1,"body":"Why  upper case?","createdAt":"2026-11-01T00:00:00Z","updatedAt":"2026-11-01T00:00:00Z","author":{"login":"ann","avatarUrl":null},"url":"https://github.com/a/b/pull/7#c1","path":"a.rs","line":2,"originalLine":2,"diffHunk":"","outdated":false,"replyTo":null,"reactionGroups":[],"viewerCanUpdate":false,"viewerCanReact":true}],"pageInfo":{"hasNextPage":false}}}],"pageInfo":{"hasNextPage":false}});
                    pr["reviewDismissals"] = json!({"nodes":[],"pageInfo":{"hasNextPage":false}});
                    pr["commits"] = json!({"nodes":[]});
                    let data = if query.contains("RoutingIdentityViewer") {
                        json!({"viewer":{"databaseId":12,"login":"nick"}})
                    } else {
                        json!({"viewer":{"login":"nick"},"repository":{"pullRequest":pr,"mergeCommitAllowed":true,"squashMergeAllowed":true,"rebaseMergeAllowed":true,"autoMergeAllowed":true,"viewerPermission":"WRITE"}})
                    };
                    Json(json!({"data": data}))
                }
            }),
        )
        .route("/repos/a/b/stacks", get(|| async { Json(json!([])) }))
        .fallback(|| async { axum::http::StatusCode::NO_CONTENT });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.expect("stub API");
    });
    (base, task)
}

async fn guide_panel(
    dir: &TestDir,
    work: &std::path::Path,
    base: &str,
    model: Arc<GuideModel>,
) -> Arc<Panel> {
    let engine = shell(work);
    *engine.snapshot.lock().expect("snapshot") = json!({"projects":[{"id":"p1","title":"Repo","workspaceRoot":work,"repositoryIdentity":{"locator":{"remoteName":"origin","remoteUrl":"git@github.com:a/b.git"}}}],"threads":[]});
    let mut panel = panel(engine, dir, base);
    let environment = Arc::new(
        ServerEnvironment::load(
            &dir.0,
            Some("Guides".into()),
            dir.0.clone(),
            Default::default(),
        )
        .expect("environment"),
    );
    environment
        .settings
        .update(json!({"reviewGuidesEnabled": true}), None)
        .expect("settings");
    let p = Arc::get_mut(&mut panel).expect("new panel");
    p.environment = Some(environment);
    p.providers = conn_provider::ProviderSet::from(vec![model as Arc<dyn conn_provider::Provider>]);
    panel
}

fn guide_input() -> Value {
    json!({"projectId":"p1","host":"github.com","repository":"a/b","number":7})
}

async fn settled_guide(table: &MethodTable) -> Value {
    for _ in 0..300 {
        let read = call(table, "pullRequests.reviewGuide", guide_input())
            .await
            .expect("guide read");
        if read["run"].is_null() || read["run"]["_tag"] == "Failed" {
            return read;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the guide run never ended");
}

#[tokio::test]
async fn a_guide_is_written_from_a_temporary_checkout_and_a_second_request_joins_it() {
    let dir = TestDir::new();
    let (work, head) = guide_repo(&dir);
    let (base, task) = guide_api(head.clone()).await;
    let answer = json!({"stops": [
        {"title": "Two becomes upper case", "summary": "s", "attention": {"kind": "product", "note": "Case matters."},
         "excerpts": [{"path": "a.rs", "side": "new", "start": 1, "end": 9, "caption": "the change"}],
         "files": [{"path": "missing.rs", "note": "gone"}],
         "notes": [{"path": "a.rs", "line": 2, "title": "Upper", "body": "Why."}],
         "questions": ["Why upper?"]}
    ]});
    let model = Arc::new(GuideModel {
        id: from_json(json!("codex")).expect("id"),
        answer: Ok(answer),
        gate: tokio::sync::Semaphore::new(0),
        requests: Mutex::default(),
        saw_checkout: Mutex::default(),
    });
    let panel = guide_panel(&dir, &work, &base, model.clone()).await;
    let mut table = MethodTable::new();
    register_panel(&mut table, panel.clone());

    let first = panel
        .mcp_call("generateReviewGuide", guide_input())
        .await
        .expect("started");
    assert_eq!(first["started"], true);
    assert_eq!(first["run"]["_tag"], "Running");
    assert_eq!(first["run"]["headSha"], head.as_str());
    assert_eq!(first["guide"], Value::Null);
    let joined = call(&table, "pullRequests.generateReviewGuide", guide_input())
        .await
        .expect("joined");
    assert_eq!(
        joined["run"], first["run"],
        "the same head joins the running run"
    );
    assert!(
        joined.get("started").is_none(),
        "the RPC answers the contract's result"
    );
    let again = panel
        .mcp_call("generateReviewGuide", guide_input())
        .await
        .expect("joined");
    assert_eq!(again["started"], false);
    let read = call(&table, "pullRequests.reviewGuide", guide_input())
        .await
        .expect("read while running");
    assert_eq!(read["run"]["_tag"], "Running", "the read reports the run");

    model.gate.add_permits(1);
    let done = settled_guide(&table).await;
    assert_eq!(done["run"], Value::Null, "{done}");
    let guide = &done["guide"];
    assert_eq!(guide["headSha"], head.as_str());
    assert_eq!(guide["modelSelection"]["instanceId"], "codex");
    assert_eq!(
        guide["stops"],
        json!([
            {"title": "Two becomes upper case", "summary": "s", "attention": {"kind": "product", "note": "Case matters."},
             "excerpts": [{"path": "a.rs", "side": "new", "start": 2, "end": 4, "caption": "the change"}],
             "files": [], "notes": [{"path": "a.rs", "line": 2, "title": "Upper", "body": "Why."}],
             "questions": ["Why upper?"]},
            {"title": "Other files", "summary": "Changed files the tour does not otherwise cover.", "attention": null,
             "excerpts": [], "files": [{"path": "b.rs"}], "notes": [], "questions": []}
        ]),
        "clamped from the first to the last hunk it overlaps (lines 2 and 4), unchanged paths dropped, the rest placed"
    );

    {
        let requests = model.requests.lock().expect("requests");
        let request = requests.first().expect("one model run");
        assert_eq!(requests.len(), 1, "a joined request starts nothing");
        assert!(request.investigate, "read-only investigation");
        assert_eq!(request.timeout, Some(Duration::from_secs(15 * 60)));
        assert_eq!(request.operation, "generateReviewGuide");
        assert_eq!(
            request.output_schema,
            crate::text_generation::prompts::REVIEW_GUIDE_OUTPUT_SCHEMA
        );
        assert!(
            request.prompt.contains("change request #7 "),
            "{}",
            request.prompt
        );
        assert!(request.prompt.contains("<pr_title>A change</pr_title>"));
        assert!(request.prompt.contains("Adds four."));
        assert!(
            request
                .prompt
                .contains("- a.rs (resolved, ann): Why upper case?"),
            "{}",
            request.prompt
        );
        assert_eq!(
            *model.saw_checkout.lock().expect("seen"),
            [true],
            "the model read the head's files"
        );
        assert!(
            !std::path::Path::new(&request.cwd).exists(),
            "the checkout is removed"
        );
        assert_eq!(
            git_in(&work, &["worktree", "list", "--porcelain"])
                .matches("worktree ")
                .count(),
            1
        );
        assert_eq!(
            git_in(&work, &["for-each-ref", "refs/t3"]),
            "",
            "the base ref is dropped"
        );
    }

    // A restart keeps the guide: a new panel reads it from the state folder.
    let fresh = guide_panel(&dir, &work, &base, model.clone()).await;
    let mut table = MethodTable::new();
    register_panel(&mut table, fresh);
    let read = call(&table, "pullRequests.reviewGuide", guide_input())
        .await
        .expect("read after restart");
    assert_eq!(read["guide"], done["guide"]);
    assert_eq!(read["run"], Value::Null);
    task.abort();
}

#[tokio::test]
async fn guides_are_off_until_turned_on_and_a_text_generator_falls_back_to_codex() {
    let dir = TestDir::new();
    let (work, head) = guide_repo(&dir);
    let (base, task) = guide_api(head).await;
    let model = Arc::new(GuideModel {
        id: from_json(json!("codex")).expect("id"),
        answer: Ok(json!({"stops": []})),
        gate: tokio::sync::Semaphore::new(10),
        requests: Mutex::default(),
        saw_checkout: Mutex::default(),
    });
    // A fresh server has no `reviewGuidesEnabled`: T3's default is off.
    let fresh = Arc::new(
        ServerEnvironment::load(
            &dir.0,
            Some("Guides".into()),
            dir.0.clone(),
            Default::default(),
        )
        .expect("environment"),
    );
    assert_eq!(fresh.settings.for_client().get("reviewGuidesEnabled"), None);
    let mut panel = guide_panel(&dir, &work, &base, model.clone()).await;
    // guide_panel turned guides on in the shared settings file; start from none.
    fresh
        .settings
        .update(json!({"reviewGuidesEnabled": false}), None)
        .expect("settings");
    let settings = fresh.clone();
    {
        let p = Arc::get_mut(&mut panel).expect("new panel");
        p.environment = Some(fresh.clone());
        p.text_generators = Some(Arc::new(crate::text_generation::TextGenerators::new(
            move || settings.settings.raw(),
        )));
    }
    let error = panel
        .mcp_call("generateReviewGuide", guide_input())
        .await
        .expect_err("off");
    assert!(
        matches!(error, Failure::Fail(ref v) if v["detail"] == "Review guides are off. Turn them on in Settings → Source control & issues."),
        "{error:?}"
    );
    // The title model is a text generator: it cannot read the checkout, so the ready Codex
    // instance writes the guide.
    fresh
        .settings
        .update(json!({"reviewGuidesEnabled": true,
            "textGenerators": {"router": {"kind": "openaiCompatible", "baseUrl": "http://127.0.0.1:1/v1"}},
            "textGenerationModelSelection": {"instanceId": "router", "model": "m"}}), None)
        .expect("settings");
    panel
        .mcp_call("generateReviewGuide", guide_input())
        .await
        .expect("started");
    for _ in 0..300 {
        if !model.requests.lock().expect("requests").is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    {
        let requests = model.requests.lock().expect("requests");
        let run = panel.guide_runs.get("github.com/a/b#7");
        let request = requests
            .first()
            .unwrap_or_else(|| panic!("the guide ran: {run}"));
        assert_eq!(to_json(&request.model_selection)["instanceId"], "codex");
    }
    task.abort();
}

#[tokio::test]
async fn a_failed_guide_run_reports_its_detail_and_keeps_the_stored_guide() {
    let dir = TestDir::new();
    let (work, head) = guide_repo(&dir);
    let (base, task) = guide_api(head.clone()).await;
    let model = Arc::new(GuideModel {
        id: from_json(json!("codex")).expect("id"),
        answer: Err("Codex CLI request timed out.".into()),
        gate: tokio::sync::Semaphore::new(10),
        requests: Mutex::default(),
        saw_checkout: Mutex::default(),
    });
    let panel = guide_panel(&dir, &work, &base, model).await;
    let mut table = MethodTable::new();
    register_panel(&mut table, panel.clone());
    call(&table, "pullRequests.generateReviewGuide", guide_input())
        .await
        .expect("started");
    let done = settled_guide(&table).await;
    assert_eq!(done["guide"], Value::Null);
    assert_eq!(done["run"]["_tag"], "Failed");
    assert_eq!(done["run"]["headSha"], head.as_str());
    assert_eq!(done["run"]["detail"], "Codex CLI request timed out.");
    assert_eq!(
        git_in(&work, &["worktree", "list", "--porcelain"])
            .matches("worktree ")
            .count(),
        1
    );

    // Another repository's pull request is refused before anything runs.
    let mut other = guide_input();
    other["repository"] = json!("c/d");
    let error = call(&table, "pullRequests.generateReviewGuide", other)
        .await
        .expect_err("another repository");
    assert!(
        matches!(error, Failure::Fail(ref v) if v["detail"].as_str().is_some_and(|d| d.starts_with("Guides are written from this project's checkout"))),
        "{error:?}"
    );
    task.abort();
}

#[tokio::test]
async fn run_action_checks_access_and_the_pinned_head_then_acts() {
    let dir = TestDir::new();
    let (base, task, _) = api().await;
    let panel = panel(shell(&dir.0), &dir, &base);
    let head = "1111111111111111111111111111111111111111";
    let run = |fields: Value| {
        let mut input = reference();
        input
            .as_object_mut()
            .expect("ref")
            .extend(fields.as_object().expect("fields").clone());
        let panel = panel.clone();
        async move {
            panel
                .mcp_call("call", json!({"method": "runAction", "input": input}))
                .await
        }
    };
    let refused = |result: Result<Value, Failure>, detail: &str| {
        assert!(
            matches!(result, Err(Failure::Fail(ref value)) if value["operation"] == "runAction" && value["detail"] == detail),
            "{detail}: {result:?}"
        );
    };
    refused(
        run(json!({"action": "merge", "mergeMethod": "fast"})).await,
        "This host cannot merge with the fast strategy.",
    );
    refused(
        run(json!({"action": "update-branch", "updateMethod": "squash"})).await,
        "This host cannot update a branch by squash.",
    );
    refused(
        run(json!({"action": "merge", "expectedHeadSha": "abc"})).await,
        &format!("The head is now {head}, not abc. Review the new commits first."),
    );
    let before = *panel.refreshes.borrow();
    assert_eq!(
        run(json!({"action": "merge", "expectedHeadSha": head}))
            .await
            .expect("merge"),
        Value::Null
    );
    assert_eq!(
        run(json!({"action": "ready"})).await.expect("ready"),
        Value::Null
    );
    assert_eq!(
        *panel.refreshes.borrow(),
        before + 2,
        "each action refreshes"
    );
    let summary = run(json!({"action": "close", "replyWithSummary": true}))
        .await
        .expect("close");
    assert_eq!(summary["projectId"], "p1", "a summary when asked for one");
    let error = panel
        .mcp_call("checkLogs", {
            let mut input = reference();
            input["check"] = json!("nope");
            input
        })
        .await
        .expect_err("no such check");
    assert!(
        matches!(error, Failure::Fail(ref value) if value["operation"] == "checkLogs" && value["detail"].as_str().is_some_and(|d| d.starts_with("No check is named nope. Checks: "))),
        "{error:?}"
    );
    task.abort();
}
