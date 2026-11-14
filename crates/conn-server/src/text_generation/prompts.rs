//! The thread title prompt and its reply, as `packages/provider-core` builds and reads them:
//! `buildThreadTitlePrompt` (`textGenerationPrompts.ts`), `formatThreadTitleContext` and
//! `limitTitleMessage` (`threadTitleContext.ts`), `sanitizeThreadTitle`
//! (`textGenerationUtils.ts`), `extractJsonObject` (`packages/shared/src/schemaJson.ts`) and
//! the output schema `{ title, needsRefinement }`.
//!
//! The prompt texts come from the monorepo (`generated.rs`, by `tools/gen-upstream.mjs`).
//! Lengths are UTF-16 units, as in JavaScript. `crates/conn-server/tools/textgen-diff.mjs`
//! runs the T3 functions and these on the same cases and fails when they differ.

use serde_json::Value;

use super::js::{self, char_code_at, is_high_surrogate, is_low_surrogate, len16, slice16};

#[path = "generated.rs"]
mod generated;
use generated::Part;

/// `EARLIER_CONTENT_TRUNCATION_MARKER` and `OMITTED`.
const OMITTED: &str = "[Earlier content truncated]\n\n";
/// `TRUNCATED` in `threadTitleContext.ts`.
const TRUNCATED: &str = "\n[Content truncated]\n";
/// `MAX_CONTEXT` and `MAX_MESSAGE`.
const MAX_CONTEXT: i64 = 8_000;
const MAX_MESSAGE: i64 = 2_000;
/// `MAX_THREAD_TITLE_CHARS`.
const MAX_THREAD_TITLE_CHARS: usize = 120;
/// `ATTACHMENT_ONLY_BOOTSTRAP_PROMPT` (`packages/shared/src/composerContextReferences.ts`).
const ATTACHMENT_ONLY_BOOTSTRAP_PROMPT: &str = "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]";

/// One attached file, as the prompt names it.
#[derive(Clone, Debug, PartialEq)]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    /// The number as the message stores it (`sizeBytes`).
    pub size_bytes: Value,
}

/// One message of a thread, for `formatThreadTitleContext`.
#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    /// `user`, `assistant`, `system` or `reasoning`.
    pub role: String,
    pub text: String,
    pub attachments: Vec<Attachment>,
}

/// `ThreadTitlePromptInput` without the parts this server does not build (a fork's source
/// and linked source control context).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TitlePromptInput {
    pub message: String,
    pub project_title: Option<String>,
    /// Set when the user asked to regenerate the title.
    pub previous_title: Option<String>,
    pub attachments: Vec<Attachment>,
    /// The `threadTitleInstructions` setting.
    pub instructions: Option<String>,
}

/// JavaScript's `\s`: Unicode white space and U+FEFF, without U+0085.
fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// `String.prototype.trim`.
pub fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_space)
}

/// `isAttachmentOnlyBootstrapPrompt`: the text a client sends for files without a message.
pub fn is_attachment_only_bootstrap_prompt(text: &str) -> bool {
    // `/^Ultrathink:\s*/i`.
    let rest = match text.get(..11) {
        Some(head) if head.eq_ignore_ascii_case("ultrathink:") => text
            .get(11..)
            .unwrap_or_default()
            .trim_start_matches(is_js_space),
        _ => text,
    };
    rest == ATTACHMENT_ONLY_BOOTSTRAP_PROMPT
}

/// `limitSection`.
pub fn limit_section(value: &str, max_chars: usize) -> String {
    if len16(value) <= max_chars {
        return value.to_owned();
    }
    let end = if is_high_surrogate(char_code_at(value, max_chars.saturating_sub(1))) {
        max_chars - 1
    } else {
        max_chars
    };
    format!("{}\n\n[truncated]", slice16(value, 0, end))
}

/// `limitTitleMessage`: the head and the tail of `text` within `budget` units.
pub fn limit_title_message(text: &str, budget: i64) -> String {
    let length = i64::try_from(len16(text)).unwrap_or(i64::MAX);
    if length <= budget {
        return text.to_owned();
    }
    let marker = i64::try_from(len16(TRUNCATED)).unwrap_or_default();
    if budget <= marker {
        return String::new();
    }
    let available = budget - marker;
    let mut head = (available + 1) / 2;
    let mut tail = available - head;
    if head > 0 && is_high_surrogate(char_code_at(text, usize::try_from(head - 1).unwrap_or(0))) {
        head -= 1;
    }
    if tail > 0
        && is_low_surrogate(char_code_at(
            text,
            usize::try_from(length - tail).unwrap_or(0),
        ))
    {
        tail -= 1;
    }
    let head = usize::try_from(head).unwrap_or(0);
    let tail = usize::try_from(tail).unwrap_or(0);
    let units = len16(text);
    let end = if tail > 0 {
        slice16(text, units - tail, units)
    } else {
        String::new()
    };
    format!("{}{TRUNCATED}{end}", slice16(text, 0, head))
}

/// `preserveMessageEnd`.
fn preserve_message_end(message: &str) -> String {
    let already = message.starts_with(OMITTED);
    let contents = if already {
        message.get(OMITTED.len()..).unwrap_or_default()
    } else {
        message
    };
    let units = len16(contents);
    if !already && units <= 8_000 {
        return contents.to_owned();
    }
    format!(
        "{OMITTED}{}",
        slice16(contents, units.saturating_sub(8_000), units)
    )
}

/// `policyInstruction`.
fn policy_instruction(instruction: Option<&str>) -> Vec<String> {
    match instruction.map(js_trim).filter(|i| !i.is_empty()) {
        Some(trimmed) => vec![
            String::new(),
            "Additional instructions:".to_owned(),
            limit_section(trimmed, 20_000),
        ],
        None => Vec::new(),
    }
}

fn number_text(value: &Value) -> String {
    match value {
        Value::Number(n) => match (n.as_u64(), n.as_i64(), n.as_f64()) {
            (Some(u), _, _) => u.to_string(),
            (_, Some(i), _) => i.to_string(),
            (_, _, Some(f)) if f.fract() == 0.0 && f.abs() < 1e21 => format!("{f:.0}"),
            _ => n.to_string(),
        },
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn attachment_lines(attachments: &[Attachment]) -> Vec<String> {
    attachments
        .iter()
        .map(|a| {
            format!(
                "- {} ({}, {} bytes)",
                a.name,
                a.mime_type,
                number_text(&a.size_bytes)
            )
        })
        .collect()
}

/// `threadTitlePromptSuffix`, without linked context.
fn prompt_suffix(input: &TitlePromptInput) -> String {
    let mut suffix = String::new();
    let additional = policy_instruction(input.instructions.as_deref());
    if !additional.is_empty() {
        suffix.push('\n');
        suffix.push_str(&additional.join("\n"));
    }
    let lines = attachment_lines(&input.attachments);
    if !lines.is_empty() {
        suffix.push_str("\n\nAttachment metadata:\n");
        suffix.push_str(&limit_section(&lines.join("\n"), 4_000));
    }
    suffix
}

/// `buildThreadTitlePrompt`.
pub fn thread_title_prompt(input: &TitlePromptInput) -> String {
    let project = input
        .project_title
        .as_deref()
        .map(js_trim)
        .filter(|p| !p.is_empty());
    let (parts, message) = match (&input.previous_title, project) {
        (None, Some(_)) => (
            generated::INITIAL_WITH_PROJECT,
            limit_title_message(&input.message, 8_000),
        ),
        (None, None) => (
            generated::INITIAL_WITHOUT_PROJECT,
            limit_title_message(&input.message, 8_000),
        ),
        (Some(_), Some(_)) => (
            generated::REGENERATE_WITH_PROJECT,
            preserve_message_end(&input.message),
        ),
        (Some(_), None) => (
            generated::REGENERATE_WITHOUT_PROJECT,
            preserve_message_end(&input.message),
        ),
    };
    let mut prompt = String::new();
    for part in parts {
        match part {
            Part::Text(text) => prompt.push_str(text),
            Part::Project => prompt.push_str(&js::json_string(project.unwrap_or_default())),
            Part::Previous => prompt.push_str(&js::json_string(
                input.previous_title.as_deref().unwrap_or_default(),
            )),
            Part::Message => prompt.push_str(&message),
        }
    }
    prompt.push_str(&prompt_suffix(input));
    prompt
}

struct Section<'a> {
    message: &'a Message,
    prefix: String,
    contents: String,
}

/// `formatThreadTitleContext`: the thread's messages within 8,000 units, the first and the
/// latest user messages first, and the attachments to name. Assistant citation links become
/// their quoted text (`assistantCitationsToPlainText`).
pub fn format_thread_title_context(messages: &[Message]) -> (String, Vec<Attachment>) {
    let sections: Vec<Section<'_>> = messages
        .iter()
        .filter_map(|message| {
            let text = if is_attachment_only_bootstrap_prompt(&message.text) {
                ""
            } else {
                message.text.as_str()
            };
            if message.role == "system"
                || message.role == "reasoning"
                || (js_trim(text).is_empty() && message.attachments.is_empty())
            {
                return None;
            }
            let names = message
                .attachments
                .iter()
                .map(|a| a.name.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            let plain = super::citations::assistant_citations_to_plain_text(text);
            let trimmed = js_trim(&plain);
            let mut parts = Vec::new();
            if !trimmed.is_empty() {
                parts.push(trimmed.to_owned());
            }
            if !names.is_empty() {
                parts.push(format!("[Attachments: {names}]"));
            }
            Some(Section {
                message,
                prefix: format!("{}:\n", message.role.to_uppercase()),
                contents: parts.join("\n"),
            })
        })
        .collect();
    let units = |s: &str| i64::try_from(len16(s)).unwrap_or(i64::MAX);
    let mut selected: Vec<Option<String>> = vec![None; sections.len()];
    let mut remaining = MAX_CONTEXT - units(OMITTED);
    let marker = units(TRUNCATED);
    let add =
        |index: usize, budget: i64, selected: &mut Vec<Option<String>>, remaining: &mut i64| {
            let Some(section) = sections.get(index) else {
                return;
            };
            if selected.get(index).is_some_and(Option::is_some) {
                return;
            }
            let limit = budget.min(*remaining) - units(&section.prefix) - 2;
            if limit <= marker {
                return;
            }
            let contents = limit_title_message(&section.contents, limit);
            if contents.is_empty() {
                return;
            }
            let text = format!("{}{contents}", section.prefix);
            *remaining -= units(&text) + 2;
            if let Some(slot) = selected.get_mut(index) {
                *slot = Some(text);
            }
        };
    let first_user = sections.iter().position(|s| s.message.role == "user");
    if let Some(first) = first_user {
        add(first, MAX_MESSAGE, &mut selected, &mut remaining);
    }
    for index in (0..sections.len()).rev() {
        if sections
            .get(index)
            .is_some_and(|s| s.message.role == "user")
        {
            let budget = MAX_MESSAGE.min(remaining - 2_000);
            add(index, budget, &mut selected, &mut remaining);
        }
    }
    for index in (0..sections.len()).rev() {
        if sections
            .get(index)
            .is_some_and(|s| s.message.role == "assistant")
        {
            add(index, MAX_MESSAGE, &mut selected, &mut remaining);
        }
    }
    for role in ["user", "assistant"] {
        for index in (0..sections.len()).rev() {
            let (Some(section), Some(Some(previous))) = (sections.get(index), selected.get(index))
            else {
                continue;
            };
            if section.message.role != role {
                continue;
            }
            let budget = units(previous) + remaining - units(&section.prefix);
            let expanded = format!(
                "{}{}",
                section.prefix,
                limit_title_message(&section.contents, budget)
            );
            remaining -= units(&expanded) - units(previous);
            if let Some(slot) = selected.get_mut(index) {
                *slot = Some(expanded);
            }
        }
    }
    let retained: Vec<usize> = (0..sections.len())
        .filter(|&i| selected.get(i).is_some_and(Option::is_some))
        .collect();
    let truncated = retained.iter().any(|&i| {
        let full = sections
            .get(i)
            .map(|s| format!("{}{}", s.prefix, s.contents));
        selected.get(i).cloned().flatten() != full
    });
    let joined = retained
        .iter()
        .filter_map(|&i| selected.get(i).cloned().flatten())
        .collect::<Vec<_>>()
        .join("\n\n");
    let message = if truncated || retained.len() < sections.len() {
        format!("{OMITTED}{joined}")
    } else {
        joined
    };
    let attachments: Vec<&Attachment> = retained
        .iter()
        .filter_map(|&i| sections.get(i))
        .flat_map(|s| s.message.attachments.iter())
        .collect();
    let first_attachment = first_user
        .and_then(|i| sections.get(i))
        .and_then(|s| s.message.attachments.first());
    let recent: Vec<&Attachment> = attachments
        .into_iter()
        .filter(|a| first_attachment.is_none_or(|first| a.id != first.id))
        .collect();
    let keep = if first_attachment.is_some() { 3 } else { 4 };
    let mut chosen: Vec<Attachment> = first_attachment.into_iter().cloned().collect();
    chosen.extend(
        recent
            .iter()
            .skip(recent.len().saturating_sub(keep))
            .map(|a| (*a).clone()),
    );
    (message, chosen)
}

/// `sanitizeThreadTitle`.
pub fn sanitize_thread_title(raw: &str) -> String {
    let decoded = serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| v.get("title").and_then(Value::as_str).map(str::to_owned));
    let title = decoded.as_deref().unwrap_or(raw);
    let first_line = js_trim(title).split('\n').next().unwrap_or_default();
    let first_line = first_line.strip_suffix('\r').unwrap_or(first_line);
    let quotes = |c: char| matches!(c, '\'' | '"' | '`');
    let unquoted = js_trim(first_line).trim_matches(quotes);
    let mut normalized = String::new();
    let mut in_space = false;
    for c in js_trim(unquoted).chars() {
        if is_js_space(c) {
            if !in_space {
                normalized.push(' ');
            }
            in_space = true;
        } else {
            normalized.push(c);
            in_space = false;
        }
    }
    if js_trim(&normalized).is_empty() {
        return "New thread".to_owned();
    }
    if len16(&normalized) <= MAX_THREAD_TITLE_CHARS {
        return normalized;
    }
    let mut end = MAX_THREAD_TITLE_CHARS - 3;
    if is_high_surrogate(char_code_at(&normalized, end - 1))
        && is_low_surrogate(char_code_at(&normalized, end))
    {
        end -= 1;
    }
    let cut = slice16(&normalized, 0, end);
    format!("{}...", cut.trim_end_matches(is_js_space))
}

/// `extractJsonObject`: the first balanced `{…}` of a reply, else the trimmed reply.
pub fn extract_json_object(raw: &str) -> String {
    let trimmed = js_trim(raw);
    let Some(start) = trimmed.find('{') else {
        return trimmed.to_owned();
    };
    let mut depth = 0i64;
    let mut in_string = false;
    let mut escaping = false;
    for (offset, c) in trimmed.get(start..).unwrap_or_default().char_indices() {
        if in_string {
            if escaping {
                escaping = false;
            } else if c == '\\' {
                escaping = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    let end = start + offset + 1;
                    return trimmed.get(start..end).unwrap_or_default().to_owned();
                }
            }
            _ => {}
        }
    }
    trimmed.get(start..).unwrap_or_default().to_owned()
}

/// The decoded title reply: `{ title: string, needsRefinement?: boolean }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TitleReply {
    pub title: String,
    pub needs_refinement: bool,
}

/// `decodeJsonReply` with the title schema; `None` is "returned invalid structured output".
pub fn decode_title_reply(text: &str) -> Option<TitleReply> {
    let value: Value = serde_json::from_str(&extract_json_object(text)).ok()?;
    let title = value.get("title")?.as_str()?.to_owned();
    let needs_refinement = match value.get("needsRefinement") {
        None => false,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => return None,
    };
    Some(TitleReply {
        title,
        needs_refinement,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_titles_as_the_t3_server() {
        assert_eq!(
            sanitize_thread_title("  \"Fix   login\"\nmore"),
            "Fix login"
        );
        assert_eq!(sanitize_thread_title("{\"title\":\"`Hello`\"}"), "Hello");
        assert_eq!(sanitize_thread_title("   "), "New thread");
        let long = "word ".repeat(40);
        let title = sanitize_thread_title(&long);
        assert!(title.ends_with("..."));
        assert!(len16(&title) <= 120);
    }

    #[test]
    fn extracts_the_first_object() {
        assert_eq!(
            extract_json_object("Sure! {\"title\": \"a}b\"} trailing"),
            "{\"title\": \"a}b\"}"
        );
        assert_eq!(extract_json_object("  no json "), "no json");
        assert_eq!(
            decode_title_reply("```json\n{\"title\":\"X\",\"needsRefinement\":true}\n```"),
            Some(TitleReply {
                title: "X".into(),
                needs_refinement: true
            })
        );
        assert_eq!(decode_title_reply("{\"title\":1}"), None);
    }

    #[test]
    fn limits_messages_in_the_middle() {
        let text = "a".repeat(100);
        let limited = limit_title_message(&text, 50);
        assert_eq!(len16(&limited), 50);
        assert!(limited.contains(TRUNCATED));
        assert_eq!(limit_title_message(&text, 10), "");
    }

    #[test]
    fn bootstrap_prompts_are_recognized() {
        assert!(is_attachment_only_bootstrap_prompt(
            ATTACHMENT_ONLY_BOOTSTRAP_PROMPT
        ));
        assert!(is_attachment_only_bootstrap_prompt(&format!(
            "ULTRATHINK:\n{ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}"
        )));
        assert!(!is_attachment_only_bootstrap_prompt("hello"));
    }
}
