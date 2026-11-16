//! Project files, search, signed asset URLs and the attachment store for `conn-server`.
//!
//! The reference is `apps/server/src/workspace/*`, `assets/*` and `attachmentStore.ts`. This
//! crate holds no per-workspace state: no search index, no caches. Every function blocks on
//! the file system or a short `git` call; the server runs them on `spawn_blocking`.

use std::{
    io,
    path::{Path, PathBuf},
};

pub mod assets;
pub mod attachments;
pub mod entries;
mod git;
pub mod mime;
pub mod paths;
pub mod search;
pub mod signer;
pub mod workspace;

pub use assets::{AssetContext, Served};
pub use attachments::{AttachmentFile, AttachmentStore};

use paths::InternalPaths;
use signer::Signer;

/// The files service: one per server, shared by the methods and the asset routes.
#[derive(Debug)]
pub struct Files {
    pub attachments: AttachmentStore,
    pub signer: Signer,
    pub internal: InternalPaths,
    pub home: Option<PathBuf>,
}

impl Files {
    /// Uses `<state-dir>/attachments` and `<state-dir>/secrets/asset-signing-key`, creating
    /// them on first start.
    pub fn open(state_dir: &Path) -> io::Result<Self> {
        let attachments_dir = state_dir.join("attachments");
        std::fs::create_dir_all(&attachments_dir)?;
        Ok(Self {
            signer: Signer::open(&state_dir.join(paths::SECRETS_DIR))?,
            internal: InternalPaths::new(state_dir),
            attachments: AttachmentStore::new(attachments_dir),
            home: std::env::var_os("HOME")
                .map(PathBuf::from)
                .filter(|h| h.is_absolute()),
        })
    }
}

/// The folders `projects.writeFile` may write in: project roots, and thread worktrees that
/// `git worktree list` names for their project (`KnownWorkspaces.ts`). Built per call from the
/// engine's shell snapshot; never cached.
#[derive(Debug, Default)]
pub struct KnownWorkspaces {
    roots: Vec<PathBuf>,
}

impl KnownWorkspaces {
    /// `projects`: workspace roots. `worktrees`: `(project root, thread worktree path)`.
    pub fn new(projects: &[String], worktrees: &[(String, String)]) -> Self {
        let real = |p: &str| {
            let path = paths::normalize(Path::new(p));
            let real = std::fs::canonicalize(&path).ok()?;
            (path.is_absolute() && !paths::is_filesystem_root(&real)).then_some(real)
        };
        let mut roots: Vec<PathBuf> = projects.iter().filter_map(|p| real(p)).collect();
        let mut listed: Vec<(String, Vec<PathBuf>)> = Vec::new();
        for (project, worktree) in worktrees {
            let Some(worktree_real) = real(worktree) else {
                continue;
            };
            if roots.contains(&worktree_real) {
                continue;
            }
            let index = match listed.iter().position(|(p, _)| p == project) {
                Some(i) => i,
                None => {
                    listed.push((project.clone(), git_worktrees(Path::new(project))));
                    listed.len() - 1
                }
            };
            if listed[index].1.contains(&worktree_real) {
                roots.push(worktree_real);
            }
        }
        Self { roots }
    }

    /// `real` must be canonical.
    pub fn contains(&self, real: &Path) -> bool {
        self.roots.iter().any(|root| real.starts_with(root))
    }
}

fn git_worktrees(project: &Path) -> Vec<PathBuf> {
    let Some(output) = git::run(
        project,
        &["worktree", "list", "--porcelain"],
        None,
        1024 * 1024,
        std::time::Duration::from_secs(5),
    ) else {
        return Vec::new();
    };
    if output.code != Some(0) {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .filter_map(|p| std::fs::canonicalize(p).ok())
        .collect()
}

/// Locks a std mutex. A poisoned lock means a thread panicked while it held the lock: a bug.
/// With `panic = "abort"` a release build stops at the panic itself.
pub(crate) fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().expect("conn-files lock poisoned")
}
