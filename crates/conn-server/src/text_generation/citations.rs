//! `assistantCitationsToPlainText` (`packages/shared/src/assistantCitations.ts`): a quote of
//! an earlier assistant reply, written as `[Assistant quote](t3-citation://v1/...)`, becomes
//! its text (and its comment) before a title prompt names it. A link that does not parse as a
//! citation stays as written.

use conn_support::url::{decode_uri_component, search_params};

use super::prompts::js_trim;

const LINK_START: &str = "[Assistant quote](";
const HREF_PREFIX: &str = "t3-citation://v1/";
const MAX_TEXT: usize = 8_000;
const MAX_COMMENT: usize = 8_000;
const CONTEXT: usize = 32;
const MAX_ID: usize = 4_096;
/// `MAX_CITATION_HREF_LENGTH`, in UTF-16 units.
const MAX_HREF: usize = 9 * (MAX_TEXT + MAX_COMMENT + 3 * MAX_ID + 2 * CONTEXT) + 1_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn units(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// JavaScript's `\s`.
fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// The plain text of one citation href, or `None` when `parseAssistantCitationHref` refuses
/// it.
fn plain_text(href: &str) -> Option<String> {
    if !href.starts_with(HREF_PREFIX) || units(href) > MAX_HREF {
        return None;
    }
    let rest = href.get(HREF_PREFIX.len()..)?;
    let (before_hash, hash) = rest.split_once('#').map_or((rest, ""), |(a, b)| (a, b));
    if !hash.is_empty() {
        return None;
    }
    let (path, query) = before_hash
        .split_once('?')
        .map_or((before_hash, ""), |(a, b)| (a, b));
    let parts: Vec<&str> = path.split('/').collect();
    let [environment, thread, message] = parts.as_slice() else {
        return None;
    };
    let params = search_params(query);
    let one = |key: &str| {
        let mut values = params.iter().filter(|(k, _)| k == key).map(|(_, v)| v);
        match (values.next(), values.next()) {
            (Some(value), None) => Some(value.clone()),
            _ => None,
        }
    };
    // `searchParams.get("comment")`: the first, when there is one.
    let comment = params
        .iter()
        .find(|(k, _)| k == "comment")
        .map(|(_, v)| v.clone());
    if params.len() != 5 + usize::from(comment.is_some()) {
        return None;
    }
    let text = one("text")?;
    let (start, end) = (one("start")?, one("end")?);
    let prefix = one("prefix")?;
    let suffix = one("suffix")?;
    let number = |value: &str| {
        (!value.is_empty() && value.len() <= 16 && value.bytes().all(|b| b.is_ascii_digit()))
            .then(|| value.parse::<u64>().ok())
            .flatten()
            .filter(|n| *n <= MAX_SAFE_INTEGER)
    };
    let (start, end) = (number(&start)?, number(&end)?);
    // The schema's checks (`AssistantCitation`).
    for id in [environment, thread, message] {
        let id = decode_uri_component(id)?;
        if js_trim(&id).is_empty() || units(&id) > MAX_ID {
            return None;
        }
    }
    if text.is_empty()
        || units(&text) > MAX_TEXT
        || js_trim(&text).is_empty()
        || comment.as_ref().is_some_and(|c| units(c) > MAX_COMMENT)
        || units(&prefix) > CONTEXT
        || units(&suffix) > CONTEXT
        || end <= start
    {
        return None;
    }
    Some(match comment {
        None => text,
        Some(comment) => format!("{text}\nComment: {comment}"),
    })
}

/// `assistantCitationsToPlainText`.
pub fn assistant_citations_to_plain_text(prompt: &str) -> String {
    let mut out = String::with_capacity(prompt.len());
    let mut rest = prompt;
    while let Some(at) = rest.find(LINK_START) {
        let (before, link) = rest.split_at(at);
        out.push_str(before);
        let after_start = link.get(LINK_START.len()..).unwrap_or("");
        // `\((t3-citation://v1/[^\s)]{1,N})\)`: the href, then `)`.
        let href_len = after_start
            .find(|c: char| c == ')' || is_js_space(c))
            .unwrap_or(after_start.len());
        let href = after_start.get(..href_len).unwrap_or("");
        let closes = after_start
            .get(href_len..)
            .is_some_and(|t| t.starts_with(')'));
        let matches = closes
            && href.starts_with(HREF_PREFIX)
            && href.len() > HREF_PREFIX.len()
            && units(href) - units(HREF_PREFIX) <= MAX_HREF - units(HREF_PREFIX);
        if matches {
            let source_len = LINK_START.len() + href_len + 1;
            match plain_text(href) {
                Some(text) => out.push_str(&text),
                None => out.push_str(link.get(..source_len).unwrap_or(link)),
            }
            rest = link.get(source_len..).unwrap_or("");
        } else {
            // No match here: move on by one character, as the regex scan does.
            let step = link.chars().next().map_or(1, char::len_utf8);
            out.push_str(link.get(..step).unwrap_or(link));
            rest = link.get(step..).unwrap_or("");
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::assistant_citations_to_plain_text as plain;

    const HREF: &str =
        "t3-citation://v1/env/thread-1/msg%201?text=Use+the+cache&start=3&end=17&prefix=a&suffix=b";

    #[test]
    fn citations_become_their_text_and_comment() {
        assert_eq!(
            plain(&format!("See [Assistant quote]({HREF}) now")),
            "See Use the cache now"
        );
        assert_eq!(
            plain(&format!("[Assistant quote]({HREF}&comment=Why%3F)")),
            "Use the cache\nComment: Why?"
        );
        // Not citations: they stay as written.
        for text in [
            format!("[Assistant quote]({})", HREF.replace("end=17", "end=2")),
            format!("[Assistant quote]({}&x=1)", HREF),
            format!(
                "[Assistant quote]({})",
                HREF.replace("text=Use+the+cache", "text=+")
            ),
            "[Assistant quote](https://example.com)".to_owned(),
            "[Assistant quote](t3-citation://v1/a b)".to_owned(),
            format!("[Assistant quote]({HREF}"),
            format!("[Assistant quote]({}#x)", HREF),
            format!("[Assistant quote]({})", HREF.replace("msg%201", "%E0")),
        ] {
            assert_eq!(plain(&text), text, "{text}");
        }
        assert_eq!(plain("plain €"), "plain €");
    }
}
