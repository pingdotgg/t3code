//! Markdown-to-blocks parser (via `markdown::to_mdast`), syntect syntax highlighting,
//! and GPUI rendering styled to match Conn's `ChatMarkdown` and `MarkdownCodeBlock`.

use std::collections::HashSet;
use std::fmt;
use std::ops::Range;
use std::rc::Rc;
use std::sync::LazyLock;

use conn_theme::{Appearance, Tokens};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, ClipboardItem, FontStyle, FontWeight, HighlightStyle, Hsla,
    InteractiveElement, InteractiveText, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, StyledText, UnderlineStyle, Window, div, px,
};
use markdown::mdast::Node;
use syntect::parsing::{ParseState, Scope, ScopeStack, SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;

use super::color::{SyntaxRole, hsla, hsla_alpha, prose_foreground};
use super::icons;

/// Body text size matching Conn's `text-sm` (`14px`) with relaxed (`1.625`) leading.
const BODY_FONT_PX: f32 = 14.0;
const BODY_LINE_HEIGHT_PX: f32 = 22.75;
/// Vertical spacing between Markdown blocks matching `.chat-markdown` (`0.65rem`).
const BLOCK_GAP_PX: f32 = 10.4;
/// Rounded corners for fenced code blocks matching Conn's `--radius-bubble` (`calc(0.5rem + 6px)`).
const CODE_BLOCK_RADIUS_PX: f32 = 14.0;
/// Monospace code size inside fenced blocks (`leading-1.625`).
const CODE_FONT_PX: f32 = 12.5;
const CODE_LINE_HEIGHT_PX: f32 = 20.3;
const MONO_FONT_FAMILY: &str = crate::theme::MONO_FONT;

static SYNTAX_SET: LazyLock<SyntaxSet> = LazyLock::new(SyntaxSet::load_defaults_newlines);

/// Inline text styling flags accumulated during AST traversal.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct InlineStyle {
    pub(super) bold: bool,
    pub(super) italic: bool,
    pub(super) code: bool,
    pub(super) strikethrough: bool,
}

/// A single styled span inside a paragraph, heading, list item, or table cell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct InlineSpan {
    pub(super) text: String,
    pub(super) style: InlineStyle,
    pub(super) link: Option<String>,
}

/// A highlighted byte range inside a fenced code block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct SyntaxSpan {
    pub(super) range: Range<usize>,
    pub(super) role: SyntaxRole,
}

/// One item in an ordered or unordered list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ListItem {
    pub(super) checked: Option<bool>,
    pub(super) blocks: Vec<MarkdownBlock>,
}

/// Heading size and weight treatment for a Markdown container.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum HeadingStyle {
    /// Standard `.chat-markdown` scale (`h1` 20px, `h2` 18px, `h3` 16px, `h4`–`h6` 14px, semibold).
    #[default]
    Scale,
    /// Body-sized headings (`14px`, medium weight), matching Conn's `TaskDetail.tsx` brief wrapper
    /// (`[&_:is(h1,h2,h3,h4,h5,h6)]:text-sm! [&_:is(h1,h2,h3,h4,h5,h6)]:font-medium!`).
    BodySize,
}

/// A quieter body for one block of Markdown: the colour, and the size when set, of Conn's
/// `**:text-muted-foreground` and `text-xs text-foreground/70` wrappers around `ChatMarkdown`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ProseStyle {
    pub(crate) color: Hsla,
    /// Font size and line height in px; the body's when `None`.
    pub(crate) size: Option<(f32, f32)>,
}

/// Per-context rendering options for [`render_blocks`] and [`render_markdown`].
#[derive(Default)]
pub(crate) struct MarkdownOptions<'a> {
    /// Overrides the colour (and size) of prose, headings and inline code.
    pub(crate) prose: Option<ProseStyle>,
    /// Heading typography style.
    pub(crate) heading_style: HeadingStyle,
    /// Block id of the code block most recently copied, to show check feedback.
    pub(crate) copied_code_key: Option<&'a str>,
    /// Optional notification invoked after a code block's copy button writes to the clipboard.
    pub(crate) on_copy_code: Option<Rc<dyn Fn(String, &mut Window, &mut App)>>,
    /// Set of code block ids currently toggled to soft-wrap lines.
    pub(crate) wrapped_code_keys: Option<&'a HashSet<String>>,
    /// Optional callback invoked when a code block's wrap-lines toggle button is clicked.
    pub(crate) on_toggle_wrap_code: Option<Rc<dyn Fn(String, &mut Window, &mut App)>>,
    /// Active workspace root for resolving clicked `file://` links or inline-code file paths.
    pub(crate) workspace_root: Option<&'a str>,
    /// Optional callback invoked when a user clicks a workspace file link or inline file path.
    pub(crate) on_open_file: Option<Rc<dyn Fn(String, &mut Window, &mut App)>>,
}

impl MarkdownOptions<'_> {
    fn prose_color(&self, tokens: &Tokens) -> Hsla {
        self.prose
            .map_or_else(|| prose_foreground(tokens), |prose| prose.color)
    }

    fn body_size(&self) -> (f32, f32) {
        self.prose
            .and_then(|prose| prose.size)
            .unwrap_or((BODY_FONT_PX, BODY_LINE_HEIGHT_PX))
    }
}

impl fmt::Debug for MarkdownOptions<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MarkdownOptions")
            .field("heading_style", &self.heading_style)
            .field("copied_code_key", &self.copied_code_key)
            .field("has_on_copy_code", &self.on_copy_code.is_some())
            .field(
                "has_on_toggle_wrap_code",
                &self.on_toggle_wrap_code.is_some(),
            )
            .field("has_on_open_file", &self.on_open_file.is_some())
            .finish()
    }
}

/// Block-level AST node ready for GPUI rendering and unit testing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum MarkdownBlock {
    Paragraph(Vec<InlineSpan>),
    Heading {
        level: u8,
        spans: Vec<InlineSpan>,
    },
    CodeBlock {
        language: Option<String>,
        code: String,
        highlights: Vec<SyntaxSpan>,
    },
    List {
        ordered: bool,
        start: u32,
        items: Vec<ListItem>,
    },
    Blockquote(Vec<MarkdownBlock>),
    Table {
        headers: Vec<Vec<InlineSpan>>,
        rows: Vec<Vec<Vec<InlineSpan>>>,
    },
    ThematicBreak,
}

/// Parses GitHub-flavored Markdown into a list of render-ready [`MarkdownBlock`]s.
pub(super) fn parse_markdown(src: &str) -> Vec<MarkdownBlock> {
    if src.trim().is_empty() {
        return Vec::new();
    }
    let Ok(root) = markdown::to_mdast(src, &markdown::ParseOptions::gfm()) else {
        return vec![MarkdownBlock::Paragraph(vec![InlineSpan {
            text: src.to_owned(),
            style: InlineStyle::default(),
            link: None,
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

fn collect_block(node: &Node, out: &mut Vec<MarkdownBlock>) {
    match node {
        Node::Paragraph(p) => {
            let spans = collect_inlines(&p.children, InlineStyle::default(), None);
            if !spans.is_empty() {
                out.push(MarkdownBlock::Paragraph(spans));
            }
        }
        Node::Heading(h) => {
            let spans = collect_inlines(&h.children, InlineStyle::default(), None);
            if !spans.is_empty() {
                out.push(MarkdownBlock::Heading {
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
            let highlights = language
                .as_deref()
                .map(|lang| highlight_code_spans(lang, &c.value))
                .unwrap_or_default();
            out.push(MarkdownBlock::CodeBlock {
                language,
                code: c.value.clone(),
                highlights,
            });
        }
        Node::List(list) => {
            let mut items = Vec::with_capacity(list.children.len());
            for child in &list.children {
                if let Node::ListItem(item) = child {
                    let mut item_blocks = Vec::new();
                    for inner in &item.children {
                        collect_block(inner, &mut item_blocks);
                    }
                    items.push(ListItem {
                        checked: item.checked,
                        blocks: item_blocks,
                    });
                }
            }
            out.push(MarkdownBlock::List {
                ordered: list.ordered,
                start: list.start.unwrap_or(1),
                items,
            });
        }
        Node::Blockquote(bq) => {
            let mut inner_blocks = Vec::new();
            for child in &bq.children {
                collect_block(child, &mut inner_blocks);
            }
            if !inner_blocks.is_empty() {
                out.push(MarkdownBlock::Blockquote(inner_blocks));
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
                        .filter_map(|cell_node| match cell_node {
                            Node::TableCell(cell) => Some(collect_inlines(
                                &cell.children,
                                InlineStyle::default(),
                                None,
                            )),
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
                out.push(MarkdownBlock::Table { headers, rows });
            }
        }
        Node::ThematicBreak(_) => out.push(MarkdownBlock::ThematicBreak),
        Node::Html(html) => {
            let trimmed = html.value.trim();
            if !trimmed.is_empty() && !(trimmed.starts_with("<!--") && trimmed.ends_with("-->")) {
                out.push(MarkdownBlock::Paragraph(vec![InlineSpan {
                    text: trimmed.to_owned(),
                    style: InlineStyle::default(),
                    link: None,
                }]));
            }
        }
        _ => {}
    }
}

fn collect_inlines(nodes: &[Node], style: InlineStyle, link: Option<&str>) -> Vec<InlineSpan> {
    let mut out = Vec::new();
    for node in nodes {
        collect_inline(node, style, link, &mut out);
    }
    out
}

fn collect_inline(node: &Node, style: InlineStyle, link: Option<&str>, out: &mut Vec<InlineSpan>) {
    match node {
        Node::Text(t) => push_span(out, &t.value, style, link),
        Node::InlineCode(c) => {
            let mut code_style = style;
            code_style.code = true;
            push_span(out, &c.value, code_style, link);
        }
        Node::Strong(s) => {
            let mut next = style;
            next.bold = true;
            for child in &s.children {
                collect_inline(child, next, link, out);
            }
        }
        Node::Emphasis(e) => {
            let mut next = style;
            next.italic = true;
            for child in &e.children {
                collect_inline(child, next, link, out);
            }
        }
        Node::Delete(d) => {
            let mut next = style;
            next.strikethrough = true;
            for child in &d.children {
                collect_inline(child, next, link, out);
            }
        }
        Node::Link(l) => {
            let href = Some(l.url.as_str());
            for child in &l.children {
                collect_inline(child, style, href, out);
            }
        }
        Node::Image(img) => {
            let label = if img.alt.is_empty() {
                img.url.as_str()
            } else {
                img.alt.as_str()
            };
            push_span(out, &format!("[{label}]"), style, Some(img.url.as_str()));
        }
        Node::Break(_) => push_span(out, "\n", style, link),
        Node::Html(h) => {
            let trimmed = h.value.trim();
            if !(trimmed.starts_with("<!--") && trimmed.ends_with("-->")) {
                push_span(out, &h.value, style, link);
            }
        }
        Node::InlineMath(m) => {
            let mut code_style = style;
            code_style.code = true;
            push_span(out, &m.value, code_style, link);
        }
        _ => {
            if let Some(children) = node.children() {
                for child in children {
                    collect_inline(child, style, link, out);
                }
            }
        }
    }
}

fn push_span(out: &mut Vec<InlineSpan>, text: &str, style: InlineStyle, link: Option<&str>) {
    if text.is_empty() {
        return;
    }
    if let Some(last) = out.last_mut()
        && last.style == style
        && last.link.as_deref() == link
        && !style.code
    {
        last.text.push_str(text);
        return;
    }
    out.push(InlineSpan {
        text: text.to_owned(),
        style,
        link: link.map(ToOwned::to_owned),
    });
}

/// Runs syntect over `code` for `language` and returns non-overlapping [`SyntaxSpan`]s.
pub(super) fn highlight_code_spans(language: &str, code: &str) -> Vec<SyntaxSpan> {
    let Some(syntax) = find_syntax(language) else {
        return Vec::new();
    };
    let mut parser = ParseState::new(syntax);
    let mut scopes = ScopeStack::new();
    let mut spans: Vec<SyntaxSpan> = Vec::new();
    let mut offset = 0usize;

    for line in LinesWithEndings::from(code) {
        let Ok(ops) = parser.parse_line(line, &SYNTAX_SET) else {
            offset += line.len();
            continue;
        };
        let mut cursor = 0usize;
        for (pos, op) in ops {
            let pos = pos.min(line.len());
            if pos > cursor {
                let role = scope_role(&scopes);
                if role != SyntaxRole::Plain {
                    push_syntax_span(&mut spans, (offset + cursor)..(offset + pos), role);
                }
                cursor = pos;
            }
            let _ = scopes.apply(&op);
        }
        if cursor < line.len() {
            let role = scope_role(&scopes);
            if role != SyntaxRole::Plain {
                push_syntax_span(&mut spans, (offset + cursor)..(offset + line.len()), role);
            }
        }
        offset += line.len();
    }
    spans
}

fn push_syntax_span(spans: &mut Vec<SyntaxSpan>, range: Range<usize>, role: SyntaxRole) {
    if range.is_empty() {
        return;
    }
    if let Some(last) = spans.last_mut()
        && last.range.end == range.start
        && last.role == role
    {
        last.range.end = range.end;
        return;
    }
    spans.push(SyntaxSpan { range, role });
}

fn find_syntax(language: &str) -> Option<&'static SyntaxReference> {
    let lower = language.trim().to_ascii_lowercase();
    let token = match lower.as_str() {
        "" | "text" | "txt" | "plain" | "plaintext" => return None,
        "ts" | "tsx" | "typescript" => "js",
        "sh" | "zsh" | "shell" => "bash",
        "yml" => "yaml",
        "rs" => "rust",
        "py" => "python",
        "rb" => "ruby",
        "cs" | "csharp" => "c#",
        other => other,
    };
    SYNTAX_SET
        .find_syntax_by_token(token)
        .or_else(|| SYNTAX_SET.find_syntax_by_token(&lower))
        .filter(|s| s.name != "Plain Text")
}

fn scope_role(stack: &ScopeStack) -> SyntaxRole {
    for scope in stack.scopes.iter().rev() {
        let role = classify_scope(*scope);
        if role != SyntaxRole::Plain {
            return role;
        }
    }
    SyntaxRole::Plain
}

fn classify_scope(scope: Scope) -> SyntaxRole {
    let name = scope.build_string();
    if name.starts_with("comment") {
        SyntaxRole::Comment
    } else if name.starts_with("string") {
        SyntaxRole::String
    } else if name.starts_with("keyword.operator") {
        SyntaxRole::Operator
    } else if name.starts_with("keyword") || name.starts_with("storage") {
        SyntaxRole::Keyword
    } else if name.starts_with("entity.name.function") || name.starts_with("support.function") {
        SyntaxRole::Function
    } else if name.starts_with("entity.name.type")
        || name.starts_with("entity.name.struct")
        || name.starts_with("entity.name.enum")
        || name.starts_with("support.type")
    {
        SyntaxRole::Type
    } else if name.starts_with("constant.numeric") {
        SyntaxRole::Number
    } else if name.starts_with("constant.language") || name.starts_with("constant.character") {
        SyntaxRole::Constant
    } else {
        SyntaxRole::Plain
    }
}

/// Parses and renders GitHub-flavored Markdown into a GPUI element styled like Conn's
/// `ChatMarkdown`.
pub(crate) fn render_markdown(
    entry_id: &str,
    src: &str,
    tokens: &Tokens,
    options: &MarkdownOptions<'_>,
) -> AnyElement {
    let blocks = parse_markdown(src);
    render_blocks(entry_id, &blocks, tokens, options)
}

/// Renders a slice of [`MarkdownBlock`]s styled like Conn's `ChatMarkdown`.
pub(super) fn render_blocks(
    entry_id: &str,
    blocks: &[MarkdownBlock],
    tokens: &Tokens,
    options: &MarkdownOptions<'_>,
) -> AnyElement {
    let mut container = div()
        .flex()
        .flex_col()
        .gap(px(BLOCK_GAP_PX))
        .w_full()
        .min_w_0();
    for (idx, block) in blocks.iter().enumerate() {
        let block_id = format!("{entry_id}-b{idx}");
        container = container.child(render_block(&block_id, block, idx == 0, tokens, options));
    }
    container.into_any_element()
}

fn render_block(
    block_id: &str,
    block: &MarkdownBlock,
    is_first: bool,
    tokens: &Tokens,
    options: &MarkdownOptions<'_>,
) -> AnyElement {
    match block {
        MarkdownBlock::Paragraph(spans) => {
            let (font_px, line_px) = options.body_size();
            div()
                .w_full()
                .min_w_0()
                .text_size(px(font_px))
                .line_height(px(line_px))
                .text_color(options.prose_color(tokens))
                .child(render_inline_spans(block_id, spans, tokens, options))
                .into_any_element()
        }

        MarkdownBlock::Heading { level, spans } => {
            let (font_px, line_px, weight, text_color) = match options.heading_style {
                HeadingStyle::Scale => {
                    let (font, line, color) = match level {
                        1 => (20.0, 26.0, hsla(tokens.foreground)),
                        2 => (18.0, 23.4, hsla(tokens.foreground)),
                        3 => (16.0, 20.8, hsla(tokens.foreground)),
                        6 => (14.0, 18.2, hsla(tokens.muted_foreground)),
                        _ => (14.0, 18.2, hsla(tokens.foreground)),
                    };
                    (font, line, FontWeight::SEMIBOLD, color)
                }
                HeadingStyle::BodySize => {
                    let color = if *level == 6 {
                        hsla(tokens.muted_foreground)
                    } else {
                        hsla(tokens.foreground)
                    };
                    (BODY_FONT_PX, 18.2, FontWeight::MEDIUM, color)
                }
            };
            let mut el = div()
                .w_full()
                .min_w_0()
                .text_size(px(font_px))
                .line_height(px(line_px))
                .font_weight(weight)
                .text_color(options.prose.map_or(text_color, |prose| prose.color))
                .child(render_inline_spans(block_id, spans, tokens, options));
            if !is_first {
                // `.chat-markdown h1..h6 { margin: 1.25rem 0 0.5rem }` (20px top total with 10.4px gap).
                el = el.pt(px(9.6));
            }
            el.into_any_element()
        }

        MarkdownBlock::CodeBlock {
            language,
            code,
            highlights,
        } => render_code_block(
            block_id,
            language.as_deref(),
            code,
            highlights,
            tokens,
            options,
        ),

        MarkdownBlock::List {
            ordered,
            start,
            items,
        } => {
            // `.chat-markdown li + li { margin-top: 0.25rem }` (4px).
            let mut list_el = div().flex().flex_col().gap(px(4.0)).w_full().min_w_0();
            for (idx, item) in items.iter().enumerate() {
                let mut body = div().flex().flex_col().gap(px(4.0)).flex_1().min_w_0();
                for (b_idx, inner) in item.blocks.iter().enumerate() {
                    let inner_id = format!("{block_id}-i{idx}-{b_idx}");
                    body = body.child(render_block(&inner_id, inner, b_idx == 0, tokens, options));
                }

                let row = if let Some(checked) = item.checked {
                    div()
                        .flex()
                        .flex_row()
                        .items_start()
                        .gap(px(6.0))
                        .w_full()
                        .min_w_0()
                        .child(
                            div()
                                .flex_none()
                                .min_w(px(16.0))
                                .text_size(px(BODY_FONT_PX))
                                .line_height(px(BODY_LINE_HEIGHT_PX))
                                .text_color(hsla(tokens.muted_foreground))
                                .child(if checked { "☑" } else { "☐" }),
                        )
                        .child(body)
                } else if *ordered {
                    div()
                        .flex()
                        .flex_row()
                        .items_start()
                        .gap(px(6.0))
                        .w_full()
                        .min_w_0()
                        .child(
                            div()
                                .flex_none()
                                .min_w(px(18.0))
                                .text_size(px(BODY_FONT_PX))
                                .line_height(px(BODY_LINE_HEIGHT_PX))
                                .text_color(hsla(tokens.muted_foreground))
                                .child(format!("{}.", start.saturating_add(idx as u32))),
                        )
                        .child(body)
                } else {
                    // Conn `.chat-markdown > ul > li`: 5px circle sitting 1px from the paragraph
                    // edge, vertically centered on the first line, item text hanging at 16px.
                    div()
                        .flex()
                        .flex_row()
                        .items_start()
                        .w_full()
                        .min_w_0()
                        .child(
                            div()
                                .flex_none()
                                .w(px(16.0))
                                .pl(px(1.0))
                                .pt(px((BODY_LINE_HEIGHT_PX - 5.0) * 0.5))
                                .child(
                                    div()
                                        .size(px(5.0))
                                        .rounded_full()
                                        .bg(hsla_alpha(tokens.foreground, 0.85)),
                                ),
                        )
                        .child(body)
                };
                list_el = list_el.child(row);
            }
            list_el.into_any_element()
        }

        MarkdownBlock::Blockquote(inner) => {
            // `.chat-markdown blockquote`: 2px left border at 35% currentColor, 0.8rem (12.8px) inset.
            let mut inner_col = div()
                .flex()
                .flex_col()
                .gap(px(6.0))
                .w_full()
                .min_w_0()
                .pl(px(12.8))
                .border_l_2()
                .border_color(hsla_alpha(tokens.foreground, 0.35))
                .text_color(options.prose_color(tokens));
            for (idx, b) in inner.iter().enumerate() {
                let inner_id = format!("{block_id}-q{idx}");
                inner_col = inner_col.child(render_block(&inner_id, b, idx == 0, tokens, options));
            }
            inner_col.into_any_element()
        }

        MarkdownBlock::Table { headers, rows } => {
            render_table(block_id, headers, rows, tokens, options)
        }

        MarkdownBlock::ThematicBreak => {
            let hr_color = match tokens.appearance {
                Appearance::Dark => hsla(tokens.muted_foreground),
                Appearance::Light => hsla(tokens.shell_divider),
            };
            div()
                .w_full()
                .h(px(1.0))
                .my(px(4.0))
                .bg(hr_color)
                .into_any_element()
        }
    }
}

fn render_code_block(
    block_id: &str,
    language: Option<&str>,
    code: &str,
    highlights: &[SyntaxSpan],
    tokens: &Tokens,
    options: &MarkdownOptions<'_>,
) -> AnyElement {
    let lang_label = match language {
        None | Some("text") => "Text".to_owned(),
        Some(other) => other.to_owned(),
    };
    let is_copied = options.copied_code_key == Some(block_id);
    let is_wrapped = options
        .wrapped_code_keys
        .is_some_and(|set| set.contains(block_id));
    let copy_code = code.to_owned();
    let copy_key = block_id.to_owned();
    let on_copy = options.on_copy_code.clone();
    let wrap_key = block_id.to_owned();
    let on_wrap = options.on_toggle_wrap_code.clone();

    let runs: Vec<(Range<usize>, HighlightStyle)> = highlights
        .iter()
        .filter(|span| span.range.end <= code.len())
        .map(|span| {
            (
                span.range.clone(),
                HighlightStyle {
                    color: Some(span.role.color(tokens)),
                    ..Default::default()
                },
            )
        })
        .collect();

    let styled_code = StyledText::new(SharedString::from(code.to_owned())).with_highlights(runs);

    // Conn `MarkdownCodeBlock`: icon-only `size="icon-xs"` (24px) button with 12px (`size-3`) glyph.
    let copy_btn = div()
        .id(SharedString::from(format!("copy-{block_id}")))
        .flex()
        .items_center()
        .justify_center()
        .size(px(24.0))
        .rounded(px(6.0))
        .cursor_pointer()
        .hover(|s| s.bg(hsla(tokens.shell_highlight)))
        .on_click(move |_, window, cx| {
            cx.write_to_clipboard(ClipboardItem::new_string(copy_code.clone()));
            if let Some(cb) = &on_copy {
                cb(copy_key.clone(), window, cx);
            }
        })
        .child(icons::icon(
            if is_copied { icons::CHECK } else { icons::COPY },
            12.0,
            if is_copied {
                hsla(tokens.success)
            } else {
                hsla_alpha(tokens.code_foreground, 0.72)
            },
        ));

    let lang_icon = language
        .and_then(language_sample_filename)
        .map(crate::file_icons::file_icon);
    let lang_muted = hsla_alpha(tokens.code_foreground, 0.72);
    let mut lang_header = div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .min_w_0();
    if let Some(icon) = lang_icon {
        let icon_color = icon
            .color
            .map(|c| hsla(c.for_appearance(tokens.appearance)))
            .unwrap_or(lang_muted);
        lang_header = lang_header.child(icons::icon(icon.asset, 13.0, icon_color));
    }
    lang_header = lang_header.child(
        div()
            .font_family(MONO_FONT_FAMILY)
            .text_size(px(11.0))
            .line_height(px(16.0))
            .text_color(lang_muted)
            .child(lang_label),
    );

    let mut header_actions = div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(2.0))
        .flex_shrink_0();
    if let Some(on_wrap_cb) = on_wrap {
        let wrap_color = if is_wrapped {
            hsla(tokens.code_foreground)
        } else {
            hsla_alpha(tokens.code_foreground, 0.72)
        };
        let wrap_btn = div()
            .id(SharedString::from(format!("wrap-{block_id}")))
            .flex()
            .items_center()
            .justify_center()
            .size(px(24.0))
            .rounded(px(6.0))
            .cursor_pointer()
            .hover(|s| s.bg(hsla(tokens.shell_highlight)))
            .on_click(move |_, window, cx| {
                on_wrap_cb(wrap_key.clone(), window, cx);
            })
            .child(icons::icon("superhero/wrap-lines.svg", 12.0, wrap_color));
        header_actions = header_actions.child(wrap_btn);
    }
    header_actions = header_actions.child(copy_btn);

    // Conn `MarkdownCodeBlockFrame`: `rounded-bubble` (14px), no header divider,
    // `pt-1.5 pr-1.5 pb-0 pl-3` header, `0.8rem 0.9rem` code body padding.
    let border_color = match tokens.appearance {
        Appearance::Dark => hsla(tokens.border),
        Appearance::Light => hsla_alpha(tokens.border, 0.70),
    };
    div()
        .w_full()
        .min_w_0()
        .overflow_hidden()
        .rounded(px(CODE_BLOCK_RADIUS_PX))
        .bg(hsla(tokens.code_background))
        .border_1()
        .border_color(border_color)
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .pt(px(6.0))
                .pr(px(6.0))
                .pb(px(0.0))
                .pl(px(12.0))
                .child(lang_header)
                .child(header_actions),
        )
        .child(
            div()
                .id(SharedString::from(format!("code-scroll-{block_id}")))
                .w_full()
                .min_w_0()
                .px(px(14.4))
                .py(px(12.8))
                .font_family(MONO_FONT_FAMILY)
                .text_size(px(CODE_FONT_PX))
                .line_height(px(CODE_LINE_HEIGHT_PX))
                .text_color(hsla(tokens.code_foreground))
                .when(!is_wrapped, |el| el.overflow_x_scroll().whitespace_nowrap())
                .child(styled_code),
        )
        .into_any_element()
}

/// Maps a fenced code block language tag to a synthetic filename for `file_icons::file_icon`.
fn language_sample_filename(lang: &str) -> Option<&'static str> {
    match lang.trim().to_ascii_lowercase().as_str() {
        "rs" | "rust" => Some("a.rs"),
        "ts" | "typescript" => Some("a.ts"),
        "tsx" => Some("a.tsx"),
        "js" | "javascript" | "mjs" | "cjs" => Some("a.js"),
        "jsx" => Some("a.jsx"),
        "json" | "jsonc" => Some("a.json"),
        "toml" => Some("a.toml"),
        "yaml" | "yml" => Some("a.yaml"),
        "sh" | "bash" | "zsh" | "shell" | "console" => Some("a.sh"),
        "py" | "python" => Some("a.py"),
        "go" | "golang" => Some("a.go"),
        "swift" => Some("a.swift"),
        "css" => Some("a.css"),
        "scss" | "sass" => Some("a.scss"),
        "html" | "htm" => Some("a.html"),
        "xml" | "svg" => Some("a.xml"),
        "sql" | "postgres" | "postgresql" | "sqlite" | "mysql" => Some("a.sql"),
        "md" | "markdown" | "mdx" => Some("a.md"),
        "c" | "h" => Some("a.c"),
        "cpp" | "c++" | "cxx" | "cc" | "hpp" => Some("a.cpp"),
        "php" => Some("a.php"),
        "rb" | "ruby" => Some("a.rb"),
        "java" => Some("a.java"),
        "kt" | "kotlin" => Some("a.kt"),
        "dockerfile" | "docker" => Some("Dockerfile"),
        "makefile" | "make" => Some("Makefile"),
        "diff" | "patch" => Some("a.diff"),
        "zig" => Some("a.zig"),
        "lua" => Some("a.lua"),
        "graphql" | "gql" => Some("a.graphql"),
        "vue" => Some("a.vue"),
        "svelte" => Some("a.svelte"),
        _ => None,
    }
}

/// Renders Conn's diagnostics-style table: row bottom borders only, no outer card border,
/// outer columns flush with surrounding prose.
fn render_table(
    block_id: &str,
    headers: &[Vec<InlineSpan>],
    rows: &[Vec<Vec<InlineSpan>>],
    tokens: &Tokens,
    options: &MarkdownOptions<'_>,
) -> AnyElement {
    let row_border = hsla_alpha(tokens.border, 0.60);
    let mut table = div().w_full().min_w_0().flex().flex_col();

    if !headers.is_empty() {
        let col_count = headers.len();
        let mut header_row = div()
            .flex()
            .flex_row()
            .w_full()
            .border_b_1()
            .border_color(row_border);
        for (c_idx, cell) in headers.iter().enumerate() {
            let pl = if c_idx == 0 { 0.0 } else { 12.0 };
            let pr = if c_idx + 1 == col_count { 0.0 } else { 12.0 };
            header_row = header_row.child(
                div()
                    .flex_1()
                    .min_w_0()
                    .pl(px(pl))
                    .pr(px(pr))
                    .py(px(8.8))
                    .text_size(px(BODY_FONT_PX))
                    .line_height(px(20.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(options.prose_color(tokens))
                    .child(render_inline_spans(
                        &format!("{block_id}-th{c_idx}"),
                        cell,
                        tokens,
                        options,
                    )),
            );
        }
        table = table.child(header_row);
    }

    for (r_idx, row) in rows.iter().enumerate() {
        let col_count = row.len();
        let mut row_el = div()
            .flex()
            .flex_row()
            .w_full()
            .border_b_1()
            .border_color(row_border);
        for (c_idx, cell) in row.iter().enumerate() {
            let pl = if c_idx == 0 { 0.0 } else { 12.0 };
            let pr = if c_idx + 1 == col_count { 0.0 } else { 12.0 };
            row_el = row_el.child(
                div()
                    .flex_1()
                    .min_w_0()
                    .pl(px(pl))
                    .pr(px(pr))
                    .py(px(7.2))
                    .text_size(px(BODY_FONT_PX))
                    .line_height(px(20.0))
                    .text_color(options.prose_color(tokens))
                    .child(render_inline_spans(
                        &format!("{block_id}-td{r_idx}-{c_idx}"),
                        cell,
                        tokens,
                        options,
                    )),
            );
        }
        table = table.child(row_el);
    }

    table.into_any_element()
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ClickTarget {
    Url(String),
    WorkspaceFile(String),
}

/// Renders inline spans as a single continuously flowing `StyledText` (or `InteractiveText` when
/// clickable URLs or workspace file paths are present).
fn render_inline_spans(
    span_id: &str,
    spans: &[InlineSpan],
    tokens: &Tokens,
    options: &MarkdownOptions<'_>,
) -> AnyElement {
    let (styled, ranges, targets) = build_styled_text_with_targets(
        spans,
        tokens,
        options.prose.map(|prose| prose.color),
        options.workspace_root,
        options.on_open_file.is_some(),
    );
    if ranges.is_empty() {
        return styled.into_any_element();
    }
    let on_open_file = options.on_open_file.clone();
    InteractiveText::new(SharedString::from(format!("inline-{span_id}")), styled)
        .on_click(ranges, move |ix, window, cx| {
            let Some(target) = targets.get(ix) else {
                return;
            };
            match target {
                ClickTarget::Url(url) => cx.open_url(url),
                ClickTarget::WorkspaceFile(path) => {
                    if let Some(cb) = &on_open_file {
                        cb(path.clone(), window, cx);
                    }
                }
            }
        })
        .into_any_element()
}

fn build_styled_text_with_targets(
    spans: &[InlineSpan],
    tokens: &Tokens,
    prose_override: Option<Hsla>,
    workspace_root: Option<&str>,
    file_links_enabled: bool,
) -> (StyledText, Vec<Range<usize>>, Vec<ClickTarget>) {
    // Runs, not highlights: inline code switches font family (SF Mono), which a highlight
    // cannot. Every run therefore carries its own font and color.
    let prose = prose_override.unwrap_or_else(|| super::color::prose_foreground(tokens));
    let mut text = String::new();
    let mut runs: Vec<gpui_kit::TextRun> = Vec::new();
    let mut ranges: Vec<Range<usize>> = Vec::new();
    let mut targets: Vec<ClickTarget> = Vec::new();

    for span in spans {
        let start = text.len();
        if span.style.code {
            // Thin padding inside the inline-code chip background.
            text.push('\u{2009}');
            text.push_str(&span.text);
            text.push('\u{2009}');
        } else {
            text.push_str(&span.text);
        }
        let end = text.len();
        let len = end - start;
        if len == 0 {
            continue;
        }

        let target = if let Some(url) = &span.link {
            if file_links_enabled
                && let Some(rel) = resolve_clickable_file_path(url, workspace_root)
            {
                Some(ClickTarget::WorkspaceFile(rel))
            } else {
                Some(ClickTarget::Url(url.clone()))
            }
        } else if span.style.code && file_links_enabled {
            resolve_clickable_file_path(&span.text, workspace_root).map(ClickTarget::WorkspaceFile)
        } else {
            None
        };

        let is_clickable_file = matches!(target, Some(ClickTarget::WorkspaceFile(_)));
        if let Some(t) = target {
            ranges.push(start..end);
            targets.push(t);
        }

        let family = if span.style.code {
            MONO_FONT_FAMILY
        } else {
            ".SystemUIFont"
        };
        let font = gpui_kit::Font {
            family: family.into(),
            features: gpui_kit::FontFeatures::default(),
            fallbacks: None,
            weight: if span.style.bold {
                FontWeight::BOLD
            } else {
                FontWeight::NORMAL
            },
            style: if span.style.italic {
                FontStyle::Italic
            } else {
                FontStyle::Normal
            },
        };
        let (color, background_color, underline) = if span.style.code {
            let fg_color = if is_clickable_file {
                hsla(tokens.info_foreground)
            } else {
                prose_override.unwrap_or_else(|| hsla(tokens.foreground))
            };
            (
                fg_color,
                Some(hsla(tokens.foreground.with_alpha(0.10))),
                None,
            )
        } else if span.link.is_some() {
            (
                hsla(tokens.info_foreground),
                None,
                Some(UnderlineStyle {
                    thickness: px(1.0),
                    color: Some(hsla(tokens.info_foreground)),
                    wavy: false,
                }),
            )
        } else {
            (prose, None, None)
        };
        let strikethrough = span
            .style
            .strikethrough
            .then(|| gpui_kit::StrikethroughStyle {
                thickness: px(1.0),
                color: Some(hsla(tokens.muted_foreground)),
            });
        runs.push(gpui_kit::TextRun {
            len,
            font,
            color,
            background_color,
            underline,
            strikethrough,
        });
    }
    (
        StyledText::new(SharedString::from(text)).with_runs(runs),
        ranges,
        targets,
    )
}

/// Resolves a `file://` URL or inline-code token (e.g. `src/main.rs:42`, `Cargo.toml`, or
/// `/abs/workspace/src/lib.rs#L10-L20`) to a workspace-relative path when it looks like a file.
fn resolve_clickable_file_path(raw: &str, workspace_root: Option<&str>) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains(char::is_whitespace) {
        return None;
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return None;
    }

    let without_scheme = trimmed.strip_prefix("file://").unwrap_or(trimmed);
    let without_frag = without_scheme.split('#').next().unwrap_or(without_scheme);
    let candidate = strip_line_col_suffix(without_frag);
    if candidate.is_empty() || candidate.contains("..") {
        return None;
    }

    if candidate.starts_with('/') {
        let root = workspace_root?.trim_end_matches('/');
        if root.is_empty() {
            return None;
        }
        let private_root = format!("/private{root}");
        let rel = candidate
            .strip_prefix(&format!("{root}/"))
            .or_else(|| candidate.strip_prefix(&format!("{private_root}/")))?;
        return looks_like_file_path(rel).then(|| rel.to_owned());
    }

    let rel = candidate.strip_prefix("./").unwrap_or(candidate);
    looks_like_file_path(rel).then(|| rel.to_owned())
}

fn strip_line_col_suffix(path: &str) -> &str {
    let mut current = path;
    for _ in 0..2 {
        if let Some((prefix, suffix)) = current.rsplit_once(':')
            && !suffix.is_empty()
            && suffix.bytes().all(|b| b.is_ascii_digit())
        {
            current = prefix;
        } else {
            break;
        }
    }
    current
}

fn looks_like_file_path(rel: &str) -> bool {
    if rel.is_empty() || rel.ends_with('/') {
        return false;
    }
    let file_name = rel.rsplit('/').next().unwrap_or(rel);
    if matches!(
        file_name,
        "Cargo.toml"
            | "Cargo.lock"
            | "Dockerfile"
            | "Makefile"
            | "Justfile"
            | "README.md"
            | "AGENTS.md"
            | "package.json"
            | "tsconfig.json"
    ) {
        return true;
    }
    let Some((_, ext)) = file_name.rsplit_once('.') else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "rs" | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "mjs"
            | "cjs"
            | "json"
            | "toml"
            | "yaml"
            | "yml"
            | "md"
            | "mdx"
            | "css"
            | "scss"
            | "html"
            | "svg"
            | "sql"
            | "sh"
            | "zsh"
            | "py"
            | "go"
            | "swift"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "php"
            | "rb"
            | "java"
            | "kt"
            | "zig"
            | "lua"
            | "lock"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_clickable_workspace_file_paths_and_rejects_non_files() {
        assert_eq!(
            resolve_clickable_file_path("crates/conn-app/src/app.rs:42:10", Some("/repo")),
            Some("crates/conn-app/src/app.rs".to_owned())
        );
        assert_eq!(
            resolve_clickable_file_path("file:///repo/Cargo.toml#L10-L20", Some("/repo")),
            Some("Cargo.toml".to_owned())
        );
        assert_eq!(
            resolve_clickable_file_path("./src/main.rs", None),
            Some("src/main.rs".to_owned())
        );
        assert_eq!(
            resolve_clickable_file_path("https://example.com/a.rs", Some("/repo")),
            None
        );
        assert_eq!(
            resolve_clickable_file_path("cargo test", Some("/repo")),
            None
        );
        assert_eq!(
            resolve_clickable_file_path("/etc/passwd", Some("/repo")),
            None
        );
    }

    #[test]
    fn parses_headings_paragraphs_and_inline_styles() {
        let md =
            "# Title\n\nHello **world**, *italic*, and `code` with [link](https://example.com).";
        let blocks = parse_markdown(md);
        assert_eq!(blocks.len(), 2, "expected heading + paragraph");

        match &blocks[0] {
            MarkdownBlock::Heading { level, spans } => {
                assert_eq!(*level, 1, "h1 level");
                assert_eq!(spans.len(), 1, "single heading span");
                assert_eq!(spans[0].text, "Title", "heading text");
            }
            other => panic!("expected heading, got {other:?}"),
        }

        match &blocks[1] {
            MarkdownBlock::Paragraph(spans) => {
                assert!(
                    spans.iter().any(|s| s.style.bold && s.text == "world"),
                    "bold span missing: {spans:?}"
                );
                assert!(
                    spans.iter().any(|s| s.style.italic && s.text == "italic"),
                    "italic span missing: {spans:?}"
                );
                assert!(
                    spans.iter().any(|s| s.style.code && s.text == "code"),
                    "inline code span missing: {spans:?}"
                );
                assert!(
                    spans
                        .iter()
                        .any(|s| s.link.as_deref() == Some("https://example.com")
                            && s.text == "link"),
                    "link span missing: {spans:?}"
                );
            }
            other => panic!("expected paragraph, got {other:?}"),
        }
    }

    #[test]
    fn parses_fenced_code_block_with_syntect_highlights() {
        let md = "```rust\nfn main() {\n    let x = \"hi\";\n}\n```";
        let blocks = parse_markdown(md);
        assert_eq!(blocks.len(), 1, "expected single code block");
        match &blocks[0] {
            MarkdownBlock::CodeBlock {
                language,
                code,
                highlights,
            } => {
                assert_eq!(language.as_deref(), Some("rust"), "rust language tag");
                assert!(code.contains("fn main()"), "code body preserved");
                assert!(
                    !highlights.is_empty(),
                    "syntect should produce highlights for rust code"
                );
                assert!(
                    highlights.iter().any(|h| h.role == SyntaxRole::Keyword),
                    "expected keyword highlight in {highlights:?}"
                );
                assert!(
                    highlights.iter().any(|h| h.role == SyntaxRole::String),
                    "expected string highlight in {highlights:?}"
                );
            }
            other => panic!("expected code block, got {other:?}"),
        }
    }

    #[test]
    fn parses_lists_blockquotes_and_tables() {
        let md = "\
- [x] Done item
- [ ] Open item

> Quoted note

| Col A | Col B |
| ----- | ----- |
| 1     | 2     |
";
        let blocks = parse_markdown(md);
        assert_eq!(blocks.len(), 3, "expected list, blockquote, table");

        match &blocks[0] {
            MarkdownBlock::List { ordered, items, .. } => {
                assert!(!ordered, "unordered list");
                assert_eq!(items.len(), 2, "two list items");
                assert_eq!(items[0].checked, Some(true), "first item checked");
                assert_eq!(items[1].checked, Some(false), "second item unchecked");
            }
            other => panic!("expected list, got {other:?}"),
        }

        assert!(
            matches!(blocks[1], MarkdownBlock::Blockquote(_)),
            "expected blockquote at index 1"
        );

        match &blocks[2] {
            MarkdownBlock::Table { headers, rows } => {
                assert_eq!(headers.len(), 2, "two header columns");
                assert_eq!(rows.len(), 1, "one body row");
            }
            other => panic!("expected table, got {other:?}"),
        }
    }

    #[test]
    fn skips_html_comments() {
        let md = "<!-- hidden -->\n## Summary\n\nVisible <!-- inline --> text";
        let blocks = parse_markdown(md);
        assert_eq!(
            blocks.len(),
            2,
            "comment block skipped, heading + paragraph remain"
        );
        assert!(matches!(blocks[0], MarkdownBlock::Heading { level: 2, .. }));
        match &blocks[1] {
            MarkdownBlock::Paragraph(spans) => {
                let joined: String = spans.iter().map(|s| s.text.as_str()).collect();
                assert!(
                    !joined.contains("inline"),
                    "inline HTML comment stripped: {joined:?}"
                );
            }
            other => panic!("expected paragraph, got {other:?}"),
        }
    }
}
