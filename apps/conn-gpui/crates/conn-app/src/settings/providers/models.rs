//! The Models section of a provider instance (`ProviderModelsSection.tsx`): favorites, the
//! models shown in the picker, their order, and custom models. Preferences are saved on the
//! environment and shared by every client (`conn_state::model_preferences`).
//!
//! Not ported: editing a custom model's name and options (`CustomModelEditor`). Remove and add
//! it again instead.

use conn_contract::ServerSettingsProviderInstancesValue as InstanceConfig;
use conn_state::model_preferences::{
    self as prefs, MODEL_FILTER_THRESHOLD, ModelEntry, ModelGroup, ModelRow,
};
use conn_state::providers::ProviderGroup;
use gpui_kit::component::input::Input;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, Context, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, TestSupportExt as _, Window, div, px,
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
