//! The Database surface. Placeholder until the view lands; see `panels/api.rs` for the pattern.

use conn_theme::Tokens;
use gpui_kit::{Context, IntoElement, Render, Window};

use super::chrome;

/// The Database panel entity.
#[derive(Debug)]
pub(crate) struct DatabasePanel {
    tokens: Tokens,
    project_key: Option<String>,
    workspace_root: Option<String>,
}

impl DatabasePanel {
    pub(crate) fn new(tokens: Tokens, _window: &mut Window, _cx: &mut Context<'_, Self>) -> Self {
        Self {
            tokens,
            project_key: None,
            workspace_root: None,
        }
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    /// The selected thread's project (Conn keys panel state by project) and its folder.
    pub(crate) fn set_project(
        &mut self,
        project_key: Option<String>,
        workspace_root: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        self.project_key = project_key;
        self.workspace_root = workspace_root;
        cx.notify();
    }
}

impl Render for DatabasePanel {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<'_, Self>) -> impl IntoElement {
        let _ = (&self.project_key, &self.workspace_root);
        chrome::empty_state(&self.tokens, "Database")
    }
}
