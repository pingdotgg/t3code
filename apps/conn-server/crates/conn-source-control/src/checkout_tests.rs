use super::*;
use crate::{
    discovery::stub::StubDir,
    hosts::{Endpoints, Environment},
    settings::Settings,
};
use conn_vcs::naming::{branch_fragment, worktree_branch};

#[tokio::test(flavor = "current_thread")]
async fn resolves_numbers_and_urls_and_reports_no_login() {
    let stub = StubDir::new("pr-resolve");
    let response = r#"{"data":{"repository":{"pullRequest":{"number":42,"title":"Fix checkout","url":"https://github.com/acme/web/pull/42","baseRefName":"main","headRefName":"fix","headRefOid":"abcdef1234567890","state":"OPEN","isCrossRepository":false,"headRepository":{"nameWithOwner":"acme/web"},"headRepositoryOwner":{"login":"acme"}}}}}"#;
    stub.executable(
        "gh",
        &[],
        &format!(
            "case \"$1\" in auth) printf token ;; api) cat >/dev/null; printf '%s' '{}' ;; esac",
            response
        ),
    );
    let settings = Settings::default();
    let env = Environment::fixed([("GH_REPO", "acme/web")]);
    let endpoints = Endpoints::default();
    let child = stub.path_env();
    let ctx = DiscoveryContext {
        cwd: &stub.dir,
        home: None,
        settings: &settings,
        env: &env,
        endpoints: &endpoints,
        child_env: &child,
    };
    for reference in [" #42 ", "https://github.com/acme/web/pull/42"] {
        let pr = resolve(ctx, &stub.dir, reference).await.unwrap();
        assert_eq!(pr.resolved.number, 42);
        assert_eq!(pr.resolved.head_branch, "fix");
    }
    let log = std::fs::read_to_string(stub.dir.join("gh.log")).unwrap();
    assert!(
        log.contains("api graphql --hostname github.com --input -"),
        "{log}"
    );
    stub.executable("gh",&[],"case \"$1\" in auth) printf token ;; api) cat >/dev/null; printf '%s' '{\"data\":{\"repository\":{\"pullRequest\":null}}}' ;; esac");
    assert!(
        resolve(ctx, &stub.dir, "42")
            .await
            .unwrap_err()
            .detail
            .starts_with("Pull request not found.")
    );
    stub.executable(
        "gh",
        &[],
        "case \"$1\" in auth) printf token ;; api) printf 'HTTP 404' >&2; exit 1 ;; esac",
    );
    assert_eq!(
        github::api_json(
            ctx,
            &stub.dir,
            "github.com",
            "repos/acme/missing",
            None,
            "Repository missing."
        )
        .await
        .unwrap_err()
        .detail,
        "Repository missing."
    );
    stub.executable(
        "gh",
        &[],
        "case \"$1\" in auth) printf token ;; api) cat ;; esac",
    );
    assert_eq!(
        github::api_json(
            ctx,
            &stub.dir,
            "github.com",
            "repos/acme/web",
            Some(json!({"name":"new"})),
            "Repository missing."
        )
        .await
        .unwrap(),
        json!({"name":"new"})
    );
    stub.executable("gh", &[], "exit 1");
    let error = resolve(ctx, &stub.dir, "42")
        .await
        .unwrap_err()
        .to_contract();
    assert_eq!(error["_tag"], "SourceControlProviderError");
    assert_eq!(
        error["detail"],
        "No GitHub credential for github.com: run `gh auth login --hostname github.com`."
    );
}

#[test]
fn fork_branch_names_avoid_parent_and_child_conflicts() {
    assert_eq!(
        worktree_branch(42, "Feature/Fix", true, &[]),
        "t3code/pr-42/feature/fix"
    );
    assert_eq!(
        worktree_branch(42, "fix", true, &["t3code".into()]),
        "t3code-pr-42-fix"
    );
    assert_eq!(
        worktree_branch(
            42,
            "fix",
            true,
            &["t3code".into(), "t3code-pr-42-fix/child".into()]
        ),
        "t3code-pr-42-fix-2"
    );
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        .current_dir(cwd)
        .env("GIT_AUTHOR_NAME", "test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().into()
}

#[tokio::test(flavor = "current_thread")]
async fn worktrees_reuse_refresh_and_preserve_edits_local_commits_and_rewritten_heads() {
    let stub = StubDir::new("pr-worktree");
    let root = std::fs::canonicalize(&stub.dir).unwrap();
    let bare = root.join("origin.git");
    let work = root.join("work");
    git(
        &root,
        &["init", "--bare", "-b", "main", bare.to_str().unwrap()],
    );
    git(
        &root,
        &["clone", bare.to_str().unwrap(), work.to_str().unwrap()],
    );
    std::fs::write(work.join("file"), "initial").unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "-m", "initial"]);
    git(&work, &["push", "origin", "main"]);
    git(&work, &["checkout", "-b", "feature"]);
    std::fs::write(work.join("file"), "first").unwrap();
    git(&work, &["commit", "-am", "first"]);
    let first = git(&work, &["rev-parse", "HEAD"]);
    git(
        &work,
        &["push", "origin", "feature", "HEAD:refs/pull/42/head"],
    );
    git(&work, &["checkout", "main"]);
    git(&work, &["branch", "-D", "feature"]);
    let rewrite = format!("url.{}.insteadOf", bare.display());
    git(&work, &["config", &rewrite, "https://github.com/acme/web"]);
    git(
        &work,
        &["remote", "set-url", "origin", "https://github.com/acme/web"],
    );
    let response = root.join("pr.json");
    let write_pr = |sha: &str| {
        std::fs::write(&response,json!({"data":{"repository":{"pullRequest":{"number":42,"title":"Feature","url":"https://github.com/acme/web/pull/42","baseRefName":"main","headRefName":"feature","headRefOid":sha,"state":"OPEN","isCrossRepository":false,"headRepository":{"nameWithOwner":"acme/web"},"headRepositoryOwner":{"login":"acme"}}}}}).to_string()).unwrap()
    };
    write_pr(&first);
    stub.executable(
        "gh",
        &[],
        &format!(
            "case \"$1\" in auth) printf token ;; api) cat '{}' ;; esac",
            response.display()
        ),
    );
    let settings = Settings::default();
    let env = Environment::fixed([("GH_REPO", "acme/web")]);
    let endpoints = Endpoints::default();
    let child = stub.path_env();
    let ctx = DiscoveryContext {
        cwd: &work,
        home: None,
        settings: &settings,
        env: &env,
        endpoints: &endpoints,
        child_env: &child,
    };
    let input = GitPreparePullRequestThreadInput {
        cwd: work.to_string_lossy().into(),
        reference: "42".into(),
        mode: ThreadEnvMode::Worktree,
        thread_id: None,
    };
    git(
        &work,
        &[
            "config",
            "remote.origin.fetch",
            "+refs/heads/main:refs/remotes/origin/main",
        ],
    );
    let fetches = root.join("fetches");
    let upload = root.join("upload-pack");
    conn_support::test_util::executable(
        &upload,
        &format!(
            "#!/bin/sh\nprintf 'fetch\\n' >> '{}'\nexec '{}/git-upload-pack' \"$@\"\n",
            fetches.display(),
            git(&root, &["--exec-path"])
        ),
    )
    .unwrap();
    git(
        &work,
        &[
            "config",
            "remote.origin.uploadpack",
            upload.to_str().unwrap(),
        ],
    );
    let (created, setup) = prepare(ctx, &input, &root.join("worktrees")).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(&fetches).unwrap().lines().count(),
        1,
        "creating the branch fetches its upstream once: {}",
        std::fs::read_to_string(&fetches).unwrap()
    );
    assert!(setup);
    let path = PathBuf::from(created.worktree_path.unwrap());
    assert_eq!(git(&path, &["rev-parse", "HEAD"]), first);
    assert_eq!(git(&path, &["rev-parse", "@{upstream}"]), first);
    assert_eq!(git(&work, &["branch", "--show-current"]), "main");
    assert_eq!(
        git(&path, &["config", "branch.feature.t3-pull-request"]),
        "https://github.com/acme/web/pull/42"
    );
    std::fs::write(path.join("file"), "uncommitted").unwrap();
    let (dirty, setup) = prepare(ctx, &input, &root.join("worktrees")).await.unwrap();
    assert!(!setup);
    assert_eq!(dirty.worktree_path.as_deref(), path.to_str());
    assert_eq!(
        std::fs::read_to_string(path.join("file")).unwrap(),
        "uncommitted"
    );
    git(&path, &["reset", "--hard"]);
    std::fs::write(work.join("new"), "next").unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "-m", "rewrite"]);
    let rewritten = git(&work, &["rev-parse", "HEAD"]);
    git(
        &work,
        &[
            "push",
            "--force",
            "origin",
            "HEAD:feature",
            "HEAD:refs/pull/42/head",
        ],
    );
    git(
        &work,
        &["update-ref", "refs/remotes/origin/feature", &first],
    );
    write_pr(&rewritten);
    let (updated, setup) = prepare(ctx, &input, &root.join("worktrees")).await.unwrap();
    assert!(setup);
    assert_eq!(updated.is_on_pull_request_head, Some(true));
    assert_eq!(git(&path, &["rev-parse", "HEAD"]), rewritten);
    assert_eq!(git(&path, &["rev-parse", "refs/t3code/pre-refresh"]), first);
    git(&bare, &["update-ref", "-d", "refs/pull/42/head"]);
    let (unchanged, setup) = prepare(ctx, &input, &root.join("worktrees")).await.unwrap();
    assert_eq!(unchanged.is_on_pull_request_head, Some(true));
    assert!(!setup);
    git(&bare, &["update-ref", "refs/pull/42/head", &rewritten]);
    std::fs::write(path.join("local"), "local").unwrap();
    git(&path, &["add", "."]);
    git(&path, &["commit", "-m", "local"]);
    let local = git(&path, &["rev-parse", "HEAD"]);
    let preserved = prepare(ctx, &input, &root.join("worktrees"))
        .await
        .unwrap()
        .0;
    assert_eq!(preserved.is_on_pull_request_head, Some(false));
    assert_eq!(git(&path, &["rev-parse", "HEAD"]), local);
    git(&work, &["reset", "--hard", "HEAD"]);
    git(&path, &["reset", "--hard", &rewritten]);
    git(&work, &["worktree", "remove", path.to_str().unwrap()]);
    let local_input = GitPreparePullRequestThreadInput {
        mode: ThreadEnvMode::Local,
        ..input.clone()
    };
    std::fs::write(work.join("file"), "dirty").unwrap();
    let refused = prepare(ctx, &local_input, &root.join("worktrees"))
        .await
        .unwrap_err();
    assert!(refused.detail.contains("uncommitted changes"));
    assert_eq!(git(&work, &["branch", "--show-current"]), "main");
    git(&work, &["reset", "--hard"]);
    let before = std::fs::read_to_string(&fetches).unwrap().lines().count();
    let local = prepare(ctx, &local_input, &root.join("worktrees"))
        .await
        .unwrap()
        .0;
    assert_eq!(
        std::fs::read_to_string(&fetches).unwrap().lines().count(),
        before + 1,
        "local checkout fetches its upstream once"
    );
    assert_eq!(local.worktree_path, None);
    assert_eq!(local.branch, "feature");
    assert_eq!(git(&work, &["rev-parse", "HEAD"]), rewritten);
    git(
        &work,
        &["config", "branch.feature.remote", "upstream-before"],
    );
    git(
        &work,
        &["config", "branch.feature.merge", "refs/heads/before"],
    );
    git(&work, &["reset", "--hard", &first]);
    std::fs::write(work.join("unpublished"), "local").unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "-m", "unpublished"]);
    assert!(
        prepare(ctx, &local_input, &root.join("worktrees"))
            .await
            .is_err()
    );
    assert_eq!(
        git(&work, &["config", "branch.feature.remote"]),
        "upstream-before"
    );
    assert_eq!(
        git(&work, &["config", "branch.feature.merge"]),
        "refs/heads/before"
    );
    git(&work, &["reset", "--hard", &rewritten]);
    git(&work, &["checkout", "main"]);
    let main = git(&work, &["rev-parse", "HEAD"]);
    let mut fork: Value =
        serde_json::from_str(&std::fs::read_to_string(&response).unwrap()).unwrap();
    let pr = &mut fork["data"]["repository"]["pullRequest"];
    pr["headRefName"] = json!("main");
    pr["headRefOid"] = json!(main);
    pr["baseRefName"] = json!("feature");
    pr["isCrossRepository"] = json!(true);
    pr["headRepositoryOwner"]["login"] = json!("someone");
    pr["headRepository"]["nameWithOwner"] = json!("someone/web");
    git(
        &work,
        &[
            "config",
            "--add",
            &rewrite,
            "https://github.com/someone/web",
        ],
    );
    std::fs::write(&response, fork.to_string()).unwrap();
    stub.executable("gh", &[], &format!(
        "case \"$1\" in auth) printf token ;; api) case \"$2\" in graphql) cat '{}' ;; repos/someone/web) printf '%s' '{{\"full_name\":\"someone/web\",\"html_url\":\"https://github.com/someone/web\",\"clone_url\":\"https://github.com/someone/web.git\",\"ssh_url\":\"git@github.com:someone/web.git\"}}' ;; *) printf '%s' '{{\"default_branch\":\"main\"}}' ;; esac ;; esac", response.display()));
    let fork = prepare(ctx, &local_input, &root.join("worktrees"))
        .await
        .unwrap()
        .0;
    assert_eq!(fork.branch, "someone/main");
    assert_eq!(
        git(&work, &["config", "branch.someone/main.remote"]),
        "someone"
    );
    assert_eq!(git(&work, &["rev-parse", "refs/heads/main"]), main);
}

#[test]
fn github_identity_accepts_https_and_ssh_remotes() {
    for remote in ["https://github.com/acme/web", "git@github.com:acme/web.git"] {
        assert_eq!(
            repositories::api_host_for_remote(remote).as_deref(),
            Some("github.com")
        );
        assert_eq!(
            remote::parse_git_remote_repository(remote)
                .map(|(_, p)| p)
                .as_deref(),
            Some("acme/web")
        );
    }
}

#[test]
fn branch_names_fold_latin_diacritics() {
    assert_eq!(branch_fragment("Féature/Đß café"), "feature/dss-cafe");
}

#[tokio::test(flavor = "current_thread")]
async fn owner_qualified_heads_use_rest_and_keep_the_owner() {
    let stub = StubDir::new("pr-owner");
    let pr = json!({"number":71,"title":"Owned","html_url":"https://github.com/acme/web/pull/71","state":"open","merged_at":null,"head":{"ref":"main","sha":"abcdef1234567","repo":{"full_name":"someone/web"},"user":{"login":"someone"}},"base":{"ref":"main","repo":{"full_name":"acme/web"}}});
    stub.executable("gh", &[], &format!("case \"$1\" in auth) printf token ;; api) case \"$2\" in *'head=someone%3Amain'*) printf '%s' '{}' ;; *) printf '%s' '{{}}' ;; esac ;; esac", json!([pr])));
    let settings = Settings::default();
    let env = Environment::fixed([("GH_REPO", "acme/web")]);
    let endpoints = Endpoints::default();
    let child = stub.path_env();
    let ctx = DiscoveryContext {
        cwd: &stub.dir,
        home: None,
        settings: &settings,
        env: &env,
        endpoints: &endpoints,
        child_env: &child,
    };
    let pr = resolve(ctx, &stub.dir, "someone:main").await.unwrap();
    assert_eq!(pr.resolved.number, 71);
    assert!(pr.cross_repository);
    assert!(!stub.log("gh").contains("graphql"));
}

#[tokio::test(flavor = "current_thread")]
async fn deleted_fork_uses_the_pull_ref_instead_of_the_base_branch() {
    let stub = StubDir::new("pr-deleted-fork");
    let root = std::fs::canonicalize(&stub.dir).unwrap();
    let bare = root.join("remote.git");
    let work = root.join("work");
    git(
        &root,
        &["init", "--bare", "-b", "main", bare.to_str().unwrap()],
    );
    git(
        &root,
        &["clone", bare.to_str().unwrap(), work.to_str().unwrap()],
    );
    std::fs::write(work.join("file"), "base").unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "-m", "base"]);
    git(&work, &["push", "origin", "main"]);
    let base = git(&work, &["rev-parse", "HEAD"]);
    std::fs::write(work.join("file"), "fork").unwrap();
    git(&work, &["commit", "-am", "fork"]);
    let head = git(&work, &["rev-parse", "HEAD"]);
    git(&work, &["push", "origin", "HEAD:refs/pull/71/head"]);
    git(&work, &["reset", "--hard", &base]);
    git(
        &work,
        &[
            "config",
            &format!("url.{}.insteadOf", bare.display()),
            "https://github.com/acme/web",
        ],
    );
    git(
        &work,
        &["remote", "set-url", "origin", "https://github.com/acme/web"],
    );
    let pr = json!({"data":{"repository":{"pullRequest":{"number":71,"title":"Deleted fork","url":"https://github.com/acme/web/pull/71","state":"OPEN","baseRefName":"main","headRefName":"main","headRefOid":head,"isCrossRepository":true,"headRepository":null}}}});
    stub.executable(
        "gh",
        &[],
        &format!(
            "case \"$1\" in auth) printf token ;; api) printf '%s' '{}' ;; esac",
            pr
        ),
    );
    let settings = Settings::default();
    let env = Environment::fixed([("GH_REPO", "acme/web")]);
    let endpoints = Endpoints::default();
    let child = stub.path_env();
    let ctx = DiscoveryContext {
        cwd: &work,
        home: None,
        settings: &settings,
        env: &env,
        endpoints: &endpoints,
        child_env: &child,
    };
    let input = GitPreparePullRequestThreadInput {
        cwd: work.to_string_lossy().into(),
        reference: "71".into(),
        mode: ThreadEnvMode::Worktree,
        thread_id: None,
    };
    let (result, _) = prepare(ctx, &input, &root.join("worktrees")).await.unwrap();
    assert_eq!(
        git(
            Path::new(result.worktree_path.as_deref().unwrap()),
            &["rev-parse", "HEAD"]
        ),
        head
    );
    assert_eq!(result.is_on_pull_request_head, Some(true));
    assert_eq!(git(&work, &["rev-parse", "main"]), base);
}
