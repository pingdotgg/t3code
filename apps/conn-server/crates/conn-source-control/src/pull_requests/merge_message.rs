//! `removeAgentCredits` (`source-control-core/src/server/mergeMessage.ts`): drops coding-agent
//! co-author trailers and "Generated with" footers from a merge commit body, outside code.

const AGENT_EMAILS: [&str; 7] = [
    "noreply@anthropic.com",
    "claude@anthropic.com",
    "noreply@openai.com",
    "codex@openai.com",
    "cursoragent@cursor.com",
    "copilot@github.com",
    "noreply@github.com",
];

const AGENT_NAMES: [&str; 9] = [
    "claude code",
    "claude",
    "codex",
    "cursor",
    "github copilot",
    "copilot",
    "opencode",
    "grok",
    "antigravity",
];

const LINK_HOSTS: [&str; 10] = [
    "claude.ai",
    "claude.com",
    "www.anthropic.com",
    "chatgpt.com",
    "openai.com",
    "cursor.com",
    "github.com",
    "opencode.ai",
    "x.ai",
    "antigravity.google",
];

/// JavaScript's `\s` (and `trim`): ECMAScript white space and line terminators.
fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn strip_prefix_ignore_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| text.get(prefix.len()..).unwrap_or_default())
}

/// `isAgentAuthor`: a `Co-authored-by:` trailer naming a coding agent's address.
fn is_agent_author(text: &str) -> bool {
    let prefix = "co-authored-by:";
    if strip_prefix_ignore_case(text, prefix).is_none() || !text.ends_with('>') {
        return false;
    }
    let Some(email_start) = text.rfind('<') else {
        return false;
    };
    if email_start < prefix.len() {
        return false;
    }
    let email = text
        .get(email_start + 1..text.len() - 1)
        .unwrap_or_default()
        .to_lowercase();
    if !AGENT_EMAILS.contains(&email.as_str()) {
        return false;
    }
    // GitHub's generic noreply address is also used by people; require Copilot's name.
    if email != "noreply@github.com" {
        return true;
    }
    let name = text
        .get(prefix.len()..email_start)
        .unwrap_or_default()
        .trim_matches(js_space)
        .to_lowercase();
    name == "copilot" || name == "github copilot"
}

/// `\[([^[\]\r\n]+)\]\(https:\/\/(?:hosts)(?:\/[^\s)[\]]*)?\)` replaced by its label, globally.
fn unlink_agent_footers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    'scan: while let Some(open) = rest.find('[') {
        out.push_str(rest.get(..open).unwrap_or_default());
        let after = rest.get(open + 1..).unwrap_or_default();
        let label_end = after.find(['[', ']', '\r', '\n']).unwrap_or(after.len());
        if label_end > 0
            && let Some(tail) = after.get(label_end..)
            && let Some(tail) = tail.strip_prefix(']')
            && let Some(tail) = tail.strip_prefix('(')
            && let Some(tail) = strip_prefix_ignore_case(tail, "https://")
        {
            for host in LINK_HOSTS {
                let Some(mut end) = strip_prefix_ignore_case(tail, host) else {
                    continue;
                };
                if let Some(path) = end.strip_prefix('/') {
                    let stop = path
                        .find(|c: char| js_space(c) || matches!(c, ')' | '[' | ']'))
                        .unwrap_or(path.len());
                    end = path.get(stop..).unwrap_or_default();
                }
                if let Some(next) = end.strip_prefix(')') {
                    out.push_str(after.get(..label_end).unwrap_or_default());
                    rest = next;
                    continue 'scan;
                }
            }
        }
        out.push('[');
        rest = after;
    }
    out.push_str(rest);
    out
}

/// `GENERATED_BY_AGENT`: `(🤖\s*)?generated (with|by)\s+<agent>[.!]?`, the whole text.
fn is_generated_by_agent(text: &str) -> bool {
    let mut rest = text;
    if let Some(after) = rest.strip_prefix('🤖') {
        rest = after.trim_start_matches(js_space);
    }
    let Some(after) = strip_prefix_ignore_case(rest, "generated ") else {
        return false;
    };
    let Some(after) =
        strip_prefix_ignore_case(after, "with").or_else(|| strip_prefix_ignore_case(after, "by"))
    else {
        return false;
    };
    let trimmed = after.trim_start_matches(js_space);
    if trimmed.len() == after.len() {
        return false;
    }
    AGENT_NAMES.iter().any(|name| {
        strip_prefix_ignore_case(trimmed, name).is_some_and(|end| matches!(end, "" | "." | "!"))
    })
}

/// `/^ {0,3}(`{3,}|~{3,})(.*)$/`: a code fence delimiter's marker and the text after it.
fn fence_delimiter(line: &str) -> Option<(&str, &str)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let body = line.get(indent..)?;
    let mark = body.chars().next().filter(|c| matches!(c, '`' | '~'))?;
    let run = body.len() - body.trim_start_matches(mark).len();
    if run < 3 {
        return None;
    }
    let remainder = body.get(run..)?;
    // `.` stops at line terminators, so `$` cannot match past one.
    if remainder.contains(['\r', '\n', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some((body.get(..run)?, remainder))
}

/// `removeAgentCredits`.
pub fn remove_agent_credits(message: &str) -> String {
    let newline = if message.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut fence: Option<String> = None;
    let mut removed = false;
    let mut lines: Vec<&str> = Vec::new();
    for raw in message.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if line.starts_with("    ") || line.starts_with('\t') {
            lines.push(line);
            continue;
        }
        if let Some((marker, remainder)) = fence_delimiter(line) {
            match &fence {
                None => {
                    if marker.starts_with('~') || !remainder.contains('`') {
                        fence = Some(marker.to_owned());
                    }
                }
                Some(open) => {
                    if marker.chars().next() == open.chars().next()
                        && marker.len() >= open.len()
                        && remainder.chars().all(|c| c == ' ' || c == '\t')
                    {
                        fence = None;
                    }
                }
            }
            lines.push(line);
            continue;
        }
        if fence.is_some() {
            lines.push(line);
            continue;
        }
        let trimmed = line.trim_matches(js_space);
        let text = match trimmed.strip_prefix(['-', '*']) {
            Some(after) if after.starts_with(js_space) => after.trim_start_matches(js_space),
            _ => trimmed,
        };
        if !is_agent_author(text) && !is_generated_by_agent(&unlink_agent_footers(text)) {
            lines.push(line);
            continue;
        }
        removed = true;
    }
    if !removed {
        return message.to_owned();
    }
    while lines.len() > 1
        && lines
            .last()
            .is_some_and(|line| line.chars().all(|c| c == ' ' || c == '\t'))
    {
        lines.pop();
    }
    lines.join(newline)
}
