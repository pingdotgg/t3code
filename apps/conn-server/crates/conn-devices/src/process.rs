//! Child processes with a deadline and bounded output: simctl, adb, ssh, npm, Node.

use std::{path::PathBuf, process::Stdio, time::Duration};

use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};

/// Output beyond this is dropped. A screenshot through `base64` is the largest answer
/// (`maxOutputBytes` 64 MiB in T3).
pub(crate) const MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, Default)]
pub(crate) struct Run {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
    /// Added to the server's own environment, or removed with `None`.
    pub(crate) env: Vec<(String, Option<String>)>,
    pub(crate) cwd: Option<PathBuf>,
    pub(crate) stdin: Option<String>,
    pub(crate) timeout: Option<Duration>,
    pub(crate) max_output: Option<usize>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Output {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    /// `None` when the process did not exit on its own (a signal or the deadline).
    pub(crate) code: Option<i32>,
    pub(crate) timed_out: bool,
    /// The spawn failed: the program is missing or not executable.
    pub(crate) not_found: bool,
    pub(crate) spawn_error: Option<String>,
}

impl Output {
    pub(crate) fn ok(&self) -> bool {
        self.code == Some(0) && !self.timed_out
    }
}

impl Run {
    pub(crate) fn new(
        program: impl Into<String>,
        args: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
            ..Self::default()
        }
    }

    pub(crate) fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub(crate) fn env(mut self, name: &str, value: &str) -> Self {
        self.env.push((name.to_owned(), Some(value.to_owned())));
        self
    }

    pub(crate) fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    pub(crate) fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command.args(&self.args);
        for (name, value) in &self.env {
            match value {
                Some(value) => command.env(name, value),
                None => command.env_remove(name),
            };
        }
        if let Some(cwd) = &self.cwd {
            command.current_dir(cwd);
        }
        command
    }

    /// Runs to the end, or kills the process at the deadline.
    pub(crate) async fn output(&self) -> Output {
        let mut command = self.command();
        command
            .stdin(if self.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(debug_assertions)]
        conn_support::spawn_guard::check(command.as_std());
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                return Output {
                    not_found: matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
                    ),
                    spawn_error: Some(error.to_string()),
                    ..Output::default()
                };
            }
        };
        let cap = self.max_output.unwrap_or(MAX_OUTPUT_BYTES);
        let stdin = child.stdin.take();
        let input = self.stdin.clone();
        let feed = async move {
            if let (Some(mut pipe), Some(text)) = (stdin, input) {
                let _ = pipe.write_all(text.as_bytes()).await;
                let _ = pipe.shutdown().await;
            }
        };
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let work = async {
            let ((), out, err, status) = tokio::join!(
                feed,
                read_capped(stdout, cap),
                read_capped(stderr, cap),
                child.wait()
            );
            (out, err, status)
        };
        let result = match self.timeout {
            Some(limit) => tokio::time::timeout(limit, work).await.ok(),
            None => Some(work.await),
        };
        match result {
            Some((stdout, stderr, status)) => Output {
                stdout,
                stderr,
                code: status.ok().and_then(|s| s.code()),
                ..Output::default()
            },
            None => Output {
                timed_out: true,
                ..Output::default()
            },
        }
    }
}

async fn read_capped<R: AsyncRead + Unpin>(reader: Option<R>, cap: usize) -> String {
    let Some(mut reader) = reader else {
        return String::new();
    };
    let mut kept = Vec::new();
    let mut chunk = vec![0u8; 16 * 1024];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = cap.saturating_sub(kept.len());
                kept.extend_from_slice(chunk.get(..n.min(room)).unwrap_or_default());
            }
        }
    }
    String::from_utf8_lossy(&kept).into_owned()
}

/// Asks a child to stop with SIGTERM (the hub cleans up its capture sessions and recordings
/// then), waits up to `grace`, and only then kills it.
pub(crate) async fn terminate(child: &mut tokio::process::Child, grace: Duration) {
    let pid = child
        .id()
        .and_then(|pid| i32::try_from(pid).ok())
        .and_then(rustix::process::Pid::from_raw);
    if let Some(pid) = pid {
        let _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
        if tokio::time::timeout(grace, child.wait()).await.is_ok() {
            return;
        }
    }
    let _ = child.kill().await;
}

/// `PATH` lookup, as `which`: the first executable file named `name`.
pub(crate) fn find_on_path(name: &str, path: Option<&str>) -> Option<PathBuf> {
    let path = path
        .map(str::to_owned)
        .or_else(|| std::env::var("PATH").ok())?;
    path.split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| PathBuf::from(dir).join(name))
        .find(|candidate| is_executable(candidate))
}

pub(crate) fn is_executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn feeds_stdin_and_caps_output() {
        let out = Run {
            stdin: Some("hello".into()),
            ..Run::new("sh", ["-c", "cat; echo err >&2; exit 3"])
        }
        .output()
        .await;
        assert_eq!(out.stdout, "hello", "stdout");
        assert_eq!(out.stderr, "err\n", "stderr");
        assert_eq!(out.code, Some(3), "code");
        let capped = Run {
            max_output: Some(4),
            ..Run::new("sh", ["-c", "printf 0123456789"])
        }
        .output()
        .await;
        assert_eq!(capped.stdout, "0123", "capped");
        let missing = Run::new("conn-devices-no-such-program", Vec::<String>::new())
            .output()
            .await;
        assert!(missing.not_found, "missing program");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn terminate_lets_the_child_clean_up_then_kills() {
        let dir =
            std::env::temp_dir().join(format!("conn-devices-term-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap_or_default();
        let marker = dir.join("cleaned");
        let script = format!(
            "trap 'echo done > {}; exit 0' TERM; echo ready; while :; do sleep 0.05; done",
            marker.display()
        );
        let mut child = Run::new("sh", ["-c", script.as_str()])
            .command()
            .stdout(Stdio::piped())
            .spawn()
            .unwrap_or_else(|e| panic!("{e}"));
        let mut stdout = child.stdout.take().unwrap_or_else(|| panic!("stdout"));
        let mut ready = [0u8; 6];
        let _ = stdout.read_exact(&mut ready).await;
        terminate(&mut child, Duration::from_secs(5)).await;
        assert!(marker.exists(), "the TERM handler ran");
        // A child that ignores TERM is killed after the grace period.
        let mut stubborn = Run::new(
            "sh",
            [
                "-c",
                "trap '' TERM; echo ready; while :; do sleep 0.05; done",
            ],
        )
        .command()
        .stdout(Stdio::piped())
        .spawn()
        .unwrap_or_else(|e| panic!("{e}"));
        let mut out = stubborn.stdout.take().unwrap_or_else(|| panic!("stdout"));
        let _ = out.read_exact(&mut ready).await;
        terminate(&mut stubborn, Duration::from_millis(200)).await;
        assert!(
            stubborn.try_wait().ok().flatten().is_some(),
            "killed after the grace period"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn kills_at_the_deadline() {
        let out = Run::new("sleep", ["5"])
            .timeout(Duration::from_millis(50))
            .output()
            .await;
        assert!(out.timed_out, "timed out");
    }
}
