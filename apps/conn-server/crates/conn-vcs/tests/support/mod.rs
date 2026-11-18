//! Throwaway git repositories for the tests. Each is removed on drop.

#![expect(
    clippy::unwrap_used,
    reason = "test helpers: a failure should fail the test"
)]

use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU32, Ordering},
};

pub(crate) struct TempDir(pub PathBuf);

impl TempDir {
    pub(crate) fn new(label: &str) -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "conn-vcs-{label}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Canonical, so paths compare equal to what git reports (macOS /var → /private/var).
        Self(std::fs::canonicalize(&dir).unwrap())
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Runs git in `cwd` with a fixed identity and no signing; panics on failure.
pub(crate) fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "tag.gpgsign=false",
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
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

pub(crate) fn write(dir: &Path, path: &str, text: &str) {
    let file = dir.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

pub(crate) fn commit_all(dir: &Path, message: &str) -> String {
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-qm", message]);
    git(dir, &["rev-parse", "HEAD"]).trim().to_owned()
}

/// `root/origin.git` (bare), and `root/work`, a clone of it on `main` with one commit pushed.
pub(crate) struct Fixture {
    pub root: TempDir,
    pub origin: PathBuf,
    pub work: PathBuf,
}

impl Fixture {
    pub(crate) fn new(label: &str) -> Self {
        let root = TempDir::new(label);
        let origin = root.path().join("origin.git");
        let work = root.path().join("work");
        git(
            root.path(),
            &[
                "init",
                "-q",
                "--bare",
                "-b",
                "main",
                origin.to_str().unwrap(),
            ],
        );
        git(
            root.path(),
            &[
                "clone",
                "-q",
                origin.to_str().unwrap(),
                work.to_str().unwrap(),
            ],
        );
        // The code under test runs its own git, which writes reflog entries. Without an
        // identity git guesses one from the host name, and a host name the resolver does not
        // know costs a 5 s lookup per entry.
        git(&work, &["config", "user.name", "test"]);
        git(&work, &["config", "user.email", "test@example.com"]);
        git(&work, &["checkout", "-q", "-b", "main"]);
        write(&work, "README.md", "# repo\n");
        write(&work, "src/lib.rs", "pub fn one() -> u32 {\n    1\n}\n");
        commit_all(&work, "init");
        git(&work, &["push", "-q", "-u", "origin", "main"]);
        git(&work, &["remote", "set-head", "origin", "main"]);
        Self { root, origin, work }
    }

    /// A second clone, for pushing changes the first one has not seen.
    pub(crate) fn other_clone(&self) -> PathBuf {
        let other = self.root.path().join("other");
        if !other.exists() {
            git(
                self.root.path(),
                &[
                    "clone",
                    "-q",
                    self.origin.to_str().unwrap(),
                    other.to_str().unwrap(),
                ],
            );
        }
        other
    }

    pub(crate) fn cwd(&self) -> String {
        self.work.to_string_lossy().into_owned()
    }
}
