//! Codex `::artifact-template{...}` directives: the parser, the "Use template" prompt, and the
//! native card.
//!
//! The parser ports `packages/shared/src/codexMarkdownDirectives.ts` and
//! `codexArtifactTemplates.ts`. The card follows the lab's `GalleryCard` (`m-gallery-card`: a
//! 3px-inset card, a 30px header, an inset body) and web's `CodexArtifactTemplateCard`.

use std::ops::Range;
use std::rc::Rc;

use conn_theme::Tokens;
use gpui_kit::{
    AnyElement, App, FontWeight, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, Window, div, px,
};
use markdown::mdast::Node;

use super::color::{changed_files_panel, changed_files_surface, hsla};
use super::icons;
use crate::a11y::ConnA11yExt as _;

const DIRECTIVE_MARKER: &str = "::artifact-template";
const SKILL_NAME_PREFIX: &str = "artifact-template-";

const CARD_RADIUS_PX: f32 = 14.0;
const CARD_INSET_PX: f32 = 3.0;
const HEADER_HEIGHT_PX: f32 = 30.0;
const UI_FONT_PX: f32 = 13.0;
const UI_LINE_HEIGHT_PX: f32 = 20.0;

/// Starts the "Use template" action: the chat appends the template's prompt to the draft.
pub(crate) type UseArtifactTemplateCallback = Rc<dyn Fn(ArtifactTemplate, &mut Window, &mut App)>;

/// What a template makes (`CodexArtifactTemplateKind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ArtifactTemplateKind {
    Document,
    Presentation,
    Spreadsheet,
    Site,
    GoogleDocs,
    GoogleSlides,
    GoogleSheets,
    Image,
    Email,
    Slack,
}

impl ArtifactTemplateKind {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "document" => Self::Document,
            "presentation" => Self::Presentation,
            "spreadsheet" => Self::Spreadsheet,
            "site" => Self::Site,
            "google-docs" => Self::GoogleDocs,
            "google-slides" => Self::GoogleSlides,
            "google-sheets" => Self::GoogleSheets,
            "image" => Self::Image,
            "email" => Self::Email,
            "slack" => Self::Slack,
            _ => return None,
        })
    }

    /// `codexArtifactTemplatePresentationLabel`.
    fn label(self) -> &'static str {
        match self {
            Self::Document => "Document template",
            Self::Presentation => "Presentation template",
            Self::Spreadsheet => "Spreadsheet template",
            Self::Site => "Site template",
            Self::GoogleDocs => "Google Doc template",
            Self::GoogleSlides => "Google Slides template",
            Self::GoogleSheets => "Google Sheet template",
            Self::Image => "Image template",
            Self::Email => "Email template",
            Self::Slack => "Slack template",
        }
    }

    /// Web's `ARTIFACT_TEMPLATE_ICON_BY_KIND`, in the superheroicons set.
    fn icon(self) -> &'static str {
        match self {
            Self::Document | Self::GoogleDocs => "superhero/file-text.svg",
            Self::Presentation | Self::GoogleSlides => "superhero/presentation.svg",
            Self::Spreadsheet | Self::GoogleSheets => "superhero/spreadsheet.svg",
            Self::Site => "superhero/globe.svg",
            Self::Image => "superhero/image.svg",
            Self::Email => "superhero/mail.svg",
            Self::Slack => "superhero/comment.svg",
        }
    }

    /// `USE_PROMPT_BY_KIND`: `skill` is the `$skill-name` mention.
    fn prompt(self, skill: &str) -> String {
        match self {
            Self::Document => format!("Create a document using this {skill} about…"),
            Self::Presentation => {
                format!("Create a presentation using the {skill} template about…")
            }
            Self::Spreadsheet => format!("Create a spreadsheet using this {skill} about…"),
            Self::Site => format!("Create a Site using this {skill} about…"),
            Self::GoogleDocs => format!("Create a Google Doc using this {skill} about…"),
            Self::GoogleSlides => {
                format!("Create a Google Slides presentation using this {skill} about…")
            }
            Self::GoogleSheets => format!("Create a Google Sheet using this {skill} about…"),
            Self::Image => format!("Create an image using this {skill} of…"),
            Self::Email => format!("Draft an email using this {skill} about…"),
            Self::Slack => format!("Draft a Slack message using this {skill} about…"),
        }
    }
}

/// A resolved `::artifact-template` directive (`CodexArtifactTemplate`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ArtifactTemplate {
    pub(crate) kind: ArtifactTemplateKind,
    pub(crate) display_name: String,
    pub(crate) skill_name: String,
}

impl ArtifactTemplate {
    /// `codexArtifactTemplateUsePrompt`.
    pub(crate) fn use_prompt(&self) -> String {
        self.kind.prompt(&format!("${}", self.skill_name))
    }
}

/// `appendCodexArtifactTemplateUsePrompt`: `draft` with the template's prompt at the end, a
/// space between when the draft does not end in whitespace, and unchanged when it already ends
/// with the prompt.
pub(crate) fn append_use_prompt(draft: &str, template: &ArtifactTemplate) -> String {
    let prompt = template.use_prompt();
    let already_ends_with_prompt = draft
        .trim_end()
        .strip_suffix(prompt.as_str())
        .is_some_and(|before| before.is_empty() || before.ends_with(char::is_whitespace));
    if already_ends_with_prompt {
        return draft.to_owned();
    }
    let needs_space = !draft.is_empty() && !draft.ends_with(char::is_whitespace);
    format!("{draft}{}{prompt}", if needs_space { " " } else { "" })
}

// -------------------------------------------------------------------------------------------
// Directive syntax
// -------------------------------------------------------------------------------------------

type Attributes = Vec<(String, String)>;

struct Scan<'a> {
    rest: &'a str,
}

impl Scan<'_> {
    fn peek(&self) -> Option<char> {
        self.rest.chars().next()
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.rest = &self.rest[c.len_utf8()..];
        Some(c)
    }

    fn eat(&mut self, expected: char) -> bool {
        let found = self.peek() == Some(expected);
        if found {
            self.bump();
        }
        found
    }

    fn skip_spaces(&mut self) {
        while matches!(self.peek(), Some(' ' | '\t')) {
            self.bump();
        }
    }
}

/// micromark's `unicodePunctuation`: ASCII punctuation, and (approximately) non-ASCII
/// punctuation and symbols.
fn is_punctuation(c: char) -> bool {
    c.is_ascii_punctuation()
        || (!c.is_ascii() && !c.is_alphanumeric() && !c.is_whitespace() && !c.is_control())
}

/// Parses one line that starts at `::artifact-template` the way micromark-extension-directive's
/// leaf directive does: `::name`, an optional `[label]`, optional `{attributes}`, then only
/// spaces. `None` is "not a directive", and the line stays ordinary Markdown.
fn parse_directive_line(line: &str) -> Option<Attributes> {
    let mut scan = Scan {
        rest: line.strip_prefix(DIRECTIVE_MARKER)?,
    };
    if scan
        .peek()
        .is_some_and(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    if scan.peek() == Some('[') {
        skip_label(&mut scan)?;
    }
    let attributes = if scan.peek() == Some('{') {
        parse_attributes(&mut scan)?
    } else {
        Attributes::new()
    };
    scan.skip_spaces();
    scan.rest.is_empty().then_some(attributes)
}

/// A balanced `[label]` on one line, with `\[`, `\\` and `\]` escapes.
fn skip_label(scan: &mut Scan<'_>) -> Option<()> {
    scan.bump();
    let mut depth = 0usize;
    loop {
        match scan.bump()? {
            '\\' => {
                if matches!(scan.peek(), Some('[' | '\\' | ']')) {
                    scan.bump();
                }
            }
            '[' => depth += 1,
            ']' if depth == 0 => return Some(()),
            ']' => depth -= 1,
            _ => {}
        }
    }
}

/// `{...}` on one line: `name`, `name=value`, `name="value"`, `name='value'`, `#id`, `.class`.
fn parse_attributes(scan: &mut Scan<'_>) -> Option<Attributes> {
    scan.bump();
    let mut attributes = Attributes::new();
    loop {
        match scan.peek()? {
            ' ' | '\t' => scan.skip_spaces(),
            marker @ ('#' | '.') => {
                scan.bump();
                let value = parse_shortcut(scan)?;
                let name = if marker == '#' { "id" } else { "class" };
                attributes.push((name.to_owned(), value));
            }
            c if c.is_whitespace() || (is_punctuation(c) && c != '-' && c != '_') => {
                return scan.eat('}').then_some(attributes);
            }
            _ => {
                let mut name = String::new();
                name.extend(scan.bump());
                while let Some(c) = scan.peek() {
                    if c.is_whitespace()
                        || (is_punctuation(c) && !matches!(c, '-' | '.' | ':' | '_'))
                    {
                        break;
                    }
                    name.push(c);
                    scan.bump();
                }
                scan.skip_spaces();
                let value = if scan.eat('=') {
                    parse_value(scan)?
                } else {
                    String::new()
                };
                attributes.push((name, value));
            }
        }
    }
}

fn parse_shortcut(scan: &mut Scan<'_>) -> Option<String> {
    let first = scan.peek()?;
    if matches!(
        first,
        '"' | '#' | '\'' | '.' | '<' | '=' | '>' | '`' | '}' | ' ' | '\t'
    ) {
        return None;
    }
    let mut value = String::new();
    value.extend(scan.bump());
    loop {
        match scan.peek()? {
            '"' | '\'' | '<' | '=' | '>' | '`' => return None,
            '#' | '.' | '}' | ' ' | '\t' => return Some(decode_references(&value)),
            c => {
                value.push(c);
                scan.bump();
            }
        }
    }
}

fn parse_value(scan: &mut Scan<'_>) -> Option<String> {
    loop {
        match scan.peek()? {
            ' ' | '\t' => scan.skip_spaces(),
            '<' | '=' | '>' | '`' | '}' => return None,
            quote @ ('"' | '\'') => {
                scan.bump();
                let end = scan.rest.find(quote)?;
                let value = decode_references(&scan.rest[..end]);
                scan.rest = &scan.rest[end + 1..];
                return matches!(scan.peek(), Some('}' | ' ' | '\t')).then_some(value);
            }
            _ => {
                let mut value = String::new();
                value.extend(scan.bump());
                loop {
                    match scan.peek()? {
                        '"' | '\'' | '<' | '=' | '>' | '`' => return None,
                        '}' | ' ' | '\t' => return Some(decode_references(&value)),
                        c => {
                            value.push(c);
                            scan.bump();
                        }
                    }
                }
            }
        }
    }
}

/// Decode CommonMark character references in directive attributes.
fn decode_references(value: &str) -> String {
    if !value.contains('&') {
        return value.to_owned();
    }
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        if let Some((decoded, len)) = decode_reference(rest) {
            out.push_str(&decoded);
            rest = &rest[len..];
        } else {
            out.push('&');
            rest = &rest[1..];
        }
    }
    out.push_str(rest);
    out
}

/// A reference including its semicolon, bounded by CommonMark's longest entity name.
fn decode_reference(text: &str) -> Option<(String, usize)> {
    let end = text.bytes().take(33).position(|byte| byte == b';')?;
    let body = &text[1..end];
    let decoded = if let Some(number) = body.strip_prefix('#') {
        if let Some(hex) = number.strip_prefix(['x', 'X']) {
            if !(1..=6).contains(&hex.len()) || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            markdown::decode_numeric(hex, 16)
        } else {
            if !(1..=7).contains(&number.len()) || !number.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            markdown::decode_numeric(number, 10)
        }
    } else {
        markdown::decode_named(body, true)?
    };
    Some((decoded, end + 1))
}

// -------------------------------------------------------------------------------------------
// Resolving
// -------------------------------------------------------------------------------------------

/// `resolveCodexArtifactTemplate`: all of `artifact_kind`, `display_name`, `skill_directory` and
/// `skill_name` must be valid, and `gallery_kind` must be valid when present.
fn resolve(attributes: &[(String, String)]) -> Option<ArtifactTemplate> {
    let get = |name: &str| {
        attributes
            .iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    };
    let kind = ArtifactTemplateKind::parse(get("artifact_kind")?)?;
    let display_name = get("display_name")?.trim();
    if display_name.is_empty() {
        return None;
    }
    if get("gallery_kind").is_some_and(|gallery| !matches!(gallery, "imagegen" | "product-design"))
    {
        return None;
    }
    if !is_absolute_directory(get("skill_directory")?) {
        return None;
    }
    let skill_name = get("skill_name")?;
    if !skill_name.starts_with(SKILL_NAME_PREFIX) {
        return None;
    }
    Some(ArtifactTemplate {
        kind,
        display_name: display_name.to_owned(),
        skill_name: skill_name.to_owned(),
    })
}

/// A POSIX path, a Windows drive path, or a UNC path.
fn is_absolute_directory(value: &str) -> bool {
    let bytes = value.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    (value.starts_with('/') && !value.starts_with("//")) || drive || is_unc(value)
}

/// `\\server\share` or `//server/share`.
fn is_unc(value: &str) -> bool {
    let (separator, rest) = if let Some(rest) = value.strip_prefix("\\\\") {
        ('\\', rest)
    } else if let Some(rest) = value.strip_prefix("//") {
        ('/', rest)
    } else {
        return false;
    };
    rest.split_once(separator).is_some_and(|(server, share)| {
        !server.is_empty() && share.chars().next().is_some_and(|c| c != separator)
    })
}

// -------------------------------------------------------------------------------------------
// Splitting a message at its templates
// -------------------------------------------------------------------------------------------

/// A message cut at its top-level template directives (`splitCodexArtifactTemplateMarkdown`).
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Segment<'a> {
    Markdown(&'a str),
    Template(ArtifactTemplate),
    /// A directive with valid syntax but invalid attributes: its source line, shown as text.
    Literal(&'a str),
}

struct Candidate {
    line_start: usize,
    text_start: usize,
    text_end: usize,
    line_end: usize,
    attributes: Attributes,
}

pub(super) fn split_segments(src: &str) -> Vec<Segment<'_>> {
    let directives = top_level_directives(src);
    if directives.is_empty() {
        return vec![Segment::Markdown(src)];
    }
    let mut segments = Vec::with_capacity(directives.len() * 2 + 1);
    let mut cursor = 0;
    for candidate in directives {
        if candidate.line_start > cursor {
            segments.push(Segment::Markdown(&src[cursor..candidate.line_start]));
        }
        segments.push(match resolve(&candidate.attributes) {
            Some(template) => Segment::Template(template),
            None => Segment::Literal(&src[candidate.text_start..candidate.text_end]),
        });
        cursor = candidate.line_end;
    }
    if cursor < src.len() {
        segments.push(Segment::Markdown(&src[cursor..]));
    }
    segments
}

/// Copy the labels of rendered template cards and preserve all surrounding Markdown.
pub(super) fn message_copy_text(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut cursor = 0;
    for candidate in top_level_directives(src) {
        if let Some(template) = resolve(&candidate.attributes) {
            out.push_str(&src[cursor..candidate.text_start]);
            out.push_str(&template.display_name);
            out.push_str(" (");
            out.push_str(template.kind.label());
            out.push(')');
            cursor = candidate.text_end;
        }
    }
    out.push_str(&src[cursor..]);
    out
}

/// The directive lines that stand on their own at the top level of `src`: not in a code or HTML
/// block, so a fenced example stays literal, and not inside a list or quote.
fn top_level_directives(src: &str) -> Vec<Candidate> {
    if !src.contains(DIRECTIVE_MARKER) {
        return Vec::new();
    }
    let mut found = Vec::new();
    let mut offset = 0;
    for line in src.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();
        let body = line.strip_suffix('\n').unwrap_or(line);
        let body = body.strip_suffix('\r').unwrap_or(body);
        let indent = body.len() - body.trim_start_matches(' ').len();
        if indent > 3 {
            continue;
        }
        let Some(attributes) = parse_directive_line(&body[indent..]) else {
            continue;
        };
        found.push((
            indent,
            Candidate {
                line_start,
                text_start: line_start + indent,
                text_end: line_start + body.len(),
                line_end: offset,
                attributes,
            },
        ));
    }
    if found.is_empty() {
        return Vec::new();
    }
    let spans = BlockSpans::of(src);
    found
        .into_iter()
        .filter(|(indent, candidate)| spans.allows(candidate.text_start, *indent))
        .map(|(_, candidate)| candidate)
        .collect()
}

/// Where the Markdown parser put code, HTML and container blocks, by byte offset.
#[derive(Default)]
struct BlockSpans {
    literal: Vec<Range<usize>>,
    containers: Vec<Range<usize>>,
}

impl BlockSpans {
    fn of(src: &str) -> Self {
        let mut spans = Self::default();
        if let Ok(Node::Root(root)) = markdown::to_mdast(src, &markdown::ParseOptions::gfm()) {
            for child in &root.children {
                spans.collect(child);
            }
        }
        spans
    }

    fn collect(&mut self, node: &Node) {
        let range = node
            .position()
            .map(|position| position.start.offset..position.end.offset);
        match node {
            Node::Code(_) | Node::Html(_) => self.literal.extend(range),
            Node::Blockquote(_) | Node::List(_) | Node::FootnoteDefinition(_) => {
                self.containers.extend(range);
                self.collect_children(node);
            }
            Node::ListItem(_) => self.collect_children(node),
            _ => {}
        }
    }

    fn collect_children(&mut self, node: &Node) {
        for child in node.children().into_iter().flatten() {
            self.collect(child);
        }
    }

    /// A line in a code or HTML block is text. A line in a list or quote is text too, unless it
    /// starts at column 0: a directive ends the block it follows, and the parser only sees that
    /// line as a lazy continuation of it.
    fn allows(&self, offset: usize, indent: usize) -> bool {
        if self.literal.iter().any(|range| range.contains(&offset)) {
            return false;
        }
        indent == 0 || !self.containers.iter().any(|range| range.contains(&offset))
    }
}

// -------------------------------------------------------------------------------------------
// Card
// -------------------------------------------------------------------------------------------

/// The card for one template: kind icon and label in the header, the display name in the inset
/// body, and a "Use template" action in the header when the chat can take the prompt.
pub(super) fn render_card(
    block_id: &str,
    template: &ArtifactTemplate,
    tokens: &Tokens,
    on_use: Option<&UseArtifactTemplateCallback>,
) -> AnyElement {
    let muted = hsla(tokens.muted_foreground);
    let ax_id = SharedString::from(format!("chat.md.{block_id}.artifact-template"));

    let mut header = div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .min_h(px(HEADER_HEIGHT_PX))
        .pl(px(11.0))
        .pr(px(5.0))
        .child(icons::icon(template.kind.icon(), 14.0, muted))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_size(px(UI_FONT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(template.kind.label()),
        );
    if let Some(on_use) = on_use {
        let on_use = Rc::clone(on_use);
        let used = template.clone();
        let hover = hsla(tokens.shell_highlight);
        header = header.child(
            div()
                .id(SharedString::from(format!(
                    "md-{block_id}-artifact-template-use"
                )))
                .a11y_button(SharedString::from(format!("{ax_id}.use")), "Use template")
                .flex()
                .flex_none()
                .items_center()
                .min_h(px(24.0))
                .px(px(6.0))
                .rounded(px(4.0))
                .cursor_pointer()
                .text_size(px(UI_FONT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(hsla(tokens.primary))
                .hover(move |style| style.bg(hover))
                .on_click(move |_, window, cx| on_use(used.clone(), window, cx))
                .child("Use template"),
        );
    }

    let body = div()
        .w_full()
        .min_w_0()
        .px(px(11.0))
        .py(px(10.0))
        .rounded(px(CARD_RADIUS_PX - CARD_INSET_PX))
        .bg(changed_files_panel(tokens))
        .text_size(px(UI_FONT_PX))
        .line_height(px(UI_LINE_HEIGHT_PX))
        .font_weight(FontWeight::MEDIUM)
        .text_color(hsla(tokens.foreground))
        .child(SharedString::from(template.display_name.clone()));

    div()
        .id(SharedString::from(format!(
            "md-{block_id}-artifact-template"
        )))
        .a11y_group(ax_id, format!("{} template", template.display_name))
        .flex()
        .flex_col()
        .w_full()
        .min_w_0()
        .gap(px(CARD_INSET_PX))
        .p(px(CARD_INSET_PX))
        .rounded(px(CARD_RADIUS_PX))
        .bg(hsla(changed_files_surface(tokens)))
        .child(header)
        .child(body)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::{
        ArtifactTemplate, ArtifactTemplateKind, Segment, append_use_prompt, split_segments,
    };
    use crate::chat::markdown::{MarkdownBlock, parse_markdown};

    const VALID: &str = r#"::artifact-template{artifact_kind="document" display_name="Weekly report" skill_directory="/Users/me/.codex/skills/artifact-template-report" skill_name="artifact-template-report"}"#;

    #[test]
    fn clipboard_replaces_only_rendered_templates_and_preserves_line_endings() {
        let second = VALID.replace("Weekly report", "Q&amp;A &copy; &NotEqualTilde; &unknown;");
        let invalid = VALID.replace("document", "invalid");
        let input =
            format!("Before\r\n{VALID}\r\n{second}\r\n{invalid}\r\n```\n{VALID}\n```\nAfter");
        let expected = format!(
            "Before\r\nWeekly report (Document template)\r\nQ&A © ≂\u{338} &unknown; (Document template)\r\n{invalid}\r\n```\n{VALID}\n```\nAfter"
        );
        assert_eq!(super::message_copy_text(&input), expected);
    }

    fn weekly_report() -> ArtifactTemplate {
        ArtifactTemplate {
            kind: ArtifactTemplateKind::Document,
            display_name: "Weekly report".to_owned(),
            skill_name: "artifact-template-report".to_owned(),
        }
    }

    fn directive(attributes: &str) -> String {
        format!("::artifact-template{{{attributes}}}")
    }

    /// The templates of a message, in order. A directive that stays text is not one.
    fn templates(src: &str) -> Vec<ArtifactTemplate> {
        split_segments(src)
            .into_iter()
            .filter_map(|segment| match segment {
                Segment::Template(template) => Some(template),
                _ => None,
            })
            .collect()
    }

    fn is_plain_markdown(src: &str) -> bool {
        split_segments(src) == vec![Segment::Markdown(src)]
    }

    #[test]
    fn a_valid_directive_is_a_template() {
        assert_eq!(
            split_segments(VALID),
            vec![Segment::Template(weekly_report())]
        );
    }

    #[test]
    fn a_template_splits_the_message_around_it() {
        let src = format!("Here is a template.\n\n{VALID}\n\nPick it.\n");
        assert_eq!(
            split_segments(&src),
            vec![
                Segment::Markdown("Here is a template.\n\n"),
                Segment::Template(weekly_report()),
                Segment::Markdown("\nPick it.\n"),
            ]
        );
    }

    #[test]
    fn a_message_holds_several_templates() {
        let second = VALID
            .replace("document", "slack")
            .replace("Weekly report", "Standup");
        let src = format!("One:\n{VALID}\nTwo:\n{second}\n");
        let found = templates(&src);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0], weekly_report());
        assert_eq!(found[1].kind, ArtifactTemplateKind::Slack);
        assert_eq!(found[1].display_name, "Standup");
    }

    #[test]
    fn a_directive_ends_the_paragraph_it_follows() {
        let src = format!("Intro line\n{VALID}\n");
        assert_eq!(
            split_segments(&src),
            vec![
                Segment::Markdown("Intro line\n"),
                Segment::Template(weekly_report()),
            ]
        );
    }

    #[test]
    fn syntax_follows_the_directive_parser() {
        let attributes = r#"display_name='Q&amp;A' artifact_kind=email skill_directory=C:\skills\a skill_name=artifact-template-qa gallery_kind=imagegen #id .class flag"#;
        let found = templates(&directive(attributes));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].display_name, "Q&A");
        assert_eq!(found[0].kind, ArtifactTemplateKind::Email);

        let labelled = VALID.replace("{", "[a [nested] \\] label]{");
        assert_eq!(templates(&labelled), vec![weekly_report()]);
        assert_eq!(templates(&format!("{VALID}   \t")), vec![weekly_report()]);
        assert_eq!(
            templates(&format!("   {VALID}")),
            vec![weekly_report()],
            "three spaces of indent are allowed"
        );
    }

    #[test]
    fn a_later_attribute_replaces_an_earlier_one() {
        let src = VALID.replace("{", r#"{display_name="Old" "#);
        assert_eq!(templates(&src), vec![weekly_report()]);
    }

    #[test]
    fn malformed_directives_stay_markdown() {
        for malformed in [
            VALID.trim_end_matches('}').to_owned(),
            format!("{VALID} trailing"),
            VALID.replace("::artifact", ":::artifact"),
            VALID.replace("::artifact-template", "::artifact-template-x"),
            VALID.replace("::artifact-template", ": :artifact-template"),
            VALID.replace(
                r#"skill_name="artifact-template-report""#,
                r#"skill_name="a"b"#,
            ),
            VALID.replace(r#"display_name="Weekly report""#, "display_name=a=b"),
            VALID.replace("{", "[unclosed {"),
            format!("    {VALID}"),
            format!("\t{VALID}"),
            format!("> {VALID}"),
            format!("- {VALID}"),
            format!("text {VALID}"),
        ] {
            assert!(is_plain_markdown(&malformed), "{malformed}");
        }
    }

    #[test]
    fn invalid_attributes_leave_the_line_as_text() {
        let name_only = "::artifact-template".to_owned();
        for source in [
            VALID.replace("\"document\"", "\"memo\""),
            VALID.replace(r#" display_name="Weekly report""#, ""),
            VALID.replace("Weekly report", "   "),
            VALID.replace(
                "/Users/me/.codex/skills/artifact-template-report",
                "skills/report",
            ),
            VALID.replace(
                "/Users/me/.codex/skills/artifact-template-report",
                "//skills",
            ),
            VALID.replace("artifact-template-report\"}", "report\"}"),
            VALID.replace("{", r#"{gallery_kind="poster" "#),
            VALID.replace("{", r#"{gallery_kind="" "#),
            name_only,
        ] {
            assert_eq!(
                split_segments(&source),
                vec![Segment::Literal(&source)],
                "{source}"
            );
        }
    }

    #[test]
    fn skill_directories_may_be_posix_windows_or_unc() {
        for directory in [
            "/skills/a",
            "C:\\skills\\a",
            "d:/skills/a",
            "\\\\server\\share\\a",
            "//server/share/a",
        ] {
            let src = VALID.replace(
                "/Users/me/.codex/skills/artifact-template-report",
                directory,
            );
            assert_eq!(templates(&src), vec![weekly_report()], "{directory}");
        }
        for directory in [
            "",
            "C:",
            "C:skills",
            "\\\\server",
            "\\\\server\\",
            "//server/",
        ] {
            let src = VALID.replace(
                "/Users/me/.codex/skills/artifact-template-report",
                directory,
            );
            assert!(templates(&src).is_empty(), "{directory}");
        }
    }

    #[test]
    fn fenced_examples_stay_literal() {
        for fenced in [
            format!("```md\n{VALID}\n```\n"),
            format!("~~~\n{VALID}\n~~~\n"),
            format!("````\n```\n{VALID}\n```\n````\n"),
            format!("```md\n{VALID}\n"),
            format!("Example:\n\n```\n{VALID}\n"),
            format!("> ```\n> {VALID}\n> ```\n"),
            format!("<div>\n{VALID}\n</div>\n"),
        ] {
            assert!(is_plain_markdown(&fenced), "{fenced}");
        }
    }

    #[test]
    fn a_template_after_a_fence_still_counts() {
        let src = format!("```md\n{VALID}\n```\n\n{VALID}\n");
        assert_eq!(
            split_segments(&src),
            vec![
                Segment::Markdown(&src[..src.len() - VALID.len() - 1]),
                Segment::Template(weekly_report()),
            ]
        );
        let closed_by_quote_end = format!("> ```\n> code\n{VALID}\n");
        assert_eq!(templates(&closed_by_quote_end), vec![weekly_report()]);
    }

    #[test]
    fn only_top_level_directives_count() {
        let nested_in_item = format!("- item\n  {VALID}\n");
        assert!(is_plain_markdown(&nested_in_item), "{nested_in_item}");
        let after_list = format!("- item\n{VALID}\n");
        assert_eq!(templates(&after_list), vec![weekly_report()]);
        let after_quote = format!("> quote\n{VALID}\n");
        assert_eq!(templates(&after_quote), vec![weekly_report()]);
    }

    #[test]
    fn windows_line_endings_end_the_directive() {
        let src = format!("a\r\n\r\n{VALID}\r\n\r\nb\r\n");
        assert_eq!(templates(&src), vec![weekly_report()]);
    }

    #[test]
    fn markdown_blocks_keep_their_order() {
        let blocks = parse_markdown(&format!("Before\n\n{VALID}\n\n- after\n"));
        assert!(matches!(blocks[0], MarkdownBlock::Paragraph(_)));
        assert_eq!(blocks[1], MarkdownBlock::ArtifactTemplate(weekly_report()));
        assert!(matches!(blocks[2], MarkdownBlock::List { .. }));
        assert_eq!(blocks.len(), 3);
    }

    #[test]
    fn a_directive_with_bad_attributes_is_one_paragraph_of_its_source() {
        let source = VALID.replace("\"document\"", "\"memo\"");
        let blocks = parse_markdown(&source);
        let [MarkdownBlock::Paragraph(spans)] = blocks.as_slice() else {
            panic!("expected one paragraph, got {blocks:?}");
        };
        let text: String = spans.iter().map(|span| span.text.as_str()).collect();
        assert_eq!(text, source);
    }

    #[test]
    fn a_fenced_example_is_one_code_block() {
        let blocks = parse_markdown(&format!("```text\n{VALID}\n```"));
        assert!(
            matches!(blocks.as_slice(), [MarkdownBlock::CodeBlock { code, .. }] if code == VALID),
            "{blocks:?}"
        );
    }

    #[test]
    fn use_prompt_names_the_skill_per_kind() {
        let mut template = weekly_report();
        assert_eq!(
            template.use_prompt(),
            "Create a document using this $artifact-template-report about…"
        );
        template.kind = ArtifactTemplateKind::Presentation;
        assert_eq!(
            template.use_prompt(),
            "Create a presentation using the $artifact-template-report template about…"
        );
        template.kind = ArtifactTemplateKind::Image;
        assert_eq!(
            template.use_prompt(),
            "Create an image using this $artifact-template-report of…"
        );
    }

    #[test]
    fn use_appends_to_the_draft_without_replacing_it() {
        let template = weekly_report();
        let prompt = template.use_prompt();
        assert_eq!(append_use_prompt("", &template), prompt);
        assert_eq!(
            append_use_prompt("Draft the Q3 numbers", &template),
            format!("Draft the Q3 numbers {prompt}")
        );
        assert_eq!(
            append_use_prompt("Draft the Q3 numbers\n", &template),
            format!("Draft the Q3 numbers\n{prompt}")
        );
    }

    #[test]
    fn use_twice_adds_the_prompt_once() {
        let template = weekly_report();
        let once = append_use_prompt("Notes", &template);
        assert_eq!(append_use_prompt(&once, &template), once);
        let with_trailing_space = format!("{once} ");
        assert_eq!(
            append_use_prompt(&with_trailing_space, &template),
            with_trailing_space
        );
        let glued = format!("Notes{}", template.use_prompt());
        assert_eq!(
            append_use_prompt(&glued, &template),
            format!("{glued} {}", template.use_prompt())
        );
    }
}
