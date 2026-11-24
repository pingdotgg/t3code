//! Pure view model for the pending-approval card (no gpui): splits the raw approval `title` /
//! `detail` into a kind heading, the real command (shell wrapper stripped) and a short note.

const DEFAULT_TITLE: &str = "Approval requested";
const SHELLS: [&str; 6] = ["sh", "bash", "zsh", "dash", "fish", "ksh"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ApprovalView {
    /// Heading, e.g. `Run command`.
    pub heading: &'static str,
    /// The command (or target) to approve, shell wrapper removed. `None` for generic requests.
    pub command: Option<String>,
    /// The wrapper that was removed, e.g. `/bin/zsh -lc`, shown muted above the command.
    pub wrapper: Option<String>,
    /// Extra reason/prompt text from the provider.
    pub note: Option<String>,
}

impl ApprovalView {
    pub(super) fn new(title: &str, detail: Option<&str>) -> Self {
        let detail = detail.map(str::trim).filter(|d| !d.is_empty());
        let kind = detail.and_then(kind_heading);
        let note = detail.filter(|_| kind.is_none()).map(str::to_owned);
        let title = title.trim();
        let (command, wrapper) = if title.is_empty() || title == DEFAULT_TITLE {
            (None, None)
        } else if let Some((wrapper, inner)) = strip_shell_wrapper(title) {
            (Some(inner), Some(wrapper))
        } else {
            (Some(title.to_owned()), None)
        };
        Self {
            heading: kind.unwrap_or(if command.is_some() {
                "Run command"
            } else {
                "Approval requested"
            }),
            command,
            wrapper,
            note,
        }
    }
}

/// Maps the server's `request_kind` labels (see `conn-state`) to a heading.
fn kind_heading(detail: &str) -> Option<&'static str> {
    Some(match detail {
        "command" => "Run command",
        "file-read" => "Read file",
        "file-change" => "Change files",
        "mcp-elicitation" => "Tool request",
        "permission" => "Permission",
        _ => return None,
    })
}

/// Splits `/bin/zsh -lc 'rm -rf x'` into (`/bin/zsh -lc`, `rm -rf x`). `None` when `cmd` is not a
/// single shell invocation with one quoted script argument.
pub(super) fn strip_shell_wrapper(cmd: &str) -> Option<(String, String)> {
    let cmd = cmd.trim();
    let (shell, rest) = cmd.split_once(char::is_whitespace)?;
    let name = shell.rsplit('/').next()?;
    if !SHELLS.contains(&name) {
        return None;
    }
    let (flags, script) = rest.trim_start().split_once(char::is_whitespace)?;
    let is_command_flag = flags.starts_with('-')
        && flags.len() > 1
        && flags[1..].chars().all(|c| c.is_ascii_lowercase())
        && flags.contains('c');
    if !is_command_flag {
        return None;
    }
    let script = unquote(script.trim())?;
    (!script.trim().is_empty()).then(|| (format!("{shell} {flags}"), script))
}

/// Removes one pair of outer quotes. `None` when the text is not exactly one quoted word, so a
/// `sh -c 'a' 'b'` style call is left untouched.
fn unquote(text: &str) -> Option<String> {
    let quote = text.chars().next().filter(|c| matches!(c, '\'' | '"'))?;
    let inner = text.strip_prefix(quote)?.strip_suffix(quote)?;
    if quote == '\'' {
        // `'\''` is the POSIX way to embed a single quote.
        let unescaped = inner.replace("'\\''", "\u{0}");
        return (!unescaped.contains('\'')).then(|| unescaped.replace('\u{0}', "'"));
    }
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some(next @ ('"' | '\\' | '$' | '`')) => out.push(next),
                Some(next) => {
                    out.push('\\');
                    out.push(next);
                }
                None => out.push('\\'),
            },
            '"' => return None,
            _ => out.push(c),
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_zsh_login_wrapper() {
        let (wrapper, inner) = strip_shell_wrapper(
            "/bin/zsh -lc 'rm -rf -- /var/folders/1j/T/conn-pr217-r9.sOtkcMXFM8'",
        )
        .unwrap();
        assert_eq!(wrapper, "/bin/zsh -lc");
        assert_eq!(
            inner,
            "rm -rf -- /var/folders/1j/T/conn-pr217-r9.sOtkcMXFM8"
        );
    }

    #[test]
    fn unescapes_embedded_quotes() {
        let (_, inner) = strip_shell_wrapper(r#"bash -c 'echo '\''hi'\'''"#).unwrap();
        assert_eq!(inner, "echo 'hi'");
        let (_, inner) = strip_shell_wrapper(r#"sh -c "echo \"hi\" \$HOME""#).unwrap();
        assert_eq!(inner, r#"echo "hi" $HOME"#);
    }

    #[test]
    fn leaves_other_commands_alone() {
        assert_eq!(strip_shell_wrapper("ls -la"), None);
        assert_eq!(strip_shell_wrapper("zsh script.sh"), None);
        assert_eq!(strip_shell_wrapper("bash -c 'a' 'b'"), None);
        assert_eq!(strip_shell_wrapper("bash -c 'unterminated"), None);
        assert_eq!(strip_shell_wrapper("bash -c ''"), None);
    }

    #[test]
    fn view_separates_kind_command_and_note() {
        let view = ApprovalView::new("/bin/zsh -lc 'rm -rf /tmp/x'", Some("command"));
        assert_eq!(view.heading, "Run command");
        assert_eq!(view.command.as_deref(), Some("rm -rf /tmp/x"));
        assert_eq!(view.wrapper.as_deref(), Some("/bin/zsh -lc"));
        assert_eq!(view.note, None);

        let view = ApprovalView::new("Approval requested", Some("Needs network access"));
        assert_eq!(view.heading, "Approval requested");
        assert_eq!(view.command, None);
        assert_eq!(view.note.as_deref(), Some("Needs network access"));

        let view = ApprovalView::new("edit src/main.rs", Some("file-change"));
        assert_eq!(view.heading, "Change files");
        assert_eq!(view.command.as_deref(), Some("edit src/main.rs"));
    }
}
