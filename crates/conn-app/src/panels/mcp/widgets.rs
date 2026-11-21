//! Shared Conn-styled UI widgets for the MCP panel: badges, glass menus with trailing detail
//! text and group labels, syntax-highlighted JSON, and safe Markdown rendering for tool output.

use std::ops::Range;

use conn_theme::{Appearance, Tokens};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, BoxShadow, Div, ElementId, FontStyle, FontWeight, HighlightStyle, Hsla,
    InteractiveElement, IntoElement, MouseButton, ParentElement, SharedString, Styled, StyledText,
    UnderlineStyle, Window, deferred, div, point, px,
};
use markdown::mdast::Node;

use crate::panels::chrome::{UI_LINE_HEIGHT_PX, UI_TEXT_PX, XS_LINE_HEIGHT_PX, XS_TEXT_PX};
use crate::panels::color::to_hsla;
use crate::panels::highlight::highlight_lines;
use crate::theme::MONO_FONT;

/// Conn `Badge` color variants (`components/ui/badge.tsx`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum McpBadgeVariant {
    Error,
    Info,
    Success,
    Outline,
}

/// Conn `Badge` (`sm:h-4.5 px-[3px] rounded-sm text-xs font-medium`), reading only `Tokens`.
pub(super) fn badge(
    tokens: &Tokens,
    variant: McpBadgeVariant,
    label: impl Into<SharedString>,
    mono: bool,
) -> Div {
    let dark = tokens.appearance == Appearance::Dark;
    let tint = if dark { 0.16 } else { 0.08 };
    let (bg, fg, border): (Hsla, Hsla, Option<Hsla>) = match variant {
        McpBadgeVariant::Error => (
            to_hsla(tokens.destructive.with_alpha(tint)),
            to_hsla(tokens.destructive_foreground),
            None,
        ),
        McpBadgeVariant::Info => (
            to_hsla(tokens.info.with_alpha(tint)),
            to_hsla(tokens.info_foreground),
            None,
        ),
        McpBadgeVariant::Success => (
            to_hsla(tokens.success.with_alpha(tint)),
            to_hsla(tokens.success_foreground),
            None,
        ),
        McpBadgeVariant::Outline => (
            if dark {
                to_hsla(tokens.input.with_alpha(0.32))
            } else {
                to_hsla(tokens.background)
            },
            to_hsla(tokens.foreground),
            Some(to_hsla(tokens.input)),
        ),
    };
    let mut el = h_flex()
        .flex_shrink_0()
        .h(px(18.0))
        .min_w(px(18.0))
        .px(px(4.0))
        .items_center()
        .justify_center()
        .rounded(px(4.0))
        .bg(bg)
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX))
        .font_weight(FontWeight::MEDIUM)
        .text_color(fg)
        .whitespace_nowrap();
    if let Some(border_color) = border {
        el = el.border_1().border_color(border_color);
    }
    if mono {
        el = el.font_family(SharedString::from(MONO_FONT));
    }
    el.child(label.into())
}

/// A row in an MCP `dropdown-glass` popup menu, with optional trailing detail text.
pub(super) struct McpMenuRow {
    pub(super) id: SharedString,
    pub(super) label: SharedString,
    pub(super) mono_label: bool,
    pub(super) detail: Option<SharedString>,
    pub(super) mono_detail: bool,
    pub(super) checked: bool,
    pub(super) on_select: Box<dyn Fn(&mut Window, &mut App)>,
}

/// Entries inside an MCP `dropdown-glass` menu.
pub(super) enum McpMenuEntry {
    Row(McpMenuRow),
    GroupLabel(SharedString),
    Separator,
}

/// Conn `dropdown-glass` popup anchored `sideOffset={6}` below a trigger (`align="start"`).
pub(super) fn dropdown_menu(
    id: impl Into<ElementId>,
    tokens: &Tokens,
    entries: Vec<McpMenuEntry>,
    top_px: f32,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let highlight = to_hsla(tokens.shell_highlight);
    let checked_bg = to_hsla(tokens.foreground.with_alpha(0.08));
    let divider = to_hsla(tokens.foreground.with_alpha(0.08));
    let mono: SharedString = MONO_FONT.into();
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
    let mut list = v_flex()
        .id(id)
        .min_w(px(176.0))
        .max_w(px(340.0))
        .p(px(4.0))
        .rounded(px(12.0))
        .bg(to_hsla(tokens.popover))
        .border_1()
        .border_color(divider)
        .shadow(vec![shadow])
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());

    for entry in entries {
        match entry {
            McpMenuEntry::Separator => {
                list = list.child(div().mx(px(8.0)).my(px(4.0)).h(px(1.0)).bg(divider));
            }
            McpMenuEntry::GroupLabel(text) => {
                list = list.child(
                    div()
                        .px(px(8.0))
                        .py(px(6.0))
                        .text_size(px(XS_TEXT_PX))
                        .line_height(px(XS_LINE_HEIGHT_PX))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(muted)
                        .child(text),
                );
            }
            McpMenuEntry::Row(row) => {
                let on_select = row.on_select;
                let mut label_el = div().min_w_0().flex_1().truncate().child(row.label);
                if row.mono_label {
                    label_el = label_el.font_family(mono.clone());
                }
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
                    .text_size(px(14.0))
                    .line_height(px(20.0))
                    .text_color(fg)
                    .when(row.checked, |el| el.bg(checked_bg))
                    .hover(move |s| s.bg(highlight))
                    .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                        cx.stop_propagation();
                        on_select(window, cx);
                    })
                    .child(label_el);
                if let Some(detail) = row.detail {
                    let mut detail_el = div()
                        .ml_auto()
                        .pl(px(12.0))
                        .flex_shrink_0()
                        .text_color(muted);
                    if row.mono_detail {
                        detail_el = detail_el
                            .font_family(mono.clone())
                            .text_size(px(XS_TEXT_PX))
                            .line_height(px(XS_LINE_HEIGHT_PX));
                    }
                    item = item.child(detail_el.child(detail));
                }
                list = list.child(item);
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
    .with_priority(3)
    .into_any_element()
}

/// Bordered mono input container matching Conn's `fieldClass`:
/// `w-full min-w-0 rounded-(--control-radius) border border-(--shell-divider)! bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground`.
pub(super) fn field_box(tokens: &Tokens) -> Div {
    div()
        .w_full()
        .min_w_0()
        .rounded(px(6.0))
        .border_1()
        .border_color(to_hsla(tokens.shell_divider))
        .px(px(10.0))
        .py(px(6.0))
        .font_family(SharedString::from(MONO_FONT))
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX))
        .text_color(to_hsla(tokens.foreground))
}

/// Renders mono `text-xs` code; when `is_json` is true, highlights tokens via syntect using `Tokens`.
pub(super) fn code_block(tokens: &Tokens, text: &str, is_json: bool) -> AnyElement {
    let mono: SharedString = MONO_FONT.into();
    let fg = to_hsla(tokens.foreground);

    if !is_json {
        return div()
            .w_full()
            .min_w_0()
            .font_family(mono)
            .text_size(px(XS_TEXT_PX))
            .line_height(px(XS_LINE_HEIGHT_PX))
            .text_color(fg)
            .child(text.to_owned())
            .into_any_element();
    }

    let lines = highlight_lines("result.json", text, tokens);
    let mut full = String::with_capacity(text.len());
    let mut highlights: Vec<(Range<usize>, HighlightStyle)> = Vec::new();
    for (idx, spans) in lines.iter().enumerate() {
        if idx > 0 {
            full.push('\n');
        }
        for span in spans {
            let start = full.len();
            full.push_str(&span.text);
            let end = full.len();
            highlights.push((
                start..end,
                HighlightStyle {
                    color: Some(to_hsla(span.color)),
                    font_weight: span.bold.then_some(FontWeight::BOLD),
                    font_style: span.italic.then_some(FontStyle::Italic),
                    ..HighlightStyle::default()
                },
            ));
        }
    }

    div()
        .w_full()
        .min_w_0()
        .font_family(mono)
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX))
        .text_color(fg)
        .child(StyledText::new(full).with_highlights(highlights))
        .into_any_element()
}

/// Renders untrusted Markdown text (no raw HTML) for MCP tool/resource/prompt results.
pub(super) fn render_markdown(tokens: &Tokens, src: &str) -> AnyElement {
    if src.trim().is_empty() {
        return div().into_any_element();
    }
    let Ok(Node::Root(root)) = markdown::to_mdast(src, &markdown::ParseOptions::gfm()) else {
        return div()
            .w_full()
            .min_w_0()
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(to_hsla(tokens.foreground))
            .child(src.to_owned())
            .into_any_element();
    };
    let mut column = v_flex().w_full().min_w_0().gap(px(8.0));
    for child in &root.children {
        if let Some(el) = render_md_block(tokens, child) {
            column = column.child(el);
        }
    }
    column.into_any_element()
}

#[derive(Clone, Copy, Default)]
struct InlineFlags {
    bold: bool,
    italic: bool,
    code: bool,
    strike: bool,
    link: bool,
}

fn collect_inline_text(
    nodes: &[Node],
    flags: InlineFlags,
    tokens: &Tokens,
    out: &mut String,
    highlights: &mut Vec<(Range<usize>, HighlightStyle)>,
) {
    let code_bg = to_hsla(tokens.foreground.with_alpha(0.10));
    let link_color = to_hsla(tokens.primary);
    for node in nodes {
        match node {
            Node::Text(t) => push_inline_run(&t.value, flags, code_bg, link_color, out, highlights),
            Node::InlineCode(c) => {
                let mut f = flags;
                f.code = true;
                push_inline_run(&c.value, f, code_bg, link_color, out, highlights);
            }
            Node::Strong(s) => {
                let mut f = flags;
                f.bold = true;
                collect_inline_text(&s.children, f, tokens, out, highlights);
            }
            Node::Emphasis(e) => {
                let mut f = flags;
                f.italic = true;
                collect_inline_text(&e.children, f, tokens, out, highlights);
            }
            Node::Delete(d) => {
                let mut f = flags;
                f.strike = true;
                collect_inline_text(&d.children, f, tokens, out, highlights);
            }
            Node::Link(l) => {
                let mut f = flags;
                f.link = true;
                collect_inline_text(&l.children, f, tokens, out, highlights);
            }
            Node::Break(_) => out.push('\n'),
            // Untrusted output: never interpret raw HTML; render as literal text.
            Node::Html(h) => push_inline_run(&h.value, flags, code_bg, link_color, out, highlights),
            _ => {}
        }
    }
}

fn push_inline_run(
    text: &str,
    flags: InlineFlags,
    code_bg: Hsla,
    link_color: Hsla,
    out: &mut String,
    highlights: &mut Vec<(Range<usize>, HighlightStyle)>,
) {
    if text.is_empty() {
        return;
    }
    let start = out.len();
    out.push_str(text);
    let end = out.len();
    if flags.bold || flags.italic || flags.code || flags.strike || flags.link {
        highlights.push((
            start..end,
            HighlightStyle {
                color: flags.link.then_some(link_color),
                font_weight: flags.bold.then_some(FontWeight::SEMIBOLD),
                font_style: flags.italic.then_some(FontStyle::Italic),
                background_color: flags.code.then_some(code_bg),
                underline: flags.link.then_some(UnderlineStyle {
                    thickness: px(1.0),
                    color: Some(link_color),
                    wavy: false,
                }),
                strikethrough: flags.strike.then_some(gpui_kit::StrikethroughStyle {
                    thickness: px(1.0),
                    color: None,
                }),
                ..HighlightStyle::default()
            },
        ));
    }
}

fn render_inline_nodes(tokens: &Tokens, nodes: &[Node]) -> StyledText {
    let mut text = String::new();
    let mut highlights = Vec::new();
    collect_inline_text(
        nodes,
        InlineFlags::default(),
        tokens,
        &mut text,
        &mut highlights,
    );
    StyledText::new(text).with_highlights(highlights)
}

fn render_md_block(tokens: &Tokens, node: &Node) -> Option<AnyElement> {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let divider = to_hsla(tokens.shell_divider);

    match node {
        Node::Paragraph(p) => Some(
            div()
                .w_full()
                .min_w_0()
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(fg)
                .child(render_inline_nodes(tokens, &p.children))
                .into_any_element(),
        ),
        Node::Heading(h) => {
            let size = match h.depth {
                1 => 16.0,
                2 => 15.0,
                3 => 14.0,
                _ => UI_TEXT_PX,
            };
            Some(
                div()
                    .w_full()
                    .min_w_0()
                    .text_size(px(size))
                    .line_height(px(size + 6.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(fg)
                    .child(render_inline_nodes(tokens, &h.children))
                    .into_any_element(),
            )
        }
        Node::Code(c) => {
            let is_json = c
                .lang
                .as_deref()
                .is_some_and(|l| l.eq_ignore_ascii_case("json"));
            Some(
                div()
                    .w_full()
                    .min_w_0()
                    .rounded(px(8.0))
                    .bg(to_hsla(tokens.code_background))
                    .border_1()
                    .border_color(divider)
                    .px(px(12.0))
                    .py(px(8.0))
                    .child(code_block(tokens, &c.value, is_json))
                    .into_any_element(),
            )
        }
        Node::List(list) => {
            let mut col = v_flex().w_full().min_w_0().gap(px(4.0)).pl(px(4.0));
            let start = list.start.unwrap_or(1);
            for (idx, item) in list.children.iter().enumerate() {
                let Node::ListItem(li) = item else { continue };
                let marker = if list.ordered {
                    format!("{}.", start + u32::try_from(idx).unwrap_or(0))
                } else {
                    "•".to_owned()
                };
                let mut item_body = v_flex().flex_1().min_w_0().gap(px(4.0));
                for child in &li.children {
                    if let Some(el) = render_md_block(tokens, child) {
                        item_body = item_body.child(el);
                    }
                }
                col = col.child(
                    h_flex()
                        .w_full()
                        .min_w_0()
                        .items_start()
                        .gap(px(8.0))
                        .child(
                            div()
                                .flex_shrink_0()
                                .text_size(px(UI_TEXT_PX))
                                .line_height(px(UI_LINE_HEIGHT_PX))
                                .text_color(muted)
                                .child(marker),
                        )
                        .child(item_body),
                );
            }
            Some(col.into_any_element())
        }
        Node::Blockquote(bq) => {
            let mut inner = v_flex()
                .w_full()
                .min_w_0()
                .gap(px(6.0))
                .pl(px(12.0))
                .border_l_2()
                .border_color(divider);
            for child in &bq.children {
                if let Some(el) = render_md_block(tokens, child) {
                    inner = inner.child(el);
                }
            }
            Some(inner.into_any_element())
        }
        Node::ThematicBreak(_) => Some(div().w_full().h(px(1.0)).bg(divider).into_any_element()),
        Node::Html(h) => Some(
            div()
                .w_full()
                .min_w_0()
                .font_family(SharedString::from(MONO_FONT))
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(h.value.clone())
                .into_any_element(),
        ),
        Node::Table(table) => {
            let mut rows_col = v_flex()
                .w_full()
                .min_w_0()
                .rounded(px(6.0))
                .border_1()
                .border_color(divider);
            for (row_idx, row_node) in table.children.iter().enumerate() {
                let Node::TableRow(row) = row_node else {
                    continue;
                };
                let mut tr = h_flex()
                    .w_full()
                    .min_w_0()
                    .when(row_idx > 0, |el| el.border_t_1().border_color(divider));
                for cell_node in &row.children {
                    let Node::TableCell(cell) = cell_node else {
                        continue;
                    };
                    tr = tr.child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .px(px(8.0))
                            .py(px(6.0))
                            .text_size(px(XS_TEXT_PX))
                            .line_height(px(XS_LINE_HEIGHT_PX))
                            .text_color(fg)
                            .when(row_idx == 0, |el| el.font_weight(FontWeight::MEDIUM))
                            .child(render_inline_nodes(tokens, &cell.children)),
                    );
                }
                rows_col = rows_col.child(tr);
            }
            Some(rows_col.into_any_element())
        }
        _ => None,
    }
}
