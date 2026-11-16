//! GitHub repository calls against a stub CLI and a loopback API.

use std::ffi::OsString;

use super::*;
use crate::{
    discovery::stub::StubDir,
    hosts::{Endpoints, Environment},
    http::fake::{self, Recorded},
    settings::Settings,
};

fn child_env(stubs: &StubDir) -> Vec<(&'static str, OsString)> {
    let mut env = stubs.path_env();
    env.push(("HOME", stubs.dir.clone().into_os_string()));
    env.push(("GIT_CONFIG_NOSYSTEM", "1".into()));
    env
}

fn hosts<'a>(
    stubs: &'a StubDir,
    settings: &'a Settings,
    env: &'a Environment,
    endpoints: &'a Endpoints,
    child_env: &'a [(&'static str, OsString)],
) -> Hosts<'a> {
    Hosts {
        ctx: DiscoveryContext {
            cwd: &stubs.dir,
            home: None,
            settings,
            env,
            endpoints,
            child_env,
        },
    }
}

fn requests(server: &fake::FakeServer) -> Vec<Recorded> {
    server
        .requests
        .lock()
        .map(|r| r.clone())
        .unwrap_or_default()
}

fn header<'a>(request: &'a Recorded, name: &str) -> Option<&'a str> {
    request
        .headers
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v.as_str())
}

const GITHUB_REPOSITORY: &str = r#"{"full_name":"octocat/t3code","html_url":"https://github.com/octocat/t3code","ssh_url":"git@github.com:octocat/t3code.git"}"#;

#[tokio::test(flavor = "current_thread")]
async fn github_reads_and_creates_repositories_over_rest() {
    let server = fake::serve(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/user") => (200, r#"{"login":"octocat"}"#.into()),
        ("GET", "/repos/octocat/t3code") | ("POST", _) => (200, GITHUB_REPOSITORY.into()),
        _ => (404, r#"{"message":"Not Found"}"#.into()),
    })
    .await;
    let stubs = StubDir::new("gh-repo");
    // A `gh` without a login: without it, the lookup would run this machine's own `gh`.
    stubs.executable("gh", &[], "echo 'not logged in' >&2; exit 1");
    let settings = Settings::default();
    let env = Environment::fixed([("GH_TOKEN", "env-token")]);
    let endpoints = Endpoints {
        github_rest: Some(server.base.clone()),
    };
    let child = child_env(&stubs);
    let hosts = hosts(&stubs, &settings, &env, &endpoints, &child);

    let urls = hosts
        .clone_urls("github", &stubs.dir, "octocat/t3code")
        .await
        .expect("looked up");
    assert_eq!(
        urls,
        CloneUrls {
            name_with_owner: "octocat/t3code".into(),
            url: "https://github.com/octocat/t3code".into(),
            ssh_url: "git@github.com:octocat/t3code.git".into(),
        }
    );
    // A bare name belongs to the signed-in account.
    hosts
        .clone_urls("github", &stubs.dir, "t3code.git")
        .await
        .expect("bare name");
    let missing = hosts.clone_urls("github", &stubs.dir, "a/b/c").await;
    assert!(missing.is_err(), "three parts on a non-host");

    hosts
        .create_repository("github", &stubs.dir, "octocat/new", Visibility::Private)
        .await
        .expect("created for the viewer");
    hosts
        .create_repository("github", &stubs.dir, "acme/new", Visibility::Public)
        .await
        .expect("created in the org");
    hosts
        .create_repository("github", &stubs.dir, "solo", Visibility::Private)
        .await
        .expect("a bare name asks no viewer");

    let seen: Vec<(String, String, String)> = requests(&server)
        .iter()
        .map(|r| (r.method.clone(), r.path.clone(), r.body.clone()))
        .collect();
    let row = |m: &str, p: &str, b: &str| (m.to_owned(), p.to_owned(), b.to_owned());
    assert_eq!(
        seen,
        [
            row("GET", "/repos/octocat/t3code", ""),
            row("GET", "/user", ""),
            row("GET", "/repos/octocat/t3code", ""),
            row("GET", "/user", ""),
            row("POST", "/user/repos", r#"{"name":"new","private":true}"#),
            row("GET", "/user", ""),
            row(
                "POST",
                "/orgs/acme/repos",
                r#"{"name":"new","private":false}"#
            ),
            row("POST", "/user/repos", r#"{"name":"solo","private":true}"#),
        ]
    );
    let first = requests(&server).into_iter().next().expect("one request");
    assert_eq!(header(&first, "authorization"), Some("Bearer env-token"));
    assert_eq!(
        header(&first, "accept"),
        Some("application/vnd.github+json")
    );
    assert_eq!(header(&first, "x-github-api-version"), Some("2022-11-28"));
    assert_eq!(header(&first, "user-agent"), Some("t3code"));
}

#[test]
fn github_selectors_and_remote_hosts() {
    assert_eq!(
        parse_selector("https://GitHub.com/o/r.git/", "x"),
        Some(Locator {
            host: "github.com".into(),
            owner: "o".into(),
            name: "r".into()
        })
    );
    assert_eq!(
        parse_selector("acme.ghe.com/o/r", "github.com").map(|l| l.host),
        Some("acme.ghe.com".into())
    );
    assert_eq!(
        parse_selector("o/r", "ghe.example").map(|l| l.host),
        Some("ghe.example".into())
    );
    assert_eq!(parse_selector("https://h/o", "x"), None);
    assert_eq!(
        api_host_for_remote("git@github.com-work:o/r.git").as_deref(),
        Some("github.com")
    );
    assert_eq!(
        api_host_for_remote("https://acme.ghe.com/o/r").as_deref(),
        Some("acme.ghe.com")
    );
    assert_eq!(api_host_for_remote("git@gitlab.com:o/r.git"), None);
    // gitHubRepositoryResolution.test.ts: "reads an SSH alias through github.com and a real
    // host as itself", and the github.com-<name> cases.
    assert_eq!(
        api_host_for_remote("git@github:acme/web.git").as_deref(),
        Some("github.com")
    );
    assert_eq!(
        api_host_for_remote("git@github.example.com:a/b.git").as_deref(),
        Some("github.example.com")
    );
    assert_eq!(
        api_host_for_remote("https://github.corp.example:8443/a/b.git").as_deref(),
        Some("github.corp.example:8443"),
        "an Enterprise Server keeps its port"
    );
    for url in [
        "git@github.com-scale:scalable-so/scalablev2.git",
        "git@GitHub.com-Work:acme/web.git",
        "ssh://git@github.com-personal/acme/web.git",
    ] {
        assert_eq!(
            api_host_for_remote(url).as_deref(),
            Some("github.com"),
            "{url}"
        );
    }
    for (url, host) in [
        (
            "git@github.com-evil.example:acme/web.git",
            Some("github.com-evil.example"),
        ),
        (
            "ssh://git@github.com-evil.example/acme/web.git",
            Some("github.com-evil.example"),
        ),
        (
            "git@github.com.evil.example:acme/web.git",
            Some("github.com.evil.example"),
        ),
        ("git@evil-github.com:acme/web.git", None),
    ] {
        assert_eq!(api_host_for_remote(url).as_deref(), host, "{url}");
    }
    assert_eq!(
        fetch_remotes(
            "origin\tgit@github.com:o/r.git (fetch)\norigin\tgit@github.com:o/r.git (push)\nup\thttps://github.com/u/r (fetch) [blob:none]\n"
        ),
        [
            ("origin".to_owned(), "git@github.com:o/r.git".to_owned()),
            ("up".to_owned(), "https://github.com/u/r".to_owned())
        ]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn an_unbuilt_host_fails_as_unregistered() {
    let stubs = StubDir::new("none-repo");
    let settings = Settings::default();
    let env = Environment::fixed([]);
    let endpoints = Endpoints::default();
    let child = child_env(&stubs);
    let hosts = hosts(&stubs, &settings, &env, &endpoints, &child);
    for kind in [
        "example",
        "gitlab",
        "forgejo",
        "bitbucket",
        "azure-devops",
        "gitcafe",
        "cursor-origin",
    ] {
        let failure = hosts
            .clone_urls(kind, &stubs.dir, "o/r")
            .await
            .expect_err("no driver");
        assert_eq!(
            failure.detail,
            format!("No {kind} source control provider is registered.")
        );
        let failure = hosts
            .create_repository(kind, &stubs.dir, "o/r", Visibility::Private)
            .await
            .expect_err("no driver");
        assert_eq!(
            failure.detail,
            format!("No {kind} source control provider is registered.")
        );
    }
}
