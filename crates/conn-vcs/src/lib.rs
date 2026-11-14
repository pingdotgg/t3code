//! Git for the Conn Server, through the `git` CLI as the T3 server does.
//!
//! Why the CLI and not `gix` or `git2` (both maintained: gix 0.90.0, 2026-10-22; git2 0.21.0,
//! 2026-10-06), measured on 2026-11-13 with this workspace's release profile, listing 6,452
//! refs and reading HEAD:
//!
//! | Way          | Binary (on a 359 KB baseline) | Peak RSS of the reading process |
//! | ------------ | ----------------------------- | ------------------------------- |
//! | `git` child  | +0                            | in the child; gone when it ends |
//! | git2         | +539 KB                       | 9.7 MB, in the server           |
//! | gix (`sha1`) | +802 KB                       | 4.1 MB, in the server           |
//!
//! The server's whole anonymous memory is 0.5 to 2.6 MiB, so a library's object and pack
//! caches would dominate it. Neither library would remove the CLI: `worktree add`, `pull`,
//! fetch with the user's credentials, hooks and textconv still need it. And the T3 server's
//! behaviour is defined by git's own output (porcelain v2, numstat), which the CLI matches.
//!
//! - [`status`], [`refs`], [`worktree`], [`review`]: one function per operation, contract types
//!   in and out.
//! - [`hub::VcsHub`]: keeps status and branch streams current.
//! - [`setup`]: worktree setup progress and [`setup::provision`] for thread launch.
//! - [`discovery`]: which VCS and forge CLIs exist.
//!
//! Every git child has a timeout and bounded stdout and stderr ([`process`]).

pub mod discovery;
pub mod error;
pub mod hub;
pub mod process;
pub mod refs;
pub mod repo;
pub mod review;
pub mod setup;
pub mod status;
pub mod worktree;

pub use error::{VcsError, VcsResult};
pub use hub::VcsHub;
pub use setup::WorktreeSetups;

/// Locks a std mutex. A poisoned lock means a thread panicked while it held the lock: a bug.
/// With `panic = "abort"` a release build stops at the panic itself.
pub(crate) fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().expect("conn-vcs lock poisoned")
}
