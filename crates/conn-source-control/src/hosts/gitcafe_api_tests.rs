//! GitCafe's hosts, credential and API against stub `cafe` and `git` executables and a fake API
//! on loopback. The cases named after a T3 test port `gitCafeHosts.test.ts`,
//! `GitCafeCredentials.test.ts` and `GitCafeSourceControlProvider.test.ts`.

use super::*;
use crate::{
    hosts::{Environment, forgejo_cli::tests::Fixture},
    http::fake,
    settings::Settings,
};

// gitCafeHosts.test.ts: "knows exactly the production and staging hosts".
#[test]
fn knows_exactly_the_production_and_staging_hosts() {
    assert_eq!(GITCAFE_HOSTS, ["git.cafe", "staging.git.cafe"]);
    assert_eq!(gitcafe_host("Git.Cafe"), Some("git.cafe"));
    assert_eq!(gitcafe_host("staging.git.cafe"), Some("staging.git.cafe"));
    for host in [
        "cafe",
        "evil.git.cafe",
        "git.cafe.example.com",
        "github.com",
    ] {
        assert_eq!(gitcafe_host(host), None, "{host}");
    }
}

// gitCafeHosts.test.ts: "reads the host and repository of %s" and "is not a GitCafe
// repository: %s".
#[test]
fn reads_hosts_and_repositories_of_remotes() {
    for (url, host) in [
        (
            "https://staging.git.cafe/team/project.git/",
            "staging.git.cafe",
        ),
        ("ssh@git.cafe:team/project.git", "git.cafe"),
        ("ssh://git@git.cafe/team/project.git", "git.cafe"),
        ("git.cafe:team/project.git", "git.cafe"),
    ] {
        assert_eq!(
            parse_remote(url),
            Some(Target {
                host: gitcafe_host(host).expect("a host"),
                repository: "team/project".into(),
            }),
            "{url}"
        );
    }
    for url in [
        "https://evil.git.cafe/team/project.git",
        "https://git.cafe/team/nested/project.git",
        "team/project",
    ] {
        assert_eq!(parse_remote(url), None, "{url}");
    }
}

// GitCafeCredentials.test.ts: "hands CAFE_TOKEN only to the host cafe itself targets".
#[test]
fn hands_cafe_token_only_to_the_host_cafe_targets() {
    let token = |pairs: &[(&str, &str)], host: &str| {
        environment_token(host, &Environment::fixed(pairs.iter().copied()))
            .map(|s| s.expose().to_owned())
    };
    let plain = [("CAFE_TOKEN", "env-token")];
    assert_eq!(token(&plain, "git.cafe").as_deref(), Some("env-token"));
    assert_eq!(token(&plain, "staging.git.cafe"), None);
    for cafe_host in ["https://staging.git.cafe/api", "staging.git.cafe"] {
        let staging = [("CAFE_TOKEN", "env-token"), ("CAFE_HOST", cafe_host)];
        assert_eq!(
            token(&staging, "staging.git.cafe").as_deref(),
            Some("env-token")
        );
        assert_eq!(token(&staging, "git.cafe"), None);
    }
    assert_eq!(token(&[("CAFE_TOKEN", " ")], "git.cafe"), None);
}

fn settings_with_token(token: &str) -> Settings {
    Settings::new(
        serde_json::json!({"sourceControlHosts": {"gitcafe": {"token": token}}})
            .as_object()
            .cloned()
            .unwrap_or_default(),
    )
}

const CAFE_HELPER: &str =
    "printf 'protocol=https\\nhost=staging.git.cafe\\nusername=alice\\npassword=gct_1\\n'";

// GitCafeCredentials.test.ts: "uses a token saved in Settings for git.cafe only, ahead of
// CAFE_TOKEN", "prefers CAFE_TOKEN without running cafe", and "asks cafe's Git credential
// helper over stdin and reuses the token" (here: within one operation).
#[tokio::test(flavor = "current_thread")]
async fn picks_settings_then_cafe_token_then_the_cafe_helper() {
    let mut fixture = Fixture::new("cafe-cred");
    fixture.stub("cafe", CAFE_HELPER);
    fixture.settings = settings_with_token("saved-token");
    fixture.env = Environment::fixed([("CAFE_TOKEN", "env-token")]);
    let server_cwd = fixture.stubs.dir.clone();
    let client = Client::new(fixture.ctx(), &server_cwd);
    assert_eq!(
        client.credential("git.cafe").await.expect("saved").expose(),
        "saved-token"
    );
    assert_eq!(
        client
            .credential("staging.git.cafe")
            .await
            .expect("helper")
            .expose(),
        "gct_1"
    );
    client.credential("staging.git.cafe").await.expect("again");
    assert_eq!(
        fixture.argv("cafe"),
        ["auth http credential --host https://staging.git.cafe/api get"],
        "asked once"
    );
    assert_eq!(
        fixture.file("cafe.stdin"),
        "protocol=https\nhost=staging.git.cafe\n\n"
    );
    assert_eq!(
        fixture.file("cafe.cwd"),
        format!("{}\n", server_cwd.canonicalize().expect("cwd").display()),
        "in the server's folder"
    );

    let mut env_only = Fixture::new("cafe-env");
    env_only.env = Environment::fixed([("CAFE_TOKEN", "env-token")]);
    let client = Client::new(env_only.ctx(), &server_cwd);
    assert_eq!(
        client.credential("git.cafe").await.expect("env").expose(),
        "env-token"
    );
    assert_eq!(
        env_only.argv("cafe"),
        Vec::<String>::new(),
        "cafe never ran"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn names_each_missing_credential_as_t3_does() {
    let fixture = Fixture::new("cafe-missing");
    let client = Client::new(fixture.ctx(), &fixture.repo);
    assert_eq!(
        client
            .credential("git.cafe")
            .await
            .expect_err("no cafe")
            .detail,
        "No GitCafe credential for git.cafe: set CAFE_TOKEN, or install the GitCafe CLI and run `cafe auth login`."
    );
    let signed_out = Fixture::new("cafe-out");
    signed_out.stub("cafe", "exit 1");
    let client = Client::new(signed_out.ctx(), &signed_out.repo);
    assert_eq!(
        client
            .credential("git.cafe")
            .await
            .expect_err("signed out")
            .detail,
        "No GitCafe credential for git.cafe: run `cafe auth login --host https://git.cafe/api`."
    );
    let mut unreadable = Fixture::new("cafe-ref");
    unreadable.settings = Settings::new(
        serde_json::json!({"sourceControlHosts": {"gitcafe": {"token": {"provider": "vault", "reference": "cafe#token"}}}})
            .as_object()
            .cloned()
            .unwrap_or_default(),
    );
    let client = Client::new(unreadable.ctx(), &unreadable.repo);
    assert!(
        client
            .credential("git.cafe")
            .await
            .expect_err("a reference")
            .detail
            .contains("\"vault\"")
    );
}

/// `git` with no remote: `remote get-url -- origin` fails and `remote` lists nothing.
const GIT_NO_REMOTE: &str = "if [ \"$1 $2\" = 'remote get-url' ]; then exit 2; fi";

// GitCafeSourceControlProvider.test.ts: "reads a bare owner/name on git.cafe without a remote",
// with the T3 driver's `git` children for the primary remote.
#[tokio::test(flavor = "current_thread")]
async fn a_bare_name_without_a_remote_is_on_git_cafe() {
    let server =
        fake::serve(|_| (200, r#"{"name":"project","defaultBranch":"trunk"}"#.into())).await;
    let mut fixture = Fixture::new("cafe-bare");
    fixture.stub("git", GIT_NO_REMOTE);
    fixture.env = Environment::fixed([("CAFE_TOKEN", "env-token")]);
    fixture.endpoints.gitcafe_api = Some(server.base.clone());
    let client = Client::new(fixture.ctx(), &fixture.repo);
    let target = client.resolve_named("team/project").await.expect("target");
    assert_eq!(target.host, "git.cafe");
    let text = client
        .request(target.host, Method::Get, "/repos/team/project", None)
        .await
        .expect("read");
    assert!(text.contains("trunk"));
    assert_eq!(fixture.argv("git"), ["remote get-url -- origin", "remote"]);
    let seen = crate::hosts::forgejo_cli::tests::requests(&server);
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].path, "/api/repos/team/project");
    let headers: Vec<(&str, &str)> = seen[0]
        .headers
        .iter()
        .filter(|(n, _)| n != "host")
        .map(|(n, v)| (n.as_str(), v.as_str()))
        .collect();
    assert_eq!(
        headers,
        [
            ("authorization", "Bearer env-token"),
            ("accept", "application/json"),
            ("user-agent", "t3code"),
        ]
    );
}

// Derived from `resolveTarget`: the checkout's GitCafe remote names the host of a bare name.
#[tokio::test(flavor = "current_thread")]
async fn the_checkouts_remote_names_the_host() {
    let fixture = Fixture::new("cafe-remote");
    fixture.stub(
        "git",
        "if [ \"$1\" = config ]; then echo 'https://staging.git.cafe/team/project.git'; fi",
    );
    let client = Client::new(fixture.ctx(), &fixture.repo);
    let target = client.resolve_named("team/other").await.expect("target");
    assert_eq!(target.host, "staging.git.cafe");
    assert_eq!(target.repository, "team/other");
    assert_eq!(
        fixture.argv("git"),
        ["remote get-url -- origin", "config --get remote.origin.url"]
    );
    assert_eq!(
        client
            .resolve_named("https://github.com/team/project")
            .await
            .expect_err("not GitCafe")
            .detail,
        "A GitCafe repository is named owner/name or by its git.cafe URL."
    );
}

// Derived from `GitCafeApi.request`: a problem's text, a redirect only within the API, and no
// request at all to a host that is not GitCafe's.
#[tokio::test(flavor = "current_thread")]
async fn follows_redirects_only_within_the_api_and_reads_problems() {
    let server = fake::serve_with_headers(|r| match r.path.as_str() {
        "/api/repos/team/project/pulls/7" => (
            301,
            vec![("location".into(), "/api/repos/team/project/pulls/42".into())],
            String::new(),
        ),
        "/api/repos/team/project/pulls/42" => (200, Vec::new(), "{}".into()),
        "/api/escape" => (
            302,
            vec![("location".into(), "/elsewhere".into())],
            String::new(),
        ),
        _ => (
            422,
            Vec::new(),
            r#"{"title":"Unprocessable","detail":"  too\n many   spaces "}"#.into(),
        ),
    })
    .await;
    let mut fixture = Fixture::new("cafe-redirect");
    fixture.env = Environment::fixed([("CAFE_TOKEN", "env-token")]);
    fixture.endpoints.gitcafe_api = Some(server.base.clone());
    let client = Client::new(fixture.ctx(), &fixture.repo);
    client
        .request("git.cafe", Method::Get, "/repos/team/project/pulls/7", None)
        .await
        .expect("followed");
    let escape = client
        .request("git.cafe", Method::Get, "/escape", None)
        .await
        .expect_err("not followed");
    assert_eq!(escape.detail, "GitCafe answered HTTP 302.");
    let problem = client
        .request("git.cafe", Method::Post, "/x", Some("{}"))
        .await
        .expect_err("422");
    assert_eq!(problem.detail, "too many spaces");
    assert_eq!(problem.status, Some(422));
    let foreign = client
        .request("example.com", Method::Get, "/x", None)
        .await
        .expect_err("not GitCafe");
    assert_eq!(
        foreign.detail,
        "GitCafe lives on git.cafe and staging.git.cafe, not example.com."
    );
    let paths: Vec<String> = crate::hosts::forgejo_cli::tests::requests(&server)
        .iter()
        .map(|r| r.path.clone())
        .collect();
    assert_eq!(
        paths,
        [
            "/api/repos/team/project/pulls/7",
            "/api/repos/team/project/pulls/42",
            "/api/escape",
            "/api/x",
        ]
    );
    assert_eq!(
        problem_text(&format!(r#"{{"title":"{}"}}"#, "a".repeat(301))).map(|t| t.chars().count()),
        Some(301)
    );
    assert_eq!(problem_text(r#"{"detail":5}"#), None);
}
