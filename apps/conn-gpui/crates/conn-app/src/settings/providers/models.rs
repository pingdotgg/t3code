//! The Models section of a provider instance (`ProviderModelsSection.tsx`): favorites, the
//! models shown in the picker, their order, and custom models. Preferences are saved on the
//! environment and shared by every client (`conn_state::model_preferences`).
//!
//! A custom model's pencil opens Conn's `CustomModelEditor` under its row: its display name and
//! the options the composer shows for it. The form lives in `conn_state::custom_model_editor`.
//!
//! Drift from Conn: a driver's known options, an option's type and `Copy from...` are rows of
//! buttons, not dropdowns, as everywhere else on these pages; Escape cancels while an input of
//! the form has focus.

use conn_contract::ServerSettingsProviderInstancesValue as InstanceConfig;
use conn_state::custom_model_editor::{Descriptor, Draft, OptionKind};
use conn_state::model_preferences::{
    self as prefs, MODEL_FILTER_THRESHOLD, ModelEntry, ModelGroup, ModelRow,
};
use conn_state::providers::ProviderGroup;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    KeyDownEvent, ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, TestSupportExt as _, Window, div, px,
};

use super::{ProvidersView, settings_section};
use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome::ConnTooltipExt as _;
use crate::settings::controls::pill_switch;
use crate::theme::hsla;

const ICON_STAR: &str = "superhero/star.svg";
const ICON_UP: &str = "superhero/arrow-up.svg";
const ICON_DOWN: &str = "superhero/arrow-down.svg";
const ICON_REMOVE: &str = "superhero/close.svg";
const ICON_EDIT: &str = "superhero/edit.svg";

/// A text field of the custom model form.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum TextKey {
    Name,
    OptionId(u64),
    OptionLabel(u64),
    ChoiceId(u64, u64),
    ChoiceLabel(u64, u64),
}

/// The custom model being edited, and one input for each of its fields.
pub(super) struct CustomEdit {
    instance_id: String,
    draft: Draft,
    inputs: std::collections::HashMap<TextKey, (Entity<InputState>, Subscription)>,
    error: Option<String>,
}

fn expected_texts(draft: &Draft) -> Vec<(TextKey, String)> {
    let mut out = vec![(TextKey::Name, draft.name.clone())];
    for option in &draft.descriptors {
        out.push((TextKey::OptionId(option.key), option.id.clone()));
        out.push((TextKey::OptionLabel(option.key), option.label.clone()));
        for choice in &option.choices {
            out.push((TextKey::ChoiceId(option.key, choice.key), choice.id.clone()));
            out.push((
                TextKey::ChoiceLabel(option.key, choice.key),
                choice.label.clone(),
            ));
        }
    }
    out
}

impl ProvidersView {
    /// The instance's models: the server's built-in ones, then the custom ones its settings
    /// keep (`deriveProviderModelsForDisplay`).
    fn model_entries(instance: &InstanceConfig, group: Option<&ProviderGroup>) -> Vec<ModelEntry> {
        let models = group.map_or(&[][..], |g| g.models.as_slice());
        let flag_missing_reasoning = models.iter().any(|m| m.has_reasoning_control());
        let mut entries: Vec<ModelEntry> = models
            .iter()
            .filter(|m| !m.is_custom)
            .map(|m| ModelEntry {
                slug: m.slug.clone(),
                name: m.name.clone(),
                is_custom: false,
                capability_labels: m.capability_labels(flag_missing_reasoning),
            })
            .collect();
        if instance.driver != "antigravity" {
            for (slug, name) in prefs::custom_models(instance) {
                if entries.iter().any(|e| e.slug == slug) {
                    continue;
                }
                let labels = models
                    .iter()
                    .find(|m| m.slug == slug)
                    .map(|m| m.capability_labels(flag_missing_reasoning))
                    .unwrap_or_default();
                entries.push(ModelEntry {
                    slug,
                    name,
                    is_custom: true,
                    capability_labels: labels,
                });
            }
        }
        entries
    }

    fn display_rows(
        &self,
        instance_id: &str,
        instance: &InstanceConfig,
        group: Option<&ProviderGroup>,
    ) -> (Vec<ModelEntry>, Vec<ModelRow>) {
        let entries = Self::model_entries(instance, group);
        let preferences = &self.config.catalog().preferences;
        let rows = prefs::group_models_for_display(
            &entries,
            &preferences.instance(instance_id),
            &preferences.favorite_models(instance_id),
        );
        (entries, rows)
    }

    fn toggle_favorite(&mut self, instance_id: &str, slug: &str, cx: &mut Context<'_, Self>) {
        let favorite = !self
            .config
            .catalog()
            .preferences
            .is_favorite(instance_id, slug);
        let request =
            prefs::set_model_favorites_request(instance_id, &[(slug.to_owned(), favorite)]);
        self.write_settings(request, cx);
    }

    fn set_hidden(
        &mut self,
        instance_id: &str,
        slug: &str,
        hidden: bool,
        cx: &mut Context<'_, Self>,
    ) {
        let request = prefs::set_models_hidden_request(instance_id, &[(slug.to_owned(), hidden)]);
        self.write_settings(request, cx);
    }

    fn toggle_all_hidden(&mut self, instance_id: &str, cx: &mut Context<'_, Self>) {
        let Some((_, instance)) = self.current_instance(instance_id) else {
            return;
        };
        let group = self.group_for(instance_id);
        let built_in: Vec<String> = Self::model_entries(&instance, group.as_ref())
            .into_iter()
            .filter(|e| !e.is_custom)
            .map(|e| e.slug)
            .collect();
        let hidden = self
            .config
            .catalog()
            .preferences
            .instance(instance_id)
            .hidden_models;
        let (next, affected) = prefs::bulk_toggle_hidden(&built_in, &hidden);
        let changes: Vec<(String, bool)> = affected
            .into_iter()
            .map(|slug| {
                let hidden = next.contains(&slug);
                (slug, hidden)
            })
            .collect();
        self.write_settings(prefs::set_models_hidden_request(instance_id, &changes), cx);
    }

    fn move_model(
        &mut self,
        instance_id: &str,
        slug: &str,
        direction: isize,
        cx: &mut Context<'_, Self>,
    ) {
        let Some((_, instance)) = self.current_instance(instance_id) else {
            return;
        };
        let group = self.group_for(instance_id);
        let (_, rows) = self.display_rows(instance_id, &instance, group.as_ref());
        if let Some(order) = prefs::move_model(&rows, slug, direction) {
            self.write_settings(prefs::set_model_order_request(instance_id, &order), cx);
        }
    }

    fn group_for(&self, instance_id: &str) -> Option<ProviderGroup> {
        self.config
            .catalog()
            .all_groups()
            .into_iter()
            .find(|g| g.instance_id == instance_id)
            .cloned()
    }

    /// `handleAdd`: validates the typed slug and saves it with the instance.
    pub(super) fn add_custom_model(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let Some(editor) = &self.editor else {
            return;
        };
        if !editor.adding_custom_model {
            return;
        }
        let instance_id = editor.instance_id.clone();
        let text = editor.custom_model.read(cx).value().to_string();
        let custom_model = editor.custom_model.clone();
        let Some((_, instance)) = self.current_instance(&instance_id) else {
            return;
        };
        let group = self.group_for(&instance_id);
        let entries = Self::model_entries(&instance, group.as_ref());
        let built_in: Vec<String> = entries
            .iter()
            .filter(|e| !e.is_custom)
            .map(|e| e.slug.clone())
            .collect();
        let custom: Vec<String> = prefs::custom_models(&instance)
            .into_iter()
            .map(|(s, _)| s)
            .collect();
        match prefs::validate_custom_model(&text, &built_in, &custom) {
            Err(message) => {
                if let Some(editor) = &mut self.editor {
                    editor.custom_model_error = Some(message);
                }
            }
            Ok(slug) => {
                self.update_instance(
                    &instance_id,
                    |instance| prefs::with_custom_model_added(instance, &slug),
                    cx,
                );
                if let Some(editor) = &mut self.editor {
                    editor.adding_custom_model = false;
                    editor.custom_model_error = None;
                }
                custom_model.update(cx, |state, cx| state.set_value("", window, cx));
            }
        }
        cx.notify();
    }

    /// `handleRemove`: drops the custom model, and its place in the order and favorites.
    fn remove_custom_model(&mut self, instance_id: &str, slug: &str, cx: &mut Context<'_, Self>) {
        self.update_instance(
            instance_id,
            |instance| prefs::with_custom_model_removed(instance, slug),
            cx,
        );
        let preferences = self.config.catalog().preferences.clone();
        let order = preferences.instance(instance_id).model_order;
        if order.iter().any(|s| s == slug) {
            let next: Vec<String> = order.into_iter().filter(|s| s != slug).collect();
            self.write_settings(prefs::set_model_order_request(instance_id, &next), cx);
        }
        if preferences.is_favorite(instance_id, slug) {
            self.write_settings(
                prefs::set_model_favorites_request(instance_id, &[(slug.to_owned(), false)]),
                cx,
            );
        }
    }

    // --- the custom model editor ---------------------------------------------------------

    /// The pencil: opens the editor of custom model `slug`, or closes it.
    pub(super) fn toggle_custom_edit(
        &mut self,
        instance_id: &str,
        slug: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if self
            .custom_edit
            .as_ref()
            .is_some_and(|edit| edit.draft.slug == slug && edit.instance_id == instance_id)
        {
            self.custom_edit = None;
            cx.notify();
            return;
        }
        let Some((row, instance)) = self.current_instance(instance_id) else {
            return;
        };
        let Some(raw) = prefs::custom_model_raw(&instance, slug) else {
            return;
        };
        self.custom_edit = Some(CustomEdit {
            instance_id: instance_id.to_owned(),
            draft: Draft::from_raw(&raw, &row.driver),
            inputs: std::collections::HashMap::new(),
            error: None,
        });
        self.sync_custom_inputs(window, cx);
        cx.notify();
    }

    /// Gives every field of the draft an input showing its text, and drops the rest.
    fn sync_custom_inputs(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let Some(edit) = &mut self.custom_edit else {
            return;
        };
        let expected = expected_texts(&edit.draft);
        edit.inputs
            .retain(|key, _| expected.iter().any(|(k, _)| k == key));
        let placeholder = edit.draft.slug.clone();
        let mut added = Vec::new();
        for (key, text) in expected {
            if let Some((input, _)) = edit.inputs.get(&key) {
                if input.read(cx).value() != text.as_str() {
                    input.update(cx, |state, cx| state.set_value(text, window, cx));
                }
                continue;
            }
            let hint = match key {
                TextKey::Name => placeholder.clone(),
                TextKey::OptionId(_) => "optionId".to_owned(),
                TextKey::OptionLabel(_) | TextKey::ChoiceLabel(..) => "Label".to_owned(),
                TextKey::ChoiceId(..) => "value".to_owned(),
            };
            let input = cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder(hint)
                    .default_value(text)
            });
            let sub = cx.subscribe_in(
                &input,
                window,
                move |view, input, event: &InputEvent, _, cx| match event {
                    InputEvent::Change => {
                        let value = input.read(cx).value().to_string();
                        view.custom_text_changed(key, &value, cx);
                    }
                    InputEvent::PressEnter { .. } => view.save_custom_edit(cx),
                    _ => {}
                },
            );
            added.push((key, (input, sub)));
        }
        if let Some(edit) = &mut self.custom_edit {
            edit.inputs.extend(added);
        }
    }

    fn custom_text_changed(&mut self, key: TextKey, value: &str, cx: &mut Context<'_, Self>) {
        let Some(edit) = &mut self.custom_edit else {
            return;
        };
        match key {
            TextKey::Name => value.clone_into(&mut edit.draft.name),
            TextKey::OptionId(option) => edit.draft.set_option_id(option, value),
            TextKey::OptionLabel(option) => edit.draft.set_option_label(option, value),
            TextKey::ChoiceId(option, choice) => edit.draft.set_choice_id(option, choice, value),
            TextKey::ChoiceLabel(option, choice) => {
                edit.draft.set_choice_label(option, choice, value);
            }
        }
        edit.error = None;
        cx.notify();
    }

    /// Changes the draft's structure (add, remove, preset, type, default) and refreshes the
    /// inputs.
    pub(super) fn edit_custom(
        &mut self,
        change: impl FnOnce(&mut Draft),
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(edit) = &mut self.custom_edit else {
            return;
        };
        change(&mut edit.draft);
        edit.error = None;
        self.sync_custom_inputs(window, cx);
        cx.notify();
    }

    /// `handleSave`: validates the draft and stores the model with its instance.
    pub(super) fn save_custom_edit(&mut self, cx: &mut Context<'_, Self>) {
        let Some(edit) = &mut self.custom_edit else {
            return;
        };
        if let Some(problem) = edit.draft.problem() {
            edit.error = Some(problem);
            cx.notify();
            return;
        }
        let (instance_id, slug, entry) = (
            edit.instance_id.clone(),
            edit.draft.slug.clone(),
            edit.draft.entry(),
        );
        self.update_instance(
            &instance_id,
            |instance| prefs::with_custom_model_replaced(instance, &slug, entry),
            cx,
        );
        self.custom_edit = None;
        cx.notify();
    }

    fn custom_input(&self, edit: &CustomEdit, key: TextKey, ax: String, label: &str) -> AnyElement {
        match edit.inputs.get(&key) {
            Some((input, _)) => div()
                .id(SharedString::from(ax.clone()))
                .a11y_group(ax, label.to_owned())
                .flex_1()
                .min_w(px(80.0))
                .child(Input::new(input))
                .test_support()
                .into_any_element(),
            None => div().into_any_element(),
        }
    }

    /// One option of the form: its id (a known one or custom), label, type and choices.
    fn custom_option_row(
        &self,
        edit: &CustomEdit,
        option: &Descriptor,
        index: usize,
        ax: &str,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let number = index + 1;
        let oax = format!("{ax}.option.{}", option.key);
        let key = option.key;
        let preset = edit.draft.preset_of(option);
        let has_presets =
            !conn_state::custom_model_editor::presets(&edit.draft.driver()).is_empty();
        let mut head = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap(px(6.0));
        head = head.child(
            div()
                .w(px(60.0))
                .text_size(px(11.0))
                .text_color(hsla(self.tokens.muted_foreground))
                .child(format!("Option {number}")),
        );
        if has_presets {
            for known in conn_state::custom_model_editor::presets(&edit.draft.driver()) {
                let id = known.id;
                head = head.child(self.labelled_button(
                    format!("{oax}.id.{id}"),
                    id,
                    &format!("Option {number} id {id}"),
                    preset.is_some_and(|p| p.id == id),
                    Some(cx.listener(move |view, _, window, cx| {
                        view.edit_custom(|d| d.apply_preset_id(key, Some(id)), window, cx);
                    })),
                ));
            }
            head = head.child(self.labelled_button(
                format!("{oax}.id.custom"),
                "Custom...",
                &format!("Option {number} custom id"),
                preset.is_none(),
                Some(cx.listener(move |view, _, window, cx| {
                    view.edit_custom(|d| d.apply_preset_id(key, None), window, cx);
                })),
            ));
        }
        if preset.is_none() {
            head = head.child(self.custom_input(
                edit,
                TextKey::OptionId(key),
                format!("{oax}.id-input"),
                &format!("Option {number} id"),
            ));
        }
        head = head.child(self.custom_input(
            edit,
            TextKey::OptionLabel(key),
            format!("{oax}.label"),
            &format!("Option {number} label"),
        ));
        for (kind, label) in [
            (OptionKind::Select, "Choices"),
            (OptionKind::Boolean, "Toggle"),
        ] {
            head = head.child(self.labelled_button(
                format!("{oax}.type.{}", label.to_lowercase()),
                label,
                &format!("Option {number} type {label}"),
                option.kind == kind,
                Some(cx.listener(move |view, _, window, cx| {
                    view.edit_custom(|d| d.set_option_kind(key, kind), window, cx);
                })),
            ));
        }
        head = head.child(self.icon_button(
            format!("{oax}.remove"),
            format!("Remove option {number}"),
            ICON_REMOVE,
            false,
            Some(cx.listener(move |view, _, window, cx| {
                view.edit_custom(|d| d.remove_option(key), window, cx);
            })),
        ));
        let mut column = div()
            .id(SharedString::from(oax.clone()))
            .a11y_group(oax.clone(), format!("Option {number}"))
            .flex()
            .flex_col()
            .gap(px(8.0))
            .p(px(10.0))
            .rounded(px(8.0))
            .border_1()
            .border_color(hsla(self.tokens.shell_divider_raised))
            .child(head);
        if option.kind == OptionKind::Select {
            let mut choices = div().flex().flex_col().gap(px(6.0)).pl(px(66.0));
            for choice in &option.choices {
                let (ckey, shown) = (choice.key, choice.is_default);
                let cax = format!("{oax}.choice.{ckey}");
                let handle = cx.entity().downgrade();
                let default_switch = pill_switch(
                    SharedString::from(format!("conn-settings-{cax}-default")),
                    shown,
                    &self.tokens,
                    move |window, cx| {
                        if let Some(view) = handle.upgrade() {
                            view.update(cx, |view, cx| {
                                view.edit_custom(
                                    |d| d.set_choice_default(key, ckey, !shown),
                                    window,
                                    cx,
                                );
                            });
                        }
                    },
                );
                choices = choices.child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.0))
                        .child(self.custom_input(
                            edit,
                            TextKey::ChoiceId(key, ckey),
                            format!("{cax}.value"),
                            &format!("Option {number} choice value"),
                        ))
                        .child(self.custom_input(
                            edit,
                            TextKey::ChoiceLabel(key, ckey),
                            format!("{cax}.label"),
                            &format!("Option {number} choice label"),
                        ))
                        .child(
                            div()
                                .text_size(px(11.0))
                                .text_color(hsla(self.tokens.muted_foreground))
                                .child("Default"),
                        )
                        .child(default_switch)
                        .child(self.icon_button(
                            format!("{cax}.remove"),
                            format!("Remove choice from option {number}"),
                            ICON_REMOVE,
                            false,
                            Some(cx.listener(move |view, _, window, cx| {
                                view.edit_custom(|d| d.remove_choice(key, ckey), window, cx);
                            })),
                        )),
                );
            }
            choices = choices.child(div().flex().flex_row().child(self.labelled_button(
                format!("{oax}.choice.add"),
                "Add choice",
                &format!("Add choice to option {number}"),
                false,
                Some(cx.listener(move |view, _, window, cx| {
                    view.edit_custom(|d| d.add_choice(key), window, cx);
                })),
            )));
            column = column.child(choices);
        }
        column.into_any_element()
    }

    /// `CustomModelEditor`: display name, options, `Copy from...`, Save and Cancel.
    fn custom_editor(
        &self,
        edit: &CustomEdit,
        builtins: &[(String, Vec<conn_state::providers::ModelOptionDescriptor>)],
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let ax = format!(
            "settings.providers.{}.models.{}.editor",
            edit.instance_id, edit.draft.slug
        );
        let mut form = div()
            .id(SharedString::from(ax.clone()))
            .a11y_group(ax.clone(), format!("Edit {}", edit.draft.slug))
            .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" && view.custom_edit.is_some() {
                    view.custom_edit = None;
                    cx.notify();
                }
            }))
            .flex()
            .flex_col()
            .gap(px(10.0))
            .mx(px(8.0))
            .mt(px(4.0))
            .mb(px(8.0))
            .p(px(12.0))
            .rounded(px(8.0))
            .border_1()
            .border_color(hsla(self.tokens.shell_divider_raised))
            .child(self.muted_line("Display name"))
            .child(div().w(px(280.0)).child(self.custom_input(
                edit,
                TextKey::Name,
                format!("{ax}.name"),
                "Display name",
            )));
        let mut header = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap(px(6.0))
            .child(self.muted_line("Options shown in the composer"));
        if !builtins.is_empty() {
            header = header.child(self.muted_line("Copy from..."));
            for (index, (name, options)) in builtins.iter().enumerate() {
                let options = options.clone();
                header = header.child(self.labelled_button(
                    format!("{ax}.copy.{index}"),
                    name,
                    &format!("Copy options from {name}"),
                    false,
                    Some(cx.listener(move |view, _, window, cx| {
                        view.edit_custom(|d| d.copy_options_from(&options), window, cx);
                    })),
                ));
            }
        }
        form = form.child(header);
        if edit.draft.descriptors.is_empty() {
            form = form.child(self.muted_line(
                "No custom options. The composer uses the provider's default options.",
            ));
        }
        for (index, option) in edit.draft.descriptors.iter().enumerate() {
            form = form.child(self.custom_option_row(edit, option, index, &ax, cx));
        }
        let mut adders = div().flex().flex_row().flex_wrap().gap(px(6.0));
        for preset in edit.draft.unused_presets() {
            let id = preset.id;
            adders = adders.child(self.labelled_button(
                format!("{ax}.add.{id}"),
                &format!("+ {}", preset.label),
                &format!("Add option {}", preset.label),
                false,
                Some(cx.listener(move |view, _, window, cx| {
                    view.edit_custom(|d| d.add_preset(id), window, cx);
                })),
            ));
        }
        adders = adders.child(self.labelled_button(
            format!("{ax}.add.custom"),
            "+ Custom option",
            "Add custom option",
            false,
            Some(cx.listener(|view, _, window, cx| {
                view.edit_custom(Draft::add_custom_option, window, cx);
            })),
        ));
        form = form.child(adders);
        if let Some(error) = &edit.error {
            form = form.child(
                div()
                    .id(SharedString::from(format!("{ax}.error")))
                    .a11y_group(format!("{ax}.error"), error.clone())
                    .text_size(px(12.0))
                    .text_color(hsla(self.tokens.destructive))
                    .child(error.clone())
                    .test_support(),
            );
        }
        form.child(
            div()
                .flex()
                .flex_row()
                .gap(px(8.0))
                .child(self.button(
                    format!("{ax}.save"),
                    "Save",
                    false,
                    Some(cx.listener(|view, _, _, cx| view.save_custom_edit(cx))),
                ))
                .child(self.button(
                    format!("{ax}.cancel"),
                    "Cancel",
                    false,
                    Some(cx.listener(|view, _, _, cx| {
                        view.custom_edit = None;
                        cx.notify();
                    })),
                )),
        )
        .into_any_element()
    }

    fn icon_button(
        &self,
        ax_id: String,
        label: String,
        icon: &'static str,
        active: bool,
        on_click: Option<impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static>,
    ) -> AnyElement {
        let tokens = &self.tokens;
        let color = if active {
            hsla(tokens.warning)
        } else {
            hsla(tokens.muted_foreground)
        };
        let hover = hsla(tokens.shell_highlight);
        let base = div()
            .id(SharedString::from(ax_id.clone()))
            .a11y_button(ax_id, label.clone())
            .conn_tooltip(label, tokens)
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(22.0))
            .rounded(px(5.0))
            .child(crate::icons::concept(icon, 12.0, color));
        match on_click {
            Some(on_click) => base
                .cursor_pointer()
                .hover(move |s| s.bg(hover))
                .on_click(on_click)
                .test_support()
                .into_any_element(),
            None => base.opacity(0.35).test_support().into_any_element(),
        }
    }

    /// The Models section of the instance being edited.
    pub(super) fn models_section(
        &self,
        instance_id: &str,
        driver: &str,
        instance: &InstanceConfig,
        group: Option<&ProviderGroup>,
        cx: &mut Context<'_, Self>,
    ) -> Option<AnyElement> {
        let editor = self.editor.as_ref()?;
        let tokens = self.tokens.clone();
        let geometry = self.geometry;
        let ax = |suffix: &str| format!("settings.providers.{instance_id}.models.{suffix}");
        let (entries, rows) = self.display_rows(instance_id, instance, group);
        let built_in: Vec<&ModelEntry> = entries.iter().filter(|e| !e.is_custom).collect();
        let hidden = self
            .config
            .catalog()
            .preferences
            .instance(instance_id)
            .hidden_models;
        let all_hidden = !built_in.is_empty() && built_in.iter().all(|e| hidden.contains(&e.slug));
        let favorite_count = rows
            .iter()
            .filter(|r| r.group == ModelGroup::Favorite)
            .count();
        let hidden_count = rows
            .iter()
            .filter(|r| r.group == ModelGroup::Hidden)
            .count();
        let show_filter = entries.len() > MODEL_FILTER_THRESHOLD;
        let filter = editor.model_filter.read(cx).value().trim().to_lowercase();
        let filtering = show_filter && !filter.is_empty();
        let visible: Vec<&ModelRow> = rows
            .iter()
            .filter(|r| {
                !filtering
                    || r.name.to_lowercase().contains(&filter)
                    || r.slug.to_lowercase().contains(&filter)
            })
            .collect();
        let custom_allowed = driver != "antigravity";

        let mut out = Vec::new();
        out.push(
            div()
                .px(px(14.0))
                .pt(px(12.0))
                .child(self.muted_line(
                    "Model preferences and custom models are saved on the selected environment and shared across connected devices.",
                ))
                .into_any_element(),
        );

        let mut counts = format!(
            "{} model{}",
            entries.len(),
            if entries.len() == 1 { "" } else { "s" }
        );
        if favorite_count > 0 {
            counts.push_str(&format!(
                " \u{b7} {favorite_count} favorite{}",
                if favorite_count == 1 { "" } else { "s" }
            ));
        }
        if hidden_count > 0 {
            counts.push_str(&format!(" \u{b7} {hidden_count} hidden"));
        }
        let toolbar_id = instance_id.to_owned();
        out.push(
            div()
                .flex()
                .flex_row()
                .flex_wrap()
                .items_center()
                .gap(px(8.0))
                .px(px(14.0))
                .py(px(8.0))
                .when(show_filter, |el| {
                    el.child(
                        div()
                            .id(SharedString::from(ax("filter")))
                            .a11y(gpui_kit::Role::Search, ax("filter"), "Filter models")
                            .w(px(200.0))
                            .child(Input::new(&editor.model_filter)),
                    )
                })
                .when(!built_in.is_empty(), |el| {
                    el.child(self.button(
                        ax("toggle-all"),
                        if all_hidden {
                            "Enable all"
                        } else {
                            "Disable all"
                        },
                        false,
                        Some(cx.listener(move |view, _, _, cx| {
                            view.toggle_all_hidden(&toolbar_id, cx)
                        })),
                    ))
                })
                .child(self.muted_line(counts))
                .child(div().flex_1())
                .when(custom_allowed && !editor.adding_custom_model, |el| {
                    el.child(self.button(
                        ax("custom.add"),
                        "Add custom model",
                        false,
                        Some(cx.listener(|view, _, window, cx| {
                            if let Some(editor) = &mut view.editor {
                                editor.adding_custom_model = true;
                                editor.custom_model_error = None;
                                let input = editor.custom_model.clone();
                                input.update(cx, |state, cx| state.focus(window, cx));
                            }
                            cx.notify();
                        })),
                    ))
                })
                .into_any_element(),
        );

        if visible.is_empty() {
            out.push(self.note_row(
                if filtering {
                    "No models match.".to_owned()
                } else {
                    "No models reported for this provider yet.".to_owned()
                },
                false,
                &ax("empty"),
            ));
        }

        let mut list = div()
            .id(SharedString::from(ax("list")))
            .a11y_group(ax("list"), "Models")
            .flex()
            .flex_col()
            .px(px(8.0))
            .pb(px(8.0))
            .max_h(px(360.0))
            .overflow_y_scroll();
        for (index, model) in visible.iter().enumerate() {
            let previous = index.checked_sub(1).and_then(|i| visible.get(i));
            if previous.is_none_or(|p| p.group != model.group) {
                let label = match model.group {
                    ModelGroup::Favorite if favorite_count > 0 => Some("Favorites"),
                    ModelGroup::Visible if favorite_count > 0 => Some("All"),
                    ModelGroup::Hidden => Some("Hidden from picker"),
                    _ => None,
                };
                if let Some(label) = label {
                    list = list.child(
                        div()
                            .px(px(6.0))
                            .pt(px(if index == 0 { 4.0 } else { 14.0 }))
                            .pb(px(4.0))
                            .text_size(px(11.0))
                            .text_color(hsla(tokens.muted_foreground))
                            .child(label),
                    );
                }
            }
            let position = rows.iter().position(|r| r.slug == model.slug).unwrap_or(0);
            let can_up = !filtering
                && position
                    .checked_sub(1)
                    .and_then(|i| rows.get(i))
                    .is_some_and(|p| p.group == model.group);
            let can_down = !filtering
                && rows
                    .get(position + 1)
                    .is_some_and(|n| n.group == model.group);
            list = list.child(self.model_row(instance_id, model, can_up, can_down, filtering, cx));
            if model.is_custom
                && let Some(edit) = self
                    .custom_edit
                    .as_ref()
                    .filter(|edit| edit.instance_id == instance_id && edit.draft.slug == model.slug)
            {
                let builtins: Vec<_> = group
                    .map(|g| {
                        g.models
                            .iter()
                            .filter(|m| !m.is_custom && !m.descriptors.is_empty())
                            .map(|m| (m.name.clone(), m.descriptors.clone()))
                            .collect()
                    })
                    .unwrap_or_default();
                list = list.child(self.custom_editor(edit, &builtins, cx));
            }
        }
        out.push(list.into_any_element());

        if custom_allowed && editor.adding_custom_model {
            out.push(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .px(px(14.0))
                    .py(px(10.0))
                    .child(self.input_box(&editor.custom_model))
                    .child(self.button(
                        ax("custom.save"),
                        "Add",
                        true,
                        Some(cx.listener(|view, _, window, cx| {
                            view.add_custom_model(window, cx);
                        })),
                    ))
                    .child(self.button(
                        ax("custom.cancel"),
                        "Cancel",
                        false,
                        Some(cx.listener(|view, _, window, cx| {
                            if let Some(editor) = &mut view.editor {
                                editor.adding_custom_model = false;
                                editor.custom_model_error = None;
                                let input = editor.custom_model.clone();
                                input.update(cx, |state, cx| state.set_value("", window, cx));
                            }
                            cx.notify();
                        })),
                    ))
                    .into_any_element(),
            );
        }
        if let Some(message) = editor.custom_model_error {
            out.push(self.note_row(message.to_owned(), true, &ax("custom.error")));
        }
        Some(settings_section("Models", out, &tokens, &geometry).into_any_element())
    }

    fn model_row(
        &self,
        instance_id: &str,
        model: &ModelRow,
        can_up: bool,
        can_down: bool,
        filtering: bool,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = &self.tokens;
        let slug = model.slug.clone();
        let rax = format!("settings.providers.{instance_id}.models.{slug}");
        let is_hidden = model.group == ModelGroup::Hidden;
        let is_favorite = model.group == ModelGroup::Favorite;
        let fav = {
            let (id, slug) = (instance_id.to_owned(), slug.clone());
            self.icon_button(
                format!("{rax}.favorite"),
                if is_favorite {
                    format!("Remove {} from favorites", model.name)
                } else {
                    format!("Add {} to favorites", model.name)
                },
                ICON_STAR,
                is_favorite,
                Some(cx.listener(move |view, _, _, cx| view.toggle_favorite(&id, &slug, cx))),
            )
        };
        let mut name = div()
            .flex()
            .flex_row()
            .items_baseline()
            .gap(px(8.0))
            .flex_1()
            .min_w_0()
            .child(
                div()
                    .truncate()
                    .text_size(px(12.0))
                    .text_color(if is_hidden {
                        hsla(tokens.muted_foreground)
                    } else {
                        hsla(tokens.foreground)
                    })
                    .child(model.name.clone()),
            );
        if model.name != model.slug {
            name = name.child(
                div()
                    .truncate()
                    .font_family("Menlo")
                    .text_size(px(11.0))
                    .text_color(hsla(tokens.muted_foreground))
                    .child(model.slug.clone()),
            );
        }
        if model.is_custom {
            name = name.child(
                div()
                    .text_size(px(11.0))
                    .text_color(hsla(tokens.muted_foreground))
                    .child("custom"),
            );
        }
        let mut actions = div().flex().flex_row().items_center().gap(px(2.0));
        if !is_hidden && !filtering {
            let (id_up, slug_up) = (instance_id.to_owned(), slug.clone());
            let (id_down, slug_down) = (instance_id.to_owned(), slug.clone());
            actions = actions
                .child(self.icon_button(
                    format!("{rax}.up"),
                    format!("Move {} up", model.name),
                    ICON_UP,
                    false,
                    can_up.then(|| {
                        cx.listener(move |view, _, _, cx| view.move_model(&id_up, &slug_up, -1, cx))
                    }),
                ))
                .child(self.icon_button(
                    format!("{rax}.down"),
                    format!("Move {} down", model.name),
                    ICON_DOWN,
                    false,
                    can_down.then(|| {
                        cx.listener(move |view, _, _, cx| {
                            view.move_model(&id_down, &slug_down, 1, cx)
                        })
                    }),
                ));
        }
        if model.is_custom {
            let (id, slug) = (instance_id.to_owned(), slug.clone());
            actions = actions.child(
                self.icon_button(
                    format!("{rax}.edit"),
                    format!("Edit {}", model.slug),
                    ICON_EDIT,
                    self.custom_edit
                        .as_ref()
                        .is_some_and(|edit| edit.draft.slug == slug && edit.instance_id == id),
                    Some(cx.listener({
                        let (id, slug) = (id.clone(), slug.clone());
                        move |view, _, window, cx| view.toggle_custom_edit(&id, &slug, window, cx)
                    })),
                ),
            );
            let (id, slug) = (instance_id.to_owned(), slug.clone());
            actions = actions.child(self.icon_button(
                format!("{rax}.remove"),
                format!("Remove {}", model.slug),
                ICON_REMOVE,
                false,
                Some(cx.listener(move |view, _, _, cx| view.remove_custom_model(&id, &slug, cx))),
            ));
        }
        let shown = !is_hidden;
        let switch_id = instance_id.to_owned();
        let switch_slug = slug.clone();
        let switch = pill_switch(
            SharedString::from(format!(
                "conn-settings-provider-{instance_id}-model-{slug}-shown"
            )),
            shown,
            tokens,
            {
                let handle = cx.entity().downgrade();
                let custom = model.is_custom;
                move |_, cx| {
                    // Custom models are always shown in the picker.
                    if custom {
                        return;
                    }
                    if let Some(view) = handle.upgrade() {
                        view.update(cx, |view, cx| {
                            view.set_hidden(&switch_id, &switch_slug, shown, cx);
                        });
                    }
                }
            },
        );
        let tooltip = if model.is_custom {
            "Custom models are always shown in the picker"
        } else if is_hidden {
            "Hidden from picker"
        } else {
            "Shown in picker"
        };
        div()
            .id(SharedString::from(rax.clone()))
            .a11y_group(rax.clone(), model.name.clone())
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .h(px(30.0))
            .px(px(6.0))
            .rounded(px(6.0))
            .when(is_hidden, |el| el.opacity(0.6))
            .child(fav)
            .child(name)
            .when(!model.capability_labels.is_empty(), |el| {
                el.child(
                    div()
                        .text_size(px(11.0))
                        .text_color(hsla(tokens.muted_foreground))
                        .child(model.capability_labels.join(" \u{b7} ")),
                )
            })
            .child(actions)
            .child(
                div()
                    .id(SharedString::from(format!("{rax}.shown")))
                    .conn_tooltip(tooltip, tokens)
                    .when(model.is_custom, |el| el.opacity(0.5))
                    .child(switch),
            )
            .into_any_element()
    }
}
