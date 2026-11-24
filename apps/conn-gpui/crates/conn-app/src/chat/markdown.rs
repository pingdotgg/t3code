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
    InteractiveElement, InteractiveText, IntoElement, ParentElement, Role, SharedString,
    StatefulInteractiveElement, Styled, StyledText, UnderlineStyle, Window, div, px,
};
use markdown::mdast::Node;
use syntect::parsing::{ParseState, Scope, ScopeStack, SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;

use super::color::{SyntaxRole, hsla, hsla_alpha, prose_foreground};
use super::icons;
use super::inline_code::{self, Built, ChipPlan, InlineCodeText};
use super::link_preview::{LinkHoverEvent, Rect, is_previewable, link_anchor};
use crate::a11y::ConnA11yExt as _;

/// Body text size matching Conn's `text-sm` (`14px`) with relaxed (`1.625`) leading.
const BODY_FONT_PX: f32 = 14.0;
const BODY_LINE_HEIGHT_PX: f32 = 22.75;
/// Vertical spacing between Markdown blocks matching `.chat-markdown` (`0.65rem`).
const BLOCK_GAP_PX: f32 = 10.4;
/// Rounded corners for fenced code blocks matching Conn's `--radius-bubble` (`calc(0.5rem + 6px)`).
const CODE_BLOCK_RADIUS_PX: f32 = 14.0;
/// Monospace code size inside fenced blocks: web's `--font-size-code` (13px default) at
/// `--line-height-code` (1.625), so 21.125px.
const CODE_FONT_PX: f32 = 13.0;
const CODE_LINE_HEIGHT_PX: f32 = 13.0 * 1.625;
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
    pub(crate) on_open_file:
        Option<Rc<dyn Fn(conn_contract::source::SourceLocation, &mut Window, &mut App)>>,
    /// Optional callback invoked with the link and the window position when a user right-clicks a
    /// web link or a workspace file link (Conn's link and file context menus).
    pub(crate) on_link_menu: Option<LinkMenuCallback>,
    /// Optional callback invoked as the pointer moves on and off a pull request or issue link
    /// (the hover preview card).
    pub(crate) on_link_hover: Option<LinkHoverCallback>,
}

/// Tells the chat where the pointer is relative to the preview-able links of a paragraph.
pub(crate) type LinkHoverCallback = Rc<dyn Fn(LinkHoverEvent, &mut Window, &mut App)>;

/// What a right-click landed on: a web link (its URL) or a workspace file link (its
/// workspace-relative path, with a `:line` suffix when the link has one).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LinkMenuTarget {
    Web(String),
    File(String),
}

/// Opens the context menu for `target` at the window position.
pub(crate) type LinkMenuCallback =
    Rc<dyn Fn(LinkMenuTarget, gpui_kit::Point<gpui_kit::Pixels>, &mut Window, &mut App)>;

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
            .field("has_on_link_menu", &self.on_link_menu.is_some())
            .field("has_on_link_hover", &self.on_link_hover.is_some())
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

/// GPUI element id for a block's AX node. Prefixed so it never collides with other row ids.
fn md_element_id(block_id: &str, kind: &str) -> SharedString {
    SharedString::from(format!("md-{block_id}-{kind}"))
}

/// Stable AX identifier of a Markdown block: `chat.md.<entry>-b<n>[-i<item>-<n>].<kind>`,
/// for example `chat.md.<entry>-b2.code` or `chat.md.<entry>-b1.item.0`.
fn md_ax_id(block_id: &str, kind: &str) -> SharedString {
    SharedString::from(format!("chat.md.{block_id}.{kind}"))
}

fn spans_text(spans: &[InlineSpan]) -> String {
    spans.iter().map(|span| span.text.as_str()).collect()
}

/// Text of a list item's first block, for its AX label.
fn list_item_text(item: &ListItem) -> String {
    match item.blocks.first() {
        Some(MarkdownBlock::Paragraph(spans) | MarkdownBlock::Heading { spans, .. }) => {
            spans_text(spans)
        }
        _ => String::new(),
    }
}

/// One line of at most 80 characters, so an AX label stays short for long paragraphs.
fn ax_preview(text: &str) -> String {
    const MAX_CHARS: usize = 80;
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= MAX_CHARS {
        return line;
    }
    let mut out: String = line.chars().take(MAX_CHARS).collect();
    out.push('…');
    out
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
                .id(md_element_id(block_id, "paragraph"))
                .a11y(
                    Role::Paragraph,
                    md_ax_id(block_id, "paragraph"),
                    format!("Paragraph: {}", ax_preview(&spans_text(spans))),
                )
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
                .id(md_element_id(block_id, "heading"))
                .a11y(
                    Role::Heading,
                    md_ax_id(block_id, "heading"),
                    format!("Heading level {level}: {}", ax_preview(&spans_text(spans))),
                )
                .aria_level(usize::from(*level))
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
            let mut list_el = div()
                .id(md_element_id(block_id, "list"))
                .a11y(
                    Role::List,
                    md_ax_id(block_id, "list"),
                    format!(
                        "{} list, {} {}",
                        if *ordered { "Numbered" } else { "Bulleted" },
                        items.len(),
                        if items.len() == 1 { "item" } else { "items" }
                    ),
                )
                .flex()
                .flex_col()
                .gap(px(4.0))
                .w_full()
                .min_w_0();
            for (idx, item) in items.iter().enumerate() {
                let item_kind = format!("item.{idx}");
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
                let row = row
                    .id(md_element_id(block_id, &item_kind))
                    .a11y(
                        Role::ListItem,
                        md_ax_id(block_id, &item_kind),
                        format!(
                            "List item {}: {}",
                            idx + 1,
                            ax_preview(&list_item_text(item))
                        ),
                    )
                    .aria_position_in_set(idx + 1)
                    .aria_size_of_set(items.len());
                list_el = list_el.child(row);
            }
            list_el.into_any_element()
        }

        MarkdownBlock::Blockquote(inner) => {
            // `.chat-markdown blockquote`: 2px left border at 35% currentColor, 0.8rem (12.8px) inset.
            let mut inner_col = div()
                .id(md_element_id(block_id, "quote"))
                .a11y(Role::Blockquote, md_ax_id(block_id, "quote"), "Block quote")
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
        .a11y_button(md_ax_id(block_id, "code.copy"), "Copy code")
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
            .a11y_button(md_ax_id(block_id, "code.wrap"), "Toggle word wrap")
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
        .id(md_element_id(block_id, "code"))
        .a11y(
            Role::Code,
            md_ax_id(block_id, "code"),
            match language {
                None | Some("text") | Some("") => "Code block".to_owned(),
                Some(lang) => format!("Code block ({lang})"),
            },
        )
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
    let column_count = headers
        .len()
        .max(rows.iter().map(Vec::len).max().unwrap_or(0));
    let mut table = div()
        .id(md_element_id(block_id, "table"))
        .a11y(
            Role::Table,
            md_ax_id(block_id, "table"),
            format!(
                "Table, {} {}, {} {}",
                rows.len(),
                if rows.len() == 1 { "row" } else { "rows" },
                column_count,
                if column_count == 1 {
                    "column"
                } else {
                    "columns"
                }
            ),
        )
        .w_full()
        .min_w_0()
        .flex()
        .flex_col();

    if !headers.is_empty() {
        let col_count = headers.len();
        let mut header_row = div()
            .id(md_element_id(block_id, "row.header"))
            .a11y(Role::Row, md_ax_id(block_id, "row.header"), "Header row")
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
            .id(md_element_id(block_id, &format!("row.{r_idx}")))
            .a11y(
                Role::Row,
                md_ax_id(block_id, &format!("row.{r_idx}")),
                format!("Row {}", r_idx + 1),
            )
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
    WorkspaceFile(conn_contract::source::SourceLocation),
}

/// Renders inline spans as a single continuously flowing `StyledText` (or `InteractiveText` when
/// clickable URLs or workspace file paths are present). Paragraphs with inline code draw each
/// code span as Conn's chip (see `inline_code`).
fn render_inline_spans(
    span_id: &str,
    spans: &[InlineSpan],
    tokens: &Tokens,
    options: &MarkdownOptions<'_>,
) -> AnyElement {
    let prose = options.prose.map(|prose| prose.color);
    let workspace_root = options.workspace_root.map(str::to_owned);
    let on_open_file = options.on_open_file.clone();
    let callbacks = LinkCallbacks {
        on_open_file: options.on_open_file.clone(),
        on_link_menu: options.on_link_menu.clone(),
        on_link_hover: options.on_link_hover.clone(),
    };
    if spans.iter().any(|span| span.style.code) {
        let spans = spans.to_vec();
        let owned_tokens = tokens.clone();
        let span_id = span_id.to_owned();
        let background = hsla(tokens.foreground.with_alpha(0.10));
        return InlineCodeText::new(background, move |window| {
            let (styled, ranges, targets, chips) = build_styled_text_with_targets(
                &spans,
                &owned_tokens,
                prose,
                workspace_root.as_deref(),
                on_open_file.is_some(),
                Some(window),
            );
            let layout = styled.layout().clone();
            let inner = interactive_inline_text(
                &span_id,
                styled,
                ranges,
                targets,
                callbacks.clone(),
                layout.clone(),
            );
            Built {
                inner,
                layout,
                chips,
            }
        })
        .into_any_element();
    }
    let (styled, ranges, targets, _) = build_styled_text_with_targets(
        spans,
        tokens,
        prose,
        options.workspace_root,
        on_open_file.is_some(),
        None,
    );
    let layout = styled.layout().clone();
    interactive_inline_text(span_id, styled, ranges, targets, callbacks, layout)
}

/// What a paragraph tells the chat about its links.
#[derive(Clone)]
struct LinkCallbacks {
    on_open_file: Option<Rc<dyn Fn(conn_contract::source::SourceLocation, &mut Window, &mut App)>>,
    on_link_menu: Option<LinkMenuCallback>,
    on_link_hover: Option<LinkHoverCallback>,
}

/// `styled`, made clickable over `ranges` (URLs and workspace file paths) when there are any. A
/// right-click on a web link or a workspace file link asks `on_link_menu` for its menu. The
/// pointer over a pull request or issue link goes to `on_link_hover` (the preview card).
fn interactive_inline_text(
    span_id: &str,
    styled: StyledText,
    ranges: Vec<Range<usize>>,
    targets: Vec<ClickTarget>,
    callbacks: LinkCallbacks,
    layout: gpui_kit::TextLayout,
) -> AnyElement {
    if ranges.is_empty() {
        return styled.into_any_element();
    }
    let LinkCallbacks {
        on_open_file,
        on_link_menu,
        on_link_hover,
    } = callbacks;
    let menu_targets = menu_targets(&ranges, &targets);
    let hover_links: Rc<Vec<(Range<usize>, String)>> = Rc::new(if on_link_hover.is_some() {
        hover_targets(&ranges, &targets)
    } else {
        Vec::new()
    });
    let text = InteractiveText::new(SharedString::from(format!("inline-{span_id}")), styled)
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
        });
    // Capture phase: `InteractiveText` records a press of any button and opens the link on
    // release, so a right-click on a link must stop before the text sees it. Without a menu
    // callback (the question panel, task details) the right-click does nothing.
    //
    // Hover: `InteractiveText::on_hover` is not used. It runs only while the pointer is over a
    // glyph of the text and never reports the pointer leaving the element, so a card would stay
    // open. The wrapper reads every mouse move the same way the right-click handler does (the
    // byte under the pointer, from the text layout) and `on_hover(false)` ends it on leaving.
    let press_layout = layout.clone();
    let press_links = hover_links.clone();
    let press_hover = on_link_hover.clone();
    let mut wrapper = div()
        .id(SharedString::from(format!("inline-links-{span_id}")))
        .capture_any_mouse_down(move |event, window, cx| {
            let Ok(index) = press_layout.index_for_position(event.position) else {
                return;
            };
            if event.button != gpui_kit::MouseButton::Right {
                // A press on a pull request or issue link opens it: the card gives way.
                if let Some(on_hover) = &press_hover
                    && hover_link_at(&press_links, index).is_some()
                {
                    on_hover(LinkHoverEvent::Press, window, cx);
                }
                return;
            }
            if let Some(target) = link_at(&menu_targets, index) {
                cx.stop_propagation();
                if let Some(on_link_menu) = &on_link_menu {
                    on_link_menu(target.clone(), event.position, window, cx);
                }
            }
        });
    if let Some(on_hover) = on_link_hover
        && !hover_links.is_empty()
    {
        let source = span_id.to_owned();
        let move_hover = on_hover.clone();
        let move_source = source.clone();
        wrapper = wrapper
            .on_mouse_move(move |event, window, cx| {
                let found = layout
                    .index_for_position(event.position)
                    .ok()
                    .and_then(|index| hover_link_at(&hover_links, index));
                let Some((range, url)) = found else {
                    move_hover(
                        LinkHoverEvent::Leave {
                            source: move_source.clone(),
                        },
                        window,
                        cx,
                    );
                    return;
                };
                let corner = |index: usize| {
                    layout
                        .position_for_index(index)
                        .map(|p| (f32::from(p.x), f32::from(p.y)))
                };
                let bounds = layout.bounds();
                let text = Rect {
                    x: f32::from(bounds.origin.x),
                    y: f32::from(bounds.origin.y),
                    w: f32::from(bounds.size.width),
                    h: f32::from(bounds.size.height),
                };
                let anchor = link_anchor(
                    corner(range.start),
                    corner(range.end),
                    f32::from(layout.line_height()),
                    (f32::from(event.position.x), f32::from(event.position.y)),
                    text,
                );
                move_hover(
                    LinkHoverEvent::Enter {
                        source: move_source.clone(),
                        url: url.clone(),
                        anchor,
                    },
                    window,
                    cx,
                );
            })
            .on_hover(move |hovered, window, cx| {
                if !*hovered {
                    on_hover(
                        LinkHoverEvent::Leave {
                            source: source.clone(),
                        },
                        window,
                        cx,
                    );
                }
            });
    }
    wrapper.child(text).into_any_element()
}

/// The pull request and issue links that get a hover card: the click targets that are URLs
/// `link_preview` can read.
fn hover_targets(ranges: &[Range<usize>], targets: &[ClickTarget]) -> Vec<(Range<usize>, String)> {
    ranges
        .iter()
        .zip(targets)
        .filter_map(|(range, target)| match target {
            ClickTarget::Url(url) if is_previewable(url) => Some((range.clone(), url.clone())),
            ClickTarget::Url(_) | ClickTarget::WorkspaceFile(_) => None,
        })
        .collect()
}

/// The hover link whose text covers byte `index` of the paragraph.
fn hover_link_at(
    links: &[(Range<usize>, String)],
    index: usize,
) -> Option<&(Range<usize>, String)> {
    links.iter().find(|(range, _)| range.contains(&index))
}

/// The links that open a context menu on a right-click: every click target, web link or
/// workspace file, so none of them falls through to its left-click action.
fn menu_targets(
    ranges: &[Range<usize>],
    targets: &[ClickTarget],
) -> Vec<(Range<usize>, LinkMenuTarget)> {
    ranges
        .iter()
        .zip(targets)
        .map(|(range, target)| {
            let target = match target {
                ClickTarget::Url(url) => LinkMenuTarget::Web(url.clone()),
                ClickTarget::WorkspaceFile(location) => {
                    LinkMenuTarget::File(match location.lines {
                        Some(lines) => format!("{}:{}", location.path, lines.start_line),
                        None => location.path.clone(),
                    })
                }
            };
            (range.clone(), target)
        })
        .collect()
}

/// The link whose text covers byte `index` of the paragraph.
fn link_at(links: &[(Range<usize>, LinkMenuTarget)], index: usize) -> Option<&LinkMenuTarget> {
    links
        .iter()
        .find(|(range, _)| range.contains(&index))
        .map(|(_, target)| target)
}

/// Builds the paragraph text and runs. With a `chip_window`, an inline code span becomes a run
/// of invisible no-break spaces as wide as its chip, and a [`ChipPlan`] says where to paint the
/// code; without one, the code stays in the text as a mono run on a flat background.
fn build_styled_text_with_targets(
    spans: &[InlineSpan],
    tokens: &Tokens,
    prose_override: Option<Hsla>,
    workspace_root: Option<&str>,
    file_links_enabled: bool,
    chip_window: Option<&Window>,
) -> (
    StyledText,
    Vec<Range<usize>>,
    Vec<ClickTarget>,
    Vec<ChipPlan>,
) {
    // Runs, not highlights: inline code switches font family (the mono font), which a highlight
    // cannot. Every run therefore carries its own font and color.
    let prose = prose_override.unwrap_or_else(|| super::color::prose_foreground(tokens));
    let mut text = String::new();
    let mut runs: Vec<gpui_kit::TextRun> = Vec::new();
    let mut ranges: Vec<Range<usize>> = Vec::new();
    let mut targets: Vec<ClickTarget> = Vec::new();
    let mut chips: Vec<ChipPlan> = Vec::new();
    let sans = |bold: bool, italic: bool| gpui_kit::Font {
        family: ".SystemUIFont".into(),
        features: gpui_kit::FontFeatures::default(),
        fallbacks: None,
        weight: if bold {
            FontWeight::BOLD
        } else {
            FontWeight::NORMAL
        },
        style: if italic {
            FontStyle::Italic
        } else {
            FontStyle::Normal
        },
    };
    // Body size and the width of one no-break space, measured once for the paragraph.
    let body = chip_window.map(|window| {
        let body_px = window.text_style().font_size.to_pixels(window.rem_size());
        let space = inline_code::shape(
            window,
            &"\u{a0}".repeat(16),
            sans(false, false),
            body_px,
            Hsla::default(),
        );
        (body_px, f32::from(space.width()) / 16.0)
    });

    for span in spans {
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
        let code_color = if is_clickable_file {
            hsla(tokens.info_foreground)
        } else {
            prose_override.unwrap_or_else(|| hsla(tokens.foreground))
        };

        let start = text.len();
        let mut is_chip = false;
        if span.style.code {
            if let (Some(window), Some((body_px, space_px))) = (chip_window, body) {
                is_chip = true;
                let code_px = f32::from(body_px) * inline_code::CODE_EM;
                let shaped = inline_code::shape(
                    window,
                    &span.text,
                    gpui_kit::Font {
                        family: MONO_FONT_FAMILY.into(),
                        features: gpui_kit::FontFeatures::default(),
                        fallbacks: None,
                        weight: FontWeight::NORMAL,
                        style: FontStyle::Normal,
                    },
                    px(code_px),
                    code_color,
                );
                let room = f32::from(shaped.width()) + 2.0 * inline_code::chip_pad_x(code_px);
                let nbsp = inline_code::nbsp_count(room, space_px);
                text.push_str(&"\u{a0}".repeat(nbsp));
                chips.push(ChipPlan {
                    range: start..text.len(),
                    nbsp,
                    space_px,
                    shaped,
                    color: code_color,
                    code_px,
                });
            } else {
                // Thin padding inside the inline-code chip background.
                text.push('\u{2009}');
                text.push_str(&span.text);
                text.push('\u{2009}');
            }
        } else {
            text.push_str(&span.text);
        }
        let end = text.len();
        let len = end - start;
        if len == 0 {
            continue;
        }
        if let Some(t) = target {
            ranges.push(start..end);
            targets.push(t);
        }

        let (font, color, background_color, underline) = if is_chip {
            // The chip's room: invisible. `InlineCodeText` paints the chip over it.
            (sans(false, false), Hsla::default(), None, None)
        } else if span.style.code {
            (
                gpui_kit::Font {
                    family: MONO_FONT_FAMILY.into(),
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
                },
                code_color,
                Some(hsla(tokens.foreground.with_alpha(0.10))),
                None,
            )
        } else if span.link.is_some() {
            (
                sans(span.style.bold, span.style.italic),
                hsla(tokens.info_foreground),
                None,
                Some(UnderlineStyle {
                    thickness: px(1.0),
                    color: Some(hsla(tokens.info_foreground)),
                    wavy: false,
                }),
            )
        } else {
            (sans(span.style.bold, span.style.italic), prose, None, None)
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
        chips,
    )
}

/// Resolves a `file://` URL or inline-code token (e.g. `src/main.rs:42`, `Cargo.toml`, or
/// `/abs/workspace/src/lib.rs#L10-L20`) to a workspace-relative path when it looks like a file.
fn resolve_clickable_file_path(
    raw: &str,
    workspace_root: Option<&str>,
) -> Option<conn_contract::source::SourceLocation> {
    use conn_contract::source::{SourceLines, SourceLocation};

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
    if candidate.is_empty() {
        return None;
    }

    let line_span = |first: &str, last: &str| {
        let start_line: usize = first.parse().ok()?;
        let end_line: usize = last.parse().ok()?;
        (start_line > 0 && end_line >= start_line).then_some(SourceLines {
            start_line,
            end_line,
        })
    };
    let lines = if let Some((_, anchor)) = without_scheme.split_once("#L") {
        let (start, end) = anchor.split_once("-L").unwrap_or((anchor, anchor));
        line_span(start, end)
    } else {
        without_frag
            .strip_prefix(candidate)
            .and_then(|suffix| suffix.strip_prefix(':'))
            .and_then(|suffix| suffix.split(':').next())
            .and_then(|line| line_span(line, line))
    };
    let location = |rel: &str| {
        (conn_contract::source::workspace_relative(rel) && looks_like_file_path(rel)).then(|| {
            SourceLocation {
                path: rel.to_owned(),
                lines,
            }
        })
    };
    if candidate.starts_with('/') {
        let root = workspace_root?.trim_end_matches('/');
        if root.is_empty() {
            return None;
        }
        let private_root = format!("/private{root}");
        let rel = candidate
            .strip_prefix(&format!("{root}/"))
            .or_else(|| candidate.strip_prefix(&format!("{private_root}/")))?;
        return location(rel);
    }

    let rel = candidate.strip_prefix("./").unwrap_or(candidate);
    location(rel)
}

/// Like [`resolve_clickable_file_path`], but keeps where the link points: `path:line` when the
/// link has a `:line[:column]` suffix or an `#L10` fragment. The Files panel opens the file at
/// that line (`revealLine`).
#[cfg(test)]
fn resolve_clickable_file_link(raw: &str, workspace_root: Option<&str>) -> Option<String> {
    let path = resolve_clickable_file_path(raw, workspace_root)?.path;
    let trimmed = raw.trim();
    let without_scheme = trimmed.strip_prefix("file://").unwrap_or(trimmed);
    let (before_fragment, fragment) = match without_scheme.split_once('#') {
        Some((before, fragment)) => (before, Some(fragment)),
        None => (without_scheme, None),
    };
    let from_suffix = {
        let rest = &before_fragment[strip_line_col_suffix(before_fragment).len()..];
        rest.trim_start_matches(':')
            .split(':')
            .next()
            .and_then(|n| n.parse::<usize>().ok())
    };
    let from_fragment = fragment
        .and_then(|f| f.strip_prefix('L'))
        .map(|f| {
            f.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
        })
        .and_then(|n| n.parse::<usize>().ok());
    match from_suffix.or(from_fragment).filter(|line| *line > 0) {
        Some(line) => Some(format!("{path}:{line}")),
        None => Some(path),
    }
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
    #[test]
    fn a_right_click_finds_the_link_under_the_pointer() {
        let web = |url: &str| LinkMenuTarget::Web(url.to_owned());
        let file = |path: &str| LinkMenuTarget::File(path.to_owned());
        let links = vec![
            (4..10, web("https://a.test")),
            (14..20, file("src/foo.rs:42")),
        ];
        assert_eq!(link_at(&links, 4), Some(&web("https://a.test")));
        assert_eq!(link_at(&links, 9), Some(&web("https://a.test")));
        assert_eq!(
            link_at(&links, 10),
            None,
            "the range end is outside the link"
        );
        assert_eq!(link_at(&links, 15), Some(&file("src/foo.rs:42")));
        assert_eq!(link_at(&links, 0), None);
    }

    #[test]
    fn web_and_file_targets_both_get_a_menu_target() {
        let ranges = vec![0..3, 5..9];
        let targets = vec![
            ClickTarget::Url("https://a.test".to_owned()),
            ClickTarget::WorkspaceFile(resolve_clickable_file_path("src/foo.rs:42", None).unwrap()),
        ];
        assert_eq!(
            menu_targets(&ranges, &targets),
            vec![
                (0..3, LinkMenuTarget::Web("https://a.test".to_owned())),
                (5..9, LinkMenuTarget::File("src/foo.rs:42".to_owned())),
            ]
        );
    }

    use super::*;

    #[test]
    fn ax_ids_and_labels_for_blocks_are_stable_and_short() {
        assert_eq!(
            md_ax_id("turn-item:x-b2", "code").as_ref(),
            "chat.md.turn-item:x-b2.code"
        );
        assert_eq!(ax_preview("a  b\n c"), "a b c");
        let long = "word ".repeat(40);
        let preview = ax_preview(&long);
        assert!(preview.ends_with('…'));
        assert_eq!(preview.chars().count(), 81);

        let blocks = parse_markdown("- first *item*\n- second\n\n```rust\nfn a() {}\n```");
        let Some(MarkdownBlock::List { items, .. }) = blocks.first() else {
            panic!("expected a list first");
        };
        assert_eq!(list_item_text(&items[0]), "first item");
        assert_eq!(list_item_text(&items[1]), "second");
        assert!(matches!(
            blocks.get(1),
            Some(MarkdownBlock::CodeBlock { language: Some(lang), .. }) if lang == "rust"
        ));
    }

    #[test]
    fn clickable_file_links_keep_their_line() {
        let link = |raw| resolve_clickable_file_link(raw, Some("/repo"));
        assert_eq!(link("src/a.rs:42:10").as_deref(), Some("src/a.rs:42"));
        assert_eq!(link("src/a.rs:7").as_deref(), Some("src/a.rs:7"));
        assert_eq!(
            link("file:///repo/Cargo.toml#L10-L20").as_deref(),
            Some("Cargo.toml:10")
        );
        assert_eq!(link("src/a.rs").as_deref(), Some("src/a.rs"));
        assert_eq!(link("src/a.rs:0").as_deref(), Some("src/a.rs"));
        assert_eq!(link("https://example.com/a.rs"), None);
    }

    #[test]
    fn resolves_clickable_workspace_file_paths_and_rejects_non_files() {
        assert_eq!(
            resolve_clickable_file_path("crates/conn-app/src/app.rs:42:10", Some("/repo")),
            Some(conn_contract::source::SourceLocation {
                path: "crates/conn-app/src/app.rs".into(),
                lines: Some(conn_contract::source::SourceLines {
                    start_line: 42,
                    end_line: 42
                })
            })
        );
        assert_eq!(
            resolve_clickable_file_path("file:///repo/Cargo.toml#L10-L20", Some("/repo")),
            Some(conn_contract::source::SourceLocation {
                path: "Cargo.toml".into(),
                lines: Some(conn_contract::source::SourceLines {
                    start_line: 10,
                    end_line: 20
                })
            })
        );
        assert_eq!(
            resolve_clickable_file_path("./src/main.rs", None),
            Some(conn_contract::source::SourceLocation {
                path: "src/main.rs".into(),
                lines: None
            })
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

    /// A paragraph with inline code lays out as Conn's chip: the code is shaped at 0.85em, and
    /// the paragraph reserves room for it with invisible no-break spaces.
    #[gpui_kit::test]
    fn inline_code_is_planned_as_a_085em_chip_in_reserved_room(cx: &mut gpui_kit::TestAppContext) {
        use gpui_kit::test::TestWindowExt as _;
        use gpui_kit::{Context, IntoElement, ParentElement as _, Render, Styled as _};

        struct Probe;
        impl Render for Probe {
            fn render(
                &mut self,
                window: &mut Window,
                _cx: &mut Context<'_, Self>,
            ) -> impl IntoElement {
                let Some(theme) = conn_theme::theme_by_id("dark-ocean") else {
                    panic!("dark-ocean must be built in");
                };
                let tokens = Tokens::derive(&theme);
                let blocks = parse_markdown("Use `--keep-source` and `dns_unverified` here.");
                let Some(MarkdownBlock::Paragraph(spans)) = blocks.first() else {
                    panic!("expected a paragraph");
                };
                let (styled, _, _, chips) =
                    build_styled_text_with_targets(spans, &tokens, None, None, false, Some(window));
                let body_px = window.text_style().font_size.to_pixels(window.rem_size());
                assert_eq!(chips.len(), 2);
                for chip in &chips {
                    assert!((chip.code_px - f32::from(body_px) * 0.85).abs() < 1e-3);
                    assert!(
                        (f32::from(chip.shaped.font_size) - chip.code_px).abs() < 1e-3,
                        "the code is shaped at 0.85em"
                    );
                    let reserved = chip.nbsp as f32 * chip.space_px;
                    let chip_width = f32::from(chip.shaped.width())
                        + 2.0 * inline_code::chip_pad_x(chip.code_px);
                    assert!(
                        (reserved - chip_width).abs() <= chip.space_px / 2.0 + 1e-3,
                        "reserved {reserved} vs chip {chip_width}"
                    );
                }
                let _ = styled;
                gpui_kit::div()
                    .w(gpui_kit::px(240.0))
                    .child(render_markdown(
                        "probe",
                        "Use `--keep-source` and `dns_unverified` here, with enough words around them to wrap.",
                        &tokens,
                        &MarkdownOptions::default(),
                    ))
            }
        }

        let (_, vcx) = cx.add_window_view(|_, _| Probe);
        for _ in 0..2 {
            vcx.update(|window, cx| window.render_frame(cx));
        }
    }
}
