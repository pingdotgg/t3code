//! The services shared with client worktree and terminal methods.

use std::{path::PathBuf, sync::Arc};

use serde_json::Value;

#[derive(Clone)]
pub struct WorktreeConfig {
    /// Read for each handoff so a settings change applies at once.
    pub directory: Arc<dyn Fn() -> PathBuf + Send + Sync>,
    pub settings: Arc<dyn Fn() -> Value + Send + Sync>,
    pub terminals: Option<conn_terminal::TerminalManager>,
    pub hub: conn_vcs::VcsHub,
}

impl std::fmt::Debug for WorktreeConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorktreeConfig").finish_non_exhaustive()
    }
}
