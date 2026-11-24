//! Review comments a user sent with a message.
//!
//! A comment reaches the client in one of two forms:
//! - a `review-comment` record in the message's `context.records`, with its place in the text
//!   marked by `[label](t3-context://v1/review-comment/<id>)`;
//! - a legacy `<review_comment ...>` block inside the text itself, as
//!   `packages/shared/src/composerContextLegacy.ts` (`upgradeLegacyContextMessage`) reads it.
//!
//! Both end up as [`ReviewComment`]s. The words around them stay the message's own prose.

use conn_contract::OrchestrationMessageContext;

const LINK_HREF: &str = "(t3-context://v1/review-comment/";
const LEGACY_OPEN: &str = "<review_comment";
const LEGACY_CLOSE: &str = "</review_comment>";
/// Context blocks that own their payload: a review-shaped text inside one is not a comment.
const OTHER_CONTEXT_BLOCKS: [&str; 3] =
    ["terminal_context", "element_context", "preview_annotation"];

/// A review comment: the diff lines the user quoted and their note on them.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ReviewComment {
    pub file_path: String,
    /// The stored range, such as `L12`, `L3 to L9`, `+12` or `-4 to -6`.
    pub range_label: String,
    /// The user's own note on the quote. May be empty.
    pub text: String,
    /// The quoted lines. May be empty.
    pub diff: String,
    /// The fence language of `diff`, when the comment names one.
    pub fence_language: Option<String>,
}

impl ReviewComment {
    /// `app.rs · #12`: the file name and the line (or range) it points at.
    #[must_use]
    pub fn label(&self) -> String {
        let name = self
            .file_path
            .rsplit(['/', '\\'])
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or(&self.file_path);
        let line = self
            .range_label
            .trim()
            .split(" to ")
            .map(|part| {
                let part = part.trim();
                part.strip_prefix('+')
                    .or_else(|| part.strip_prefix('L'))
                    .unwrap_or(part)
            })
            .collect::<Vec<_>>()
            .join(" to ");
        if line.is_empty() {
            name.to_owned()
        } else {
            format!("{name} · #{line}")
        }
    }
}

/// Every review comment of a message: the context records first, then legacy blocks in the text.
/// A comment that repeats another one in every field is kept once.
pub(crate) fn review_comments_for_message(
    context: Option<&OrchestrationMessageContext>,
    text: &str,
) -> Vec<ReviewComment> {
    let mut comments = Vec::new();
    let mut keep = |comment: ReviewComment| {
        if !comments.contains(&comment) {
            comments.push(comment);
        }
    };
    if let Some(context) = context {
        context
            .records
            .iter()
            .filter(|record| {
                record.get("kind").and_then(|kind| kind.as_str()) == Some("review-comment")
            })
            .filter_map(|record| {
                let field = |key: &str| record.get(key).and_then(|value| value.as_str());
                let file_path = field("filePath")?.trim();
                let range_label = field("rangeLabel")?;
                if file_path.is_empty() {
                    return None;
                }
                Some(ReviewComment {
                    file_path: file_path.to_owned(),
                    range_label: range_label.to_owned(),
                    text: field("text").unwrap_or_default().trim().to_owned(),
                    diff: field("diff")
                        .unwrap_or_default()
                        .trim_end_matches('\n')
                        .to_owned(),
                    fence_language: field("fenceLanguage")
                        .map(str::trim)
                        .filter(|language| !language.is_empty())
                        .map(str::to_owned),
                })
            })
            .for_each(&mut keep);
    }
    legacy_blocks(text)
        .into_iter()
        .filter_map(|block| block.comment)
        .for_each(&mut keep);
    comments
}

/// `text` without the places its review comments sat: the inline
/// `[label](t3-context://v1/review-comment/<id>)` links and the legacy `<review_comment>` blocks.
/// What is left is the message's own prose, trimmed.
#[must_use]
pub fn text_without_review_comments(text: &str) -> String {
    let mut without_blocks = String::with_capacity(text.len());
    let mut rest = 0;
    for block in legacy_blocks(text) {
        if block.comment.is_some() {
            without_blocks.push_str(&text[rest..block.start]);
            rest = block.end;
        }
    }
    without_blocks.push_str(&text[rest..]);
    strip_links(&without_blocks).trim().to_owned()
}

fn strip_links(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(href_at) = rest.find(LINK_HREF) {
        let (before, from_href) = rest.split_at(href_at);
        // The label is `[...]` right before the `(`, on one line.
        let label_start = before.strip_suffix(']').and_then(|head| {
            let open = head.rfind('[')?;
            let label = &head[open + 1..];
            (!label.contains(['[', ']', '\n'])).then_some(open)
        });
        match (label_start, from_href.find(')')) {
            (Some(open), Some(close)) => {
                out.push_str(&before[..open]);
                rest = &from_href[close + 1..];
            }
            _ => {
                // Not a link: keep the text up to and including the marker, then go on.
                let keep = href_at + LINK_HREF.len();
                out.push_str(&rest[..keep]);
                rest = &rest[keep..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// One `<review_comment>` block of a text: its byte range and the comment it holds, when valid.
struct LegacyBlock {
    start: usize,
    end: usize,
    comment: Option<ReviewComment>,
}

/// The legacy review blocks of `text`, in order. Blocks inside another context block are skipped.
/// A block that never closes ends the scan, and the rest stays text (as in the web reader).
fn legacy_blocks(text: &str) -> Vec<LegacyBlock> {
    let mut blocks = Vec::new();
    if !text.contains(LEGACY_OPEN) {
        return blocks;
    }
    let mut pos = 0;
    while pos < text.len() {
        let next_review = find_review_open(text, pos);
        let next_other = find_other_block(text, pos);
        match (next_review, next_other) {
            (_, Some((other_start, other_end)))
                if next_review.is_none_or(|r| other_start < r.0) =>
            {
                pos = other_end.max(other_start + 1);
            }
            (Some((open_at, attrs_end)), _) => {
                let Some(end) = block_end(text, attrs_end + 1) else {
                    break;
                };
                let attrs = &text[open_at + LEGACY_OPEN.len()..attrs_end];
                let body = &text[attrs_end + 1..end.body_end];
                blocks.push(LegacyBlock {
                    start: open_at,
                    end: end.block_end,
                    comment: legacy_comment(attrs, body),
                });
                pos = end.block_end;
            }
            (None, _) => break,
        }
    }
    blocks
}

/// `<review_comment\b[^>]*>` at or after `from`: where it opens and where its `>` is.
fn find_review_open(text: &str, from: usize) -> Option<(usize, usize)> {
    let mut search = from;
    while let Some(found) = text[search..].find(LEGACY_OPEN) {
        let open_at = search + found;
        let after = open_at + LEGACY_OPEN.len();
        let boundary = text[after..]
            .chars()
            .next()
            .is_none_or(|c| !(c.is_alphanumeric() || c == '_'));
        if boundary && let Some(gt) = text[after..].find('>') {
            return Some((open_at, after + gt));
        }
        search = after;
    }
    None
}

/// The first `<terminal_context>`-style block at or after `from`, opened at a line start and
/// closed by `\n</name>`: its byte range.
fn find_other_block(text: &str, from: usize) -> Option<(usize, usize)> {
    OTHER_CONTEXT_BLOCKS
        .iter()
        .filter_map(|name| {
            let open = format!("<{name}>\n");
            let close = format!("\n</{name}>");
            let mut search = from;
            while let Some(found) = text[search..].find(&open) {
                let open_at = search + found;
                if open_at == 0 || text.as_bytes()[open_at - 1] == b'\n' {
                    let body_from = open_at + open.len() - 1;
                    if let Some(end) = text[body_from..].find(&close) {
                        return Some((open_at, body_from + end + close.len()));
                    }
                }
                search = open_at + 1;
            }
            None
        })
        .min_by_key(|range| range.0)
}

struct BlockEnd {
    /// Where the body stops (before `</review_comment>`).
    body_end: usize,
    /// Where the block stops (after `</review_comment>`).
    block_end: usize,
}

/// Finds the `</review_comment>` that closes a block whose body starts at `body_start`. A code
/// fence in the body hides any closing tag inside it, and a fence closes only with a line of at
/// least as many backticks and no info text.
fn block_end(text: &str, body_start: usize) -> Option<BlockEnd> {
    let mut fence = 0usize;
    let mut line_start = body_start;
    while line_start <= text.len() {
        let line_end = text[line_start..]
            .find('\n')
            .map_or(text.len(), |at| line_start + at);
        let line = &text[line_start..line_end];
        let ticks = line.chars().take_while(|c| *c == '`').count();
        if ticks >= 3 {
            let info = &line[ticks..];
            if fence == 0 {
                fence = ticks;
            } else if ticks >= fence && info.trim().is_empty() {
                fence = 0;
            }
        } else if fence == 0
            && let Some(at) = line.find(LEGACY_CLOSE)
        {
            return Some(BlockEnd {
                body_end: line_start + at,
                block_end: line_start + at + LEGACY_CLOSE.len(),
            });
        }
        if line_end >= text.len() {
            return None;
        }
        line_start = line_end + 1;
    }
    None
}

fn unescape_attribute(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
}

/// `name="value"` pairs of a block's opening tag.
fn attributes(raw: &str) -> Vec<(&str, String)> {
    let mut pairs = Vec::new();
    let mut rest = raw;
    while let Some(eq) = rest.find("=\"") {
        let name_start = rest[..eq]
            .rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
            .map_or(0, |at| at + 1);
        let name = &rest[name_start..eq];
        let value_from = eq + 2;
        let Some(close) = rest[value_from..].find('"') else {
            break;
        };
        if name.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
            pairs.push((
                name,
                unescape_attribute(&rest[value_from..value_from + close]),
            ));
        }
        rest = &rest[value_from + close + 1..];
    }
    pairs
}

/// The comment of a legacy block, or `None` when it lacks what the web reader requires: a file,
/// a section, and numeric start and end indexes.
fn legacy_comment(raw_attributes: &str, raw_body: &str) -> Option<ReviewComment> {
    let attrs = attributes(raw_attributes);
    let get = |name: &str| {
        attrs
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.as_str())
    };
    let file_path = get("filePath")?.trim();
    let section_id = get("sectionId")?.trim();
    let numeric = |name: &str| {
        get(name).filter(|value| !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()))
    };
    numeric("startIndex")?;
    numeric("endIndex")?;
    if file_path.is_empty() || section_id.is_empty() {
        return None;
    }
    let range_label = get("rangeLabel")
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .unwrap_or("line");
    let fence = last_fence(raw_body);
    let text = fence
        .as_ref()
        .map_or(raw_body, |fence| &raw_body[..fence.start])
        .trim();
    Some(ReviewComment {
        file_path: file_path.to_owned(),
        range_label: range_label.to_owned(),
        text: text.to_owned(),
        diff: fence
            .as_ref()
            .map(|fence| fence.content.clone())
            .unwrap_or_default(),
        fence_language: Some(
            fence
                .map(|fence| fence.language)
                .filter(|language| !language.is_empty())
                .unwrap_or_else(|| "diff".to_owned()),
        ),
    })
}

struct Fence {
    start: usize,
    language: String,
    content: String,
}

/// The last ```` ```lang\n...\n``` ```` fence of `body`, as the web `REVIEW_FENCE` finds it: the
/// closing line repeats the opening backticks exactly (a longer run also closes it).
fn last_fence(body: &str) -> Option<Fence> {
    let bytes = body.as_bytes();
    let mut last = None;
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'`' {
            at += 1;
            continue;
        }
        let run = bytes[at..].iter().take_while(|b| **b == b'`').count();
        let found = (3..=run).rev().find_map(|ticks| {
            let ticks_str = &body[at..at + ticks];
            let after = at + ticks;
            let language_len = body[after..]
                .find(|c: char| c.is_whitespace() || c == '`')
                .unwrap_or(body.len() - after);
            let language = &body[after..after + language_len];
            let line_end = body[after..].find('\n')? + after;
            let content_from = line_end + 1;
            let close = body[line_end..].find(&format!("\n{ticks_str}"))? + line_end;
            // `\n\1` may close at the empty line right after the info line.
            let content = if close < content_from {
                ""
            } else {
                &body[content_from..close]
            };
            Some((
                Fence {
                    start: at,
                    language: language.to_owned(),
                    content: content.to_owned(),
                },
                close + 1 + ticks,
            ))
        });
        match found {
            Some((fence, end)) => {
                last = Some(fence);
                at = end;
            }
            None => at += 1,
        }
    }
    last
}

#[cfg(test)]
mod tests {
    use super::*;

    fn comment(path: &str, range: &str) -> ReviewComment {
        ReviewComment {
            file_path: path.to_owned(),
            range_label: range.to_owned(),
            text: String::new(),
            diff: String::new(),
            fence_language: None,
        }
    }

    #[test]
    fn labels_name_the_file_and_the_line() {
        assert_eq!(
            comment("a/b/lib.rs", "L3 to L9").label(),
            "lib.rs · #3 to 9"
        );
        assert_eq!(comment("lib.rs", "+12").label(), "lib.rs · #12");
        assert_eq!(comment("lib.rs", "-4 to -6").label(), "lib.rs · #-4 to -6");
        assert_eq!(comment("lib.rs", "").label(), "lib.rs");
    }

    #[test]
    fn inline_links_leave_the_prose() {
        assert_eq!(
            text_without_review_comments(
                "See [a.rs L1](t3-context://v1/review-comment/r1) and more"
            ),
            "See  and more"
        );
        assert_eq!(
            text_without_review_comments("[keep](t3-context://v1/mention/m1) text"),
            "[keep](t3-context://v1/mention/m1) text"
        );
        assert_eq!(
            text_without_review_comments("[a.rs L1](t3-context://v1/review-comment/r1)"),
            "",
            "a message of one link has no prose"
        );
    }

    const LEGACY: &str = "Please look\n<review_comment filePath=\"src/a.rs\" sectionId=\"file:src/a.rs\" startIndex=\"3\" endIndex=\"4\" rangeLabel=\"L4 to L5\">\nKeep \"this\" here.\n```diff\n- a\n+ b\n</review_comment>\n```\n</review_comment>\nthanks";

    #[test]
    fn legacy_blocks_become_comments_and_leave_the_prose() {
        let comments = review_comments_for_message(None, LEGACY);
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].file_path, "src/a.rs");
        assert_eq!(comments[0].range_label, "L4 to L5");
        assert_eq!(comments[0].text, "Keep \"this\" here.");
        assert_eq!(
            comments[0].diff, "- a\n+ b\n</review_comment>",
            "a closing tag inside the fence is quote, not the end"
        );
        assert_eq!(comments[0].fence_language.as_deref(), Some("diff"));
        assert_eq!(
            text_without_review_comments(LEGACY),
            "Please look\n\nthanks"
        );
    }

    #[test]
    fn invalid_or_unclosed_legacy_blocks_stay_text() {
        let bad = "<review_comment filePath=\"a\">x</review_comment>";
        assert!(review_comments_for_message(None, bad).is_empty());
        assert_eq!(text_without_review_comments(bad), bad);
        let open =
            "<review_comment filePath=\"a\" sectionId=\"s\" startIndex=\"1\" endIndex=\"1\">x";
        assert!(review_comments_for_message(None, open).is_empty());
        assert_eq!(text_without_review_comments(open), open);
    }

    #[test]
    fn review_text_inside_another_context_block_is_not_a_comment() {
        let text = "hi\n<terminal_context>\n- t lines 1-2:\n<review_comment filePath=\"a\" sectionId=\"s\" startIndex=\"1\" endIndex=\"1\">x</review_comment>\n</terminal_context>";
        assert!(review_comments_for_message(None, text).is_empty());
    }
}
