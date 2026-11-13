//! One `claude` child process: a writer task for stdin, a reader task for stdout, a stderr
//! tail, and a supervisor that owns the child, reaps it, and stops its process group.
//!
//! Bounded everywhere: stdin lines queue in a 64-slot channel, stdout lines are capped at
//! [`MAX_LINE_BYTES`] (longer lines are dropped and reported), decoded messages go to the
//! session over a bounded channel, so a slow consumer slows the CLI instead of growing memory.
//! Nothing blocks the runtime thread. The general shape (spawn, line framing, supervisor) fits a
//! Codex crate too.

use std::{
    io,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{Notify, mpsc, oneshot, watch},
};

use crate::launch::LaunchSpec;
use crate::protocol::Inbound;

/// A line longer than this is dropped. Large tool results (images as base64) stay below it.
pub const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES: usize = 4096;
/// How long a closed stdin may take to end the CLI before it is killed.
pub const CLOSE_GRACE: Duration = Duration::from_secs(3);

#[derive(Debug)]
#[allow(clippy::large_enum_variant)] // Moved once per line; boxing adds an allocation each.
pub enum ProcEvent {
    Message(Inbound),
    /// A stdout line over [`MAX_LINE_BYTES`] was dropped.
    Oversized(usize),
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
}

impl Process {
    /// Starts the CLI. Events arrive on `events` until [`ProcEvent::Exited`].
    pub fn spawn(spec: &LaunchSpec, events: mpsc::Sender<ProcEvent>) -> io::Result<Process> {
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
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");

        let (writer, mut lines) = mpsc::channel::<String>(64);
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
        });

        let tail = Arc::new(Mutex::new(String::new()));
        let stderr_done = spawn_stderr_tail(stderr, tail.clone());

        let (stdout_done_tx, stdout_done) = oneshot::channel();
        let reader_events = events.clone();
        tokio::spawn(async move {
            read_lines(stdout, &reader_events).await;
            let _ = stdout_done_tx.send(());
        });

        let kill = Arc::new(Notify::new());
        let (exited_tx, exited) = watch::channel(false);
        tokio::spawn(supervise(
            child,
            pid,
            kill.clone(),
            stdout_done,
            stderr_done,
            tail,
            events,
            exited_tx,
        ));
        Ok(Process {
            pid,
            writer,
            kill,
            exited,
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

#[allow(clippy::too_many_arguments)]
async fn supervise(
    mut child: Child,
    pid: u32,
    kill: Arc<Notify>,
    stdout_done: oneshot::Receiver<()>,
    stderr_done: oneshot::Receiver<()>,
    tail: Arc<Mutex<String>>,
    events: mpsc::Sender<ProcEvent>,
    exited: watch::Sender<bool>,
) {
    let status = tokio::select! {
        status = child.wait() => status,
        _ = kill.notified() => {
            let _ = child.start_kill();
            child.wait().await
        }
    };
    // Tools the agent started (Bash jobs) share the CLI's process group; stop what is left.
    #[cfg(unix)]
    kill_group(pid).await;
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

/// `kill -KILL -<pgid>` for the group created at spawn (pgid = the pid we captured).
#[cfg(unix)]
async fn kill_group(pgid: u32) {
    if pgid == 0 {
        return;
    }
    let result = Command::new("kill")
        .args(["-KILL", "--", &format!("-{pgid}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
    let _ = result;
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

/// Reads newline-framed JSON, capping each line at [`MAX_LINE_BYTES`].
async fn read_lines(stdout: impl AsyncRead + Unpin, events: &mpsc::Sender<ProcEvent>) {
    let mut reader = BufReader::with_capacity(64 * 1024, stdout);
    let mut line: Vec<u8> = Vec::new();
    let mut dropped = 0usize;
    while let Ok(buf) = reader.fill_buf().await {
        if buf.is_empty() {
            break;
        }
        let (chunk, found_newline) = match buf.iter().position(|b| *b == b'\n') {
            Some(i) => (&buf[..i], true),
            None => (buf, false),
        };
        let consumed = chunk.len() + usize::from(found_newline);
        if dropped > 0 || line.len() + chunk.len() > MAX_LINE_BYTES {
            dropped += chunk.len() + line.len();
            line.clear();
        } else {
            line.extend_from_slice(chunk);
        }
        reader.consume(consumed);
        if !found_newline {
            continue;
        }
        let event = if dropped > 0 {
            Some(ProcEvent::Oversized(std::mem::take(&mut dropped)))
        } else {
            let text = String::from_utf8_lossy(&line);
            let text = text.trim();
            (!text.is_empty()).then(|| ProcEvent::Message(Inbound::decode(text)))
        };
        line.clear();
        // Release the big buffer after a large line instead of keeping it for the session.
        if line.capacity() > 1024 * 1024 {
            line = Vec::new();
        }
        if let Some(event) = event
            && events.send(event).await.is_err()
        {
            return;
        }
    }
}

/// Whether a process with this pid exists (`kill -0`). For tests that check a child ended.
#[cfg(all(test, unix))]
pub fn pid_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn reader_frames_lines_and_drops_oversized_ones() {
        let big = "x".repeat(MAX_LINE_BYTES + 10);
        let input = format!("{{\"type\":\"keep_alive\"}}\n{big}\n\n{{\"type\":\"nope\"}}");
        let (tx, mut rx) = mpsc::channel(8);
        read_lines(input.as_bytes(), &tx).await;
        drop(tx);
        let mut got = Vec::new();
        while let Some(event) = rx.recv().await {
            got.push(event);
        }
        assert!(matches!(got[0], ProcEvent::Message(Inbound::Ignored(_))));
        assert!(matches!(got[1], ProcEvent::Oversized(n) if n > MAX_LINE_BYTES));
        // The last line has no trailing newline: EOF ends it without a message, as the CLI
        // always terminates lines.
        assert_eq!(got.len(), 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_dead_child_reports_its_exit_and_is_reaped() {
        let spec = LaunchSpec {
            program: "sh".into(),
            args: vec![
                "-c".into(),
                r#"echo '{"type":"keep_alive"}'; echo boom >&2; exit 3"#.into(),
            ],
            cwd: None,
            env_remove: vec![],
            env_set: vec![],
        };
        let (tx, mut rx) = mpsc::channel(8);
        let process = Process::spawn(&spec, tx).unwrap();
        assert!(process.pid > 0);
        assert!(matches!(
            rx.recv().await,
            Some(ProcEvent::Message(Inbound::Ignored(_)))
        ));
        let Some(ProcEvent::Exited(info)) = rx.recv().await else {
            panic!("expected exit")
        };
        assert_eq!(info.code, Some(3));
        assert_eq!(info.stderr_tail, "boom\n");
        assert!(process.has_exited());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn shutdown_kills_a_child_that_ignores_end_of_input() {
        let spec = LaunchSpec {
            program: "sh".into(),
            args: vec!["-c".into(), "trap '' TERM; sleep 30".into()],
            cwd: None,
            env_remove: vec![],
            env_set: vec![],
        };
        let (tx, mut rx) = mpsc::channel(8);
        let process = Process::spawn(&spec, tx).unwrap();
        let started = std::time::Instant::now();
        process.shutdown().await;
        assert!(started.elapsed() < CLOSE_GRACE + Duration::from_secs(2));
        let Some(ProcEvent::Exited(info)) = rx.recv().await else {
            panic!("expected exit")
        };
        assert_eq!(info.signal, Some(9));
    }
}
