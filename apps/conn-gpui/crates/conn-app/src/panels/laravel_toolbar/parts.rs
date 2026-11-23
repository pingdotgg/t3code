//! Building blocks shared by the toolbar panels (`apps/web/src/laravelToolbar/ui/parts.tsx`).
//! Rules from the design notes (`laravelToolbarPreview/DESIGN.md`): 12px text, 18px stat values,
//! medium weight, mono only for code, flush grid with thin dividers, no cards.

use conn_desktop::laravel_toolbar::layout::{SortDirection, TableSort};
use conn_theme::{Rgba, Tokens};
use gpui_kit::{
    AnyElement, ClickEvent, Context, Div, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, div, px,
};

use super::LaravelToolbar;
use crate::a11y::ConnA11yExt as _;
use crate::icons;
use crate::theme::{hsla, hsla_alpha};
use gpui_kit::TestSupportExt as _;

pub(super) const TEXT_PX: f32 = 12.0;
pub(super) const SMALL_PX: f32 = 11.0;
pub(super) const CELL_X_PX: f32 = 12.0;
pub(super) const HEAD_H_PX: f32 = 36.0;

/// `font-mono` for code, paths and headers.
pub(super) const MONO: &str = crate::theme::MONO_FONT;

/// The brand marks of the environment item (`brandIcons.tsx`).
#[derive(Clone, Copy)]
pub(super) enum Brand {
    Laravel,
    Symfony,
    Php,
}

pub(super) fn brand_icon(tokens: &Tokens, brand: Brand) -> AnyElement {
    let color = hsla(tokens.muted_foreground);
    let (path, width, height) = match brand {
        Brand::Laravel => ("brand/laravel.svg", 14.0, 14.0),
        Brand::Symfony => ("brand/symfony.svg", 14.0, 14.0),
        Brand::Php => ("brand/php.svg", 24.0, 12.0),
    };
    gpui_kit::svg()
        .path(path)
        .w(px(width))
        .h(px(height))
        .flex_none()
        .text_color(color)
        .into_any_element()
}

/// A CSS colour of the payload (`#rgb`, `#rrggbb`, `rgb(r, g, b)`) as a GPUI colour.
pub(super) fn css_color(text: &str) -> Option<gpui_kit::Hsla> {
    let text = text.trim();
    let (r, g, b) = if let Some(hex) = text.strip_prefix('#') {
        match hex.len() {
            3 => {
                let n = u16::from_str_radix(hex, 16).ok()?;
                let expand = |v: u16| u8::try_from((v & 0xf) * 17).unwrap_or(0);
                (expand(n >> 8), expand(n >> 4), expand(n))
            }
            6 => {
                let n = u32::from_str_radix(hex, 16).ok()?;
                (
                    u8::try_from((n >> 16) & 0xff).ok()?,
                    u8::try_from((n >> 8) & 0xff).ok()?,
                    u8::try_from(n & 0xff).ok()?,
                )
            }
            _ => return None,
        }
    } else {
        let args = text
            .strip_prefix("rgb(")
            .and_then(|t| t.strip_suffix(')'))?;
        let mut parts = args
            .split(|c: char| c == ',' || c.is_whitespace())
            .filter(|p| !p.is_empty());
        (
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
        )
    };
    Some(crate::panels::color::rgb8_to_hsla((r, g, b)))
}

/// A status colour (`success`, `warning`, `info`, `error`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Tone {
    Default,
    Success,
    Warning,
    Info,
    Danger,
}

pub(super) fn tone_color(tokens: &Tokens, tone: Tone) -> gpui_kit::Hsla {
    match tone {
        Tone::Default => hsla(tokens.foreground),
        Tone::Success => hsla(tokens.success_foreground),
        Tone::Warning => hsla(tokens.warning_foreground),
        Tone::Info => hsla(tokens.info_foreground),
        Tone::Danger => hsla(tokens.destructive),
    }
}

fn tone_fill(tokens: &Tokens, tone: Tone) -> Rgba {
    match tone {
        Tone::Default => tokens.foreground,
        Tone::Success => tokens.success,
        Tone::Warning => tokens.warning,
        Tone::Info => tokens.info,
        Tone::Danger => tokens.destructive,
    }
}

/// A `Badge`: a small tinted pill with its tone's text colour (`outline` has a border only).
pub(super) fn badge(tokens: &Tokens, tone: Option<Tone>, label: &str, mono: bool) -> Div {
    let base = div()
        .flex()
        .items_center()
        .h(px(20.0))
        .px(px(6.0))
        .rounded(px(4.0))
        .flex_shrink_0()
        .text_size(px(TEXT_PX))
        .line_height(px(16.0))
        .child(label.to_owned());
    let base = if mono { base.font_family(MONO) } else { base };
    match tone {
        Some(tone) => base
            .bg(hsla_alpha(tone_fill(tokens, tone), 0.14))
            .text_color(tone_color(tokens, tone)),
        None => base
            .border_1()
            .border_color(hsla(tokens.border))
            .text_color(hsla(tokens.foreground)),
    }
}

/// `StatusBadge`: 5xx error, 4xx warning, 3xx info, else success.
pub(super) fn status_badge(tokens: &Tokens, status: Option<u16>) -> AnyElement {
    match status {
        None => div()
            .font_family(MONO)
            .text_size(px(TEXT_PX))
            .text_color(hsla(tokens.muted_foreground))
            .child("–")
            .into_any_element(),
        Some(code) => {
            let tone = match code {
                500.. => Tone::Danger,
                400..=499 => Tone::Warning,
                300..=399 => Tone::Info,
                _ => Tone::Success,
            };
            badge(tokens, Some(tone), &code.to_string(), true).into_any_element()
        }
    }
}

/// `MethodBadge`: GET info, POST success, DELETE error, others warning.
pub(super) fn method_badge(tokens: &Tokens, method: &str) -> AnyElement {
    let tone = match method {
        "GET" => Tone::Info,
        "POST" => Tone::Success,
        "DELETE" => Tone::Danger,
        _ => Tone::Warning,
    };
    badge(tokens, Some(tone), method, true).into_any_element()
}

/// The thin horizontal rule between rows (`divide-y`, `border-b`).
pub(super) fn rule(tokens: &Tokens) -> Div {
    div()
        .h(px(1.0))
        .w_full()
        .flex_shrink_0()
        .bg(hsla(tokens.border))
}

/// `EmptyRow`.
pub(super) fn empty_row(tokens: &Tokens, id: &'static str, text: &str) -> AnyElement {
    div()
        .id(id)
        .test_support()
        .a11y_group(format!("browser.laravel-toolbar.{id}"), text.to_owned())
        .flex()
        .justify_center()
        .px(px(CELL_X_PX))
        .py(px(24.0))
        .text_size(px(TEXT_PX))
        .text_color(hsla(tokens.muted_foreground))
        .child(text.to_owned())
        .into_any_element()
}

/// `Stat`: a label, an 18px value and a secondary line.
pub(super) fn stat(
    tokens: &Tokens,
    id: &str,
    label: &str,
    value: impl Into<SharedString>,
    hint: Option<String>,
    tone: Tone,
) -> AnyElement {
    let value: SharedString = value.into();
    div()
        .id(SharedString::from(format!("stat-{id}")))
        .test_support()
        .a11y_group(
            format!("browser.laravel-toolbar.stat.{id}"),
            format!("{label} {value}"),
        )
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .p(px(CELL_X_PX))
        .child(
            div()
                .truncate()
                .text_size(px(TEXT_PX))
                .font_weight(FontWeight::MEDIUM)
                .text_color(hsla(tokens.muted_foreground))
                .child(label.to_owned()),
        )
        .child(
            div()
                .mt(px(2.0))
                .truncate()
                .text_size(px(18.0))
                .line_height(px(28.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(tone_color(tokens, tone))
                .child(value),
        )
        .child(
            div()
                .mt(px(4.0))
                .truncate()
                .text_size(px(SMALL_PX))
                .line_height(px(16.0))
                .text_color(hsla(tokens.muted_foreground))
                .child(hint.unwrap_or_else(|| " ".to_owned())),
        )
        .into_any_element()
}

/// `StatStrip`: stats split by thin vertical dividers, with a rule below.
pub(super) fn stat_strip(tokens: &Tokens, stats: Vec<AnyElement>) -> AnyElement {
    let mut strip = div().flex().flex_row().w_full().flex_shrink_0();
    for (index, stat) in stats.into_iter().enumerate() {
        if index > 0 {
            strip = strip.child(div().w(px(1.0)).flex_shrink_0().bg(hsla(tokens.border)));
        }
        strip = strip.child(stat);
    }
    div()
        .flex()
        .flex_col()
        .w_full()
        .child(strip)
        .child(rule(tokens))
        .into_any_element()
}

/// `Section`: a titled block of rows, separated from the next by a rule.
pub(super) fn section(
    tokens: &Tokens,
    id: &str,
    title: Option<&str>,
    aside: Option<String>,
    inset: bool,
    body: AnyElement,
) -> AnyElement {
    let mut block = div()
        .id(SharedString::from(format!("section-{id}")))
        .flex()
        .flex_col()
        .w_full()
        .flex_1()
        .min_w_0();
    if let Some(title) = title {
        block = block.child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .px(px(CELL_X_PX))
                .pt(px(12.0))
                .pb(px(8.0))
                .text_size(px(TEXT_PX))
                .text_color(hsla(tokens.muted_foreground))
                .child(
                    div()
                        .font_weight(FontWeight::MEDIUM)
                        .child(title.to_owned()),
                )
                .children(aside),
        );
    }
    block
        .child(if inset {
            div().px(px(CELL_X_PX)).pb(px(12.0)).child(body)
        } else {
            div().child(body)
        })
        .into_any_element()
}

/// A value cell of [`key_value_rows`].
pub(super) enum Value {
    Text(String),
    Mono(String),
    Element(AnyElement),
}

/// `KeyValueRows`: label and value rows, sans unless the row is code.
pub(super) fn key_value_rows(
    tokens: &Tokens,
    id: &str,
    rows: Vec<(String, Value)>,
    mono: bool,
) -> AnyElement {
    let mut list = div().flex().flex_col().w_full();
    let count = rows.len();
    for (index, (key, value)) in rows.into_iter().enumerate() {
        let cell = match value {
            Value::Text(text) if mono => div().font_family(MONO).child(text),
            Value::Text(text) => div().child(text),
            Value::Mono(text) => div().font_family(MONO).child(text),
            Value::Element(element) => div().child(element),
        };
        let row = div()
            .id(SharedString::from(format!("kv-{id}-{key}")))
            .test_support()
            .a11y_group(
                format!("browser.laravel-toolbar.kv.{id}.{key}"),
                key.clone(),
            )
            .flex()
            .flex_row()
            .items_center()
            .gap(px(24.0))
            .px(px(CELL_X_PX))
            .py(px(12.0))
            .text_size(px(TEXT_PX))
            .child(
                div()
                    .w(px(144.0))
                    .flex_shrink_0()
                    .text_color(hsla(tokens.muted_foreground))
                    .child(key),
            )
            .child(
                cell.flex_1()
                    .min_w_0()
                    .truncate()
                    .text_color(hsla(tokens.foreground)),
            );
        list = list.child(if index + 1 < count {
            row.border_b_1().border_color(hsla(tokens.border))
        } else {
            row
        });
    }
    list.into_any_element()
}

/// `SourceLink`: a source file, opened in the editor: soft text with an underline.
pub(super) fn source_link(
    tokens: &Tokens,
    id: String,
    label: String,
    small: bool,
    target: Option<String>,
    cx: &mut Context<'_, LaravelToolbar>,
) -> AnyElement {
    let size = if small { 11.0 } else { TEXT_PX };
    let text = div()
        .id(SharedString::from(format!("source-{id}")))
        .truncate()
        .font_family(MONO)
        .text_size(px(size))
        .text_color(hsla_alpha(tokens.foreground, 0.80));
    let Some(target) = target else {
        return text.child(label).into_any_element();
    };
    let fg = hsla(tokens.foreground);
    text.a11y_button(
        format!("browser.laravel-toolbar.source.{id}"),
        format!("Open {label}"),
    )
    .flex_shrink_0()
    .cursor_pointer()
    .underline()
    .hover(move |s| s.text_color(fg))
    .child(label)
    .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
        cx.stop_propagation();
        this.open_source(&target, cx);
    }))
    .into_any_element()
}

/// `RowMarker`: a thin vertical bar in a status or stage colour.
pub(super) fn row_marker(color: gpui_kit::Hsla, height: f32) -> Div {
    div()
        .h(px(height))
        .w(px(2.0))
        .flex_shrink_0()
        .rounded(px(1.0))
        .bg(color)
}

/// `StageBar`: one thin bar split into segments, each sized by its share.
pub(super) fn stage_bar(tokens: &Tokens, segments: Vec<(gpui_kit::Hsla, f32)>) -> AnyElement {
    let mut bar = div().flex().flex_row().w_full();
    for (color, share) in segments {
        bar = bar.child(
            div()
                .flex()
                .w(gpui_kit::relative(share.clamp(0.0, 1.0)))
                .min_w(px(16.0))
                .px(px(4.0))
                .child(div().h(px(4.0)).w_full().rounded_full().bg(color)),
        );
    }
    div()
        .flex()
        .items_center()
        .h(px(HEAD_H_PX))
        .flex_shrink_0()
        .px(px(CELL_X_PX))
        .border_b_1()
        .border_color(hsla(tokens.border))
        .child(bar)
        .into_any_element()
}

/// A table column: its width and alignment.
#[derive(Clone, Copy)]
pub(super) enum Width {
    Fixed(f32),
    Flex,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Align {
    Left,
    Right,
}

/// One cell, sized like its column.
pub(super) fn cell(width: Width, align: Align, content: impl IntoElement) -> Div {
    let base = div()
        .min_w_0()
        .px(px(CELL_X_PX))
        .flex()
        .flex_row()
        .items_center();
    let base = match width {
        Width::Fixed(w) => base.w(px(w)).flex_shrink_0(),
        Width::Flex => base.flex_1(),
    };
    let base = if align == Align::Right {
        base.justify_end().text_right()
    } else {
        base
    };
    base.child(content)
}

/// `SortHeader`: a column header that sorts its table when clicked.
#[expect(
    clippy::too_many_arguments,
    reason = "a header cell is one table, column, label, sort, width, alignment and action"
)]
pub(super) fn sort_header(
    tokens: &Tokens,
    table: &'static str,
    column: &'static str,
    label: &str,
    sort: Option<&TableSort>,
    width: Width,
    align: Align,
    on_sort: impl Fn(&mut LaravelToolbar, &mut Context<'_, LaravelToolbar>) + 'static,
    cx: &mut Context<'_, LaravelToolbar>,
) -> Div {
    let direction = sort.filter(|s| s.column == column).map(|s| s.direction);
    let next = match direction {
        None => "ascending",
        Some(SortDirection::Ascending) => "descending",
        Some(SortDirection::Descending) => "original order",
    };
    let muted = hsla(tokens.muted_foreground);
    let fg = hsla(tokens.foreground);
    let mut button = div()
        .id(SharedString::from(format!("sort-{table}-{column}")))
        .test_support()
        .a11y_button(
            format!("browser.laravel-toolbar.sort.{table}.{column}"),
            format!("{label}: sort {next}"),
        )
        .flex()
        .flex_row()
        .items_center()
        .gap(px(4.0))
        .h(px(HEAD_H_PX))
        .w_full()
        .min_w_0()
        .cursor_pointer()
        .text_color(muted)
        .hover(move |s| s.text_color(fg))
        .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
            on_sort(this, cx);
            cx.notify();
        }));
    if align == Align::Right {
        button = button.justify_end();
    }
    button = button.child(div().truncate().child(label.to_owned()));
    match direction {
        Some(SortDirection::Ascending) => {
            button = button.child(icons::concept("superhero/arrow-up.svg", 12.0, muted));
        }
        Some(SortDirection::Descending) => {
            button = button.child(icons::concept("superhero/arrow-down.svg", 12.0, muted));
        }
        None => {}
    }
    cell(width, align, button)
        .px(px(0.0))
        .pl(px(CELL_X_PX))
        .pr(px(CELL_X_PX))
        .text_size(px(TEXT_PX))
        .font_weight(FontWeight::MEDIUM)
}

/// The header row of a table: sticky look, thin rule below.
pub(super) fn head_row(tokens: &Tokens, cells: Vec<Div>) -> Div {
    div()
        .flex()
        .flex_row()
        .items_center()
        .w_full()
        .h(px(HEAD_H_PX))
        .flex_shrink_0()
        .border_b_1()
        .border_color(hsla(tokens.border))
        .children(cells)
}

/// A body row of a table, with a hover fill and a thin rule below.
pub(super) fn body_row(tokens: &Tokens, cells: Vec<Div>) -> Div {
    div()
        .flex()
        .flex_row()
        .items_center()
        .w_full()
        .py(px(12.0))
        .text_size(px(TEXT_PX))
        .text_color(hsla(tokens.foreground))
        .border_b_1()
        .border_color(hsla(tokens.border))
        .children(cells)
}

/// `UnderlineTabs`: tabs inside a panel; the open one has an underline.
pub(super) fn underline_tabs<T: Copy + PartialEq + 'static>(
    tokens: &Tokens,
    group: &'static str,
    value: T,
    tabs: Vec<(T, &'static str, String)>,
    on_pick: impl Fn(&mut LaravelToolbar, T, &mut Context<'_, LaravelToolbar>) + Clone + 'static,
    cx: &mut Context<'_, LaravelToolbar>,
) -> AnyElement {
    let muted = hsla(tokens.muted_foreground);
    let fg = hsla(tokens.foreground);
    let primary = hsla(tokens.primary);
    let mut row = div()
        .flex()
        .flex_row()
        .items_stretch()
        .gap(px(16.0))
        .h(px(HEAD_H_PX))
        .flex_shrink_0()
        .px(px(CELL_X_PX))
        .border_b_1()
        .border_color(hsla(tokens.border));
    for (id, key, label) in tabs {
        let selected = id == value;
        let pick = on_pick.clone();
        let mut tab = div()
            .id(SharedString::from(format!("tab-{group}-{key}")))
            .test_support()
            .a11y_button(
                format!("browser.laravel-toolbar.tab.{group}.{key}"),
                label.clone(),
            )
            .relative()
            .flex()
            .items_center()
            .cursor_pointer()
            .text_size(px(TEXT_PX))
            .font_weight(FontWeight::MEDIUM)
            .text_color(if selected { fg } else { muted })
            .hover(move |s| s.text_color(fg))
            .child(label)
            .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                pick(this, id, cx);
                cx.notify();
            }));
        if selected {
            tab = tab.child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom(px(-1.0))
                    .h(px(2.0))
                    .rounded_full()
                    .bg(primary),
            );
        }
        row = row.child(tab);
    }
    row.into_any_element()
}
