//! Conn-styled floating model picker (`ProviderModelPicker` / `ModelPickerContent` parity).
//!
//! Populated from the live `subscribeServerConfig` catalog (`conn_state::providers`).
//! Renders as a floating `dropdown-glass` surface (`12px` radius, `shell_overlay` fill,
//! `glass_divider` 1px border, `8px` row radius, `shell_highlight` hover).

use conn_theme::Tokens;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, Context, Entity, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, div, px,
};

use super::super::color::{hsla, hsla_alpha};
use super::super::icons;
use super::Composer;
use super::actions::FollowUpBehavior;
use super::footer::{
    RuntimeModeOption, popover_surface, render_permissions_section, runtime_mode_option,
};
use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome::ConnTooltipExt as _;

/// Popup corner radius matching Conn's `rounded-xl` (`12px`) on `dropdown-glass`.
const PICKER_RADIUS_PX: f32 = 12.0;
/// Row corner radius matching Conn's `rounded-lg` (`8px`).
const PICKER_ROW_RADIUS_PX: f32 = 8.0;
/// Popup width matching `max-w-90` (`360px`).
const PICKER_WIDTH_PX: f32 = 360.0;
/// Fixed docked popup height matching `h-86.5` (`346px`).
const PICKER_MAX_HEIGHT_PX: f32 = 346.0;
/// Left provider sidebar width matching `w-11` (`44px`).
const SIDEBAR_WIDTH_PX: f32 = 44.0;
/// Docked effort column width (`w-48`).
const EFFORT_COLUMN_WIDTH_PX: f32 = 192.0;
/// Superheroicons concepts for `ZapIcon` and `ListPlus`.
const ICON_FAST: &str = "superhero/fast.svg";
const ICON_QUEUE: &str = "superhero/list-add.svg";

/// Superheroicons 16/solid paths used by the model picker.
pub(super) const ICON_SEARCH: &str = "superhero/search.svg";
pub(super) const ICON_CHECK: &str = "superhero/check.svg";
const ICON_STAR: &str = "superhero/star.svg";

pub(crate) use conn_state::providers::{
    ColumnControls, FAVORITES_TAB, ModelCatalog, ModelOption, ModelOptionDescriptor, OptionMap,
    ProviderGroup,
};

/// Parameters for rendering the docked model picker popup.
pub(super) struct ModelPickerView<'a> {
    pub(super) catalog: &'a ModelCatalog,
    pub(super) loading: bool,
    pub(super) active_instance_id: Option<&'a str>,
    pub(super) active_model: &'a str,
    pub(super) selected_provider: Option<&'a str>,
    pub(super) search_input: &'a Entity<InputState>,
    pub(super) query: &'a str,
    pub(super) highlighted_index: usize,
    pub(super) tokens: &'a Tokens,
    /// The selected model, whose levels the effort column lists.
    pub(super) selected: Option<&'a ModelOption>,
    pub(super) selected_options: Option<&'a OptionMap>,
    pub(super) runtime_mode: &'a str,
    pub(super) runtime_options: &'a [RuntimeModeOption],
    pub(super) permissions_open: bool,
    pub(super) permission_preview: Option<&'static str>,
    pub(super) follow_up: FollowUpBehavior,
}

/// Renders Conn's docked model picker: model list, effort column (`w-48`), and picker footer.
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
    // The rail always offers Favorites (`showFavorites`), so one provider still gets a rail.
    let show_sidebar = !is_searching && view.catalog.picker_providers().count() > 0;
    let favorites_tab = view.selected_provider == Some(FAVORITES_TAB);
    let effective_provider = view
        .selected_provider
        .or(view.active_instance_id)
        .or_else(|| {
            view.catalog
                .picker_providers()
                .next()
                .map(|p| p.instance_id.as_str())
        });
    let models = view.catalog.filtered_models(effective_provider, view.query);
    let setup_notice = (!is_searching)
        .then(|| {
            view.catalog
                .picker_providers()
                .find(|p| Some(p.instance_id.as_str()) == effective_provider)
                .and_then(|p| {
                    p.setup_notice()
                        .map(|notice| (p.instance_id.clone(), notice))
                })
        })
        .flatten();

    let mut content = div()
        .flex()
        .flex_row()
        .flex_none()
        .w(px(PICKER_WIDTH_PX))
        .h(px(PICKER_MAX_HEIGHT_PX))
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

        let star_color = if favorites_tab { fg } else { muted };
        let mut favorites_btn = div()
            .id("model-picker-provider-favorites")
            .a11y_tab(
                "composer.model-picker.provider.favorites",
                "Favorites",
                favorites_tab,
            )
            .conn_tooltip("Favorites", tokens)
            .relative()
            .flex()
            .items_center()
            .justify_center()
            .w_full()
            .h(px(36.0))
            .rounded(px(6.0))
            .cursor_pointer()
            .hover(move |s| s.bg(highlight_bg))
            .on_click(cx.listener(|composer, _, _, cx| {
                composer.select_picker_provider(FAVORITES_TAB.to_owned(), cx);
            }))
            .child(icons::icon(ICON_STAR, 18.0, star_color));
        if favorites_tab {
            favorites_btn = favorites_btn.child(
                div()
                    .absolute()
                    .right(px(0.0))
                    .w(px(3.0))
                    .h(px(20.0))
                    .rounded_full()
                    .bg(hsla(tokens.primary)),
            );
        }
        rail = rail.child(favorites_btn);

        for provider in view.catalog.picker_providers() {
            let is_selected = effective_provider == Some(provider.instance_id.as_str());
            let provider_id = provider.instance_id.clone();
            let icon_color = if is_selected { fg } else { muted };
            let disabled = provider.rail_disabled();
            let label = provider.rail_label();
            let btn = div()
                .id(SharedString::from(format!(
                    "model-picker-provider-{}",
                    provider.instance_id
                )))
                .a11y_tab(
                    format!("composer.model-picker.provider.{}", provider.instance_id),
                    label.clone(),
                    is_selected,
                )
                .conn_tooltip(label, tokens)
                .relative()
                .flex()
                .items_center()
                .justify_center()
                .w_full()
                .h(px(36.0))
                .rounded(px(6.0))
                .child(crate::icons::provider_mark(
                    &provider.driver,
                    18.0,
                    icon_color,
                ));
            let mut btn = if disabled {
                btn.opacity(0.5).cursor_not_allowed()
            } else {
                btn.cursor_pointer()
                    .hover(move |s| s.bg(highlight_bg))
                    .on_click(cx.listener(move |composer, _, _, cx| {
                        composer.select_picker_provider(provider_id.clone(), cx);
                    }))
            };

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
        .a11y_group("composer.model-picker.list", "Models")
        .flex()
        .flex_col()
        .gap(px(2.0))
        .p(px(6.0))
        .flex_1()
        .min_h_0()
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
    } else if models.is_empty() && setup_notice.is_none() {
        list = list.child(
            div()
                .px(px(10.0))
                .py(px(14.0))
                .text_size(px(13.0))
                .line_height(px(20.0))
                .text_color(muted)
                .child(if favorites_tab && !is_searching {
                    "No favorites yet"
                } else {
                    "No models found"
                }),
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
            let is_favorite = view.catalog.is_favorite(model);
            let group_name = SharedString::from(format!(
                "model-picker-row-group-{}-{}",
                model.instance_id, model.slug
            ));
            let star = {
                let instance_id = model.instance_id.clone();
                let slug = model.slug.clone();
                let label = if is_favorite {
                    "Remove from favorites"
                } else {
                    "Add to favorites"
                };
                // In Favorites every row is starred, so the star shows on hover there.
                let on_hover_only = !is_favorite || (favorites_tab && !is_searching);
                let star_color = if is_favorite {
                    hsla(tokens.warning)
                } else {
                    muted
                };
                div()
                    .id(SharedString::from(format!(
                        "model-picker-favorite-{}-{}",
                        model.instance_id, model.slug
                    )))
                    .a11y_button(
                        format!(
                            "composer.model-picker.favorite.{}.{}",
                            model.instance_id, model.slug
                        ),
                        format!("{label}: {}", model.display_label()),
                    )
                    .conn_tooltip(label, tokens)
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .size(px(18.0))
                    .rounded(px(4.0))
                    .cursor_pointer()
                    .when(on_hover_only, |el| {
                        el.opacity(0.0)
                            .group_hover(group_name.clone(), |s| s.opacity(1.0))
                    })
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |composer, _, _, cx| {
                        cx.stop_propagation();
                        composer.toggle_model_favorite(instance_id.clone(), slug.clone(), cx);
                    }))
                    .child(icons::icon(ICON_STAR, 12.0, star_color))
            };

            let mut row = div()
                .group(group_name.clone())
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
                        .child(model.display_label()),
                );

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

            row = row.child(label_group).child(star).child(
                div()
                    .flex_none()
                    .size(px(14.0))
                    .when(is_active, |el| el.child(icons::icon(ICON_CHECK, 14.0, fg))),
            );
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
        .child(list)
        .when_some(setup_notice, |column, (instance_id, notice)| {
            let link = hsla(tokens.primary);
            let link_hover = hsla_alpha(tokens.primary, 0.12);
            column.child(
                div()
                    .id("composer.model-picker.provider-notice")
                    .a11y_group("composer.model-picker.provider-notice", notice.clone())
                    .flex_none()
                    .max_h(px(176.0))
                    .overflow_hidden()
                    .p(px(8.0))
                    .border_t_1()
                    .border_color(glass_divider)
                    .child(
                        div()
                            .px(px(4.0))
                            .pt(px(6.0))
                            .text_size(px(12.0))
                            .line_height(px(16.5))
                            .line_clamp(3)
                            .text_color(muted)
                            .child(notice),
                    )
                    .child(
                        div()
                            .id("composer.model-picker.open-provider-setup")
                            .a11y_button(
                                "composer.model-picker.open-provider-setup",
                                "Open provider setup",
                            )
                            .mx(px(4.0))
                            .mt(px(4.0))
                            .px(px(4.0))
                            .rounded(px(4.0))
                            .self_start()
                            .text_size(px(12.0))
                            .line_height(px(16.5))
                            .text_color(link)
                            .cursor_pointer()
                            .hover(move |s| s.bg(link_hover))
                            .on_click(cx.listener(move |composer, _, _, cx| {
                                composer.open_provider_setup(instance_id.clone(), cx);
                            }))
                            .child("Open provider setup"),
                    ),
            )
        });

    // `updateRequiredNotices`: for the selected provider, or every provider while searching.
    let update_notices: Vec<(String, String)> = view
        .catalog
        .picker_providers()
        .filter(|provider| {
            is_searching || Some(provider.instance_id.as_str()) == effective_provider
        })
        .filter_map(|provider| {
            provider
                .update_required_notice(view.query)
                .map(|notice| (provider.instance_id.clone(), notice))
        })
        .collect();
    let right_column =
        right_column.children(update_notices.into_iter().map(|(instance_id, notice)| {
            div()
                .id(SharedString::from(format!(
                    "composer.model-picker.update-required.{instance_id}"
                )))
                .a11y_group(
                    format!("composer.model-picker.update-required.{instance_id}"),
                    notice.clone(),
                )
                .flex_none()
                .border_t_1()
                .border_color(glass_divider)
                .px(px(12.0))
                .py(px(8.0))
                .text_size(px(13.0))
                .line_height(px(18.0))
                .text_color(muted)
                .child(notice)
        }));

    content = content.child(right_column);

    let row = div()
        .flex()
        .flex_row()
        .h(px(PICKER_MAX_HEIGHT_PX))
        .child(content)
        .child(render_effort_column(view, cx));

    div()
        .id("composer-model-picker-popup")
        .a11y_group("composer.model-picker", "Model picker")
        .flex()
        .flex_col()
        .w(px(PICKER_WIDTH_PX + EFFORT_COLUMN_WIDTH_PX))
        .rounded(px(PICKER_RADIUS_PX))
        .bg(glass_bg)
        .border_1()
        .border_color(glass_divider)
        .shadow_lg()
        .occlude()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(
            div()
                .rounded_t(px(PICKER_RADIUS_PX))
                .overflow_hidden()
                .child(row),
        )
        .child(render_picker_footer(view, cx))
        .into_any_element()
}

/// Header label of the effort column (`descriptor.label`, `Options`, or `Effort`).
fn effort_column_header(controls: Option<&ColumnControls<'_>>) -> String {
    match controls {
        Some(c) => match c.effort {
            Some(effort) => effort.label().to_owned(),
            None if !c.others.is_empty() => "Options".to_owned(),
            None => "Effort".to_owned(),
        },
        None => "Effort".to_owned(),
    }
}

/// `ComposerEffortColumn`: header aligned with the search row, reasoning levels, then options.
fn render_effort_column(view: &ModelPickerView<'_>, cx: &mut Context<'_, Composer>) -> AnyElement {
    let tokens = view.tokens;
    let fg = hsla(tokens.foreground);
    let muted = hsla(tokens.muted_foreground);
    let divider = hsla_alpha(tokens.border, 0.70);
    let row_hover = hsla_alpha(tokens.foreground, 0.09);
    let controls = view.selected.map(ModelOption::column_controls);
    let model_label = view
        .selected
        .map(ModelOption::trigger_label)
        .unwrap_or_else(|| view.active_model.to_owned());

    let header = div().flex_none().px(px(12.0)).pt(px(10.0)).child(
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .h(px(33.0))
            .pb(px(6.0))
            .border_b_1()
            .border_color(divider)
            .text_size(px(13.0))
            .line_height(px(20.0))
            .child(
                div()
                    .text_color(muted)
                    .child(effort_column_header(controls.as_ref())),
            )
            .child(
                div()
                    .ml_auto()
                    .min_w_0()
                    .truncate()
                    .text_size(px(12.0))
                    .line_height(px(16.0))
                    .text_color(muted)
                    .child(model_label),
            ),
    );

    let mut rows = div()
        .id("model-picker-effort-rows")
        .a11y_group("composer.model-picker.effort", "Effort levels")
        .flex()
        .flex_col()
        .gap(px(2.0))
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .px(px(8.0))
        .pt(px(10.0))
        .pb(px(6.0));

    let no_effort = || {
        div()
            .flex()
            .items_center()
            .h(px(32.0))
            .px(px(8.0))
            .text_size(px(13.0))
            .text_color(muted)
            .child("No effort levels")
    };

    match (view.selected, controls.as_ref()) {
        (Some(model), Some(c)) if c.effort.is_some() || !c.others.is_empty() => {
            if let Some(effort) = c.effort {
                rows = rows.children(render_effort_rows(
                    model,
                    effort,
                    view.selected_options,
                    tokens,
                    fg,
                    muted,
                    row_hover,
                    cx,
                ));
            }
            if !c.others.is_empty() {
                let mut others = div().flex().flex_col().gap(px(2.0));
                if c.effort.is_some() {
                    others = others
                        .mt(px(4.0))
                        .pt(px(4.0))
                        .border_t_1()
                        .border_color(divider);
                }
                for descriptor in &c.others {
                    others = others.child(render_option_row(
                        model,
                        descriptor,
                        view.selected_options,
                        fg,
                        muted,
                        row_hover,
                        tokens,
                        cx,
                    ));
                }
                rows = rows.child(others);
            }
        }
        _ => rows = rows.child(no_effort()),
    }

    div()
        .flex()
        .flex_col()
        .flex_none()
        .w(px(EFFORT_COLUMN_WIDTH_PX))
        .h_full()
        .border_l_1()
        .border_color(divider)
        .bg(hsla_alpha(tokens.muted, 0.40))
        .child(header)
        .child(rows)
        .into_any_element()
}

/// Reasoning radio rows (`EffortRows`).
#[expect(clippy::too_many_arguments, reason = "row styling inputs")]
fn render_effort_rows(
    model: &ModelOption,
    effort: &ModelOptionDescriptor,
    selected: Option<&OptionMap>,
    tokens: &Tokens,
    fg: gpui_kit::Hsla,
    muted: gpui_kit::Hsla,
    row_hover: gpui_kit::Hsla,
    cx: &mut Context<'_, Composer>,
) -> Vec<AnyElement> {
    let mut out = Vec::new();
    match effort {
        ModelOptionDescriptor::Boolean { id, .. } => {
            let current = effort.bool_value(selected);
            for value in [true, false] {
                let option_id = id.clone();
                out.push(
                    column_row(
                        SharedString::from(format!("model-picker-effort-{id}-{value}")),
                        if value { "On" } else { "Off" }.to_owned(),
                        current == value,
                        false,
                        fg,
                        muted,
                        row_hover,
                    )
                    .on_click(cx.listener(move |composer, _, _, cx| {
                        composer.set_model_option(
                            option_id.clone(),
                            serde_json::Value::Bool(value),
                            cx,
                        );
                    }))
                    .into_any_element(),
                );
            }
        }
        ModelOptionDescriptor::Select { id, .. } => {
            let value = effort.select_value(selected).map(str::to_owned);
            for choice in effort.selectable_choices() {
                let option_id = id.clone();
                let choice_id = choice.id.clone();
                let mut row = column_row(
                    SharedString::from(format!(
                        "model-picker-effort-{}-{}-{}",
                        model.slug, id, choice.id
                    )),
                    choice.label.clone(),
                    value.as_deref() == Some(choice.id.as_str()),
                    choice.is_default,
                    fg,
                    muted,
                    row_hover,
                )
                .on_click(cx.listener(move |composer, _, _, cx| {
                    composer.set_model_option(
                        option_id.clone(),
                        serde_json::Value::String(choice_id.clone()),
                        cx,
                    );
                }));
                if let Some(description) = &choice.description {
                    row = row.conn_tooltip(description.clone(), tokens);
                }
                out.push(row.into_any_element());
            }
        }
    }
    out
}

/// `ColumnRow`: `h-8` label, `Default` hint, and trailing check.
fn column_row(
    id: SharedString,
    label: String,
    selected: bool,
    is_default: bool,
    fg: gpui_kit::Hsla,
    muted: gpui_kit::Hsla,
    row_hover: gpui_kit::Hsla,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id.clone())
        .a11y_button(id, label.clone())
        .aria_selected(selected)
        .flex()
        .flex_none()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .h(px(32.0))
        .w_full()
        .px(px(8.0))
        .rounded(px(4.0))
        .cursor_pointer()
        .text_size(px(13.0))
        .line_height(px(20.0))
        .text_color(fg)
        .hover(move |s| s.bg(row_hover))
        .child(div().flex_1().min_w_0().truncate().child(label))
        .when(selected, |el| el.child(icons::icon(ICON_CHECK, 14.0, fg)))
        .when(!selected && is_default, |el| {
            el.child(
                div()
                    .text_size(px(12.0))
                    .line_height(px(16.0))
                    .text_color(gpui_kit::Hsla {
                        a: muted.a * 0.7,
                        ..muted
                    })
                    .child("Default"),
            )
        })
}

/// `OptionMenuRow` / `OptionSwitchRow`: a select cycles to its next choice, a switch toggles.
#[expect(clippy::too_many_arguments, reason = "row styling inputs")]
fn render_option_row(
    model: &ModelOption,
    descriptor: &ModelOptionDescriptor,
    selected: Option<&OptionMap>,
    fg: gpui_kit::Hsla,
    muted: gpui_kit::Hsla,
    row_hover: gpui_kit::Hsla,
    tokens: &Tokens,
    cx: &mut Context<'_, Composer>,
) -> AnyElement {
    let id = descriptor.id().to_owned();
    let row_id = SharedString::from(format!("model-picker-option-{}-{id}", model.slug));
    let base = div()
        .id(row_id)
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .w_full()
        .px(px(8.0))
        .py(px(4.0))
        .rounded(px(4.0))
        .cursor_pointer()
        .hover(move |s| s.bg(row_hover));
    let text = |value: String| {
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .child(
                div()
                    .truncate()
                    .text_size(px(12.0))
                    .line_height(px(16.0))
                    .text_color(muted)
                    .child(descriptor.label().to_owned()),
            )
            .child(
                div()
                    .truncate()
                    .text_size(px(13.0))
                    .line_height(px(20.0))
                    .text_color(fg)
                    .child(value),
            )
    };
    match descriptor {
        ModelOptionDescriptor::Boolean { .. } => {
            let checked = descriptor.bool_value(selected);
            let track = if checked {
                hsla(tokens.switch_on)
            } else {
                hsla_alpha(tokens.input, 0.80)
            };
            base.a11y_button(
                SharedString::from(format!("model-picker-switch-{id}")),
                descriptor.label().to_owned(),
            )
            .aria_selected(checked)
            .on_click(cx.listener(move |composer, _, _, cx| {
                composer.set_model_option(id.clone(), serde_json::Value::Bool(!checked), cx);
            }))
            .child(text(if checked { "On" } else { "Off" }.to_owned()))
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .w(px(28.0))
                    .h(px(16.0))
                    .p(px(2.0))
                    .rounded_full()
                    .bg(track)
                    .when(checked, |el| el.justify_end())
                    .child(
                        div()
                            .size(px(12.0))
                            .rounded_full()
                            .bg(hsla(tokens.background)),
                    ),
            )
            .into_any_element()
        }
        ModelOptionDescriptor::Select { .. } => {
            let choices = descriptor.selectable_choices();
            let current = descriptor.select_value(selected).map(str::to_owned);
            let current_label = choices
                .iter()
                .find(|c| Some(c.id.as_str()) == current.as_deref())
                .map(|c| c.label.clone())
                .unwrap_or_default();
            let next = choices
                .iter()
                .position(|c| Some(c.id.as_str()) == current.as_deref())
                .map_or(0, |i| (i + 1) % choices.len().max(1));
            let next_id = choices.get(next).map(|c| c.id.clone());
            base.a11y_button(
                SharedString::from(format!("model-picker-select-{id}")),
                format!("{}: {current_label}", descriptor.label()),
            )
            .on_click(cx.listener(move |composer, _, _, cx| {
                if let Some(next_id) = next_id.clone() {
                    composer.set_model_option(id.clone(), serde_json::Value::String(next_id), cx);
                }
            }))
            .child(text(current_label))
            .child(icons::icon(icons::CARET_RIGHT, 14.0, muted))
            .into_any_element()
        }
    }
}

/// `ComposerPickerFooter`: speed segments, follow-up behavior, and the permissions menu.
fn render_picker_footer(view: &ModelPickerView<'_>, cx: &mut Context<'_, Composer>) -> AnyElement {
    let tokens = view.tokens;
    let fg = hsla(tokens.foreground);
    let muted = hsla(tokens.muted_foreground);
    let divider = hsla_alpha(tokens.border, 0.70);
    let row_hover = hsla_alpha(tokens.foreground, 0.09);

    let mut footer = div()
        .flex()
        .flex_row()
        .flex_wrap()
        .items_center()
        .gap(px(8.0))
        .px(px(12.0))
        .py(px(8.0))
        .border_t_1()
        .border_color(divider)
        .bg(hsla_alpha(tokens.muted, 0.40))
        .rounded_b(px(PICKER_RADIUS_PX));

    if let Some(model) = view.selected {
        let controls = model.column_controls();
        let mut segments: Vec<(String, String, serde_json::Value, bool, Option<String>)> =
            Vec::new();
        if let Some(speed) = controls.speed_select {
            let value = speed.select_value(view.selected_options).map(str::to_owned);
            for choice in speed.selectable_choices() {
                segments.push((
                    speed.id().to_owned(),
                    choice.label.clone(),
                    serde_json::Value::String(choice.id.clone()),
                    value.as_deref() == Some(choice.id.as_str()),
                    choice.description.clone(),
                ));
            }
        } else if let Some(fast) = controls.fast_toggle {
            let on = fast.bool_value(view.selected_options);
            for value in [false, true] {
                segments.push((
                    fast.id().to_owned(),
                    if value { "Fast" } else { "Standard" }.to_owned(),
                    serde_json::Value::Bool(value),
                    on == value,
                    None,
                ));
            }
        }
        if !segments.is_empty() {
            let count = segments.len();
            let mut group = segment_group(tokens);
            for (index, (option_id, label, value, checked, description)) in
                segments.into_iter().enumerate()
            {
                let bolt = matches!(label.as_str(), "Fast" | "Ultrafast");
                let mut seg = segment(
                    SharedString::from(format!("model-picker-speed-{index}")),
                    checked,
                    index,
                    count,
                    fg,
                    muted,
                    tokens,
                )
                .on_click(cx.listener(move |composer, _, _, cx| {
                    composer.set_model_option(option_id.clone(), value.clone(), cx);
                }))
                .when(bolt, |el| {
                    el.child(icons::icon(
                        ICON_FAST,
                        12.0,
                        if checked { fg } else { muted },
                    ))
                })
                .child(label);
                if let Some(description) = description {
                    seg = seg.conn_tooltip(description, tokens);
                }
                group = group.child(seg);
            }
            footer = footer.child(group);
        }
    }

    // Follow-up behavior while a turn runs (`settings.followUpBehavior`).
    let mut follow = segment_group(tokens);
    for (index, behavior) in [FollowUpBehavior::Steer, FollowUpBehavior::Queue]
        .into_iter()
        .enumerate()
    {
        let checked = view.follow_up == behavior;
        follow = follow.child(
            segment(
                SharedString::from(format!("model-picker-follow-up-{}", behavior.verb())),
                checked,
                index,
                2,
                fg,
                muted,
                tokens,
            )
            .on_click(cx.listener(move |composer, _, _, cx| {
                composer.set_follow_up_behavior(behavior, cx);
            }))
            .child(icons::icon(
                match behavior {
                    FollowUpBehavior::Steer => icons::FORWARD,
                    FollowUpBehavior::Queue => ICON_QUEUE,
                },
                12.0,
                if checked { fg } else { muted },
            ))
            .child(behavior.label()),
        );
    }
    footer = footer.child(
        div()
            .id("model-picker-follow-up")
            .a11y_group("composer.model-picker.follow-up", "Follow-up behavior")
            .child(follow)
            .conn_tooltip("While a turn runs: steer it, or queue after it", tokens),
    );

    // `PermissionsMenu`: current mode icon + label + chevron, opening the section above.
    let current = runtime_mode_option(view.runtime_mode);
    let open = view.permissions_open;
    let mut permissions = div().relative().ml_auto().child(
        div()
            .id("model-picker-permissions-trigger")
            .a11y_button(
                "composer.picker-permissions",
                format!("Permissions: {}", current.label),
            )
            .aria_expanded(open)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .h(px(28.0))
            .px(px(8.0))
            .rounded(px(6.0))
            .cursor_pointer()
            .text_size(px(12.0))
            .line_height(px(16.0))
            .text_color(if open { fg } else { muted })
            .when(open, |el| el.bg(row_hover))
            .hover(move |s| s.bg(row_hover).text_color(fg))
            .on_click(cx.listener(|composer, _, _, cx| {
                composer.toggle_picker_permissions_menu(cx);
            }))
            .child(icons::icon(
                current.icon,
                14.0,
                if open { fg } else { muted },
            ))
            .child(current.label)
            .child(icons::icon("superhero/chevron-up.svg", 12.0, muted)),
    );
    if open {
        let section = render_permissions_section(
            view.runtime_mode,
            view.runtime_options,
            view.permission_preview,
            "picker",
            tokens,
            cx,
        );
        permissions =
            permissions.child(
                gpui_kit::deferred(div().absolute().bottom_full().right_0().mb(px(4.0)).child(
                    popover_surface("model-picker-permissions-popup", tokens).child(section),
                ))
                .with_priority(4),
            );
    }
    footer.child(permissions).into_any_element()
}

/// `rounded-lg bg-input/40 p-0.5` segmented group.
fn segment_group(tokens: &Tokens) -> gpui_kit::Div {
    div()
        .flex()
        .flex_row()
        .rounded(px(8.0))
        .bg(hsla_alpha(tokens.input, 0.40))
        .p(px(2.0))
}

/// `FOOTER_SEGMENT`: `h-6 px-2 text-xs`, checked `bg-input/72`.
fn segment(
    id: SharedString,
    checked: bool,
    index: usize,
    count: usize,
    fg: gpui_kit::Hsla,
    muted: gpui_kit::Hsla,
    tokens: &Tokens,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let checked_bg = hsla_alpha(tokens.input, 0.72);
    div()
        .id(id.clone())
        .a11y_button(id.clone(), id)
        .aria_selected(checked)
        .flex()
        .flex_row()
        .items_center()
        .justify_center()
        .gap(px(4.0))
        .h(px(24.0))
        .px(px(8.0))
        .cursor_pointer()
        .text_size(px(12.0))
        .line_height(px(16.0))
        .text_color(if checked { fg } else { muted })
        .when(index == 0, |el| el.rounded_l(px(6.0)))
        .when(index + 1 == count, |el| el.rounded_r(px(6.0)))
        .when(checked, |el| el.bg(checked_bg))
        .hover(move |s| s.text_color(fg))
}
