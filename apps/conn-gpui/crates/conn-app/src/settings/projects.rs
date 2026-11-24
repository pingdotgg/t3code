//! Settings → Projects: pick a project, then set where its new threads start and edit its
//! actions (`ProjectsSettings.tsx`, `ProjectSettingsPanel.tsx`, `ProjectDefaultsSettings.tsx`,
//! `ProjectActionsSettings.tsx`, `projectScriptEditor.tsx`).
//!
//! `docs/scope.md` §2 #13 keeps only a project's actions (scripts) and its worktree default as
//! per-project overrides, and §5.1 gives the rest of Conn's project page to Orbit: name, icon,
//! pin, archive, checkouts and removal are not here. Per-project provider switches are dropped:
//! provider settings are flat.
//!
//! Every write is one `server.updateSettings` patch of `projectSettingsOverrides[project]`,
//! built in `conn_state::project_settings`. The settings stream brings the result back.
//!
//! Drift from Conn: the action form is a section of the page, not a dialog, so a dialog never
//! stacks on the Settings modal. The form has no `Keybinding` field: GPUI does not show or run
//! the server's keybindings, so a shortcut set here would do nothing in this client. The
//! workspace choice is two buttons, not a select.

use std::sync::Arc;

use conn_client::Connection;
use conn_contract::OrchestrationProjectShell as ProjectShell;
use conn_state::project_settings::{
    Defaults, ENV_MODES, FileState, SCRIPT_ICONS, Script, Source, T3_PROJECT_FILE_NAME,
    env_mode_request, importable, imported, next_script_id, parse_file, script_from_form,
    scripts_after_delete, scripts_after_save, scripts_request, scripts_reset_request,
};
use conn_state::providers::ServerConfigState;
use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, Styled as _, Subscription, TestSupportExt as _,
    Window, div, px,
};
use serde_json::{Value, json};

use super::ScheduledTaskProjectOption;
use super::controls::{pill_switch, settings_row, settings_section};
use super::providers::styled_button;
use crate::a11y::ConnA11yExt as _;
use crate::theme::hsla;

/// The action form while it is open.
struct Form {
    /// The action being edited, `None` for a new one.
    editing: Option<String>,
    /// The form's switches and icon; the text fields are the inputs below.
    script: Script,
    name: Entity<InputState>,
    command: Entity<InputState>,
    preview_url: Entity<InputState>,
    error: Option<&'static str>,
    confirm_delete: bool,
    _subscriptions: Vec<Subscription>,
}

/// What a finished write changes on the page.
#[derive(Clone, Copy)]
enum Then {
    CloseForm,
    Stay,
}

/// The checkout's `t3.json`, read when a project's page opens.
enum FileLoad {
    Loading,
    Loaded(FileState),
}

/// The Projects settings page.
pub(crate) struct ProjectsView {
    tokens: Tokens,
    geometry: ShellGeometry,
    connection: Option<Connection>,
    config: Arc<ServerConfigState>,
    projects: Vec<ScheduledTaskProjectOption>,
    shells: Vec<ProjectShell>,
    /// The project whose page is open.
    detail: Option<String>,
    form: Option<Form>,
    file: FileLoad,
    show_import: bool,
    pending: bool,
    error: Option<String>,
}

impl ProjectsView {
    pub(crate) fn new(
        tokens: Tokens,
        geometry: ShellGeometry,
        projects: Vec<ScheduledTaskProjectOption>,
        connection: Option<Connection>,
    ) -> Self {
        Self {
            tokens,
            geometry,
            connection,
            config: Arc::default(),
            projects,
            shells: Vec::new(),
            detail: None,
            form: None,
            file: FileLoad::Loading,
            show_import: false,
            pending: false,
            error: None,
        }
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    /// A new connection: nothing half-edited carries over.
    pub(crate) fn set_connection(
        &mut self,
        connection: Option<Connection>,
        cx: &mut Context<'_, Self>,
    ) {
        self.connection = connection;
        self.close_detail();
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

    /// The projects as the server lists them, for each one's own actions and workspace.
    pub(crate) fn set_shells(&mut self, shells: Vec<ProjectShell>, cx: &mut Context<'_, Self>) {
        if self.shells != shells {
            self.shells = shells;
            if self
                .detail
                .as_ref()
                .is_some_and(|id| !self.shells.iter().any(|p| &p.id == id))
            {
                self.close_detail();
            }
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

    fn close_detail(&mut self) {
        self.detail = None;
        self.form = None;
        self.show_import = false;
        self.error = None;
        self.file = FileLoad::Loading;
    }

    fn shell(&self, id: &str) -> Option<&ProjectShell> {
        self.shells.iter().find(|p| p.id == id)
    }

    /// What the project sets itself: `New worktree · 2 actions`, else `Uses the device's settings.`
    fn summary(&self, project_id: &str) -> String {
        let Some(defaults) = self.shell(project_id).and_then(|p| self.defaults(p)) else {
            return "Uses the device's settings.".to_owned();
        };
        let mut parts = Vec::new();
        if defaults.env_mode_source == Source::Project
            && let Some(label) = ENV_MODES
                .iter()
                .find(|(mode, _)| Some(*mode) == defaults.env_mode.as_deref())
                .map(|(_, label)| *label)
        {
            parts.push(label.to_owned());
        }
        match defaults.scripts.len() {
            0 => {}
            1 => parts.push("1 action".to_owned()),
            n => parts.push(format!("{n} actions")),
        }
        if parts.is_empty() {
            "Uses the device's settings.".to_owned()
        } else {
            parts.join(" \u{b7} ")
        }
    }

    fn defaults(&self, project: &ProjectShell) -> Option<Defaults> {
        self.config
            .settings()
            .map(|settings| Defaults::of(settings, project))
    }

    /// Opens a project's page and reads its `t3.json`.
    fn open_detail(&mut self, id: String, cx: &mut Context<'_, Self>) {
        self.close_detail();
        let root = self.shell(&id).map(|p| p.workspace_root.clone());
        self.detail = Some(id.clone());
        if let (Some(connection), Some(root)) = (self.connection.clone(), root) {
            cx.spawn(async move |this, cx| {
                let result = connection
                    .call_json(
                        "projects.readFile",
                        json!({ "cwd": root, "relativePath": T3_PROJECT_FILE_NAME, "allowMissing": true }),
                    )
                    .await;
                let state = match result {
                    Ok(reply)
                        if reply.get("exists") != Some(&json!(false))
                            && reply.get("truncated") != Some(&json!(true)) =>
                    {
                        reply
                            .get("contents")
                            .and_then(Value::as_str)
                            .map_or(FileState::Missing, parse_file)
                    }
                    _ => FileState::Missing,
                };
                let _ = this.update(cx, |view, cx| {
                    if view.detail.as_deref() == Some(id.as_str()) {
                        view.file = FileLoad::Loaded(state);
                        cx.notify();
                    }
                });
            })
            .detach();
        }
        cx.notify();
    }

    /// One `server.updateSettings` call.
    fn write(&mut self, request: Value, then: Then, cx: &mut Context<'_, Self>) {
        let Some(connection) = self.connection.clone() else {
            self.error = Some("Connect an environment to change project settings.".to_owned());
            cx.notify();
            return;
        };
        if self.pending {
            return;
        }
        self.pending = true;
        self.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = connection.call_json("server.updateSettings", request).await;
            let _ = this.update(cx, |view, cx| {
                view.pending = false;
                match result {
                    Ok(_) => {
                        if matches!(then, Then::CloseForm) {
                            view.form = None;
                        }
                    }
                    Err(err) => {
                        view.error = Some(format!(
                            "Could not save project settings. {}",
                            conn_client::commands::format_client_error(&err)
                        ));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    // --- actions ---------------------------------------------------------------------------

    fn open_form(
        &mut self,
        script: Option<Script>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let editing = script.as_ref().map(|s| s.id.clone());
        let script = script.unwrap_or_else(Script::blank);
        let name = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Test")
                .default_value(script.name.clone())
        });
        let command = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("bun test")
                .default_value(script.command.clone())
        });
        let preview_url = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("http://localhost:5173")
                .default_value(script.preview_url.clone().unwrap_or_default())
        });
        let mut subscriptions = Vec::new();
        for input in [&name, &command, &preview_url] {
            subscriptions.push(cx.subscribe_in(
                input,
                window,
                |view, _, event: &InputEvent, _, cx| match event {
                    InputEvent::PressEnter { .. } => view.submit(cx),
                    InputEvent::Change => cx.notify(),
                    _ => {}
                },
            ));
        }
        self.show_import = false;
        self.error = None;
        self.form = Some(Form {
            editing,
            script,
            name,
            command,
            preview_url,
            error: None,
            confirm_delete: false,
            _subscriptions: subscriptions,
        });
        cx.notify();
    }

    fn current_scripts(&self) -> Vec<Script> {
        self.detail
            .as_deref()
            .and_then(|id| self.shell(id))
            .and_then(|p| self.defaults(p))
            .map(|d| d.scripts)
            .unwrap_or_default()
    }

    /// Every action id the device knows, so a new one never repeats an id.
    fn taken_ids(&self) -> Vec<String> {
        let mut ids = Vec::new();
        let Some(settings) = self.config.settings() else {
            return ids;
        };
        for project in &self.shells {
            ids.extend(
                Defaults::of(settings, project)
                    .scripts
                    .into_iter()
                    .map(|s| s.id),
            );
        }
        let root = serde_json::to_value(settings).unwrap_or(Value::Null);
        let lists = root.get("defaultProjectScripts").into_iter().chain(
            root.get("projectSettingsOverrides")
                .and_then(Value::as_object)
                .into_iter()
                .flat_map(|all| all.values().filter_map(|o| o.get("defaultProjectScripts"))),
        );
        for list in lists {
            ids.extend(
                list.as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|s| s.get("id").and_then(Value::as_str).map(str::to_owned)),
            );
        }
        ids
    }

    fn write_scripts(&mut self, scripts: &[Script], then: Then, cx: &mut Context<'_, Self>) {
        let (Some(settings), Some(id)) = (self.config.settings(), self.detail.clone()) else {
            return;
        };
        let request = scripts_request(settings, &id, scripts);
        self.write(request, then, cx);
    }

    fn submit(&mut self, cx: &mut Context<'_, Self>) {
        let Some(form) = &self.form else {
            return;
        };
        let id = form.editing.clone().unwrap_or_else(|| {
            let name = form.name.read(cx).value().to_string();
            next_script_id(&name, &self.taken_ids())
        });
        let mut script = form.script.clone();
        script.name = form.name.read(cx).value().to_string();
        script.command = form.command.read(cx).value().to_string();
        let preview_url = form.preview_url.read(cx).value().to_string();
        let is_new = form.editing.is_none();
        match script_from_form(&id, script, &preview_url) {
            Ok(saved) => {
                let next = scripts_after_save(&self.current_scripts(), &saved, is_new);
                self.write_scripts(&next, Then::CloseForm, cx);
            }
            Err(message) => {
                if let Some(form) = &mut self.form {
                    form.error = Some(message);
                }
                cx.notify();
            }
        }
    }

    fn delete_action(&mut self, id: &str, cx: &mut Context<'_, Self>) {
        let next = scripts_after_delete(&self.current_scripts(), id);
        self.write_scripts(&next, Then::CloseForm, cx);
    }

    fn import_action(&mut self, file_script: &Script, cx: &mut Context<'_, Self>) {
        let added = imported(file_script, &self.taken_ids());
        let next = scripts_after_save(&self.current_scripts(), &added, true);
        self.write_scripts(&next, Then::Stay, cx);
    }

    fn reset_scripts(&mut self, cx: &mut Context<'_, Self>) {
        let (Some(settings), Some(id)) = (self.config.settings(), self.detail.clone()) else {
            return;
        };
        let request = scripts_reset_request(settings, &id);
        self.form = None;
        self.write(request, Then::Stay, cx);
    }

    fn set_env_mode(&mut self, mode: Option<&str>, cx: &mut Context<'_, Self>) {
        let (Some(settings), Some(id)) = (self.config.settings(), self.detail.clone()) else {
            return;
        };
        let request = env_mode_request(settings, &id, mode);
        self.write(request, Then::Stay, cx);
    }

    // --- pieces ----------------------------------------------------------------------------

    fn button(
        &self,
        ax_id: String,
        label: &str,
        ax_label: &str,
        primary: bool,
        on_click: Option<impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static>,
    ) -> AnyElement {
        styled_button(&self.tokens, ax_id, label, ax_label, primary, on_click)
    }

    fn note(&self, ax_id: &str, text: String, error: bool) -> AnyElement {
        div()
            .id(SharedString::from(ax_id.to_owned()))
            .a11y_group(ax_id.to_owned(), text.clone())
            .px(px(14.0))
            .py(px(10.0))
            .text_size(px(self.geometry.ui_font_size_px))
            .line_height(px(self.geometry.ui_line_height_px))
            .text_color(if error {
                hsla(self.tokens.destructive)
            } else {
                hsla(self.tokens.muted_foreground_raised)
            })
            .child(text)
            .test_support()
            .into_any_element()
    }

    fn field(
        &self,
        ax_id: &str,
        title: &str,
        help: Option<&str>,
        input: &Entity<InputState>,
    ) -> AnyElement {
        let column = div().flex().flex_col().items_end().w(px(260.0)).child(
            div()
                .id(SharedString::from(ax_id.to_owned()))
                .a11y_group(ax_id.to_owned(), title.to_owned())
                .w_full()
                .child(Input::new(input))
                .test_support(),
        );
        settings_row(
            title,
            help,
            column.into_any_element(),
            &self.tokens,
            &self.geometry,
        )
    }

    fn switch_row(
        &self,
        title: &str,
        slug: &str,
        checked: bool,
        toggle: impl Fn(&mut Form) + Clone + 'static,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let entity = cx.entity();
        let switch = pill_switch(
            SharedString::from(format!("conn-settings-{slug}")),
            checked,
            &self.tokens,
            move |_window, cx| {
                let toggle = toggle.clone();
                entity.update(cx, |view, cx| {
                    if let Some(form) = &mut view.form {
                        toggle(form);
                    }
                    cx.notify();
                });
            },
        );
        let ax_id = format!("settings.projects.action.{slug}");
        let labelled = div()
            .id(SharedString::from(ax_id.clone()))
            .a11y_group(
                ax_id,
                format!("{title}: {}", if checked { "on" } else { "off" }),
            )
            .child(switch)
            .test_support();
        settings_row(
            title,
            None,
            labelled.into_any_element(),
            &self.tokens,
            &self.geometry,
        )
    }

    fn form_section(&self, form: &Form, cx: &mut Context<'_, Self>) -> AnyElement {
        let editing = form.editing.is_some();
        let has_preview = !form.preview_url.read(cx).value().trim().is_empty();
        let script = &form.script;
        let mut rows = vec![
            self.note(
                "settings.projects.action.about",
                "Actions are project-scoped commands you can run from the top bar.".to_owned(),
                false,
            ),
            self.field("settings.projects.action.name", "Name", None, &form.name),
        ];

        let mut icons = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .gap(px(6.0))
            .justify_end();
        for (id, label) in SCRIPT_ICONS {
            let id_owned = id.to_owned();
            icons = icons.child(self.button(
                format!("settings.projects.action.icon.{id}"),
                label,
                &format!("Icon: {label}"),
                script.icon == id,
                Some(cx.listener(move |view, _, _, cx| {
                    if let Some(form) = &mut view.form {
                        form.script.icon.clone_from(&id_owned);
                    }
                    cx.notify();
                })),
            ));
        }
        rows.push(settings_row(
            "Icon",
            None,
            icons.into_any_element(),
            &self.tokens,
            &self.geometry,
        ));

        rows.push(self.field(
            "settings.projects.action.command",
            "Command",
            None,
            &form.command,
        ));
        rows.push(self.field(
            "settings.projects.action.preview-url",
            "Preview URL (optional)",
            Some("Open this URL in the in-app preview when this action runs."),
            &form.preview_url,
        ));
        rows.push(self.switch_row(
            "Run automatically on worktree creation",
            "run-on-worktree-creation",
            script.run_on_worktree_create,
            |form| {
                form.script.run_on_worktree_create = !form.script.run_on_worktree_create;
                if !form.script.run_on_worktree_create {
                    form.script.wait_for_setup = false;
                }
            },
            cx,
        ));
        if script.run_on_worktree_create {
            rows.push(self.switch_row(
                "Wait for it to finish before the agent starts",
                "wait-for-setup",
                script.wait_for_setup,
                |form| form.script.wait_for_setup = !form.script.wait_for_setup,
                cx,
            ));
        }
        rows.push(self.switch_row(
            "Run in the thread's worktree when the thread settles",
            "run-on-settle",
            script.run_on_settle,
            |form| form.script.run_on_settle = !form.script.run_on_settle,
            cx,
        ));
        rows.push(self.switch_row(
            "Stop this action when the thread settles",
            "stop-on-settle",
            script.stop_on_settle,
            |form| form.script.stop_on_settle = !form.script.stop_on_settle,
            cx,
        ));
        if has_preview {
            rows.push(self.switch_row(
                "Open preview automatically when this action runs",
                "auto-open-preview",
                script.auto_open_preview,
                |form| form.script.auto_open_preview = !form.script.auto_open_preview,
                cx,
            ));
        }
        if let Some(message) = form.error {
            rows.push(self.note("settings.projects.action.error", message.to_owned(), true));
        }

        let save_label = if editing {
            "Save changes"
        } else {
            "Save action"
        };
        let mut buttons = div()
            .flex()
            .flex_row()
            .justify_end()
            .gap(px(8.0))
            .px(px(14.0))
            .py(px(10.0));
        if form.editing.is_some() {
            buttons = buttons.child(self.button(
                "settings.projects.action.delete".to_owned(),
                "Delete action",
                &format!("Delete action {}", script.name),
                false,
                Some(cx.listener(|view, _, _, cx| {
                    if let Some(form) = &mut view.form {
                        form.confirm_delete = true;
                    }
                    cx.notify();
                })),
            ));
        }
        buttons = buttons
            .child(self.button(
                "settings.projects.action.cancel".to_owned(),
                "Cancel",
                "Cancel",
                false,
                Some(cx.listener(|view, _, _, cx| {
                    view.form = None;
                    cx.notify();
                })),
            ))
            .child(self.button(
                "settings.projects.action.save".to_owned(),
                save_label,
                save_label,
                true,
                (!self.pending).then(|| cx.listener(|view, _, _, cx| view.submit(cx))),
            ));
        rows.push(buttons.into_any_element());

        if form.confirm_delete
            && let Some(id) = &form.editing
        {
            let name = script.name.clone();
            let confirm_id = id.clone();
            rows.push(
                div()
                    .id("settings.projects.action.delete.question")
                    .a11y_group(
                        "settings.projects.action.delete.question",
                        format!("Delete action \"{name}\"?"),
                    )
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .px(px(14.0))
                    .py(px(10.0))
                    .child(
                        div()
                            .text_size(px(self.geometry.ui_font_size_px))
                            .text_color(hsla(self.tokens.foreground))
                            .child(format!("Delete action \"{name}\"?")),
                    )
                    .child(
                        div()
                            .text_size(px(self.geometry.ui_font_size_px))
                            .text_color(hsla(self.tokens.muted_foreground_raised))
                            .child("This action cannot be undone."),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .justify_end()
                            .gap(px(8.0))
                            .child(self.button(
                                "settings.projects.action.delete.cancel".to_owned(),
                                "Cancel",
                                "Cancel",
                                false,
                                Some(cx.listener(|view, _, _, cx| {
                                    if let Some(form) = &mut view.form {
                                        form.confirm_delete = false;
                                    }
                                    cx.notify();
                                })),
                            ))
                            .child(self.button(
                                "settings.projects.action.delete.confirm".to_owned(),
                                "Delete action",
                                &format!("Delete action {name} for good"),
                                true,
                                (!self.pending).then(|| {
                                    cx.listener(move |view, _, _, cx| {
                                        view.delete_action(&confirm_id, cx);
                                    })
                                }),
                            )),
                    )
                    .test_support()
                    .into_any_element(),
            );
        }

        settings_section(
            if editing { "Edit Action" } else { "Add Action" },
            rows,
            &self.tokens,
            &self.geometry,
        )
        .into_any_element()
    }

    fn actions_section(
        &self,
        project: &ProjectShell,
        defaults: &Defaults,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let pid = project.id.clone();
        let file_state = match &self.file {
            FileLoad::Loaded(state) => Some(state),
            FileLoad::Loading => None,
        };
        let offered: Vec<Script> = match file_state {
            Some(FileState::Valid(file)) => importable(file, &defaults.scripts)
                .into_iter()
                .cloned()
                .collect(),
            _ => Vec::new(),
        };
        let mut controls = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap(px(6.0));
        if defaults.scripts_source == Source::Project {
            controls = controls.child(self.button(
                format!("settings.projects.{pid}.actions.reset"),
                "Use device actions",
                "Use device actions for this project",
                false,
                (!self.pending).then(|| cx.listener(|view, _, _, cx| view.reset_scripts(cx))),
            ));
        }
        if !offered.is_empty() {
            controls = controls.child(self.button(
                format!("settings.projects.{pid}.actions.import"),
                "Import scripts",
                "Import scripts from t3.json",
                false,
                (!self.pending).then(|| {
                    cx.listener(|view, _, _, cx| {
                        view.show_import = !view.show_import;
                        cx.notify();
                    })
                }),
            ));
        }
        controls = controls.child(
            self.button(
                format!("settings.projects.{pid}.actions.add"),
                "Add action",
                "Add action",
                false,
                (self.form.is_none() && !self.pending)
                    .then(|| cx.listener(|view, _, window, cx| view.open_form(None, window, cx))),
            ),
        );

        let mut rows = vec![settings_row(
            "Actions",
            Some("Commands that run in this project's checkout or its worktree."),
            controls.into_any_element(),
            &self.tokens,
            &self.geometry,
        )];

        if self.show_import && !offered.is_empty() {
            rows.push(self.note(
                "settings.projects.import.about",
                "Import from t3.json: add actions declared by this checkout without editing them first."
                    .to_owned(),
                false,
            ));
            for (index, script) in offered.iter().enumerate() {
                let to_import = script.clone();
                rows.push(settings_row(
                    &script.name,
                    Some(&script.command),
                    self.button(
                        format!("settings.projects.import.{index}"),
                        "Import",
                        &format!("Import {}", script.name),
                        false,
                        (!self.pending).then(|| {
                            cx.listener(move |view, _, _, cx| view.import_action(&to_import, cx))
                        }),
                    ),
                    &self.tokens,
                    &self.geometry,
                ));
            }
        }

        if defaults.scripts.is_empty() {
            rows.push(self.note(
                "settings.projects.actions.empty",
                "No actions configured.".to_owned(),
                false,
            ));
        }
        for script in &defaults.scripts {
            let mut badges = vec![script.command.clone()];
            if script.run_on_worktree_create {
                badges.push("setup".to_owned());
            }
            if script.run_on_settle {
                badges.push("on settle".to_owned());
            }
            if script.preview_url.is_some() {
                badges.push("preview \u{b7} desktop only".to_owned());
            }
            let edit = script.clone();
            rows.push(settings_row(
                &script.name,
                Some(&badges.join(" \u{b7} ")),
                self.button(
                    format!("settings.projects.{pid}.actions.{}.edit", script.id),
                    "Edit",
                    &format!("Edit {}", script.name),
                    false,
                    (!self.pending).then(|| {
                        cx.listener(move |view, _, window, cx| {
                            view.open_form(Some(edit.clone()), window, cx);
                        })
                    }),
                ),
                &self.tokens,
                &self.geometry,
            ));
        }
        if matches!(file_state, Some(FileState::Invalid)) {
            rows.push(self.note(
                "settings.projects.t3-invalid",
                "t3.json is invalid. A t3.json exists in this checkout but fails to parse, so every action and icon it declares is ignored. Check the JSON syntax and icon values."
                    .to_owned(),
                true,
            ));
        }
        settings_section("Actions", rows, &self.tokens, &self.geometry).into_any_element()
    }

    fn workspace_section(
        &self,
        project: &ProjectShell,
        defaults: &Defaults,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let pid = project.id.clone();
        let mut choices = div().flex().flex_row().items_center().gap(px(6.0));
        if defaults.env_mode_source == Source::Project {
            choices = choices.child(self.button(
                format!("settings.projects.{pid}.workspace.reset"),
                "Use device setting",
                "Use the device's workspace setting for this project",
                false,
                (!self.pending).then(|| cx.listener(|view, _, _, cx| view.set_env_mode(None, cx))),
            ));
        }
        for (mode, label) in ENV_MODES {
            choices =
                choices.child(self.button(
                    format!("settings.projects.{pid}.workspace.{mode}"),
                    label,
                    &format!("Workspace: {label}"),
                    defaults.env_mode.as_deref() == Some(mode),
                    (!self.pending).then(|| {
                        cx.listener(move |view, _, _, cx| view.set_env_mode(Some(mode), cx))
                    }),
                ));
        }
        let description = match defaults.env_mode_source {
            Source::Project => "Where new threads in this project start.",
            Source::Device => {
                "Where new threads in this project start. Follows the device setting."
            }
        };
        settings_section(
            "New threads",
            vec![settings_row(
                "Workspace",
                Some(description),
                choices.into_any_element(),
                &self.tokens,
                &self.geometry,
            )],
            &self.tokens,
            &self.geometry,
        )
        .into_any_element()
    }

    fn detail_page(&self, id: &str, cx: &mut Context<'_, Self>) -> AnyElement {
        let mut page = div()
            .id("settings-project-page")
            .flex()
            .flex_col()
            .gap(px(20.0))
            .w_full();
        let name = self
            .shell(id)
            .map(|p| p.title.clone())
            .or_else(|| {
                self.projects
                    .iter()
                    .find(|p| p.id == id)
                    .map(|p| p.name.clone())
            })
            .unwrap_or_else(|| id.to_owned());
        let back = self.button(
            "settings.projects.back".to_owned(),
            "All projects",
            "Back to all projects",
            false,
            Some(cx.listener(|view, _, _, cx| {
                view.close_detail();
                cx.notify();
            })),
        );
        page = page.child(settings_section(
            &name,
            vec![settings_row(
                "Project",
                Some("Name, icon and removal belong to Orbit."),
                back,
                &self.tokens,
                &self.geometry,
            )],
            &self.tokens,
            &self.geometry,
        ));

        let (Some(project), true) = (self.shell(id), self.config.is_loaded()) else {
            return page
                .child(settings_section(
                    "Settings",
                    vec![self.note(
                        "settings.projects.waiting",
                        "Connect an environment to change this project's settings.".to_owned(),
                        false,
                    )],
                    &self.tokens,
                    &self.geometry,
                ))
                .into_any_element();
        };
        let Some(defaults) = self.defaults(project) else {
            return page.into_any_element();
        };
        page = page.child(self.workspace_section(project, &defaults, cx));
        if let Some(form) = &self.form {
            page = page.child(self.form_section(form, cx));
        }
        page = page.child(self.actions_section(project, &defaults, cx));
        if let Some(error) = self.error.clone() {
            page = page.child(settings_section(
                "Not saved",
                vec![self.note("settings.projects.error", error, true)],
                &self.tokens,
                &self.geometry,
            ));
        }
        page.into_any_element()
    }
}

impl Render for ProjectsView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        if let Some(id) = self.detail.clone() {
            return self.detail_page(&id, cx);
        }
        let tokens = self.tokens.clone();
        let geometry = self.geometry;
        let mut rows: Vec<AnyElement> = Vec::new();
        if self.projects.is_empty() {
            rows.push(settings_row(
                "No projects",
                Some("Projects come from Orbit. Open one there to configure it here."),
                div().into_any_element(),
                &tokens,
                &geometry,
            ));
        }
        for project in &self.projects {
            let id = project.id.clone();
            let summary = self.summary(&id);
            let open_id = id.clone();
            let controls = div().flex().flex_row().gap(px(6.0)).child(styled_button(
                &tokens,
                format!("settings.projects.{id}.open"),
                "Settings",
                &format!("Settings of {}", project.name),
                false,
                Some(cx.listener(move |view, _, _, cx| view.open_detail(open_id.clone(), cx))),
            ));
            // Keyed by project id: two projects may share a name.
            let row = settings_row(
                &project.name,
                Some(&summary),
                controls.into_any_element(),
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
                Some("Choose a project to set where its new threads start and edit its actions. A project's setting wins over the device setting."),
                div().into_any_element(),
                &tokens,
                &geometry,
            ))
            .child(settings_section("All projects", rows, &tokens, &geometry))
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use gpui_kit::test::{TestQueryExt as _, TestWindowExt as _};
    use gpui_kit::{
        AnyWindowHandle, Bounds, Point, TestAppContext, WindowBounds, WindowOptions, size,
    };

    use super::*;
    use crate::theme::apply_kit_theme;

    fn config() -> Arc<ServerConfigState> {
        let mut snapshot: Value = serde_json::from_str(include_str!(
            "../../../../../../crates/conn-state/tests/fixtures/server-config-snapshot.json"
        ))
        .expect("fixture is JSON");
        snapshot["config"]["settings"]["defaultThreadEnvMode"] = json!("local");
        snapshot["config"]["settings"]["projectSettingsOverrides"] = json!({
            "p1": {
                "defaultThreadEnvMode": "worktree",
                "defaultProjectScripts": [
                    { "id": "dev", "name": "Dev server", "command": "npm run dev", "icon": "play",
                      "runOnWorktreeCreate": false, "previewUrl": "http://localhost:5173", "autoOpenPreview": false },
                    { "id": "setup", "name": "Setup", "command": "npm i", "icon": "build",
                      "runOnWorktreeCreate": true },
                ],
            },
        });
        let mut state = ServerConfigState::new();
        state.apply(serde_json::from_value(snapshot).expect("snapshot event"));
        Arc::new(state)
    }

    fn shell(id: &str, title: &str) -> ProjectShell {
        serde_json::from_value(json!({
            "id": id, "title": title, "workspaceRoot": format!("/w/{id}"),
            "defaultModelSelection": null, "scripts": [],
            "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
            "deletedAt": null
        }))
        .expect("project")
    }

    fn mount(cx: &mut TestAppContext) -> (AnyWindowHandle, Entity<ProjectsView>) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            let theme = conn_theme::theme_by_id("dark-ocean").expect("built-in theme");
            let tokens = Tokens::derive(&theme);
            apply_kit_theme(&tokens, cx);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Point::default(),
                    size(px(1200.0), px(3000.0)),
                ))),
                ..Default::default()
            };
            gpui_kit::open_window(options, cx, |window, cx| {
                window.activate_window();
                cx.new(|_| {
                    let mut view = ProjectsView::new(
                        tokens,
                        ShellGeometry::default(),
                        vec![
                            ScheduledTaskProjectOption {
                                id: "p1".to_owned(),
                                name: "Conn".to_owned(),
                            },
                            ScheduledTaskProjectOption {
                                id: "p2".to_owned(),
                                name: "Other".to_owned(),
                            },
                        ],
                        None,
                    );
                    view.shells = vec![shell("p1", "Conn"), shell("p2", "Other")];
                    view.config = config();
                    view
                })
            })
            .expect("window opens")
        })
    }

    fn has(cx: &mut TestAppContext, window: AnyWindowHandle, label: &str) -> bool {
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
            window.try_find_by_label(label).is_some()
        })
        .unwrap_or(false)
    }

    #[gpui_kit::test]
    fn the_list_opens_a_projects_page_and_offers_nothing_orbit_owns(cx: &mut TestAppContext) {
        let (window, view) = mount(cx);
        assert!(has(cx, window, "Settings of Conn"));
        assert!(has(cx, window, "Settings of Other"));
        cx.update(|cx| view.update(cx, |view, cx| view.open_detail("p1".to_owned(), cx)));
        assert!(has(cx, window, "Back to all projects"));
        assert!(has(cx, window, "Add action"));
        for orbit_owned in [
            "Rename",
            "Pin project",
            "Archive",
            "Remove project",
            "Choose icon",
        ] {
            assert!(!has(cx, window, orbit_owned), "{orbit_owned} is Orbit's");
        }
    }

    #[gpui_kit::test]
    fn the_workspace_default_reads_the_override_and_can_follow_the_device_again(
        cx: &mut TestAppContext,
    ) {
        let (window, view) = mount(cx);
        cx.update(|cx| view.update(cx, |view, cx| view.open_detail("p1".to_owned(), cx)));
        assert!(has(cx, window, "Workspace: New worktree"));
        assert!(has(cx, window, "Workspace: Current checkout"));
        assert!(has(
            cx,
            window,
            "Use the device's workspace setting for this project"
        ));
        cx.update(|cx| {
            view.update(cx, |view, cx| {
                view.close_detail();
                view.open_detail("p2".to_owned(), cx);
            });
        });
        assert!(
            !has(
                cx,
                window,
                "Use the device's workspace setting for this project"
            ),
            "p2 follows the device already"
        );
    }

    #[gpui_kit::test]
    fn actions_list_edit_and_validate_as_in_conn(cx: &mut TestAppContext) {
        let (window, view) = mount(cx);
        cx.update(|cx| view.update(cx, |view, cx| view.open_detail("p1".to_owned(), cx)));
        assert!(has(cx, window, "Edit Dev server"));
        assert!(has(cx, window, "Edit Setup"));
        assert!(has(cx, window, "Use device actions for this project"));

        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| {
                view.open_form(None, window, cx);
                view.submit(cx);
            });
        })
        .expect("window");
        assert!(has(cx, window, "Name is required."));
        assert!(has(cx, window, "Save action"));
        assert!(
            !has(cx, window, "Delete action"),
            "a new action has none to delete"
        );
        assert!(
            !has(
                cx,
                window,
                "Wait for it to finish before the agent starts: off"
            ),
            "only a setup action waits"
        );

        let setup = cx.update(|cx| {
            view.read(cx)
                .current_scripts()
                .into_iter()
                .find(|s| s.id == "setup")
        });
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| view.open_form(setup.clone(), window, cx));
        })
        .expect("window");
        assert!(has(cx, window, "Save changes"));
        assert!(has(
            cx,
            window,
            "Wait for it to finish before the agent starts: off"
        ));
        cx.update(|cx| {
            view.update(cx, |view, cx| {
                if let Some(form) = &mut view.form {
                    form.confirm_delete = true;
                }
                cx.notify();
            });
        });
        assert!(has(cx, window, "Delete action \"Setup\"?"));
    }

    #[gpui_kit::test]
    fn a_checkouts_t3_json_offers_its_missing_actions_and_flags_a_bad_file(
        cx: &mut TestAppContext,
    ) {
        let (window, view) = mount(cx);
        cx.update(|cx| view.update(cx, |view, cx| view.open_detail("p1".to_owned(), cx)));
        assert!(!has(cx, window, "Import scripts from t3.json"));
        cx.update(|cx| {
            view.update(cx, |view, cx| {
                view.file = FileLoad::Loaded(parse_file(
                    r#"{ "scripts": [
                        { "name": "Dev server", "command": "other" },
                        { "name": "Lint", "command": "npm run lint" }
                    ] }"#,
                ));
                view.show_import = true;
                cx.notify();
            });
        });
        assert!(has(cx, window, "Import scripts from t3.json"));
        assert!(has(cx, window, "Import Lint"));
        assert!(
            !has(cx, window, "Import Dev server"),
            "a same-named action counts as there"
        );
        cx.update(|cx| {
            view.update(cx, |view, cx| {
                view.file = FileLoad::Loaded(parse_file("{ nope"));
                cx.notify();
            });
        });
        assert!(has(
            cx,
            window,
            "t3.json is invalid. A t3.json exists in this checkout but fails to parse, so every action and icon it declares is ignored. Check the JSON syntax and icon values."
        ));
    }
}
