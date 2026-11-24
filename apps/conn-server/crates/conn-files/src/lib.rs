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
pub mod html;
mod mcp_app_bootstrap;
pub mod mcp_apps;
pub mod mime;
pub mod paths;
pub mod search;
pub mod signer;
pub mod themes;
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
    /// `<state-dir>/themes`: the published environment themes.
    pub themes: themes::Themes,
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
            themes: themes::Themes::open(state_dir.join("themes")),
            home: std::env::var_os("HOME")
                .map(PathBuf::from)
                .filter(|h| h.is_absolute()),
        })
    }
}

/// The folders `projects.writeFile` may write in: project roots, thread worktrees that
/// `git worktree list` names for their project, and, with [`KnownWorkspaces::with_managed`],
/// a managed worktree whose repository lies in a project, or is a linked-worktree project's
/// repository, and lists it (`KnownWorkspaces.ts`).
/// Built per call from the engine's shell snapshot; never cached.
#[derive(Debug, Default)]
pub struct KnownWorkspaces {
    roots: Vec<PathBuf>,
    /// Project roots, resolved.
    projects: Vec<PathBuf>,
    /// Managed worktree folders, resolved.
    managed: Vec<PathBuf>,
}

impl KnownWorkspaces {
    /// `projects`: workspace roots. `worktrees`: `(project root, thread worktree path)`.
    pub fn new(projects: &[String], worktrees: &[(String, String)]) -> Self {
        let mut roots: Vec<PathBuf> = projects.iter().filter_map(|p| real_root(p)).collect();
        let mut listed: Vec<(String, Vec<PathBuf>)> = Vec::new();
        for (project, worktree) in worktrees {
            let Some(worktree_real) = real_root(worktree) else {
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
        Self {
            projects: projects.iter().filter_map(|p| real_root(p)).collect(),
            roots,
            managed: Vec::new(),
        }
    }

    /// Also allows a worktree inside `dirs`, the managed worktree folders, before any thread
    /// names it, such as one `vcs.createWorktree` just made: its repository (the project's or
    /// one nested in it) must lie in a project and list the checkout as its worktree.
    #[must_use]
    pub fn with_managed(mut self, dirs: &[PathBuf]) -> Self {
        self.managed = dirs
            .iter()
            .filter_map(|d| real_root(&d.to_string_lossy()))
            .collect();
        self
    }

    /// `real` must be canonical.
    pub fn contains(&self, real: &Path) -> bool {
        if self.roots.iter().any(|root| real.starts_with(root)) {
            return true;
        }
        // `<managed>/<repo>/<name>`: the checkout `real` lies in.
        let Some(checkout) = self.managed.iter().find_map(|dir| {
            let mut parts = real.strip_prefix(dir).ok()?.components();
            let (repo, name) = (parts.next()?, parts.next()?);
            Some(dir.join(repo).join(name))
        }) else {
            return false;
        };
        let Some(common) = git_common_dir(&checkout) else {
            return false;
        };
        // The repository lies in a project, or is the one a linked-worktree project belongs to.
        // Comparing common dirs, not their parents, keeps a bare `app.git` apart from its siblings.
        self.projects
            .iter()
            .any(|p| common.starts_with(p) || git_common_dir(p).as_ref() == Some(&common))
            && git_worktrees(&checkout).contains(&checkout)
    }
}

/// The canonical `--git-common-dir` of the repository a checkout belongs to.
fn git_common_dir(checkout: &Path) -> Option<PathBuf> {
    let output = git::run(
        checkout,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        None,
        64 * 1024,
        std::time::Duration::from_secs(5),
    )?;
    if output.code != Some(0) {
        return None;
    }
    std::fs::canonicalize(String::from_utf8_lossy(&output.stdout).trim()).ok()
}

/// A canonical, absolute folder that is not a filesystem root.
fn real_root(p: &str) -> Option<PathBuf> {
    let path = paths::normalize(Path::new(p));
    let real = std::fs::canonicalize(&path).ok()?;
    (path.is_absolute() && !paths::is_filesystem_root(&real)).then_some(real)
}

fn git_worktrees(project: &Path) -> Vec<PathBuf> {
    git::worktrees(project)
        .iter()
        .filter_map(|p| std::fs::canonicalize(p).ok())
        .collect()
}

/// Locks a std mutex. A poisoned lock means a thread panicked while it held the lock: a bug.
/// With `panic = "abort"` a release build stops at the panic itself.
pub(crate) fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().expect("conn-files lock poisoned")
}
