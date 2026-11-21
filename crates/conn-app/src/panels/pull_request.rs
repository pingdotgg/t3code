//! The Pull request surface. Placeholder until the view lands; see `panels/api.rs` for the pattern.

use conn_client::Connection;
use conn_theme::Tokens;
use gpui_kit::{Context, IntoElement, Render, Window};

use super::chrome;

/// The Pull request panel entity.
pub(crate) struct PullRequestPanel {
    tokens: Tokens,
    connection: Option<Connection>,
    workspace_root: Option<String>,
    thread_id: Option<String>,
}

impl std::fmt::Debug for PullRequestPanel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PullRequestPanel")
            .field("workspace_root", &self.workspace_root)
            .field("thread_id", &self.thread_id)
            .finish_non_exhaustive()
    }
}

impl PullRequestPanel {
    pub(crate) fn new(
        tokens: Tokens,
        connection: Option<Connection>,
        _window: &mut Window,
        _cx: &mut Context<'_, Self>,
    ) -> Self {
        Self {
            tokens,
            connection,
            workspace_root: None,
            thread_id: None,
        }
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    /// The selected thread and its project folder.
    pub(crate) fn set_thread(
        &mut self,
        workspace_root: Option<String>,
        thread_id: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        self.workspace_root = workspace_root;
        self.thread_id = thread_id;
        cx.notify();
    }
}

impl Render for PullRequestPanel {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<'_, Self>) -> impl IntoElement {
        let _ = &self.connection;
        chrome::empty_state(&self.tokens, "Pull request")
    }
}
