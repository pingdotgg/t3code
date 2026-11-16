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
        endpoints: Endpoints {
            github_rest: Some(endpoint.into()),
            ..Endpoints::default()
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

async fn api() -> (String, tokio::task::JoinHandle<()>, Arc<AtomicU64>) {
    use axum::{Json, Router, routing::get};

    let calls = Arc::new(AtomicU64::new(0));

    let counter = calls.clone();

    let router=Router::new().route("/user",get(||async{Json(json!({"id":12,"login":"nick"}))})).route("/graphql",axum::routing::post(move |Json(body):Json<Value>|{let counter=counter.clone();
async move {
        counter.fetch_add(1,Ordering::Relaxed);
let query=text(&body,"query");
let mut pr:Value=serde_json::from_str(include_str!("../../../../conn-source-control/src/pull_requests/sample.json")).expect("sample");

        let data=if query.contains("PullRequestStats") && body["variables"].get("_0_owner").is_some() {json!({"_0_repository":{"pullRequest":{"additions":10,"deletions":2}}})}
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
    }}));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");

    let base = format!("http://{}", listener.local_addr().expect("addr"));

    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.expect("stub API");
    });

    (base, task, calls)
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
        "a/b could not be read. Your gh login can't see it. Give it access, or save a token in Settings → Source Control."
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
