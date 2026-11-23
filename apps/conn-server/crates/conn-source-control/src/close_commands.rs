//! Which change requests a shell command merges or closes, and whether a command failed: T3's
//! `isChangeRequestCloseCommand`, `changeRequestsClosedBy`
//! (`apps/server/src/sourceControl/sourceControlDefinitions.ts`) and `commandIndicatesFailure`
//! (`packages/shared/src/toolOutput.ts`). The pull request watch uses them to tell a merge
//! the watching thread's own agent ran from one someone else made.

use std::{collections::BTreeSet, sync::OnceLock};

use regex_automata::meta::Regex;

mod generated;

/// The change requests a close command names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClosedBy {
    /// A command that names none, such as a bare `gh pr merge` on the checked-out branch.
    Any,
    Numbers(BTreeSet<u64>),
}

impl ClosedBy {
    pub fn closes(&self, number: u64) -> bool {
        match self {
            Self::Any => true,
            Self::Numbers(numbers) => numbers.contains(&number),
        }
    }
}

/// A pattern that failed to build is `None` and matches nothing.
struct Patterns {
    close: Vec<Regex>,
    shell_word: Option<Regex>,
    named: Option<Regex>,
    failure_hint: Option<Regex>,
    failure: Option<Regex>,
    missing_path: Option<Regex>,
    does_not_exist: Option<Regex>,
    not_recognized: Option<Regex>,
    the_term: Option<Regex>,
    exit_code: Option<Regex>,
}

fn is_match(re: &Option<Regex>, text: &str) -> bool {
    re.as_ref().is_some_and(|re| re.is_match(text))
}

/// The patterns are generated or fixed here, never outside input: a test compiles each.
fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let compile = |pattern: &str| Regex::new(pattern).ok();
                Patterns {
            close: generated::CLOSE_COMMANDS
                .iter()
                .filter_map(|p| compile(p))
                .collect(),
            shell_word: compile(generated::SHELL_WORD),
            named: compile(generated::NAMED_CHANGE_REQUEST),
            // `toolOutputIndicatesFailure`: a superset of every phrase below, scanned first.
            failure_hint: compile(
                r"(?i)enoent|no such|no files found|not found|commandnotfound|not recognized|cannot (?:find path|be found)|exit",
            ),
            failure: compile(
                r"(?i)file not found|no files found|enoent|no such file|commandnotfoundexception|command not found|is not recognized as the name of a cmdlet|a parameter cannot be found that matches parameter name",
            ),
            missing_path: compile(r"(?i)cannot find path"),
            does_not_exist: compile(r"(?i)because it does not exist"),
            not_recognized: compile(r"(?i)is not recognized"),
            the_term: compile(r"(?i)the term '"),
            exit_code: compile(
                r"(?i)exit(?:ed)? with exit code\s+[1-9][0-9]*|exit code\s*[:\s]\s*[1-9][0-9]*\b",
            ),
        }
    })
}

/// `isChangeRequestCloseCommand`: a host CLI command that merges or closes a change request.
pub fn is_close_command(command: &str) -> bool {
    patterns().close.iter().any(|re| re.is_match(command))
}

/// `changeRequestsClosedBy`: the change requests a close command names. `None` when the
/// command closes none.
pub fn closed_by(command: &str) -> Option<ClosedBy> {
    let patterns = patterns();
    let mut named = BTreeSet::new();
    let mut matched = false;
    for close in &patterns.close {
        for found in close.find_iter(command) {
            matched = true;
            // From the match's start, as Azure's match runs through `--id` to `--status`.
            let rest = command.get(found.start()..).unwrap_or_default();
            let args = rest.split([';', '&', '|', '\n']).next().unwrap_or_default();
            // Every host's merge and close takes one change request: a later one is text.
            match target(patterns, args) {
                Some(number) => {
                    named.insert(number);
                }
                None => return Some(ClosedBy::Any),
            }
        }
    }
    if !matched {
        return None;
    }
    Some(if named.is_empty() {
        ClosedBy::Any
    } else {
        ClosedBy::Numbers(named)
    })
}

/// The first shell word that names a change request, up to a comment.
fn target(patterns: &Patterns, args: &str) -> Option<u64> {
    let shell_word = patterns.shell_word.as_ref()?;
    for caps in shell_word.captures_iter(args) {
        let group = |i| caps.get_group(i).and_then(|s| args.get(s.range()));
        let (word, bare) = match (group(1), group(2), group(3)) {
            (Some(word), _, _) | (None, Some(word), _) => (word, false),
            (None, None, Some(word)) => (word, true),
            _ => continue,
        };
        // A comment ends the command (`^#(?!\d+$)`).
        if bare
            && let Some(rest) = word.strip_prefix('#')
            && !(!rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
        {
            return None;
        }
        if let Some(number) = named_number(patterns, word) {
            return Some(number);
        }
    }
    None
}

fn named_number(patterns: &Patterns, word: &str) -> Option<u64> {
    let named = patterns.named.as_ref()?;
    let mut caps = named.create_captures();
    named.captures(word, &mut caps);
    let group = caps.get_group(1).or_else(|| caps.get_group(2))?;
    word.get(group.range())?.parse().ok()
}

/// `toolOutputIndicatesFailure`: some providers report a command completed when its output
/// describes a failure.
pub fn output_indicates_failure(text: &str) -> bool {
    let p = patterns();
    is_match(&p.failure_hint, text)
        && (is_match(&p.failure, text)
            || (is_match(&p.missing_path, text) && is_match(&p.does_not_exist, text))
            || (is_match(&p.not_recognized, text) && is_match(&p.the_term, text))
            || is_match(&p.exit_code, text))
}

/// T3 reads the first 32,768 UTF-16 units of a command's output (`output.slice(0, 32_768)`).
const FAILURE_SCAN_UTF16_UNITS: usize = 32_768;

/// The longest prefix of `text` within `units` UTF-16 units. JS's slice can split a surrogate
/// pair there; the half it keeps matches nothing the failure phrases look for.
fn utf16_prefix(text: &str, units: usize) -> &str {
    let mut used = 0;
    for (at, c) in text.char_indices() {
        used += c.len_utf16();
        if used > units {
            return text.get(..at).unwrap_or_default();
        }
    }
    text
}

/// `commandIndicatesFailure` for a `command_execution` turn item: a reported exit code
/// outranks text in its output.
pub fn command_failed(item: &serde_json::Value) -> bool {
    if let Some(code) = item.get("exitCode").and_then(serde_json::Value::as_i64) {
        return code != 0;
    }
    if item.get("outputIndicatesFailure") == Some(&serde_json::Value::Bool(true)) {
        return true;
    }
    let Some(output) = item.get("output").and_then(serde_json::Value::as_str) else {
        return false;
    };
    output_indicates_failure(utf16_prefix(output, FAILURE_SCAN_UTF16_UNITS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pattern_compiles() {
        let close = generated::CLOSE_COMMANDS.iter();
        for pattern in close.chain([&generated::SHELL_WORD, &generated::NAMED_CHANGE_REQUEST]) {
            assert!(Regex::new(pattern).is_ok(), "{pattern}");
        }
        let p = patterns();
        assert_eq!(p.close.len(), generated::CLOSE_COMMANDS.len());
        assert!(p.shell_word.is_some() && p.named.is_some() && p.failure_hint.is_some());
        assert!(p.failure.is_some() && p.exit_code.is_some() && p.the_term.is_some());
    }

    /// T3's `changeRequestsClosedBy` answers, generated from its own functions.
    #[test]
    fn closes_what_t3_finds() {
        for (command, expected) in generated::CLOSED_BY_CASES {
            let expected = expected.map(|numbers| {
                if numbers.is_empty() {
                    ClosedBy::Any
                } else {
                    ClosedBy::Numbers(numbers.iter().copied().collect())
                }
            });
            assert_eq!(closed_by(command), expected, "{command}");
            assert_eq!(is_close_command(command), expected.is_some(), "{command}");
        }
    }

    /// T3's `toolOutputIndicatesFailure` answers, generated from its own function.
    #[test]
    fn reads_failure_output_as_t3() {
        for (text, expected) in generated::FAILURE_CASES {
            assert_eq!(output_indicates_failure(text), *expected, "{text}");
        }
    }

    /// T3's `commandIndicatesFailure` on long outputs: it reads 32,768 UTF-16 units.
    #[test]
    fn reads_as_much_output_as_t3() {
        for (unit, count, suffix, expected) in generated::COMMAND_FAILURE_CASES {
            let item = serde_json::json!({ "output": format!("{}{suffix}", unit.repeat(*count)) });
            assert_eq!(command_failed(&item), *expected, "{unit} x {count}");
        }
    }

    #[test]
    fn an_exit_code_outranks_the_output() {
        let failed = |item| command_failed(&item);
        assert!(failed(
            serde_json::json!({"exitCode": 1, "output": "merged"})
        ));
        assert!(!failed(
            serde_json::json!({"exitCode": 0, "output": "exit code: 1"})
        ));
        assert!(failed(serde_json::json!({"outputIndicatesFailure": true})));
        assert!(failed(
            serde_json::json!({"output": "<exited with exit code 1>"})
        ));
        assert!(!failed(serde_json::json!({"output": "Merged #19"})));
    }
}
