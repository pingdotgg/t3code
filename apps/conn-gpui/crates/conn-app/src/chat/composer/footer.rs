//! Composer footer mode controls (`ComposerFooterControls.tsx`, `runtimeModeConfig.ts`,
//! `composerControlsOwnership.ts` parity).
//!
//! - Plan / Build toggle (`PencilRulerIcon` -> `design`, `BotIcon` -> `agent`).
//! - Permissions chip, shown only while the thread's mode differs from the default.
//! - `ComposerPermissionsSection`: the 4-segment icon radio with a hover preview.

use conn_theme::Tokens;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, Context, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _,
    TestSupportExt as _, div, px,
};

use super::super::color::{hsla, hsla_alpha};
use super::super::icons;
use super::Composer;
use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome::ConnTooltipExt as _;

/// Footer control height (`ComposerControl size="sm"`, `h-7`).
pub(super) const FOOTER_CONTROL_HEIGHT_PX: f32 = 28.0;

/// One permission mode (`runtimeModeConfig`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RuntimeModeOption {
    pub(crate) mode: &'static str,
    pub(crate) label: &'static str,
    pub(crate) description: &'static str,
    pub(crate) icon: &'static str,
}

/// Conn's four permission modes, in `runtimeModeOptions` order.
pub(crate) const RUNTIME_MODES: [RuntimeModeOption; 4] = [
    RuntimeModeOption {
        mode: "approval-required",
        label: "Supervised",
        description: "Ask before commands and file changes.",
        icon: "superhero/lock.svg",
    },
    RuntimeModeOption {
        mode: "auto-accept-edits",
        label: "Auto-accept edits",
        description: "Auto-approve edits, ask before other actions.",
        icon: "superhero/edit.svg",
    },
    RuntimeModeOption {
        mode: "auto",
        label: "Auto",
        description: "Supported providers approve routine actions; others still ask.",
        icon: "superhero/ai.svg",
    },
    RuntimeModeOption {
        mode: "full-access",
        label: "Full access",
        description: "Allow commands and edits without prompts.",
        icon: "superhero/shield-off.svg",
    },
];

/// The option for `mode`, falling back to Supervised like Conn's `supervisedRuntimeModeOption`.
#[must_use]
pub(crate) fn runtime_mode_option(mode: &str) -> RuntimeModeOption {
    RUNTIME_MODES
        .iter()
        .find(|option| option.mode == mode)
        .copied()
        .unwrap_or(RUNTIME_MODES[0])
}

/// `resolveCompatibleRuntimeMode`: the modes a provider supports (all when it reports none).
#[must_use]
pub(crate) fn compatible_runtime_modes(supported: &[String]) -> Vec<RuntimeModeOption> {
    if supported.is_empty() {
        return RUNTIME_MODES.to_vec();
    }
    RUNTIME_MODES
        .iter()
        .filter(|option| supported.iter().any(|mode| mode == option.mode))
        .copied()
        .collect()
}

/// `resolveComposerControlsOwnership.accessDisplay`: the footer chip hides while the mode is the
/// user's default or the new-thread strip already names it.
#[must_use]
pub(crate) fn footer_permissions_visible(
    runtime_mode: &str,
    default_runtime_mode: &str,
    shown_in_strip: bool,
) -> bool {
    !(runtime_mode == default_runtime_mode || shown_in_strip)
}

/// Plan / Build toggle (`ComposerFooterModeControls` interaction toggle).
pub(super) fn render_interaction_mode_toggle(
    plan_active: bool,
    tokens: &Tokens,
    cx: &mut Context<'_, Composer>,
) -> AnyElement {
    let fg = hsla(tokens.foreground);
    let muted = hsla(tokens.muted_foreground);
    let hover_bg = hsla(tokens.shell_highlight);
    let tooltip = if plan_active {
        "Plan mode. Click to return to normal build mode"
    } else {
        "Default mode. Click to enter plan mode"
    };
    let (icon, label) = if plan_active {
        ("superhero/design.svg", "Plan")
    } else {
        ("superhero/agent.svg", "Build")
    };
    div()
        .id("composer-plan-mode-toggle")
        .test_support()
        .a11y_button("composer.plan-mode", tooltip)
        .aria_selected(plan_active)
        .flex()
        .flex_none()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .h(px(FOOTER_CONTROL_HEIGHT_PX))
        .px(px(8.0))
        .rounded_full()
        .cursor_pointer()
        .text_size(px(13.0))
        .line_height(px(20.0))
        .font_weight(FontWeight::MEDIUM)
        .text_color(if plan_active {
            hsla(tokens.accent_foreground)
        } else {
            hsla_alpha(tokens.foreground, 0.80)
        })
        // Conn: `aria-pressed:bg-accent aria-pressed:text-accent-foreground`.
        .when(plan_active, |el| el.bg(hsla(tokens.accent)))
        .hover(move |s| s.bg(hover_bg).text_color(fg))
        .on_click(cx.listener(|composer, _, _, cx| {
            composer.toggle_interaction_mode(cx);
        }))
        .conn_tooltip(tooltip, tokens)
        .child(icons::icon(
            icon,
            16.0,
            if plan_active {
                hsla(tokens.accent_foreground)
            } else {
                muted
            },
        ))
        .child(label)
        .into_any_element()
}

/// Footer permissions chip (only rendered while the mode differs from the default).
pub(super) fn render_permissions_chip(
    runtime_mode: &str,
    menu_open: bool,
    options: &[RuntimeModeOption],
    preview: Option<&'static str>,
    tokens: &Tokens,
    cx: &mut Context<'_, Composer>,
) -> AnyElement {
    let option = runtime_mode_option(runtime_mode);
    let fg = hsla(tokens.foreground);
    let label_color = hsla_alpha(tokens.foreground, 0.80);
    let hover_bg = hsla(tokens.shell_highlight);
    let tooltip = format!("Permissions: {}. {}", option.label, option.description);
    let mut slot = div().relative().flex_none().child(
        div()
            .id("composer-permissions-chip")
            .a11y_button(
                "composer.permissions",
                format!("Permissions: {}", option.label),
            )
            .aria_expanded(menu_open)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .h(px(FOOTER_CONTROL_HEIGHT_PX))
            .pl(px(6.0))
            .pr(px(8.0))
            .rounded_full()
            .cursor_pointer()
            .text_size(px(13.0))
            .line_height(px(20.0))
            .font_weight(FontWeight::MEDIUM)
            .text_color(if menu_open { fg } else { label_color })
            .when(menu_open, |el| el.bg(hover_bg))
            .hover(move |s| s.bg(hover_bg).text_color(fg))
            .on_click(cx.listener(|composer, _, _, cx| {
                composer.toggle_footer_permissions_menu(cx);
            }))
            .conn_tooltip(tooltip, tokens)
            // `emphasized`: the icon takes the label color, not muted.
            .child(icons::icon(option.icon, 16.0, label_color))
            .child(option.label),
    );
    if menu_open {
        let section =
            render_permissions_section(runtime_mode, options, preview, "footer", tokens, cx);
        slot =
            slot.child(
                gpui_kit::deferred(
                    div().absolute().bottom_full().left_0().mb(px(4.0)).child(
                        popover_surface("composer-permissions-popup", tokens).child(section),
                    ),
                )
                .with_priority(3),
            );
    }
    slot.into_any_element()
}

/// `MenuPopup` surface used by composer popovers.
pub(super) fn popover_surface(
    id: &'static str,
    tokens: &Tokens,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .rounded(px(10.0))
        .bg(hsla(tokens.popover))
        .border_1()
        .border_color(hsla(tokens.shell_inner_border))
        .shadow_md()
        .p(px(4.0))
        .occlude()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
}

/// `ComposerPermissionsSection`: `w-72` header, segmented icon radio, preview label + reserved
/// two-line description.
pub(super) fn render_permissions_section(
    runtime_mode: &str,
    options: &[RuntimeModeOption],
    preview: Option<&'static str>,
    id_prefix: &'static str,
    tokens: &Tokens,
    cx: &mut Context<'_, Composer>,
) -> AnyElement {
    let fg = hsla(tokens.foreground);
    let muted = hsla(tokens.muted_foreground);
    let shown_mode = preview.unwrap_or_else(|| runtime_mode_option(runtime_mode).mode);
    let shown = options
        .iter()
        .find(|option| option.mode == shown_mode)
        .copied()
        .unwrap_or_else(|| runtime_mode_option(shown_mode));

    let count = options.len();
    let mut group = div()
        .flex()
        .flex_row()
        .rounded(px(8.0))
        .bg(hsla_alpha(tokens.input, 0.40))
        .p(px(2.0));
    for (index, option) in options.iter().enumerate() {
        let checked = option.mode == runtime_mode;
        let mode = option.mode;
        let checked_bg = hsla_alpha(tokens.input, 0.72);
        let hover_bg = hsla(tokens.accent);
        group = group.child(
            div()
                .id(SharedString::from(format!(
                    "composer-permissions-{id_prefix}-{mode}"
                )))
                .a11y_button(
                    SharedString::from(format!("composer.permissions.{mode}")),
                    option.label,
                )
                .aria_selected(checked)
                .flex()
                .flex_1()
                .items_center()
                .justify_center()
                .h(px(24.0))
                .cursor_pointer()
                .when(index == 0, |el| el.rounded_l(px(6.0)))
                .when(index + 1 == count, |el| el.rounded_r(px(6.0)))
                .when(checked, |el| el.bg(checked_bg))
                .when(!checked, |el| el.hover(move |s| s.bg(hover_bg)))
                .on_hover(cx.listener(move |composer, hovered: &bool, _, cx| {
                    composer.preview_permission(mode, *hovered, cx);
                }))
                .on_click(cx.listener(move |composer, _, _, cx| {
                    composer.pick_runtime_mode(mode, cx);
                }))
                .child(icons::icon(
                    option.icon,
                    14.0,
                    if checked { fg } else { muted },
                )),
        );
    }

    div()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .w(px(288.0))
        .px(px(8.0))
        .py(px(6.0))
        .child(
            div()
                .text_size(px(12.0))
                .line_height(px(16.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(muted)
                .child("Permissions"),
        )
        .child(group)
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(2.0))
                .child(
                    div()
                        .text_size(px(13.0))
                        .line_height(px(20.0))
                        .text_color(if shown.mode == runtime_mode {
                            fg
                        } else {
                            muted
                        })
                        .child(shown.label),
                )
                .child(
                    // Two lines reserved so previews never shift the menu (`min-h-8`).
                    div()
                        .min_h(px(32.0))
                        .text_size(px(12.0))
                        .line_height(px(16.0))
                        .text_color(muted)
                        .child(shown.description),
                ),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_mode_labels_match_conn() {
        assert_eq!(
            runtime_mode_option("auto-accept-edits").label,
            "Auto-accept edits"
        );
        assert_eq!(runtime_mode_option("approval-required").label, "Supervised");
        assert_eq!(
            runtime_mode_option("full-access").icon,
            "superhero/shield-off.svg"
        );
        assert_eq!(
            runtime_mode_option("unknown").mode,
            "approval-required",
            "falls back to Supervised"
        );
    }

    #[test]
    fn compatible_modes_filter_to_provider_support() {
        assert_eq!(compatible_runtime_modes(&[]).len(), 4);
        let modes = compatible_runtime_modes(&["full-access".to_owned(), "auto".to_owned()]);
        let ids: Vec<_> = modes.iter().map(|m| m.mode).collect();
        assert_eq!(ids, vec!["auto", "full-access"], "keeps Conn's order");
    }

    #[test]
    fn footer_chip_hides_for_default_mode_or_strip() {
        assert!(!footer_permissions_visible(
            "full-access",
            "full-access",
            false
        ));
        assert!(footer_permissions_visible("auto", "full-access", false));
        assert!(!footer_permissions_visible("auto", "full-access", true));
    }
}
