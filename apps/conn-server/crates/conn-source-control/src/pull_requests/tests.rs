use super::normalize::text;
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
            "reviewSubmission" => actions::review_submission(input).expect("review submission"),
            "subject" => json!(actions::subject_belongs(input)),
            "reviewerCandidates" => {
                actions::reviewer_candidates(&input["result"], input["query"].as_str())
                    .unwrap_or(Value::Null)
            }
            "reviewerRequest" => actions::reviewer_request(input.as_array().expect("reviewers")),
            "labelCandidates" => actions::label_candidates(input).unwrap_or(Value::Null),
            "stack" => stack::decode(input).expect("stack"),
            "stackError" => json!(stack::decode(input).is_err()),
            "provider-failure" | "access-hint" => continue,
            "github-host" => json!(github::is_github_host(input.as_str().expect("host"))),
            "summary" => normalize::summary(input, "github.com"),
            "checks" => json!(normalize::checks(input.as_array().expect("contexts"))),
            "breakdown" => normalize::breakdown(input),
            "patch" => diff::files_patch(input.as_array().expect("files")),
            "mergeMessage" => json!(super::merge_message::remove_agent_credits(
                input.as_str().expect("message")
            )),
            "jobId" => json!(super::checks::actions_job_id(input.as_str())),
            "logTail" => {
                let (log, truncated) = super::checks::tail_log_lines(
                    text(input, "text"),
                    input["lines"].as_u64().expect("lines") as usize,
                );
                json!({"log": log, "truncated": truncated})
            }
            "lightPermissions" => {
                super::run_action::light_viewer_permissions(input).unwrap_or(Value::Null)
            }
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
async fn actions_send_t3_documents_and_rest_bodies_and_keep_one_credential() {
    use crate::http::fake;
    let server = fake::serve(|request| {
        if request.path != "/graphql" {return (204,String::new());}
        let body: Value = serde_json::from_str(&request.body).expect("request");
        let query = body["query"].as_str().expect("query");
        let data = if query.contains("query PullRequestSubject") {
            json!({"repository":{"pullRequest":{"id":"PR7"}},"node":{"__typename":"IssueComment","id":"C7","pullRequest":{"id":"PR7"}}})
        } else if query.contains("query ViewerPermissions") {
            json!({"repository":{"viewerPermission":"WRITE","pullRequest":{"viewerDidAuthor":false}}})
        } else if query.contains("query PullRequestNodeId") {
            json!({"repository":{"pullRequest":{"id":"PR7"}}})
        } else {json!({})};
        (200,json!({"data":data}).to_string())
    }).await;
    let stubs = StubDir::new("pr-actions");
    stubs.executable("gh", &[], "printf '%s\\n' fake-pr-token");
    let client = connect(&stubs, &server.base).await;
    let lookup = Lookup::new("a/b", 7).expect("lookup");
    let mutations = [
        ("comment", json!({"body":"a } mutation { \n"})),
        ("replyToThread", json!({"threadId":"T7","body":"reply"})),
        (
            "setThreadResolution",
            json!({"threadId":"T7","resolved":true}),
        ),
        (
            "setThreadResolution",
            json!({"threadId":"T7","resolved":false}),
        ),
        ("setReaction", json!({"content":"thumbs-up","reacted":true})),
        (
            "setReaction",
            json!({"subjectId":"C7","content":"heart","reacted":false}),
        ),
        (
            "updateComment",
            json!({"commentId":"C7","kind":"issue-comment","body":"issue"}),
        ),
        (
            "updateComment",
            json!({"commentId":"C7","kind":"review-comment","body":"review"}),
        ),
        ("update", json!({"body":"","maintainerCanModify":false})),
        (
            "submitReview",
            json!({"verdict":"approve","body":"","comments":[]}),
        ),
        (
            "requestReviewers",
            json!({"requested":true,"reviewers":[{"id":"reader","kind":"user"},{"id":"core","kind":"team"}]}),
        ),
        (
            "requestReviewers",
            json!({"requested":false,"reviewers":[{"id":"reader","kind":"user"}]}),
        ),
        ("setLabels", json!({"labels":["bug"],"applied":true})),
        (
            "setLabels",
            json!({"labels":["good first issue","area/web"],"applied":false}),
        ),
    ];
    for (method, input) in mutations {
        assert_eq!(
            client.action(&lookup, method, &input).await.expect(method),
            Value::Null,
            "{method}"
        );
    }
    let requests = server.requests.lock().expect("requests");
    let graphql: Vec<Value> = requests
        .iter()
        .filter(|r| r.path == "/graphql")
        .map(|r| serde_json::from_str(&r.body).expect("graphql"))
        .collect();
    let writes: Vec<_> = graphql
        .iter()
        .filter(|r| text(r, "query").starts_with("mutation "))
        .map(|r| (text(r, "query"), r.get("variables").expect("variables")))
        .collect();
    assert_eq!(
        writes,
        vec![
            (
                generated::ADD_COMMENT.document,
                &json!({"subjectId":"PR7","body":"a } mutation { \n"})
            ),
            (
                generated::ADD_REVIEW_THREAD_REPLY.document,
                &json!({"threadId":"T7","body":"reply"})
            ),
            (
                generated::RESOLVE_REVIEW_THREAD.document,
                &json!({"threadId":"T7"})
            ),
            (
                generated::UNRESOLVE_REVIEW_THREAD.document,
                &json!({"threadId":"T7"})
            ),
            (
                generated::ADD_REACTION.document,
                &json!({"subjectId":"PR7","content":"THUMBS_UP"})
            ),
            (
                generated::REMOVE_REACTION.document,
                &json!({"subjectId":"C7","content":"HEART"})
            ),
            (
                generated::UPDATE_ISSUE_COMMENT.document,
                &json!({"commentId":"C7","body":"issue"})
            ),
            (
                generated::UPDATE_REVIEW_COMMENT.document,
                &json!({"commentId":"C7","body":"review"})
            ),
            (
                generated::UPDATE_PULL_REQUEST.document,
                &json!({"pullRequestId":"PR7","body":"","maintainerCanModify":false})
            ),
        ],
        "generated documents and variables; omitted update fields stay omitted"
    );
    let rest: Vec<_> = requests
        .iter()
        .filter(|r| r.path != "/graphql")
        .map(|r| {
            (
                r.method.as_str(),
                r.path.as_str(),
                if r.body.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_str::<Value>(&r.body).expect("body")
                },
            )
        })
        .collect();
    assert_eq!(
        rest,
        vec![
            (
                "POST",
                "/repos/a/b/pulls/7/reviews",
                json!({"event":"APPROVE","body":"","comments":[]})
            ),
            (
                "POST",
                "/repos/a/b/pulls/7/requested_reviewers",
                json!({"reviewers":["reader"],"team_reviewers":["core"]})
            ),
            (
                "DELETE",
                "/repos/a/b/pulls/7/requested_reviewers",
                json!({"reviewers":["reader"],"team_reviewers":[]})
            ),
            (
                "POST",
                "/repos/a/b/issues/7/labels",
                json!({"labels":["bug"]})
            ),
            (
                "DELETE",
                "/repos/a/b/issues/7/labels/good%20first%20issue",
                Value::Null
            ),
            (
                "DELETE",
                "/repos/a/b/issues/7/labels/area%2Fweb",
                Value::Null
            ),
        ],
        "T3 REST paths, order and payloads"
    );
    for request in requests.iter() {
        assert!(
            request
                .headers
                .iter()
                .any(|(key, value)| key == "authorization" && value == "Bearer fake-pr-token"),
            "one credential throughout"
        );
    }
}

#[tokio::test]
async fn actions_match_t3s_recorded_http_requests() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("action-cases.json")).expect("T3 recordings");
    for case in cases {
        let refusal = case.get("refusal").cloned();
        let server=crate::http::fake::serve(move |request| {
            let body:Value=serde_json::from_str(&request.body).unwrap_or(Value::Null);
            let query=text(&body,"query");
            if let Some(refusal)=&refusal && (request.path!="/graphql" || query.starts_with("mutation ")) {
                return (refusal["status"].as_u64().expect("status") as u16,refusal["body"].to_string());
            }
            let data=if query.contains("query PullRequestSubject"){json!({"repository":{"pullRequest":{"id":"PR7"}},"node":{"__typename":"IssueComment","id":"C7","pullRequest":{"id":"PR7"}}})}
                else if query.contains("query ViewerPermissions"){json!({"repository":{"viewerPermission":"WRITE","pullRequest":{"viewerDidAuthor":false}}})}
                else if query.contains("query PullRequestNodeId"){json!({"repository":{"pullRequest":{"id":"PR7"}}})}
                else {json!({})};
            (200,json!({"data":data}).to_string())
        }).await;
        let stubs = StubDir::new("pr-action-recording");
        stubs.executable("gh", &[], "printf '%s\\n' fake-pr-token");
        let client = connect(&stubs, &server.base).await;
        let result = client
            .action(
                &Lookup::new("a/b", 7).expect("lookup"),
                text(&case, "method"),
                &case["input"],
            )
            .await;
        if let Some(expected) = case.get("error") {
            let error = result.expect_err("T3 refuses this action");
            assert_eq!(
                error.to_contract(text(&case, "method"))["detail"],
                expected["detail"],
                "T3 error for {}",
                case["method"]
            );
            assert_eq!(
                matches!(error, Error::NotFound(_) | Error::RepositoryNotFound(_, _)),
                expected["tag"] == "GitHubApiNotFoundError",
                "not-found classification"
            );
            assert_eq!(
                matches!(error, Error::RateLimited),
                expected["tag"] == "GitHubApiRateLimitError",
                "rate-limit classification"
            );
        } else {
            assert_eq!(result.expect("action"), Value::Null, "write result");
        }
        let actual:Vec<_>=server.requests.lock().expect("requests").iter().filter(|r|!r.body.contains("query ViewerPermissions")).map(|r|json!({"method":r.method,"path":r.path,"body":if r.body.is_empty(){Value::Null}else{serde_json::from_str::<Value>(&r.body).expect("JSON")}})).collect();
        assert_eq!(
            json!(actual),
            case["requests"],
            "T3 API trace for {} {:?}",
            case["method"],
            case["input"]
        );
    }
}

#[tokio::test]
async fn fresh_permissions_refuse_writes_and_subjects_from_another_pr() {
    use crate::http::fake;
    let permission = std::sync::Arc::new(std::sync::Mutex::new(json!("READ")));
    let author = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let server = fake::serve({let permission=permission.clone();let author=author.clone(); move |request| {
        let body: Value = serde_json::from_str(&request.body).expect("request");
        let data = if text(&body,"query").contains("ViewerPermissions") {
            json!({"repository":{"viewerPermission":permission.lock().expect("permission").clone(),"pullRequest":{"viewerDidAuthor":author.load(std::sync::atomic::Ordering::Relaxed)}}})
        } else {
            json!({"repository":{"pullRequest":{"id":"PR7"}},"node":{"__typename":"PullRequestReviewComment","id":"C8","reviewCommentPullRequest":{"id":"PR8"}}})
        };
        (200,json!({"data":data}).to_string())
    }}).await;
    let stubs = StubDir::new("pr-access");
    stubs.executable("gh", &[], "printf '%s\\n' fake-pr-token");
    let client = connect(&stubs, &server.base).await;
    let lookup = Lookup::new("a/b", 7).expect("lookup");
    for method in [
        "requestReviewers",
        "reviewerCandidates",
        "labelCandidates",
        "setLabels",
        "setThreadResolution",
    ] {
        let error = client
            .action(&lookup, method, &json!({"threadId":"T7","resolved":true}))
            .await
            .expect_err(method);
        let detail = match method {
            "requestReviewers" | "reviewerCandidates" => {
                "You need write access on this repository to ask for a review."
            }
            "setLabels" | "labelCandidates" => {
                "You need triage access on this repository to change its labels."
            }
            _ => {
                "You need write access on this repository, or to have opened this change request, to resolve a review conversation."
            }
        };
        assert_eq!(error, Error::Failed(detail.into()), "{method}");
    }
    *permission.lock().expect("permission") = json!("WRITE");
    author.store(true, std::sync::atomic::Ordering::Relaxed);
    for (verdict, label) in [
        ("approve", "approve"),
        ("request-changes", "request changes on"),
    ] {
        assert_eq!(
            client
                .action(
                    &lookup,
                    "submitReview",
                    &json!({"verdict":verdict,"body":"summary","comments":[]})
                )
                .await
                .expect_err("author cannot review"),
            Error::Failed(format!(
                "You need write access on this repository to {label} a change request."
            )),
            "author has write access but cannot approve self"
        );
    }
    for (method, input) in [
        (
            "setReaction",
            json!({"subjectId":"C8","content":"heart","reacted":true}),
        ),
        (
            "updateComment",
            json!({"commentId":"C8","body":"new","kind":"review-comment"}),
        ),
    ] {
        assert_eq!(
            client
                .action(&lookup, method, &input)
                .await
                .expect_err("other PR"),
            Error::Failed("The named subject did not belong to the named pull request.".into()),
            "{method}"
        );
    }
    assert!(
        server
            .requests
            .lock()
            .expect("requests")
            .iter()
            .all(|r| !r.body.contains("mutation ")),
        "refusals send no mutation"
    );
}

#[tokio::test]
async fn stack_reads_details_and_only_not_found_means_no_stack() {
    use crate::http::fake;
    let server = fake::serve(|request| {
        match request.path.as_str() {
            "/repos/a/b/stacks?pull_request=7" => (200,json!([{"number":3,"url":"api","base":"main","pull_requests":[]}]).to_string()),
            "/repos/a/b/stacks/3" => (200,json!({"number":3,"url":"api","base":"main","pull_requests":[{"number":7,"head":{"ref":"branch","sha":"abc"}}]}).to_string()),
            "/repos/a/b/stacks?pull_request=8" => (404,"{}".into()),
            _ => (500,"{}".into()),
        }
    }).await;
    let stubs = StubDir::new("pr-stack");
    stubs.executable("gh", &[], "printf '%s\\n' fake-pr-token");
    let client = connect(&stubs, &server.base).await;
    assert_eq!(
        client
            .stack(&Lookup::new("a/b", 7).expect("lookup"))
            .await
            .expect("stack")["layers"][0]["headSha"],
        "abc",
        "detailed stack"
    );
    assert_eq!(
        client
            .stack(&Lookup::new("a/b", 8).expect("lookup"))
            .await
            .expect("no stack"),
        Value::Null,
        "404 is unsupported"
    );
    assert!(
        client
            .stack(&Lookup::new("a/b", 9).expect("lookup"))
            .await
            .is_err(),
        "outage must not erase stacks"
    );
    assert!(
        stack::decode(&json!([{"number":"bad"}])).is_err(),
        "malformed host output fails"
    );
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

    assert!(
        matches!(error, Error::NotFound(_) | Error::RepositoryNotFound(_, _)),
        "typed not-found"
    );

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
        if r.path != "/graphql" { return (404,"{}".into()); }
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

#[tokio::test]
async fn routing_identity_falls_back_to_graphql_when_user_is_forbidden() {
    use crate::http::fake;
    let server = fake::serve(|r| {
        if r.path == "/user" {
            (
                403,
                json!({"message":"Resource not accessible by integration"}).to_string(),
            )
        } else {
            let body: Value = serde_json::from_str(&r.body).expect("JSON");
            assert!(
                body["query"]
                    .as_str()
                    .expect("query")
                    .contains("RoutingIdentityViewer")
            );
            (
                200,
                json!({"data":{"viewer":{"databaseId":12,"login":"nick"}}}).to_string(),
            )
        }
    })
    .await;
    let stubs = StubDir::new("pr-identity-fallback");
    stubs.executable("gh", &[], "echo fake");
    let client = connect(&stubs, &server.base).await;
    assert_eq!(
        client.identity().await.expect("GraphQL fallback"),
        json!({"accountId":"12","viewer":"nick"})
    );
}

#[tokio::test]
async fn requests_keep_github_messages_and_secondary_rate_limit_classification() {
    use crate::http::fake;
    for (status, body, detail, reason) in [
        (
            403,
            json!({"message":"You have triggered an abuse detection mechanism"}),
            "GitHub API rate limit exceeded.",
            "rate-limited",
        ),
        (
            422,
            json!({"message":"Validation failed","errors":[{"field":"title","code":"missing"}]}),
            "GitHub returned an error: Validation failed; title missing",
            "failed",
        ),
    ] {
        let server = fake::serve(move |_| (status, body.to_string())).await;
        let stubs = StubDir::new("pr-request-policy");
        stubs.executable("gh", &[], "echo fake");
        let client = connect(&stubs, &server.base).await;
        let error = client
            .summary(&Lookup::new("a/b", 7).expect("lookup"))
            .await
            .expect_err("refused");
        assert_eq!(error.to_string(), detail);
        assert_eq!(error.to_contract("summary")["cause"]["reason"], reason);
    }
}

/// 26 heads take two documents. When the second fails, the first document's 25 answers still
/// count; only the 26th head is unanswered.
#[tokio::test]
async fn head_lookups_keep_each_documents_answers_when_a_later_one_fails() {
    use crate::http::fake;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let documents = std::sync::Arc::new(AtomicUsize::new(0));
    let seen = documents.clone();
    let server = fake::serve(move |request| {
        if request.path != "/graphql" {
            return (404, String::new());
        }
        if seen.fetch_add(1, Ordering::SeqCst) > 0 {
            return (502, "bad gateway".into());
        }
        let body: Value = serde_json::from_str(&request.body).expect("request");
        let mut data = serde_json::Map::new();
        for index in 0..25 {
            let head = body["variables"][format!("_{index}_head")].clone();
            data.insert(
                format!("_{index}_repository"),
                json!({"pullRequests": {"nodes": [{"number": index + 1, "headRefName": head}]}}),
            );
        }
        (200, json!({"data": data}).to_string())
    })
    .await;
    let stubs = StubDir::new("pr-heads");
    stubs.executable("gh", &[], "printf '%s\\n' fake-pr-token");
    let client = connect(&stubs, &server.base).await;
    let heads: Vec<(String, String, String)> = (0..26)
        .map(|n| ("o".into(), "r".into(), format!("b{n}")))
        .collect();
    let answers = client.pull_requests_by_heads(&heads).await;
    assert_eq!(documents.load(Ordering::SeqCst), 2, "two documents");
    assert_eq!(answers.len(), 26);
    for (index, answer) in answers.iter().take(25).enumerate() {
        let nodes = answer.as_ref().expect("the first document's answer");
        assert_eq!(nodes[0]["headRefName"], format!("b{index}"));
    }
    assert_eq!(answers[25], None, "the failed document's head");
}

/// T3's `runPullRequestAction`, `readCheckLogs` and `rerunChecks` traces
/// (`tools/pr-action-recordings.mjs`), replayed on the same answers. Check reads and re-runs run
/// concurrently in T3, so their requests compare as a set.
#[tokio::test]
async fn run_actions_and_ci_match_t3s_recorded_http_requests() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("run-action-cases.json")).expect("T3 recordings");
    for case in cases {
        let responses = case["responses"].clone();
        let server = crate::http::fake::serve(move |request| {
            let body: Value = serde_json::from_str(&request.body).unwrap_or(Value::Null);
            let operation = text(&body, "query")
                .split_once(' ')
                .and_then(|(_, rest)| rest.split(['(', '{']).next())
                .map(str::to_owned);
            let key = match (request.path.ends_with("/graphql"), &operation) {
                (true, Some(name)) => format!("graphql {name}"),
                _ => format!("{} {}", request.method, request.path),
            };
            let answer =
                responses
                    .get(&key)
                    .cloned()
                    .unwrap_or_else(|| match operation.as_deref() {
                        Some("PullRequestNodeId") => {
                            json!({"data": {"repository": {"pullRequest": {"id": "PR7"}}}})
                        }
                        Some(_) => json!({"data": {}}),
                        None => json!({"status": 200, "body": {}}),
                    });
            let status = answer["status"].as_u64().unwrap_or(200) as u16;
            let body = match (answer.get("text"), answer.get("body")) {
                (Some(text), _) => text.as_str().unwrap_or_default().to_owned(),
                (None, Some(body)) => body.to_string(),
                (None, None) => answer.to_string(),
            };
            (status, body)
        })
        .await;
        let stubs = StubDir::new("pr-run-action");
        stubs.executable("gh", &[], "printf '%s\\n' fake-pr-token");
        let client = connect(&stubs, &server.base).await;
        let lookup = Lookup::new("a/b", 7).expect("lookup");
        let input = &case["input"];
        let empty = Vec::new();
        let checks = input["checks"].as_array().unwrap_or(&empty);
        let method = text(&case, "method");
        let result: Result<Value, Error> = match method {
            "runPullRequestAction" => client
                .run_action(
                    &lookup,
                    input,
                    input["removeAgentCreditsOnMerge"] == Value::Bool(true),
                )
                .await
                .map(|()| Value::Null),
            "readCheckLogs" => client
                .check_logs(
                    &lookup,
                    checks,
                    input["tailLines"].as_u64().expect("lines") as usize,
                )
                .await
                .map(Value::from),
            "rerunChecks" => client.rerun_checks(&lookup, checks).await.map(Value::from),
            other => panic!("unknown recorded method {other}"),
        };
        match case.get("error") {
            Some(expected) => {
                let error = result.expect_err("T3 failed this case");
                assert_eq!(
                    json!(error.to_string()),
                    expected["detail"],
                    "T3 error for {method} {input}"
                );
            }
            None => assert_eq!(
                result.expect("T3 succeeded"),
                case["result"],
                "T3 result for {method} {input}"
            ),
        }
        let mut actual: Vec<Value> = server
            .requests
            .lock()
            .expect("requests")
            .iter()
            .map(|r| {
                json!({"method": r.method, "path": r.path, "body": if r.body.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_str::<Value>(&r.body).expect("JSON")
                }})
            })
            .collect();
        let mut expected = case["requests"].as_array().cloned().unwrap_or_default();
        if method != "runPullRequestAction" {
            let order = |v: &Value| format!("{} {}", v["method"], v["path"]);
            actual.sort_by_key(order);
            expected.sort_by_key(order);
        }
        assert_eq!(actual, expected, "T3 API trace for {method} {input}");
    }
}
