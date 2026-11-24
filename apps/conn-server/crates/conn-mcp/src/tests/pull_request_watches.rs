//! `watch_pull_request`, `unwatch_pull_request` and `read_pull_request_guide` on a stand-in pull request panel
//! (`PullRequestWatchService.setWatching`, the toolkit's `locateAll`).

use super::*;

/// The panel's answers: a summary in `state` and the stored guide.
fn host(state: &'static str) -> crate::PullRequestHost {
    Arc::new(move |operation, input: Value| {
        Box::pin(async move {
            match operation {
                "watchSummary" if state == "missing" => Err(json!({
                    "_tag": "PullRequestUnavailableError", "reason": "cli-missing",
                    "provider": "github", "requirement": "No GitHub credential on the server."})),
                "watchSummary" => Ok(json!({"state": state})),
                "locateProject" => Ok(json!({"projectId": project_id()})),
                // `GitManager.createPullRequest`: opened, found open, or not listed yet.
                "createPullRequest" => Ok(match input["title"].as_str() {
                    Some("unlisted") => json!({"status": "created", "baseBranch": "main",
                        "headBranch": "feature", "title": "unlisted"}),
                    Some(title) => {
                        json!({"status": if title == "again" { "opened_existing" } else { "created" },
                        "url": URL, "number": 7, "baseBranch": input["base"].as_str().unwrap_or("main"),
                        "headBranch": "feature", "title": title})
                    }
                    None => json!(null),
                }),
                "reviewGuide" => Ok(json!({"guide": guide(), "run": null,
                    "currentHeadSha": format!("new-{}", input["number"])})),
                "generateReviewGuide" if input["number"] == 9 => Err(json!({
                    "_tag": "PullRequestOperationError", "operation": "generateReviewGuide",
                    "detail": "Review guides are off. Turn them on in Settings → Source control & issues."})),
                "generateReviewGuide" => Ok(json!({"guide": null,
                    "run": {"_tag": "Running", "headSha": "h", "startedAt": "2026-11-19T00:00:00.000Z"},
                    "currentHeadSha": "h", "started": input["number"] == 7})),
                _ => Err(json!({"_tag": "PullRequestOperationError",
                    "operation": operation, "detail": "unexpected"})),
            }
        }) as conn_engine::BoxFuture<'static, Result<Value, Value>>
    })
}

fn guide() -> Value {
    json!({"headSha": "old", "generatedAt": "2026-11-16T00:00:00.000Z",
        "modelSelection": {"instanceId": "codex", "model": "gpt-6.1-sol"},
        "stops": [{"title": "Read the boundary", "summary": "Check the input.",
            "attention": null, "excerpts": [], "files": [], "notes": [], "questions": []}]})
}

fn with_host(base: Fixture, state: &'static str) -> Fixture {
    let config = &base.service.config;
    let service = McpService::new(McpConfig {
        listen_address: "0.0.0.0:4711".parse().unwrap(),
        preview: None,
        devices: None,
        refresh_provider: None,
        worktrees: None,
        panels: None,
        peers: None,
        settings: None,
        pull_requests: Some(host(state)),
        clone_repository: None,
        secrets: None,
        test_logins: None,
        engine: config.engine.clone(),
        environment_id: config.environment_id.clone(),
        label: config.label.clone(),
        server_version: config.server_version.clone(),
        platform: config.platform.clone(),
        providers: config.providers.clone(),
        hosted_app_url: config.hosted_app_url.clone(),
        scheduled_tasks: None,
        files: None,
        annotations: None,
    });
    let dir = base.dir.clone();
    std::mem::forget(base);
    Fixture { service, dir }
}

const URL: &str = "https://github.com/o/r/pull/7";

#[tokio::test(flavor = "current_thread")]
async fn watches_start_link_and_stop_as_t3() {
    let f = with_host(fixture("pr-watch"), "open");
    let mut swamp = Client::open(&f.service, client(true)).await;
    let thread = launch_as_swamp(&mut swamp, "Watch", "hang", "full-access", "default").await;
    let watched = swamp
        .ok(
            "watch_pull_request",
            json!({"threadId": thread, "url": URL}),
        )
        .await;
    assert_eq!(
        watched,
        json!({"host": "github.com", "repository": "o/r", "number": 7, "url": URL,
            "watching": true, "wasWatching": false})
    );
    let listed = swamp
        .ok("list_thread_pull_requests", json!({"threadId": thread}))
        .await;
    assert_eq!(
        listed["pullRequests"][0]["watching"], true,
        "linked and watched"
    );
    assert_eq!(listed["pullRequests"][0]["source"], "agent");
    let again = swamp
        .ok(
            "watch_pull_request",
            json!({"threadId": thread, "url": URL}),
        )
        .await;
    assert_eq!(again["wasWatching"], true);
    let stopped = swamp
        .ok(
            "unwatch_pull_request",
            json!({"threadId": thread, "url": URL}),
        )
        .await;
    assert_eq!(
        (stopped["watching"].clone(), stopped["wasWatching"].clone()),
        (json!(false), json!(true))
    );
    let listed = swamp
        .ok("list_thread_pull_requests", json!({"threadId": thread}))
        .await;
    assert_eq!(
        listed["pullRequests"][0]["watching"], false,
        "it stays linked"
    );
    assert_eq!(
        plain_failure(&mut swamp, "watch_pull_request", json!({"url": URL})).await,
        "Pass threadId: this MCP client is not running inside a Conn thread."
    );

    // A delegated child is not offered the watch tools.
    let entry = f.service.issue_thread_credential(ThreadCredentialRequest {
        thread_id: thread.clone(),
        provider_instance_id: "claudeAgent".into(),
        subagent: true,
        preview: false,
        device: false,
    });
    let token = entry.authorization.strip_prefix("Bearer ").unwrap();
    let child = Caller::Thread(f.service.resolve_thread_token(token).unwrap());
    let mut child = Client::open(&f.service, child).await;
    not_offered(&mut child, "watch_pull_request", json!({"url": URL})).await;
    not_offered(&mut child, "unwatch_pull_request", json!({"url": URL})).await;
    f.service.config.engine.shutdown().await;
}

#[tokio::test(flavor = "current_thread")]
async fn merged_and_unreadable_pull_requests_are_refused() {
    let merged = with_host(fixture("pr-watch-merged"), "merged");
    let mut swamp = Client::open(&merged.service, client(true)).await;
    let thread = launch_as_swamp(&mut swamp, "Merged", "hang", "full-access", "default").await;
    assert_eq!(
        plain_failure(
            &mut swamp,
            "watch_pull_request",
            json!({"threadId": thread, "url": URL})
        )
        .await,
        "The pull request is merged, so there is nothing to watch."
    );
    merged.service.config.engine.shutdown().await;

    let missing = with_host(fixture("pr-watch-missing"), "missing");
    let mut swamp = Client::open(&missing.service, client(true)).await;
    let thread = launch_as_swamp(&mut swamp, "Missing", "hang", "full-access", "default").await;
    assert_eq!(
        plain_failure(
            &mut swamp,
            "watch_pull_request",
            json!({"threadId": thread, "url": URL})
        )
        .await,
        "No GitHub credential on the server."
    );
    missing.service.config.engine.shutdown().await;
}

#[tokio::test(flavor = "current_thread")]
async fn guides_read_the_store_and_writes_start_or_join_runs() {
    let f = with_host(fixture("pr-guides"), "open");
    let mut swamp = Client::open(&f.service, client(true)).await;
    let read = swamp
        .ok("read_pull_request_guide", json!({"url": URL}))
        .await;
    assert_eq!(read["guide"], guide());
    assert_eq!(read["currentHeadSha"], "new-7");
    assert_eq!(read["stale"], true);
    assert_eq!(read["run"], Value::Null);
    assert_eq!(
        plain_failure(
            &mut swamp,
            "read_pull_request_guide",
            json!({"url": "https://example.com/x"})
        )
        .await,
        "This is not a recognised pull request URL. Pass repository and number instead."
    );
    // Each target gets its own outcome; one that fails does not stop the others.
    let written = swamp
        .ok(
            "write_pull_request_guides",
            json!({"pullRequests": [
                {"url": URL},
                {"repository": "o/r", "number": 8, "host": "github.com"},
                {"url": "https://github.com/o/r/pull/9"},
                {"url": "https://example.com/x"},
            ]}),
        )
        .await;
    assert_eq!(
        written["guides"],
        json!([
            {"host": "github.com", "repository": "o/r", "number": 7, "url": URL, "outcome": "started", "detail": null},
            {"host": "github.com", "repository": "o/r", "number": 8, "url": "https://github.com/o/r/pull/8", "outcome": "running", "detail": null},
            {"host": "github.com", "repository": "o/r", "number": 9, "url": "https://github.com/o/r/pull/9", "outcome": "failed",
             "detail": "Review guides are off. Turn them on in Settings → Source control & issues."},
            {"host": "", "repository": "", "number": 0, "url": "https://example.com/x", "outcome": "failed",
             "detail": "This is not a recognised pull request URL. Pass repository and number instead."},
        ])
    );
    f.service.config.engine.shutdown().await;
}

#[tokio::test(flavor = "current_thread")]
async fn create_links_the_opened_pull_request_as_t3() {
    let f = with_host(fixture("pr-create"), "open");
    let mut swamp = Client::open(&f.service, client(true)).await;
    let thread = launch_as_swamp(&mut swamp, "Create", "hang", "full-access", "default").await;
    let mut agent = Client::open(&f.service, agent_of(&f, &thread)).await;
    let created = agent
        .ok(
            "pull_request_create",
            json!({"title": "Feature", "body": "Body", "base": "develop", "draft": true}),
        )
        .await;
    assert_eq!(
        created,
        json!({"host": "github.com", "repository": "o/r", "number": 7, "url": URL, "created": true})
    );
    let listed = swamp
        .ok("list_thread_pull_requests", json!({"threadId": thread}))
        .await;
    assert_eq!(listed["pullRequests"].as_array().map(Vec::len), Some(1));
    assert_eq!(listed["pullRequests"][0]["source"], "created");
    // The open PR comes back as it is; the link is not repeated.
    let again = agent
        .ok("pull_request_create", json!({"title": "again", "body": ""}))
        .await;
    assert_eq!(again["created"], false);
    let listed = swamp
        .ok("list_thread_pull_requests", json!({"threadId": thread}))
        .await;
    assert_eq!(listed["pullRequests"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        plain_failure(
            &mut agent,
            "pull_request_create",
            json!({"title": "unlisted", "body": ""})
        )
        .await,
        "The host accepted the PR but does not list it yet. Find it with pull_request_list."
    );
}

/// The search sources `conn_thread_search` returns for `thread` on `query`.
async fn search_sources(swamp: &mut Client<'_>, thread: &str, query: &str) -> Vec<Value> {
    let found = swamp
        .ok(
            "conn_thread_search",
            json!({"projectId": project_id(), "query": query}),
        )
        .await;
    found["matches"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|hit| hit["threadId"] == thread)
        .map(|hit| hit["source"].clone())
        .collect()
}

/// T3's `searchThreads` reads a thread's linked pull requests (`threadSearchPullRequests`).
#[tokio::test(flavor = "current_thread")]
async fn search_finds_a_thread_by_its_linked_pull_request() {
    let f = with_host(fixture("pr-search"), "open");
    let mut swamp = Client::open(&f.service, client(true)).await;
    let thread = launch_as_swamp(
        &mut swamp,
        "Spring maintenance",
        "hang",
        "full-access",
        "default",
    )
    .await;
    let url = "https://github.com/example/fixture/pull/7483";
    swamp
        .ok("link_pull_request", json!({"threadId": thread, "url": url}))
        .await;
    let listed = swamp
        .ok("list_thread_pull_requests", json!({"threadId": thread}))
        .await;
    assert_eq!(listed["pullRequests"][0]["number"], 7483);
    dispatch(
        &f,
        json!({"type": "thread.pull-request-link.sync", "commandId": "pr-search-sync",
            "threadId": thread, "host": "github.com", "repository": "example/fixture",
            "number": 7483, "stack": null,
            "snapshot": {"state": "open", "title": "Résumé indexing", "headBranch": "resume",
                "baseBranch": "main", "isDraft": false, "updatedAt": "2026-11-19T08:00:00Z",
                "syncedAt": "2026-11-19T09:00:00.000Z", "closedAt": null, "mergedAt": null,
                "checksState": null, "reviewDecision": null}}),
    )
    .await;

    // `foldSearchQuery`: quotes around a pasted query go, case and accents fold. A PR title
    // matches token by token at word starts (`matchToken`).
    for query in [
        "Spring maintenance",
        "#7483",
        "PR 7483",
        "example/fixture#7483",
        "\"example/fixture#7483\"",
        url,
        "https://github.com/example/fixture/pull/7483/files",
        "resume",
        "Résumé",
        "indexing resume",
        "\u{201c}résumé index\u{201d}",
        // `scoreThreadSearch`: each word in some field, and the PR explains the words left
        // after the project's name.
        "project #7483",
        "Project resume",
        "project indexing resume",
        "spring #7483",
        "#7483 maintenance",
    ] {
        assert_eq!(
            search_sources(&mut swamp, &thread, query).await,
            [json!("title")],
            "{query}"
        );
    }
    for query in [
        "#7484",
        "example/fixture#74830",
        "fixture/pull/74",
        "sume",
        "resume draft",
        "project #7484",
        "project draft",
    ] {
        assert_eq!(
            search_sources(&mut swamp, &thread, query).await,
            Vec::<Value>::new(),
            "{query}"
        );
    }

    swamp
        .ok(
            "unlink_pull_request",
            json!({"threadId": thread, "url": url}),
        )
        .await;
    for query in ["#7483", "example/fixture#7483", url] {
        assert_eq!(
            search_sources(&mut swamp, &thread, query).await,
            Vec::<Value>::new(),
            "{query} after unlink"
        );
    }
    f.service.config.engine.shutdown().await;
}

/// `searchThreads` ranks before its limit (`rankSearchItems`): a thread titled as the query
/// stays ahead of a newer one that only links a PR of that title.
#[tokio::test(flavor = "current_thread")]
async fn search_ranks_an_exact_title_above_a_newer_pull_request_title() {
    let f = with_host(fixture("pr-search-rank"), "open");
    let mut swamp = Client::open(&f.service, client(true)).await;
    let titled = launch_as_swamp(
        &mut swamp,
        "Session cleanup",
        "hang",
        "full-access",
        "default",
    )
    .await;
    let linked = launch_as_swamp(
        &mut swamp,
        "Spring maintenance",
        "hang",
        "full-access",
        "default",
    )
    .await;
    let url = "https://github.com/example/fixture/pull/7483";
    swamp
        .ok("link_pull_request", json!({"threadId": linked, "url": url}))
        .await;
    dispatch(
        &f,
        json!({"type": "thread.pull-request-link.sync", "commandId": "pr-search-rank-sync",
            "threadId": linked, "host": "github.com", "repository": "example/fixture",
            "number": 7483, "stack": null,
            "snapshot": {"state": "open", "title": "Session cleanup", "headBranch": "cleanup",
                "baseBranch": "main", "isDraft": false, "updatedAt": "2026-11-19T08:00:00Z",
                "syncedAt": "2026-11-19T09:00:00.000Z", "closedAt": null, "mergedAt": null,
                "checksState": null, "reviewDecision": null}}),
    )
    .await;
    let both = swamp
        .ok(
            "conn_thread_search",
            json!({"projectId": project_id(), "query": "Session cleanup"}),
        )
        .await;
    let ids: Vec<&Value> = both["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|hit| &hit["threadId"])
        .collect();
    assert_eq!(ids, [&json!(titled), &json!(linked)]);
    let one = swamp
        .ok(
            "conn_thread_search",
            json!({"projectId": project_id(), "query": "Session cleanup", "limit": 1}),
        )
        .await;
    assert_eq!(one["matches"][0]["threadId"], titled);
    assert_eq!(one["matches"].as_array().map(Vec::len), Some(1));
    f.service.config.engine.shutdown().await;
}
