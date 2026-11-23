//! The provider instance editor behind Settings → Providers (`ProviderSettingsPanel.tsx`,
//! `ProviderInstanceCard.tsx`, `ProviderSettingsForm.tsx`, `AddProviderInstanceDialog.tsx`).
//!
//! Every edit is one `server.updateSettings` call carrying a `providerInstanceMutation` or a
//! model preference (`conn_state::provider_settings`,
//! `conn_state::model_preferences`). Writes go out one at a time, in order. The inputs commit
//! on Enter and on blur, like Conn's `DraftInput`, and follow the settings the server sends back.
//!
//! Drift from Conn: the accent color is gpui-component's `ColorPicker` (palette, HSL sliders
//! and hex) instead of a saturation plane, and it saves when its popover closes. Not ported:
//! the Codex managed runtime and the managed token broker (Conn Server providers sign in
//! through the Orbit AI router), and the ACP Registry, which the Conn Server does not serve.

use std::collections::VecDeque;

use conn_contract::{
    ServerSettings, ServerSettingsProviderInstancesValue as InstanceConfig,
    ServerSettingsProviderInstancesValueEnvironmentItem as EnvironmentVariable,
};
use conn_state::provider_auth::{ProviderSummary, StatusKey};
use conn_state::provider_settings::{
    self as settings_logic, Control, DRIVERS, DriverDef, EnvField, FieldDef, InstanceRow,
};
use conn_state::providers::ProviderGroup;
use gpui_kit::Focusable as _;
use gpui_kit::component::Colorize as _;
use gpui_kit::component::color_picker::{ColorPicker, ColorPickerEvent, ColorPickerState};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, FontWeight, Hsla, InteractiveElement as _,
    IntoElement, ParentElement as _, SharedString, Styled as _, Subscription, TestSupportExt as _,
    Window, div, px,
};
use serde_json::Value;

use super::{ProvidersView, settings_row, settings_section};
use crate::a11y::ConnA11yExt as _;
use crate::settings::controls::pill_switch;
use crate::theme::hsla;

/// What an input commits.
#[derive(Clone, Copy, Debug)]
pub(super) enum Commit {
    DisplayName,
    Field(&'static str),
    EnvField(&'static str),
    Variables,
    CustomModel,
}

/// A driver config field.
struct FieldRow {
    def: &'static FieldDef,
    input: Option<Entity<InputState>>,
}

/// A variable a driver asks for by name.
struct EnvFieldRow {
    def: &'static EnvField,
    input: Entity<InputState>,
}

/// An environment variable row of the generic Environment section.
struct VariableRow {
    key: u64,
    name: Entity<InputState>,
    value: Entity<InputState>,
    sensitive: bool,
    /// What the server sent, kept while the value input stays empty: a saved secret never
    /// shows, and leaving it empty keeps it.
    original: Option<EnvironmentVariable>,
}

/// The inputs of the instance being edited.
pub(super) struct Editor {
    pub(super) instance_id: String,
    display_name: Entity<InputState>,
    accent: Entity<ColorPickerState>,
    /// A color dragged in the open picker, saved when it closes.
    accent_pending: Option<String>,
    fields: Vec<FieldRow>,
    env_fields: Vec<EnvFieldRow>,
    variables: Vec<VariableRow>,
    /// The settings' variables the rows were built from.
    variables_stamp: String,
    next_key: u64,
    pub(super) model_filter: Entity<InputState>,
    pub(super) custom_model: Entity<InputState>,
    pub(super) adding_custom_model: bool,
    pub(super) custom_model_error: Option<&'static str>,
    _subscriptions: Vec<Subscription>,
}

/// The Add provider form.
pub(super) struct AddForm {
    driver: String,
    label: Entity<InputState>,
    accent: Entity<ColorPickerState>,
    instance_id: Entity<InputState>,
    error: Option<String>,
    _subscriptions: Vec<Subscription>,
}

/// Settings writes waiting their turn, and why the last one failed.
#[derive(Default)]
pub(super) struct WriteState {
    pending: bool,
    queue: VecDeque<Value>,
    error: Option<String>,
}

fn variables_stamp(variables: &[EnvironmentVariable]) -> String {
    serde_json::to_string(variables).unwrap_or_default()
}

/// `#rrggbb` of a picked color, opaque.
fn accent_hex(color: Hsla) -> String {
    Hsla { a: 1.0, ..color }.to_hex().to_ascii_lowercase()
}

fn accent_color(hex: Option<&str>) -> Option<Hsla> {
    conn_state::providers::normalize_accent_color(hex).and_then(|hex| Hsla::parse_hex(&hex).ok())
}

impl ProvidersView {
    fn settings(&self) -> Option<&ServerSettings> {
        self.config.settings()
    }

    /// The row and instance being edited, as the server's settings have them.
    pub(super) fn current_instance(
        &self,
        instance_id: &str,
    ) -> Option<(InstanceRow, InstanceConfig)> {
        let settings = self.settings()?;
        let show_cursor = self.config.provider("cursor").is_some();
        let row = settings_logic::instance_rows(settings, show_cursor, Some(instance_id))
            .into_iter()
            .find(|row| row.instance_id == instance_id)?;
        let instance = row
            .explicit
            .clone()
            .unwrap_or_else(|| settings_logic::blank_instance(&row.driver));
        Some((row, instance))
    }

    // --- writes -------------------------------------------------------------------------

    /// Queues one `server.updateSettings` request. The settings stream brings the result.
    pub(super) fn write_settings(&mut self, request: Value, cx: &mut Context<'_, Self>) {
        if self.connection.is_none() {
            return;
        }
        self.write.queue.push_back(request);
        self.send_next_write(cx);
    }

    fn send_next_write(&mut self, cx: &mut Context<'_, Self>) {
        if self.write.pending {
            return;
        }
        let (Some(connection), Some(request)) =
            (self.connection.clone(), self.write.queue.pop_front())
        else {
            return;
        };
        self.write.pending = true;
        self.write.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = connection.call_json("server.updateSettings", request).await;
            let _ = this.update(cx, |view, cx| {
                view.write.pending = false;
                if let Err(err) = result {
                    view.write.error = Some(format!(
                        "Could not update provider instance. {}",
                        conn_client::commands::format_client_error(&err)
                    ));
                }
                view.send_next_write(cx);
                cx.notify();
            });
        })
        .detach();
    }

    /// Applies `edit` to the instance and saves it when it changed. Turning off the instance
    /// text generation runs on also resets that selection (`updateInstance`).
    pub(super) fn update_instance(
        &mut self,
        instance_id: &str,
        edit: impl FnOnce(&InstanceConfig) -> InstanceConfig,
        cx: &mut Context<'_, Self>,
    ) {
        let Some((row, current)) = self.current_instance(instance_id) else {
            return;
        };
        let next = edit(&current);
        if next == current && row.explicit.is_some() {
            return;
        }
        let Some(settings) = self.settings() else {
            return;
        };
        let request = settings_logic::update_instance_request(
            settings,
            self.config.providers(),
            instance_id,
            &current,
            &next,
        );
        self.write_settings(request, cx);
    }

    /// The enable switch.
    pub(super) fn set_enabled(
        &mut self,
        instance_id: &str,
        enabled: bool,
        cx: &mut Context<'_, Self>,
    ) {
        self.update_instance(
            instance_id,
            |instance| settings_logic::with_enabled(instance, enabled),
            cx,
        );
    }

    pub(super) fn remove_instance(&mut self, instance_id: &str, cx: &mut Context<'_, Self>) {
        self.confirm_remove = None;
        if self.selected.as_deref() == Some(instance_id) {
            self.select(None, cx);
        }
        self.write_settings(settings_logic::remove_request(instance_id), cx);
    }

    fn commit(&mut self, what: Commit, window: &mut Window, cx: &mut Context<'_, Self>) {
        let Some(editor) = &self.editor else {
            return;
        };
        let instance_id = editor.instance_id.clone();
        match what {
            Commit::DisplayName => {
                let name = editor.display_name.read(cx).value().to_string();
                self.update_instance(
                    &instance_id,
                    |instance| settings_logic::with_display_name(instance, &name),
                    cx,
                );
            }
            Commit::Field(key) => {
                let Some(FieldRow {
                    def,
                    input: Some(input),
                    ..
                }) = editor.fields.iter().find(|f| f.def.key == key)
                else {
                    return;
                };
                let value = input.read(cx).value().to_string();
                let field = *def;
                // A saved secret never shows, so an empty box keeps it.
                if field.secret && value.is_empty() {
                    return;
                }
                self.update_instance(
                    &instance_id,
                    |instance| settings_logic::with_config_field(instance, field, &value),
                    cx,
                );
            }
            Commit::EnvField(name) => {
                let Some(row) = editor.env_fields.iter().find(|f| f.def.name == name) else {
                    return;
                };
                let value = row.input.read(cx).value().to_string();
                if value.is_empty() {
                    return;
                }
                self.update_instance(
                    &instance_id,
                    |instance| settings_logic::with_environment_field(instance, name, &value, true),
                    cx,
                );
            }
            Commit::Variables => self.commit_variables(&instance_id, cx),
            Commit::CustomModel => self.add_custom_model(window, cx),
        }
    }

    fn commit_variables(&mut self, instance_id: &str, cx: &mut Context<'_, Self>) {
        let Some(editor) = &self.editor else {
            return;
        };
        let rows: Vec<EnvironmentVariable> = editor
            .variables
            .iter()
            .map(|row| {
                let name = row.name.read(cx).value().trim().to_owned();
                let value = row.value.read(cx).value().to_string();
                match &row.original {
                    Some(original) if value.is_empty() => EnvironmentVariable {
                        name,
                        sensitive: Some(row.sensitive),
                        ..original.clone()
                    },
                    _ => settings_logic::variable(&name, &value, row.sensitive),
                }
            })
            .collect();
        let driver = settings_logic::driver_def(
            &self
                .current_instance(instance_id)
                .map(|(row, _)| row.driver)
                .unwrap_or_default(),
        );
        self.update_instance(
            instance_id,
            |instance| {
                let kept: Vec<EnvironmentVariable> = instance
                    .environment
                    .iter()
                    .flatten()
                    .filter(|variable| {
                        driver.is_some_and(|def| {
                            def.env_fields.iter().any(|f| f.name == variable.name)
                        })
                    })
                    .cloned()
                    .collect();
                settings_logic::with_environment(instance, kept.into_iter().chain(rows).collect())
            },
            cx,
        );
    }

    // --- editor inputs ------------------------------------------------------------------

    #[expect(
        clippy::too_many_arguments,
        reason = "an input needs its text, placeholder, mask, commit target and the window and subscription sinks"
    )]
    fn text_input(
        &mut self,
        text: &str,
        placeholder: &str,
        masked: bool,
        commit: Commit,
        subscriptions: &mut Vec<Subscription>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Entity<InputState> {
        let placeholder = placeholder.to_owned();
        let text = text.to_owned();
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(placeholder)
                .default_value(text)
                .masked(masked)
        });
        subscriptions.push(cx.subscribe_in(
            &input,
            window,
            move |view, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::PressEnter { .. } | InputEvent::Blur) {
                    view.commit(commit, window, cx);
                }
            },
        ));
        input
    }

    fn accent_picker(
        &mut self,
        hex: Option<&str>,
        for_editor: bool,
        subscriptions: &mut Vec<Subscription>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Entity<ColorPickerState> {
        let initial = accent_color(hex);
        let picker = cx.new(|cx| {
            let state = ColorPickerState::new(window, cx);
            match initial {
                Some(color) => state.default_value(color),
                None => state,
            }
        });
        if for_editor {
            subscriptions.push(cx.subscribe(
                &picker,
                |view, state, event: &ColorPickerEvent, cx| {
                    let ColorPickerEvent::Change(color) = event;
                    let hex = color.map(accent_hex).unwrap_or_default();
                    if state.read(cx).is_open() {
                        // A drag saves once, when the picker closes.
                        if let Some(editor) = &mut view.editor {
                            editor.accent_pending = Some(hex);
                        }
                    } else {
                        view.commit_accent(&hex, cx);
                    }
                },
            ));
            subscriptions.push(cx.observe(&picker, |view, state, cx| {
                if state.read(cx).is_open() {
                    return;
                }
                if let Some(hex) = view.editor.as_mut().and_then(|e| e.accent_pending.take()) {
                    view.commit_accent(&hex, cx);
                }
            }));
        } else {
            subscriptions.push(cx.subscribe(&picker, |_, _, _: &ColorPickerEvent, cx| cx.notify()));
        }
        picker
    }

    pub(super) fn commit_accent(&mut self, hex: &str, cx: &mut Context<'_, Self>) {
        let Some(editor) = &self.editor else {
            return;
        };
        let instance_id = editor.instance_id.clone();
        let hex = hex.to_owned();
        self.update_instance(
            &instance_id,
            |instance| settings_logic::with_accent_color(instance, &hex),
            cx,
        );
    }

    /// Builds the inputs of the selected instance, or follows the settings the server sent.
    pub(super) fn ensure_editor(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let Some(selected) = self.selected.clone() else {
            self.editor = None;
            return;
        };
        let Some((row, instance)) = self.current_instance(&selected) else {
            self.editor = None;
            return;
        };
        let def = settings_logic::driver_def(&row.driver);
        let stamp = def.map_or_else(String::new, |def| {
            variables_stamp(&settings_logic::generic_environment(&instance, def))
        });
        if let Some(editor) = &self.editor
            && editor.instance_id == selected
        {
            self.follow_settings(&instance, def, &stamp, window, cx);
            return;
        }
        let mut subs = Vec::new();
        let label = def.map_or(row.driver.as_str(), |def| def.label);
        let display_name = self.text_input(
            instance.display_name.as_deref().unwrap_or_default(),
            label,
            false,
            Commit::DisplayName,
            &mut subs,
            window,
            cx,
        );
        let accent = self.accent_picker(
            instance.accent_color.as_deref(),
            true,
            &mut subs,
            window,
            cx,
        );
        let mut fields = Vec::new();
        for field in def.map_or(&[][..], |def| def.fields) {
            let input = match field.control {
                Control::Select(_) => None,
                Control::Text | Control::Password => {
                    let text = if field.secret {
                        String::new()
                    } else {
                        settings_logic::config_string(&instance, field.key)
                    };
                    let placeholder = if field.secret
                        && settings_logic::config_secret_saved(&instance, field.key)
                    {
                        "Saved. Type to replace"
                    } else {
                        field.placeholder
                    };
                    Some(self.text_input(
                        &text,
                        placeholder,
                        field.control == Control::Password,
                        Commit::Field(field.key),
                        &mut subs,
                        window,
                        cx,
                    ))
                }
            };
            fields.push(FieldRow { def: field, input });
        }
        let mut env_fields = Vec::new();
        for field in def.map_or(&[][..], |def| def.env_fields) {
            let variable = settings_logic::environment_variable(&instance, field.name);
            let placeholder = if variable.is_some() {
                "Saved. Type to replace"
            } else {
                field.placeholder
            };
            let input = self.text_input(
                "",
                placeholder,
                true,
                Commit::EnvField(field.name),
                &mut subs,
                window,
                cx,
            );
            env_fields.push(EnvFieldRow { def: field, input });
        }
        let mut next_key = 0;
        let variables =
            self.build_variable_rows(&instance, def, &mut next_key, &mut subs, window, cx);
        let model_filter = cx.new(|cx| InputState::new(window, cx).placeholder("Filter models"));
        subs.push(cx.subscribe(&model_filter, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        }));
        // Adds on Enter or Add only: leaving the field for Cancel must not save it.
        let placeholder = custom_model_placeholder(&row.driver);
        let custom_model = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
        subs.push(cx.subscribe_in(
            &custom_model,
            window,
            |view, _, event: &InputEvent, window, cx| match event {
                InputEvent::PressEnter { .. } => view.commit(Commit::CustomModel, window, cx),
                InputEvent::Change => {
                    if let Some(editor) = &mut view.editor
                        && editor.custom_model_error.take().is_some()
                    {
                        cx.notify();
                    }
                }
                _ => {}
            },
        ));
        self.editor = Some(Editor {
            instance_id: selected,
            display_name,
            accent,
            accent_pending: None,
            fields,
            env_fields,
            variables,
            variables_stamp: stamp,
            next_key,
            model_filter,
            custom_model,
            adding_custom_model: false,
            custom_model_error: None,
            _subscriptions: subs,
        });
    }

    fn build_variable_rows(
        &mut self,
        instance: &InstanceConfig,
        def: Option<&'static DriverDef>,
        next_key: &mut u64,
        subs: &mut Vec<Subscription>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Vec<VariableRow> {
        let variables = def.map_or_else(
            || instance.environment.clone().unwrap_or_default(),
            |def| settings_logic::generic_environment(instance, def),
        );
        variables
            .into_iter()
            .map(|variable| {
                let key = *next_key;
                *next_key += 1;
                let saved_secret =
                    variable.value_redacted == Some(true) || variable.secret.is_some();
                let shown = if variable.sensitive == Some(true) || saved_secret {
                    String::new()
                } else {
                    variable.value.clone().unwrap_or_default()
                };
                let sensitive = variable.sensitive == Some(true) || saved_secret;
                let name = self.text_input(
                    &variable.name,
                    "NAME",
                    false,
                    Commit::Variables,
                    subs,
                    window,
                    cx,
                );
                let placeholder = if saved_secret {
                    "Saved. Type to replace"
                } else {
                    "value"
                };
                let value = self.text_input(
                    &shown,
                    placeholder,
                    sensitive,
                    Commit::Variables,
                    subs,
                    window,
                    cx,
                );
                VariableRow {
                    key,
                    name,
                    value,
                    sensitive,
                    original: Some(variable),
                }
            })
            .collect()
    }

    /// The server's settings changed: show them in every input that is not being typed in.
    fn follow_settings(
        &mut self,
        instance: &InstanceConfig,
        def: Option<&'static DriverDef>,
        stamp: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(editor) = &self.editor else {
            return;
        };
        let mut sync = |input: &Entity<InputState>, expected: &str, cx: &mut Context<'_, Self>| {
            let focused = input.read(cx).focus_handle(cx).is_focused(window);
            if !focused && input.read(cx).value() != expected {
                input.update(cx, |state, cx| {
                    state.set_value(expected.to_owned(), window, cx)
                });
            }
        };
        sync(
            &editor.display_name,
            instance.display_name.as_deref().unwrap_or_default(),
            cx,
        );
        for row in &editor.fields {
            if let Some(input) = &row.input
                && !row.def.secret
            {
                sync(
                    input,
                    &settings_logic::config_string(instance, row.def.key),
                    cx,
                );
            }
        }
        let accent = editor.accent.clone();
        let accent_idle = editor.accent_pending.is_none() && !accent.read(cx).is_open();
        let saved_accent = accent_color(instance.accent_color.as_deref());
        if accent_idle && accent.read(cx).value() != saved_accent {
            accent.update(cx, |state, cx| match saved_accent {
                Some(color) => state.set_value(color, window, cx),
                None => state.clear_value(window, cx),
            });
        }
        if editor.variables_stamp != stamp {
            let any_focused = editor.variables.iter().any(|row| {
                row.name.read(cx).focus_handle(cx).is_focused(window)
                    || row.value.read(cx).focus_handle(cx).is_focused(window)
            });
            if !any_focused {
                let mut subs = Vec::new();
                let mut next_key = editor.next_key;
                let rows =
                    self.build_variable_rows(instance, def, &mut next_key, &mut subs, window, cx);
                if let Some(editor) = &mut self.editor {
                    editor.variables = rows;
                    editor.variables_stamp = stamp.to_owned();
                    editor.next_key = next_key;
                    editor._subscriptions.extend(subs);
                }
            }
        }
    }

    fn add_variable(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let mut subs = Vec::new();
        let key = self.editor.as_ref().map_or(0, |e| e.next_key);
        let name = self.text_input("", "NAME", false, Commit::Variables, &mut subs, window, cx);
        let value = self.text_input("", "value", false, Commit::Variables, &mut subs, window, cx);
        if let Some(editor) = &mut self.editor {
            editor.next_key = key + 1;
            editor.variables.push(VariableRow {
                key,
                name: name.clone(),
                value,
                sensitive: false,
                original: None,
            });
            editor._subscriptions.extend(subs);
        }
        name.update(cx, |input, cx| input.focus(window, cx));
        cx.notify();
    }

    fn remove_variable(&mut self, key: u64, window: &mut Window, cx: &mut Context<'_, Self>) {
        if let Some(editor) = &mut self.editor {
            editor.variables.retain(|row| row.key != key);
        }
        self.commit(Commit::Variables, window, cx);
        cx.notify();
    }

    fn toggle_variable_sensitive(
        &mut self,
        key: u64,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if let Some(editor) = &mut self.editor
            && let Some(row) = editor.variables.iter_mut().find(|row| row.key == key)
        {
            row.sensitive = !row.sensitive;
        }
        self.commit(Commit::Variables, window, cx);
        cx.notify();
    }

    fn pick_option(
        &mut self,
        instance_id: &str,
        field: &'static FieldDef,
        value: &'static str,
        cx: &mut Context<'_, Self>,
    ) {
        self.update_instance(
            instance_id,
            |instance| settings_logic::with_config_field(instance, field, value),
            cx,
        );
    }

    fn clear_secret(
        &mut self,
        instance_id: &str,
        field: &'static FieldDef,
        cx: &mut Context<'_, Self>,
    ) {
        self.update_instance(
            instance_id,
            |instance| settings_logic::with_config_field(instance, field, ""),
            cx,
        );
    }

    fn clear_env_field(
        &mut self,
        instance_id: &str,
        name: &'static str,
        cx: &mut Context<'_, Self>,
    ) {
        self.update_instance(
            instance_id,
            |instance| settings_logic::with_environment_field(instance, name, "", true),
            cx,
        );
    }

    // --- Add provider -------------------------------------------------------------------

    /// The drivers Add provider offers: all but the ACP Registry.
    fn addable_drivers() -> Vec<&'static DriverDef> {
        DRIVERS
            .iter()
            .filter(|def| def.kind != "acpRegistry")
            .collect()
    }

    pub(super) fn open_add_form(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let Some(first) = Self::addable_drivers().first().copied() else {
            return;
        };
        let driver = first.kind.to_owned();
        let mut subs = Vec::new();
        let label = cx.new(|cx| InputState::new(window, cx).placeholder(first.label));
        let accent = self.accent_picker(None, false, &mut subs, window, cx);
        let instance_id = cx.new(|cx| InputState::new(window, cx).placeholder(first.kind));
        for input in [&label, &instance_id] {
            subs.push(cx.subscribe(input, |_, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            }));
        }
        self.adding = Some(AddForm {
            driver,
            label,
            accent,
            instance_id,
            error: None,
            _subscriptions: subs,
        });
        cx.notify();
    }

    /// The id the form would create: the typed one, else one derived from the label.
    fn add_form_id(&self, form: &AddForm, cx: &gpui_kit::App) -> String {
        let typed = form.instance_id.read(cx).value().trim().to_owned();
        if !typed.is_empty() {
            return typed;
        }
        let existing = self.existing_instance_ids();
        let existing: Vec<&str> = existing.iter().map(String::as_str).collect();
        settings_logic::derive_available_instance_id(
            &form.driver,
            form.label.read(cx).value().trim(),
            &existing,
        )
    }

    fn existing_instance_ids(&self) -> Vec<String> {
        // Codex and Claude run before they are configured, so their ids are taken.
        let mut ids: Vec<String> = vec!["codex".to_owned(), "claudeAgent".to_owned()];
        ids.extend(
            self.config
                .catalog()
                .instances
                .iter()
                .map(|info| info.instance_id.clone()),
        );
        if let Some(settings) = self.settings() {
            ids.extend(
                settings
                    .provider_instances
                    .iter()
                    .flatten()
                    .map(|(id, _)| id.clone()),
            );
        }
        ids
    }

    fn submit_add_form(&mut self, cx: &mut Context<'_, Self>) {
        let Some(form) = &self.adding else {
            return;
        };
        let id = self.add_form_id(form, cx);
        let existing = self.existing_instance_ids();
        let existing: Vec<&str> = existing.iter().map(String::as_str).collect();
        if let Err(message) = settings_logic::validate_instance_id(&id, &existing) {
            if let Some(form) = &mut self.adding {
                form.error = Some(message);
            }
            cx.notify();
            return;
        }
        let accent = form
            .accent
            .read(cx)
            .value()
            .map(accent_hex)
            .unwrap_or_default();
        let instance = settings_logic::new_instance(
            &form.driver,
            form.label.read(cx).value().as_ref(),
            &accent,
            (form.driver == "codex").then(|| serde_json::json!({ "setupMode": "existing" })),
        );
        self.adding = None;
        self.write_settings(settings_logic::create_request(&id, &instance), cx);
        self.select(Some(id), cx);
    }

    // --- rendering ----------------------------------------------------------------------

    fn dot(&self, key: StatusKey) -> gpui_kit::Div {
        div().size(px(8.0)).rounded_full().bg(self.dot_color(key))
    }

    /// One provider instance in the list (`ProviderInstanceCard` in list mode).
    pub(super) fn instance_row(
        &self,
        row: &InstanceRow,
        group: Option<&ProviderGroup>,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = &self.tokens;
        let id = row.instance_id.clone();
        let instance = row
            .explicit
            .clone()
            .unwrap_or_else(|| settings_logic::blank_instance(&row.driver));
        let enabled = settings_logic::resolve_instance_enabled(&instance);
        let def = settings_logic::driver_def(&row.driver);
        let name = settings_logic::instance_label(&instance);
        let (key, headline, detail) = match group {
            Some(group) if enabled => {
                let summary = ProviderSummary::of(group);
                (summary.key, summary.headline, summary.detail)
            }
            _ => (StatusKey::Disabled, "Disabled".to_owned(), None),
        };
        let selected = self.selected.as_deref() == Some(id.as_str());
        let refreshing = self.refreshing.contains(&id);
        let confirming = self.confirm_remove.as_deref() == Some(id.as_str());

        let title = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .child(crate::icons::provider_mark(
                &row.driver,
                16.0,
                hsla(tokens.foreground),
            ))
            .child(self.dot(key))
            .child(div().child(name.clone()))
            .when(!row.is_default, |el| {
                el.child(
                    div()
                        .text_size(px(12.0))
                        .font_weight(FontWeight::NORMAL)
                        .text_color(hsla(tokens.muted_foreground_raised))
                        .child(id.clone()),
                )
            })
            .when_some(group.and_then(|g| g.version.clone()), |el, version| {
                el.child(
                    div()
                        .text_size(px(12.0))
                        .font_weight(FontWeight::NORMAL)
                        .text_color(hsla(tokens.muted_foreground_raised))
                        .child(format!("v{version}")),
                )
            });
        let description = if confirming {
            let provider = def.map_or(row.driver.as_str(), |def| def.label);
            if row.is_default {
                let turns_off = settings_logic::reset_turns_off(&instance);
                format!(
                    "Reset the {provider} provider to its defaults?{}",
                    if turns_off {
                        " It will also be turned off."
                    } else {
                        ""
                    }
                )
            } else {
                format!("Remove the {name} provider instance?")
            }
        } else {
            match detail {
                Some(detail) => format!("{headline} \u{b7} {detail}"),
                None => headline,
            }
        };

        let mut trailing = div().flex().flex_row().items_center().gap(px(8.0));
        if confirming {
            let confirm_id = id.clone();
            trailing = trailing
                .child(self.button(
                    format!("settings.providers.{id}.remove-confirm"),
                    if row.is_default { "Reset" } else { "Remove" },
                    true,
                    (!self.write.pending).then(|| {
                        cx.listener(move |view, _, _, cx| view.remove_instance(&confirm_id, cx))
                    }),
                ))
                .child(self.button(
                    format!("settings.providers.{id}.remove-keep"),
                    "Keep",
                    false,
                    Some(cx.listener(|view, _, _, cx| {
                        view.confirm_remove = None;
                        cx.notify();
                    })),
                ));
        } else {
            let toggle_id = id.clone();
            let switch = pill_switch(
                SharedString::from(format!("conn-settings-provider-{id}-enabled")),
                enabled,
                tokens,
                {
                    let handle = cx.entity().downgrade();
                    move |_, cx| {
                        if let Some(view) = handle.upgrade() {
                            view.update(cx, |view, cx| view.set_enabled(&toggle_id, !enabled, cx));
                        }
                    }
                },
            );
            let select_id = id.clone();
            let refresh_id = id.clone();
            let remove_id = id.clone();
            trailing = trailing
                .child(switch)
                .child(self.button(
                    format!("settings.providers.{id}.edit"),
                    if selected { "Close" } else { "Edit" },
                    false,
                    Some(cx.listener(move |view, _, _, cx| {
                        let next = (view.selected.as_deref() != Some(select_id.as_str()))
                            .then(|| select_id.clone());
                        view.select(next, cx);
                    })),
                ))
                .child(self.button(
                    format!("settings.providers.{id}.refresh"),
                    if refreshing {
                        "Refreshing..."
                    } else {
                        "Refresh"
                    },
                    false,
                    (!refreshing).then(|| {
                        cx.listener(move |view, _, _, cx| {
                            view.refresh(Some(refresh_id.clone()), cx)
                        })
                    }),
                ));
            if !row.is_default || row.is_dirty {
                trailing = trailing.child(self.button(
                    format!("settings.providers.{id}.remove"),
                    if row.is_default { "Reset" } else { "Delete" },
                    false,
                    Some(cx.listener(move |view, _, _, cx| {
                        view.confirm_remove = Some(remove_id.clone());
                        cx.notify();
                    })),
                ));
            }
        }
        div()
            .id(SharedString::from(format!("settings.providers.{id}")))
            .a11y_group(format!("settings.providers.{id}"), name)
            .flex()
            .flex_row()
            .items_start()
            .justify_between()
            .gap(px(16.0))
            .w_full()
            .px(px(14.0))
            .py(px(12.0))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(px(2.0))
                    .child(
                        div()
                            .text_size(px(self.geometry.ui_font_size_px))
                            .line_height(px(self.geometry.ui_line_height_px))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(hsla(tokens.foreground))
                            .child(title),
                    )
                    .child(self.muted_line(description)),
            )
            .child(div().flex_shrink_0().child(trailing))
            .into_any_element()
    }

    pub(super) fn input_box(&self, input: &Entity<InputState>) -> AnyElement {
        div()
            .w(px(260.0))
            .child(Input::new(input))
            .into_any_element()
    }

    /// The sections of the instance being edited.
    pub(super) fn editor_sections(
        &mut self,
        group: Option<&ProviderGroup>,
        cx: &mut Context<'_, Self>,
    ) -> Vec<AnyElement> {
        let Some(selected) = self.selected.clone() else {
            return Vec::new();
        };
        let Some((row, instance)) = self.current_instance(&selected) else {
            return Vec::new();
        };
        let tokens = self.tokens.clone();
        let geometry = self.geometry;
        let name = settings_logic::instance_label(&instance);
        let enabled = settings_logic::resolve_instance_enabled(&instance);
        let ax = |suffix: &str| format!("settings.providers.{selected}.{suffix}");
        let mut sections = Vec::new();

        // Identity.
        let summary = group.map(ProviderSummary::of);
        let mut identity = Vec::new();
        identity.push(settings_row(
            "Status",
            summary
                .as_ref()
                .filter(|_| enabled)
                .map(|s| match &s.detail {
                    Some(detail) => format!("{} \u{b7} {detail}", s.headline),
                    None => s.headline.clone(),
                })
                .as_deref()
                .or(Some(if enabled {
                    "Waiting for the server to report installation and authentication details."
                } else {
                    "Disabled"
                })),
            div().into_any_element(),
            &tokens,
            &geometry,
        ));
        if let Some(editor) = &self.editor {
            let has_accent = instance.accent_color.is_some();
            identity.push(settings_row(
                "Display name",
                None,
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        div()
                            .id(SharedString::from(ax("accent")))
                            .a11y_group(ax("accent"), format!("Accent color for {name}"))
                            .child(
                                ColorPicker::new(&editor.accent)
                                    .accessibility_label(format!("Accent color for {name}")),
                            )
                            .test_support(),
                    )
                    .when(has_accent, |el| {
                        el.child(self.button(
                            ax("accent.clear"),
                            "Clear color",
                            false,
                            Some(cx.listener(|view, _, _, cx| view.commit_accent("", cx))),
                        ))
                    })
                    .child(self.input_box(&editor.display_name))
                    .into_any_element(),
                &tokens,
                &geometry,
            ));
        }
        sections.push(settings_section(&name, identity, &tokens, &geometry).into_any_element());

        // Setup: Antigravity's enable button and credential check, and the driver's own
        // variables.
        let mut setup = Vec::new();
        if row.driver == "antigravity" {
            let enable_id = selected.clone();
            let environment = self.environment_label.clone();
            setup.push(settings_row(
                "Environment",
                Some("Device that runs this provider."),
                div()
                    .flex()
                    .flex_col()
                    .items_end()
                    .gap(px(8.0))
                    .child(self.muted_line(environment))
                    .when(!enabled, |el| {
                        el.child(self.button(
                            ax("enable"),
                            "Enable Antigravity",
                            false,
                            (!self.write.pending).then(|| {
                                cx.listener(move |view, _, _, cx| {
                                    view.update_instance(
                                        &enable_id,
                                        |i| settings_logic::with_enabled(i, true),
                                        cx,
                                    );
                                })
                            }),
                        ))
                    })
                    .into_any_element(),
                &tokens,
                &geometry,
            ));
        }
        if let Some(group) = group.filter(|g| conn_state::provider_auth::offers_credential_check(g))
        {
            setup.extend(self.account_rows(group, cx));
        }
        if let Some(editor) = &self.editor {
            for field_row in &editor.env_fields {
                let field = field_row.def;
                let name = field.name;
                let variable = settings_logic::environment_variable(&instance, name);
                let saved = variable.is_some();
                let control = {
                    let clear_id = selected.clone();
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.0))
                        .child(self.input_box(&field_row.input))
                        .when(saved, |el| {
                            el.child(self.button(
                                ax(&format!("env.{name}.clear")),
                                "Clear",
                                false,
                                Some(cx.listener(move |view, _, _, cx| {
                                    view.clear_env_field(&clear_id, name, cx)
                                })),
                            ))
                        })
                        .into_any_element()
                };
                setup.push(settings_row(
                    field.label,
                    Some(field.description),
                    control,
                    &tokens,
                    &geometry,
                ));
            }
        }
        if !setup.is_empty() {
            sections.push(settings_section("Setup", setup, &tokens, &geometry).into_any_element());
        }

        // Runtime: the driver's settings fields.
        if let Some(editor) = &self.editor
            && !editor.fields.is_empty()
        {
            let mut runtime = Vec::new();
            for field_row in &editor.fields {
                let field: &'static FieldDef = field_row.def;
                let control = match (field.control, &field_row.input) {
                    (Control::Select(options), _) => {
                        let current = settings_logic::config_string(&instance, field.key);
                        let current = if current.is_empty() {
                            options.first().map_or("", |(value, _)| *value).to_owned()
                        } else {
                            current
                        };
                        let mut group = div()
                            .flex()
                            .flex_row()
                            .flex_wrap()
                            .justify_end()
                            .gap(px(6.0));
                        for (value, label) in options {
                            let option_id = selected.clone();
                            let value: &'static str = value;
                            group = group.child(self.button(
                                ax(&format!("field.{}.{value}", field.key)),
                                label,
                                current == value,
                                (!self.write.pending).then(|| {
                                    cx.listener(move |view, _, _, cx| {
                                        view.pick_option(&option_id, field, value, cx);
                                    })
                                }),
                            ));
                        }
                        group.into_any_element()
                    }
                    (_, Some(input)) => {
                        let saved = field.secret
                            && settings_logic::config_secret_saved(&instance, field.key);
                        let clear_id = selected.clone();
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.0))
                            .child(self.input_box(input))
                            .when(saved, |el| {
                                el.child(self.button(
                                    ax(&format!("field.{}.clear", field.key)),
                                    "Clear",
                                    false,
                                    Some(cx.listener(move |view, _, _, cx| {
                                        view.clear_secret(&clear_id, field, cx);
                                    })),
                                ))
                            })
                            .into_any_element()
                    }
                    _ => div().into_any_element(),
                };
                let description = (!field.description.is_empty()).then_some(field.description);
                runtime.push(settings_row(
                    field.title,
                    description,
                    control,
                    &tokens,
                    &geometry,
                ));
            }
            sections
                .push(settings_section("Runtime", runtime, &tokens, &geometry).into_any_element());
        }

        // Environment: free-form variables.
        if let Some(editor) = &self.editor {
            let mut rows = Vec::new();
            for variable in &editor.variables {
                let key = variable.key;
                let vax = ax(&format!("var.{key}"));
                let value = div()
                    .flex_1()
                    .min_w_0()
                    .child(Input::new(&variable.value))
                    .into_any_element();
                let line = div()
                    .id(SharedString::from(vax.clone()))
                    .a11y_group(vax.clone(), "Environment variable")
                    .flex()
                    .flex_row()
                    .items_start()
                    .gap(px(8.0))
                    .px(px(14.0))
                    .py(px(10.0))
                    .child(div().w(px(180.0)).child(Input::new(&variable.name)))
                    .child(div().flex_1().min_w_0().child(value))
                    .child(self.button(
                        format!("{vax}.sensitive"),
                        if variable.sensitive {
                            "Sensitive"
                        } else {
                            "Plain text"
                        },
                        variable.sensitive,
                        Some(cx.listener(move |view, _, window, cx| {
                            view.toggle_variable_sensitive(key, window, cx)
                        })),
                    ))
                    .child(self.button(
                        format!("{vax}.remove"),
                        "Remove",
                        false,
                        Some(cx.listener(move |view, _, window, cx| {
                            view.remove_variable(key, window, cx)
                        })),
                    ));
                rows.push(line.into_any_element());
            }
            rows.push(settings_row(
                "Variables",
                Some("API keys, base URLs, and other per-instance CLI settings. Sensitive values are stored separately and never returned to the app."),
                self.button(
                    ax("var.add"),
                    "Add variable",
                    false,
                    Some(cx.listener(|view, _, window, cx| view.add_variable(window, cx))),
                ),
                &tokens,
                &geometry,
            ));
            sections
                .push(settings_section("Environment", rows, &tokens, &geometry).into_any_element());
        }

        // Models: favorites, hidden models, order and custom models.
        if settings_logic::driver_def(&row.driver).is_some()
            && let Some(models) = self.models_section(&selected, &row.driver, &instance, group, cx)
        {
            sections.push(models);
        }
        sections
    }

    /// Add provider (`AddProviderInstanceDialog`), as a section above the list.
    pub(super) fn add_form_section(&self, cx: &mut Context<'_, Self>) -> Option<AnyElement> {
        let form = self.adding.as_ref()?;
        let tokens = self.tokens.clone();
        let geometry = self.geometry;
        let id = self.add_form_id(form, cx);
        let existing = self.existing_instance_ids();
        let existing: Vec<&str> = existing.iter().map(String::as_str).collect();
        let id_error = settings_logic::validate_instance_id(&id, &existing).err();
        let mut drivers = div().flex().flex_row().flex_wrap().gap(px(6.0));
        for def in Self::addable_drivers() {
            let kind = def.kind;
            drivers = drivers.child(self.button(
                format!("settings.providers.add.driver.{kind}"),
                def.label,
                form.driver == kind,
                Some(cx.listener(move |view, _, _, cx| {
                    if let Some(form) = &mut view.adding {
                        form.driver = kind.to_owned();
                        form.error = None;
                    }
                    cx.notify();
                })),
            ));
        }
        let mut rows = vec![
            settings_row(
                "Provider",
                None,
                div().into_any_element(),
                &tokens,
                &geometry,
            ),
            div()
                .px(px(14.0))
                .pb(px(12.0))
                .child(drivers)
                .into_any_element(),
            settings_row(
                "Name",
                Some("Shown in the model picker."),
                self.input_box(&form.label),
                &tokens,
                &geometry,
            ),
            settings_row(
                "Accent color",
                Some("Optional. Tells accounts of one provider apart."),
                div()
                    .id("settings.providers.add.accent")
                    .a11y_group("settings.providers.add.accent", "Accent color")
                    .child(ColorPicker::new(&form.accent).accessibility_label("Accent color"))
                    .into_any_element(),
                &tokens,
                &geometry,
            ),
            settings_row(
                "Instance ID",
                Some(&format!("Letters, digits, '-' and '_'. Now: {id}")),
                self.input_box(&form.instance_id),
                &tokens,
                &geometry,
            ),
        ];
        let message = form
            .error
            .clone()
            .or(id_error.filter(|_| !id.is_empty() || form.error.is_some()));
        if let Some(message) = message {
            rows.push(self.note_row(message, true, "settings.providers.add.error"));
        }
        rows.push(
            div()
                .flex()
                .flex_row()
                .justify_end()
                .gap(px(8.0))
                .px(px(14.0))
                .py(px(12.0))
                .child(self.button(
                    "settings.providers.add.cancel".to_owned(),
                    "Cancel",
                    false,
                    Some(cx.listener(|view, _, _, cx| {
                        view.adding = None;
                        cx.notify();
                    })),
                ))
                .child(
                    self.button(
                        "settings.providers.add.submit".to_owned(),
                        "Add provider",
                        true,
                        (!self.write.pending)
                            .then(|| cx.listener(|view, _, _, cx| view.submit_add_form(cx))),
                    ),
                )
                .into_any_element(),
        );
        Some(settings_section("Add provider", rows, &tokens, &geometry).into_any_element())
    }

    /// The note under the list: a failed write, if any.
    pub(super) fn write_error_row(&self) -> Option<AnyElement> {
        self.write
            .error
            .clone()
            .map(|message| self.note_row(message, true, "settings.providers.write-error"))
    }
}

/// `CUSTOM_MODEL_PLACEHOLDER_BY_KIND`.
fn custom_model_placeholder(driver: &str) -> &'static str {
    match driver {
        "codex" => "gpt-6.7-codex-ultra-preview",
        "claudeAgent" => "claude-sonnet-5",
        "cursor" => "claude-sonnet-4-6",
        "opencode" => "openai/gpt-5",
        "pi" => "anthropic/claude-sonnet-5",
        _ => "model-slug",
    }
}
