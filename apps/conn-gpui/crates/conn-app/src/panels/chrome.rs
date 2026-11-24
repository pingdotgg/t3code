//! Conn's shared panel controls, drawn the same way in every surface (API, Database, MCP,
//! Tasks): the subheader toolbar row, `ToolbarGroup`, ghost icon buttons, the soft input group,
//! underlined section tabs (`ApiTabs`), the checkbox, warning notices and `dropdown-glass` menus.
//!
//! Metrics come from Conn's `index.css` (`--spacing-toolbar: 7.5px`, `--spacing-toolbar-end:
//! 11.5px`, `--toolbar-radius: 9999px`, `--toolbar-group-fill: var(--shell-control)`,
//! `--toolbar-group-border: var(--shell-divider-header)`) and `components/ui/*.tsx`.

use std::time::Duration;

use conn_contract::IssueActor;
use conn_theme::{Appearance, Tokens};
use gpui_kit::component::h_flex;
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, AnyView, App, BoxShadow, ClickEvent, Context, Div, ElementId, FontWeight, Hsla,
    InteractiveElement, IntoElement, MouseButton, ObjectFit, ParentElement, Render, Role,
    SharedString, SharedUri, Stateful, StatefulInteractiveElement, Styled, Window, deferred, div,
    img, point, px,
};

use super::color::to_hsla;
use super::header::superhero_icon;
use crate::a11y::ConnA11yExt as _;
use crate::theme::MONO_FONT;

/// Default tooltip show delay matching Conn's Base UI `TooltipProvider` (`600ms`).
pub(crate) const TOOLTIP_SHOW_DELAY: Duration = Duration::from_millis(600);
/// Shorter tooltip delay used inside Pull request detail views (`delay={150}`).
pub(crate) const TOOLTIP_FAST_DELAY: Duration = Duration::from_millis(150);

/// Visual variant matching Conn's `TooltipPopup` (`components/ui/tooltip.tsx`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TooltipVariant {
    /// Standard UI tooltip: `rounded-md px-2 py-1 text-xs leading-snug max-w-80`.
    Default,
    /// Monospace code tooltip (`variant="code"`): `font-mono text-[11px] leading-relaxed max-w-120`.
    Code,
}

/// Shared Conn `TooltipPopup` view rendered by GPUI's native `.tooltip(...)` hook.
struct ConnTooltip {
    text: SharedString,
    variant: TooltipVariant,
    bg: Hsla,
    fg: Hsla,
    border: Hsla,
    shadow: BoxShadow,
}

impl Render for ConnTooltip {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<'_, Self>) -> impl IntoElement {
        let mut popup = div()
            .rounded(px(6.0))
            .border_1()
            .border_color(self.border)
            .bg(self.bg)
            .text_color(self.fg)
            .px(px(8.0))
            .py(px(4.0))
            .shadow(vec![self.shadow.clone()]);

        popup = match self.variant {
            TooltipVariant::Default => popup
                .max_w(px(320.0))
                .text_size(px(12.0))
                .line_height(px(16.5)),
            TooltipVariant::Code => popup
                .max_w(px(480.0))
                .font_family(SharedString::from(MONO_FONT))
                .text_size(px(11.0))
                .line_height(px(17.875)),
        };

        // Offset from the pointer so the popup sits clear of the cursor, matching gpui-kit.
        div().m(px(12.0)).child(popup.child(self.text.clone()))
    }
}

/// Extension trait attaching Conn's `TooltipPopup` to any stateful GPUI element.
pub(crate) trait ConnTooltipExt: StatefulInteractiveElement + Sized {
    /// Attaches a standard Conn tooltip with the default `600ms` show delay.
    fn conn_tooltip(self, text: impl Into<SharedString>, tokens: &Tokens) -> Self {
        self.conn_tooltip_with(text, tokens, TooltipVariant::Default, TOOLTIP_SHOW_DELAY)
    }

    /// Attaches a standard Conn tooltip with the fast `150ms` PR detail show delay.
    fn conn_fast_tooltip(self, text: impl Into<SharedString>, tokens: &Tokens) -> Self {
        self.conn_tooltip_with(text, tokens, TooltipVariant::Default, TOOLTIP_FAST_DELAY)
    }

    /// Attaches a monospace code Conn tooltip (`variant="code"`) with `150ms` show delay.
    fn conn_code_tooltip(self, text: impl Into<SharedString>, tokens: &Tokens) -> Self {
        self.conn_tooltip_with(text, tokens, TooltipVariant::Code, TOOLTIP_FAST_DELAY)
    }

    /// Attaches a Conn tooltip with an explicit variant and show delay.
    fn conn_tooltip_with(
        self,
        text: impl Into<SharedString>,
        tokens: &Tokens,
        variant: TooltipVariant,
        delay: Duration,
    ) -> Self {
        let text: SharedString = text.into();
        let bg = to_hsla(tokens.popover);
        let fg = to_hsla(tokens.popover_foreground);
        let border = to_hsla(tokens.border);
        let shadow_alpha = match tokens.appearance {
            Appearance::Dark => 0.24,
            Appearance::Light => 0.10,
        };
        let shadow = BoxShadow {
            color: gpui_kit::hsla(0.0, 0.0, 0.0, shadow_alpha),
            offset: point(px(0.0), px(4.0)),
            blur_radius: px(10.0),
            spread_radius: px(-2.0),
            inset: false,
        };
        self.tooltip_show_delay(delay)
            .tooltip(move |_window, cx| -> AnyView {
                let text = text.clone();
                let shadow = shadow.clone();
                cx.new(|_| ConnTooltip {
                    text,
                    variant,
                    bg,
                    fg,
                    border,
                    shadow,
                })
                .into()
            })
    }
}

impl<E: StatefulInteractiveElement + Sized> ConnTooltipExt for E {}

/// Formats an actor's tooltip label matching Conn's `IssueActorLabel`:
/// `"Full Name (@login)"` when a distinct display name exists, otherwise `"login"` or `"ghost"`.
pub(crate) fn actor_tooltip_label(actor: Option<&IssueActor>) -> SharedString {
    match actor {
        Some(actor) => match actor
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty() && *name != actor.login)
        {
            Some(name) => format!("{name} (@{})", actor.login).into(),
            None => actor.login.clone().into(),
        },
        None => "ghost".into(),
    }
}

/// First uppercase letter of an actor's login, falling back to `"G"` (`"ghost"`), matching
/// Conn's `IssueActorAvatar`.
pub(crate) fn actor_initial(actor: Option<&IssueActor>) -> String {
    actor
        .and_then(|a| a.login.trim().chars().next())
        .map_or_else(|| "G".to_owned(), |c| c.to_uppercase().to_string())
}

/// Returns a trimmed HTTP(S) URI for an actor's remote avatar, if valid.
fn remote_avatar_uri(actor: Option<&IssueActor>) -> Option<SharedUri> {
    let raw = actor?.avatar_url.as_deref()?.trim();
    if raw.starts_with("https://") || raw.starts_with("http://") {
        Some(SharedUri::from(raw.to_owned()))
    } else {
        None
    }
}

/// Renders Conn's `IssueActorAvatar` (`pullRequestPresentation.tsx`): circular avatar
/// loaded remotely via GPUI's `img()` (`ObjectFit::Cover`, `bg-muted`) with fallback to the
/// uppercase login initial while loading, on error, or when no `avatar_url` is present.
///
/// `ring_color` draws a 2px circular review-outcome ring around the avatar (`ring-2`).
/// `grayscale` desaturates muted/collapsed timeline avatars (`grayscale`).
pub(crate) fn actor_avatar(
    tokens: &Tokens,
    actor: Option<&IssueActor>,
    size_px: f32,
    ring_color: Option<Hsla>,
    grayscale: bool,
) -> AnyElement {
    let muted_bg = to_hsla(tokens.muted);
    let muted_fg = to_hsla(tokens.muted_foreground);
    let initial: SharedString = actor_initial(actor).into();
    let font_px = (size_px * 0.58).max(9.0);

    let make_fallback = move || -> AnyElement {
        div()
            .flex()
            .flex_shrink_0()
            .size_full()
            .items_center()
            .justify_center()
            .rounded_full()
            .bg(muted_bg)
            .text_size(px(font_px))
            .font_weight(FontWeight::MEDIUM)
            .text_color(muted_fg)
            .child(initial.clone())
            .into_any_element()
    };

    let content: AnyElement = if let Some(uri) = remote_avatar_uri(actor) {
        let fallback_loading = make_fallback.clone();
        let fallback_error = make_fallback;
        img(uri)
            .size_full()
            .rounded_full()
            .object_fit(ObjectFit::Cover)
            .grayscale(grayscale)
            .with_loading(fallback_loading)
            .with_fallback(fallback_error)
            .into_any_element()
    } else {
        make_fallback()
    };

    let mut wrapper = div()
        .flex()
        .flex_shrink_0()
        .size(px(size_px))
        .items_center()
        .justify_center()
        .rounded_full()
        .overflow_hidden()
        .bg(muted_bg);
    if let Some(ring) = ring_color {
        wrapper = wrapper.border_2().border_color(ring);
    }
    wrapper.child(content).into_any_element()
}

/// `text-ui`: 13px / 20px.
pub(crate) const UI_TEXT_PX: f32 = 13.0;
pub(crate) const UI_LINE_HEIGHT_PX: f32 = 20.0;
/// `text-xs`: 12px / 16px.
pub(crate) const XS_TEXT_PX: f32 = 12.0;
pub(crate) const XS_LINE_HEIGHT_PX: f32 = 16.0;
/// `py-toolbar`, `ps-2`, `pe-toolbar-end`.
pub(crate) const TOOLBAR_PAD_Y_PX: f32 = 7.5;
pub(crate) const TOOLBAR_PAD_START_PX: f32 = 8.0;
pub(crate) const TOOLBAR_PAD_END_PX: f32 = 11.5;
/// Toolbar controls are `h-8`.
pub(crate) const CONTROL_HEIGHT_PX: f32 = 32.0;
/// `Button size="icon-xs"` (`sm:size-6`) with a `sm:size-3.5` glyph.
pub(crate) const ICON_BUTTON_PX: f32 = 24.0;
pub(crate) const ICON_BUTTON_GLYPH_PX: f32 = 14.0;
/// `ApiTabs`: `h-9`, `gap-4`, `ps-4`.
pub(crate) const SECTION_TABS_HEIGHT_PX: f32 = 36.0;
/// Row inset used by panel lists (`ps-4`, `px-4`).
pub(crate) const ROW_PAD_START_PX: f32 = 16.0;
/// Conn `StatusDotBadge` (`apps/web/src/components/StatusDotBadge.tsx`) geometry:
/// `6px` solid status dot (`size-1.5`) with a `2px` opaque cutout ring (`10px` outer disc)
/// centered right on the icon's corner (`top: -5px, right: -5px`, half-width / half-height).
pub(crate) const STATUS_DOT_INNER_PX: f32 = 6.0;
pub(crate) const STATUS_DOT_RING_PX: f32 = 2.0;
pub(crate) const STATUS_DOT_OUTER_PX: f32 = STATUS_DOT_INNER_PX + 2.0 * STATUS_DOT_RING_PX;
pub(crate) const STATUS_DOT_OFFSET_PX: f32 = -(STATUS_DOT_OUTER_PX / 2.0);
const PILL_RADIUS_PX: f32 = 9999.0;

/// Alpha-composites a translucent `overlay` over an opaque `backdrop` (`a = 1.0`).
#[must_use]
pub(crate) fn composite_over(
    overlay: conn_theme::Rgba,
    backdrop: conn_theme::Rgba,
) -> conn_theme::Rgba {
    let a = overlay.a.clamp(0.0, 1.0);
    conn_theme::Rgba::new(
        overlay.r * a + backdrop.r * (1.0 - a),
        overlay.g * a + backdrop.g * (1.0 - a),
        overlay.b * a + backdrop.b * (1.0 - a),
        1.0,
    )
}

/// Computes opaque `(rest_ring, hover_ring)` colors matching a sidebar row's composited surface
/// so the `2px` status-dot cutout blends cleanly into the row in both translucent vibrancy mode
/// (`shell_inner_fill.a < 1.0`) and opaque `reduce_transparency` mode (`shell_inner_fill.a == 1.0`).
#[must_use]
pub(crate) fn sidebar_status_dot_rings(tokens: &Tokens, selected: bool) -> (Hsla, Option<Hsla>) {
    let vibrancy_backdrop = match tokens.appearance {
        Appearance::Dark => conn_theme::Rgba::new(50.0 / 255.0, 50.0 / 255.0, 50.0 / 255.0, 1.0),
        Appearance::Light => {
            conn_theme::Rgba::new(238.0 / 255.0, 238.0 / 255.0, 238.0 / 255.0, 1.0)
        }
    };
    let sidebar_base = composite_over(tokens.shell_inner_fill, vibrancy_backdrop);
    if selected {
        (
            to_hsla(composite_over(tokens.sidebar_row_active, sidebar_base)),
            None,
        )
    } else {
        (
            to_hsla(sidebar_base),
            Some(to_hsla(composite_over(
                tokens.sidebar_row_hover,
                sidebar_base,
            ))),
        )
    }
}

/// Renders Conn's `StatusDotBadge` corner overlay as two nested circles — an opaque `10px` cutout
/// disc (`ring_color`) containing a centered `6px` status dot (`dot_color`) — so the `2px` cutout
/// ring never bleeds `dot_color` underneath a GPUI border.
#[must_use]
pub(crate) fn status_dot_cutout(
    dot_color: Hsla,
    ring_color: Hsla,
    hover_ring: Option<(SharedString, Hsla)>,
    bottom: bool,
) -> Div {
    let mut outer = div()
        .absolute()
        .right(px(STATUS_DOT_OFFSET_PX))
        .size(px(STATUS_DOT_OUTER_PX))
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .bg(ring_color)
        .child(
            div()
                .size(px(STATUS_DOT_INNER_PX))
                .rounded_full()
                .bg(dot_color),
        );
    outer = if bottom {
        outer.bottom(px(STATUS_DOT_OFFSET_PX))
    } else {
        outer.top(px(STATUS_DOT_OFFSET_PX))
    };
    if let Some((group, hover_bg)) = hover_ring {
        outer = outer.group_hover(group, move |s| s.bg(hover_bg));
    }
    outer
}

/// The surface subheader row (`data-surface-subheader`): `py-toolbar ps-2 pe-toolbar-end
/// gap-2`, with the shell divider under it.
pub(crate) fn toolbar_row(tokens: &Tokens) -> Div {
    h_flex()
        .w_full()
        .flex_shrink_0()
        .items_center()
        .gap(px(8.0))
        .py(px(TOOLBAR_PAD_Y_PX))
        .pl(px(TOOLBAR_PAD_START_PX))
        .pr(px(TOOLBAR_PAD_END_PX))
        .border_b_1()
        .border_color(to_hsla(tokens.shell_divider))
}

/// `ToolbarGroup`: a bordered pill cluster of icon buttons (`h-8 px-0.75 gap-0.5`).
pub(crate) fn toolbar_group(tokens: &Tokens) -> Div {
    h_flex()
        .flex_shrink_0()
        .h(px(CONTROL_HEIGHT_PX))
        .px(px(3.0))
        .gap(px(2.0))
        .items_center()
        .rounded(px(PILL_RADIUS_PX))
        .bg(to_hsla(tokens.shell_control))
        .border_1()
        .border_color(to_hsla(tokens.shell_divider_header))
}

/// A ghost `icon-xs` button (`[:hover]:bg-accent`). Inside a toolbar group the control radius
/// is the group's pill radius. `disabled` dims it to 64% and drops the click.
pub(crate) fn icon_button(
    id: impl Into<ElementId>,
    icon_path: &'static str,
    tokens: &Tokens,
    disabled: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let hover = to_hsla(tokens.shell_highlight);
    let color = to_hsla(tokens.muted_foreground);
    let id = id.into();
    let button = div()
        .id(id.clone())
        .a11y_button(format!("panel.{id}"), icon_action_label(icon_path))
        .flex()
        .flex_shrink_0()
        .size(px(ICON_BUTTON_PX))
        .items_center()
        .justify_center()
        .rounded(px(PILL_RADIUS_PX))
        .child(superhero_icon(icon_path, ICON_BUTTON_GLYPH_PX, color));
    if disabled {
        button.opacity(0.64)
    } else {
        button
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .on_click(on_click)
    }
}

/// AX label of an icon-only button, from its glyph (`superhero/refresh.svg` -> `Refresh`).
fn icon_action_label(icon_path: &str) -> String {
    let stem = icon_path
        .rsplit('/')
        .next()
        .unwrap_or(icon_path)
        .trim_end_matches(".svg")
        .replace(['-', '_'], " ");
    let mut chars = stem.chars();
    chars
        .next()
        .map(|c| c.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

/// A ghost `xs` text button (`h-6 gap-1 px-[7px] text-xs`, `size-3.5` glyph), such as
/// "Add header".
pub(crate) fn text_button(
    id: impl Into<ElementId>,
    icon_path: Option<&'static str>,
    label: impl Into<SharedString>,
    tokens: &Tokens,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let hover = to_hsla(tokens.shell_highlight);
    let fg = to_hsla(tokens.foreground);
    let id = id.into();
    let label = label.into();
    let mut button = h_flex()
        .id(id.clone())
        .a11y_button(format!("panel.{id}"), label.clone())
        .flex_shrink_0()
        .h(px(24.0))
        .px(px(7.0))
        .gap(px(4.0))
        .items_center()
        .rounded(px(6.0))
        .cursor_pointer()
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX))
        .text_color(fg)
        .hover(move |s| s.bg(hover))
        .on_click(on_click);
    if let Some(path) = icon_path {
        button = button.child(superhero_icon(
            path,
            ICON_BUTTON_GLYPH_PX,
            to_hsla(tokens.muted_foreground),
        ));
    }
    button.child(label)
}

/// The soft input group (`InputGroup variant="soft"`): `h-8`, pill radius, `--shell-field`
/// fill, `--shell-divider-header` border, `--shell-control` on hover.
pub(crate) fn soft_input_group(tokens: &Tokens) -> Div {
    let hover = to_hsla(tokens.shell_control);
    h_flex()
        .flex_1()
        .min_w_0()
        .h(px(CONTROL_HEIGHT_PX))
        .items_center()
        .rounded(px(PILL_RADIUS_PX))
        .bg(to_hsla(tokens.shell_field))
        .border_1()
        .border_color(to_hsla(tokens.shell_divider_header))
        .text_size(px(UI_TEXT_PX))
        .hover(move |s| s.bg(hover))
}

/// One underlined section tab (`ApiTabs` button) with an optional muted count.
#[derive(Clone, Debug)]
pub(crate) struct SectionTab {
    pub(crate) id: &'static str,
    pub(crate) label: &'static str,
    pub(crate) count: Option<usize>,
}

/// `ApiTabs`: underlined section tabs, `h-9 gap-4 ps-4 pe-toolbar-end`, divider below, the
/// active tab marked with a 2px primary bar on the divider. `trailing` sits at the far end.
pub(crate) fn section_tabs(
    id: impl Into<SharedString>,
    tokens: &Tokens,
    tabs: &[SectionTab],
    active: &str,
    trailing: Option<AnyElement>,
    on_select: impl Fn(&'static str, &mut Window, &mut App) + Clone + 'static,
) -> Div {
    let id: SharedString = id.into();
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let primary = to_hsla(tokens.primary);
    let mut row = h_flex()
        .w_full()
        .flex_shrink_0()
        .h(px(SECTION_TABS_HEIGHT_PX))
        .items_stretch()
        .gap(px(16.0))
        .pl(px(ROW_PAD_START_PX))
        .pr(px(TOOLBAR_PAD_END_PX))
        .border_b_1()
        .border_color(to_hsla(tokens.shell_divider));
    for tab in tabs {
        let is_active = tab.id == active;
        let on_select = on_select.clone();
        let tab_id = tab.id;
        let mut button = h_flex()
            .id(SharedString::from(format!("{id}-{tab_id}")))
            .a11y_tab(format!("panel.{id}.{tab_id}"), tab.label, is_active)
            .relative()
            .items_center()
            .gap(px(6.0))
            .cursor_pointer()
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(if is_active { fg } else { muted })
            .when(!is_active, |el| el.hover(move |s| s.text_color(fg)))
            .on_click(move |_, window, cx| on_select(tab_id, window, cx))
            .child(tab.label);
        if let Some(count) = tab.count.filter(|count| *count > 0) {
            button = button.child(div().text_color(muted).child(count.to_string()));
        }
        if is_active {
            button = button.child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom(px(-1.0))
                    .h(px(2.0))
                    .rounded(px(PILL_RADIUS_PX))
                    .bg(primary),
            );
        }
        row = row.child(button);
    }
    if let Some(trailing) = trailing {
        row = row.child(
            h_flex()
                .ml_auto()
                .min_w_0()
                .items_center()
                .gap(px(8.0))
                .child(trailing),
        );
    }
    row
}

/// Conn's checkbox (`size-4`, 4px radius, `border-input`; checked: primary fill with a
/// `size-3` check).
pub(crate) fn checkbox(
    id: impl Into<ElementId>,
    checked: bool,
    tokens: &Tokens,
    on_toggle: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let base = div()
        .id(id)
        .flex()
        .flex_shrink_0()
        .size(px(16.0))
        .items_center()
        .justify_center()
        .rounded(px(4.0))
        .cursor_pointer()
        .on_click(on_toggle);
    if checked {
        base.bg(to_hsla(tokens.primary)).child(superhero_icon(
            "superhero/check.svg",
            12.0,
            to_hsla(tokens.primary_foreground),
        ))
    } else {
        let fill = match tokens.appearance {
            Appearance::Dark => to_hsla(tokens.input.with_alpha(0.32)),
            Appearance::Light => to_hsla(tokens.background),
        };
        base.bg(fill).border_1().border_color(to_hsla(tokens.input))
    }
}

/// A warning notice (`m-1 rounded-lg bg-warning/10 px-3 py-2 text-ui text-warning`, alert
/// glyph).
pub(crate) fn warning_notice(tokens: &Tokens, text: impl Into<SharedString>) -> Div {
    let warning = to_hsla(tokens.warning);
    h_flex()
        .m(px(4.0))
        .items_center()
        .gap(px(8.0))
        .rounded(px(8.0))
        .bg(to_hsla(tokens.warning.with_alpha(0.10)))
        .px(px(12.0))
        .py(px(8.0))
        .text_size(px(UI_TEXT_PX))
        .line_height(px(UI_LINE_HEIGHT_PX))
        .text_color(warning)
        .child(superhero_icon("superhero/error-circle.svg", 16.0, warning))
        .child(div().min_w_0().child(text.into()))
}

/// One row of a `dropdown-glass` menu.
pub(crate) struct MenuRow {
    pub(crate) id: SharedString,
    pub(crate) label: SharedString,
    pub(crate) mono: bool,
    /// Radio items mark the checked row with `bg-foreground/[0.08]`.
    pub(crate) checked: bool,
    pub(crate) on_select: Box<dyn Fn(&mut Window, &mut App)>,
}

/// A row list entry: a menu row or a `MenuSeparator`.
pub(crate) enum MenuEntry {
    Row(MenuRow),
    Separator,
}

/// A `dropdown-glass` menu popup anchored `sideOffset={6}` under a 32px trigger at the left
/// edge (`align="start"`), drawn above everything else.
pub(crate) fn dropdown_menu(
    id: impl Into<ElementId>,
    tokens: &Tokens,
    entries: Vec<MenuEntry>,
    mono_font: SharedString,
    top_px: f32,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let highlight = to_hsla(tokens.shell_highlight);
    let checked_bg = to_hsla(tokens.foreground.with_alpha(0.08));
    let divider = to_hsla(tokens.foreground.with_alpha(0.08));
    let (offset_y, blur, alpha) = match tokens.appearance {
        Appearance::Dark => (18.0, 44.0, 0.80),
        Appearance::Light => (16.0, 40.0, 0.55),
    };
    let shadow = BoxShadow {
        color: gpui_kit::hsla(0.0, 0.0, 0.0, alpha),
        offset: point(px(0.0), px(offset_y)),
        blur_radius: px(blur),
        spread_radius: px(-18.0),
        inset: false,
    };
    let id = id.into();
    let mut list = div()
        .id(id.clone())
        .a11y(Role::Menu, format!("panel.menu.{id}"), "Menu")
        .flex()
        .flex_col()
        .min_w(px(160.0))
        .max_w(px(320.0))
        .p(px(4.0))
        .rounded(px(12.0))
        .bg(to_hsla(tokens.popover))
        .border_1()
        .border_color(divider)
        .shadow(vec![shadow])
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());
    for entry in entries {
        match entry {
            MenuEntry::Separator => {
                list = list.child(div().mx(px(8.0)).my(px(4.0)).h(px(1.0)).bg(divider));
            }
            MenuEntry::Row(row) => {
                let on_select = row.on_select;
                let ax_id = format!("panel.menu.item.{}", row.id);
                let ax_label = row.label.clone();
                let mut label = div().min_w_0().flex_1().truncate().child(row.label);
                if row.mono {
                    label = label.font_family(mono_font.clone());
                }
                list = list.child(
                    h_flex()
                        .id(row.id)
                        .a11y(Role::MenuItem, ax_id, ax_label)
                        .w_full()
                        .min_h(px(28.0))
                        .px(px(8.0))
                        .py(px(4.0))
                        .gap(px(8.0))
                        .items_center()
                        .rounded(px(8.0))
                        .cursor_pointer()
                        .text_size(px(14.0))
                        .line_height(px(20.0))
                        .text_color(fg)
                        .when(row.checked, |el| el.bg(checked_bg))
                        .hover(move |s| s.bg(highlight))
                        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                            cx.stop_propagation();
                            on_select(window, cx);
                        })
                        .child(label),
                );
            }
        }
    }
    deferred(
        div()
            .absolute()
            .top(px(top_px + 6.0))
            .left(px(0.0))
            .child(list),
    )
    .with_priority(2)
    .into_any_element()
}

/// Bold-weight helper kept next to the menu code for `MenuShortcut`-style labels.
#[expect(dead_code, reason = "used by surfaces ported next (Database, MCP)")]
pub(crate) fn medium(text: impl Into<SharedString>) -> Div {
    div().font_weight(FontWeight::MEDIUM).child(text.into())
}

/// Muted centered placeholder text, as panels show before there is content.
pub(crate) fn empty_state(tokens: &Tokens, text: impl Into<SharedString>) -> Div {
    h_flex()
        .flex_1()
        .min_h_0()
        .w_full()
        .items_center()
        .justify_center()
        .gap(px(8.0))
        .px(px(ROW_PAD_START_PX))
        .text_size(px(UI_TEXT_PX))
        .line_height(px(UI_LINE_HEIGHT_PX))
        .text_color(to_hsla(tokens.muted_foreground))
        .child(text.into())
}

/// `Hsla` of a token with an alpha, for hover fills such as `hover:bg-foreground/4`.
pub(crate) fn alpha(color: conn_theme::Rgba, a: f32) -> Hsla {
    to_hsla(color.with_alpha(a))
}

/// Paint order of full-window modals (Settings, the command palette). Popovers, menus and cards
/// use deferred priorities 1 to 7; a modal must draw above all of them (Nick, #321).
pub(crate) const MODAL_LAYER_PRIORITY: usize = 9;

#[cfg(test)]
mod tests {
    use conn_contract::IssueActor;

    use super::{actor_initial, actor_tooltip_label, remote_avatar_uri};

    fn sample_actor(login: &str, name: Option<&str>, avatar_url: Option<&str>) -> IssueActor {
        IssueActor {
            is_bot: None,
            login: login.to_owned(),
            name: name.map(ToOwned::to_owned),
            avatar_url: avatar_url.map(ToOwned::to_owned),
        }
    }

    #[test]
    fn actor_helpers_handle_initials_labels_and_remote_uris() {
        assert_eq!(
            actor_initial(None),
            "G",
            "missing actor falls back to ghost"
        );
        let empty_login = sample_actor("   ", None, None);
        assert_eq!(
            actor_initial(Some(&empty_login)),
            "G",
            "blank login falls back to G"
        );

        let named = sample_actor(
            "nckrtl",
            Some("Nick"),
            Some("https://avatars.githubusercontent.com/u/1?v=4"),
        );
        assert_eq!(actor_initial(Some(&named)), "N", "uppercase initial");
        assert_eq!(
            actor_tooltip_label(Some(&named)).as_ref(),
            "Nick (@nckrtl)",
            "tooltip includes full name and login"
        );
        assert!(
            remote_avatar_uri(Some(&named)).is_some(),
            "https avatar URI should be accepted"
        );

        let same_name = sample_actor("octocat", Some("octocat"), Some("javascript:alert(1)"));
        assert_eq!(
            actor_tooltip_label(Some(&same_name)).as_ref(),
            "octocat",
            "duplicate display name is not repeated"
        );
        assert!(
            remote_avatar_uri(Some(&same_name)).is_none(),
            "non-http(s) avatar URLs must be rejected"
        );
    }

    #[test]
    fn sidebar_status_dot_rings_are_opaque_and_distinct_per_row_state() {
        for theme in conn_theme::builtin_themes() {
            let theme_id = &theme.id;
            let tokens = conn_theme::Tokens::derive(&theme);
            let (rest, hover) = super::sidebar_status_dot_rings(&tokens, false);
            let hover = hover.expect("unselected sidebar row should define a hover ring");
            let (selected, selected_hover) = super::sidebar_status_dot_rings(&tokens, true);
            assert!(
                selected_hover.is_none(),
                "selected sidebar row keeps active ring on hover"
            );
            assert!(
                (rest.a - 1.0).abs() < 1e-4
                    && (hover.a - 1.0).abs() < 1e-4
                    && (selected.a - 1.0).abs() < 1e-4,
                "cutout rings must be 100% opaque to punch cleanly through the icon ({theme_id})"
            );
            assert_ne!(
                rest, selected,
                "selected row ring must match active row fill ({theme_id})"
            );
            assert_ne!(
                rest, hover,
                "hovered row ring must match hover row fill ({theme_id})"
            );
        }
    }
}
