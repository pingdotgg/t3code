//! Settings → Projects: pick a project, then hop to a settings page scoped to it
//! (`ProjectsSettings.tsx`, `ProjectSettingsPanel.tsx`, `SettingsScopeContext.tsx`).
//!
//! In Conn the project picked here stays picked while you move between settings pages, and
//! the Providers page then edits that project's own switches (`projectSettingsOverrides`).
//! Here each project opens the Providers page in its scope.
//!
//! Not ported from Conn's project page: rename, icon and favicon, pin, archive, checkouts and
//! their grouping rule, project defaults and delete. The sidebar's project menu covers the
//! ones GPUI has.

use std::sync::Arc;

use conn_state::providers::ServerConfigState;
use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::{
    AnyElement, Context, EventEmitter, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, SharedString, Styled as _, TestSupportExt as _, Window, div, px,
};

use super::ScheduledTaskProjectOption;
use super::controls::{settings_row, settings_section};
use super::providers::settings_button;
use crate::a11y::ConnA11yExt as _;

/// What the Projects page asks of the Settings modal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ProjectsEvent {
    /// Open Providers scoped to `(project id, title)`.
    OpenProviders(String, String),
}

/// The Projects settings page.
pub(crate) struct ProjectsView {
    tokens: Tokens,
    geometry: ShellGeometry,
    config: Arc<ServerConfigState>,
    projects: Vec<ScheduledTaskProjectOption>,
}

impl EventEmitter<ProjectsEvent> for ProjectsView {}

impl ProjectsView {
    pub(crate) fn new(
        tokens: Tokens,
        geometry: ShellGeometry,
        projects: Vec<ScheduledTaskProjectOption>,
    ) -> Self {
        Self {
            tokens,
            geometry,
            config: Arc::default(),
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

    pub(crate) fn set_server_config(
        &mut self,
        config: Arc<ServerConfigState>,
        cx: &mut Context<'_, Self>,
    ) {
        self.config = config;
        cx.notify();
    }

    /// `"2 providers set for this project"`, from its overrides.
    fn override_summary(&self, project_id: &str) -> String {
        let count = self
            .config
            .settings()
            .and_then(|s| conn_state::provider_settings::project_overrides(s, project_id))
            .and_then(|o| o.provider_instances.as_ref())
            .map_or(0, |instances| {
                instances.values().filter(|i| i.enabled.is_some()).count()
            });
        match count {
            0 => "Uses the device's providers.".to_owned(),
            1 => "1 provider set for this project.".to_owned(),
            n => format!("{n} providers set for this project."),
        }
    }
}

impl Render for ProjectsView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let tokens = self.tokens.clone();
        let geometry = self.geometry;
        let mut rows: Vec<AnyElement> = Vec::new();
        if self.projects.is_empty() {
            rows.push(settings_row(
                "No projects",
                Some("Add a project from the sidebar to configure it here."),
                div().into_any_element(),
                &tokens,
                &geometry,
            ));
        }
        for project in &self.projects {
            let id = project.id.clone();
            let title = project.name.clone();
            let summary = self.override_summary(&id);
            // Keyed by project id: two projects may share a name.
            let row = settings_row(
                &project.name,
                Some(&summary),
                settings_button(
                    &tokens,
                    format!("settings.projects.{id}.providers"),
                    "Providers",
                    Some(cx.listener(move |_, _, _, cx| {
                        cx.emit(ProjectsEvent::OpenProviders(id.clone(), title.clone()));
                    })),
                ),
                &tokens,
                &geometry,
            );
            let ax_id = format!("settings.projects.{}", project.id);
            rows.push(
                div()
                    .id(SharedString::from(ax_id.clone()))
                    .a11y_group(ax_id, format!("{}: {summary}", project.name))
                    .child(row)
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
            .child(settings_row(
                "Projects",
                Some("Choose a project to set which providers it uses. A project's switch wins over the device setting."),
                div().into_any_element(),
                &tokens,
                &geometry,
            ))
            .child(settings_section("All projects", rows, &tokens, &geometry))
    }
}
