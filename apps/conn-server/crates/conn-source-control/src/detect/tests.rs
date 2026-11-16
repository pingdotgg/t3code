//! T3's `SourceControlProviderRegistry.test.ts` cases, on scratch repositories with stub host
//! CLIs. The children's `PATH` is the stub folder and `/usr/bin:/bin` only, so no real `gh`,
//! host CLI can run, and `HOME` is the stub folder.

use std::{ffi::OsString, path::Path, process::Command};

use super::*;
use crate::{
    discovery::stub::StubDir,
    hosts::{Endpoints, Environment},
    settings::Settings,
};

fn child_env(stubs: &StubDir) -> Vec<(&'static str, OsString)> {
    let mut path = OsString::from(&stubs.dir);
    path.push(":/usr/bin:/bin");
    vec![
        ("PATH", path),
        ("HOME", stubs.dir.clone().into_os_string()),
        ("GIT_CONFIG_NOSYSTEM", "1".into()),
        ("XDG_CONFIG_HOME", stubs.dir.join("xdg").into_os_string()),
    ]
}

/// A scratch repository with these remotes.
fn repository(stubs: &StubDir, name: &str, remotes: &[(&str, &str)]) -> std::path::PathBuf {
    let dir = stubs.dir.join(name);
    std::fs::create_dir_all(&dir).expect("repo dir");
    let git = |args: &[&str]| {
        let status = Command::new("/usr/bin/git")
            .args(args)
            .current_dir(&dir)
            .env("HOME", &stubs.dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?}");
    };
    git(&["init", "-q"]);
    for (remote, url) in remotes {
        git(&["remote", "add", remote, url]);
    }
    dir
}

/// A GitHub CLI without a login.
fn quiet_stubs(stubs: &StubDir) {
    stubs.executable("gh", &[], "echo 'not logged in' >&2; exit 1");
}

struct Fixture {
    settings: Settings,
    env: Environment,
    endpoints: Endpoints,
    child_env: Vec<(&'static str, OsString)>,
}

impl Fixture {
    fn new(stubs: &StubDir) -> Self {
        Self {
            settings: Settings::default(),
            env: Environment::fixed([]),
            endpoints: Endpoints::default(),
            child_env: child_env(stubs),
        }
    }

    fn ctx<'a>(&'a self, cwd: &'a Path) -> DiscoveryContext<'a> {
        DiscoveryContext {
            cwd,
            home: None,
            settings: &self.settings,
            env: &self.env,
            endpoints: &self.endpoints,
            child_env: &self.child_env,
        }
    }
}

fn unknown_context(remote_url: &str) -> ProviderContext {
    ProviderContext {
        provider: ProviderInfo {
            kind: "unknown".into(),
            name: "git.example.internal".into(),
            base_url: "https://git.example.internal".into(),
        },
        remote_name: "origin".into(),
        remote_url: remote_url.into(),
        requested_host: None,
    }
}

#[tokio::test(flavor = "current_thread")]
async fn routes_an_unknown_remote_to_the_integration_that_claims_its_server() {
    let stubs = StubDir::new("detect-claim");
    stubs.executable("gh", &[], "echo token");
    let repo = repository(
        &stubs,
        "repo",
        &[("origin", "git@self-hosted.example.test:group/project.git")],
    );
    let fixture = Fixture::new(&stubs);
    let context = Detector::default()
        .resolve(fixture.ctx(&stubs.dir), &repo, None)
        .await
        .expect("detected")
        .expect("context");
    assert_eq!(
        context.provider,
        ProviderInfo {
            kind: "github".into(),
            name: "GitHub Self-Hosted".into(),
            base_url: "https://self-hosted.example.test".into()
        }
    );
    assert_eq!(
        stubs.log("gh"),
        "argv auth token --hostname self-hosted.example.test\n"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn leaves_a_remote_no_integration_claims_unknown_with_its_servers_address() {
    let stubs = StubDir::new("detect-unknown");
    quiet_stubs(&stubs);
    let repo = repository(
        &stubs,
        "repo",
        &[("origin", "git@code.example.test:team/project.git")],
    );
    let fixture = Fixture::new(&stubs);
    let context = Detector::default()
        .resolve(fixture.ctx(&stubs.dir), &repo, None)
        .await
        .expect("detected")
        .expect("a context");
    assert_eq!(context.provider.kind, "unknown", "unknown");
    assert_eq!(
        context.provider.base_url, "https://code.example.test",
        "its address"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn reads_the_host_of_an_ssh_remote_that_leaves_its_user_to_ssh_config() {
    let stubs = StubDir::new("detect-userless");
    quiet_stubs(&stubs);
    let fixture = Fixture::new(&stubs);
    for (index, (url, expected)) in [
        ("github.com:team/project.git", "github"),
        ("gitlab.com:team/project.git", "unknown"),
        ("bitbucket.org:team/project.git", "unknown"),
        ("code.example.test:team/project.git", "unknown"),
    ]
    .into_iter()
    .enumerate()
    {
        let repo = repository(&stubs, &format!("r{index}"), &[("origin", url)]);
        let context = Detector::default()
            .resolve(fixture.ctx(&stubs.dir), &repo, None)
            .await
            .expect("detected")
            .expect("a context");
        assert_eq!(context.provider.kind, expected, "{url}");
        assert_eq!(context.remote_url, url, "{url}");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn refines_the_caller_selected_remote_instead_of_another_configured_remote() {
    let stubs = StubDir::new("detect-selected");
    quiet_stubs(&stubs);
    stubs.executable("gh", &[], "echo token");
    let repo = repository(
        &stubs,
        "repo",
        &[("origin", "git@github.com:fork/project.git")],
    );
    let fixture = Fixture::new(&stubs);
    let selected = ProviderContext {
        provider: ProviderInfo {
            kind: "unknown".into(),
            name: "self-hosted.example.test".into(),
            base_url: "https://self-hosted.example.test".into(),
        },
        remote_name: "upstream".into(),
        remote_url: "https://self-hosted.example.test/group/project.git".into(),
        requested_host: None,
    };
    let context = Detector::default()
        .resolve(fixture.ctx(&stubs.dir), &repo, Some(selected))
        .await
        .expect("refined")
        .expect("a context");
    assert_eq!(context.provider.kind, "github", "claimed");
    assert_eq!(context.remote_name, "upstream", "the caller's remote");
}

#[tokio::test(flavor = "current_thread")]
async fn falls_back_to_a_non_origin_remote_when_origin_is_not_configured() {
    let stubs = StubDir::new("detect-fallback");
    quiet_stubs(&stubs);
    let repo = repository(
        &stubs,
        "repo",
        &[("upstream", "https://dev.azure.com/acme/project/_git/repo")],
    );
    let fixture = Fixture::new(&stubs);
    let context = Detector::default()
        .resolve(fixture.ctx(&stubs.dir), &repo, None)
        .await
        .expect("detected")
        .expect("a context");
    assert_eq!(context.provider.kind, "unknown", "unclaimed");
    assert_eq!(
        stubs.log("gh"),
        "argv auth token --hostname dev.azure.com\n"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn does_not_refine_a_context_whose_server_address_is_empty() {
    let stubs = StubDir::new("detect-empty");
    // A gh signed in to every host would claim it, if asked.
    stubs.executable("gh", &[], "echo token");
    let fixture = Fixture::new(&stubs);
    let mut context = unknown_context("git@githubenterprise.dev.example.com:team/workspace.git");
    context.provider.base_url = String::new();
    let refined = Detector::default()
        .resolve(fixture.ctx(&stubs.dir), &stubs.dir, Some(context.clone()))
        .await
        .expect("refined");
    assert_eq!(refined, Some(context), "unchanged");
}

#[tokio::test(flavor = "current_thread")]
async fn asks_once_for_every_checkout_of_a_server_no_integration_claims() {
    let stubs = StubDir::new("detect-once");
    quiet_stubs(&stubs);
    let fixture = Fixture::new(&stubs);
    let detector = Detector::default();
    let resolve = |repository: &'static str| {
        let context = unknown_context(&format!("git@Git.Example.Internal:team/{repository}.git"));
        detector.resolve(fixture.ctx(&stubs.dir), &stubs.dir, Some(context))
    };
    let (a, b, c) = tokio::join!(resolve("a"), resolve("b"), resolve("c"));
    for answer in [a, b, c] {
        let kind = answer.expect("refined").map(|c| c.provider.kind);
        assert_eq!(kind.as_deref(), Some("unknown"), "unclaimed");
    }
    resolve("d").await.expect("refined");
    assert_eq!(stubs.log("gh").lines().count(), 1, "one gh call");
    detector.settings_changed();
    resolve("a").await.expect("refined");
    assert_eq!(
        stubs.log("gh").lines().count(),
        2,
        "asked again after settings change"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn asks_again_after_a_check_that_could_not_answer() {
    let stubs = StubDir::new("detect-unanswered");
    quiet_stubs(&stubs);
    // An unresolved GitHub credential does not settle the lookup.
    let mut fixture = Fixture::new(&stubs);
    fixture.settings = Settings::new(serde_json::from_value(serde_json::json!({
        "sourceControlHosts": {"github": {"tokens": {"git.example.internal": {"provider":"missing", "reference":"token"}}}}
    })).expect("settings"));
    let detector = Detector::default();
    for repository in ["a", "b"] {
        let context = unknown_context(&format!("git@git.example.internal:team/{repository}.git"));
        detector
            .resolve(fixture.ctx(&stubs.dir), &stubs.dir, Some(context))
            .await
            .expect("refined");
    }
    fixture.settings = Settings::default();
    stubs.executable("gh", &[], "echo token");
    let answer = detector
        .resolve(
            fixture.ctx(&stubs.dir),
            &stubs.dir,
            Some(unknown_context("git@git.example.internal:team/c.git")),
        )
        .await
        .expect("resolved")
        .expect("context");
    assert_eq!(
        answer.provider.kind, "github",
        "an unanswered lookup is retried"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_folder_that_is_no_repository_fails_detection() {
    let stubs = StubDir::new("detect-none");
    quiet_stubs(&stubs);
    let fixture = Fixture::new(&stubs);
    let outside = stubs.dir.join("plain");
    std::fs::create_dir_all(&outside).expect("dir");
    // `GIT_CEILING_DIRECTORIES` keeps git from finding a repository above the temp folder.
    let mut fixture = fixture;
    fixture.child_env.push((
        "GIT_CEILING_DIRECTORIES",
        stubs.dir.clone().into_os_string(),
    ));
    let answer = Detector::default()
        .resolve(fixture.ctx(&stubs.dir), &outside, None)
        .await;
    assert_eq!(answer, Err(DetectError), "T3's detectProvider error");
}

#[test]
fn remote_verbose_output_is_read_as_git_writes_it() {
    let remotes = parse_remote_verbose(
        "origin\thttps://h/o/r.git (fetch)\norigin\tgit@h:o/r.git (push)\n\
         part\thttps://h/x (fetch) [blob:none]\nbad line\nup\tu (push)\n",
    );
    assert_eq!(remotes.len(), 2, "remotes with a fetch URL");
    assert_eq!(
        remotes[0].push_url.as_deref(),
        Some("git@h:o/r.git"),
        "push URL"
    );
    assert_eq!(remotes[1].url, "https://h/x", "promisor filter dropped");
}

#[test]
fn the_unknown_remote_key_names_the_server_not_the_repository() {
    assert_eq!(
        strip_repository("git@h.example:team/a.git"),
        "git@h.example:",
        "scp"
    );
    assert_eq!(
        strip_repository("https://h.example/team/a.git"),
        "https://h.example/",
        "url"
    );
    assert_eq!(
        strip_repository("https://h.example/a"),
        "https://h.example/a",
        "authority kept"
    );
    assert_eq!(
        strip_repository("https://h.example/m/team/a/"),
        "https://h.example/m/",
        "mount"
    );
}
