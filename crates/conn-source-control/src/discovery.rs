//! The generic host probe: `probeSourceControlProvider` for a `cli` spec, and the auth text
//! helpers, from `packages/source-control-core/src/server/discovery.ts`.

use std::{ffi::OsString, path::Path, time::Duration};

use conn_contract::{
    ServerProviderAuthStatus, SourceControlDiscoveryStatus, SourceControlProviderAuth,
    SourceControlProviderAuthAccountsItem, SourceControlProviderDiscoveryItem,
    VcsDiscoveryItemDetail, VcsDiscoveryItemDetailNone, VcsDiscoveryItemDetailSome, lit,
};
use conn_vcs::process::{GitCommand, OnLimit, ProcessError};

/// `DEFAULT_PROBE_TIMEOUT_MS`.
pub const DEFAULT_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// `maxOutputBytes` of every probe.
pub const PROBE_MAX_BYTES: usize = 8_000;
/// `OUTPUT_TRUNCATED_MARKER` in `VcsProcess.ts`, appended when `appendTruncationMarker`.
pub const TRUNCATED_MARKER: &str = "\n\n[truncated]";
const OPERATION_PROBE: &str = "source-control.discovery.probe";
const OPERATION_AUTH: &str = "source-control.discovery.auth";

pub fn some(value: impl Into<String>) -> VcsDiscoveryItemDetail {
    VcsDiscoveryItemDetail::Some(VcsDiscoveryItemDetailSome {
        tag: lit::Some,
        value: value.into(),
    })
}

pub fn none() -> VcsDiscoveryItemDetail {
    VcsDiscoveryItemDetail::None(VcsDiscoveryItemDetailNone { tag: lit::None2 })
}

/// `Option` of a trimmed, non-empty text, as `authAccount`, `authHost` and `authDetail` build it.
fn trimmed(value: Option<&str>) -> VcsDiscoveryItemDetail {
    match value.map(str::trim) {
        Some(text) if !text.is_empty() => some(text),
        _ => none(),
    }
}

/// `providerAuth`: status plus trimmed account, host and detail; no account list.
pub fn provider_auth(
    status: ServerProviderAuthStatus,
    account: Option<&str>,
    host: Option<&str>,
    detail: Option<&str>,
) -> SourceControlProviderAuth {
    SourceControlProviderAuth {
        status,
        account: trimmed(account),
        host: trimmed(host),
        detail: trimmed(detail),
        accounts: None,
    }
}

pub fn unknown_auth(detail: Option<&str>) -> SourceControlProviderAuth {
    provider_auth(ServerProviderAuthStatus::Unknown, None, None, detail)
}

/// What a probe's child printed, as `SourceControlAuthProbeInput` holds it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProbeOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

impl ProbeOutput {
    /// `combinedAuthOutput`: the non-blank streams, stdout first, joined by a newline.
    pub fn combined(&self) -> String {
        [self.stdout.as_str(), self.stderr.as_str()]
            .into_iter()
            .filter(|s| !s.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Why a probe child gave no output, with the T3 error's `message` as `detail`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProbeFailure {
    /// The executable is not on `PATH` (`isMissingExecutable`).
    Missing {
        message: String,
    },
    Timeout {
        message: String,
        timeout_ms: u64,
    },
    Exit {
        message: String,
        code: i32,
    },
    Failed {
        message: String,
    },
}

impl ProbeFailure {
    pub fn message(&self) -> &str {
        match self {
            ProbeFailure::Missing { message }
            | ProbeFailure::Timeout { message, .. }
            | ProbeFailure::Exit { message, .. }
            | ProbeFailure::Failed { message } => message,
        }
    }

    pub fn is_missing(&self) -> bool {
        matches!(self, ProbeFailure::Missing { .. })
    }
}

/// One probe child: bounded to [`PROBE_MAX_BYTES`] per stream with the truncation marker.
#[derive(Clone, Debug)]
pub struct ProbeCommand<'a> {
    pub operation: &'static str,
    pub executable: &'a str,
    pub args: Vec<String>,
    pub cwd: &'a Path,
    pub timeout: Duration,
    pub allow_non_zero_exit: bool,
    /// Variables added to the server's environment. A credential goes here only through
    /// [`crate::Secret::expose`].
    pub env: Vec<(&'static str, OsString)>,
    pub stdin: Option<Vec<u8>>,
}

impl<'a> ProbeCommand<'a> {
    pub fn new(operation: &'static str, executable: &'a str, args: &[&str], cwd: &'a Path) -> Self {
        Self {
            operation,
            executable,
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            cwd,
            timeout: DEFAULT_PROBE_TIMEOUT,
            allow_non_zero_exit: false,
            env: Vec::new(),
            stdin: None,
        }
    }
}

fn cap(text: String) -> String {
    if text.len() <= PROBE_MAX_BYTES {
        return text;
    }
    let mut end = PROBE_MAX_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = text.get(..end).unwrap_or_default().to_owned();
    out.push_str(TRUNCATED_MARKER);
    out
}

/// Runs one probe child as `VcsProcess.run` would, mapping failures to the T3 error messages.
pub async fn run_probe(command: ProbeCommand<'_>) -> Result<ProbeOutput, ProbeFailure> {
    let cwd_text = command.cwd.to_string_lossy().into_owned();
    let mut git = GitCommand::host_cli(
        command.operation,
        command.executable,
        command.cwd,
        command.args.iter().map(OsString::from),
    )
    .timeout(command.timeout)
    .max_stdout(PROBE_MAX_BYTES, OnLimit::Truncate);
    if command.allow_non_zero_exit {
        git = git.allow_exit(ALL_EXIT_CODES);
    }
    git.env = command.env;
    git.stdin = command.stdin;
    let context = format!("{}: {} ({cwd_text})", command.operation, command.executable);
    match git.run().await {
        Ok(output) => {
            let mut stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            if output.stdout_truncated {
                stdout.push_str(TRUNCATED_MARKER);
            }
            Ok(ProbeOutput {
                stdout,
                stderr: cap(output.stderr),
                exit_code: output.code,
            })
        }
        Err(ProcessError::Spawn { not_found, .. }) => {
            let message = format!("VCS process failed to spawn in {context}");
            Err(if not_found {
                ProbeFailure::Missing { message }
            } else {
                ProbeFailure::Failed { message }
            })
        }
        Err(ProcessError::Timeout { timeout_ms, .. }) => Err(ProbeFailure::Timeout {
            message: format!("VCS process timed out in {context} after {timeout_ms}ms"),
            timeout_ms,
        }),
        Err(ProcessError::Exit { code, stderr, .. }) => {
            let detail = classify_exit_detail(&stderr);
            Err(ProbeFailure::Exit {
                message: format!("VCS process failed in {context} exited with {code} - {detail}"),
                code,
            })
        }
        Err(ProcessError::OutputLimit {
            max_bytes,
            observed_bytes,
            ..
        }) => Err(ProbeFailure::Failed {
            message: format!(
                "VCS process stdout produced {observed_bytes} bytes in {context}, exceeding the {max_bytes} byte limit"
            ),
        }),
    }
}

/// Every exit code a child can report, for `allowNonZeroExit`.
const ALL_EXIT_CODES: &[i32] = &{
    let mut codes = [0i32; 512];
    let mut i = 0;
    while i < 512 {
        codes[i] = i as i32 - 255;
        i += 1;
    }
    codes
};

/// `classifyNonZeroExit` plus `VcsProcessExitError.fromProcessExit`'s detail.
fn classify_exit_detail(stderr: &str) -> &'static str {
    let s = stderr.to_lowercase();
    if [
        "authentication failed",
        "not logged in",
        "no oauth token",
        "unauthorized",
    ]
    .iter()
    .any(|p| s.contains(p))
    {
        "Authentication failed."
    } else if [
        "api rate limit",
        "rate limit exceeded",
        "secondary rate limit",
        "too many requests",
        "http 429",
    ]
    .iter()
    .any(|p| s.contains(p))
    {
        "API rate limit exceeded."
    } else {
        "Process exited with a non-zero status."
    }
}

/// Node's `stripVTControlCharacters`: CSI, OSC and two-byte escape sequences.
pub fn strip_vt(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(next) = chars.next() {
                        if next == '\u{7}' {
                            break;
                        }
                        if next == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            },
            '\u{9b}' => {
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// `firstNonEmptyLine`.
pub fn first_non_empty_line(text: &str) -> Option<String> {
    strip_vt(text)
        .split('\n')
        .map(|l| l.trim_end_matches('\r').trim())
        .find(|l| !l.is_empty())
        .map(str::to_owned)
}

/// `sanitizedAuthLines`: trimmed non-empty lines without `token:` / `token scopes:` lines.
fn sanitized_auth_lines(text: &str) -> impl Iterator<Item = &str> {
    text.split('\n')
        .map(|l| l.trim_end_matches('\r').trim())
        .filter(|l| !l.is_empty() && !is_token_line(l))
}

/// `/^[-\s]*token(?:\s+scopes?)?:/iu`.
fn is_token_line(line: &str) -> bool {
    let rest = line.trim_start_matches(|c: char| c == '-' || c.is_whitespace());
    let Some(after) = strip_prefix_ignore_case(rest, "token") else {
        return false;
    };
    if after.starts_with(':') {
        return true;
    }
    let spaced = after.trim_start();
    if spaced.len() == after.len() {
        return false;
    }
    strip_prefix_ignore_case(spaced, "scopes:")
        .or_else(|| strip_prefix_ignore_case(spaced, "scope:"))
        .is_some()
}

pub(crate) fn strip_prefix_ignore_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| text.get(prefix.len()..))
        .flatten()
}

/// `firstSafeAuthLine`.
pub fn first_safe_auth_line(text: &str) -> Option<String> {
    sanitized_auth_lines(text).next().map(str::to_owned)
}

/// `parseCliHost`: the first sanitized line that, without leading symbols, is a host name.
pub fn parse_cli_host(text: &str) -> Option<String> {
    sanitized_auth_lines(text)
        .map(|l| l.trim_start_matches(|c: char| !c.is_ascii_alphanumeric()))
        .find(|l| is_host_text(l))
        .map(str::to_owned)
}

/// `/^[a-z0-9][a-z0-9.-]*(?::\d+)?$/iu`.
fn is_host_text(line: &str) -> bool {
    let (name, port) = match line.split_once(':') {
        Some((name, port)) => (name, Some(port)),
        None => (line, None),
    };
    let name_ok = name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    let port_ok = port.is_none_or(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    name_ok && port_ok
}

/// A `cli` discovery spec.
#[derive(Clone, Debug)]
pub struct CliSpec {
    pub kind: &'static str,
    pub label: &'static str,
    pub executable: &'static str,
    pub version_args: &'static [&'static str],
    pub auth_args: Vec<String>,
    pub auth_retry_args: Option<Vec<String>>,
    pub probe_timeout: Duration,
    pub install_hint: &'static str,
}

/// `failedProbeHint`: a missing CLI keeps its install advice; another failure needs repair.
pub fn failed_probe_hint(spec: &CliSpec, failure: &ProbeFailure) -> String {
    if failure.is_missing() {
        return spec.install_hint.to_owned();
    }
    let command = std::iter::once(spec.executable)
        .chain(spec.version_args.iter().copied())
        .collect::<Vec<_>>()
        .join(" ");
    let outcome = match failure {
        ProbeFailure::Timeout { timeout_ms, .. } => format!("timed out after {timeout_ms}ms"),
        ProbeFailure::Exit { code, .. } => format!("exited with status {code}"),
        ProbeFailure::Missing { .. } | ProbeFailure::Failed { .. } => "failed".into(),
    };
    format!(
        "`{command}` {outcome}. Check the `{}` that the server's PATH resolves.",
        spec.executable
    )
}

/// Inputs every probe child of one spec shares: where it runs and what it adds to the
/// environment.
#[derive(Clone, Copy, Debug)]
pub struct ProbeContext<'a> {
    pub cwd: &'a Path,
    pub env: &'a [(&'static str, OsString)],
}

fn probe_command<'a>(
    ctx: ProbeContext<'a>,
    spec: &'a CliSpec,
    operation: &'static str,
    args: Vec<String>,
) -> ProbeCommand<'a> {
    ProbeCommand {
        operation,
        executable: spec.executable,
        args,
        cwd: ctx.cwd,
        timeout: spec.probe_timeout,
        allow_non_zero_exit: operation == OPERATION_AUTH,
        env: ctx.env.to_vec(),
        stdin: None,
    }
}

/// `probeSourceControlProvider` for a `cli` spec: the version and the sign-in probes at once.
pub async fn probe_cli(
    ctx: ProbeContext<'_>,
    spec: &CliSpec,
    parse_auth: impl Fn(&ProbeOutput) -> SourceControlProviderAuth,
) -> SourceControlProviderDiscoveryItem {
    let version_args = spec.version_args.iter().map(|a| (*a).to_owned()).collect();
    let version = run_probe(probe_command(ctx, spec, OPERATION_PROBE, version_args));
    let run_auth = |args: Vec<String>| {
        let parse = &parse_auth;
        async move {
            match run_probe(probe_command(ctx, spec, OPERATION_AUTH, args)).await {
                Ok(output) => parse(&output),
                Err(failure) => unknown_auth(Some(failure.message())),
            }
        }
    };
    let auth = async {
        let first = run_auth(spec.auth_args.clone()).await;
        match &spec.auth_retry_args {
            Some(retry) if first.status == ServerProviderAuthStatus::Unauthenticated => {
                let again = run_auth(retry.clone()).await;
                if again.status == ServerProviderAuthStatus::Authenticated {
                    again
                } else {
                    first
                }
            }
            _ => first,
        }
    };
    let (version, auth) = tokio::join!(version, auth);
    match version {
        Ok(output) => SourceControlProviderDiscoveryItem {
            kind: spec.kind.into(),
            label: spec.label.into(),
            executable: Some(spec.executable.into()),
            status: SourceControlDiscoveryStatus::Available,
            version: first_non_empty_line(&output.stdout)
                .or_else(|| first_non_empty_line(&output.stderr))
                .map_or_else(none, some),
            install_hint: spec.install_hint.into(),
            detail: none(),
            auth,
            app_sign_in: None,
        },
        Err(failure) => {
            let hint = failed_probe_hint(spec, &failure);
            SourceControlProviderDiscoveryItem {
                kind: spec.kind.into(),
                label: spec.label.into(),
                executable: Some(spec.executable.into()),
                status: SourceControlDiscoveryStatus::Missing,
                version: none(),
                detail: trimmed(Some(failure.message())),
                auth: unknown_auth(Some(&hint)),
                install_hint: hint,
                app_sign_in: None,
            }
        }
    }
}

/// An `api` spec's item: available, no version, the auth the probe found within 3 s.
pub fn api_item(
    kind: &str,
    label: &str,
    install_hint: &str,
    auth: Option<SourceControlProviderAuth>,
) -> SourceControlProviderDiscoveryItem {
    SourceControlProviderDiscoveryItem {
        kind: kind.into(),
        label: label.into(),
        executable: None,
        status: SourceControlDiscoveryStatus::Available,
        version: none(),
        install_hint: install_hint.into(),
        detail: none(),
        auth: auth.unwrap_or_else(|| {
            unknown_auth(Some(
                "The hosting service did not answer in time. Refresh to try again.",
            ))
        }),
        app_sign_in: None,
    }
}

/// `API_PROBE_TIMEOUT`.
pub const API_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// An account row of `SourceControlProviderAuth.accounts`.
pub fn account_row(
    host: &str,
    account: &str,
    active: bool,
    authenticated: bool,
) -> SourceControlProviderAuthAccountsItem {
    SourceControlProviderAuthAccountsItem {
        host: host.into(),
        account: account.into(),
        active,
        authenticated,
        error: None,
        environment_variable: None,
    }
}

#[cfg(test)]
pub(crate) mod stub {
    //! A stub executable that records its argv and chosen environment variables, and answers
    //! from a script keyed on its arguments.

    use std::{os::unix::fs::PermissionsExt, path::PathBuf};

    #[derive(Debug)]
    pub(crate) struct StubDir {
        pub(crate) dir: PathBuf,
    }

    impl StubDir {
        pub(crate) fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "conn-sc-stub-{name}-{}-{}",
                std::process::id(),
                conn_test_counter()
            ));
            std::fs::create_dir_all(&dir).expect("stub dir");
            Self { dir }
        }

        /// Writes `<dir>/<name>`: a shell script that appends `argv` (one line, NUL-free, args
        /// joined by U+001F) and the listed variables to `<dir>/<name>.log`, then runs `body`.
        pub(crate) fn executable(&self, name: &str, record_env: &[&str], body: &str) -> String {
            let path = self.dir.join(name);
            let log = self.dir.join(format!("{name}.log"));
            let mut env_lines = String::new();
            for var in record_env {
                env_lines.push_str(&format!(
                    "printf '  env %s=%s\\n' '{var}' \"${{{var}-<unset>}}\" >> '{}'\n",
                    log.display()
                ));
            }
            let script = format!(
                "#!/bin/sh\n(printf 'argv'; for a in \"$@\"; do printf ' %s' \"$a\"; done; printf '\\n') >> '{log}'\n{env_lines}{body}\n",
                log = log.display()
            );
            std::fs::write(&path, script).expect("write stub");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .expect("chmod stub");
            path.to_string_lossy().into_owned()
        }

        /// `PATH` for a child: this folder first, then the server's own `PATH`.
        pub(crate) fn path_env(&self) -> Vec<(&'static str, std::ffi::OsString)> {
            let mut path = std::ffi::OsString::from(&self.dir);
            if let Some(rest) = std::env::var_os("PATH") {
                path.push(":");
                path.push(rest);
            }
            vec![("PATH", path)]
        }

        pub(crate) fn log(&self, name: &str) -> String {
            std::fs::read_to_string(self.dir.join(format!("{name}.log"))).unwrap_or_default()
        }
    }

    impl Drop for StubDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn conn_test_counter() -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        NEXT.fetch_add(1, Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_text_helpers_follow_discovery_ts() {
        assert_eq!(
            first_safe_auth_line("  token: abc\n- Token scopes: repo\n\nLogged in\n").as_deref(),
            Some("Logged in"),
            "token lines are never shown"
        );
        assert_eq!(
            parse_cli_host("✓ Logged in\n  ✓ gitlab.example.com:8443\n").as_deref(),
            Some("gitlab.example.com:8443"),
            "a host line after symbols"
        );
        assert_eq!(
            first_non_empty_line("\n\u{1b}[1mgh version 2.81.0\u{1b}[0m (2025)\n").as_deref(),
            Some("gh version 2.81.0 (2025)"),
            "escapes stripped"
        );
        let output = ProbeOutput {
            stdout: " \n".into(),
            stderr: "err".into(),
            exit_code: 1,
        };
        assert_eq!(output.combined(), "err", "blank streams are left out");
    }

    fn spec(executable: &'static str) -> CliSpec {
        CliSpec {
            kind: "alpha",
            label: "alpha",
            executable,
            version_args: &["--version"],
            auth_args: vec!["auth".into(), "status".into()],
            auth_retry_args: None,
            probe_timeout: DEFAULT_PROBE_TIMEOUT,
            install_hint: "Install alpha.",
        }
    }

    fn signed_in(output: &ProbeOutput) -> SourceControlProviderAuth {
        let account = output
            .stdout
            .split_once("as ")
            .map(|(_, a)| a.trim().to_owned());
        provider_auth(
            ServerProviderAuthStatus::Authenticated,
            account.as_deref(),
            None,
            None,
        )
    }

    /// `SourceControlDiscovery.test.ts`: an available CLI, a missing one, a broken one.
    #[tokio::test(flavor = "current_thread")]
    async fn probes_like_source_control_discovery_test() {
        let stubs = stub::StubDir::new("probe");
        let alpha = stubs.executable(
            "alpha-cli",
            &[],
            "if [ \"$1\" = --version ]; then echo 'alpha-cli version test'; else echo 'signed in as alpha-cli-user'; fi",
        );
        let cwd = std::env::temp_dir();
        let ctx = ProbeContext {
            cwd: &cwd,
            env: &[],
        };
        let leaked: &'static str = Box::leak(alpha.into_boxed_str());
        let item = probe_cli(ctx, &spec(leaked), signed_in).await;
        assert_eq!(
            item.status,
            SourceControlDiscoveryStatus::Available,
            "available"
        );
        assert_eq!(item.version, some("alpha-cli version test"), "version line");
        assert_eq!(item.auth.account, some("alpha-cli-user"), "auth parsed");
        assert_eq!(
            stubs.log("alpha-cli"),
            "argv --version\nargv auth status\n",
            "argv"
        );

        let missing = probe_cli(ctx, &spec("conn-sc-absent-cli"), signed_in).await;
        assert_eq!(
            missing.status,
            SourceControlDiscoveryStatus::Missing,
            "missing"
        );
        assert_eq!(
            missing.install_hint, "Install alpha.",
            "keeps install advice"
        );
        assert_eq!(
            missing.auth.status,
            ServerProviderAuthStatus::Unknown,
            "unknown"
        );
        assert_eq!(
            missing.auth.detail,
            some("Install alpha."),
            "hint as detail"
        );

        let broken = stubs.executable(
            "broken-cli",
            &[],
            "echo 'broken-cli: bad install' >&2; exit 1",
        );
        let leaked: &'static str = Box::leak(broken.into_boxed_str());
        let item = probe_cli(ctx, &spec(leaked), signed_in).await;
        assert_eq!(item.status, SourceControlDiscoveryStatus::Missing, "broken");
        assert_eq!(
            item.install_hint,
            format!(
                "`{leaked} --version` exited with status 1. Check the `{leaked}` that the server's PATH resolves."
            ),
            "repair advice"
        );
    }
}
