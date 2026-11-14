//! Each host's repository calls against stub CLIs and a fake API on loopback. The expected argv,
//! paths and bodies are the T3 drivers' (`GitLabCli.ts`, `AzureDevOpsCli.ts`, `BitbucketApi.ts`,
//! `GitHubSourceControlProvider.ts`, `OriginSourceControlProvider.ts`).

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
    let settings = Settings::default();
    let env = Environment::fixed([("GH_TOKEN", "env-token")]);
    let endpoints = Endpoints {
        github_rest: Some(server.base.clone()),
        ..Endpoints::default()
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

const GITLAB_PROJECT: &str = r#"{"path_with_namespace":"group/sub/project","web_url":"https://gitlab.com/group/sub/project","http_url_to_repo":"https://gitlab.com/group/sub/project.git","ssh_url_to_repo":"git@gitlab.com:group/sub/project.git"}"#;

#[tokio::test(flavor = "current_thread")]
async fn gitlab_runs_glab_api_like_gitlab_cli() {
    let stubs = StubDir::new("glab-repo");
    stubs.executable(
        "glab",
        &["GITLAB_HOST", "GIT_CONFIG_KEY_0"],
        &format!(
            "case \"$2\" in namespaces/*) echo '{{\"id\":42}}';; *) echo '{GITLAB_PROJECT}';; esac"
        ),
    );
    let settings = Settings::default();
    let env = Environment::fixed([]);
    let endpoints = Endpoints::default();
    let child = child_env(&stubs);
    let hosts = hosts(&stubs, &settings, &env, &endpoints, &child);
    let urls = hosts
        .clone_urls("gitlab", &stubs.dir, "group/sub/project")
        .await
        .expect("looked up");
    assert_eq!(urls.name_with_owner, "group/sub/project");
    assert_eq!(
        urls.url, "https://gitlab.com/group/sub/project",
        "web_url, as T3"
    );
    assert_eq!(urls.ssh_url, "git@gitlab.com:group/sub/project.git");
    hosts
        .create_repository(
            "gitlab",
            &stubs.dir,
            "group/sub/project",
            Visibility::Private,
        )
        .await
        .expect("created");
    hosts
        .create_repository("gitlab", &stubs.dir, "solo", Visibility::Public)
        .await
        .expect("created in the personal namespace");
    let env_lines = "  env GITLAB_HOST=<unset>\n  env GIT_CONFIG_KEY_0=safe.bareRepository\n";
    assert_eq!(
        stubs.log("glab"),
        [
            "argv api projects/group%2Fsub%2Fproject\n",
            "argv api namespaces/group%2Fsub\n",
            "argv api --method POST projects --raw-field path=project --raw-field name=project --raw-field visibility=private --raw-field namespace_id=42\n",
            "argv api --method POST projects --raw-field path=solo --raw-field name=solo --raw-field visibility=public\n",
        ]
        .map(|argv| format!("{argv}{env_lines}"))
        .concat()
    );
}

const AZURE_REPOSITORY: &str = r#"{"name":"repo","webUrl":"https://dev.azure.com/org/proj/_git/repo","remoteUrl":"https://org@dev.azure.com/org/proj/_git/repo","sshUrl":"git@ssh.dev.azure.com:v3/org/proj/repo","project":{"name":"proj"}}"#;

#[tokio::test(flavor = "current_thread")]
async fn azure_runs_az_repos_like_azure_devops_cli() {
    let stubs = StubDir::new("az-repo");
    stubs.executable("az", &[], &format!("echo '{AZURE_REPOSITORY}'"));
    let settings = Settings::default();
    let env = Environment::fixed([]);
    let endpoints = Endpoints::default();
    let child = child_env(&stubs);
    let hosts = hosts(&stubs, &settings, &env, &endpoints, &child);
    let urls = hosts
        .clone_urls("azure-devops", &stubs.dir, "org/proj/repo")
        .await
        .expect("looked up");
    assert_eq!(
        urls,
        CloneUrls {
            name_with_owner: "proj/repo".into(),
            url: "https://org@dev.azure.com/org/proj/_git/repo".into(),
            ssh_url: "git@ssh.dev.azure.com:v3/org/proj/repo".into(),
        }
    );
    hosts
        .create_repository("azure-devops", &stubs.dir, "repo", Visibility::Private)
        .await
        .expect("created");
    assert_eq!(
        stubs.log("az"),
        "argv repos show --detect true --repository repo --project proj --only-show-errors --output json\nargv repos create --detect true --name repo --only-show-errors --output json\n"
    );
}

const BITBUCKET_REPOSITORY: &str = r#"{"full_name":"ws/repo","links":{"html":{"href":"https://bitbucket.org/ws/repo"},"clone":[{"name":"https","href":"https://bitbucket.org/ws/repo.git"},{"name":"ssh","href":"git@bitbucket.org:ws/repo.git"}]}}"#;

#[tokio::test(flavor = "current_thread")]
async fn bitbucket_reads_and_creates_over_the_api() {
    let server = fake::serve(|_| (200, BITBUCKET_REPOSITORY.into())).await;
    let stubs = StubDir::new("bb-repo");
    let settings = Settings::default();
    let base = format!("{}/2.0/", server.base);
    let env = Environment::fixed([
        ("T3CODE_BITBUCKET_API_BASE_URL", base.as_str()),
        ("T3CODE_BITBUCKET_ACCESS_TOKEN", "bb-token"),
    ]);
    let endpoints = Endpoints::default();
    let child = child_env(&stubs);
    let hosts = hosts(&stubs, &settings, &env, &endpoints, &child);
    let urls = hosts
        .clone_urls("bitbucket", &stubs.dir, "ws/repo.git")
        .await
        .expect("looked up");
    assert_eq!(
        urls,
        CloneUrls {
            name_with_owner: "ws/repo".into(),
            url: "https://bitbucket.org/ws/repo.git".into(),
            ssh_url: "git@bitbucket.org:ws/repo.git".into(),
        }
    );
    hosts
        .create_repository("bitbucket", &stubs.dir, "ws/new", Visibility::Private)
        .await
        .expect("created");
    let shape = hosts.clone_urls("bitbucket", &stubs.dir, "repo").await;
    assert_eq!(
        shape.expect_err("no workspace").user_facing.as_deref(),
        Some("Bitbucket repositories must be specified as workspace/repository."),
        "the one host text a client sees"
    );
    let seen = requests(&server);
    assert_eq!(seen.len(), 2, "a bad shape sends nothing");
    let get = seen.first().expect("get");
    assert_eq!(
        (get.method.as_str(), get.path.as_str()),
        ("GET", "/2.0/repositories/ws/repo")
    );
    assert_eq!(header(get, "authorization"), Some("Bearer bb-token"));
    assert_eq!(header(get, "accept"), Some("application/json"));
    let post = seen.get(1).expect("post");
    assert_eq!(
        (post.method.as_str(), post.path.as_str()),
        ("POST", "/2.0/repositories/ws/new")
    );
    assert_eq!(
        post.body, r#"{"scm":"git","is_private":true}"#,
        "T3's key order"
    );
}

#[test]
fn bitbucket_falls_back_from_missing_clone_links() {
    let response = |body: &str| HttpResponse {
        status: 200,
        headers: Vec::new(),
        body: body.as_bytes().to_vec(),
        truncated: false,
    };
    let html_only = bitbucket_urls(&response(
        r#"{"full_name":"ws/r","links":{"html":{"href":"https://bitbucket.org/ws/r"}}}"#,
    ))
    .expect("decodes");
    assert_eq!(html_only.url, "https://bitbucket.org/ws/r");
    assert_eq!(html_only.ssh_url, "https://bitbucket.org/ws/r");
    let bare = bitbucket_urls(&response(r#"{"full_name":"ws/r","links":{}}"#)).expect("decodes");
    assert_eq!((bare.url.as_str(), bare.ssh_url.as_str()), ("ws/r", "ws/r"));
    assert!(bitbucket_urls(&response(r#"{"links":{}}"#)).is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn origin_reads_and_creates_private_repositories() {
    let server = fake::serve(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/v1/origin/namespaces") => (
            200,
            r#"{"namespaces":[{"namespace":{"slug":"team","type":"team"}},{"namespace":{"slug":"me","type":"user"}}]}"#.into(),
        ),
        ("GET", _) => (200, r#"{"name":"repo","owner":{"slug":"me"}}"#.into()),
        ("POST", _) => (200, r#"{"name":"new"}"#.into()),
        _ => (
            200,
            r#"{"name":"new","fullName":"me/new","cloneUrl":"https://origin.cursor.com/me/new.git"}"#.into(),
        ),
    })
    .await;
    let stubs = StubDir::new("origin-repo");
    stubs.executable("origin", &["NO_COLOR"], "echo origin-session");
    let settings = Settings::default();
    let env = Environment::fixed([]);
    let endpoints = Endpoints {
        cursor_origin_api: Some(server.base.clone()),
        ..Endpoints::default()
    };
    let child = child_env(&stubs);
    let hosts = hosts(&stubs, &settings, &env, &endpoints, &child);
    let urls = hosts
        .clone_urls("cursor-origin", &stubs.dir, "me/repo")
        .await
        .expect("looked up");
    assert_eq!(
        urls,
        CloneUrls {
            name_with_owner: "me/repo".into(),
            url: "https://origin.cursor.com/me/repo.git".into(),
            ssh_url: "https://origin.cursor.com/me/repo.git".into(),
        }
    );
    let public = hosts
        .create_repository("cursor-origin", &stubs.dir, "new", Visibility::Public)
        .await;
    assert!(public.is_err(), "Origin repositories are private");
    let created = hosts
        .create_repository("cursor-origin", &stubs.dir, "new", Visibility::Private)
        .await
        .expect("created");
    assert_eq!(created.name_with_owner, "me/new");
    let seen: Vec<(String, String, String)> = requests(&server)
        .iter()
        .map(|r| (r.method.clone(), r.path.clone(), r.body.clone()))
        .collect();
    let row = |m: &str, p: &str, b: &str| (m.to_owned(), p.to_owned(), b.to_owned());
    assert_eq!(
        seen,
        [
            row("GET", "/v1/origin/repos/me/repo", ""),
            row("GET", "/v1/origin/namespaces", ""),
            row("POST", "/v1/origin/repos/me", r#"{"name":"new"}"#),
            row(
                "PATCH",
                "/v1/origin/repos/me/new",
                r#"{"visibility":"private"}"#
            ),
        ]
    );
    let first = requests(&server).into_iter().next().expect("request");
    assert_eq!(
        header(&first, "authorization"),
        Some("Bearer origin-session")
    );
    assert!(
        stubs
            .log("origin")
            .starts_with("argv auth token\n  env NO_COLOR=1\n")
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
    let failure = hosts
        .clone_urls("example", &stubs.dir, "o/r")
        .await
        .expect_err("no driver");
    assert_eq!(
        failure.detail,
        "No example source control provider is registered."
    );
    assert_eq!(failure.user_facing, None);
}
