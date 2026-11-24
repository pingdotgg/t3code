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
    io::{AsyncRead, AsyncWriteExt},
    process::{Child, Command},
    sync::{Notify, mpsc, oneshot, watch},
};

use crate::lines::{Line, read_lines, read_lines_keeping_last};

const STDERR_TAIL_BYTES: usize = 4096;
/// The longest stderr line an observer reads whole: Antigravity's sign-in URL may be 16,384
/// characters (T3's `maxAuthorizationUrlLength`) behind its marker. The tail keeps its 4 KiB.
const OBSERVED_STDERR_LINE_BYTES: usize = 16_384 + 1024;
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

/// Sees each stderr line; a line it returns is delivered as stdout.
pub type StderrObserver = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;

pub struct Process {
    pub pid: u32,
    writer: mpsc::Sender<String>,
    kill: Arc<Notify>,
    exited: watch::Receiver<bool>,
    /// Fires when the writer task has closed the child's stdin.
    stdin_closed: oneshot::Receiver<()>,
}

impl std::fmt::Debug for Process {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Process")
            .field("pid", &self.pid)
            .finish_non_exhaustive()
    }
}

impl Process {
    /// Starts the child in its own process group. Events arrive on `events` until
    /// [`ProcEvent::Exited`]. Stdout lines longer than `max_line_bytes` are dropped.
    pub fn spawn(
        spec: &LaunchSpec,
        max_line_bytes: usize,
        events: mpsc::Sender<ProcEvent>,
    ) -> io::Result<Process> {
        Self::spawn_observing_stderr(spec, max_line_bytes, events, None)
    }

    /// [`Process::spawn`] with `on_stderr` shown each stderr line: a line it returns goes to
    /// `events` as if the child had written it to stdout (a CLI that reports on stderr what
    /// the protocol reader must see).
    pub fn spawn_observing_stderr(
        spec: &LaunchSpec,
        max_line_bytes: usize,
        events: mpsc::Sender<ProcEvent>,
        on_stderr: Option<StderrObserver>,
    ) -> io::Result<Process> {
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            // The login shell's PATH (`conn_support::login_env`); the spec's variables win.
            .envs(conn_support::login_env::vars());
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
        conn_support::spawn_guard::check(command.as_std());
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
        let stderr_done = spawn_stderr_tail(
            stderr,
            tail.clone(),
            on_stderr.map(|observe| (observe, events.clone())),
        );

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
    pub async fn shutdown(mut self) {
        // Replacing our sender with a closed one drops it: the writer task ends stdin once no
        // clone from `writer()` is left.
        let (closed, _) = mpsc::channel(1);
        drop(std::mem::replace(&mut self.writer, closed));
        let mut exited = self.exited.clone();
        let wait = exited.wait_for(|done| *done);
        if tokio::time::timeout(CLOSE_GRACE, wait).await.is_err() {
            self.kill.notify_one();
            let _ = exited.wait_for(|done| *done).await;
        }
    }
}

impl Process {
    /// Ends input and waits up to `wait` until the writer task closed stdin (once no clone
    /// from `writer()` is left). T3's ACP runtime ends an agent's stdin as its writer stream
    /// completes, just before the scope's SIGKILL to the group.
    pub async fn end_input(&mut self, wait: Duration) {
        let (closed, _) = mpsc::channel(1);
        drop(std::mem::replace(&mut self.writer, closed));
        let (_, never) = oneshot::channel();
        let stdin_closed = std::mem::replace(&mut self.stdin_closed, never);
        let _ = tokio::time::timeout(wait, stdin_closed).await;
    }

    /// Ends input, then sends SIGTERM to the process group, and SIGKILL after `grace` when
    /// the child still runs. Returns once the child is reaped. This is how the T3 server stops
    /// a CLI (Effect's spawner with `forceKillAfter`).
    pub async fn terminate(mut self, grace: Duration) {
        let pid = self.pid;
        // As in `shutdown`: dropping our sender lets the writer task end stdin. `self` stays
        // whole, because `Process` has a `Drop`.
        let (closed, _) = mpsc::channel(1);
        drop(std::mem::replace(&mut self.writer, closed));
        let (_, never) = oneshot::channel();
        let stdin_closed = std::mem::replace(&mut self.stdin_closed, never);
        // The end of input goes first, as in TS; a writer stuck on a full pipe does not hold
        // the signal back for long.
        let _ = tokio::time::timeout(Duration::from_millis(200), stdin_closed).await;
        #[cfg(unix)]
        signal_group(pid, rustix::process::Signal::TERM);
        #[cfg(not(unix))]
        let _ = pid;
        let mut exited = self.exited.clone();
        let wait = exited.wait_for(|done| *done);
        if tokio::time::timeout(grace, wait).await.is_err() {
            self.kill.notify_one();
            let _ = exited.wait_for(|done| *done).await;
        }
    }
}

/// A `Process` dropped without [`Process::shutdown`] or [`Process::terminate`] kills its
/// child, so no path leaves it running. After either of them the child is already reaped and
/// this does nothing.
impl Drop for Process {
    fn drop(&mut self) {
        if !*self.exited.borrow() {
            self.kill.notify_one();
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

/// Whether a process with this pid still runs. Signal 0 succeeds on a zombie too, and on Linux
/// a killed orphan stays a zombie until its new parent reaps it, so there a `Z` (or `X`) state
/// in `/proc/<pid>/stat` counts as ended.
#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    let signalled = i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
        .is_some_and(|pid| rustix::process::test_kill_process(pid).is_ok());
    signalled && !is_zombie(pid)
}

#[cfg(target_os = "linux")]
fn is_zombie(pid: u32) -> bool {
    // `pid (comm) S ...`: the state follows the last ')', since comm may hold one.
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|stat| {
            let rest = stat.get(stat.rfind(')')? + 1..)?;
            rest.trim_start().chars().next()
        })
        .is_some_and(|state| state == 'Z' || state == 'X')
}

#[cfg(all(unix, not(target_os = "linux")))]
fn is_zombie(_pid: u32) -> bool {
    false
}

/// Waits up to `timeout` for `pid` to end ([`pid_alive`]). For tests and shutdown checks: a
/// killed process can take a moment to be reaped.
#[cfg(unix)]
pub async fn wait_gone(pid: u32, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if !pid_alive(pid) {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Keeps the last [`STDERR_TAIL_BYTES`] of stderr. Lines are framed with a cap (larger for an
/// observer, [`OBSERVED_STDERR_LINE_BYTES`]) and decoded lossily, so a long line or invalid
/// UTF-8 cannot grow memory or end the reader (which would close the pipe and fail the
/// child's next stderr write).
fn spawn_stderr_tail(
    stderr: impl AsyncRead + Unpin + Send + 'static,
    tail: Arc<Mutex<String>>,
    observer: Option<(StderrObserver, mpsc::Sender<ProcEvent>)>,
) -> oneshot::Receiver<()> {
    let (done_tx, done) = oneshot::channel();
    tokio::spawn(async move {
        let line_bytes = if observer.is_some() {
            OBSERVED_STDERR_LINE_BYTES
        } else {
            STDERR_TAIL_BYTES
        };
        read_lines_keeping_last(stderr, line_bytes, |line| {
            let text = match line {
                Line::Text(text) => text,
                Line::Oversized(bytes) => format!("[{bytes}-byte line dropped]"),
            };
            let forward = observer
                .as_ref()
                .and_then(|(observe, events)| Some((observe(&text)?, events.clone())));
            if let Ok(mut tail) = tail.lock() {
                tail.push_str(&text);
                tail.push('\n');
                if tail.len() > STDERR_TAIL_BYTES {
                    let mut cut = tail.len() - STDERR_TAIL_BYTES;
                    while !tail.is_char_boundary(cut) {
                        cut += 1;
                    }
                    tail.drain(..cut);
                }
            }
            async move {
                if let Some((line, events)) = forward {
                    let _ = events.send(ProcEvent::Line(Line::Text(line))).await;
                }
                true
            }
        })
        .await;
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
    async fn invalid_utf8_on_stderr_keeps_the_pipe_open() {
        let (tx, mut rx) = mpsc::channel(8);
        // After the bad byte the child writes again; a closed pipe would fail that write.
        let script = "printf '\\377\\376\\n' >&2; sleep 0.2; echo after >&2 || exit 9; exit 0";
        let _process = Process::spawn(&sh(script), 1024, tx).unwrap();
        let Some(ProcEvent::Exited(info)) = rx.recv().await else {
            panic!("expected exit")
        };
        assert_eq!(info.code, Some(0), "the second stderr write succeeded");
        assert!(info.stderr_tail.contains("after"));
    }

    /// Antigravity's sign-in URL may be 16,384 characters behind its marker: an observer
    /// sees a stderr line that long whole, and the tail still keeps only its last 4 KiB.
    #[tokio::test(flavor = "current_thread")]
    async fn an_observed_stderr_line_may_carry_a_16k_url() {
        let (tx, mut rx) = mpsc::channel(8);
        let script = "printf 'url: %s\\n' \"$(printf '%16384s' x | tr ' ' a)\" >&2";
        let observer: StderrObserver =
            Box::new(|line| line.starts_with("url: ").then(|| line.len().to_string()));
        let _process =
            Process::spawn_observing_stderr(&sh(script), 1024, tx, Some(observer)).unwrap();
        let Some(ProcEvent::Line(Line::Text(len))) = rx.recv().await else {
            panic!("the observed line arrives")
        };
        assert_eq!(len, (5 + 16_384).to_string());
        let Some(ProcEvent::Exited(info)) = rx.recv().await else {
            panic!("expected exit")
        };
        assert!(info.stderr_tail.len() <= STDERR_TAIL_BYTES);
        assert!(info.stderr_tail.ends_with("ax\n"));
    }

    /// A stderr line the observer recognises reaches the reader as stdout, after the stdout
    /// written before it; other stderr lines stay in the tail only.
    #[tokio::test(flavor = "current_thread")]
    async fn an_observed_stderr_line_is_delivered_as_stdout() {
        let (tx, mut rx) = mpsc::channel(8);
        let script = "echo out; sleep 0.1; echo noise >&2; echo 'url: x' >&2; sleep 0.1";
        let observer: StderrObserver =
            Box::new(|line| line.strip_prefix("url: ").map(|u| format!("signal {u}")));
        let _process =
            Process::spawn_observing_stderr(&sh(script), 1024, tx, Some(observer)).unwrap();
        let mut lines = Vec::new();
        while let Some(event) = rx.recv().await {
            match event {
                ProcEvent::Line(Line::Text(text)) => lines.push(text),
                ProcEvent::Line(Line::Oversized(_)) => {}
                ProcEvent::Exited(info) => {
                    assert!(info.stderr_tail.contains("noise"));
                    break;
                }
            }
        }
        assert_eq!(lines, ["out", "signal x"]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_dropped_process_kills_its_child() {
        let (tx, mut rx) = mpsc::channel(8);
        let process = Process::spawn(&sh("sleep 30"), 1024, tx).unwrap();
        let pid = process.pid;
        drop(process);
        let exited = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await;
        assert!(matches!(exited, Ok(Some(ProcEvent::Exited(_)))));
        assert!(wait_gone(pid, Duration::from_secs(5)).await);
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
        let pid: u32 = pid.parse().unwrap();
        assert!(
            wait_gone(pid, Duration::from_secs(5)).await,
            "grandchild {pid} survived the group kill"
        );
    }
}
