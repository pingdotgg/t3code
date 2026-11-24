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

/// Where a followed script's output lines go (`observeCompletion.onOutputLine`).
pub(crate) struct OutputLines<'a> {
    /// The shell echoes typed input; lines ending with these are the wrapper, not output.
    pub(crate) echoed: &'a [String],
    pub(crate) sink: &'a mut (dyn FnMut(String) + Send),
}

/// Output lines are cut to this many characters (`OUTPUT_LINE_MAX_LENGTH`).
const OUTPUT_LINE_MAX_LENGTH: usize = 400;

impl OutputLines<'_> {
    /// `handleLine` for a line that is not the sentinel.
    fn line(&mut self, raw: &str, sentinel: &str) {
        let cleaned = strip_terminal_control(raw);
        let cleaned = cleaned.trim_end();
        if cleaned.is_empty()
            || cleaned.contains(sentinel)
            || self
                .echoed
                .iter()
                .any(|echoed| cleaned.ends_with(echoed.as_str()))
        {
            return;
        }
        (self.sink)(cleaned.chars().take(OUTPUT_LINE_MAX_LENGTH).collect());
    }
}

/// `stripTerminalControl`: ECMA-48 CSI and OSC sequences, any other escape with its
/// intermediates and final byte, then the remaining control characters except tab.
fn strip_terminal_control(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            if !(c.is_control() && c != '\t' && (u32::from(c) < 0x20 || c == '\x7f')) {
                out.push(c);
            }
            continue;
        }
        match chars.peek().copied() {
            Some('[') => {
                chars.next();
                // Parameters and intermediates, then one final byte in @..~.
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                while let Some(next) = chars.next() {
                    if next == '\x07' {
                        break;
                    }
                    if next == '\x1b' {
                        if chars.peek() == Some(&'\\') {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            _ => {
                while chars.peek().is_some_and(|n| (' '..='/').contains(n)) {
                    chars.next();
                }
                if chars.peek().is_some_and(|n| ('0'..='~').contains(n)) {
                    chars.next();
                }
            }
        }
    }
    out
}

/// Appends `data` to the partial line in `buffer` and returns the complete lines. Bare CR
/// redraws progress in place, so it ends a line too, instead of growing one.
fn take_lines(buffer: &mut String, data: &str) -> Vec<String> {
    buffer.push_str(data);
    let mut lines: Vec<String> = buffer
        .split("\r\n")
        .flat_map(|part| part.split(['\r', '\n']))
        .map(str::to_owned)
        .collect();
    *buffer = lines.pop().unwrap_or_default();
    if buffer.len() > PARTIAL_LINE_MAX_LENGTH {
        let mut cut = buffer.len() - PARTIAL_LINE_MAX_LENGTH;
        while !buffer.is_char_boundary(cut) {
            cut += 1;
        }
        buffer.drain(..cut);
    }
    lines
}

/// `observeTerminalCompletion`: reads the terminal's output until the sentinel and returns
/// its exit code, then waits briefly for the prompt to be drawn again (closing earlier mistakes
/// the redraw for activity). `None` when the terminal exited or closed first.
///
/// A subscriber that falls behind loses its queued output and gets a snapshot instead
/// (`Subscription::next`). The snapshot's status tells whether the shell exited, and its
/// scrollback still holds a sentinel the queue dropped.
pub(crate) async fn completion(
    stream: &mut conn_terminal::Subscription,
    sentinel: &str,
    mut lines_out: Option<OutputLines<'_>>,
) -> Option<i64> {
    let mut buffer = String::new();
    let code = loop {
        match stream.next().await {
            Event::Snapshot(resync) => {
                if resync.snapshot.status == conn_contract::TerminalSessionStatus::Exited {
                    return None;
                }
                // The scrollback repeats lines already handed on, so none go to `lines_out`.
                buffer.clear();
                let lines = take_lines(&mut buffer, &resync.snapshot.history);
                if let Some(code) = lines.iter().find_map(|line| exit_code(line, sentinel)) {
                    break code;
                }
            }
            Event::Output(output) => {
                let lines = take_lines(&mut buffer, &output.data);
                let mut found = None;
                for line in &lines {
                    if let Some(code) = exit_code(line, sentinel) {
                        found = Some(code);
                        break;
                    }
                    if let Some(out) = lines_out.as_mut() {
                        out.line(line, sentinel);
                    }
                }
                if let Some(code) = found {
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

    /// A noisy script overflows the subscriber's queue, and the queue drops its sentinel: the
    /// resync's snapshot still reports the exit code.
    #[tokio::test(flavor = "current_thread")]
    async fn a_sentinel_the_overflowing_queue_dropped_is_read_from_the_resync() {
        let manager = conn_terminal::TerminalManager::new(conn_terminal::TerminalConfig {
            shells: vec!["/bin/sh".into()],
            max_queued_bytes: 16 * 1024,
            ..Default::default()
        });
        let input = conn_contract::from_json(serde_json::json!({
            "threadId": "t", "terminalId": "setup-flood",
            "cwd": std::env::temp_dir(), "cols": 80, "rows": 24,
            "env": {"PS1": "$ ", "HISTFILE": "/dev/null"},
        }))
        .unwrap();
        let mut stream = manager.open_observed(input).unwrap();
        let sentinel = sentinel("flood");
        let flood = "i=0; while [ $i -lt 2000 ]; do echo line-$i-0123456789012345678901234567890123456789012345678901234567890123456789; i=$((i+1)); done";
        let command = wrap(
            &format!("{flood}; exit 7"),
            CompletionShell::Posix,
            &sentinel,
        );
        let write = conn_contract::from_json(serde_json::json!({
            "threadId": "t", "terminalId": "setup-flood", "data": format!(" {command}\r"),
        }))
        .unwrap();
        manager.write(write, None).await.unwrap();
        // Nobody reads while the script runs, so the queue overflows and drops its end.
        let reported = format!("{sentinel}7");
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            while !manager
                .read("t", "setup-flood", None)
                .is_some_and(|s| s.history.contains(&reported))
            {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the script printed its sentinel");
        let code = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            completion(&mut stream, &sentinel, None),
        )
        .await
        .expect("completion reads the sentinel from the resync");
        assert_eq!(code, Some(7));
        manager.shutdown().await;
    }

    #[test]
    fn output_lines_drop_terminal_control_the_wrapper_and_the_sentinel() {
        assert_eq!(
            strip_terminal_control("\x1b[1;32mok\x1b[0m \x1b]0;title\x07done\x1b(B\x01"),
            "ok done"
        );
        let mut seen = Vec::new();
        let mut sink = |line: String| seen.push(line);
        let echoed = vec!["printf '%s' x".to_owned()];
        let sentinel = sentinel("t");
        let mut output = OutputLines {
            echoed: &echoed,
            sink: &mut sink,
        };
        output.line("$ printf '%s' x", &sentinel);
        output.line(&format!("echo {sentinel}"), &sentinel);
        output.line("   ", &sentinel);
        output.line(&"y".repeat(500), &sentinel);
        output.line("installed 3 packages  ", &sentinel);
        assert_eq!(seen.len(), 2);
        assert_eq!(seen.first().map(String::len), Some(400));
        assert_eq!(
            seen.get(1).map(String::as_str),
            Some("installed 3 packages")
        );
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
