//! A project script's completion in its terminal (`ProjectSetupScriptRunner.ts`): the command
//! is wrapped so the shell prints a sentinel with a random per-run token and the exit code,
//! and the terminal's output is read until that sentinel. Settle scripts use it to close
//! their terminal after an exit code of 0.

use conn_contract::TerminalAttachStreamEvent as Event;

/// Random per-run tokens keep script output from spoofing completion.
const SENTINEL_PREFIX: &str = "__T3_SETUP_DONE__";
/// Canonical TTY input (before a line editor reads) caps a line below 1 KiB on Linux.
const POSIX_MAX_LINE_BYTES: usize = 1_023;
const POSIX_APPEND: &str = "__t3_command=\"$__t3_command\"";
/// Newline-free output is bounded; the sentinel has its own line.
const PARTIAL_LINE_MAX_LENGTH: usize = 4_096;
/// A shell with an empty prompt never prints one; the wait for its redraw ends here.
const PROMPT_WAIT: std::time::Duration = std::time::Duration::from_secs(1);

/// `CompletionShell`: how a command is wrapped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CompletionShell {
    Posix,
    Fish,
    Nushell,
    PowerShell,
}

/// `resolveCompletionShell`: by the shell's file name; `None` for cmd.exe, which cannot.
pub(crate) fn completion_shell(shell: &str) -> Option<CompletionShell> {
    let name = shell
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(shell)
        .to_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    match name {
        "cmd" => None,
        "fish" => Some(CompletionShell::Fish),
        "nu" => Some(CompletionShell::Nushell),
        "pwsh" | "powershell" => Some(CompletionShell::PowerShell),
        _ => Some(CompletionShell::Posix),
    }
}

/// `completionSentinel`: the text before the exit code.
pub(crate) fn sentinel(token: &str) -> String {
    format!("{SENTINEL_PREFIX}_{token}:")
}

/// `encodePosixScript`: a `printf '%b'` payload inside single quotes.
fn encode_posix(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len());
    for character in text.chars() {
        let code = u32::from(character);
        if character == '\'' {
            encoded.push_str("'\\''");
        } else if character == '\\' || code <= 0x1f || code == 0x7f {
            encoded.push_str(&format!("\\0{code:03o}"));
        } else {
            encoded.push(character);
        }
    }
    encoded
}

/// `wrapPosixCommand`: line editors run each submitted line on its own, so every line is a
/// complete command. The `_` suffix keeps trailing newlines; the subshell contains exits and
/// syntax errors. A script too long for one canonical line is assembled in a variable.
fn wrap_posix(command: &str, sentinel: &str) -> String {
    let normalized = command.replace("\r\n", "\n");
    let evaluate = |payload: &str| {
        format!(
            "( __t3_command=$(printf '%b_' {payload}); eval \"${{__t3_command%_}}\" ); printf '\\n{sentinel}%s\\n' \"$?\""
        )
    };
    let inline = evaluate(&format!("'{}'", encode_posix(&normalized)));
    if format!(" {inline}\r").len() <= POSIX_MAX_LINE_BYTES {
        return inline;
    }
    let max_chunk_bytes = POSIX_MAX_LINE_BYTES - format!(" {POSIX_APPEND}''\r").len();
    let mut lines = Vec::new();
    let mut prefix = "__t3_command=";
    let mut chunk = String::new();
    for character in normalized.chars() {
        let encoded = encode_posix(character.encode_utf8(&mut [0; 4]));
        if chunk.len() + encoded.len() > max_chunk_bytes {
            lines.push(format!("{prefix}'{chunk}'"));
            prefix = POSIX_APPEND;
            chunk.clear();
        }
        chunk.push_str(&encoded);
    }
    lines.push(format!("{prefix}'{chunk}'"));
    lines.push(format!(
        "{}; unset __t3_command",
        evaluate("\"$__t3_command\"")
    ));
    // The leading space gives every line the history suppression a short command gets.
    lines.join("\r ")
}

/// `wrapCommandForCompletion`.
pub(crate) fn wrap(command: &str, shell: CompletionShell, sentinel: &str) -> String {
    let body = command.replace("\r\n", "\r").replace('\n', "\r");
    match shell {
        CompletionShell::PowerShell => format!(
            "$global:LASTEXITCODE = $null; & {{\r{body}\r}}; if ($null -ne $LASTEXITCODE) {{ $__t3c = $LASTEXITCODE }} elseif ($?) {{ $__t3c = 0 }} else {{ $__t3c = 1 }}; Write-Host \"{sentinel}$__t3c\""
        ),
        CompletionShell::Fish => {
            format!("begin\r{body}\rend; printf '\\n{sentinel}%s\\n' $status")
        }
        CompletionShell::Nushell => {
            let mut escaped = String::with_capacity(command.len());
            for character in command.chars() {
                match character {
                    '"' | '\\' => {
                        escaped.push('\\');
                        escaped.push(character);
                    }
                    c if u32::from(c) <= 0x1f => {
                        escaped.push_str(&format!("\\u{{{:x}}}", u32::from(c)))
                    }
                    c => escaped.push(c),
                }
            }
            // Nu resolves imports before running cd; source a file rooted in the worktree.
            [
                "$env.LAST_EXIT_CODE = 0".to_owned(),
                "let __t3f = try { mktemp --tmpdir-path $env.T3CODE_WORKTREE_PATH --suffix .nu .t3-setup-XXXXXXXX } catch {|e| print -e $e.msg; null }".to_owned(),
                format!("if $__t3f == null {{ $env.LAST_EXIT_CODE = 1 }} else {{ try {{ [$\"rm --permanent ($__t3f | to nuon)\" \"{escaped}\"] | str join (char newline) | save --force --raw $__t3f; ^$nu.current-exe --login --commands $\"cd $env.T3CODE_WORKTREE_PATH; source ($__t3f | to nuon)\" }} catch {{|e| if $e != null and $e.exit_code? == null {{ print -e $e.msg }}; if $env.LAST_EXIT_CODE == 0 {{ $env.LAST_EXIT_CODE = 1 }} }} }}"),
                "let __t3c = $env.LAST_EXIT_CODE".to_owned(),
                "try { if $__t3f != null and ($__t3f | path exists) { rm --permanent $__t3f } } catch {|e| print -e $e.msg }".to_owned(),
                format!("print $\"\\n{sentinel}($__t3c)\""),
            ]
            .join("; ")
        }
        CompletionShell::Posix => wrap_posix(command, sentinel),
    }
}

/// The exit code a line reports after `sentinel` (`completionSentinelPattern`: `-?\d+`).
fn exit_code(line: &str, sentinel: &str) -> Option<Option<i64>> {
    let rest = &line[line.find(sentinel)? + sentinel.len()..];
    let digits = rest.strip_prefix('-').unwrap_or(rest);
    let length = digits.bytes().take_while(u8::is_ascii_digit).count();
    if length == 0 {
        return None;
    }
    let number = &rest[..rest.len() - digits.len() + length];
    Some(number.parse().ok())
}

/// `observeTerminalCompletion`: reads the terminal's output until the sentinel and returns
/// its exit code, then waits briefly for the prompt to be drawn again (closing earlier mistakes
/// the redraw for activity). `None` when the terminal exited or closed first.
pub(crate) async fn completion(
    stream: &mut conn_terminal::Subscription,
    sentinel: &str,
) -> Option<i64> {
    let mut buffer = String::new();
    let code = loop {
        match stream.next().await {
            Event::Output(output) => {
                buffer.push_str(&output.data);
                // Bare CR redraws progress in place; split redraws instead of growing one line.
                let mut lines: Vec<String> = buffer
                    .split("\r\n")
                    .flat_map(|part| part.split(['\r', '\n']))
                    .map(str::to_owned)
                    .collect();
                buffer = lines.pop().unwrap_or_default();
                if buffer.len() > PARTIAL_LINE_MAX_LENGTH {
                    let mut cut = buffer.len() - PARTIAL_LINE_MAX_LENGTH;
                    while !buffer.is_char_boundary(cut) {
                        cut += 1;
                    }
                    buffer.drain(..cut);
                }
                if let Some(code) = lines.iter().find_map(|line| exit_code(line, sentinel)) {
                    break code;
                }
            }
            Event::Exited(_) | Event::Closed(_) => return None,
            _ => {}
        }
    };
    // The prompt has returned once a partial line follows the sentinel.
    let prompt = async {
        if !buffer.is_empty() {
            return;
        }
        loop {
            match stream.next().await {
                Event::Output(output) if output.data.contains(['\r', '\n']) => {
                    let tail = output.data.rsplit(['\r', '\n']).next().unwrap_or_default();
                    if !tail.is_empty() {
                        return;
                    }
                }
                Event::Output(output) if !output.data.is_empty() => return,
                Event::Exited(_) | Event::Closed(_) => return,
                _ => {}
            }
        }
    };
    let _ = tokio::time::timeout(PROMPT_WAIT, prompt).await;
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs a wrapped POSIX command as T3's live tests do: `/bin/bash -c`, Enter as newline.
    fn run_posix(command: &str) -> (String, Vec<String>, Option<i64>) {
        let sentinel = sentinel("0123abcd");
        let submitted = wrap(command, CompletionShell::Posix, &sentinel);
        let output = std::process::Command::new("/bin/bash")
            .args([
                "--noprofile",
                "--norc",
                "-c",
                &submitted.replace('\r', "\n"),
            ])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .output()
            .expect("bash runs");
        let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
        text.push_str(&String::from_utf8_lossy(&output.stderr));
        let mut code = None;
        let mut lines = Vec::new();
        for line in text.lines() {
            match exit_code(line, &sentinel) {
                Some(found) => code = found,
                None if !line.trim().is_empty() => lines.push(line.to_owned()),
                None => {}
            }
        }
        (submitted, lines, code)
    }

    /// `submits one line while preserving multiline shell syntax and literal text`.
    #[test]
    fn submits_one_line_and_keeps_multiline_syntax_and_literal_text() {
        let (submitted, lines, code) = run_posix(
            &[
                "printf '%s\\n' \"it's ready\" 'literal \\n $(printf wrong) `printf wrong` café'",
                "cat <<'END'",
                "$literal \\path 雪",
                "END",
                "printf '%s\\n' done # trailing comment",
            ]
            .join("\r\n"),
        );
        assert!(!submitted.contains(['\r', '\n']), "one line");
        assert_eq!(
            lines,
            [
                "it's ready",
                "literal \\n $(printf wrong) `printf wrong` café",
                "$literal \\path 雪",
                "done",
            ]
        );
        assert_eq!(code, Some(0));
    }

    /// `completes long scripts without exceeding canonical terminal line limits`.
    #[test]
    fn completes_long_scripts_within_canonical_line_limits() {
        let expected: Vec<String> = (0..120)
            .map(|i| format!("line-{i}: café 雪 'quoted' \\path"))
            .collect();
        let command = expected
            .iter()
            .map(|line| format!("printf '%s\\n' \"{}\"", line.replace('\\', "\\\\")))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(command.len() > 4_096);
        let (submitted, lines, code) = run_posix(&command);
        assert_eq!(lines, expected);
        assert_eq!(code, Some(0));
        assert!(!submitted.contains('\n'));
        for line in submitted.split('\r') {
            assert!(line.len() + 1 < 1_024, "{} bytes", line.len());
        }
    }

    /// `preserves a trailing backslash-newline even when losing it would still exit zero`.
    #[test]
    fn keeps_a_trailing_backslash_newline() {
        let (_, lines, code) = run_posix("printf '%s\\n' direct\\\n");
        assert_eq!(lines, ["direct"]);
        assert_eq!(code, Some(0));
    }

    /// `reports a nonzero completion for $name`.
    #[test]
    fn reports_a_nonzero_completion() {
        assert_eq!(run_posix("exit 7").2, Some(7));
        // bash 5 (T3's CI) reports a syntax error as 2; macOS's bash 3.2 as 1.
        let syntax = run_posix("if then").2;
        if cfg!(target_os = "linux") {
            assert_eq!(syntax, Some(2));
        } else {
            assert!(syntax.is_some_and(|code| code != 0), "{syntax:?}");
        }
    }

    #[test]
    fn resolves_completion_shells_and_sentinel_lines() {
        assert_eq!(completion_shell("/bin/zsh"), Some(CompletionShell::Posix));
        assert_eq!(
            completion_shell("/usr/local/bin/fish"),
            Some(CompletionShell::Fish)
        );
        assert_eq!(completion_shell("nu"), Some(CompletionShell::Nushell));
        assert_eq!(
            completion_shell("C:\\pwsh.exe"),
            Some(CompletionShell::PowerShell)
        );
        assert_eq!(completion_shell("CMD.EXE"), None);
        let s = sentinel("t");
        assert_eq!(exit_code(&format!("x{s}-3"), &s), Some(Some(-3)));
        // The echoed wrapper holds the sentinel before `%s`, never before digits.
        assert_eq!(exit_code(&format!("printf '\\n{s}%s\\n'"), &s), None);
        assert_eq!(exit_code("unrelated", &s), None);
    }
}
