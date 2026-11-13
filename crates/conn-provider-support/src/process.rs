//! One CLI child process: a writer task for stdin, a reader task for stdout, a stderr tail, and
//! a supervisor that owns the child, reaps it, and stops its process group.
//!
//! Bounded everywhere: stdin lines queue in a 64-slot channel, stdout lines are capped (longer
//! ones are reported and dropped), and lines go to the owner over the bounded channel it passes
//! in, so a slow consumer slows the CLI instead of growing memory.

use std::{
    io,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{Notify, mpsc, oneshot, watch},
};

use crate::lines::{Line, read_lines};

const STDERR_TAIL_BYTES: usize = 4096;
/// How long a closed stdin may take to end the CLI before it is killed.
pub const CLOSE_GRACE: Duration = Duration::from_secs(3);

/// Everything needed to start a child: program, argv, working directory, environment edits.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LaunchSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env_remove: Vec<String>,
    pub env_set: Vec<(String, String)>,
}

#[derive(Debug)]
pub enum ProcEvent {
    Line(Line),
    /// The child exited and stdout is drained. Always the last event.
    Exited(ExitInfo),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub stderr_tail: String,
}

impl ExitInfo {
    pub fn describe(&self) -> String {
        match (self.code, self.signal) {
            (Some(code), _) => format!("exit code {code}"),
            (None, Some(signal)) => format!("signal {signal}"),
            _ => "unknown status".into(),
        }
    }
}

pub struct Process {
    pub pid: u32,
    writer: mpsc::Sender<String>,
    kill: Arc<Notify>,
    exited: watch::Receiver<bool>,
    /// Fires when the writer task has closed the child's stdin.
    stdin_closed: oneshot::Receiver<()>,
}

impl Process {
    /// Starts the child in its own process group. Events arrive on `events` until
    /// [`ProcEvent::Exited`]. Stdout lines longer than `max_line_bytes` are dropped.
    pub fn spawn(
        spec: &LaunchSpec,
        max_line_bytes: usize,
        events: mpsc::Sender<ProcEvent>,
    ) -> io::Result<Process> {
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        if let Some(cwd) = &spec.cwd {
            command.current_dir(cwd);
        }
        for key in &spec.env_remove {
            command.env_remove(key);
        }
        for (key, value) in &spec.env_set {
            command.env(key, value);
        }
        let mut child = command.spawn()?;
        let pid = child.id().unwrap_or(0);
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err(io::Error::other("the child's stdio pipes are missing"));
        };

        let (writer, mut lines) = mpsc::channel::<String>(64);
        let (stdin_closed_tx, stdin_closed) = oneshot::channel();
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(line) = lines.recv().await {
                let write = async {
                    stdin.write_all(line.as_bytes()).await?;
                    stdin.write_all(b"\n").await?;
                    stdin.flush().await
                };
                if write.await.is_err() {
                    break;
                }
            }
            // Dropping stdin is the CLI's end of input.
            drop(stdin);
            let _ = stdin_closed_tx.send(());
        });

        let tail = Arc::new(Mutex::new(String::new()));
        let stderr_done = spawn_stderr_tail(stderr, tail.clone());

        let (stdout_done_tx, stdout_done) = oneshot::channel();
        let reader_events = events.clone();
        tokio::spawn(async move {
            read_lines(stdout, max_line_bytes, |line| {
                let events = reader_events.clone();
                async move { events.send(ProcEvent::Line(line)).await.is_ok() }
            })
            .await;
            let _ = stdout_done_tx.send(());
        });

        let kill = Arc::new(Notify::new());
        let (exited_tx, exited) = watch::channel(false);
        tokio::spawn(supervise(Supervised {
            child,
            pid,
            kill: kill.clone(),
            stdout_done,
            stderr_done,
            tail,
            events,
            exited: exited_tx,
        }));
        Ok(Process {
            pid,
            writer,
            kill,
            exited,
            stdin_closed,
        })
    }

    pub fn writer(&self) -> mpsc::Sender<String> {
        self.writer.clone()
    }

    pub fn has_exited(&self) -> bool {
        *self.exited.borrow()
    }

    /// Kills the child now (SIGKILL). The supervisor reaps it.
    pub fn kill(&self) {
        self.kill.notify_one();
    }

    /// Ends input, waits [`CLOSE_GRACE`], then kills. Returns once the child is reaped.
    pub async fn shutdown(self) {
        let Process {
            writer,
            kill,
            mut exited,
            ..
        } = self;
        drop(writer);
        let wait = exited.wait_for(|done| *done);
        if tokio::time::timeout(CLOSE_GRACE, wait).await.is_err() {
            kill.notify_one();
            let _ = exited.wait_for(|done| *done).await;
        }
    }
}

impl Process {
    /// Ends input, then sends SIGTERM to the process group, and SIGKILL after `grace` when
    /// the child still runs. Returns once the child is reaped. This is how the T3 server stops
    /// a CLI (Effect's spawner with `forceKillAfter`).
    pub async fn terminate(self, grace: Duration) {
        let Process {
            pid,
            writer,
            kill,
            mut exited,
            stdin_closed,
        } = self;
        drop(writer);
        // The end of input goes first, as in TS; a writer stuck on a full pipe does not hold
        // the signal back for long.
        let _ = tokio::time::timeout(Duration::from_millis(200), stdin_closed).await;
        #[cfg(unix)]
        signal_group(pid, rustix::process::Signal::TERM);
        #[cfg(not(unix))]
        let _ = pid;
        let wait = exited.wait_for(|done| *done);
        if tokio::time::timeout(grace, wait).await.is_err() {
            kill.notify_one();
            let _ = exited.wait_for(|done| *done).await;
        }
    }
}

struct Supervised {
    child: Child,
    pid: u32,
    kill: Arc<Notify>,
    stdout_done: oneshot::Receiver<()>,
    stderr_done: oneshot::Receiver<()>,
    tail: Arc<Mutex<String>>,
    events: mpsc::Sender<ProcEvent>,
    exited: watch::Sender<bool>,
}

async fn supervise(s: Supervised) {
    let Supervised {
        mut child,
        pid,
        kill,
        stdout_done,
        stderr_done,
        tail,
        events,
        exited,
    } = s;
    let status = tokio::select! {
        status = child.wait() => status,
        _ = kill.notified() => {
            let _ = child.start_kill();
            child.wait().await
        }
    };
    // Tools the agent started share the CLI's process group; stop what is left.
    #[cfg(unix)]
    kill_group(pid).await;
    #[cfg(not(unix))]
    let _ = pid;
    // A grandchild can hold stdout open; do not wait on it forever.
    let _ = tokio::time::timeout(Duration::from_secs(2), stdout_done).await;
    let _ = tokio::time::timeout(Duration::from_millis(200), stderr_done).await;
    let (code, signal) = match &status {
        Ok(status) => (status.code(), exit_signal(status)),
        Err(_) => (None, None),
    };
    let stderr_tail = tail.lock().map(|t| t.clone()).unwrap_or_default();
    let _ = events
        .send(ProcEvent::Exited(ExitInfo {
            code,
            signal,
            stderr_tail,
        }))
        .await;
    let _ = exited.send(true);
}

#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_: &std::process::ExitStatus) -> Option<i32> {
    None
}

/// SIGKILL to the group created at spawn (pgid = the pid captured at spawn).
#[cfg(unix)]
async fn kill_group(pgid: u32) {
    signal_group(pgid, rustix::process::Signal::KILL);
}

/// Sends `signal` to the process group `pgid`. A group already gone is not an error.
#[cfg(unix)]
pub fn signal_group(pgid: u32, signal: rustix::process::Signal) {
    let Some(pgid) = i32::try_from(pgid)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
    else {
        return;
    };
    let _ = rustix::process::kill_process_group(pgid, signal);
}

/// Whether a process with this pid exists (signal 0). For checking that a child ended.
#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
        .is_some_and(|pid| rustix::process::test_kill_process(pid).is_ok())
}

fn spawn_stderr_tail(
    stderr: impl AsyncRead + Unpin + Send + 'static,
    tail: Arc<Mutex<String>>,
) -> oneshot::Receiver<()> {
    let (done_tx, done) = oneshot::channel();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(mut tail) = tail.lock() {
                tail.push_str(&line);
                tail.push('\n');
                if tail.len() > STDERR_TAIL_BYTES {
                    let mut cut = tail.len() - STDERR_TAIL_BYTES;
                    while !tail.is_char_boundary(cut) {
                        cut += 1;
                    }
                    tail.drain(..cut);
                }
            }
        }
        let _ = done_tx.send(());
    });
    done
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(script: &str) -> LaunchSpec {
        LaunchSpec {
            program: "sh".into(),
            args: vec!["-c".into(), script.into()],
            ..LaunchSpec::default()
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_dead_child_reports_its_exit_and_is_reaped() {
        let (tx, mut rx) = mpsc::channel(8);
        let process = Process::spawn(&sh("echo '{}'; echo boom >&2; exit 3"), 1024, tx).unwrap();
        assert!(process.pid > 0);
        assert!(matches!(rx.recv().await, Some(ProcEvent::Line(Line::Text(t))) if t == "{}"));
        let Some(ProcEvent::Exited(info)) = rx.recv().await else {
            panic!("expected exit")
        };
        assert_eq!(info.code, Some(3));
        assert_eq!(info.stderr_tail, "boom\n");
        assert!(process.has_exited());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn shutdown_kills_a_child_that_ignores_end_of_input() {
        let (tx, mut rx) = mpsc::channel(8);
        let process = Process::spawn(&sh("trap '' TERM; sleep 30"), 1024, tx).unwrap();
        let started = std::time::Instant::now();
        process.shutdown().await;
        assert!(started.elapsed() < CLOSE_GRACE + Duration::from_secs(2));
        let Some(ProcEvent::Exited(info)) = rx.recv().await else {
            panic!("expected exit")
        };
        assert_eq!(info.signal, Some(9));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn terminate_sends_sigterm_then_kills_after_the_grace() {
        let (tx, mut rx) = mpsc::channel(8);
        let process = Process::spawn(
            &sh("trap 'echo term' TERM; while :; do sleep 0.05; done"),
            1024,
            tx,
        )
        .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let started = std::time::Instant::now();
        process.terminate(Duration::from_millis(300)).await;
        let elapsed = started.elapsed();
        assert!(elapsed >= Duration::from_millis(300), "{elapsed:?}");
        assert!(elapsed < Duration::from_secs(2), "{elapsed:?}");
        let mut lines = Vec::new();
        let info = loop {
            match rx.recv().await {
                Some(ProcEvent::Line(Line::Text(t))) => lines.push(t),
                Some(ProcEvent::Exited(info)) => break info,
                other => panic!("unexpected {other:?}"),
            }
        };
        assert_eq!(lines, ["term"]);
        assert_eq!(info.signal, Some(9));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn the_group_kill_reaches_grandchildren() {
        let (tx, mut rx) = mpsc::channel(8);
        // The grandchild writes its pid, then outlives the parent.
        let process = Process::spawn(&sh("sleep 30 & echo $!; exit 0"), 1024, tx).unwrap();
        let Some(ProcEvent::Line(Line::Text(pid))) = rx.recv().await else {
            panic!("expected the grandchild pid")
        };
        while !matches!(rx.recv().await, Some(ProcEvent::Exited(_))) {}
        drop(process);
        let alive = pid.parse().is_ok_and(pid_alive);
        assert!(!alive, "grandchild {pid} survived the group kill");
    }
}
