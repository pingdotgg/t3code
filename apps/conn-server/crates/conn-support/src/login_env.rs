//! The login shell's `PATH` for child processes, without changing the server's own
//! environment.
//!
//! The T3 server reads `PATH`, `__MISE_DIFF` and `JAVA_HOME` from the user's login shell at
//! start (`fixPath`) and again before each source control discovery (`refreshPathFromLoginShell`,
//! at most every 10 s), and writes them into `process.env`, so every later child sees them.
//! Rust makes `std::env::set_var` unsafe once threads exist, and this workspace forbids
//! `unsafe`. So the values live here, and every place that starts a child adds [`vars`] to
//! its environment; a program lookup that reads `PATH` itself uses [`var_os`].
//!
//! The one piece of state in this crate: three values, replaced as a whole on each refresh.

use std::{
    ffi::{OsStr, OsString},
    io::Read,
    path::Path,
    process::{Command, Stdio},
    sync::RwLock,
    time::{Duration, Instant},
};

/// `LOGIN_SHELL_ENV_NAMES`. `__MISE_DIFF` must travel with the shell's `PATH`, or `mise x` can
/// rebuild `PATH` behind a same-named wrapper that then re-runs itself forever.
pub const NAMES: [&str; 3] = ["PATH", "__MISE_DIFF", "JAVA_HOME"];
/// `LOGIN_SHELL_TIMEOUT`.
pub const TIMEOUT: Duration = Duration::from_secs(5);
/// How long one refresh serves (`Effect.cachedWithTTL(Duration.seconds(10))` in discovery).
/// The caller keeps the time and coalesces concurrent refreshes (conn-server's
/// `methods/source_control.rs`).
pub const REFRESH_TTL: Duration = Duration::from_secs(10);
/// The most of the shell's output that is read.
const MAX_OUTPUT_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Default)]
struct Overlay {
    values: Vec<(&'static str, OsString)>,
}

static OVERLAY: RwLock<Overlay> = RwLock::new(Overlay { values: Vec::new() });

/// The values to add to a child's environment: empty until a login shell answered.
pub fn vars() -> Vec<(&'static str, OsString)> {
    OVERLAY
        .read()
        .map(|overlay| overlay.values.clone())
        .unwrap_or_default()
}

/// A variable as a child sees it: the login shell's value, else the server's own.
pub fn var_os(name: &str) -> Option<OsString> {
    let overlaid = OVERLAY.read().ok().and_then(|overlay| {
        overlay
            .values
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.clone())
    });
    overlaid.or_else(|| std::env::var_os(name))
}

/// The whole environment a child starts from: the server's own variables with the login
/// shell's values on top, as text.
///
/// A name or value that is not valid Unicode is converted lossily, as Node does for
/// `process.env`. `std::env::vars` would panic on one, and a panic stops the server.
pub fn child_env() -> Vec<(String, String)> {
    overlay_onto(std::env::vars_os(), vars())
}

fn overlay_onto(
    base: impl Iterator<Item = (OsString, OsString)>,
    overlay: Vec<(&'static str, OsString)>,
) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = base
        .map(|(name, value)| {
            (
                name.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .collect();
    for (name, value) in overlay {
        let value = value.to_string_lossy().into_owned();
        match env.iter_mut().find(|(n, _)| n == name) {
            Some(entry) => entry.1 = value,
            None => env.push((name.to_owned(), value)),
        }
    }
    env
}

/// `mergePathEntries`: the preferred entries first, then the inherited ones, each once, empty
/// entries dropped. POSIX entries keep their whitespace: a directory may start or end with it.
pub fn merge_path_entries(preferred: Option<&str>, inherited: Option<&str>) -> Option<String> {
    let mut merged: Vec<&str> = Vec::new();
    for value in [preferred, inherited].into_iter().flatten() {
        for entry in value.split(':') {
            if !entry.is_empty() && !merged.contains(&entry) {
                merged.push(entry);
            }
        }
    }
    (!merged.is_empty()).then(|| merged.join(":"))
}

/// `applyLoginShellEnvironment` on the overlay: `PATH` merged in front of what children
/// have now; `__MISE_DIFF` with a shell `PATH`; `JAVA_HOME` only when children have none.
pub fn apply(shell: &[(&'static str, String)]) {
    let value = |name: &str| {
        shell
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.as_str())
    };
    let current = |name: &str| var_os(name).map(|v| v.to_string_lossy().into_owned());
    let mut values: Vec<(&'static str, OsString)> = vars();
    let mut set = |name: &'static str, text: String| {
        values.retain(|(n, _)| *n != name);
        values.push((name, OsString::from(text)));
    };
    let shell_path = value("PATH");
    if let Some(merged) = merge_path_entries(shell_path, current("PATH").as_deref()) {
        set("PATH", merged);
    }
    if let (Some(_), Some(diff)) = (shell_path, value("__MISE_DIFF")) {
        set("__MISE_DIFF", diff.to_owned());
    }
    if current("JAVA_HOME").is_none_or(|v| v.is_empty())
        && let Some(java) = value("JAVA_HOME")
    {
        set("JAVA_HOME", java.to_owned());
    }
    if let Ok(mut overlay) = OVERLAY.write() {
        overlay.values = values;
    }
}

/// Forgets the login shell's values, so children see the server's own environment again:
/// for a tool that runs several servers' start-ups in one process.
pub fn clear() {
    if let Ok(mut overlay) = OVERLAY.write() {
        *overlay = Overlay::default();
    }
}

fn start_marker(name: &str) -> String {
    format!("__T3CODE_ENV_{name}_START__")
}

fn end_marker(name: &str) -> String {
    format!("__T3CODE_ENV_{name}_END__")
}

/// Shells whose DEBUG trap could echo each command (`DEBUG_TRAP_SHELLS`).
const DEBUG_TRAP_SHELLS: [&str; 4] = ["bash", "ksh", "mksh", "oksh"];

/// `buildEnvironmentCaptureCommand` for a POSIX shell. Nushell is not supported here: its
/// capture is a different program, and such a login shell reads as one that printed no `PATH`.
pub fn capture_command(shell: &str) -> Option<String> {
    let executable = Path::new(shell)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if executable.starts_with("nu") {
        return None;
    }
    let capture = NAMES
        .iter()
        .map(|name| {
            format!(
                "printf '%s\\n' '{}'; printenv {name} || true; printf '%s\\n' '{}'",
                start_marker(name),
                end_marker(name)
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
    Some(if DEBUG_TRAP_SHELLS.contains(&executable.as_str()) {
        format!("(trap - DEBUG) 2>/dev/null && trap - DEBUG; {capture}")
    } else {
        capture
    })
}

/// `extractEnvironmentValues`: the values between the markers; unset or empty ones omitted.
pub fn extract(output: &str) -> Vec<(&'static str, String)> {
    NAMES
        .iter()
        .filter_map(|name| {
            let start = start_marker(name);
            let begin = output.find(&start)? + start.len();
            let rest = output.get(begin..)?;
            let end = rest.find(&end_marker(name))?;
            let value = rest.get(..end)?;
            let value = value
                .strip_prefix("\r\n")
                .or_else(|| value.strip_prefix('\n'))
                .unwrap_or(value);
            let value = value
                .strip_suffix("\r\n")
                .or_else(|| value.strip_suffix('\n'))
                .unwrap_or(value);
            (!value.is_empty()).then(|| (*name, value.to_owned()))
        })
        .collect()
}

/// The first of `listLoginShellCandidates`: `$SHELL`, else the account's shell, else the
/// platform's (`/bin/zsh` on macOS, `/bin/bash` on Linux). Only the user's own shell counts
/// for a refresh.
pub fn login_shell(shell_var: Option<&OsStr>, account_shell: Option<&str>) -> Option<String> {
    let trimmed = |s: &str| {
        let t = s.trim();
        (!t.is_empty()).then(|| t.to_owned())
    };
    shell_var
        .and_then(|s| trimmed(&s.to_string_lossy()))
        .or_else(|| account_shell.and_then(trimmed))
        .or_else(|| {
            if cfg!(target_os = "macos") {
                Some("/bin/zsh".into())
            } else if cfg!(target_os = "linux") {
                Some("/bin/bash".into())
            } else {
                None
            }
        })
}

/// Why a login shell gave no values.
#[derive(Debug, PartialEq, Eq)]
pub enum ReadFailure {
    Spawn,
    Timeout,
    Exit,
    Unsupported,
}

/// `readLoginShellOutput`: `<shell> -ilc <capture>` with stdin and stderr closed, stdout
/// read, killed after `timeout`. Blocking: call it from a blocking thread.
pub fn read_login_shell(
    shell: &str,
    timeout: Duration,
    extra_env: &[(&'static str, OsString)],
) -> Result<String, ReadFailure> {
    let command = capture_command(shell).ok_or(ReadFailure::Unsupported)?;
    let mut child = Command::new(shell)
        .arg("-ilc")
        .arg(command)
        .envs(extra_env.iter().map(|(k, v)| (*k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ReadFailure::Spawn)?;
    let stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut text = Vec::new();
        if let Some(out) = stdout {
            let _ = out.take(MAX_OUTPUT_BYTES).read_to_end(&mut text);
        }
        text
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => break None,
        }
    };
    let Some(status) = status else {
        let _ = child.kill();
        let _ = child.wait();
        let _ = reader.join();
        return Err(ReadFailure::Timeout);
    };
    let text = reader.join().unwrap_or_default();
    if !status.success() {
        return Err(ReadFailure::Exit);
    }
    Ok(String::from_utf8_lossy(&text).into_owned())
}

/// `refreshPathFromLoginShell`: read the login shell and apply what it printed. Returns
/// whether a `PATH` came back; any failure leaves the overlay as it was. Blocking.
pub fn refresh(shell: &str, timeout: Duration) -> bool {
    let Ok(output) = read_login_shell(shell, timeout, &[]) else {
        return false;
    };
    let values = extract(&output);
    if !values.iter().any(|(name, _)| *name == "PATH") {
        return false;
    }
    apply(&values);
    true
}

/// `SLOW_LOGIN_SHELL_TIMEOUT_MS`: one longer wait for a profile that is slow while the
/// machine boots.
pub const SLOW_TIMEOUT: Duration = Duration::from_secs(20);

/// `fixPath`'s POSIX part, at start: `$SHELL`, then the platform's shell, until one prints a
/// `PATH`; after the first timeout, one more try with [`SLOW_TIMEOUT`]. Unlike T3 it does not
/// read the account's shell from the user database nor ask `launchctl` on macOS. Blocking.
pub fn hydrate() -> bool {
    hydrate_from(std::env::var_os("SHELL").as_deref())
}

/// [`hydrate`] with `shell_var` in place of `$SHELL`: for a tool that proves the start-up
/// against a stand-in login shell without changing its own environment. Blocking.
pub fn hydrate_from(shell_var: Option<&OsStr>) -> bool {
    if !(cfg!(target_os = "macos") || cfg!(target_os = "linux")) {
        return false;
    }
    let mut candidates: Vec<String> = Vec::new();
    for candidate in [login_shell(shell_var, None), login_shell(None, None)]
        .into_iter()
        .flatten()
    {
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    let mut waited = false;
    for shell in &candidates {
        let mut output = read_login_shell(shell, TIMEOUT, &[]);
        if output == Err(ReadFailure::Timeout) && !waited {
            waited = true;
            output = read_login_shell(shell, SLOW_TIMEOUT, &[]);
        }
        let values = output.map(|text| extract(&text)).unwrap_or_default();
        if values.iter().any(|(name, _)| *name == "PATH") {
            apply(&values);
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn child_env_takes_the_overlay_and_survives_bytes_that_are_not_unicode() {
        use std::os::unix::ffi::OsStringExt;
        let base = vec![
            (OsString::from("PATH"), OsString::from("/usr/bin")),
            (OsString::from("ODD"), OsString::from_vec(vec![b'a', 0xff])),
        ];
        let env = overlay_onto(
            base.into_iter(),
            vec![
                ("PATH", OsString::from("/login:/usr/bin")),
                ("JAVA_HOME", OsString::from("/jdk")),
            ],
        );
        assert_eq!(
            env,
            [
                ("PATH".to_owned(), "/login:/usr/bin".to_owned()),
                ("ODD".to_owned(), "a\u{fffd}".to_owned()),
                ("JAVA_HOME".to_owned(), "/jdk".to_owned()),
            ]
        );
    }

    #[test]
    fn merges_like_merge_path_entries() {
        assert_eq!(
            merge_path_entries(Some("/a: /b ::/c"), Some("/b:/d")).as_deref(),
            Some("/a: /b :/c:/b:/d")
        );
        assert_eq!(merge_path_entries(None, Some("")), None);
    }

    #[test]
    fn extracts_between_the_markers() {
        let output = "motd line\n__T3CODE_ENV_PATH_START__\n/opt/bin:/usr/bin\n__T3CODE_ENV_PATH_END__\n__T3CODE_ENV___MISE_DIFF_START__\n__T3CODE_ENV___MISE_DIFF_END__\n";
        assert_eq!(extract(output), [("PATH", "/opt/bin:/usr/bin".to_owned())]);
        assert_eq!(extract("no markers"), []);
    }

    #[test]
    fn builds_the_capture_command_t3_builds() {
        assert_eq!(
            capture_command("/bin/zsh").as_deref(),
            Some(
                "printf '%s\\n' '__T3CODE_ENV_PATH_START__'; printenv PATH || true; printf '%s\\n' '__T3CODE_ENV_PATH_END__'; printf '%s\\n' '__T3CODE_ENV___MISE_DIFF_START__'; printenv __MISE_DIFF || true; printf '%s\\n' '__T3CODE_ENV___MISE_DIFF_END__'; printf '%s\\n' '__T3CODE_ENV_JAVA_HOME_START__'; printenv JAVA_HOME || true; printf '%s\\n' '__T3CODE_ENV_JAVA_HOME_END__'"
            )
        );
        assert!(
            capture_command("/usr/bin/bash")
                .is_some_and(|c| c.starts_with("(trap - DEBUG) 2>/dev/null && trap - DEBUG; "))
        );
        assert_eq!(capture_command("/opt/homebrew/bin/nu"), None);
    }

    #[test]
    fn picks_the_users_own_shell() {
        assert_eq!(
            login_shell(Some(OsStr::new(" /bin/fish ")), Some("/bin/zsh")).as_deref(),
            Some("/bin/fish")
        );
        assert_eq!(
            login_shell(Some(OsStr::new(" ")), Some("/bin/ksh")).as_deref(),
            Some("/bin/ksh")
        );
    }

    /// A stand-in login shell (a script that sets its own `PATH`, then runs the capture)
    /// prints a `PATH`; the overlay then puts it first, keeps the inherited entries after it,
    /// and leaves the server's own environment untouched. No real profile is read.
    #[test]
    fn a_login_shell_reaches_children_and_not_the_server() {
        let before = std::env::var_os("PATH");
        let fake_shell_path = "/conn-login-env-test/bin";
        let dir = std::env::temp_dir().join(format!("conn-login-env-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let shell = dir.join("fake-login-shell");
        crate::test_util::executable(
            &shell,
            &format!("#!/bin/sh\nPATH={fake_shell_path}:/usr/bin:/bin\nexport PATH\nexec /bin/sh -c \"$2\"\n"),
        )
        .expect("script");
        let output = read_login_shell(&shell.to_string_lossy(), TIMEOUT, &[]);
        let _ = std::fs::remove_dir_all(&dir);
        let output = output.expect("the shell answers");
        let values = extract(&output);
        assert_eq!(
            values
                .first()
                .map(|(n, v)| (*n, v.starts_with(fake_shell_path))),
            Some(("PATH", true)),
            "{output}"
        );
        apply(&values);
        let child_path = var_os("PATH")
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        assert!(child_path.starts_with(fake_shell_path), "{child_path}");
        assert_eq!(
            std::env::var_os("PATH"),
            before,
            "the server's own PATH is unchanged"
        );
        let probe = Command::new("sh")
            .args(["-c", "printf %s \"$PATH\""])
            .envs(vars())
            .output()
            .expect("sh");
        assert!(String::from_utf8_lossy(&probe.stdout).starts_with(fake_shell_path));
    }
}
