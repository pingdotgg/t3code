//! Conn-styled floating model picker (`ProviderModelPicker` / `ModelPickerContent` parity).
//!
//! Populated from `server.getConfig` (`conn_contract::ServerConfig.providers`).
//! Renders as a floating `dropdown-glass` surface (`12px` radius, `shell_overlay` fill,
//! `glass_divider` 1px border, `8px` row radius, `shell_highlight` hover).

use conn_contract::{
    ServerConfig, ServerProviderState, ServerProvidersItemItem, ServerProvidersItemItemModelsItem,
    ServerProvidersItemItemModelsItemCapabilitiesOptionDescriptorsItem as OptionDescriptor,
};
use conn_theme::Tokens;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::{
    AnyElement, Context, Entity, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, div, px,
};

use super::super::color::{hsla, hsla_alpha};
use super::super::icons;
use super::Composer;

/// Popup corner radius matching Conn's `rounded-xl` (`12px`) on `dropdown-glass`.
const PICKER_RADIUS_PX: f32 = 12.0;
/// Row corner radius matching Conn's `rounded-lg` (`8px`).
const PICKER_ROW_RADIUS_PX: f32 = 8.0;
/// Popup width matching `max-w-90` (`360px`).
const PICKER_WIDTH_PX: f32 = 360.0;
/// Maximum popup height matching `max-h-86.5` (`346px`).
const PICKER_MAX_HEIGHT_PX: f32 = 346.0;
/// Left provider sidebar width matching `w-11` (`44px`).
const SIDEBAR_WIDTH_PX: f32 = 44.0;
/// Maximum scrollable model list height inside the popup.
const LIST_MAX_HEIGHT_PX: f32 = 280.0;

/// Superheroicons 16/solid paths used by the model picker.
pub(super) const ICON_SEARCH: &str = "superhero/search.svg";
pub(super) const ICON_CHECK: &str = "superhero/check.svg";

/// Reasoning/effort select descriptor advertised by a model in `server.getConfig`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReasoningOptionDescriptor {
    pub(crate) option_id: String,
    pub(crate) label: String,
    pub(crate) choices: Vec<(String, String)>,
    pub(crate) default_value: Option<String>,
}

/// One selectable model belonging to a provider instance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ModelOption {
    pub(crate) instance_id: String,
    pub(crate) driver: String,
    pub(crate) provider_display_name: String,
    pub(crate) slug: String,
    pub(crate) name: String,
    pub(crate) short_name: Option<String>,
    pub(crate) sub_provider: Option<String>,
    pub(crate) is_default: bool,
    pub(crate) is_legacy: bool,
    pub(crate) is_new: bool,
    pub(crate) reasoning: Option<ReasoningOptionDescriptor>,
}

impl ModelOption {
    /// Short label shown on the composer trigger (`short_name` if present, otherwise `name`).
    #[must_use]
    pub(crate) fn trigger_label(&self) -> &str {
        self.short_name
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(self.name.as_str())
    }
}

/// One provider instance group returned by `server.getConfig`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProviderGroup {
    pub(crate) instance_id: String,
    pub(crate) driver: String,
    pub(crate) display_name: String,
    pub(crate) enabled: bool,
    pub(crate) ready: bool,
    pub(crate) models: Vec<ModelOption>,
}

/// Parsed provider and model catalog from `server.getConfig`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ModelCatalog {
    pub(crate) providers: Vec<ProviderGroup>,
}

impl ModelCatalog {
    /// Builds a [`ModelCatalog`] from a typed `conn_contract::ServerConfig`.
    #[must_use]
    pub(crate) fn from_server_config(config: &ServerConfig) -> Self {
        Self::from_providers(&config.providers)
    }

    /// Builds a [`ModelCatalog`] from `ServerConfig::providers`.
    #[must_use]
    pub(crate) fn from_providers(providers: &[Option<ServerProvidersItemItem>]) -> Self {
        let mut groups = Vec::new();
        for item in providers.iter().flatten() {
            if !item.enabled && item.models.is_empty() {
                continue;
            }
            let display_name = item
                .display_name
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format_driver_name(&item.driver));
            let ready =
                item.enabled && item.installed && matches!(item.status, ServerProviderState::Ready);
            let models = item
                .models
                .iter()
                .map(|m| model_option_from_contract(item, &display_name, m))
                .collect();
            groups.push(ProviderGroup {
                instance_id: item.instance_id.clone(),
                driver: item.driver.clone(),
                display_name,
                enabled: item.enabled,
                ready,
                models,
            });
        }
        Self { providers: groups }
    }

    /// Returns the preferred default model across available providers:
    /// first ready provider's `is_default` model, else first model of a ready provider,
    /// else any `is_default` model, else the very first model in the catalog.
    #[must_use]
    pub(crate) fn default_model(&self) -> Option<&ModelOption> {
        self.providers
            .iter()
            .filter(|p| p.ready)
            .flat_map(|p| p.models.iter())
            .find(|m| m.is_default)
            .or_else(|| {
                self.providers
                    .iter()
                    .filter(|p| p.ready)
                    .flat_map(|p| p.models.iter())
                    .next()
            })
            .or_else(|| {
                self.providers
                    .iter()
                    .flat_map(|p| p.models.iter())
                    .find(|m| m.is_default)
            })
            .or_else(|| self.providers.iter().flat_map(|p| p.models.iter()).next())
    }

    /// Looks up a model by `(instance_id, slug)` or by `slug` / short alias alone.
    #[must_use]
    pub(crate) fn find_model(
        &self,
        instance_id: Option<&str>,
        model_slug: &str,
    ) -> Option<&ModelOption> {
        let exact = |m: &&ModelOption| m.slug == model_slug || m.name == model_slug;
        if let Some(id) = instance_id
            && let Some(group) = self.providers.iter().find(|p| p.instance_id == id)
            && let Some(found) = group.models.iter().find(exact)
        {
            return Some(found);
        }
        if let Some(found) = self
            .providers
            .iter()
            .flat_map(|p| p.models.iter())
            .find(exact)
        {
            return Some(found);
        }
        let needle = model_slug.trim().to_ascii_lowercase();
        if needle.is_empty() {
            return None;
        }
        let alias = |m: &&ModelOption| {
            m.short_name
                .as_deref()
                .is_some_and(|s| s.eq_ignore_ascii_case(&needle))
                || m.slug.to_ascii_lowercase().contains(&needle)
        };
        if let Some(id) = instance_id
            && let Some(group) = self.providers.iter().find(|p| p.instance_id == id)
            && let Some(found) = group.models.iter().find(alias)
        {
            return Some(found);
        }
        self.providers
            .iter()
            .flat_map(|p| p.models.iter())
            .find(alias)
    }

    /// Returns the models visible for the active provider tab and search query.
    ///
    /// When `query` is non-empty, searches across all providers (matching `ModelPickerContent.tsx`).
    /// When `query` is empty, filters to `selected_provider` (or all providers if `None`).
    #[must_use]
    pub(crate) fn filtered_models(
        &self,
        selected_provider: Option<&str>,
        query: &str,
    ) -> Vec<&ModelOption> {
        let trimmed = query.trim();
        if !trimmed.is_empty() {
            let needle = trimmed.to_ascii_lowercase();
            return self
                .providers
                .iter()
                .flat_map(|p| p.models.iter())
                .filter(|m| {
                    m.name.to_ascii_lowercase().contains(&needle)
                        || m.slug.to_ascii_lowercase().contains(&needle)
                        || m.provider_display_name
                            .to_ascii_lowercase()
                            .contains(&needle)
                        || m.sub_provider
                            .as_deref()
                            .is_some_and(|sp| sp.to_ascii_lowercase().contains(&needle))
                })
                .collect();
        }

        if let Some(id) = selected_provider
            && let Some(group) = self.providers.iter().find(|p| p.instance_id == id)
        {
            return group.models.iter().collect();
        }

        self.providers
            .iter()
            .flat_map(|p| p.models.iter())
            .collect()
    }
}

fn model_option_from_contract(
    provider: &ServerProvidersItemItem,
    display_name: &str,
    model: &ServerProvidersItemItemModelsItem,
) -> ModelOption {
    let reasoning = model
        .capabilities
        .as_ref()
        .and_then(|caps| caps.option_descriptors.as_deref())
        .and_then(|descriptors| {
            descriptors.iter().find_map(|desc| match desc {
                OptionDescriptor::Select(sel)
                    if (sel.role.is_some()
                        || sel.id.contains("effort")
                        || sel.id.contains("reasoning")
                        || sel.id.contains("thought"))
                        && !sel.options.is_empty() =>
                {
                    let default_value = sel
                        .current_value
                        .clone()
                        .or_else(|| {
                            sel.options
                                .iter()
                                .find(|o| o.is_default == Some(true))
                                .map(|o| o.id.clone())
                        })
                        .or_else(|| sel.options.first().map(|o| o.id.clone()));
                    Some(ReasoningOptionDescriptor {
                        option_id: sel.id.clone(),
                        label: sel.label.clone(),
                        choices: sel
                            .options
                            .iter()
                            .map(|o| (o.id.clone(), o.label.clone()))
                            .collect(),
                        default_value,
                    })
                }
                _ => None,
            })
        });
    ModelOption {
        instance_id: provider.instance_id.clone(),
        driver: provider.driver.clone(),
        provider_display_name: display_name.to_owned(),
        slug: model.slug.clone(),
        name: model.name.clone(),
        short_name: model.short_name.clone(),
        sub_provider: model.sub_provider.clone(),
        is_default: model.is_default.unwrap_or(false),
        is_legacy: model.is_legacy.unwrap_or(false),
        is_new: model.badge.is_some(),
        reasoning,
    }
}

fn format_driver_name(driver: &str) -> String {
    match driver {
        "claudeAgent" => "Claude".to_owned(),
        "codex" => "Codex".to_owned(),
        "antigravity" => "Antigravity".to_owned(),
        "opencode" => "OpenCode".to_owned(),
        other => other.to_owned(),
    }
}

/// Parameters for rendering the floating model picker popup.
pub(super) struct ModelPickerView<'a> {
    pub(super) catalog: &'a ModelCatalog,
    pub(super) loading: bool,
    pub(super) error: Option<&'a str>,
    pub(super) active_instance_id: Option<&'a str>,
    pub(super) active_model: &'a str,
    pub(super) selected_provider: Option<&'a str>,
    pub(super) search_input: &'a Entity<InputState>,
    pub(super) query: &'a str,
    pub(super) highlighted_index: usize,
    pub(super) tokens: &'a Tokens,
}

/// Renders Conn's floating `dropdown-glass` model picker popup.
pub(super) fn render_model_picker(
    view: &ModelPickerView<'_>,
    cx: &mut Context<'_, Composer>,
) -> AnyElement {
    let tokens = view.tokens;
    let glass_bg = hsla(tokens.shell_overlay);
    let glass_divider = hsla(tokens.glass_divider);
    let highlight_bg = hsla(tokens.shell_highlight);
    let fg = hsla(tokens.foreground);
    let muted = hsla(tokens.muted_foreground);

    let is_searching = !view.query.trim().is_empty();
    let show_sidebar = !is_searching && view.catalog.providers.len() > 1;
    let effective_provider = view
        .selected_provider
        .or(view.active_instance_id)
        .or_else(|| {
            view.catalog
                .providers
                .first()
                .map(|p| p.instance_id.as_str())
        });
    let models = view.catalog.filtered_models(effective_provider, view.query);

    let mut content = div()
        .flex()
        .flex_row()
        .w_full()
        .max_h(px(PICKER_MAX_HEIGHT_PX))
        .overflow_hidden();

    if show_sidebar {
        let mut rail = div()
            .flex()
            .flex_col()
            .flex_none()
            .w(px(SIDEBAR_WIDTH_PX))
            .p(px(4.0))
            .gap(px(4.0))
            .border_r_1()
            .border_color(glass_divider)
            .bg(hsla_alpha(tokens.muted, 0.30));

        for provider in &view.catalog.providers {
            let is_selected = effective_provider == Some(provider.instance_id.as_str());
            let provider_id = provider.instance_id.clone();
            let icon_color = if is_selected { fg } else { muted };
            let mut btn = div()
                .id(SharedString::from(format!(
                    "model-picker-provider-{}",
                    provider.instance_id
                )))
                .relative()
                .flex()
                .items_center()
                .justify_center()
                .w_full()
                .h(px(36.0))
                .rounded(px(6.0))
                .cursor_pointer()
                .hover(move |s| s.bg(highlight_bg))
                .on_click(cx.listener(move |composer, _, _, cx| {
                    composer.select_picker_provider(provider_id.clone(), cx);
                }))
                .child(crate::icons::provider_mark(
                    &provider.driver,
                    18.0,
                    icon_color,
                ));

            if is_selected {
                btn = btn.child(
                    div()
                        .absolute()
                        .right(px(0.0))
                        .w(px(3.0))
                        .h(px(20.0))
                        .rounded_full()
                        .bg(hsla(tokens.primary)),
                );
            }
            rail = rail.child(btn);
        }
        content = content.child(rail);
    }

    let search_row = div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .w_full()
        .px(px(10.0))
        .py(px(8.0))
        .border_b_1()
        .border_color(glass_divider)
        .child(icons::icon(ICON_SEARCH, 14.0, muted))
        .child(
            div().flex_1().min_w_0().child(
                Input::new(view.search_input)
                    .appearance(false)
                    .pl(px(0.0))
                    .text_size(px(13.0))
                    .line_height(px(20.0)),
            ),
        );

    let mut list = div()
        .id("model-picker-list")
        .flex()
        .flex_col()
        .gap(px(2.0))
        .p(px(6.0))
        .max_h(px(LIST_MAX_HEIGHT_PX))
        .overflow_y_scroll();

    if view.loading && models.is_empty() {
        list = list.child(
            div()
                .px(px(10.0))
                .py(px(14.0))
                .text_size(px(13.0))
                .line_height(px(20.0))
                .text_color(muted)
                .child("Loading models..."),
        );
    } else if let Some(err) = view.error
        && models.is_empty()
    {
        list = list.child(
            div()
                .px(px(10.0))
                .py(px(14.0))
                .text_size(px(13.0))
                .line_height(px(20.0))
                .text_color(hsla(tokens.destructive))
                .child(err.to_owned()),
        );
    } else if models.is_empty() {
        list = list.child(
            div()
                .px(px(10.0))
                .py(px(14.0))
                .text_size(px(13.0))
                .line_height(px(20.0))
                .text_color(muted)
                .child("No models found"),
        );
    } else {
        for (idx, model) in models.iter().enumerate() {
            let is_active = model.slug == view.active_model
                && view
                    .active_instance_id
                    .is_none_or(|id| id == model.instance_id);
            let is_highlighted = idx == view.highlighted_index;
            let instance_id = model.instance_id.clone();
            let slug = model.slug.clone();

            let mut row = div()
                .id(SharedString::from(format!(
                    "model-picker-row-{}-{}",
                    model.instance_id, model.slug
                )))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.0))
                .w_full()
                .min_w_0()
                .px(px(8.0))
                .py(px(6.0))
                .rounded(px(PICKER_ROW_RADIUS_PX))
                .cursor_pointer()
                .hover(move |s| s.bg(highlight_bg))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |composer, _, _, cx| {
                    composer.pick_model(instance_id.clone(), slug.clone(), cx);
                }))
                .child(crate::icons::provider_mark(
                    &model.driver,
                    16.0,
                    if is_active { fg } else { muted },
                ));

            if is_highlighted {
                row = row.bg(highlight_bg);
            }

            let mut label_group = div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_size(px(13.0))
                        .line_height(px(20.0))
                        .font_weight(if is_active {
                            FontWeight::MEDIUM
                        } else {
                            FontWeight::NORMAL
                        })
                        .text_color(fg)
                        .child(model.name.clone()),
                );

            if is_active {
                label_group = label_group.child(icons::icon(ICON_CHECK, 14.0, fg));
            }

            if let Some(sub) = model.sub_provider.as_deref() {
                label_group = label_group.child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_size(px(12.0))
                        .line_height(px(16.0))
                        .text_color(muted)
                        .child(sub.to_owned()),
                );
            }

            if model.is_new {
                label_group = label_group.child(
                    div()
                        .flex_none()
                        .px(px(4.0))
                        .py(px(1.0))
                        .rounded(px(4.0))
                        .bg(hsla_alpha(tokens.info, 0.15))
                        .text_size(px(10.0))
                        .line_height(px(14.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(hsla(tokens.info_foreground))
                        .child("New"),
                );
            }

            row = row.child(label_group);
            list = list.child(row);
        }
    }

    let right_column = div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .overflow_hidden()
        .child(search_row)
        .child(list);

    content = content.child(right_column);

    div()
        .id("composer-model-picker-popup")
        .flex()
        .flex_col()
        .w(px(PICKER_WIDTH_PX))
        .max_h(px(PICKER_MAX_HEIGHT_PX))
        .rounded(px(PICKER_RADIUS_PX))
        .overflow_hidden()
        .bg(glass_bg)
        .border_1()
        .border_color(glass_divider)
        .shadow_lg()
        .occlude()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(content)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use conn_contract::{ServerProviderAuthStatus, ServerProvidersItemItemAuth};

    use super::*;

    fn sample_provider(
        instance_id: &str,
        driver: &str,
        display_name: &str,
        models: Vec<(&str, &str)>,
    ) -> Option<ServerProvidersItemItem> {
        Some(ServerProvidersItemItem {
            instance_id: instance_id.to_owned(),
            driver: driver.to_owned(),
            display_name: Some(display_name.to_owned()),
            accent_color: None,
            icon_url: None,
            badge_label: None,
            continuation: None,
            show_interaction_mode_toggle: None,
            reports_context_window: None,
            supported_runtime_modes: None,
            supports_conversation_rollback: None,
            supports_text_generation: None,
            setup: None,
            native_sessions: None,
            configurable_providers: None,
            runtime_paths: None,
            enabled: true,
            installed: true,
            version: None,
            installed_version: None,
            status: ServerProviderState::Ready,
            auth: ServerProvidersItemItemAuth {
                status: ServerProviderAuthStatus::Authenticated,
                r#type: None,
                label: None,
                email: None,
                action: None,
                can_logout: None,
                subscription_sharing: None,
                profile_id: None,
                workspace_id: None,
                endpoint: None,
            },
            checked_at: "2026-11-21T00:00:00Z".to_owned(),
            message: None,
            availability: None,
            unavailable_reason: None,
            models: models
                .into_iter()
                .map(|(slug, name)| ServerProvidersItemItemModelsItem {
                    slug: slug.to_owned(),
                    name: name.to_owned(),
                    short_name: None,
                    sub_provider: None,
                    aliases: None,
                    badge: None,
                    is_custom: false,
                    is_default: None,
                    is_legacy: None,
                    supports_text_generation: None,
                    capabilities: None,
                })
                .collect(),
            update_required_models: None,
            slash_commands: None,
            skills: None,
            workspace_snapshots: None,
            usage_limits: None,
            version_advisory: None,
            compatibility_advisory: None,
            update_state: None,
            catalog_digest: None,
            loaded_catalog_digest: None,
        })
    }

    #[test]
    fn catalog_parses_providers_and_filters_by_provider_and_query() {
        let providers = vec![
            sample_provider(
                "claude-1",
                "claudeAgent",
                "Claude",
                vec![("claude-sonnet-4-5", "Claude Sonnet 4.5")],
            ),
            sample_provider(
                "codex-1",
                "codex",
                "Codex",
                vec![("gpt-5.4", "GPT-5.4"), ("gpt-5.3", "GPT-5.3")],
            ),
        ];

        let catalog = ModelCatalog::from_providers(&providers);
        assert_eq!(catalog.providers.len(), 2, "two providers parsed");

        let codex_only = catalog.filtered_models(Some("codex-1"), "");
        assert_eq!(codex_only.len(), 2, "provider filter returns codex models");
        assert_eq!(codex_only[0].slug, "gpt-5.4", "preserves model order");

        let searched = catalog.filtered_models(Some("codex-1"), "sonnet");
        assert_eq!(searched.len(), 1, "search spans across all providers");
        assert_eq!(
            searched[0].instance_id, "claude-1",
            "search finds claude model"
        );
    }
}
