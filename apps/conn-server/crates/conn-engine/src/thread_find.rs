//! The text in-thread Find searches: the segments a message or plan shows once its Markdown
//! is rendered, as T3's `threadFindText.ts`. Emphasis and a link's label join the text around
//! them; a link's destination is not shown, so it is not searched. A block (paragraph,
//! heading, list item, table cell, code block, line break) ends a segment, so a phrase never
//! spans two. An assistant's HTML shows its text, as `rehype-raw` and `rehype-sanitize` show
//! it; a footnote shows its number, and the definitions follow under `Footnotes`.
//!
//! Not built: T3's file-link labels, citation cards, composer context chips, skill labels,
//! Codex directives, artifact templates and `★ Insight` blocks. Find skips their text.

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use serde_json::Value;

/// The displayed text segments of a turn item that Find searches; none for other items.
pub(crate) fn segments(item: &Value) -> Vec<String> {
    let text = |key: &str| item[key].as_str().unwrap_or_default();
    match item["type"].as_str() {
        Some("user_message") => markdown_segments(text("text"), Role::User),
        Some("assistant_message") => markdown_segments(text("text"), Role::Assistant),
        Some("proposed_plan") => plan_segments(text("markdown")),
        _ => Vec::new(),
    }
}

/// Which of T3's two Markdown pipelines renders the text.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    /// `remark-breaks` (each line break shows), single tildes kept, HTML shown as typed.
    User,
    /// Plain GFM; a plan's body renders this way too.
    Assistant,
}

/// `searchablePlanSegments`: the title the card shows, then the body under it.
fn plan_segments(markdown: &str) -> Vec<String> {
    let title = markdown
        .lines()
        .find_map(|line| heading(line).filter(|text| !text.is_empty()))
        .unwrap_or("Proposed plan");
    let mut segments = vec![title.to_owned()];
    segments.extend(markdown_segments(
        &strip_displayed_plan(markdown),
        Role::Assistant,
    ));
    segments
}

/// The trimmed text of an ATX heading line, `^\s{0,3}#{1,6}\s+(.*)$`.
fn heading(line: &str) -> Option<&str> {
    let rest = line.trim_start();
    let indent = line.get(..line.len() - rest.len()).unwrap_or_default();
    if indent.chars().count() > 3 {
        return None;
    }
    let hashes = rest.bytes().take_while(|b| *b == b'#').count();
    let after = rest.get(hashes..)?;
    ((1..=6).contains(&hashes) && after.starts_with(char::is_whitespace)).then(|| after.trim())
}

/// `stripDisplayedPlanMarkdown`: drops the title line and a leading `Summary` heading.
fn strip_displayed_plan(markdown: &str) -> String {
    let lines: Vec<&str> = markdown.trim_end().lines().collect();
    let blank = |at: usize| lines.get(at).is_some_and(|line| line.trim().is_empty());
    let mut start = usize::from(lines.first().is_some_and(|line| heading(line).is_some()));
    while blank(start) {
        start += 1;
    }
    if lines
        .get(start)
        .and_then(|line| heading(line))
        .is_some_and(|text| text.to_lowercase() == "summary")
    {
        start += 1;
        while blank(start) {
            start += 1;
        }
    }
    lines.get(start..).unwrap_or_default().join("\n")
}

/// `markdownThreadFindText`: the text a CommonMark and GFM render shows, in segments.
fn markdown_segments(markdown: &str, role: Role) -> Vec<String> {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_TASKLISTS;
    let mut out = Segments {
        role,
        text: String::new(),
        done: Vec::new(),
    };
    // An image's alt text is not shown; images can nest inside a link.
    let mut in_image = 0_usize;
    // A user's single `~` does not strike (GFM `singleTilde: false`), so it stays shown.
    let mut kept_tildes: Vec<bool> = Vec::new();
    let mut in_code_block = false;
    let mut html = Html::default();
    let mut notes = Footnotes::default();
    for (event, range) in Parser::new_ext(markdown, options).into_offset_iter() {
        match event {
            Event::Start(Tag::Image { .. }) => in_image += 1,
            Event::End(TagEnd::Image) => in_image = in_image.saturating_sub(1),
            _ if in_image > 0 => {}
            Event::Text(_) | Event::Code(_) | Event::SoftBreak if html.in_script => {}
            // A code block keeps its lines.
            Event::Text(text) if in_code_block => out.text.push_str(&text),
            Event::Text(text) | Event::Code(text) => out.push(&text),
            // A user's HTML shows as typed, and its line breaks do not show.
            Event::InlineHtml(source) | Event::Html(source) if role == Role::User => {
                out.push(&source.replace("\r\n", " ").replace('\n', " "));
            }
            Event::InlineHtml(source) | Event::Html(source) => html.feed(&source, &mut out),
            Event::SoftBreak => out.push("\n"),
            Event::HardBreak | Event::Rule => out.flush(),
            Event::FootnoteReference(label) => out.push(&notes.reference(&label).to_string()),
            Event::Start(Tag::FootnoteDefinition(label)) => {
                out.flush();
                notes.open(&label, &mut out);
            }
            Event::End(TagEnd::FootnoteDefinition) => {
                out.flush();
                notes.close(&mut out);
            }
            Event::Start(Tag::Strikethrough) => {
                let single = role == Role::User
                    && markdown
                        .get(range)
                        .is_some_and(|source| !source.starts_with("~~"));
                if single {
                    out.text.push('~');
                }
                kept_tildes.push(single);
            }
            Event::End(TagEnd::Strikethrough) => {
                if kept_tildes.pop() == Some(true) {
                    out.text.push('~');
                }
            }
            Event::Start(tag) if is_block(&tag) => {
                in_code_block = matches!(tag, Tag::CodeBlock(_));
                out.flush();
            }
            Event::End(tag) if is_block_end(tag) => {
                in_code_block = false;
                notes.tail_is_paragraph = tag == TagEnd::Paragraph;
                out.flush();
            }
            // Inline markup (emphasis, strong, a link's label) joins; a link's destination
            // and a task box are not text.
            _ => {}
        }
    }
    out.flush();
    notes.append_section(&mut out.done);
    out.done
}

fn is_block(tag: &Tag<'_>) -> bool {
    !matches!(
        tag,
        Tag::Emphasis | Tag::Strong | Tag::Strikethrough | Tag::Link { .. } | Tag::Image { .. }
    )
}

fn is_block_end(tag: TagEnd) -> bool {
    !matches!(
        tag,
        TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough | TagEnd::Link | TagEnd::Image
    )
}

/// The tags that end a segment, T3's `THREAD_FIND_BLOCK_TAGS`.
const BLOCK_TAGS: &[&str] = &[
    "address",
    "article",
    "aside",
    "blockquote",
    "br",
    "dd",
    "details",
    "div",
    "dl",
    "dt",
    "figcaption",
    "figure",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "summary",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
];

/// Reads the HTML an assistant writes as the sanitized render shows it: tags and comments
/// hide, a block tag ends the segment, and `<script>` hides its text. The state carries over
/// from one HTML event to the next, as a tag can span the lines of an HTML block.
#[derive(Default)]
struct Html {
    in_script: bool,
    /// The source of an open tag or comment, after its `<`.
    tag: Option<String>,
}

impl Html {
    fn feed(&mut self, source: &str, out: &mut Segments) {
        let mut text = String::new();
        let mut chars = source.chars().peekable();
        while let Some(c) = chars.next() {
            if let Some(tag) = &mut self.tag {
                tag.push(c);
                let ended = if tag.starts_with("!--") {
                    tag.len() >= 5 && tag.ends_with("-->")
                } else {
                    c == '>'
                };
                if ended {
                    let tag = self.tag.take().unwrap_or_default();
                    self.close_tag(&tag, &mut text, out);
                }
            } else if c == '<'
                && chars.peek().is_some_and(|next| {
                    next.is_ascii_alphabetic() || matches!(next, '/' | '!' | '?')
                })
            {
                self.tag = Some(String::new());
            } else if !self.in_script {
                text.push(c);
            }
        }
        out.push(&decode_entities(&text));
    }

    /// Acts on a finished tag; the text before it is pushed first.
    fn close_tag(&mut self, tag: &str, text: &mut String, out: &mut Segments) {
        let closing = tag.starts_with('/');
        let name: String = tag
            .trim_start_matches('/')
            .chars()
            .take_while(char::is_ascii_alphanumeric)
            .collect::<String>()
            .to_ascii_lowercase();
        if name == "script" {
            self.in_script = !closing;
        }
        if BLOCK_TAGS.contains(&name.as_str()) {
            out.push(&decode_entities(&std::mem::take(text)));
            out.flush();
        }
    }
}

/// Decodes the character references in HTML text. Each `&...;` goes through pulldown-cmark,
/// which holds the HTML5 entity table; one it does not know stays as written.
fn decode_entities(text: &str) -> String {
    let mut decoded = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        let (before, from) = rest.split_at(at);
        decoded.push_str(before);
        let end = from
            .char_indices()
            .take(40)
            .find(|&(_, c)| c == ';')
            .map(|(at, _)| at + 1);
        let Some(token) = end.and_then(|end| from.get(..end)) else {
            decoded.push('&');
            rest = from.get(1..).unwrap_or_default();
            continue;
        };
        let parsed: String = Parser::new(token)
            .filter_map(|event| match event {
                Event::Text(text) => Some(text.into_string()),
                _ => None,
            })
            .collect();
        decoded.push_str(if parsed.is_empty() { token } else { &parsed });
        rest = from.get(token.len()..).unwrap_or_default();
    }
    decoded.push_str(rest);
    decoded
}

/// GFM footnotes as `mdast-util-to-hast` shows them: a reference shows its number, by first
/// reference; the referenced definitions follow the message under a `Footnotes` heading, in
/// that order, each ending with one back-reference per reference.
#[derive(Default)]
struct Footnotes {
    /// Each referenced label, lowercased, with its reference count, in first-reference order.
    references: Vec<(String, usize)>,
    /// Each definition's label, segments, and whether it ends in a paragraph.
    definitions: Vec<(String, Vec<String>, bool)>,
    /// The open definition's label and the segments before it.
    open: Option<(String, Vec<String>)>,
    tail_is_paragraph: bool,
}

impl Footnotes {
    fn reference(&mut self, label: &str) -> usize {
        let label = label.to_lowercase();
        if let Some(at) = self.references.iter().position(|(seen, _)| *seen == label) {
            if let Some((_, count)) = self.references.get_mut(at) {
                *count += 1;
            }
            return at + 1;
        }
        self.references.push((label, 1));
        self.references.len()
    }

    fn open(&mut self, label: &str, out: &mut Segments) {
        self.tail_is_paragraph = false;
        self.open = Some((label.to_lowercase(), std::mem::take(&mut out.done)));
    }

    fn close(&mut self, out: &mut Segments) {
        if let Some((label, before)) = self.open.take() {
            let body = std::mem::replace(&mut out.done, before);
            self.definitions.push((label, body, self.tail_is_paragraph));
        }
    }

    fn append_section(self, segments: &mut Vec<String>) {
        let mut definitions = self.definitions;
        let mut heading = false;
        for (label, count) in &self.references {
            let Some(at) = definitions.iter().position(|(seen, ..)| seen == label) else {
                continue;
            };
            let (_, mut body, tail_is_paragraph) = definitions.swap_remove(at);
            if !heading {
                segments.push("Footnotes".to_owned());
                heading = true;
            }
            let back = (1..=*count)
                .map(|n| {
                    if n == 1 {
                        "↩".to_owned()
                    } else {
                        format!("↩{n}")
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            match body.last_mut() {
                Some(tail) if tail_is_paragraph => {
                    tail.push(' ');
                    tail.push_str(&back);
                }
                _ => body.push(back),
            }
            segments.extend(body);
        }
    }
}

/// The segment being joined and the finished ones.
struct Segments {
    role: Role,
    text: String,
    done: Vec<String>,
}

impl Segments {
    /// Ends the current segment; one with only whitespace is dropped.
    fn flush(&mut self) {
        let text = std::mem::take(&mut self.text);
        if !text.trim().is_empty() {
            self.done.push(text);
        }
    }

    /// Appends inline text. A user's line break ends the segment and an assistant's joins
    /// the lines with a space, as `remark-breaks` and the HTML render show them.
    fn push(&mut self, value: &str) {
        let mut lines = value.split('\n');
        if let Some(first) = lines.next() {
            self.text
                .push_str(first.strip_suffix('\r').unwrap_or(first));
        }
        for line in lines {
            match self.role {
                Role::User => self.flush(),
                Role::Assistant => self.text.push(' '),
            }
            self.text.push_str(line.strip_suffix('\r').unwrap_or(line));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn shown(kind: &str, text: &str) -> Vec<String> {
        segments(&json!({"type": kind, "text": text, "markdown": text}))
    }

    /// `searches visible rendered messages and plans in canonical item order`: a phrase
    /// across emphasis, a plan's title, and a link's hidden destination.
    #[test]
    fn rendered_text_joins_inline_markup_and_hides_link_targets() {
        assert_eq!(
            shown("user_message", "Check **the build**"),
            ["Check the build"]
        );
        assert_eq!(
            shown(
                "assistant_message",
                "[documentation](https://hidden.example/needle)"
            ),
            ["documentation"]
        );
        assert_eq!(
            shown("proposed_plan", "# Check the build\nShip it"),
            ["Check the build", "Ship it"]
        );
        assert_eq!(
            shown(
                "user_message",
                "Check **the build**, then [the handbook](https://example.test/internal-handle)."
            ),
            ["Check the build, then the handbook."]
        );
        // A URL in a code span, or a bare one, is shown.
        assert_eq!(
            shown(
                "user_message",
                "See `https://example.test/a` or https://example.test/b"
            ),
            ["See https://example.test/a or https://example.test/b"]
        );
    }

    #[test]
    fn blocks_and_line_breaks_end_segments() {
        assert_eq!(
            shown(
                "assistant_message",
                "One\ntwo\n\n- three\n- four\n\n```\nfn a()\n```"
            ),
            ["One two", "three", "four", "fn a()\n"]
        );
        // A user's line break shows, so it ends a segment; HTML shows as typed.
        assert_eq!(
            shown("user_message", "One\ntwo <b>x</b>"),
            ["One", "two <b>x</b>"]
        );
        assert_eq!(
            shown("assistant_message", "a ~b~ | c\n--|--\nd | e"),
            ["a b", "c", "d", "e"]
        );
        assert_eq!(shown("user_message", "a ~/b ~/c"), ["a ~/b ~/c"]);
        // A user's single tilde stays; an assistant's strikes.
        assert_eq!(shown("user_message", "~x~ and ~~y~~"), ["~x~ and y"]);
        assert_eq!(shown("assistant_message", "~x~ and ~~y~~"), ["x and y"]);
        assert!(shown("assistant_message", "![alt text](x.png)").is_empty());
        assert!(shown("dynamic_tool", "text").is_empty());
    }

    /// `proposedPlanTitle` and `stripDisplayedPlanMarkdown`.
    #[test]
    fn a_plan_shows_its_title_and_the_body_after_a_summary_heading() {
        assert_eq!(
            shown("proposed_plan", "# Plan\n\n## Summary\n\nDo it\n"),
            ["Plan", "Do it"]
        );
        assert_eq!(
            shown("proposed_plan", "Just text"),
            ["Proposed plan", "Just text"]
        );
        assert_eq!(
            shown("proposed_plan", "Intro\n    # not a heading\n### Title"),
            ["Title", "Intro # not a heading", "Title"]
        );
        assert_eq!(heading("####### x"), None);
        assert_eq!(heading("#"), None);
        assert_eq!(heading("# "), Some(""));
    }

    // The cases below were recorded from `threadFindText.ts` (remark, remark-gfm,
    // remark-breaks, rehype-raw and rehype-sanitize) on the same input.

    /// `indexes nested disclosure summaries and bodies in rendered order`, and the rest of the
    /// HTML an assistant writes: tags hide, block tags end a segment, `<script>` hides its text.
    #[test]
    fn an_assistants_html_shows_its_text() {
        let assistant = |text| shown("assistant_message", text);
        assert_eq!(
            assistant(
                "<details><summary>Outer</summary><p>first</p><details><summary>Inner</summary><p>second</p></details></details>"
            ),
            ["Outer", "first", "Inner", "second"]
        );
        assert_eq!(
            assistant("<div>block html</div>\n\nafter"),
            ["block html", "after"]
        );
        assert_eq!(assistant("Hello <b>bold</b> world"), ["Hello bold world"]);
        assert_eq!(assistant("<div>a<br>b</div>"), ["a", "b"]);
        assert_eq!(
            assistant("<div\n  class=\"a\">a &amp; b &#33; &copy;</div>"),
            ["a & b ! ©"]
        );
        assert_eq!(
            assistant("<div>\nline one\nline two\n</div>"),
            [" line one line two "]
        );
        assert_eq!(assistant("a <script>x()</script> b"), ["a  b"]);
        assert_eq!(assistant("a <!-- hidden --> b"), ["a  b"]);
        // A user's HTML shows as typed, its lines joined as one.
        assert_eq!(
            shown("user_message", "a\n<div>\nb\n</div>"),
            ["a", "<div> b </div>"]
        );
    }

    /// GFM footnotes: a reference shows its number, and the definitions follow the message
    /// under a `Footnotes` heading, in reference order, each with its back-references.
    #[test]
    fn footnotes_show_numbers_and_a_footnotes_section() {
        let assistant = |text| shown("assistant_message", text);
        assert_eq!(
            assistant("Text with note[^1].\n\n[^1]: The footnote body."),
            ["Text with note1.", "Footnotes", "The footnote body. ↩"]
        );
        assert_eq!(
            assistant("A[^b] and C[^a] and again[^b].\n\n[^a]: Alpha.\n[^b]: Beta.\n[^c]: Unused."),
            [
                "A1 and C2 and again1.",
                "Footnotes",
                "Beta. ↩ ↩2",
                "Alpha. ↩"
            ]
        );
        assert_eq!(
            assistant("Ref[^1].\n\n[^1]: First para.\n\n    Second para."),
            ["Ref1.", "Footnotes", "First para.", "Second para. ↩"]
        );
        assert_eq!(
            assistant("Ref[^X].\n\n[^x]: Case."),
            ["Ref1.", "Footnotes", "Case. ↩"]
        );
        assert_eq!(
            assistant("Undefined[^nope] ref."),
            ["Undefined[^nope] ref."]
        );
        assert_eq!(
            shown("proposed_plan", "# Plan\n\nNote[^1]\n\n[^1]: Foot."),
            ["Plan", "Note1", "Footnotes", "Foot. ↩"]
        );
    }

    /// GFM autolink literals show their URL as the link text.
    #[test]
    fn bare_autolinks_show_their_url() {
        assert_eq!(
            shown(
                "assistant_message",
                "Visit https://example.com/path or www.example.org now"
            ),
            ["Visit https://example.com/path or www.example.org now"]
        );
        assert_eq!(
            shown(
                "user_message",
                "Mail me@example.com or see www.x.org/a?b=1, <https://example.com/x>."
            ),
            ["Mail me@example.com or see www.x.org/a?b=1, https://example.com/x."]
        );
    }

    /// An image shows no text, alone, in a link, or in a list item.
    #[test]
    fn a_standalone_image_shows_no_text() {
        let assistant = |text| shown("assistant_message", text);
        assert!(assistant("![alt text](x.png)").is_empty());
        assert!(shown("user_message", "![alt text](x.png)").is_empty());
        assert!(assistant("![alt](https://example.com/y.png \"Title\")").is_empty());
        assert_eq!(
            assistant("Text\n\n![shot](/tmp/shot.png)\n\nMore"),
            ["Text", "More"]
        );
        assert_eq!(assistant("[label ![i](x.png)](https://l)"), ["label "]);
        assert_eq!(assistant("- ![shot](a.png)\n- text"), ["text"]);
    }

    /// CRLF line endings read as LF.
    #[test]
    fn crlf_line_endings_read_as_lf() {
        let assistant = |text| shown("assistant_message", text);
        assert_eq!(assistant("One\r\ntwo\r\n\r\nthree"), ["One two", "three"]);
        assert_eq!(shown("user_message", "Hi\r\nthere"), ["Hi", "there"]);
        assert_eq!(
            assistant("Ref[^1].\r\n\r\n[^1]: Body.\r\n"),
            ["Ref1.", "Footnotes", "Body. ↩"]
        );
        assert_eq!(
            assistant("<div>\r\nline one\r\nline two\r\n</div>"),
            [" line one line two "]
        );
        assert_eq!(
            shown("proposed_plan", "# Plan\r\n\r\n## Summary\r\n\r\nDo it\r\n"),
            ["Plan", "Do it"]
        );
    }
}
