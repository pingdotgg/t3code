//! The cases of `SourceControlRepositoryService.test.ts`, on scratch repositories. Real `git`
//! runs against local bare repositories; a stub `git` stands in where git must fail (an SSH
//! refusal, a slow clone). No test reaches a network host.

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Mutex,
};

use conn_contract::{
    ProjectCloneStartInputProtocol as Protocol, SourceControlCloneRepositoryInput,
    SourceControlPublishRepositoryInput, SourceControlPublishStatus,
    SourceControlRepositoryLookupInput, SourceControlRepositoryVisibility,
};

use super::*;
use crate::discovery::stub::StubDir;

/// A host that answers from fixed clone URLs and records what it was asked.
#[derive(Debug, Default)]
struct FakeHosts {
    urls: Option<CloneUrls>,
    failure: Option<HostFailure>,
    calls: Mutex<Vec<String>>,
}

impl FakeHosts {
    fn answering(urls: CloneUrls) -> Self {
        Self {
            urls: Some(urls),
            ..Self::default()
        }
    }

    fn answer(&self, call: String) -> HostResult<CloneUrls> {
        if let Ok(mut calls) = self.calls.lock() {
            calls.push(call);
        }
        match (&self.failure, &self.urls) {
            (Some(failure), _) => Err(failure.clone()),
            (None, Some(urls)) => Ok(urls.clone()),
            (None, None) => Err(HostFailure::new("no answer")),
        }
    }
}

impl RepositoryHosts for FakeHosts {
    async fn clone_urls(&self, kind: &str, cwd: &Path, repository: &str) -> HostResult<CloneUrls> {
        self.answer(format!("lookup {kind} {repository} in {}", cwd.display()))
    }

    async fn create_repository(
        &self,
        kind: &str,
        _cwd: &Path,
        repository: &str,
        visibility: SourceControlRepositoryVisibility,
    ) -> HostResult<CloneUrls> {
        self.answer(format!("create {kind} {repository} {visibility:?}"))
    }
}

/// A scratch folder with a `HOME` of its own, so no git setting of this machine is read.
#[derive(Debug)]
struct Scratch {
    root: PathBuf,
    env: Vec<(&'static str, OsString)>,
}

impl Scratch {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "conn-sc-repo-{name}-{}-{}",
            std::process::id(),
            uuid_like()
        ));
        std::fs::create_dir_all(root.join("home")).expect("home");
        let env = vec![
            ("HOME", root.join("home").into_os_string()),
            ("GIT_CONFIG_NOSYSTEM", "1".into()),
            ("GIT_AUTHOR_NAME", "T3".into()),
            ("GIT_AUTHOR_EMAIL", "t3@example.invalid".into()),
            ("GIT_COMMITTER_NAME", "T3".into()),
            ("GIT_COMMITTER_EMAIL", "t3@example.invalid".into()),
        ];
        Self { root, env }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    fn ctx(&self) -> ServiceContext<'_> {
        ServiceContext {
            server_cwd: &self.root,
            process_cwd: &self.root,
            home: None,
            child_env: &self.env,
            clone_timeout: CLONE_TIMEOUT,
        }
    }

    fn git(&self, cwd: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(["-c", "init.defaultBranch=main"])
            .args(args)
            .current_dir(cwd)
            .envs(self.env.iter().map(|(k, v)| (*k, v)))
            .output()
            .expect("git");
        assert!(output.status.success(), "git {args:?}: {output:?}");
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    /// A bare repository with one commit on `main`.
    fn bare_with_commit(&self, name: &str) -> PathBuf {
        let work = self.path(&format!("{name}-work"));
        std::fs::create_dir_all(&work).expect("work");
        self.git(&work, &["init"]);
        std::fs::write(work.join("README.md"), "hello\n").expect("file");
        self.git(&work, &["add", "README.md"]);
        self.git(&work, &["commit", "-m", "first"]);
        let bare = self.path(&format!("{name}.git"));
        self.git(
            &self.root,
            &[
                "clone",
                "--bare",
                &work.to_string_lossy(),
                &bare.to_string_lossy(),
            ],
        );
        bare
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn uuid_like() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

fn urls(url: &str, ssh_url: &str) -> CloneUrls {
    CloneUrls {
        name_with_owner: "octocat/t3code".into(),
        url: url.into(),
        ssh_url: ssh_url.into(),
    }
}

fn clone_input(destination: &Path) -> SourceControlCloneRepositoryInput {
    SourceControlCloneRepositoryInput {
        provider: None,
        repository: None,
        remote_url: None,
        destination_path: destination.to_string_lossy().into_owned(),
        protocol: None,
    }
}

/// The real `git` for a stub to hand over to.
fn real_git() -> String {
    let output = std::process::Command::new("sh")
        .args(["-c", "command -v git"])
        .output()
        .expect("sh");
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// A stub `git` first on `PATH`, after the scratch environment.
fn with_stub(scratch: &Scratch, stubs: &StubDir) -> Vec<(&'static str, OsString)> {
    let mut env = scratch.env.clone();
    env.extend(stubs.path_env());
    env
}

#[tokio::test(flavor = "current_thread")]
async fn tells_the_user_a_hosts_fixed_explanation_of_a_failed_lookup() {
    let scratch = Scratch::new("lookup");
    let input = SourceControlRepositoryLookupInput {
        provider: "bitbucket".into(),
        repository: "x".into(),
        cwd: None,
    };
    let fixed = FakeHosts {
        failure: Some(HostFailure::user_facing(
            "Repositories are named workspace/repository.",
        )),
        ..FakeHosts::default()
    };
    let error = lookup(&fixed, scratch.ctx(), &input)
        .await
        .expect_err("fails");
    assert_eq!(error.detail, "Repositories are named workspace/repository.");
    assert_eq!(error.operation, "lookupRepository");

    // "keeps a host's raw response text out of a failed repository lookup"
    let raw = FakeHosts {
        failure: Some(HostFailure::new("<html>internal token=abc</html>")),
        ..FakeHosts::default()
    };
    let error = lookup(&raw, scratch.ctx(), &input)
        .await
        .expect_err("fails");
    assert_eq!(
        error.detail,
        "The source control operation could not be completed."
    );

    let unknown = SourceControlRepositoryLookupInput {
        provider: "unknown".into(),
        ..input
    };
    let error = lookup(&raw, scratch.ctx(), &unknown)
        .await
        .expect_err("fails");
    assert_eq!(
        error.detail,
        "Choose a source control provider before continuing."
    );
    assert!(
        raw.calls.lock().map(|c| c.len()).unwrap_or(0) == 1,
        "unknown asks no host"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn clones_a_looked_up_repository_after_creating_missing_parents() {
    let scratch = Scratch::new("clone");
    let bare = scratch.bare_with_commit("origin");
    let hosts = FakeHosts::answering(urls(&bare.to_string_lossy(), "git@example.invalid:o/r.git"));
    let destination = scratch.path("nested/deeper/t3code");
    let input = SourceControlCloneRepositoryInput {
        provider: Some("github".into()),
        repository: Some("octocat/t3code".into()),
        protocol: Some(Protocol::Https),
        ..clone_input(&destination)
    };
    let result = clone(&hosts, scratch.ctx(), &input).await.expect("clones");
    assert_eq!(result.cwd, destination.to_string_lossy());
    assert_eq!(result.remote_url, bare.to_string_lossy());
    let repository = result.repository.expect("repository");
    assert_eq!(repository.provider, "github");
    assert_eq!(repository.name_with_owner, "octocat/t3code");
    assert!(destination.join("README.md").is_file(), "checked out");
    let calls = hosts.calls.lock().map(|c| c.clone()).unwrap_or_default();
    assert_eq!(
        calls,
        [format!(
            "lookup github octocat/t3code in {}",
            scratch.path("nested/deeper").display()
        )],
        "looked up in the destination's parent"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn keeps_gits_error_text_and_refuses_a_used_destination() {
    let scratch = Scratch::new("clone-fail");
    let hosts = FakeHosts::default();
    let input = SourceControlCloneRepositoryInput {
        remote_url: Some(scratch.path("missing.git").to_string_lossy().into_owned()),
        ..clone_input(&scratch.path("target"))
    };
    let error = clone(&hosts, scratch.ctx(), &input)
        .await
        .expect_err("fails");
    assert!(
        error.detail.contains("does not exist") || error.detail.contains("does not appear"),
        "git's own last lines: {}",
        error.detail
    );
    assert_eq!(error.provider, "unknown");

    std::fs::create_dir_all(scratch.path("used")).expect("dir");
    std::fs::write(scratch.path("used/file"), "x").expect("file");
    let used = SourceControlCloneRepositoryInput {
        remote_url: Some("https://example.invalid/o/r".into()),
        ..clone_input(&scratch.path("used"))
    };
    let error = clone(&hosts, scratch.ctx(), &used)
        .await
        .expect_err("fails");
    assert_eq!(
        error.detail,
        "Destination path already exists and is not empty."
    );
    let file = SourceControlCloneRepositoryInput {
        remote_url: Some("https://example.invalid/o/r".into()),
        ..clone_input(&scratch.path("used/file"))
    };
    let error = clone(&hosts, scratch.ctx(), &file)
        .await
        .expect_err("fails");
    assert_eq!(
        error.detail,
        "Destination path already exists and is not a directory."
    );
    let nothing = clone_input(&scratch.path("empty"));
    let error = clone(&hosts, scratch.ctx(), &nothing)
        .await
        .expect_err("fails");
    assert_eq!(
        error.detail,
        "Enter a repository path or clone URL before cloning."
    );
}

#[tokio::test(flavor = "current_thread")]
async fn says_a_clone_that_ran_out_of_time_timed_out() {
    let scratch = Scratch::new("clone-slow");
    let stubs = StubDir::new("git-slow");
    stubs.executable(
        "git",
        &[],
        "echo 'remote: still thinking' >&2\nexec sleep 30",
    );
    let env = with_stub(&scratch, &stubs);
    let ctx = ServiceContext {
        child_env: &env,
        clone_timeout: Duration::from_millis(300),
        ..scratch.ctx()
    };
    let input = SourceControlCloneRepositoryInput {
        remote_url: Some("https://example.invalid/o/r".into()),
        ..clone_input(&scratch.path("slow"))
    };
    let error = clone(&FakeHosts::default(), ctx, &input)
        .await
        .expect_err("times out");
    assert_eq!(error.detail, "The clone timed out after 300ms.");
    assert_eq!(
        format_duration(CLONE_TIMEOUT),
        "2m",
        "T3's text for the default"
    );
}

/// A stub `git` that refuses an SSH clone (or every clone), records argv, and makes the
/// destination for an HTTPS one.
fn refusing_git(stubs: &StubDir, refuse_https: bool) {
    let https = if refuse_https {
        "echo \"fatal: unable to access '$4?token=secret': The requested URL returned error: 403\" >&2; exit 128"
    } else {
        "mkdir -p \"$5\"; exit 0"
    };
    stubs.executable(
        "git",
        &["GIT_TERMINAL_PROMPT", "LANGUAGE", "GIT_PROGRESS_DELAY", "LC_ALL"],
        &format!(
            "case \"$4\" in\n  git@*) echo 'Cloning into x...' >&2; echo 'git@github.com: Permission denied (publickey).' >&2; echo 'fatal: Could not read from remote repository.' >&2; exit 128;;\n  *) {https};;\nesac"
        ),
    );
}

#[tokio::test(flavor = "current_thread")]
async fn retries_a_clone_over_https_when_the_ssh_login_is_refused() {
    let scratch = Scratch::new("clone-ssh");
    let stubs = StubDir::new("git-ssh");
    refusing_git(&stubs, false);
    let env = with_stub(&scratch, &stubs);
    let ctx = ServiceContext {
        child_env: &env,
        ..scratch.ctx()
    };
    let hosts = FakeHosts::answering(urls(
        "https://github.com/octocat/t3code",
        "git@github.com:octocat/t3code.git",
    ));
    let input = SourceControlCloneRepositoryInput {
        provider: Some("github".into()),
        repository: Some("octocat/t3code".into()),
        ..clone_input(&scratch.path("t3code"))
    };
    let result = clone(&hosts, ctx, &input).await.expect("https clone");
    assert_eq!(result.remote_url, "https://github.com/octocat/t3code");
    assert_eq!(
        stubs.log("git"),
        "argv clone --progress -- git@github.com:octocat/t3code.git t3code\n  env GIT_TERMINAL_PROMPT=0\n  env LANGUAGE=C\n  env GIT_PROGRESS_DELAY=0\n  env LC_ALL=<unset>\nargv clone --progress -- https://github.com/octocat/t3code t3code\n  env GIT_TERMINAL_PROMPT=0\n  env LANGUAGE=C\n  env GIT_PROGRESS_DELAY=0\n  env LC_ALL=<unset>\n",
        "argv and CLONE_ENV as T3 runs them; the locale is left alone"
    );

    // "reports both failures when the HTTPS retry fails too"
    let stubs = StubDir::new("git-ssh-both");
    refusing_git(&stubs, true);
    let env = with_stub(&scratch, &stubs);
    let ctx = ServiceContext {
        child_env: &env,
        ..scratch.ctx()
    };
    let input = SourceControlCloneRepositoryInput {
        provider: Some("github".into()),
        repository: Some("octocat/t3code".into()),
        ..clone_input(&scratch.path("again"))
    };
    let error = clone(&hosts, ctx, &input).await.expect_err("both fail");
    assert_eq!(
        error.detail,
        "git@github.com: Permission denied (publickey). fatal: Could not read from remote repository. Cloning over HTTPS instead also failed: fatal: unable to access 'https://github.com/octocat/t3code': The requested URL returned error: 403",
        "both texts, the query token redacted"
    );

    // An explicit SSH request never falls back.
    let input = SourceControlCloneRepositoryInput {
        protocol: Some(Protocol::Ssh),
        provider: Some("github".into()),
        repository: Some("octocat/t3code".into()),
        ..clone_input(&scratch.path("ssh-only"))
    };
    let error = clone(&hosts, ctx, &input).await.expect_err("ssh only");
    assert!(!error.detail.contains("HTTPS"), "{}", error.detail);
}

#[tokio::test(flavor = "current_thread")]
async fn strips_embedded_credentials_from_the_remote_url_it_reports() {
    let scratch = Scratch::new("clone-creds");
    let stubs = StubDir::new("git-creds");
    refusing_git(&stubs, false);
    let env = with_stub(&scratch, &stubs);
    let ctx = ServiceContext {
        child_env: &env,
        ..scratch.ctx()
    };
    let input = SourceControlCloneRepositoryInput {
        remote_url: Some("https://user:secret@example.invalid/o/r.git".into()),
        ..clone_input(&scratch.path("creds"))
    };
    let result = clone(&FakeHosts::default(), ctx, &input)
        .await
        .expect("clones");
    assert_eq!(result.remote_url, "https://example.invalid/o/r.git");
    assert!(
        stubs
            .log("git")
            .contains("https://user:secret@example.invalid/o/r.git"),
        "git still gets the credentials"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn publishes_and_records_the_upstream() {
    let scratch = Scratch::new("publish");
    let bare = scratch.bare_with_commit("seed");
    let empty_bare = scratch.path("published.git");
    scratch.git(
        &scratch.root,
        &["init", "--bare", &empty_bare.to_string_lossy()],
    );
    let work = scratch.path("work");
    scratch.git(
        &scratch.root,
        &["clone", &bare.to_string_lossy(), &work.to_string_lossy()],
    );
    scratch.git(&work, &["checkout", "-b", "feature/remote-v1"]);
    let hosts = FakeHosts::answering(urls(
        "https://example.invalid/o/r",
        &empty_bare.to_string_lossy(),
    ));
    let input = SourceControlPublishRepositoryInput {
        cwd: work.to_string_lossy().into_owned(),
        provider: "github".into(),
        repository: "octocat/t3code".into(),
        visibility: SourceControlRepositoryVisibility::Private,
        remote_name: None,
        protocol: None,
    };
    let result = publish(&hosts, scratch.ctx(), &input)
        .await
        .expect("publishes");
    assert_eq!(result.status, SourceControlPublishStatus::Pushed);
    assert_eq!(
        result.remote_name, "origin-1",
        "origin is taken by another repository"
    );
    assert_eq!(result.branch, "feature/remote-v1");
    assert_eq!(result.remote_url, empty_bare.to_string_lossy());
    assert_eq!(
        scratch.git(&empty_bare, &["rev-parse", "refs/heads/feature/remote-v1"]),
        scratch.git(&work, &["rev-parse", "HEAD"]),
        "pushed"
    );
    assert_eq!(
        scratch.git(&work, &["config", "branch.feature/remote-v1.remote"]),
        "origin-1"
    );
    assert_eq!(
        scratch.git(&work, &["config", "branch.feature/remote-v1.merge"]),
        "refs/heads/feature/remote-v1"
    );

    // A second publish to the same repository reuses the remote that points at it.
    let again = publish(&hosts, scratch.ctx(), &input).await.expect("again");
    assert_eq!(again.remote_name, "origin-1");
}

#[tokio::test(flavor = "current_thread")]
async fn publish_without_commits_only_adds_the_remote() {
    let scratch = Scratch::new("publish-empty");
    let work = scratch.path("fresh");
    std::fs::create_dir_all(&work).expect("dir");
    scratch.git(&work, &["init"]);
    let hosts = FakeHosts::answering(urls(
        "https://example.invalid/o/r",
        "git@example.invalid:o/r.git",
    ));
    let input = SourceControlPublishRepositoryInput {
        cwd: work.to_string_lossy().into_owned(),
        provider: "gitlab".into(),
        repository: "group/project".into(),
        visibility: SourceControlRepositoryVisibility::Public,
        remote_name: Some("  ".into()),
        protocol: Some(Protocol::Https),
    };
    let result = publish(&hosts, scratch.ctx(), &input).await.expect("adds");
    assert_eq!(result.status, SourceControlPublishStatus::RemoteAdded);
    assert_eq!(result.branch, "main");
    assert_eq!(result.remote_name, "origin");
    assert_eq!(result.remote_url, "https://example.invalid/o/r");
    assert_eq!(
        scratch.git(&work, &["remote", "get-url", "origin"]),
        "https://example.invalid/o/r"
    );
    assert_eq!(
        hosts.calls.lock().map(|c| c.clone()).unwrap_or_default(),
        ["create gitlab group/project Public"]
    );
}

/// A stub `git` that refuses every push over SSH and hands the rest to the real git.
fn ssh_refusing_push(stubs: &StubDir) {
    let real = real_git();
    stubs.executable(
        "git",
        &[],
        &format!(
            "if [ \"$1\" = push ]; then url=$('{real}' remote get-url \"$3\"); case \"$url\" in git@*) echo 'git@example.invalid: Permission denied (publickey).' >&2; exit 128;; esac; fi\nexec '{real}' \"$@\""
        ),
    );
}

#[tokio::test(flavor = "current_thread")]
async fn explains_or_recovers_from_a_rejected_ssh_push() {
    let scratch = Scratch::new("publish-ssh");
    let stubs = StubDir::new("git-push");
    ssh_refusing_push(&stubs);
    let env = with_stub(&scratch, &stubs);
    let ctx = ServiceContext {
        child_env: &env,
        ..scratch.ctx()
    };
    let bare = scratch.bare_with_commit("seed");
    let target = scratch.path("target.git");
    scratch.git(
        &scratch.root,
        &["init", "--bare", &target.to_string_lossy()],
    );
    let hosts = FakeHosts::answering(urls(
        &target.to_string_lossy(),
        "git@example.invalid:o/r.git",
    ));

    // "explains a rejected SSH push after creating the repository"
    let work = scratch.path("explicit");
    scratch.git(
        &scratch.root,
        &["clone", &bare.to_string_lossy(), &work.to_string_lossy()],
    );
    scratch.git(&work, &["remote", "remove", "origin"]);
    let explicit = SourceControlPublishRepositoryInput {
        cwd: work.to_string_lossy().into_owned(),
        provider: "github".into(),
        repository: "octocat/t3code".into(),
        visibility: SourceControlRepositoryVisibility::Private,
        remote_name: None,
        protocol: Some(Protocol::Ssh),
    };
    let error = publish(&hosts, ctx, &explicit).await.expect_err("refused");
    assert_eq!(
        error.detail,
        format!(
            "Created octocat/t3code and added it as remote \"origin\", but the push failed because SSH authentication was rejected. Add an SSH key to your account, or switch the remote to HTTPS with \"git remote set-url origin {}\", then push again.",
            target.display()
        )
    );

    // "switches an auto-selected remote to HTTPS when the SSH push is refused"
    let work = scratch.path("auto");
    scratch.git(
        &scratch.root,
        &["clone", &bare.to_string_lossy(), &work.to_string_lossy()],
    );
    scratch.git(&work, &["remote", "remove", "origin"]);
    let auto = SourceControlPublishRepositoryInput {
        cwd: work.to_string_lossy().into_owned(),
        protocol: None,
        ..explicit
    };
    let result = publish(&hosts, ctx, &auto).await.expect("switched");
    assert_eq!(result.remote_url, target.to_string_lossy());
    assert_eq!(
        scratch.git(&work, &["remote", "get-url", "origin"]),
        target.to_string_lossy()
    );
    assert_eq!(result.status, SourceControlPublishStatus::Pushed);
}

#[tokio::test(flavor = "current_thread")]
async fn says_the_repository_exists_when_an_unclassified_push_fails() {
    let scratch = Scratch::new("publish-other");
    let bare = scratch.bare_with_commit("seed");
    let work = scratch.path("work");
    scratch.git(
        &scratch.root,
        &["clone", &bare.to_string_lossy(), &work.to_string_lossy()],
    );
    scratch.git(&work, &["remote", "remove", "origin"]);
    let missing = scratch.path("not-a-repo");
    let hosts = FakeHosts::answering(urls(
        "https://example.invalid/o/r",
        &missing.to_string_lossy(),
    ));
    let input = SourceControlPublishRepositoryInput {
        cwd: work.to_string_lossy().into_owned(),
        provider: "github".into(),
        repository: "octocat/t3code".into(),
        visibility: SourceControlRepositoryVisibility::Private,
        remote_name: None,
        protocol: None,
    };
    let error = publish(&hosts, scratch.ctx(), &input)
        .await
        .expect_err("fails");
    assert_eq!(
        error.detail,
        "Created octocat/t3code and added it as remote \"origin\", but the push failed. Fix the problem, then push again."
    );
}

#[test]
fn parses_remotes_and_names_like_t3() {
    assert_eq!(
        remote_fetch_urls(
            "origin\thttps://h/o/r (fetch)\norigin\thttps://h/o/r (push)\nfork\tgit@h:x/y.git (fetch) [blob:none]\n"
        ),
        [
            ("origin".to_owned(), "https://h/o/r".to_owned()),
            ("fork".to_owned(), "git@h:x/y.git".to_owned())
        ]
    );
    assert_eq!(sanitize_remote_name(" my fork! "), "my-fork");
    assert_eq!(sanitize_remote_name("***"), "fork");
}

#[test]
fn splits_stderr_on_every_line_end() {
    let mut stderr = CloneStderr::default();
    stderr.feed(b"Cloning into 'x'...\nReceiving objects:  50% (1/2)\rReceiving objects: 100% (2/2), done.\r", false);
    stderr.feed(
        b"\nfatal: one\r\nfatal: two\nerror: three\nwarning: four\nlast without end",
        true,
    );
    assert_eq!(
        stderr.tail,
        [
            "fatal: two",
            "error: three",
            "warning: four",
            "last without end"
        ]
    );
}
