//! Lightweight GitHub-flavored Markdown renderer for pull request descriptions and comments.
//!
//! `crate::chat::markdown` is private to the `chat` module, so the PR surface parses GFM via
//! `markdown::to_mdast` directly and styles blocks strictly with `conn_theme::Tokens`.

use std::ops::Range;

use conn_theme::Tokens;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::{
    AnyElement, ClipboardItem, FontStyle, FontWeight, HighlightStyle, InteractiveElement,
    IntoElement, ParentElement, SharedString, StatefulInteractiveElement, Styled, StyledText,
    UnderlineStyle, div, px,
};
use markdown::mdast::Node;

use super::super::chrome;
use super::super::color::to_hsla;
use super::super::header::superhero_icon;
use crate::theme::MONO_FONT;

const BODY_FONT_PX: f32 = 14.0;
const BODY_LINE_HEIGHT_PX: f32 = 22.0;
const CODE_FONT_PX: f32 = 12.5;
const CODE_LINE_HEIGHT_PX: f32 = 19.0;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct InlineStyle {
    bold: bool,
    italic: bool,
    code: bool,
    strikethrough: bool,
    link: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct InlineSpan {
    text: String,
    style: InlineStyle,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ListItem {
    checked: Option<bool>,
    blocks: Vec<MdBlock>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum MdBlock {
    Paragraph(Vec<InlineSpan>),
    Heading {
        level: u8,
        spans: Vec<InlineSpan>,
    },
    CodeBlock {
        language: Option<String>,
        code: String,
    },
    List {
        ordered: bool,
        start: u32,
        items: Vec<ListItem>,
    },
    Blockquote(Vec<MdBlock>),
    Table {
        headers: Vec<Vec<InlineSpan>>,
        rows: Vec<Vec<Vec<InlineSpan>>>,
    },
    ThematicBreak,
}

/// Parses GitHub-flavored Markdown into renderable blocks.
#[must_use]
fn parse_markdown(src: &str) -> Vec<MdBlock> {
    if src.trim().is_empty() {
        return Vec::new();
    }
    let Ok(root) = markdown::to_mdast(src, &markdown::ParseOptions::gfm()) else {
        return vec![MdBlock::Paragraph(vec![InlineSpan {
            text: src.to_owned(),
            style: InlineStyle::default(),
        }])];
    };
    let mut blocks = Vec::new();
    if let Node::Root(root) = root {
        for child in &root.children {
            collect_block(child, &mut blocks);
        }
    }
    blocks
}

fn collect_block(node: &Node, out: &mut Vec<MdBlock>) {
    match node {
        Node::Paragraph(p) => {
            let spans = collect_inlines(&p.children, InlineStyle::default());
            if !spans.is_empty() {
                out.push(MdBlock::Paragraph(spans));
            }
        }
        Node::Heading(h) => {
            let spans = collect_inlines(&h.children, InlineStyle::default());
            if !spans.is_empty() {
                out.push(MdBlock::Heading {
                    level: h.depth,
                    spans,
                });
            }
        }
        Node::Code(c) => {
            let language = c
                .lang
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned);
            out.push(MdBlock::CodeBlock {
                language,
                code: c.value.clone(),
            });
        }
        Node::List(list) => {
            let mut items = Vec::with_capacity(list.children.len());
            for child in &list.children {
                if let Node::ListItem(item) = child {
                    let mut inner_blocks = Vec::new();
                    for inner in &item.children {
                        collect_block(inner, &mut inner_blocks);
                    }
                    items.push(ListItem {
                        checked: item.checked,
                        blocks: inner_blocks,
                    });
                }
            }
            out.push(MdBlock::List {
                ordered: list.ordered,
                start: list.start.unwrap_or(1),
                items,
            });
        }
        Node::Blockquote(bq) => {
            let mut inner = Vec::new();
            for child in &bq.children {
                collect_block(child, &mut inner);
            }
            if !inner.is_empty() {
                out.push(MdBlock::Blockquote(inner));
            }
        }
        Node::Table(table) => {
            let mut headers = Vec::new();
            let mut rows = Vec::new();
            for (idx, row_node) in table.children.iter().enumerate() {
                if let Node::TableRow(row) = row_node {
                    let cells: Vec<Vec<InlineSpan>> = row
                        .children
                        .iter()
                        .filter_map(|cell| match cell {
                            Node::TableCell(tc) => {
                                Some(collect_inlines(&tc.children, InlineStyle::default()))
                            }
                            _ => None,
                        })
                        .collect();
                    if idx == 0 {
                        headers = cells;
                    } else {
                        rows.push(cells);
                    }
                }
            }
            if !headers.is_empty() || !rows.is_empty() {
                out.push(MdBlock::Table { headers, rows });
            }
        }
        Node::ThematicBreak(_) => out.push(MdBlock::ThematicBreak),
        Node::Html(html) => {
            // Skip pure HTML comment blocks (`<!-- ... -->`) like Conn's markdown sanitizer.
            let trimmed = html.value.trim();
            if !trimmed.is_empty() && !(trimmed.starts_with("<!--") && trimmed.ends_with("-->")) {
                out.push(MdBlock::Paragraph(vec![InlineSpan {
                    text: trimmed.to_owned(),
                    style: InlineStyle::default(),
                }]));
            }
        }
        _ => {}
    }
}

fn collect_inlines(nodes: &[Node], style: InlineStyle) -> Vec<InlineSpan> {
    let mut out = Vec::new();
    for node in nodes {
        collect_inline(node, style, &mut out);
    }
    out
}

fn collect_inline(node: &Node, style: InlineStyle, out: &mut Vec<InlineSpan>) {
    match node {
        Node::Text(t) => push_span(out, &t.value, style),
        Node::InlineCode(c) => {
            let mut next = style;
            next.code = true;
            push_span(out, &c.value, next);
        }
        Node::Strong(s) => {
            let mut next = style;
            next.bold = true;
            for child in &s.children {
                collect_inline(child, next, out);
            }
        }
        Node::Emphasis(e) => {
            let mut next = style;
            next.italic = true;
            for child in &e.children {
                collect_inline(child, next, out);
            }
        }
        Node::Delete(d) => {
            let mut next = style;
            next.strikethrough = true;
            for child in &d.children {
                collect_inline(child, next, out);
            }
        }
        Node::Link(link) => {
            let mut next = style;
            next.link = true;
            for child in &link.children {
                collect_inline(child, next, out);
            }
        }
        Node::Break(_) => push_span(out, "\n", style),
        Node::Image(img) => {
            let label = if img.alt.is_empty() {
                &img.url
            } else {
                &img.alt
            };
            push_span(out, label, style);
        }
        _ => {}
    }
}

fn push_span(out: &mut Vec<InlineSpan>, text: &str, style: InlineStyle) {
    if text.is_empty() {
        return;
    }
    if let Some(last) = out.last_mut()
        && last.style == style
    {
        last.text.push_str(text);
        return;
    }
    out.push(InlineSpan {
        text: text.to_owned(),
        style,
    });
}

/// Renders Markdown text into a GPUI element using Conn's typography and theme tokens.
pub(super) fn render_markdown(id_prefix: &str, src: &str, tokens: &Tokens) -> AnyElement {
    let blocks = parse_markdown(src);
    render_blocks(id_prefix, &blocks, tokens)
}

fn render_blocks(id_prefix: &str, blocks: &[MdBlock], tokens: &Tokens) -> AnyElement {
    let mut col = v_flex().w_full().min_w_0().gap(px(10.0));
    for (idx, block) in blocks.iter().enumerate() {
        col = col.child(render_block(&format!("{id_prefix}-{idx}"), block, tokens));
    }
    col.into_any_element()
}

fn render_block(id: &str, block: &MdBlock, tokens: &Tokens) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let divider = to_hsla(tokens.shell_divider);

    match block {
        MdBlock::Paragraph(spans) => div()
            .w_full()
            .min_w_0()
            .text_size(px(BODY_FONT_PX))
            .line_height(px(BODY_LINE_HEIGHT_PX))
            .text_color(fg)
            .child(styled_inlines(spans, tokens))
            .into_any_element(),
        MdBlock::Heading { level, spans } => {
            let (size_px, line_px) = match level {
                1 => (18.0, 26.0),
                2 => (16.0, 24.0),
                3 => (14.5, 22.0),
                _ => (14.0, 20.0),
            };
            div()
                .w_full()
                .min_w_0()
                .pt(px(4.0))
                .text_size(px(size_px))
                .line_height(px(line_px))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(fg)
                .child(styled_inlines(spans, tokens))
                .into_any_element()
        }
        MdBlock::CodeBlock { language, code } => {
            let code_bg = to_hsla(tokens.code_background);
            let code_fg = to_hsla(tokens.code_foreground);
            let hover_bg = to_hsla(tokens.shell_highlight);
            let copy_text = code.clone();
            let header = h_flex()
                .w_full()
                .items_center()
                .justify_between()
                .px(px(12.0))
                .py(px(6.0))
                .border_b_1()
                .border_color(divider)
                .child(
                    div()
                        .text_size(px(12.0))
                        .line_height(px(16.0))
                        .text_color(muted)
                        .child(language.clone().unwrap_or_else(|| "code".to_owned())),
                )
                .child(
                    div()
                        .id(SharedString::from(format!("pr-md-copy-{id}")))
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(px(22.0))
                        .rounded(px(6.0))
                        .cursor_pointer()
                        .hover(move |s| s.bg(hover_bg))
                        .on_click(move |_, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(copy_text.clone()));
                        })
                        .child(superhero_icon("superhero/copy.svg", 13.0, muted)),
                );
            v_flex()
                .w_full()
                .min_w_0()
                .rounded(px(10.0))
                .bg(code_bg)
                .border_1()
                .border_color(divider)
                .overflow_hidden()
                .child(header)
                .child(
                    div()
                        .w_full()
                        .min_w_0()
                        .px(px(12.0))
                        .py(px(10.0))
                        .font_family(SharedString::from(MONO_FONT))
                        .text_size(px(CODE_FONT_PX))
                        .line_height(px(CODE_LINE_HEIGHT_PX))
                        .text_color(code_fg)
                        .child(code.clone()),
                )
                .into_any_element()
        }
        MdBlock::List {
            ordered,
            start,
            items,
        } => {
            let mut list = v_flex().w_full().min_w_0().gap(px(4.0));
            for (idx, item) in items.iter().enumerate() {
                let marker: AnyElement = if let Some(checked) = item.checked {
                    let color = if checked {
                        to_hsla(tokens.primary)
                    } else {
                        muted
                    };
                    div()
                        .pt(px(3.0))
                        .flex_shrink_0()
                        .child(superhero_icon(
                            if checked {
                                "superhero/check-circle.svg"
                            } else {
                                "superhero/circle.svg"
                            },
                            14.0,
                            color,
                        ))
                        .into_any_element()
                } else {
                    let bullet = if *ordered {
                        format!("{}.", start.saturating_add(u32::try_from(idx).unwrap_or(0)))
                    } else {
                        "•".to_owned()
                    };
                    div()
                        .w(px(16.0))
                        .flex_shrink_0()
                        .text_size(px(BODY_FONT_PX))
                        .line_height(px(BODY_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child(bullet)
                        .into_any_element()
                };
                list = list.child(
                    h_flex()
                        .w_full()
                        .min_w_0()
                        .items_start()
                        .gap(px(6.0))
                        .pl(px(4.0))
                        .child(marker)
                        .child(div().flex_1().min_w_0().child(render_blocks(
                            &format!("{id}-li-{idx}"),
                            &item.blocks,
                            tokens,
                        ))),
                );
            }
            list.into_any_element()
        }
        MdBlock::Blockquote(inner) => div()
            .w_full()
            .min_w_0()
            .pl(px(12.0))
            .border_l_2()
            .border_color(to_hsla(tokens.shell_divider_header))
            .text_color(muted)
            .child(render_blocks(&format!("{id}-bq"), inner, tokens))
            .into_any_element(),
        MdBlock::Table { headers, rows } => {
            let mut table = v_flex()
                .w_full()
                .min_w_0()
                .rounded(px(8.0))
                .border_1()
                .border_color(divider)
                .overflow_hidden();
            if !headers.is_empty() {
                let mut header_row = h_flex()
                    .w_full()
                    .bg(chrome::alpha(tokens.foreground, 0.04))
                    .border_b_1()
                    .border_color(divider);
                for cell in headers {
                    header_row = header_row.child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .px(px(10.0))
                            .py(px(6.0))
                            .text_size(px(13.0))
                            .line_height(px(18.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(fg)
                            .child(styled_inlines(cell, tokens)),
                    );
                }
                table = table.child(header_row);
            }
            for (r_idx, row) in rows.iter().enumerate() {
                let mut tr = h_flex().w_full();
                if r_idx + 1 < rows.len() {
                    tr = tr.border_b_1().border_color(divider);
                }
                for cell in row {
                    tr = tr.child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .px(px(10.0))
                            .py(px(6.0))
                            .text_size(px(13.0))
                            .line_height(px(18.0))
                            .text_color(fg)
                            .child(styled_inlines(cell, tokens)),
                    );
                }
                table = table.child(tr);
            }
            table.into_any_element()
        }
        MdBlock::ThematicBreak => div()
            .w_full()
            .h(px(1.0))
            .my(px(4.0))
            .bg(divider)
            .into_any_element(),
    }
}

fn styled_inlines(spans: &[InlineSpan], tokens: &Tokens) -> StyledText {
    let mut text = String::new();
    let mut highlights: Vec<(Range<usize>, HighlightStyle)> = Vec::new();
    let inline_code_bg = to_hsla(tokens.foreground.with_alpha(0.10));
    let link_color = to_hsla(tokens.primary);

    for span in spans {
        let start = text.len();
        text.push_str(&span.text);
        let end = text.len();
        let s = span.style;
        if s.bold || s.italic || s.code || s.strikethrough || s.link {
            let mut hs = HighlightStyle::default();
            if s.bold {
                hs.font_weight = Some(FontWeight::SEMIBOLD);
            }
            if s.italic {
                hs.font_style = Some(FontStyle::Italic);
            }
            if s.code {
                hs.background_color = Some(inline_code_bg);
            }
            if s.strikethrough {
                hs.strikethrough = Some(gpui_kit::StrikethroughStyle {
                    thickness: px(1.0),
                    color: None,
                });
            }
            if s.link {
                hs.color = Some(link_color);
                hs.underline = Some(UnderlineStyle {
                    thickness: px(1.0),
                    color: Some(link_color),
                    wavy: false,
                });
            }
            highlights.push((start..end, hs));
        }
    }

    StyledText::new(text).with_highlights(highlights)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_headings_lists_code_and_ignores_html_comments() {
        let md =
            "<!-- hidden -->\n## Summary\n\n- [x] Done\n- [ ] Todo\n\n```rust\nfn main() {}\n```";
        let blocks = parse_markdown(md);
        assert_eq!(blocks.len(), 3, "heading + list + code block");
        assert!(matches!(blocks[0], MdBlock::Heading { level: 2, .. }));
        assert!(matches!(blocks[1], MdBlock::List { .. }));
        assert!(matches!(blocks[2], MdBlock::CodeBlock { .. }));
    }
}
