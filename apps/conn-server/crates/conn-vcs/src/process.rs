//! Runs `git` (or a source control host's CLI, such as `gh`) as a child process with a
//! timeout and bounded output.
//!
//! Every read is bounded: stdout stops at `max_stdout` bytes (then the child is killed and the
//! output is either marked truncated or failed, as the caller chooses), stderr at
//! [`MAX_STDERR_BYTES`]. Nothing waits on a pool thread: tokio drives the pipes.

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};

/// What [`GitCommand::scan`] hands each stdout chunk to.
pub type Scanner<'a> = &'a mut (dyn FnMut(&[u8]) + Send);

/// `apps/server/src/vcs/VcsProcess.ts`: stderr kept for error classification.
pub const MAX_STDERR_BYTES: usize = 64 * 1024;
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
pub const DEFAULT_MAX_STDOUT: usize = 1_000_000;

/// What to do when stdout passes `max_stdout`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnLimit {
    /// Keep the first `max_stdout` bytes and mark the output truncated.
    Truncate,
    /// Fail with [`ProcessError::OutputLimit`].
    Fail,
}

#[derive(Clone, Debug)]
pub struct GitCommand {
    pub operation: &'static str,
    /// `git`, or a host CLI from [`GitCommand::host_cli`].
    pub program: OsString,
    pub cwd: PathBuf,
    pub args: Vec<OsString>,
    pub timeout: Duration,
    pub max_stdout: usize,
    pub on_limit: OnLimit,
    /// Exit codes that count as success besides 0 (`git diff --no-index` exits 1 on changes).
    pub allow_exit: &'static [i32],
    pub stdin: Option<Vec<u8>>,
    pub env: Vec<(&'static str, OsString)>,
}

impl GitCommand {
    pub fn new<I, S>(operation: &'static str, cwd: &Path, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        Self {
            operation,
            program: "git".into(),
            cwd: cwd.to_owned(),
            args: args.into_iter().map(Into::into).collect(),
            timeout: DEFAULT_TIMEOUT,
            max_stdout: DEFAULT_MAX_STDOUT,
            on_limit: OnLimit::Fail,
            allow_exit: &[],
            stdin: None,
            env: Vec::new(),
        }
    }

    /// A source control host's CLI (`gh`), run as `VcsProcess.ts` runs a
    /// command that is not `git`: the server's environment plus `safe.bareRepository=explicit`
    /// through `GIT_CONFIG_*` (`explicitBareRepositoryEnv`), and none of the `git`-only
    /// variables.
    pub fn host_cli<I, S>(operation: &'static str, program: &str, cwd: &Path, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        Self {
            program: program.into(),
            ..Self::new(operation, cwd, args)
        }
    }

    fn is_git(&self) -> bool {
        self.program == "git"
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn max_stdout(mut self, bytes: usize, on_limit: OnLimit) -> Self {
        self.max_stdout = bytes;
        self.on_limit = on_limit;
        self
    }

    pub fn allow_exit(mut self, codes: &'static [i32]) -> Self {
        self.allow_exit = codes;
        self
    }

    pub fn stdin(mut self, input: Vec<u8>) -> Self {
        self.stdin = Some(input);
        self
    }

    pub fn env(mut self, key: &'static str, value: impl Into<OsString>) -> Self {
        self.env.push((key, value.into()));
        self
    }

    /// `git <first arg>`, as the TypeScript errors name a command without its arguments.
    pub fn command_label(&self) -> String {
        let program = self.program.to_string_lossy();
        match self.args.first() {
            Some(sub) => format!("{program} {}", sub.to_string_lossy()),
            None => program.into_owned(),
        }
    }

    pub async fn run(self) -> Result<GitOutput, ProcessError> {
        run(self, None).await
    }

    /// Runs and hands every stdout chunk to `scan` instead of keeping it, so a long listing
    /// (`ls-files` of a large index) costs one chunk of memory. The output's `stdout` is empty.
    pub async fn scan(self, scan: Scanner<'_>) -> Result<GitOutput, ProcessError> {
        run(self, Some(scan)).await
    }

    /// Runs and returns stdout as text, failing on a non-zero exit.
    pub async fn text(self) -> Result<String, ProcessError> {
        let output = self.run().await?;
        Ok(output.stdout_text())
    }
}

#[derive(Clone, Debug, Default)]
pub struct GitOutput {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub stdout_truncated: bool,
}

impl GitOutput {
    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

/// Where and what failed, for the contract error the caller builds.
#[derive(Clone, Debug, PartialEq)]
pub struct ProcessContext {
    pub operation: &'static str,
    pub command: String,
    pub cwd: String,
    pub argument_count: usize,
}

#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum ProcessError {
    #[error("{} failed to start in {}: {message}", .context.command, .context.operation)]
    Spawn {
        context: ProcessContext,
        message: String,
        /// The executable was not found (the cwd is checked by the caller).
        not_found: bool,
    },
    #[error("{} timed out after {timeout_ms}ms in {}", .context.command, .context.operation)]
    Timeout {
        context: ProcessContext,
        timeout_ms: u64,
    },
    #[error("{} produced more than {max_bytes} bytes in {}", .context.command, .context.operation)]
    OutputLimit {
        context: ProcessContext,
        max_bytes: usize,
        observed_bytes: usize,
    },
    #[error("{} exited with {code} in {}: {}", .context.command, .context.operation, .stderr.trim())]
    Exit {
        context: ProcessContext,
        code: i32,
        stderr: String,
        stderr_truncated: bool,
    },
}

impl ProcessError {
    pub fn context(&self) -> &ProcessContext {
        match self {
            ProcessError::Spawn { context, .. }
            | ProcessError::Timeout { context, .. }
            | ProcessError::OutputLimit { context, .. }
            | ProcessError::Exit { context, .. } => context,
        }
    }

    pub fn stderr(&self) -> &str {
        match self {
            ProcessError::Exit { stderr, .. } => stderr,
            _ => "",
        }
    }

    /// Whether the child ran to its end and exited with a code; a signal leaves it without one.
    pub fn is_completed_exit(&self) -> bool {
        matches!(self, ProcessError::Exit { code, .. } if *code != SIGNALLED)
    }
}

/// Kills a process group with `SIGKILL` when dropped, unless disarmed.
pub(crate) struct GroupKill(Option<rustix::process::Pid>);

impl GroupKill {
    /// The group a child started with `process_group(0)` leads.
    pub(crate) fn of(pid: Option<u32>) -> Self {
        Self(
            pid.and_then(|id| i32::try_from(id).ok())
                .and_then(rustix::process::Pid::from_raw),
        )
    }

    pub(crate) fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for GroupKill {
    fn drop(&mut self) {
        if let Some(group) = self.0.take() {
            let _ = rustix::process::kill_process_group(group, rustix::process::Signal::KILL);
        }
    }
}

/// The code in [`ProcessError::Exit`] for a child that a signal ended (`ExitStatus::code` is
/// `None`). T3 fails such a command before a caller sees an exit code.
pub const SIGNALLED: i32 = -1;

async fn run(command: GitCommand, scan: Option<Scanner<'_>>) -> Result<GitOutput, ProcessError> {
    let context = ProcessContext {
        operation: command.operation,
        command: command.command_label(),
        cwd: command.cwd.to_string_lossy().into_owned(),
        argument_count: command.args.len(),
    };
    let mut child = Command::new(&command.program);
    child.args(&command.args).current_dir(&command.cwd);
    if command.is_git() {
        unset_inherited_repository_env(&mut child);
        // Status reads must not take `index.lock` from under an agent's own git commands.
        child
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C");
    } else {
        for (key, value) in explicit_bare_repository_env() {
            child.env(key, value);
        }
    }
    child
        .stdin(if command.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Its own group: a run that is stopped (a cancelled setup, a timeout) kills git and
        // what it started, such as a `post-checkout` hook and the hook's children.
        .process_group(0)
        .kill_on_drop(true);
    // The login shell's PATH (`conn_support::login_env`); the caller's own variables win.
    child.envs(conn_support::login_env::vars());
    for (key, value) in &command.env {
        child.env(key, value);
    }
    conn_support::spawn_guard::check(child.as_std());
    let mut child = child.spawn().map_err(|e| ProcessError::Spawn {
        context: context.clone(),
        message: e.to_string(),
        not_found: e.kind() == std::io::ErrorKind::NotFound,
    })?;

    let mut group = GroupKill::of(child.id());
    let stdin = command.stdin.clone();
    let mut stdin_pipe = child.stdin.take();
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let work = async {
        let write = async {
            if let (Some(pipe), Some(input)) = (stdin_pipe.as_mut(), stdin) {
                // A child that exits early closes the pipe; its exit code tells the story.
                let _ = pipe.write_all(&input).await;
            }
            drop(stdin_pipe.take());
        };
        let read_stdout = async {
            if let Some(scan) = scan {
                read_scanned(&mut stdout, scan).await;
                return (Vec::new(), None);
            }
            let (out, over) = read_bounded(&mut stdout, command.max_stdout, false).await;
            if over.is_some() {
                // Stop git now: it would block on the full pipe, and stderr would never end.
                let _ = child.start_kill();
            }
            (out, over)
        };
        let ((out, over), (err, err_truncated), ()) = tokio::join!(
            read_stdout,
            read_bounded(&mut stderr, MAX_STDERR_BYTES, true),
            write
        );
        (out, over, err, err_truncated.is_some())
    };

    let (stdout, stdout_over, stderr, stderr_truncated) =
        match tokio::time::timeout(command.timeout, work).await {
            Ok(result) => result,
            Err(_) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err(ProcessError::Timeout {
                    context,
                    timeout_ms: command.timeout.as_millis() as u64,
                });
            }
        };

    let status = match tokio::time::timeout(command.timeout, child.wait()).await {
        Ok(Ok(status)) => {
            // Git ended on its own: what it left running in the background stays.
            group.disarm();
            status
        }
        Ok(Err(e)) => {
            return Err(ProcessError::Spawn {
                context,
                message: e.to_string(),
                not_found: false,
            });
        }
        Err(_) => {
            let _ = child.start_kill();
            return Err(ProcessError::Timeout {
                context,
                timeout_ms: command.timeout.as_millis() as u64,
            });
        }
    };
    let stderr = String::from_utf8_lossy(&stderr).into_owned();

    if let Some(observed) = stdout_over {
        return match command.on_limit {
            OnLimit::Fail => Err(ProcessError::OutputLimit {
                context,
                max_bytes: command.max_stdout,
                observed_bytes: observed,
            }),
            OnLimit::Truncate => Ok(GitOutput {
                code: 0,
                stdout,
                stderr,
                stdout_truncated: true,
            }),
        };
    }

    let code = status.code().unwrap_or(SIGNALLED);
    if code != 0 && !command.allow_exit.contains(&code) {
        return Err(ProcessError::Exit {
            context,
            code,
            stderr,
            stderr_truncated,
        });
    }
    Ok(GitOutput {
        code,
        stdout,
        stderr,
        stdout_truncated: false,
    })
}

/// `explicitBareRepositoryEnv` in `VcsProcess.ts`: one more `GIT_CONFIG_KEY_<n>` /
/// `GIT_CONFIG_VALUE_<n>` pair after the ones the server inherited, so a `git` that a host CLI
/// starts opens a bare repository only when told to.
/// `REPOSITORY_SELECTORS` in `VcsProcess.ts`.
const REPOSITORY_SELECTORS: [&str; 6] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

/// `unsetInheritedRepositoryEnv`: the repository selectors among `inherited`, such as a Git
/// hook's `GIT_DIR`, so that Git finds the repository from its working folder. A command's own
/// variables, set after, may still name them.
pub fn inherited_repository_selectors<'a>(
    inherited: impl IntoIterator<Item = &'a std::ffi::OsStr>,
) -> Vec<&'static str> {
    let mut found: Vec<&'static str> = Vec::new();
    for name in inherited {
        if let Some(selector) = REPOSITORY_SELECTORS.iter().find(|s| name == **s)
            && !found.contains(selector)
        {
            found.push(selector);
        }
    }
    found
}

/// Removes the repository selectors the server inherited from a `git` child's environment.
pub fn unset_inherited_repository_env(command: &mut Command) {
    let names: Vec<std::ffi::OsString> = std::env::vars_os().map(|(name, _)| name).collect();
    for selector in inherited_repository_selectors(names.iter().map(std::ffi::OsString::as_os_str))
    {
        command.env_remove(selector);
    }
}

pub fn explicit_bare_repository_env() -> Vec<(String, String)> {
    git_config_env(std::env::var("GIT_CONFIG_COUNT").ok().as_deref())
}

/// `gitConfigEnv` for `safe.bareRepository=explicit`: an inherited count that is not Git's
/// count syntax (leading white space, an optional `+` and digits, or `-0`) adds nothing.
fn git_config_env(inherited: Option<&str>) -> Vec<(String, String)> {
    let count = match inherited {
        None | Some("") => 0,
        Some(text) => {
            let body = text.trim_start_matches([' ', '\t', '\r', '\n', '\x0b', '\x0c']);
            let digits = body.strip_prefix('+').unwrap_or(body);
            let negative_zero =
                body.len() > 1 && body.starts_with('-') && body.bytes().skip(1).all(|b| b == b'0');
            if negative_zero {
                0
            } else if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
                match digits.parse::<u64>() {
                    Ok(count) => count,
                    Err(_) => return Vec::new(),
                }
            } else {
                return Vec::new();
            }
        }
    };
    vec![
        ("GIT_CONFIG_COUNT".into(), (count + 1).to_string()),
        (
            format!("GIT_CONFIG_KEY_{count}"),
            "safe.bareRepository".into(),
        ),
        (format!("GIT_CONFIG_VALUE_{count}"), "explicit".into()),
    ]
}

/// Reads to EOF and hands each chunk to `scan`.
async fn read_scanned<R: AsyncRead + Unpin>(reader: &mut R, scan: Scanner<'_>) {
    let mut chunk = vec![0u8; 8192];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => scan(chunk.get(..n).unwrap_or_default()),
        }
    }
}

/// Reads at most `limit` bytes. Returns the bytes and, when the stream had more, how many
/// bytes were seen. With `drain`, reading goes on to EOF and the excess is dropped (stderr,
/// so the child never blocks on it); without, reading stops at the limit.
async fn read_bounded<R: AsyncRead + Unpin>(
    reader: &mut R,
    limit: usize,
    drain: bool,
) -> (Vec<u8>, Option<usize>) {
    let mut buffer = Vec::new();
    // On the heap: an 8 KiB array would sit in every git future (stdout and stderr each),
    // which makes them about 18 KiB (clippy's `large_futures`).
    let mut chunk = vec![0u8; 8192];
    let mut seen = 0usize;
    loop {
        let n = match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        seen += n;
        let room = limit.saturating_sub(buffer.len());
        buffer.extend_from_slice(&chunk[..n.min(room)]);
        if n > room && !drain {
            return (buffer, Some(seen));
        }
    }
    (buffer, (seen > limit).then_some(seen))
}

#[cfg(test)]
mod tests {
    // `unsetInheritedRepositoryEnv` on a POSIX host: exact names only, each once.
    #[test]
    fn finds_the_inherited_repository_selectors() {
        let names = [
            "PATH",
            "GIT_DIR",
            "git_dir",
            "GIT_WORK_TREE",
            "GIT_DIR",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_CONFIG_COUNT",
        ];
        let found = super::inherited_repository_selectors(names.iter().map(std::ffi::OsStr::new));
        assert_eq!(
            found,
            [
                "GIT_DIR",
                "GIT_WORK_TREE",
                "GIT_ALTERNATE_OBJECT_DIRECTORIES"
            ]
        );
    }

    #[test]
    fn host_clis_get_the_bare_repository_guard() {
        use super::git_config_env;
        let pairs = |v: Option<&str>| git_config_env(v);
        assert_eq!(
            pairs(None),
            vec![
                ("GIT_CONFIG_COUNT".to_owned(), "1".to_owned()),
                (
                    "GIT_CONFIG_KEY_0".to_owned(),
                    "safe.bareRepository".to_owned()
                ),
                ("GIT_CONFIG_VALUE_0".to_owned(), "explicit".to_owned()),
            ],
            "nothing inherited"
        );
        assert_eq!(
            pairs(Some(" +2")).first().map(|p| p.1.as_str()),
            Some("3"),
            "+2"
        );
        assert_eq!(
            pairs(Some("-00")).first().map(|p| p.1.as_str()),
            Some("1"),
            "-0"
        );
        assert!(pairs(Some("x")).is_empty(), "invalid count adds nothing");
        assert!(
            pairs(Some("2 ")).is_empty(),
            "trailing text is not Git's syntax"
        );
    }

    use super::*;

    #[test]
    fn process_errors_read_as_before() {
        let context = ProcessContext {
            operation: "GitCore.status",
            command: "git status".into(),
            cwd: "/repo".into(),
            argument_count: 1,
        };
        let cases = [
            (
                ProcessError::Spawn {
                    context: context.clone(),
                    message: "not found".into(),
                    not_found: true,
                },
                "git status failed to start in GitCore.status: not found",
            ),
            (
                ProcessError::Timeout {
                    context: context.clone(),
                    timeout_ms: 30_000,
                },
                "git status timed out after 30000ms in GitCore.status",
            ),
            (
                ProcessError::OutputLimit {
                    context: context.clone(),
                    max_bytes: 10,
                    observed_bytes: 11,
                },
                "git status produced more than 10 bytes in GitCore.status",
            ),
            (
                ProcessError::Exit {
                    context,
                    code: 128,
                    stderr: "fatal: not a git repository\n".into(),
                    stderr_truncated: false,
                },
                "git status exited with 128 in GitCore.status: fatal: not a git repository",
            ),
        ];
        for (error, text) in cases {
            assert_eq!(error.to_string(), text);
            assert_eq!(
                crate::VcsError::from(error).to_string(),
                text,
                "VcsError is transparent"
            );
        }
    }

    #[tokio::test]
    async fn bounded_stdout_truncates_or_fails() {
        let dir = std::env::temp_dir();
        let out = GitCommand::new("test", &dir, ["--version"])
            .max_stdout(4, OnLimit::Truncate)
            .run()
            .await
            .unwrap();
        assert!(out.stdout_truncated);
        assert_eq!(out.stdout, b"git ");

        let err = GitCommand::new("test", &dir, ["--version"])
            .max_stdout(4, OnLimit::Fail)
            .run()
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            ProcessError::OutputLimit { max_bytes: 4, .. }
        ));
    }

    #[tokio::test]
    async fn non_zero_exit_carries_stderr() {
        let dir = tempdir();
        let err = GitCommand::new("test", &dir, ["rev-parse", "HEAD"])
            .run()
            .await
            .unwrap_err();
        let ProcessError::Exit { code, stderr, .. } = err else {
            panic!("{err:?}")
        };
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(code, 128);
        assert!(stderr.contains("not a git repository"), "{stderr}");
    }

    /// The state letter of process `pid` from `ps`, or `None` when it is gone.
    fn process_state(pid: &str) -> Option<String> {
        let out = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", pid])
            .output()
            .unwrap();
        let state = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        (!state.is_empty()).then_some(state)
    }

    /// A child whose run is cancelled (the caller's future dropped, as when a client call
    /// ends) and one that times out are killed and reaped: no zombie stays while the server
    /// runs. Each case runs `sh`, which writes its pid and then sleeps.
    #[tokio::test]
    async fn cancelled_and_timed_out_children_are_reaped() {
        // Its own folder: other tests here remove the shared `tempdir()`.
        let dir = std::env::temp_dir().join(format!("conn-vcs-reap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for (case, cancel) in [("cancelled", true), ("timed-out", false)] {
            let pid_file = dir.join(format!("{case}.pid"));
            let script = format!("echo $$ > '{}'; exec sleep 30", pid_file.display());
            let command = GitCommand::host_cli("test", "sh", &dir, ["-c", script.as_str()])
                .timeout(Duration::from_secs(if cancel { 30 } else { 2 }));
            let written = async {
                while std::fs::read_to_string(&pid_file).map_or(true, |t| !t.ends_with('\n')) {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            };
            if cancel {
                // Drop the run once the child is up, as a client call that ends drops it.
                tokio::select! {
                    ran = command.run() => panic!("{case}: the run ended: {ran:?}"),
                    () = written => {}
                }
            } else {
                let err = command.run().await.unwrap_err();
                assert!(
                    matches!(err, ProcessError::Timeout { .. }),
                    "{case}: {err:?}"
                );
            }
            let pid = std::fs::read_to_string(&pid_file)
                .unwrap()
                .trim()
                .to_owned();
            let mut state = process_state(&pid);
            for _ in 0..100 {
                if state.is_none() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
                state = process_state(&pid);
            }
            assert_eq!(
                state, None,
                "{case}: child {pid} is still there (Z is a zombie)"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn tempdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("conn-vcs-proc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
