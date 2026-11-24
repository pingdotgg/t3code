//! Row label of a command work entry, ported from Conn's web timeline.
//!
//! Web shows `commandDisplayText(command)` (`packages/client-runtime/src/work-log/commandLabel.ts`):
//! a `sh -c "…"` wrapper is unwrapped when its quoting balances and the script is the last
//! argument, and control characters show as control pictures. The row cell is
//! `truncate [&_*]:whitespace-nowrap` (`WorkLog.tsx` `WorkLogLine`), so the browser then collapses
//! every whitespace run, newlines included, into one space on a single clipped line.

use std::borrow::Cow;

const SHELL_PROGRAMS: [&str; 7] = ["sh", "bash", "zsh", "dash", "ash", "ksh", "fish"];
const WINDOWS_SHELL_PROGRAMS: [&str; 6] = [
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
];
const SHELL_OPTIONS_WITH_VALUE: [&str; 4] = ["-o", "-O", "--rcfile", "--init-file"];
const POWERSHELL_FLAGS: [&str; 5] = ["-mta", "-nologo", "-noninteractive", "-noprofile", "-sta"];
const POWERSHELL_OPTIONS_WITH_VALUE: [&str; 7] = [
    "-configurationname",
    "-executionpolicy",
    "-inputformat",
    "-outputformat",
    "-version",
    "-windowstyle",
    "-workingdirectory",
];

/// The one-line label a command row shows: web's `commandDisplayText`, then whitespace collapsed.
pub(super) fn command_row_label(command: &str) -> String {
    collapse_whitespace(&command_display_text(command)).into_owned()
}

/// Web's `commandDisplayText`: shell wrapper removed, control characters made visible.
pub(super) fn command_display_text(command: &str) -> String {
    with_visible_control_characters(&without_shell_wrapper(command))
}

/// CSS `white-space: nowrap` collapsing: runs of space, tab and line breaks become one space and
/// the ends are trimmed. Other Unicode spaces (such as no-break space) stay.
pub(super) fn collapse_whitespace(text: &str) -> Cow<'_, str> {
    let is_css_space = |c: char| matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{c}');
    let already_flat = !text.starts_with(is_css_space)
        && !text.ends_with(is_css_space)
        && !text.contains(['\t', '\n', '\r', '\u{c}'])
        && !text.contains("  ");
    if already_flat {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut pending_space = false;
    for c in text.chars() {
        if is_css_space(c) {
            pending_space = !out.is_empty();
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(c);
        }
    }
    Cow::Owned(out)
}

fn with_visible_control_characters(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\u{7f}' => '\u{2421}',
            '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' => {
                char::from_u32(0x2400 + c as u32).unwrap_or(c)
            }
            _ => c,
        })
        .collect()
}

/// Web's `withoutShellWrapper`. A wrapper whose quoting does not balance is kept: the end of the
/// script cannot be known.
fn without_shell_wrapper(command: &str) -> String {
    let trimmed = command.trim();
    if split_remaining_command(trimmed).is_some() {
        return trimmed.to_owned();
    }
    let Some(tokens) = tokenize_shell_command(trimmed) else {
        return trimmed.to_owned();
    };
    let Some(first) = tokens.first() else {
        return trimmed.to_owned();
    };
    let executable = first.rsplit(['/', '\\']).next().unwrap_or_default();
    let program = strip_exe(executable);
    if executable.is_empty() || program.is_empty() {
        return trimmed.to_owned();
    }
    let script_index = if SHELL_PROGRAMS.contains(&program) {
        shell_command_argument_index(&tokens, 1)
    } else if WINDOWS_SHELL_PROGRAMS.contains(&executable.to_lowercase().as_str()) {
        windows_shell_script_index(&program.to_lowercase(), &tokens)
    } else {
        None
    };
    // Positional arguments can affect the script; keep those invocations intact.
    match script_index {
        Some(index) if index + 1 == tokens.len() => {
            let script = tokens[index].trim();
            if script.is_empty() {
                trimmed.to_owned()
            } else {
                script.to_owned()
            }
        }
        _ => trimmed.to_owned(),
    }
}

fn strip_exe(name: &str) -> &str {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".exe") {
        &name[..name.len() - 4]
    } else {
        name
    }
}

fn shell_command_argument_index(tokens: &[String], start: usize) -> Option<usize> {
    let mut index = start;
    while index < tokens.len() {
        let option = tokens[index].as_str();
        if option == "--" || !option.starts_with('-') {
            return None;
        }
        if SHELL_OPTIONS_WITH_VALUE.contains(&option) {
            index += 2;
            continue;
        }
        let letters = &option[1..];
        if option == "--command"
            || (letters.chars().all(|c| c.is_ascii_alphabetic()) && letters.contains('c'))
        {
            return Some(index + 1);
        }
        index += 1;
    }
    None
}

fn windows_shell_script_index(shell: &str, tokens: &[String]) -> Option<usize> {
    let mut index = 1;
    while index < tokens.len() {
        let option = tokens[index].to_lowercase();
        if shell == "cmd" {
            if option == "/c" {
                return Some(index + 1);
            }
            if !option.starts_with('/') {
                return None;
            }
        } else if option == "-command" || option == "-c" {
            return Some(index + 1);
        } else if POWERSHELL_OPTIONS_WITH_VALUE.contains(&option.as_str()) {
            index += 1;
        } else if !POWERSHELL_FLAGS.contains(&option.as_str()) {
            return None;
        }
        index += 1;
    }
    None
}

/// `^(?:[A-Za-z]:|\.{1,2})(?:\\[^\s]*)?$`
fn is_windows_path(text: &str) -> bool {
    let tail_ok = |rest: &str| {
        rest.is_empty() || (rest.starts_with('\\') && !rest.chars().any(char::is_whitespace))
    };
    let mut chars = text.chars();
    let drive = matches!(
        (chars.next(), chars.next()),
        (Some(letter), Some(':')) if letter.is_ascii_alphabetic()
    );
    (drive && tail_ok(&text[2..]))
        || text.strip_prefix("..").is_some_and(tail_ok)
        || text.strip_prefix('.').is_some_and(tail_ok)
}

/// Web's `tokenizeShellCommand`: `None` when quoting or nesting does not balance.
fn tokenize_shell_command(command: &str) -> Option<Vec<String>> {
    let chars: Vec<char> = command.trim().chars().collect();
    let at = |i: usize| chars.get(i).copied();
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaping = false;
    let mut in_backticks = false;
    let mut substitution_depth = 0usize;
    let mut parameter_depth = 0usize;
    let mut token_started = false;

    let mut index = 0;
    while index < chars.len() {
        let i = index;
        index += 1;
        let c = chars[i];
        if escaping {
            current.push(c);
            escaping = false;
            token_started = true;
            continue;
        }
        if c == '\\' && quote != Some('\'') {
            let windows_path = quote.is_none() && is_windows_path(&current);
            if (quote == Some('"') || windows_path)
                && at(i + 1).is_some_and(|n| !matches!(n, '"' | '\\' | '$' | '`' | '\n'))
            {
                current.push(c);
                token_started = true;
                continue;
            }
            escaping = true;
            token_started = true;
            continue;
        }
        if in_backticks {
            current.push(c);
            if c == '`' {
                in_backticks = false;
            }
            token_started = true;
            continue;
        }
        if let Some(open) = quote {
            if c == open {
                quote = None;
            } else {
                current.push(c);
            }
            token_started = true;
            continue;
        }
        if c == '`' {
            current.push(c);
            in_backticks = true;
            token_started = true;
            continue;
        }
        if c == '$' && at(i + 1) == Some('{') {
            current.push_str("${");
            parameter_depth += 1;
            token_started = true;
            index += 1;
            continue;
        }
        if c == '{' && parameter_depth > 0 {
            current.push(c);
            parameter_depth += 1;
            token_started = true;
            continue;
        }
        if c == '}' && parameter_depth > 0 {
            current.push(c);
            parameter_depth -= 1;
            token_started = true;
            continue;
        }
        if c == '$' && at(i + 1) == Some('(') {
            current.push_str("$(");
            substitution_depth += 1;
            token_started = true;
            index += 1;
            continue;
        }
        if c == '(' {
            current.push(c);
            substitution_depth += 1;
            token_started = true;
            continue;
        }
        if c == ')' && substitution_depth > 0 {
            current.push(c);
            substitution_depth -= 1;
            token_started = true;
            continue;
        }
        if c == '"' || c == '\'' {
            quote = Some(c);
            token_started = true;
            continue;
        }
        if c.is_whitespace() {
            if substitution_depth > 0 || parameter_depth > 0 {
                current.push(c);
                token_started = true;
                continue;
            }
            if token_started {
                tokens.push(std::mem::take(&mut current));
                token_started = false;
            }
            continue;
        }
        current.push(c);
        token_started = true;
    }

    if quote.is_some() || escaping || in_backticks || substitution_depth > 0 || parameter_depth > 0
    {
        return None;
    }
    if token_started {
        tokens.push(current);
    }
    Some(tokens)
}

struct Heredoc {
    delimiter: String,
    strip_tabs: bool,
}

fn read_heredoc_delimiter(
    chars: &[char],
    start: usize,
    strip_tabs: bool,
) -> Option<(Heredoc, usize)> {
    let mut index = start;
    while matches!(chars.get(index), Some(' ' | '\t')) {
        index += 1;
    }
    let mut delimiter = String::new();
    let mut quote: Option<char> = None;
    let mut escaping = false;
    while index < chars.len() {
        let c = chars[index];
        if escaping {
            delimiter.push(c);
            escaping = false;
        } else if c == '\\' && quote != Some('\'') {
            escaping = true;
        } else if let Some(open) = quote {
            if c == open {
                quote = None;
            } else {
                delimiter.push(c);
            }
        } else if c == '"' || c == '\'' {
            quote = Some(c);
        } else if c.is_whitespace() || ";&|<>()".contains(c) {
            break;
        } else {
            delimiter.push(c);
        }
        index += 1;
    }
    if delimiter.is_empty() || quote.is_some() || escaping {
        return None;
    }
    Some((
        Heredoc {
            delimiter,
            strip_tabs,
        },
        index,
    ))
}

fn text_of(chars: &[char], from: usize, to: usize) -> String {
    let to = to.min(chars.len());
    let from = from.min(to);
    chars[from..to].iter().collect()
}

fn command_after_heredocs(chars: &[char], start: usize, heredocs: &[Heredoc]) -> Option<String> {
    let mut cursor = start;
    for heredoc in heredocs {
        let mut found = false;
        while cursor <= chars.len() {
            let newline = chars
                .get(cursor..)
                .and_then(|rest| rest.iter().position(|&c| c == '\n'))
                .map(|offset| cursor + offset);
            let line_end = newline.unwrap_or(chars.len());
            let line = text_of(chars, cursor, line_end);
            let line = line.strip_suffix('\r').unwrap_or(&line);
            let comparable = if heredoc.strip_tabs {
                line.trim_start_matches('\t')
            } else {
                line
            };
            cursor = newline.map_or(chars.len(), |n| n + 1);
            if comparable == heredoc.delimiter {
                found = true;
                break;
            }
            if newline.is_none() {
                break;
            }
        }
        if !found {
            return None;
        }
    }
    let rest = text_of(chars, cursor, chars.len());
    let rest = rest.trim();
    (!rest.is_empty()).then(|| rest.to_owned())
}

/// The part of `command` after its first top-level command, as web's `splitFirstShellCommand`
/// reports it in `remainingCommand`. Separators inside quotes, comments, `$(…)`, `${…}` and
/// PowerShell here-strings do not count; heredoc bodies are skipped.
fn split_remaining_command(command: &str) -> Option<String> {
    let chars: Vec<char> = command.chars().collect();
    let at = |i: usize| chars.get(i).copied();
    let mut quote: Option<char> = None;
    let mut here_string_quote: Option<char> = None;
    let mut escaping = false;
    let mut in_backticks = false;
    let mut in_comment = false;
    let mut substitution_depth = 0usize;
    let mut parameter_depth = 0usize;
    let mut heredocs: Vec<Heredoc> = Vec::new();
    let mut separator_before_heredocs: Option<(usize, usize)> = None;

    let mut index = 0;
    while index < chars.len() {
        let i = index;
        index += 1;
        let c = chars[i];
        if let Some(open) = here_string_quote {
            if c == open && at(i + 1) == Some('@') && (i == 0 || chars[i - 1] == '\n') {
                here_string_quote = None;
                index += 1;
            }
            continue;
        }
        if in_comment {
            if c != '\n' {
                continue;
            }
            in_comment = false;
        }
        if escaping {
            escaping = false;
            continue;
        }
        if c == '\\' && quote != Some('\'') {
            escaping = true;
            continue;
        }
        if in_backticks {
            if c == '`' {
                in_backticks = false;
            }
            continue;
        }
        if let Some(open) = quote {
            if c == open {
                quote = None;
            }
            continue;
        }
        if c == '@'
            && matches!(at(i + 1), Some('"' | '\''))
            && (at(i + 2) == Some('\n') || (at(i + 2) == Some('\r') && at(i + 3) == Some('\n')))
        {
            here_string_quote = at(i + 1);
            index += 1;
            continue;
        }
        if c == '"' || c == '\'' {
            quote = Some(c);
            continue;
        }
        if c == '`' {
            in_backticks = true;
            continue;
        }
        if c == '#' && (i == 0 || chars[i - 1].is_whitespace() || ";&|(".contains(chars[i - 1])) {
            in_comment = true;
            continue;
        }
        if c == '$' && at(i + 1) == Some('{') {
            parameter_depth += 1;
            index += 1;
            continue;
        }
        if c == '{' && parameter_depth > 0 {
            parameter_depth += 1;
            continue;
        }
        if c == '}' && parameter_depth > 0 {
            parameter_depth -= 1;
            continue;
        }
        if c == '(' {
            substitution_depth += 1;
            continue;
        }
        if c == ')' && substitution_depth > 0 {
            substitution_depth -= 1;
            continue;
        }
        if substitution_depth > 0 || parameter_depth > 0 {
            continue;
        }

        if c == '<' && at(i + 1) == Some('<') && at(i + 2) != Some('<') {
            let strip_tabs = at(i + 2) == Some('-');
            let (heredoc, end) =
                read_heredoc_delimiter(&chars, i + if strip_tabs { 3 } else { 2 }, strip_tabs)?;
            heredocs.push(heredoc);
            index = end;
            continue;
        }

        let is_double = (c == '&' && at(i + 1) == Some('&'))
            || (c == '|' && matches!(at(i + 1), Some('|' | '&')));
        let is_redirection_ampersand =
            c == '&' && ((i > 0 && matches!(chars[i - 1], '>' | '<')) || at(i + 1) == Some('>'));
        if (!is_double && !";&|\n".contains(c)) || is_redirection_ampersand {
            continue;
        }

        if c == '\n' && !heredocs.is_empty() {
            let before = separator_before_heredocs
                .map(|(start, length)| text_of(&chars, start + length, i).trim().to_owned())
                .unwrap_or_default();
            let following = command_after_heredocs(&chars, i + 1, &heredocs);
            let remaining = [Some(before), following]
                .into_iter()
                .flatten()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            return (!remaining.is_empty()).then_some(remaining);
        }
        if !heredocs.is_empty() {
            separator_before_heredocs.get_or_insert((i, if is_double { 2 } else { 1 }));
            if is_double {
                index += 1;
            }
            continue;
        }

        let mut next = i + if is_double { 2 } else { 1 };
        while at(next).is_some_and(char::is_whitespace) {
            next += 1;
        }
        let rest = text_of(&chars, next, chars.len());
        let rest = rest.trim();
        return (!rest.is_empty()).then(|| rest.to_owned());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Nick's report: the script's `#!` was written as `#"'!`, so the quotes never balance.
    /// Web keeps the raw text and its nowrap cell flattens it onto one clipped line.
    const UNBALANCED: &str = "/bin/zsh -lc \"cd /tmp/conn-index-research.7yJdvC\ncat > spy <<'SH'\n#\"'!/bin/sh\nfor arg do\ncase \"$arg\" in\n stor";

    #[test]
    fn unbalanced_wrapper_from_the_report_is_one_line() {
        let label = command_row_label(UNBALANCED);
        assert!(!label.contains('\n'));
        assert_eq!(
            label,
            "/bin/zsh -lc \"cd /tmp/conn-index-research.7yJdvC cat > spy <<'SH' #\"'!/bin/sh for arg do case \"$arg\" in stor"
        );
    }

    #[test]
    fn balanced_multi_line_wrapper_is_unwrapped_and_flattened() {
        let command = "/bin/zsh -lc \"cd /tmp/conn-index-research.7yJdvC\ncat > spy <<'SH'\n#!/bin/sh\nfor arg do\n  echo \\\"$arg\\\"\ndone\nSH\nchmod +x spy\"";
        assert_eq!(
            command_display_text(command),
            "cd /tmp/conn-index-research.7yJdvC\ncat > spy <<'SH'\n#!/bin/sh\nfor arg do\n  echo \"$arg\"\ndone\nSH\nchmod +x spy"
        );
        assert_eq!(
            command_row_label(command),
            "cd /tmp/conn-index-research.7yJdvC cat > spy <<'SH' #!/bin/sh for arg do echo \"$arg\" done SH chmod +x spy"
        );
    }

    #[test]
    fn shell_wrapper_forms_unwrap() {
        assert_eq!(command_row_label("/bin/zsh -lc 'ls -la'"), "ls -la");
        assert_eq!(
            command_row_label("bash -c \"cd /tmp && ls\""),
            "cd /tmp && ls"
        );
        assert_eq!(command_row_label("sh -lc 'git status'"), "git status");
        assert_eq!(
            command_row_label("powershell.exe -NoProfile -Command \"Get-Date\""),
            "Get-Date"
        );
        assert_eq!(command_row_label("cmd.exe /c \"dir C:\\\\\""), "dir C:\\");
    }

    #[test]
    fn wrapper_with_arguments_or_other_commands_stays_intact() {
        assert_eq!(
            command_row_label("bash -c 'echo $0' arg"),
            "bash -c 'echo $0' arg"
        );
        assert_eq!(
            command_row_label("zsh -lc 'ls' && echo done"),
            "zsh -lc 'ls' && echo done"
        );
        assert_eq!(
            command_row_label("cargo test -p conn-app"),
            "cargo test -p conn-app"
        );
        assert_eq!(command_row_label("bash script.sh"), "bash script.sh");
    }

    #[test]
    fn whitespace_collapses_like_css_nowrap() {
        assert_eq!(collapse_whitespace("  a\t b\n\n c \n"), "a b c");
        assert!(matches!(collapse_whitespace("a b"), Cow::Borrowed(_)));
        assert_eq!(collapse_whitespace("a\u{a0}\u{a0}b"), "a\u{a0}\u{a0}b");
    }

    #[test]
    fn control_characters_show_as_pictures() {
        assert_eq!(command_row_label("echo \u{1b}[0m"), "echo \u{241b}[0m");
        assert_eq!(command_row_label("a\u{7f}b"), "a\u{2421}b");
    }

    #[test]
    fn heredoc_bodies_are_not_separate_commands() {
        assert_eq!(split_remaining_command("cat <<'EOF'\nhello\nEOF"), None);
        assert_eq!(
            split_remaining_command("cat <<'EOF'\nhello\nEOF\nls").as_deref(),
            Some("ls")
        );
        assert_eq!(
            split_remaining_command("echo a; echo b").as_deref(),
            Some("echo b")
        );
        assert_eq!(split_remaining_command("echo \"a; b\" 'c\nd'"), None);
    }
}
