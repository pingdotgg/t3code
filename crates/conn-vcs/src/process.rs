//! Runs `git` as a child process with a timeout and bounded output.
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
        match self.args.first() {
            Some(sub) => format!("git {}", sub.to_string_lossy()),
            None => "git".into(),
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
}

async fn run(command: GitCommand, scan: Option<Scanner<'_>>) -> Result<GitOutput, ProcessError> {
    let context = ProcessContext {
        operation: command.operation,
        command: command.command_label(),
        cwd: command.cwd.to_string_lossy().into_owned(),
        argument_count: command.args.len(),
    };
    let mut child = Command::new("git");
    child
        .args(&command.args)
        .current_dir(&command.cwd)
        // Status reads must not take `index.lock` from under an agent's own git commands.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(if command.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in &command.env {
        child.env(key, value);
    }
    let mut child = child.spawn().map_err(|e| ProcessError::Spawn {
        context: context.clone(),
        message: e.to_string(),
    })?;

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
        Ok(Ok(status)) => status,
        Ok(Err(e)) => {
            return Err(ProcessError::Spawn {
                context,
                message: e.to_string(),
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

    let code = status.code().unwrap_or(-1);
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

    fn tempdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("conn-vcs-proc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
