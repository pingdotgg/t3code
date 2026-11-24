//! Git 2.34 (Ubuntu 22.04) takes `worktree add --lock --reason` but refuses
//! `worktree list -z`. A shim `git` that refuses it stands in, through the children's `PATH`
//! overlay, so this file is its own test binary: the overlay is process-wide.

#[expect(dead_code, reason = "repos.rs uses the other helpers")]
mod support;

use std::os::unix::fs::PermissionsExt;

use conn_vcs::setup::{self, ProvisionError, ProvisionRequest, WorktreeSetups};
use support::{Fixture, git};

#[tokio::test]
async fn a_failed_hook_unlocks_its_checkout_on_git_without_list_z() {
    let fx = Fixture::new("old-git");
    let real = std::env::var_os("PATH")
        .and_then(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join("git"))
                .find(|git| git.is_file())
        })
        .unwrap();
    let shim_dir = fx.root.path().join("shim");
    std::fs::create_dir_all(&shim_dir).unwrap();
    let shim = shim_dir.join("git");
    std::fs::write(
        &shim,
        format!(
            "#!/bin/sh\ncase \" $* \" in *\" list \"*\" -z \"*) echo \"error: unknown switch \\`z'\" >&2; exit 129;; esac\nexec {} \"$@\"\n",
            real.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
    conn_support::login_env::apply(&[("PATH", shim_dir.to_string_lossy().into_owned())]);

    let hook = fx.work.join(".git/hooks/post-checkout");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let result = setup::provision(
        &WorktreeSetups::new(),
        ProvisionRequest {
            thread_id: "old".into(),
            project_root: fx.work.clone(),
            base_ref: "main".into(),
            branch: Some("feature-old".into()),
            start_from_origin: false,
            missing_base: conn_vcs::setup::MissingBase::Fail,
            submodules: None,
            setup: None,
            worktrees_dir: fx.root.path().join("worktrees"),
        },
    )
    .await;
    conn_support::login_env::clear();
    assert!(
        matches!(result, Err(ProvisionError::Failed(_))),
        "{result:?}"
    );
    let list = git(&fx.work, &["worktree", "list", "--porcelain"]);
    assert!(list.contains("feature-old"), "the checkout was removed");
    assert!(!list.contains("locked"), "the kept checkout stayed locked");
}
