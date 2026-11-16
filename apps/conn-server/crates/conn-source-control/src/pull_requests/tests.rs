use super::*;

use crate::{
    discovery::stub::StubDir,
    hosts::{Endpoints, Environment},
    settings::Settings,
};

use serde_json::json;

// Characterizations of GitHubPullRequestProvider and gitHubPullRequestJson's boundary.
#[test]
fn summaries_keep_verdicts_hidden_reviews_and_stack_absence() {
    let mut raw = sample_pr();

    raw["reviewDecision"] = Value::Null;

    raw["latestReviews"] = json!({"nodes":[
        {"state":"CHANGES_REQUESTED","isMinimized":true},
        {"state":"APPROVED","isMinimized":false}
    ]});

    let summary = normalize::summary(&raw, "github.com");

    assert_eq!(summary["reviewDecision"], "approved");

    assert_eq!(summary["checksState"], "passing");

    assert!(summary.get("stack").is_none());

    raw["stack"] = Value::Null;

    assert_eq!(normalize::summary(&raw, "github.com")["stack"], Value::Null);

    raw["mergedAt"] = json!("2026-11-16T00:00:00Z");

    assert_eq!(normalize::summary(&raw, "github.com")["state"], "merged");
}

#[test]
fn checks_keep_running_reruns_and_separate_workflows() {
    let entries = json!([
        {"__typename":"CheckRun","name":"test","status":"COMPLETED","conclusion":"FAILURE","completedAt":"2026-11-15T01:00:00Z","workflowName":"CI"},
        {"__typename":"CheckRun","name":"test","status":"IN_PROGRESS","workflowName":"CI"},
        {"__typename":"CheckRun","name":"test","status":"COMPLETED","conclusion":"SUCCESS","completedAt":"2026-11-16T01:00:00Z","workflowName":"CI"},
        {"__typename":"CheckRun","name":"test","status":"COMPLETED","conclusion":"CANCELLED","workflowName":"Build"},
        {"__typename":"StatusContext","context":"external","state":"EXPECTED","isRequired":true}
    ]);

    let checks = normalize::checks(entries.as_array().unwrap());

    assert_eq!(checks[0]["name"], "Build / test");

    assert_eq!(checks[1]["name"], "CI / test");

    assert_eq!(checks[1]["status"], "pending");

    assert_eq!(checks[2]["required"], true);
}

#[tokio::test]
async fn unsigned_cli_returns_t3_unavailable_without_api_or_token_output() {
    let stubs = StubDir::new("pr-auth");

    stubs.executable(
        "gh",
        &["GH_DEBUG", "GH_PROMPT_DISABLED"],
        "echo 'not logged in' >&2; exit 1",
    );

    let child_env = stubs.path_env();

    let settings = Settings::default();

    let env = Environment::fixed([]);

    let endpoints = Endpoints::default();

    let context = DiscoveryContext {
        cwd: &stubs.dir,
        home: Some(&stubs.dir),
        settings: &settings,
        env: &env,
        endpoints: &endpoints,
        child_env: &child_env,
    };

    let error = Client::connect(context, "github.com").await.unwrap_err();

    assert_eq!(
        error.to_contract("summary"),
        json!({"_tag":"PullRequestUnavailableError","reason":"cli-unauthenticated","provider":"github","requirement":UNAUTHENTICATED})
    );

    let log = stubs.log("gh");

    assert!(log.contains("auth token --hostname github.com"));

    assert!(log.contains("GH_DEBUG=\n"));

    assert!(log.contains("GH_PROMPT_DISABLED=1"));

    assert!(!log.contains("api"));
}

#[test]
fn selectors_and_diff_file_membership_do_not_accept_arbitrary_reads() {
    for repository in ["a/b/c", "a/../b", "--repo", "a/b?x", "a/b;echo"] {
        assert!(Lookup::new(repository, 1).is_err(), "{repository}");
    }
    assert!(Lookup::new("a/b", 2_147_483_648).is_err());

    assert!(Lookup::new("a/b", 0).is_err());

    assert!(Lookup::new("a/b", 1).is_ok());

    let files = json!([{"filename":"new name","previous_filename":"old name","status":"renamed"}]);

    assert!(diff::contains_file(
        files.as_array().unwrap(),
        "old name",
        "new name"
    ));

    assert!(!diff::contains_file(
        files.as_array().unwrap(),
        "secret",
        "new name"
    ));
}

pub(super) fn sample_pr() -> Value {
    serde_json::from_str(include_str!("sample.json")).expect("sample PR")
}

#[test]
fn t3_characterizations_match_the_current_upstream_functions() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("cases.json")).expect("T3 cases");

    for case in cases {
        let input = &case["input"];

        let actual = match case["kind"].as_str().expect("kind") {
            "provider-failure" | "access-hint" => continue,
            "github-host" => json!(github::is_github_host(input.as_str().expect("host"))),
            "summary" => normalize::summary(input, "github.com"),
            "checks" => json!(normalize::checks(input.as_array().expect("contexts"))),
            "breakdown" => normalize::breakdown(input),
            "patch" => diff::files_patch(input.as_array().expect("files")),
            "unavailable" => if input == "cli-missing" {
                Error::Missing
            } else {
                Error::Unauthenticated
            }
            .to_contract("summary"),
            kind => panic!("Unknown characterization {kind}"),
        };

        assert_eq!(actual, case["expected"], "{}: {}", case["kind"], input);
    }
}

async fn connect(stubs: &StubDir, base: &str) -> Client {
    let child_env = stubs.path_env();

    let settings = Settings::default();

    let env = Environment::fixed([]);

    let endpoints = Endpoints {
        github_rest: Some(base.into()),
    };

    Client::connect(
        DiscoveryContext {
            cwd: &stubs.dir,
            home: Some(&stubs.dir),
            settings: &settings,
            env: &env,
            endpoints: &endpoints,
            child_env: &child_env,
        },
        "github.com",
    )
    .await
    .expect("stub credential")
}

#[tokio::test]
async fn generated_read_documents_and_identity_use_the_official_cli_credential() {
    use crate::http::fake;

    let server = fake::serve(|request| {
        if request.path == "/user" {
            return (200, json!({"id":12,"login":"nick"}).to_string());
        }
        let body: Value = serde_json::from_str(&request.body).expect("request JSON");

        assert_eq!(body["variables"]["owner"], "a", "owner");

        assert_eq!(body["variables"]["name"], "b", "name");

        assert_eq!(body["variables"]["number"], 7, "number");

        (
            200,
            json!({"data":{"repository":{"pullRequest":sample_pr()}}}).to_string(),
        )
    })
    .await;

    let stubs = StubDir::new("pr-read");

    stubs.executable("gh", &[], "printf '%s\\n' 'fake-pr-token'");

    let client = connect(&stubs, &server.base).await;

    let lookup = Lookup::new("a/b", 7).expect("lookup");

    assert_eq!(
        client.identity().await.expect("identity"),
        json!({"accountId":"12","viewer":"nick"}),
        "account's stable id"
    );

    assert_eq!(
        client.summary(&lookup).await.expect("summary")["title"],
        "A change",
        "summary"
    );

    assert_eq!(
        client.preview(&lookup).await.expect("preview")["createdAt"],
        "2026-11-15T00:00:00Z",
        "preview"
    );

    assert_eq!(
        client.stats(&lookup).await.expect("stats")["additions"],
        10,
        "stats"
    );

    let requests = server.requests.lock().expect("requests");

    for request in requests.iter() {
        assert_eq!(
            request
                .headers
                .iter()
                .find(|(n, _)| n == "authorization")
                .map(|(_, v)| v.as_str()),
            Some("Bearer fake-pr-token"),
            "private header"
        );

        assert_eq!(
            request
                .headers
                .iter()
                .find(|(n, _)| n == "user-agent")
                .map(|(_, v)| v.as_str()),
            Some("t3code"),
            "user agent"
        );
    }
    let documents: Vec<_> = requests
        .iter()
        .filter(|r| r.path == "/graphql")
        .map(|r| serde_json::from_str::<Value>(&r.body).expect("JSON")["query"].clone())
        .collect();

    assert_eq!(
        documents,
        json!([
            generated::PULL_REQUEST_SUMMARY.document,
            generated::PULL_REQUEST_PREVIEW.document,
            generated::PULL_REQUEST_STATS.document
        ])
        .as_array()
        .expect("documents")
        .to_vec(),
        "T3 documents, not copied queries"
    );

    assert!(
        stubs.log("gh").contains("auth token --hostname github.com"),
        "official auth token call"
    );
}

#[tokio::test]
async fn viewed_files_preserve_whitespace_page_at_five_and_toggles_stay_in_order() {
    use crate::http::fake;

    let server=fake::serve(|request| {
        let body:Value=serde_json::from_str(&request.body).expect("JSON");
let query=body["query"].as_str().expect("query");

        let data=if query.contains("query PullRequestFilesViewed") {
            let after=body["variables"]["after"].as_str().unwrap_or("0").parse::<u32>().expect("cursor");

            json!({"repository":{"pullRequest":{"files":{"nodes":[{"path":" space ","viewerViewedState":if after==0{"VIEWED"}else{"DISMISSED"}},{"path":"","viewerViewedState":"UNVIEWED"}],"pageInfo":{"hasNextPage":true,"endCursor":(after+1).to_string()}}}}})
        } else if query.contains("query PullRequestNodeId") {json!({"repository":{"pullRequest":{"id":"PR7"}}})}
        else {json!({"markFileAsViewed":{"clientMutationId":null}})};

        (200,json!({"data":data}).to_string())
    }).await;

    let stubs = StubDir::new("pr-viewed");

    stubs.executable("gh", &[], "echo fake");

    let client = connect(&stubs, &server.base).await;

    let lookup = Lookup::new("a/b", 7).expect("lookup");

    let viewed = client.files_viewed(&lookup).await.expect("viewed");

    assert_eq!(
        viewed["files"].as_array().expect("files").len(),
        5,
        "bounded walk"
    );

    assert_eq!(
        viewed["files"][0]["path"], " space ",
        "host path whitespace"
    );

    assert_eq!(viewed["truncated"], true, "more files exist");

    client
        .set_files_viewed(
            &lookup,
            &[
                json!({"path":" space ","viewed":true}),
                json!({"path":" space ","viewed":false}),
            ],
        )
        .await
        .expect("toggles");

    let requests = server.requests.lock().expect("requests");

    let mutations: Vec<Value> = requests
        .iter()
        .map(|r| serde_json::from_str::<Value>(&r.body).expect("JSON"))
        .filter(|v| {
            v["query"]
                .as_str()
                .is_some_and(|q| q.starts_with("mutation"))
        })
        .collect();

    assert_eq!(
        mutations
            .iter()
            .map(|m| m["variables"].clone())
            .collect::<Vec<_>>(),
        vec![
            json!({"pullRequestId":"PR7","path":" space ","viewed":true}),
            json!({"pullRequestId":"PR7","path":" space ","viewed":false})
        ],
        "last press wins"
    );
}

#[tokio::test]
async fn review_thread_paging_rejects_another_pull_requests_thread() {
    use crate::http::fake;

    let server=fake::serve(|_|(200,json!({"data":{"viewer":{"login":"nick"},"repository":{"pullRequest":{"id":"PR7"}},"node":{"__typename":"PullRequestReviewThread","pullRequest":{"id":"PR8"},"comments":{"nodes":[],"pageInfo":{"hasNextPage":false}}}}}).to_string())).await;

    let stubs = StubDir::new("pr-thread");

    stubs.executable("gh", &[], "echo fake");

    let client = connect(&stubs, &server.base).await;

    assert_eq!(
        client
            .thread_comments(&Lookup::new("a/b", 7).expect("lookup"), "thread8", None)
            .await
            .expect_err("foreign subject"),
        Error::Failed("The named subject did not belong to the named pull request.".into()),
        "scope guard"
    );
}

#[tokio::test]
async fn diff_expansion_checks_membership_and_reads_the_merge_base_not_the_base_tip() {
    use crate::http::fake;

    let server = fake::serve(|r| {
        let value = if r.path.contains("/files?") {
            json!([{"filename":"new name.rs","previous_filename":"old name.rs","status":"renamed"}])
                .to_string()
        } else if r.path.contains("/compare/") {
            json!({"merge_base_commit":{"sha":"3333333"}}).to_string()
        } else if r.path.contains("/contents/") {
            if r.path.contains("ref=3333333") {
                "before\n".into()
            } else {
                "after\n".into()
            }
        } else {
            json!({"base":{"sha":"1111111"},"head":{"sha":"2222222"}}).to_string()
        };

        (200, value)
    })
    .await;

    let stubs = StubDir::new("pr-diff");

    stubs.executable("gh", &[], "echo fake");

    let client = connect(&stubs, &server.base).await;

    let lookup = Lookup::new("a/b", 7).expect("lookup");

    assert_eq!(client.diff_file_contents(&lookup,&json!({"oldPath":"old name.rs","newPath":"new name.rs","changeType":"rename-changed"})).await.expect("expanded"),json!({"oldContents":"before\n","newContents":"after\n"}),"uses merge base");

    let previous = server.requests.lock().expect("requests").len();

    let error = client
        .diff_file_contents(
            &lookup,
            &json!({"oldPath":".env","newPath":".env","changeType":"change"}),
        )
        .await
        .expect_err("not changed");

    assert!(matches!(error, Error::NotFound(_)), "typed not-found");

    assert_eq!(
        server.requests.lock().expect("requests").len(),
        previous + 1,
        "no contents request for an arbitrary path"
    );

    assert!(
        server
            .requests
            .lock()
            .expect("requests")
            .iter()
            .any(|r| r.path.contains("old%20name.rs?ref=3333333")),
        "encoded file name"
    );
}

#[tokio::test]
async fn missing_pull_refs_and_forbidden_team_reviewers_do_not_hide_core_detail() {
    use crate::http::fake;

    let server=fake::serve(|r| {
        let body:Value=serde_json::from_str(&r.body).expect("JSON");
let requested=body["variables"]["requestedReviewers"].as_u64().unwrap_or(0);

        let mut data=json!({"repository":{"pullRequest":sample_pr(),"viewerPermission":"READ"}});
data["repository"]["pullRequest"]["baseRef"]=Value::Null;

        let errors=if requested>0{json!([{"type":"FORBIDDEN","path":["repository","pullRequest","reviewRequests","nodes",0,"requestedReviewer"]},{"type":"NOT_FOUND","path":["repository","pullRequest","baseRef","compare"]}])}else{json!([{"type":"NOT_FOUND","path":["repository","pullRequest","baseRef","compare"]}])};

        (200,json!({"data":data,"errors":errors}).to_string())
    }).await;

    let stubs = StubDir::new("pr-teams");

    stubs.executable("gh", &[], "echo fake");

    let client = connect(&stubs, &server.base).await;

    let detail = client
        .detail(&Lookup::new("a/b", 7).expect("lookup"))
        .await
        .expect("detail survives field failures");

    assert_eq!(
        detail["baseComparison"], "unknown",
        "missing pull ref does not remove the PR"
    );

    let requests = server.requests.lock().expect("requests");

    let reviewer_counts: Vec<_> = requests
        .iter()
        .filter_map(|r| serde_json::from_str::<Value>(&r.body).ok())
        .filter_map(|v| v["variables"]["requestedReviewers"].as_u64())
        .collect();

    assert_eq!(
        reviewer_counts,
        vec![100, 0],
        "retry without unreadable reviewer rows"
    );
}

#[tokio::test]
async fn statistics_are_aliased_in_bounded_batches_and_missing_slices_stay_missing() {
    use crate::http::fake;

    let server = fake::serve(|r| {
        let body: Value = serde_json::from_str(&r.body).expect("JSON");

        let count = body["variables"].as_object().expect("variables").len() / 3;

        assert!(count <= 100, "bounded batch");

        assert_eq!(
            body["query"].as_str(),
            Some(
                generated::PULL_REQUEST_STATS
                    .render_slices(count)
                    .expect("rendered")
                    .as_str()
            ),
            "Effect batch document"
        );

        let mut data = serde_json::Map::new();

        for index in 0..count {
            let number = body["variables"][format!("_{index}_number")]
                .as_u64()
                .expect("number");

            if number != 2 {
                data.insert(
                    format!("_{index}_repository"),
                    json!({"pullRequest":{"additions":number,"deletions":0}}),
                );
            }
        }
        (200, json!({"data":data}).to_string())
    })
    .await;

    let stubs = StubDir::new("pr-stats");

    stubs.executable("gh", &[], "echo fake");

    let client = connect(&stubs, &server.base).await;

    let refs: Vec<_> = (1..=105)
        .map(|number| Lookup::new("a/b", number).expect("lookup"))
        .collect();

    let stats = client.stats_batch(&refs).await.expect("stats");

    assert_eq!(stats.len(), 104, "missing slice not reported as zero");

    assert_eq!(
        stats.last().expect("last").1["additions"],
        105,
        "all batches read"
    );

    assert_eq!(
        server.requests.lock().expect("requests").len(),
        2,
        "100 rows then five rows"
    );
}

#[tokio::test]
async fn listing_cursors_exclude_delivered_ties_and_query_text_cannot_add_qualifiers() {
    use crate::http::fake;

    let server=fake::serve(|r|{
        let body:Value=serde_json::from_str(&r.body).expect("JSON");

        let q=body["variables"]["q"].as_str().expect("query");
assert!(q.contains("repo:a/b"),"fixed repository qualifier");
assert!(q.contains(r#""is:closed\" OR""#),"user text is a phrase");

        let mut first=sample_pr();
first["number"]=json!(1);
let mut second=sample_pr();
second["number"]=json!(2);

        (200,json!({"data":{"search":{"nodes":[null,{"number":3},first,second],"pageInfo":{"hasNextPage":false}}}}).to_string())
    }).await;

    let stubs = StubDir::new("pr-list");

    stubs.executable("gh", &[], "echo fake");

    let client = connect(&stubs, &server.base).await;

    let input = json!({"state":"open","limit":1,"query":"is:closed\" OR"});

    let first = client
        .list("a/b", &input, "nick", None)
        .await
        .expect("first page");

    assert_eq!(
        first["items"][0]["number"], 1,
        "malformed rows do not hide a valid one"
    );

    let cursor = listing::Cursor::parse(first["nextCursor"].as_str().expect("cursor"))
        .expect("valid cursor");

    let second = client
        .list("a/b", &input, "nick", Some(&cursor))
        .await
        .expect("continued");

    assert_eq!(
        second["items"][0]["number"], 2,
        "no duplicate on equal timestamp"
    );

    assert_eq!(second["nextCursor"], Value::Null, "finished");

    for raw in [
        "bad|0|1",
        "2026-11-16T00:00:00Z more|0|1",
        "2026-11-16T00:00:00Z|-1|1",
        "2026-11-16T00:00:00Z|0|x",
    ] {
        assert!(listing::Cursor::parse(raw).is_err(), "invalid cursor {raw}");
    }
}

#[tokio::test]
async fn activity_keeps_verdicts_reactions_and_thread_paging_but_omits_hidden_comments() {
    use crate::http::fake;

    let server=fake::serve(|r|{
        let body:Value=serde_json::from_str(&r.body).expect("JSON");
let query=body["query"].as_str().expect("query");

        let data=if query.contains("query PullRequestActivity") {json!({"repository":{"pullRequest":{"author":{"login":"nick"},"commits":{"nodes":[]},"comments":{"nodes":[{"id":"hidden","body":"hidden","isMinimized":true,"createdAt":"2026-11-15T00:00:00Z"},{"id":"c1","author":{"login":"nick"},"body":"hello","createdAt":"2026-11-15T00:00:00Z"}],"pageInfo":{"hasNextPage":false}},"reviews":{"nodes":[{"id":"review","body":"","state":"APPROVED","submittedAt":"2026-11-16T00:00:00Z"},{"id":"empty","body":"","state":"COMMENTED","submittedAt":"2026-11-16T00:00:00Z"}],"pageInfo":{"hasNextPage":false}}}}})}
        else {
            json!({"viewer":{"login":"nick"},"repository":{"pullRequest":{
                "reviewRequests":{"nodes":[]},"latestReviews":{"nodes":[]},"comments":{"nodes":[]},"reviews":{"nodes":[]},"commits":{"nodes":[]},"reviewDismissals":{"nodes":[],"pageInfo":{"hasNextPage":false}},
                "reactionGroups":[{"content":"THUMBS_UP","viewerHasReacted":true,"reactors":{"totalCount":2,"nodes":[{"login":"nick"},{"login":"other"}]}}],
                "reviewThreads":{"nodes":[{"id":"thread","path":"file.rs","line":null,"diffSide":"LEFT","isResolved":false,"isOutdated":true,"comments":{"totalCount":3,"nodes":[{"id":"line1","author":{"login":"other"},"body":"look","createdAt":"2026-11-15T12:00:00Z","lastEditedAt":null,"url":null},{"id":"hidden-line","body":"hidden","isMinimized":true}],"pageInfo":{"hasNextPage":true,"endCursor":"comments-after"}}}],"pageInfo":{"hasNextPage":false}}}}})
        };
(200,json!({"data":data}).to_string())
    }).await;

    let stubs = StubDir::new("pr-activity");

    stubs.executable("gh", &[], "echo fake");

    let client = connect(&stubs, &server.base).await;

    let activity = client
        .activity(&Lookup::new("a/b", 7).expect("lookup"))
        .await
        .expect("activity");

    assert_eq!(
        activity["comments"]
            .as_array()
            .expect("comments")
            .iter()
            .map(|c| c["id"].as_str().expect("id"))
            .collect::<Vec<_>>(),
        vec!["c1", "line1", "review"],
        "sorted visible remarks plus bodiless verdict"
    );

    assert_eq!(
        activity["reactions"][0]["actors"],
        json!(["other"]),
        "viewer is counted but not named twice"
    );

    assert_eq!(
        activity["reactions"][0]["count"], 2,
        "viewer remains in the count"
    );

    assert_eq!(
        activity["commentCount"], 4,
        "unloaded comments contribute to the count"
    );

    assert_eq!(activity["commentsTruncated"], true, "more comments exist");

    assert_eq!(
        activity["reviewThreadsTruncated"], false,
        "all thread headers are present"
    );

    assert_eq!(
        activity["reviewThreads"][0]["nextCommentsCursor"], "comments-after",
        "thread can continue"
    );

    assert_eq!(
        activity["reviewThreads"][0]["side"], "left",
        "outdated left anchor"
    );
}

#[tokio::test]
async fn raw_diff_and_paged_commit_diffs_follow_the_http_contract() {
    use crate::http::fake;

    let server=fake::serve(|r|{if r.path=="/repos/a/b/pulls/7"{(200,"diff --git a/file.rs b/file.rs\n--- a/file.rs\n+++ b/file.rs\n@@ -1 +1 @@\n-a\n+b\n".into())}else{(200,json!({"files":[{"filename":"file.rs","status":"modified","patch":"@@ -1 +1 @@\n-a\n+b","additions":1,"deletions":1}]}).to_string())}}).await;

    let stubs = StubDir::new("pr-patch");

    stubs.executable("gh", &[], "echo fake");

    let client = connect(&stubs, &server.base).await;

    let lookup = Lookup::new("a/b", 7).expect("lookup");

    let full = client.diff(&lookup, &json!({})).await.expect("full diff");

    assert_eq!(full["truncated"], false, "raw diff");

    assert!(
        full["patch"].as_str().expect("patch").contains("-a\n+b"),
        "patch body"
    );

    let paged = client
        .diff(&lookup, &json!({"commit":"1111111"}))
        .await
        .expect("commit diff");

    assert_eq!(
        paged["patch"], full["patch"],
        "same patch through the files API"
    );

    assert!(
        client.diff(&lookup, &json!({"cursor":"0"})).await.is_err(),
        "invalid cursor is refused"
    );

    let requests = server.requests.lock().expect("requests");

    assert_eq!(requests.len(), 2, "invalid cursor asks nothing");

    assert!(
        requests[0]
            .headers
            .iter()
            .any(|(k, v)| k == "accept" && v == "application/vnd.github.diff"),
        "raw media type"
    );
}

#[tokio::test]
async fn listings_filter_before_the_limit_and_keep_duplicate_only_cursors() {
    use crate::http::fake;
    let server = fake::serve(|_| {
        let mut draft = sample_pr();
        draft["number"] = json!(1);
        draft["isDraft"] = json!(true);
        let mut ready = draft.clone();
        ready["number"] = json!(2);
        ready["isDraft"] = json!(false);
        (
            200,
            json!({"data":{"search":{"nodes":[draft,ready],"pageInfo":{"hasNextPage":false}}}})
                .to_string(),
        )
    })
    .await;
    let stubs = StubDir::new("pr-filter-limit");
    stubs.executable("gh", &[], "echo fake");
    let client = connect(&stubs, &server.base).await;
    let page = client
        .list(
            "a/b",
            &json!({"state":"open","limit":1,"filters":{"draft":"exclude"}}),
            "nick",
            None,
        )
        .await
        .expect("filtered");
    assert_eq!(
        page["items"][0]["number"], 2,
        "a rejected row cannot use the limit"
    );

    let server = fake::serve(|_| {
        let mut pr = sample_pr();
        pr["number"] = json!(1);
        pr["updatedAt"] = json!("2026-11-16T00:00:00Z");
        (200, json!({"data":{"search":{"nodes":[pr],"pageInfo":{"hasNextPage":true,"endCursor":"more"}}}}).to_string())
    }).await;
    let client = connect(&stubs, &server.base).await;
    let cursor = listing::Cursor::parse("2026-11-16T00:00:00Z|1|1").expect("cursor");
    let page = client
        .list(
            "a/b",
            &json!({"state":"open","limit":1}),
            "nick",
            Some(&cursor),
        )
        .await
        .expect("duplicates");
    assert_eq!(page["items"], json!([]));
    assert_eq!(
        page["nextCursor"], "2026-11-16T00:00:00Z|1|1",
        "consumed rows keep continuation even when none are delivered"
    );
}

#[tokio::test]
async fn forbidden_reads_preserve_the_provider_classification_without_an_invalid_outer_reason() {
    use crate::http::fake;
    let cases: Vec<Value> = serde_json::from_str(include_str!("cases.json")).expect("T3 cases");
    for case in cases.iter().filter(|c| c["kind"] == "provider-failure") {
        let status = case["input"]["status"].as_u64().expect("status") as u16;
        let errors: Vec<_> = case["input"]["githubErrorTypes"]
            .as_array()
            .expect("error types")
            .iter()
            .map(|kind| json!({"type":kind}))
            .collect();
        let server = fake::serve(move |_| (status, json!({"errors":errors}).to_string())).await;
        let stubs = StubDir::new("pr-forbidden");
        stubs.executable("gh", &[], "echo fake");
        let client = connect(&stubs, &server.base).await;
        let error = client
            .summary(&Lookup::new("a/b", 7).expect("lookup"))
            .await
            .expect_err("refused");
        let value = error.to_contract("summary");
        assert_eq!(value["cause"]["reason"], case["expected"]);
        assert!(
            value.get("reason").is_none(),
            "T3 only exposes not-found as an outer reason"
        );
    }
}

#[tokio::test]
async fn repository_not_found_hints_follow_the_credential_source() {
    use crate::http::fake;
    let server = fake::serve(|_| (404, json!({"message":"not found"}).to_string())).await;
    let stubs = StubDir::new("pr-access-hint");
    stubs.executable("gh", &[], "echo fake");
    let child_env = stubs.path_env();
    let endpoints = Endpoints {
        github_rest: Some(server.base.clone()),
    };
    let cases: Vec<Value> = serde_json::from_str(include_str!("cases.json")).expect("cases");
    for case in cases.iter().filter(|c| c["kind"] == "access-hint") {
        let source = case["input"].as_str().expect("source");
        let raw = if source == "settings" {
            json!({"sourceControlHosts":{"github":{"tokens":{"github.com":"saved"}}}})
        } else {
            json!({})
        };
        let settings = Settings::new(raw.as_object().expect("settings").clone());
        let env = Environment::fixed(if source == "env" {
            vec![("GH_TOKEN", "env")]
        } else {
            vec![]
        });
        let client = Client::connect(
            DiscoveryContext {
                cwd: &stubs.dir,
                home: Some(&stubs.dir),
                settings: &settings,
                env: &env,
                endpoints: &endpoints,
                child_env: &child_env,
            },
            "github.com",
        )
        .await
        .expect("credential");
        let error = client
            .summary(&Lookup::new("a/b", 7).expect("lookup"))
            .await
            .expect_err("not found");
        assert_eq!(error.access_hint(), case["expected"].as_str(), "{source}");
    }
}
