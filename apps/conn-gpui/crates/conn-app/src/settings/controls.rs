//! Shared Conn settings & overlay controls: raised `Kbd` caps, pill switches,
//! and raised `SettingsGroup` / square-row containers.
//!
//! All colors are derived from [`Tokens`] — never hardcoded hex literals.

use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::{
    AnyElement, Div, ElementId, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, Stateful, StatefulInteractiveElement as _, Styled as _,
    Window, div, px,
};

use crate::a11y::ConnA11yExt as _;
use crate::theme::hsla;

const SWITCH_TRACK_W_PX: f32 = 34.0;
const SWITCH_TRACK_H_PX: f32 = 20.0;
const SWITCH_THUMB_PX: f32 = 16.0;
const SWITCH_INSET_PX: f32 = 2.0;

/// Raised `Kbd` key cap matching Conn's `ui/kbd.tsx` (`variant="raised"`):
/// `shell_highlight` fill and `foreground` text, 20px tall, 4px radius.
#[must_use]
pub(crate) fn kbd_cap(label: &str, tokens: &Tokens) -> Div {
    div()
        .flex()
        .items_center()
        .justify_center()
        .flex_shrink_0()
        .h(px(20.0))
        .min_w(px(20.0))
        .px(px(5.0))
        .rounded(px(4.0))
        .bg(hsla(tokens.shell_highlight))
        .text_size(px(12.0))
        .font_weight(FontWeight::MEDIUM)
        .text_color(hsla(tokens.foreground))
        .child(label.to_owned())
}

/// Pill switch matching Conn's `ui/switch.tsx`:
/// `9999px` pill track, checked color `tokens.switch_on`, unchecked `tokens.input`,
/// concentric round thumb (`tokens.background`).
#[must_use]
pub(crate) fn pill_switch(
    id: impl Into<ElementId>,
    checked: bool,
    tokens: &Tokens,
    on_click: impl Fn(&mut Window, &mut gpui_kit::App) + 'static,
) -> impl IntoElement {
    let track_bg = if checked {
        hsla(tokens.switch_on)
    } else {
        hsla(tokens.input)
    };
    let thumb_bg = hsla(tokens.background);
    let thumb_offset = if checked {
        SWITCH_TRACK_W_PX - SWITCH_THUMB_PX - SWITCH_INSET_PX * 2.0
    } else {
        0.0
    };

    let switch_id = id.into();
    let raw_slug = match &switch_id {
        ElementId::Name(name) => name.trim_start_matches("conn-settings-").to_owned(),
        other => format!("{other:?}"),
    };
    let ax_id = SharedString::from(format!("settings.switch.{raw_slug}"));
    let label = humanize_slug(&raw_slug);
    div()
        .id(switch_id)
        .a11y_switch(ax_id, label, checked)
        .flex()
        .flex_row()
        .items_center()
        .flex_shrink_0()
        .w(px(SWITCH_TRACK_W_PX))
        .h(px(SWITCH_TRACK_H_PX))
        .p(px(SWITCH_INSET_PX))
        .rounded(px(9999.0))
        .bg(track_bg)
        .cursor_pointer()
        .on_click(move |_, window, cx| on_click(window, cx))
        .child(
            div()
                .ml(px(thumb_offset))
                .size(px(SWITCH_THUMB_PX))
                .rounded(px(9999.0))
                .bg(thumb_bg),
        )
}

/// Renders a Settings section: normal sentence-case title (`13px` medium,
/// `foreground`) above a raised `SettingsGroup` card (`shell_settings_card` fill,
/// `shell_settings_card_border` border, `8px` radius) whose square rows are
/// divided by `1px` `shell_divider_raised` with no trailing divider.
#[must_use]
pub(crate) fn settings_section(
    title: &str,
    rows: Vec<AnyElement>,
    tokens: &Tokens,
    geometry: &ShellGeometry,
) -> Stateful<Div> {
    let fg = hsla(tokens.foreground);
    let card_bg = hsla(tokens.shell_settings_card);
    let card_border = hsla(tokens.shell_settings_card_border);
    let row_divider = hsla(tokens.shell_divider_raised);

    let mut group = div()
        .flex()
        .flex_col()
        .w_full()
        .rounded(px(8.0))
        .overflow_hidden()
        .bg(card_bg)
        .border_1()
        .border_color(card_border);

    let row_count = rows.len();
    for (idx, row) in rows.into_iter().enumerate() {
        group = group.child(row);
        if idx + 1 < row_count {
            group = group.child(div().w_full().h(px(1.0)).bg(row_divider));
        }
    }

    let slug = title.to_ascii_lowercase().replace(' ', "-");
    div()
        .id(SharedString::from(format!("settings-section-{slug}")))
        .a11y_region(
            SharedString::from(format!("settings.section.{slug}")),
            title.to_owned(),
        )
        .flex()
        .flex_col()
        .gap(px(8.0))
        .w_full()
        .child(
            div()
                .px(px(4.0))
                .text_size(px(geometry.ui_font_size_px))
                .line_height(px(geometry.ui_line_height_px))
                .font_weight(FontWeight::MEDIUM)
                .text_color(fg)
                .child(title.to_owned()),
        )
        .child(group)
}

/// A titled region with no card around its content: the title, then `content` as it is. The
/// terminal example uses it, as its own box carries the border (Nick, #336).
#[must_use]
pub(crate) fn settings_bare_section(
    title: &str,
    content: AnyElement,
    tokens: &Tokens,
    geometry: &ShellGeometry,
) -> Stateful<Div> {
    let slug = title.to_ascii_lowercase().replace(' ', "-");
    div()
        .id(SharedString::from(format!("settings-section-{slug}")))
        .a11y_region(
            SharedString::from(format!("settings.section.{slug}")),
            title.to_owned(),
        )
        .flex()
        .flex_col()
        .gap(px(8.0))
        .w_full()
        .child(
            div()
                .px(px(4.0))
                .text_size(px(geometry.ui_font_size_px))
                .line_height(px(geometry.ui_line_height_px))
                .font_weight(FontWeight::MEDIUM)
                .text_color(hsla(tokens.foreground))
                .child(title.to_owned()),
        )
        .child(content)
}

/// One square row (`rounded-none`) inside a raised [`settings_section`].
///
/// Trailing controls align with the title line (`items_start`), and secondary
/// descriptions use `tokens.muted_foreground_raised` at `13px`/`20px`.
#[must_use]
pub(crate) fn settings_row(
    title: &str,
    description: Option<&str>,
    trailing: AnyElement,
    tokens: &Tokens,
    geometry: &ShellGeometry,
) -> AnyElement {
    let fg = hsla(tokens.foreground);
    let muted_raised = hsla(tokens.muted_foreground_raised);

    let mut text_col = div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .gap(px(2.0))
        .child(
            div()
                .text_size(px(geometry.ui_font_size_px))
                .line_height(px(geometry.ui_line_height_px))
                .font_weight(FontWeight::MEDIUM)
                .text_color(fg)
                .child(title.to_owned()),
        );

    if let Some(desc) = description {
        text_col = text_col.child(
            div()
                .text_size(px(geometry.ui_font_size_px))
                .line_height(px(geometry.ui_line_height_px))
                .text_color(muted_raised)
                .child(desc.to_owned()),
        );
    }

    let slug = title.to_ascii_lowercase().replace(' ', "-");
    div()
        .id(SharedString::from(format!("settings-row-{slug}")))
        .a11y_group(
            SharedString::from(format!("settings.row.{slug}")),
            title.to_owned(),
        )
        .flex()
        .flex_row()
        .items_start()
        .justify_between()
        .gap(px(16.0))
        .w_full()
        .px(px(14.0))
        .py(px(12.0))
        .child(text_col)
        .child(div().flex_shrink_0().child(trailing))
        .into_any_element()
}

fn humanize_slug(slug: &str) -> String {
    let words = slug.replace(['-', '_'], " ");
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
        None => "Toggle setting".to_owned(),
    }
}
