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
                "reviewGuide" => Ok(json!({"guide": guide(), "run": null,
                    "currentHeadSha": format!("new-{}", input["number"])})),
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
        preview: None,
        refresh_provider: None,
        worktrees: None,
        panels: None,
        pull_requests: Some(host(state)),
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
    service.set_listen_address("0.0.0.0:4711".parse().unwrap());
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
        "Pass threadId: this MCP client is not running inside a T3 thread."
    );

    // A delegated child is not offered the watch tools.
    let entry = f.service.issue_thread_credential(ThreadCredentialRequest {
        thread_id: thread.clone(),
        provider_instance_id: "claudeAgent".into(),
        subagent: true,
        preview: false,
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
async fn guides_read_the_store_and_the_write_is_not_offered() {
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
    // No review guide generator here, so the write tool is not offered (capability rule).
    not_offered(
        &mut swamp,
        "write_pull_request_guides",
        json!({"pullRequests": [{"url": URL}]}),
    )
    .await;
    f.service.config.engine.shutdown().await;
}
