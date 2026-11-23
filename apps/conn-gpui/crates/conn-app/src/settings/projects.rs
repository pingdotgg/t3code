//! Settings → Projects: the projects of this environment (`ProjectsSettings.tsx`).
//!
//! `docs/scope.md` §2 #13 keeps only a project's actions (scripts) and its worktree default as
//! per-project settings, and §5.1 gives the rest of Conn's project page to Orbit. Per-project
//! provider switches are dropped: settings are flat.

use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::{
    AnyElement, Context, InteractiveElement as _, IntoElement, ParentElement as _, Render,
    SharedString, Styled as _, TestSupportExt as _, Window, div, px,
};

use super::ScheduledTaskProjectOption;
use super::controls::{settings_row, settings_section};
use crate::a11y::ConnA11yExt as _;

/// The Projects settings page.
pub(crate) struct ProjectsView {
    tokens: Tokens,
    geometry: ShellGeometry,
    projects: Vec<ScheduledTaskProjectOption>,
}

impl ProjectsView {
    pub(crate) fn new(
        tokens: Tokens,
        geometry: ShellGeometry,
        projects: Vec<ScheduledTaskProjectOption>,
    ) -> Self {
        Self {
            tokens,
            geometry,
            projects,
        }
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    pub(crate) fn set_projects(
        &mut self,
        projects: Vec<ScheduledTaskProjectOption>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.projects != projects {
            self.projects = projects;
            cx.notify();
        }
    }
}

impl Render for ProjectsView {
    fn render(&mut self, _: &mut Window, _: &mut Context<'_, Self>) -> impl IntoElement {
        let tokens = self.tokens.clone();
        let geometry = self.geometry;
        let mut rows: Vec<AnyElement> = Vec::new();
        if self.projects.is_empty() {
            rows.push(settings_row(
                "No projects",
                Some("Projects come from Orbit."),
                div().into_any_element(),
                &tokens,
                &geometry,
            ));
        }
        for project in &self.projects {
            // Keyed by project id: two projects may share a name.
            let ax_id = format!("settings.projects.{}", project.id);
            rows.push(
                div()
                    .id(SharedString::from(ax_id.clone()))
                    .a11y_group(ax_id, project.name.clone())
                    .child(settings_row(
                        &project.name,
                        None,
                        div().into_any_element(),
                        &tokens,
                        &geometry,
                    ))
                    .test_support()
                    .into_any_element(),
            );
        }
        div()
            .id("settings-projects-page")
            .flex()
            .flex_col()
            .gap(px(20.0))
            .w_full()
            .child(settings_section("All projects", rows, &tokens, &geometry))
    }
}
