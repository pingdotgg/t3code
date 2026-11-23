//! The text in-thread Find searches: the segments a message or plan shows once its Markdown
//! is rendered, as T3's `threadFindText.ts`. Emphasis and a link's label join the text around
//! them; a link's destination is not shown, so it is not searched. A block (paragraph,
//! heading, list item, table cell, code block, line break) ends a segment, so a phrase never
//! spans two.
//!
//! Not built: T3's file-link labels, citation cards, composer context chips, skill labels,
//! Codex directives, artifact templates, `★ Insight` blocks, and the HTML an assistant writes.
//! Find skips their text.

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
    for (event, range) in Parser::new_ext(markdown, options).into_offset_iter() {
        match event {
            Event::Start(Tag::Image { .. }) => in_image += 1,
            Event::End(TagEnd::Image) => in_image = in_image.saturating_sub(1),
            _ if in_image > 0 => {}
            // A code block keeps its lines.
            Event::Text(text) if in_code_block => out.text.push_str(&text),
            Event::Text(text) | Event::Code(text) => out.push(&text),
            Event::InlineHtml(html) | Event::Html(html) if role == Role::User => out.push(&html),
            Event::SoftBreak => out.push("\n"),
            Event::HardBreak | Event::Rule => out.flush(),
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
                out.flush();
            }
            // Inline markup (emphasis, strong, a link's label) joins; a link's destination,
            // a footnote's number, a task box and an assistant's HTML are not text.
            _ => {}
        }
    }
    out.flush();
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
}
