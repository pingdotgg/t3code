//! Shared Conn-exact UI primitives for the Device surface.
//!
//! All colors come strictly from [`conn_theme::Tokens`] and every icon uses
//! `superhero/*.svg` through [`super::super::header::superhero_icon`].

use conn_contract::{DeviceHostStatus, DevicePlatformAvailability, DeviceToolVersions};
use conn_theme::{Appearance, Tokens};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, BoxShadow, ClickEvent, Div, ElementId, Entity, FontWeight, Hsla,
    InteractiveElement, IntoElement, MouseButton, ParentElement, SharedString, Stateful, Styled,
    Window, deferred, div, point, px,
};

use super::super::chrome::{
    self, ConnTooltipExt as _, MenuEntry, UI_LINE_HEIGHT_PX, UI_TEXT_PX, XS_LINE_HEIGHT_PX,
    XS_TEXT_PX,
};
use super::super::color::to_hsla;
use super::super::header::{CONTROL_RADIUS_PX, superhero_icon};
use super::logic::{
    HostDiagnostic, HostView, active_tool_version, discovery_warning_text, platform_name,
};
use crate::a11y::ConnA11yExt as _;
use crate::theme::MONO_FONT;

/// The AX id of a Device control from its element id: `panel.device.<slug>`.
fn ax_id_for(id: &ElementId) -> SharedString {
    let raw = match id {
        ElementId::Name(name) => name.to_string(),
        other => format!("{other:?}"),
    };
    let mut slug = String::with_capacity(raw.len());
    for c in raw.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    SharedString::from(format!("panel.device.{}", slug.trim_matches('-')))
}

/// A label for a control that shows only a glyph: the glyph's name (`superhero/close.svg` ->
/// `Close`).
fn icon_label(icon_path: &str) -> SharedString {
    let stem = icon_path
        .rsplit('/')
        .next()
        .unwrap_or(icon_path)
        .trim_end_matches(".svg")
        .replace('-', " ");
    let mut chars = stem.chars();
    let label = match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
        None => "Button".to_owned(),
    };
    SharedString::from(label)
}

/// `Button size="sm"` (`sm:h-7` = 28px, `text-sm` = 14/20, `gap-1.5` = 6px, `px-[9px]`).
pub(super) const SM_BUTTON_HEIGHT_PX: f32 = 28.0;
pub(super) const SM_TEXT_PX: f32 = 14.0;
pub(super) const SM_LINE_HEIGHT_PX: f32 = 20.0;
/// `Button size="xs"` (`sm:h-6` = 24px, `text-xs` = 12/16).
pub(super) const XS_BUTTON_HEIGHT_PX: f32 = 24.0;
/// `Button size="micro"` (`h-5` = 20px, `text-[11px]`).
pub(super) const MICRO_BUTTON_HEIGHT_PX: f32 = 20.0;
pub(super) const MICRO_TEXT_PX: f32 = 11.0;
/// `Button size="icon-sm"` (`sm:size-7` = 28px).
pub(super) const ICON_SM_PX: f32 = 28.0;
pub(super) const PILL_RADIUS_PX: f32 = 9999.0;

/// Conn `Button variant="outline" size="sm"`.
pub(super) fn outline_sm_button(
    id: impl Into<ElementId>,
    icon_path: Option<&'static str>,
    label: impl Into<SharedString>,
    tokens: &Tokens,
    disabled: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let id: ElementId = id.into();
    let label: SharedString = label.into();
    let ax_id = ax_id_for(&id);
    let (bg, hover_bg) = outline_fills(tokens);
    let shadow = outline_shadow(tokens);
    let mut button = h_flex()
        .id(id)
        .a11y_button(ax_id, label.clone())
        .flex_shrink_0()
        .h(px(SM_BUTTON_HEIGHT_PX))
        .px(px(9.0))
        .gap(px(6.0))
        .items_center()
        .justify_center()
        .rounded(px(CONTROL_RADIUS_PX))
        .bg(bg)
        .border_1()
        .border_color(to_hsla(tokens.input))
        .text_size(px(SM_TEXT_PX))
        .line_height(px(SM_LINE_HEIGHT_PX))
        .font_weight(FontWeight::MEDIUM)
        .text_color(to_hsla(tokens.foreground));

    if let Some(shadow) = shadow
        && !disabled
    {
        button = button.shadow(vec![shadow]);
    }
    if let Some(path) = icon_path {
        button = button.child(superhero_icon(path, 16.0, to_hsla(tokens.muted_foreground)));
    }
    button = button.child(label);

    if disabled {
        button.opacity(0.64)
    } else {
        button
            .cursor_pointer()
            .hover(move |s| s.bg(hover_bg))
            .on_click(on_click)
    }
}

/// Conn `Button variant="default" size="sm"` (primary CTA: Continue, Done, Save host).
pub(super) fn primary_sm_button(
    id: impl Into<ElementId>,
    icon_path: Option<&'static str>,
    label: impl Into<SharedString>,
    tokens: &Tokens,
    disabled: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let id: ElementId = id.into();
    let label: SharedString = label.into();
    let ax_id = ax_id_for(&id);
    let bg = to_hsla(tokens.primary);
    let hover = chrome::alpha(tokens.primary, 0.90);
    let fg = to_hsla(tokens.primary_foreground);
    let mut button = h_flex()
        .id(id)
        .a11y_button(ax_id, label.clone())
        .flex_shrink_0()
        .h(px(SM_BUTTON_HEIGHT_PX))
        .px(px(11.0))
        .gap(px(6.0))
        .items_center()
        .justify_center()
        .rounded(px(CONTROL_RADIUS_PX))
        .bg(bg)
        .border_1()
        .border_color(bg)
        .text_size(px(SM_TEXT_PX))
        .line_height(px(SM_LINE_HEIGHT_PX))
        .font_weight(FontWeight::MEDIUM)
        .text_color(fg);
    if let Some(path) = icon_path {
        button = button.child(superhero_icon(path, 14.0, fg));
    }
    button = button.child(label);
    if disabled {
        button.opacity(0.64)
    } else {
        button
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .on_click(on_click)
    }
}

/// Conn `Button variant="ghost" size="sm"`.
pub(super) fn ghost_sm_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    tokens: &Tokens,
    disabled: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let id: ElementId = id.into();
    let label: SharedString = label.into();
    let ax_id = ax_id_for(&id);
    let hover = to_hsla(tokens.shell_highlight);
    let button = h_flex()
        .id(id)
        .a11y_button(ax_id, label.clone())
        .flex_shrink_0()
        .h(px(SM_BUTTON_HEIGHT_PX))
        .px(px(9.0))
        .gap(px(6.0))
        .items_center()
        .justify_center()
        .rounded(px(CONTROL_RADIUS_PX))
        .text_size(px(SM_TEXT_PX))
        .line_height(px(SM_LINE_HEIGHT_PX))
        .font_weight(FontWeight::MEDIUM)
        .text_color(to_hsla(tokens.foreground))
        .child(label);
    if disabled {
        button.opacity(0.64)
    } else {
        button
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .on_click(on_click)
    }
}

/// Conn `Button variant="outline" size="xs"` (`h-6 px-[7px] text-xs`).
pub(super) fn outline_xs_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    tokens: &Tokens,
    disabled: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let id: ElementId = id.into();
    let label: SharedString = label.into();
    let ax_id = ax_id_for(&id);
    let (bg, hover_bg) = outline_fills(tokens);
    let button = h_flex()
        .id(id)
        .a11y_button(ax_id, label.clone())
        .flex_shrink_0()
        .h(px(XS_BUTTON_HEIGHT_PX))
        .px(px(7.0))
        .gap(px(4.0))
        .items_center()
        .justify_center()
        .rounded(px(CONTROL_RADIUS_PX))
        .bg(bg)
        .border_1()
        .border_color(to_hsla(tokens.input))
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX))
        .font_weight(FontWeight::MEDIUM)
        .text_color(to_hsla(tokens.foreground))
        .child(label);
    if disabled {
        button.opacity(0.64)
    } else {
        button
            .cursor_pointer()
            .hover(move |s| s.bg(hover_bg))
            .on_click(on_click)
    }
}

/// Conn `Button variant="ghost" size="xs"`.
pub(super) fn ghost_xs_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    tokens: &Tokens,
    disabled: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let id: ElementId = id.into();
    let label: SharedString = label.into();
    let ax_id = ax_id_for(&id);
    let hover = to_hsla(tokens.shell_highlight);
    let button = h_flex()
        .id(id)
        .a11y_button(ax_id, label.clone())
        .flex_shrink_0()
        .h(px(XS_BUTTON_HEIGHT_PX))
        .px(px(7.0))
        .gap(px(4.0))
        .items_center()
        .justify_center()
        .rounded(px(CONTROL_RADIUS_PX))
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX))
        .font_weight(FontWeight::MEDIUM)
        .text_color(to_hsla(tokens.foreground))
        .child(label);
    if disabled {
        button.opacity(0.64)
    } else {
        button
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .on_click(on_click)
    }
}

/// Conn `Button variant="outline" size="compact"` (`h-7 px-[7px] text-xs rounded-md`).
pub(super) fn compact_outline_button(
    id: impl Into<ElementId>,
    icon_path: Option<&'static str>,
    label: impl Into<SharedString>,
    tokens: &Tokens,
    disabled: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let id: ElementId = id.into();
    let label: SharedString = label.into();
    let ax_id = ax_id_for(&id);
    let (bg, hover_bg) = outline_fills(tokens);
    let mut button = h_flex()
        .id(id)
        .a11y_button(ax_id, label.clone())
        .flex_shrink_0()
        .h(px(SM_BUTTON_HEIGHT_PX))
        .px(px(7.0))
        .gap(px(4.0))
        .items_center()
        .justify_center()
        .rounded(px(CONTROL_RADIUS_PX))
        .bg(bg)
        .border_1()
        .border_color(to_hsla(tokens.input))
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX))
        .font_weight(FontWeight::MEDIUM)
        .text_color(to_hsla(tokens.foreground));
    if let Some(path) = icon_path {
        button = button.child(superhero_icon(path, 14.0, to_hsla(tokens.muted_foreground)));
    }
    button = button.child(label);
    if disabled {
        button.opacity(0.64)
    } else {
        button
            .cursor_pointer()
            .hover(move |s| s.bg(hover_bg))
            .on_click(on_click)
    }
}

/// Conn `Button variant="ghost" size="micro"` (`h-5 px-1.5 text-[11px] rounded-sm`).
pub(super) fn micro_ghost_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    tokens: &Tokens,
    disabled: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let id: ElementId = id.into();
    let label: SharedString = label.into();
    let ax_id = ax_id_for(&id);
    let hover = to_hsla(tokens.shell_highlight);
    let button = h_flex()
        .id(id)
        .a11y_button(ax_id, label.clone())
        .flex_shrink_0()
        .h(px(MICRO_BUTTON_HEIGHT_PX))
        .px(px(5.0))
        .gap(px(4.0))
        .items_center()
        .justify_center()
        .rounded(px(4.0))
        .text_size(px(MICRO_TEXT_PX))
        .line_height(px(14.0))
        .font_weight(FontWeight::MEDIUM)
        .text_color(to_hsla(tokens.foreground))
        .child(label);
    if disabled {
        button.opacity(0.64)
    } else {
        button
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .on_click(on_click)
    }
}

/// Conn `Button variant="ghost" size="icon-micro"` (`size-5 rounded-sm`, 12px icon).
pub(super) fn micro_icon_button(
    id: impl Into<ElementId>,
    icon_path: &'static str,
    tokens: &Tokens,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let id: ElementId = id.into();
    let ax_id = ax_id_for(&id);
    let hover = to_hsla(tokens.shell_highlight);
    div()
        .id(id)
        .a11y_button(ax_id, icon_label(icon_path))
        .flex()
        .flex_shrink_0()
        .size(px(MICRO_BUTTON_HEIGHT_PX))
        .items_center()
        .justify_center()
        .rounded(px(4.0))
        .cursor_pointer()
        .hover(move |s| s.bg(hover))
        .on_click(on_click)
        .child(superhero_icon(
            icon_path,
            12.0,
            to_hsla(tokens.muted_foreground),
        ))
}

/// Conn's pill [`Switch`](../../../components/ui/switch.tsx): `--switch-radius: 9999px`,
/// checked track `--switch-on`, unchecked `--input`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SwitchSize {
    Default,
    Small,
}

pub(super) fn conn_switch(
    id: impl Into<ElementId>,
    checked: bool,
    disabled: bool,
    size: SwitchSize,
    tokens: &Tokens,
    on_toggle: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let id: ElementId = id.into();
    let ax_id = ax_id_for(&id);
    let switch_label = ax_id
        .rsplit('.')
        .next()
        .unwrap_or("Toggle")
        .replace('-', " ");
    let (track_w, track_h, thumb_px) = match size {
        SwitchSize::Default => (30.0, 18.0, 14.0),
        SwitchSize::Small => (26.0, 16.0, 12.0),
    };
    let track_bg = if checked {
        to_hsla(tokens.switch_on)
    } else {
        to_hsla(tokens.input)
    };
    let thumb_bg = if !checked && tokens.appearance == Appearance::Dark {
        to_hsla(tokens.muted_foreground)
    } else {
        to_hsla(tokens.background)
    };
    let track = h_flex()
        .id(id)
        .a11y_switch(ax_id, switch_label, checked)
        .flex_shrink_0()
        .w(px(track_w))
        .h(px(track_h))
        .p(px(2.0))
        .items_center()
        .when(checked, Styled::justify_end)
        .when(!checked, Styled::justify_start)
        .rounded(px(PILL_RADIUS_PX))
        .bg(track_bg)
        .child(
            div()
                .size(px(thumb_px))
                .rounded(px(PILL_RADIUS_PX))
                .bg(thumb_bg),
        );
    if disabled {
        track.opacity(0.64)
    } else {
        track.cursor_pointer().on_click(on_toggle)
    }
}

/// Compact bordered input (`Input size="compact"` in `DeviceToolsPanel.tsx` and host editors).
pub(super) fn compact_input(
    state: &Entity<InputState>,
    mono: bool,
    tokens: &Tokens,
    disabled: bool,
) -> Div {
    let mut box_el = h_flex()
        .flex_1()
        .min_w_0()
        .h(px(SM_BUTTON_HEIGHT_PX))
        .items_center()
        .rounded(px(CONTROL_RADIUS_PX))
        .bg(to_hsla(tokens.shell_field))
        .border_1()
        .border_color(to_hsla(tokens.input))
        .px(px(8.0))
        .text_size(px(XS_TEXT_PX))
        .text_color(to_hsla(tokens.foreground));
    if mono {
        box_el = box_el.font_family(SharedString::from(MONO_FONT));
    }
    if disabled {
        box_el = box_el.opacity(0.64);
    }
    box_el.child(
        div().flex_1().min_w_0().child(
            Input::new(state)
                .appearance(false)
                .text_size(px(XS_TEXT_PX)),
        ),
    )
}

/// Compact select trigger (`SelectTrigger size="xs"` in `DeviceToolsPanel.tsx`).
pub(super) fn select_trigger_xs(
    id: impl Into<ElementId>,
    label: SharedString,
    placeholder: bool,
    width_px: f32,
    tokens: &Tokens,
    disabled: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let id: ElementId = id.into();
    let ax_id = ax_id_for(&id);
    let (bg, hover_bg) = outline_fills(tokens);
    let text_color = if placeholder {
        to_hsla(tokens.muted_foreground)
    } else {
        to_hsla(tokens.foreground)
    };
    let trigger = h_flex()
        .id(id)
        .a11y_button(ax_id, label.clone())
        .w(px(width_px))
        .flex_shrink_0()
        .h(px(XS_BUTTON_HEIGHT_PX))
        .px(px(8.0))
        .gap(px(6.0))
        .items_center()
        .justify_between()
        .rounded(px(CONTROL_RADIUS_PX))
        .bg(bg)
        .border_1()
        .border_color(to_hsla(tokens.input))
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX))
        .text_color(text_color)
        .child(div().min_w_0().flex_1().truncate().child(label))
        .child(superhero_icon(
            "superhero/chevron-down.svg",
            12.0,
            to_hsla(tokens.muted_foreground),
        ));
    if disabled {
        trigger.opacity(0.64)
    } else {
        trigger
            .cursor_pointer()
            .hover(move |s| s.bg(hover_bg))
            .on_click(on_click)
    }
}

/// Floating `dropdown-glass` menu anchored to the left of a trigger (for `DeviceControlsRail`,
/// `side="left"`) or aligned to the right edge under a trigger (`align="end"`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum MenuAnchor {
    /// Opens to the left of the rail button (`right: 36px`, `top: 0`).
    LeftOfRail,
    /// Opens below the trigger, aligned to its right edge (`top: trigger_h + 6px`, `right: 0`).
    BelowEnd(f32),
    /// Opens below the trigger, aligned to its left edge (`top: trigger_h + 6px`, `left: 0`).
    BelowStart(f32),
}

/// Row with optional leading icon and destructive tone for Device rail / host menus.
pub(super) struct DeviceMenuRow {
    pub(super) id: SharedString,
    pub(super) label: SharedString,
    pub(super) icon: Option<&'static str>,
    pub(super) checked: bool,
    pub(super) destructive: bool,
    pub(super) on_select: Box<dyn Fn(&mut Window, &mut App)>,
}

pub(super) enum DeviceMenuEntry {
    Row(DeviceMenuRow),
    Separator,
}

pub(super) fn device_dropdown_menu(
    id: impl Into<ElementId>,
    tokens: &Tokens,
    entries: Vec<DeviceMenuEntry>,
    anchor: MenuAnchor,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let destructive_fg = to_hsla(tokens.destructive);
    let highlight = to_hsla(tokens.shell_highlight);
    let checked_bg = chrome::alpha(tokens.foreground, 0.08);
    let divider = chrome::alpha(tokens.foreground, 0.08);
    let shadow = dropdown_shadow(tokens);

    let mut list = div()
        .id(id)
        .flex()
        .flex_col()
        .min_w(px(164.0))
        .max_w(px(260.0))
        .p(px(4.0))
        .rounded(px(12.0))
        .bg(to_hsla(tokens.popover))
        .border_1()
        .border_color(divider)
        .shadow(vec![shadow])
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());

    for entry in entries {
        match entry {
            DeviceMenuEntry::Separator => {
                list = list.child(div().mx(px(8.0)).my(px(4.0)).h(px(1.0)).bg(divider));
            }
            DeviceMenuEntry::Row(row) => {
                let on_select = row.on_select;
                let text_color = if row.destructive { destructive_fg } else { fg };
                let icon_color = if row.destructive {
                    destructive_fg
                } else {
                    muted
                };
                let mut item = h_flex()
                    .id(row.id)
                    .w_full()
                    .min_h(px(28.0))
                    .px(px(8.0))
                    .py(px(4.0))
                    .gap(px(8.0))
                    .items_center()
                    .rounded(px(8.0))
                    .cursor_pointer()
                    .text_size(px(SM_TEXT_PX))
                    .line_height(px(SM_LINE_HEIGHT_PX))
                    .text_color(text_color)
                    .when(row.checked, |el| el.bg(checked_bg))
                    .hover(move |s| s.bg(highlight))
                    .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                        cx.stop_propagation();
                        on_select(window, cx);
                    });
                if let Some(icon) = row.icon {
                    item = item.child(superhero_icon(icon, 14.0, icon_color));
                }
                item = item.child(div().min_w_0().flex_1().truncate().child(row.label));
                if row.checked {
                    item = item.child(superhero_icon("superhero/check.svg", 12.0, fg));
                }
                list = list.child(item);
            }
        }
    }

    let positioned = match anchor {
        MenuAnchor::LeftOfRail => div().absolute().top(px(0.0)).right(px(36.0)).child(list),
        MenuAnchor::BelowEnd(h) => div().absolute().top(px(h + 6.0)).right(px(0.0)).child(list),
        MenuAnchor::BelowStart(h) => div().absolute().top(px(h + 6.0)).left(px(0.0)).child(list),
    };
    deferred(positioned).with_priority(3).into_any_element()
}

/// Simple select dropdown delegating to [`chrome::dropdown_menu`] or [`device_dropdown_menu`].
pub(super) fn simple_select_menu(
    id: impl Into<ElementId>,
    tokens: &Tokens,
    entries: Vec<MenuEntry>,
    anchor: MenuAnchor,
) -> AnyElement {
    let converted = entries
        .into_iter()
        .map(|entry| match entry {
            MenuEntry::Separator => DeviceMenuEntry::Separator,
            MenuEntry::Row(row) => DeviceMenuEntry::Row(DeviceMenuRow {
                id: row.id,
                label: row.label,
                icon: None,
                checked: row.checked,
                destructive: false,
                on_select: row.on_select,
            }),
        })
        .collect();
    device_dropdown_menu(id, tokens, converted, anchor)
}

/// `RailButton` (`DeviceControlsRail.tsx`: `size="icon-sm"` = 28px, ghost or secondary when pressed).
pub(super) fn rail_icon_button(
    id: impl Into<ElementId>,
    icon_path: &'static str,
    tokens: &Tokens,
    pressed: bool,
    disabled: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let id: ElementId = id.into();
    let ax_id = ax_id_for(&id);
    let hover = to_hsla(tokens.shell_highlight);
    let pressed_bg = to_hsla(tokens.secondary);
    let glyph_color = if pressed {
        to_hsla(tokens.foreground)
    } else {
        to_hsla(tokens.muted_foreground)
    };
    let button = div()
        .id(id)
        .a11y_button(ax_id, icon_label(icon_path))
        .flex()
        .flex_shrink_0()
        .size(px(ICON_SM_PX))
        .items_center()
        .justify_center()
        .rounded(px(CONTROL_RADIUS_PX))
        .when(pressed, |el| el.bg(pressed_bg))
        .child(superhero_icon(icon_path, 16.0, glyph_color));
    if disabled {
        button.opacity(0.45)
    } else {
        button
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .on_click(on_click)
    }
}

/// `DeviceNotice` (`DevicePanel.tsx`: destructive error bar with dismiss `X`).
pub(super) fn device_notice(
    tokens: &Tokens,
    message: impl Into<SharedString>,
    on_dismiss: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Div {
    let destructive = to_hsla(tokens.destructive);
    h_flex()
        .w_full()
        .items_start()
        .gap(px(8.0))
        .border_b_1()
        .border_color(to_hsla(tokens.shell_divider))
        .bg(chrome::alpha(tokens.destructive, 0.05))
        .px(px(12.0))
        .py(px(8.0))
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX))
        .text_color(destructive)
        .child(div().mt(px(1.0)).child(superhero_icon(
            "superhero/error-circle.svg",
            14.0,
            destructive,
        )))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .max_h(px(128.0))
                .child(message.into()),
        )
        .child(
            chrome::icon_button(
                "device-notice-dismiss",
                "superhero/close.svg",
                tokens,
                false,
                on_dismiss,
            )
            .conn_tooltip("Dismiss", tokens),
        )
}

/// `DeviceDiscoveryWarning` (`DevicePanel.tsx`): inline status bar with Retry, Details popover, Dismiss.
pub(super) fn device_discovery_warning(
    tokens: &Tokens,
    diagnostic: &HostDiagnostic,
    retrying: bool,
    details_open: bool,
    on_retry: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    on_toggle_details: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    on_dismiss: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Div {
    let muted = to_hsla(tokens.muted_foreground);
    let warning = to_hsla(tokens.warning_foreground);
    let divider = to_hsla(tokens.shell_divider);
    let text = discovery_warning_text(&diagnostic.label, &diagnostic.incomplete_platforms);
    let host_id = &diagnostic.host_id;

    let mut details_anchor = div().relative().child(micro_ghost_button(
        SharedString::from(format!("device-warn-details-{host_id}")),
        "Details",
        tokens,
        false,
        on_toggle_details,
    ));
    if details_open {
        let shadow = dropdown_shadow(tokens);
        details_anchor = details_anchor.child(
            deferred(
                div()
                    .absolute()
                    .top(px(MICRO_BUTTON_HEIGHT_PX + 6.0))
                    .right(px(0.0))
                    .w(px(280.0))
                    .p(px(10.0))
                    .rounded(px(12.0))
                    .bg(to_hsla(tokens.popover))
                    .border_1()
                    .border_color(chrome::alpha(tokens.foreground, 0.08))
                    .shadow(vec![shadow])
                    .font_family(SharedString::from(MONO_FONT))
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(diagnostic.detail.clone()),
            )
            .with_priority(3),
        );
    }

    let mut actions = h_flex()
        .ml_auto()
        .flex_shrink_0()
        .items_center()
        .gap(px(2.0));
    if !diagnostic.incomplete_platforms.is_empty() {
        actions = actions.child(micro_ghost_button(
            SharedString::from(format!("device-warn-retry-{host_id}")),
            if retrying { "Retrying…" } else { "Retry" },
            tokens,
            retrying,
            on_retry,
        ));
    }
    actions = actions.child(details_anchor).child(
        micro_icon_button(
            SharedString::from(format!("device-warn-dismiss-{host_id}")),
            "superhero/close.svg",
            tokens,
            on_dismiss,
        )
        .conn_tooltip("Dismiss", tokens),
    );

    h_flex()
        .w_full()
        .items_center()
        .gap(px(8.0))
        .border_b_1()
        .border_color(divider)
        .px(px(12.0))
        .py(px(4.0))
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX))
        .text_color(muted)
        .child(
            h_flex()
                .flex_1()
                .min_w_0()
                .items_start()
                .gap(px(8.0))
                .child(div().mt(px(1.0)).child(superhero_icon(
                    "superhero/error-circle.svg",
                    14.0,
                    warning,
                )))
                .child(div().min_w_0().child(text)),
        )
        .child(actions)
}

/// `DeviceHostUpdates` (`DeviceHostUpdates.tsx`): per-host installing/starting/failed cards.
pub(super) fn device_host_updates(
    tokens: &Tokens,
    hosts: &[HostView<'_>],
    host_statuses: &conn_contract::DeviceHostStatuses,
    supports_host_retry: bool,
    retrying_host_id: Option<&str>,
    on_retry_host: impl Fn(String, &mut Window, &mut App) + Clone + 'static,
) -> Option<Div> {
    let mut cards = Vec::new();
    for host in hosts {
        let Some(status) = host_statuses.get(host.id) else {
            continue;
        };
        if !matches!(
            status.status,
            DeviceHostStatus::Installing | DeviceHostStatus::Starting | DeviceHostStatus::Failed
        ) {
            continue;
        }
        let failed = status.status == DeviceHostStatus::Failed;
        let detail = status.detail.as_deref().unwrap_or(if failed {
            "Device support could not start."
        } else if status.status == DeviceHostStatus::Installing {
            "Installing device tools…"
        } else {
            "Starting device tools…"
        });

        let mut text_col = v_flex()
            .flex_1()
            .min_w_0()
            .gap(px(2.0))
            .child(
                div()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(to_hsla(tokens.foreground))
                    .child(host.label.to_owned()),
            )
            .child(
                div()
                    .text_color(to_hsla(tokens.muted_foreground))
                    .child(detail.to_owned()),
            );
        if failed {
            text_col = text_col.child(
                div()
                    .mt(px(2.0))
                    .text_color(to_hsla(tokens.muted_foreground))
                    .child("Check the host connection and network access, then retry. Your device settings are saved."),
            );
        }

        let mut card = h_flex()
            .w_full()
            .items_start()
            .gap(px(12.0))
            .rounded(px(CONTROL_RADIUS_PX))
            .border_1()
            .border_color(chrome::alpha(tokens.border, 0.60))
            .px(px(12.0))
            .py(px(8.0))
            .text_size(px(XS_TEXT_PX))
            .line_height(px(XS_LINE_HEIGHT_PX))
            .child(text_col);

        if failed && supports_host_retry {
            let host_id = host.id.to_owned();
            let on_retry = on_retry_host.clone();
            let is_this = retrying_host_id == Some(host.id);
            card = card.child(compact_outline_button(
                SharedString::from(format!("device-host-retry-{}", host.id)),
                None,
                if is_this { "Retrying…" } else { "Retry" },
                tokens,
                retrying_host_id.is_some(),
                move |_, window, cx| on_retry(host_id.clone(), window, cx),
            ));
        }
        cards.push(card);
    }

    if cards.is_empty() {
        return None;
    }
    let mut stack = v_flex().w_full().gap(px(8.0)).px(px(12.0)).py(px(8.0));
    for card in cards {
        stack = stack.child(card);
    }
    Some(stack)
}

/// Booting banner (`DevicePanel.tsx`: "Starting {names}… This can take a minute.").
pub(super) fn booting_banner(tokens: &Tokens, names: &str) -> Div {
    div()
        .w_full()
        .border_b_1()
        .border_color(to_hsla(tokens.shell_divider))
        .px(px(12.0))
        .py(px(8.0))
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX))
        .text_color(to_hsla(tokens.muted_foreground))
        .child(format!("Starting {names}… This can take a minute."))
}

/// Stage for [`device_loading_view`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum LoadingStage {
    Opening,
    Stream,
}

/// `DeviceLoadingView` (`DeviceLoadingView.tsx`): centered tile, name, description,
/// spinner + status message, optional action button, and 2-segment progress bar.
pub(super) fn device_loading_view(
    tokens: &Tokens,
    name: impl Into<SharedString>,
    description: Option<SharedString>,
    stage: LoadingStage,
    message: impl Into<SharedString>,
    is_error: bool,
    action: Option<AnyElement>,
) -> Div {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let tile_bg = to_hsla(tokens.shell_tile);
    let tile_border = to_hsla(tokens.shell_tile_border);

    let mut title_block = v_flex().items_center().gap(px(4.0)).child(
        div()
            .text_size(px(SM_TEXT_PX))
            .line_height(px(SM_LINE_HEIGHT_PX))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .child(name.into()),
    );
    if let Some(desc) = description.filter(|d| !d.is_empty()) {
        title_block = title_block.child(
            div()
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(desc),
        );
    }

    let mut status_row = h_flex()
        .items_center()
        .justify_center()
        .gap(px(8.0))
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX))
        .text_color(if is_error {
            to_hsla(tokens.destructive)
        } else {
            muted
        });
    if !is_error {
        status_row = status_row.child(superhero_icon("superhero/spinner.svg", 14.0, muted));
    }
    status_row = status_row.child(message.into());

    let mut inner = v_flex()
        .max_w(px(384.0))
        .items_center()
        .gap(px(12.0))
        .child(
            div()
                .flex()
                .size(px(48.0))
                .items_center()
                .justify_center()
                .rounded(px(12.0))
                .bg(tile_bg)
                .border_1()
                .border_color(tile_border)
                .child(superhero_icon("superhero/phone.svg", 24.0, muted)),
        )
        .child(title_block)
        .child(status_row);

    if let Some(action) = action {
        inner = inner.child(action);
    }

    if !is_error {
        let active_bar = chrome::alpha(tokens.foreground, 0.60);
        let idle_bar = to_hsla(tokens.muted);
        inner = inner.child(
            h_flex()
                .w(px(96.0))
                .gap(px(4.0))
                .child(
                    div()
                        .h(px(4.0))
                        .flex_1()
                        .rounded(px(PILL_RADIUS_PX))
                        .bg(active_bar),
                )
                .child(div().h(px(4.0)).flex_1().rounded(px(PILL_RADIUS_PX)).bg(
                    if stage == LoadingStage::Stream {
                        active_bar
                    } else {
                        idle_bar
                    },
                )),
        );
    }

    div()
        .flex()
        .flex_1()
        .min_h_0()
        .size_full()
        .items_center()
        .justify_center()
        .px(px(24.0))
        .py(px(40.0))
        .child(inner)
}

/// `DeviceHostAvailability` (`DeviceHostAvailability.tsx`): compact check/minus platform row.
pub(super) fn device_host_availability(
    tokens: &Tokens,
    platforms: &[DevicePlatformAvailability],
) -> Div {
    let muted = to_hsla(tokens.muted_foreground);
    let success = to_hsla(tokens.success);
    let mut row = h_flex()
        .flex_wrap()
        .gap_x(px(16.0))
        .gap_y(px(4.0))
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX))
        .text_color(muted);
    for (idx, platform) in platforms.iter().enumerate() {
        let name = platform_name(platform.platform);
        let (icon, color, text) = if platform.available {
            ("superhero/check.svg", success, format!("{name} available"))
        } else {
            ("superhero/remove.svg", muted, format!("{name} unavailable"))
        };
        let tip = platform
            .reason
            .as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .map_or_else(|| text.clone(), ToOwned::to_owned);
        row = row.child(
            h_flex()
                .id(SharedString::from(format!(
                    "device-host-avail-{idx}-{:?}",
                    platform.platform
                )))
                .items_center()
                .gap(px(4.0))
                .conn_tooltip(tip, tokens)
                .child(superhero_icon(icon, 12.0, color))
                .child(text),
        );
    }
    row
}

/// `DeviceToolVersions` inline card (`DeviceToolVersions.tsx`).
pub(super) fn tool_versions_detail(
    tokens: &Tokens,
    tools: Option<&DeviceToolVersions>,
    error: Option<&str>,
) -> Div {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let divider = to_hsla(tokens.shell_divider);
    let mono: SharedString = MONO_FONT.into();

    let mut card = v_flex()
        .w_full()
        .gap(px(8.0))
        .rounded(px(10.0))
        .border_1()
        .border_color(divider)
        .bg(to_hsla(tokens.shell_settings_card))
        .p(px(12.0))
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX));

    if let Some(tools) = tools {
        for (idx, (title, tool)) in [("Device hub", &tools.hub), ("Agent device", &tools.agent)]
            .into_iter()
            .enumerate()
        {
            let active = active_tool_version(tool)
                .map(|v| format!("v{v}"))
                .unwrap_or_else(|| "Not installed".to_owned());
            let installed = if tool.installed_versions.is_empty() {
                "None".to_owned()
            } else {
                tool.installed_versions.join(", ")
            };
            let mut section = v_flex()
                .gap(px(4.0))
                .when(idx > 0, |el| {
                    el.pt(px(8.0)).border_t_1().border_color(divider)
                })
                .child(
                    h_flex()
                        .justify_between()
                        .items_center()
                        .child(
                            div()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(fg)
                                .child(title),
                        )
                        .child(div().text_color(muted).child(active)),
                );
            for (k, v) in [
                (
                    "Running",
                    tool.running_version
                        .as_deref()
                        .unwrap_or("Not running")
                        .to_owned(),
                ),
                ("Required", tool.required_version.clone()),
                ("Installed", installed),
            ] {
                section = section.child(
                    h_flex()
                        .justify_between()
                        .gap(px(16.0))
                        .child(div().text_color(muted).child(k))
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .font_family(mono.clone())
                                .text_color(fg)
                                .child(v),
                        ),
                );
            }
            card = card.child(section);
        }
    } else {
        card = card.child(
            div()
                .text_color(muted)
                .child("Versions have not been checked."),
        );
    }

    card = card.child(
        div()
            .pt(px(8.0))
            .border_t_1()
            .border_color(divider)
            .text_color(muted)
            .child("Tools update automatically on this host when needed."),
    );
    if let Some(err) = error {
        card = card.child(
            div()
                .text_color(to_hsla(tokens.destructive))
                .child(err.to_owned()),
        );
    }
    card
}

/// Standard `text-ui` labeled field wrapper for setup/host forms.
pub(super) fn form_field(
    label: impl Into<SharedString>,
    tokens: &Tokens,
    control: impl IntoElement,
) -> Div {
    v_flex()
        .w_full()
        .gap(px(6.0))
        .child(
            div()
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(to_hsla(tokens.foreground))
                .child(label.into()),
        )
        .child(control)
}

fn outline_fills(tokens: &Tokens) -> (Hsla, Hsla) {
    match tokens.appearance {
        Appearance::Light => (
            to_hsla(tokens.popover),
            chrome::alpha(tokens.shell_highlight, 0.50),
        ),
        Appearance::Dark => (
            chrome::alpha(tokens.input, 0.32),
            chrome::alpha(tokens.input, 0.64),
        ),
    }
}

fn outline_shadow(tokens: &Tokens) -> Option<BoxShadow> {
    match tokens.appearance {
        Appearance::Light => Some(BoxShadow {
            color: gpui_kit::hsla(0.0, 0.0, 0.0, 0.05),
            offset: point(px(0.0), px(1.0)),
            blur_radius: px(2.0),
            spread_radius: px(0.0),
            inset: false,
        }),
        Appearance::Dark => None,
    }
}

pub(super) fn dropdown_shadow(tokens: &Tokens) -> BoxShadow {
    let (offset_y, blur, alpha) = match tokens.appearance {
        Appearance::Dark => (18.0, 44.0, 0.80),
        Appearance::Light => (16.0, 40.0, 0.55),
    };
    BoxShadow {
        color: gpui_kit::hsla(0.0, 0.0, 0.0, alpha),
        offset: point(px(0.0), px(offset_y)),
        blur_radius: px(blur),
        spread_radius: px(-18.0),
        inset: false,
    }
}
