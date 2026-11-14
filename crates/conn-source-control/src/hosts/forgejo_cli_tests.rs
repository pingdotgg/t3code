//! `ForgejoCli.resolveTarget` and `api` against stub `fj`, `tea` and `git` executables and a fake
//! Forgejo API on loopback. The cases named after a T3 test port
//! `ForgejoSourceControlProvider.test.ts`; the expected argv, paths and bodies are the T3
//! driver's.

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

use super::*;
use crate::{
    discovery::stub::StubDir,
    hosts::{Endpoints, Environment, forgejo::keys_paths},
    http::fake::{self, Recorded},
    settings::Settings,
};

/// A stub folder (the children's whole `PATH`), a home with fj's keys, and a checkout folder.
pub(crate) struct Fixture {
    pub(crate) stubs: StubDir,
    pub(crate) home: PathBuf,
    pub(crate) repo: PathBuf,
    pub(crate) settings: Settings,
    pub(crate) env: Environment,
    pub(crate) endpoints: Endpoints,
    pub(crate) child_env: Vec<(&'static str, OsString)>,
}

impl Fixture {
    pub(crate) fn new(name: &str) -> Self {
        let stubs = StubDir::new(name);
        let home = stubs.dir.join("home");
        let repo = stubs.dir.join("repo");
        std::fs::create_dir_all(&home).expect("home");
        std::fs::create_dir_all(&repo).expect("repo");
        let home = home.canonicalize().expect("canonical home");
        let repo = repo.canonicalize().expect("canonical repo");
        let child_env = vec![
            ("PATH", OsString::from(&stubs.dir)),
            ("HOME", home.clone().into_os_string()),
        ];
        Self {
            stubs,
            home,
            repo,
            settings: Settings::default(),
            env: Environment::fixed(Vec::<(&str, &str)>::new()),
            endpoints: Endpoints::default(),
            child_env,
        }
    }

    pub(crate) fn ctx(&self) -> DiscoveryContext<'_> {
        DiscoveryContext {
            cwd: &self.repo,
            home: Some(&self.home),
            settings: &self.settings,
            env: &self.env,
            endpoints: &self.endpoints,
            child_env: &self.child_env,
        }
    }

    pub(crate) fn write_keys(&self, json: &str) {
        let path = keys_paths(&self.home, None, forgejo::PLATFORM)
            .into_iter()
            .next()
            .expect("a keys path");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("keys dir");
        std::fs::write(path, json).expect("keys");
    }

    /// A stub that records argv, its working folder (`<name>.cwd`) and its stdin
    /// (`<name>.stdin`), then runs `body`.
    pub(crate) fn stub(&self, name: &str, body: &str) {
        let cwd_log = self.stubs.dir.join(format!("{name}.cwd"));
        let stdin_log = self.stubs.dir.join(format!("{name}.stdin"));
        let body = format!(
            "pwd -P >> '{}'\nif [ ! -t 0 ]; then /bin/cat >> '{}'; fi\n{body}",
            cwd_log.display(),
            stdin_log.display()
        );
        self.stubs.executable(name, &["GIT_CONFIG_COUNT"], &body);
    }

    /// Each recorded argv of `name`, without the `argv ` prefix.
    pub(crate) fn argv(&self, name: &str) -> Vec<String> {
        self.stubs
            .log(name)
            .lines()
            .filter_map(|line| line.strip_prefix("argv "))
            .map(str::to_owned)
            .collect()
    }

    pub(crate) fn file(&self, name: &str) -> String {
        std::fs::read_to_string(self.stubs.dir.join(name)).unwrap_or_default()
    }
}

pub(crate) fn requests(server: &fake::FakeServer) -> Vec<Recorded> {
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

pub(crate) const FJ_OK: &str = "case \"$1\" in version) echo 'fj 0.10.0';; *) exit 0;; esac";
pub(crate) const TEA_LOGINS: &str = r#"[{"name":"work","url":"http://forgejo.local:3000","ssh_host":"forgejo.local","user":"maria","default":"true"}]"#;

fn tea_stub(fixture: &Fixture, api_stdout: &str, api_stderr: &str) {
    fixture.stub(
        "tea",
        &format!(
            "if [ \"$1\" = login ]; then printf '%s' '{TEA_LOGINS}'; else printf '%s' '{api_stdout}'; printf '{api_stderr}' >&2; fi"
        ),
    );
}

fn in_path(cwd: &Path) -> String {
    format!("{}\n", cwd.display())
}

// ForgejoSourceControlProvider.test.ts: "reads clone URLs on the given host rather than the
// checkout's". The call names the host, so `git remote -v` is read for that host only.
#[tokio::test(flavor = "current_thread")]
async fn reads_on_the_given_host_rather_than_the_checkouts() {
    let server = fake::serve(|_| {
        (
            200,
            r#"{"full_name":"maria/project","clone_url":"https://forgejo.test/maria/project.git","ssh_url":"git@forgejo.test:maria/project.git"}"#.into(),
        )
    })
    .await;
    let mut fixture = Fixture::new("fj-host");
    fixture.write_keys(
        r#"{"hosts":{"forgejo.test":{"type":"Application","token":"test-token"},"code.example":{"type":"Application","token":"other-token"}}}"#,
    );
    fixture.endpoints.forgejo_api = Some(server.base.clone());
    fixture.stub("fj", FJ_OK);
    fixture.stub(
        "git",
        "printf 'origin\\thttps://code.example/maria/project.git (fetch)\\n'",
    );
    let mut session = Session::new(fixture.ctx());
    let input = Input {
        repository: Some("maria/project"),
        host: Some("forgejo.test"),
        ..Input::default()
    };
    let output = session
        .api(&input, "repos/maria/project", Method::Get, None)
        .await
        .expect("read");
    assert!(
        output
            .stdout
            .contains("https://forgejo.test/maria/project.git")
    );
    let seen = requests(&server);
    assert_eq!(
        seen.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(),
        ["/api/v1/repos/maria/project"]
    );
    assert_eq!(header(&seen[0], "authorization"), Some("token test-token"));
    assert_eq!(fixture.argv("git"), ["remote -v"]);
    assert_eq!(fixture.argv("fj"), ["--host https://forgejo.test whoami"]);
    // fj reads the cwd repository even with --host, so it runs in the home folder.
    assert_eq!(fixture.file("fj.cwd"), in_path(&fixture.home));
}

// ForgejoSourceControlProvider.test.ts: "rejects HTTP failures even when tea exits
// successfully".
#[tokio::test(flavor = "current_thread")]
async fn rejects_http_failures_even_when_tea_exits_successfully() {
    let fixture = Fixture::new("tea-404");
    tea_stub(
        &fixture,
        r#"{"message":"not found"}"#,
        "HTTP/1.1 404 Not Found\\n",
    );
    let mut session = Session::new(fixture.ctx());
    let input = Input {
        repository: Some("http://forgejo.local:3000/maria/project"),
        ..Input::default()
    };
    let error = session
        .api(
            &input,
            "repos/maria/project/pulls/42",
            Method::Patch,
            Some(r#"{"state":"closed"}"#),
        )
        .await
        .expect_err("a 404");
    assert_eq!(
        error.detail,
        "Forgejo repository or pull request was not found."
    );
    assert_eq!(error.http_status, Some(404));
    assert_eq!(error.reason, Some(Reason::NotFound));
    assert_eq!(
        fixture.argv("tea"),
        [
            "login list --output json",
            "api --include --login work --repo maria/project --method PATCH --data @- http://forgejo.local:3000/api/v1/repos/maria/project/pulls/42",
        ]
    );
    assert_eq!(fixture.file("tea.stdin"), r#"{"state":"closed"}"#);
    assert_eq!(fixture.file("tea.cwd"), in_path(&fixture.repo).repeat(2));
}

// ForgejoSourceControlProvider.test.ts: "keeps Gitea's failure reason when tea reports an HTTP
// error".
#[tokio::test(flavor = "current_thread")]
async fn keeps_giteas_failure_reason() {
    let fixture = Fixture::new("tea-405");
    tea_stub(
        &fixture,
        r#"{"message":"The head branch is behind the base branch","url":"http://forgejo.local:3000/api/swagger"}"#,
        "HTTP/1.1 405 Method Not Allowed\\nContent-Type: application/json;charset=utf-8\\n",
    );
    let mut session = Session::new(fixture.ctx());
    let input = Input {
        repository: Some("http://forgejo.local:3000/maria/project"),
        ..Input::default()
    };
    let error = session
        .api(
            &input,
            "repos/maria/project/pulls/1/merge",
            Method::Post,
            Some(r#"{"Do":"merge","delete_branch_after_merge":true}"#),
        )
        .await
        .expect_err("a 405");
    assert!(error.detail.contains("405"), "{}", error.detail);
    assert!(
        error
            .detail
            .contains("The head branch is behind the base branch"),
        "{}",
        error.detail
    );
}

// Derived from `api`: tea without a status line fails; a 2xx passes the body through.
#[tokio::test(flavor = "current_thread")]
async fn tea_needs_a_status_line() {
    let fixture = Fixture::new("tea-status");
    tea_stub(&fixture, "{}", "no status\\n");
    let mut session = Session::new(fixture.ctx());
    let input = Input {
        repository: Some("http://forgejo.local:3000/maria/project"),
        ..Input::default()
    };
    let error = session
        .api(&input, "repos/maria/project", Method::Get, None)
        .await
        .expect_err("no status");
    assert_eq!(
        error.detail,
        "Forgejo API request failed without an HTTP status."
    );
    assert_eq!(tea_status("HTTP/2 201 \nx"), Some(201));
    assert_eq!(tea_status("x\nHTTP/1.1 302 Found\n"), Some(302));
    assert_eq!(tea_status("HTTP/1.1  200"), None);
}

// ForgejoSourceControlProvider.test.ts: "re-sends an fj write with its method and body to a
// renamed repository's path".
#[tokio::test(flavor = "current_thread")]
async fn resends_an_fj_write_to_a_renamed_repositorys_path() {
    let server = fake::serve_with_headers(|r| {
        if r.path.contains("old-name") {
            (
                301,
                vec![(
                    "location".into(),
                    "/api/v1/repos/maria/new-name/issues/42/comments".into(),
                )],
                String::new(),
            )
        } else {
            (201, Vec::new(), "{}".into())
        }
    })
    .await;
    let mut fixture = Fixture::new("fj-rename");
    fixture
        .write_keys(r#"{"hosts":{"forgejo.local":{"type":"Application","token":"test-token"}}}"#);
    fixture.endpoints.forgejo_api = Some(server.base.clone());
    fixture.stub("fj", FJ_OK);
    let mut session = Session::new(fixture.ctx());
    let input = Input {
        repository: Some("https://forgejo.local/maria/old-name"),
        ..Input::default()
    };
    session
        .api(
            &input,
            "repos/maria/old-name/issues/42/comments",
            Method::Post,
            Some(r#"{"body":"only once"}"#),
        )
        .await
        .expect("sent");
    let seen = requests(&server);
    assert_eq!(
        seen.iter()
            .map(|r| (r.method.as_str(), r.path.as_str(), r.body.as_str()))
            .collect::<Vec<_>>(),
        [
            (
                "POST",
                "/api/v1/repos/maria/old-name/issues/42/comments",
                r#"{"body":"only once"}"#
            ),
            (
                "POST",
                "/api/v1/repos/maria/new-name/issues/42/comments",
                r#"{"body":"only once"}"#
            ),
        ]
    );
    for request in &seen {
        assert_eq!(header(request, "authorization"), Some("token test-token"));
        assert_eq!(header(request, "content-type"), Some("application/json"));
    }
}

// ForgejoSourceControlProvider.test.ts: "handles fj mutation statuses without retrying failures
// or reading absent bodies".
#[tokio::test(flavor = "current_thread")]
async fn handles_fj_mutation_statuses_without_retrying() {
    for status in [204u16, 205, 302, 401, 403, 404, 429, 500] {
        let server = fake::serve_with_headers(move |_| {
            (
                status,
                vec![("location".into(), "https://other.local/".into())],
                String::new(),
            )
        })
        .await;
        let mut fixture = Fixture::new("fj-status");
        fixture.write_keys(
            r#"{"hosts":{"forgejo.local":{"type":"Application","token":"test-token"}}}"#,
        );
        fixture.endpoints.forgejo_api = Some(server.base.clone());
        fixture.stub("fj", FJ_OK);
        let mut session = Session::new(fixture.ctx());
        let input = Input {
            repository: Some("https://forgejo.local/maria/project"),
            ..Input::default()
        };
        let result = session
            .api(
                &input,
                "repos/maria/project/issues/42/comments",
                Method::Post,
                Some(r#"{"body":"only once"}"#),
            )
            .await;
        match result {
            Ok(output) => {
                assert!(status < 300, "{status}");
                assert_eq!(output.stdout, "");
            }
            Err(error) => {
                assert!(status >= 300, "{status}");
                assert_eq!(error.command, Program::Fj);
                assert_eq!(error.http_status, Some(status));
            }
        }
        assert_eq!(requests(&server).len(), 1, "{status}: one write");
        // A failed mutation must never switch accounts or CLI.
        assert_eq!(fixture.argv("tea"), Vec::<String>::new());
    }
}

// Derived from `resolveTarget`: the login is verified once per operation; a bare name takes the
// fj account's owner; a name that is not owner/name is refused.
#[tokio::test(flavor = "current_thread")]
async fn resolves_bare_names_through_the_fj_account() {
    let server = fake::serve(|r| match r.path.as_str() {
        "/api/v1/user" => (200, r#"{"login":"maria"}"#.into()),
        _ => (404, String::new()),
    })
    .await;
    let mut fixture = Fixture::new("fj-bare");
    fixture
        .write_keys(r#"{"hosts":{"forgejo.local":{"type":"Application","token":"test-token"}}}"#);
    fixture.endpoints.forgejo_api = Some(server.base.clone());
    fixture.stub("fj", FJ_OK);
    let mut session = Session::new(fixture.ctx());
    let resolved = session
        .resolve_repository(&Input {
            repository: Some("project.git"),
            ..Input::default()
        })
        .await
        .expect("resolved");
    assert_eq!(
        resolved,
        Resolved {
            command: Program::Fj,
            login: "forgejo.local".into(),
            repository: "maria/project".into(),
            base_url: "https://forgejo.local".into(),
        }
    );
    assert_eq!(fixture.argv("fj"), ["--host https://forgejo.local whoami"]);
    let refused = session
        .resolve_repository(&Input {
            repository: Some("maria/a b"),
            ..Input::default()
        })
        .await
        .expect_err("a space");
    assert_eq!(
        refused.detail,
        "Specify a Forgejo repository as owner/repository or its full server URL."
    );
}

// Derived from `resolveTarget`: no fj login and no tea login names the server.
#[tokio::test(flavor = "current_thread")]
async fn no_login_is_an_authentication_failure() {
    let fixture = Fixture::new("no-login");
    fixture.stub("tea", "printf '[]'");
    let error = Session::new(fixture.ctx())
        .resolve_repository(&Input {
            repository: Some("maria/project"),
            ..Input::default()
        })
        .await
        .expect_err("no login");
    assert_eq!(error.reason, Some(Reason::Authentication));
    assert!(error.detail.starts_with("No matching Forgejo login."));
    // Neither CLI installed: tea's absence is the failure.
    let bare = Fixture::new("no-cli");
    let error = Session::new(bare.ctx())
        .resolve_repository(&Input {
            repository: Some("maria/project"),
            ..Input::default()
        })
        .await
        .expect_err("no tea");
    assert_eq!(error.reason, Some(Reason::MissingCli));
}

#[test]
fn parses_remote_lines_and_paths_as_the_regexes_do() {
    assert_eq!(
        fetch_http_url("origin https://code.test/a/b.git (fetch) [blob:none]"),
        Some("https://code.test/a/b.git")
    );
    assert_eq!(fetch_http_url("origin git@code.test:a/b.git (fetch)"), None);
    assert_eq!(
        fetch_http_url("origin https://code.test/a/b.git (push)"),
        None
    );
    assert_eq!(
        without_pulls_suffix("maria/project/pulls/12/files"),
        "maria/project"
    );
    assert_eq!(without_pulls_suffix("maria/pulls/x"), "maria/pulls/x");
    assert!(is_owner_and_name("a/b"));
    assert!(!is_owner_and_name("a/b/c"));
    assert!(!is_owner_and_name("/b"));
    assert_eq!(
        repository_api_path("maria/pro ject"),
        "repos/maria/pro%20ject"
    );
    assert_eq!(
        url_origin("HTTP://Code.Test:80/a/b"),
        Some("http://code.test".into())
    );
}
