//! Supervises exactly one SergeCode server child process: spawn, bootstrap
//! delivery over stdin, readiness polling, crash-restart with exponential
//! backoff, and shutdown.
//!
//! Port of `apps/mac/Sources/SidecarKit/ServerProcess.swift`. The Swift
//! version is an `actor` whose re-entrant `start()`/`stop()` race is closed by
//! an `operationGeneration` counter; Rust gets the same guarantee structurally
//! instead — one task owns the child and the state, and callers reach it only
//! through an mpsc command channel, so two commands can never interleave
//! inside a teardown.
//!
//! Behavioural parity with macOS, all pinned by tests below:
//!   * readiness = `GET /.well-known/t3/environment`, polled every 100ms for
//!     up to 60s
//!   * backoff = 500ms, 1s, 2s, 4s, 8s, capped at 10s from attempt 5 onward
//!   * `restart_attempt` resets to 0 once a run reaches `Ready`
//!   * a readiness timeout terminates the (still running, port-holding) child
//!     before restarting, so the next launch cannot fail to bind
//!   * stdout/stderr rotate one generation per run

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::io::AsyncWriteExt as _;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, watch};

use super::bootstrap::BootstrapEnvelope;
use super::config::SidecarConfig;
use super::job::ProcessJob;
use super::node::no_window;

const READINESS_TIMEOUT: Duration = Duration::from_secs(60);
const READINESS_POLL_INTERVAL: Duration = Duration::from_millis(100);
const TERMINATE_GRACE: Duration = Duration::from_secs(2);
const INITIAL_RESTART_DELAY_MS: u64 = 500;
const MAX_RESTART_DELAY_MS: u64 = 10_000;

/// Lifecycle states published on the supervisor's watch channel.
/// `restart_attempt` (0-based) is the number of restarts already attempted for
/// the current desired-running episode; it resets to 0 once a run reaches
/// `Ready`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SidecarState {
    Idle,
    #[serde(rename_all = "camelCase")]
    Launching {
        restart_attempt: u32,
    },
    #[serde(rename_all = "camelCase")]
    Ready {
        pid: u32,
    },
    #[serde(rename_all = "camelCase")]
    Crashed {
        reason: String,
        restart_attempt: u32,
    },
    Stopped,
}

enum SupervisorCommand {
    Start,
    Stop(oneshot::Sender<()>),
}

/// Handle to the supervisor task. Cloning shares the same child.
#[derive(Clone)]
pub struct ServerProcess {
    commands: mpsc::Sender<SupervisorCommand>,
    state: watch::Receiver<SidecarState>,
}

impl ServerProcess {
    /// Spawns the supervisor task. The child is not launched until `start()`.
    pub fn spawn(config: SidecarConfig, bootstrap_token: String, job: Arc<ProcessJob>) -> Self {
        let (commands_tx, commands_rx) = mpsc::channel(8);
        let (state_tx, state_rx) = watch::channel(SidecarState::Idle);

        tokio::spawn(async move {
            Supervisor {
                config,
                token: bootstrap_token,
                job,
                state: state_tx,
                commands: commands_rx,
                desired_running: false,
                restart_attempt: 0,
                http: reqwest::Client::builder()
                    .timeout(Duration::from_secs(1))
                    // The sidecar is loopback-only; a proxy configured for the
                    // user's browser must never intercept the readiness probe.
                    .no_proxy()
                    .build()
                    .unwrap_or_default(),
            }
            .run()
            .await;
        });

        Self {
            commands: commands_tx,
            state: state_rx,
        }
    }

    /// Idempotent: starting an already-running sidecar is a no-op.
    pub async fn start(&self) {
        let _ = self.commands.send(SupervisorCommand::Start).await;
    }

    /// Graceful shutdown, then force-kill of the whole tree. Resolves once the
    /// child is gone so app teardown can await it.
    pub async fn stop(&self) {
        let (ack_tx, ack_rx) = oneshot::channel();
        if self
            .commands
            .send(SupervisorCommand::Stop(ack_tx))
            .await
            .is_ok()
        {
            let _ = ack_rx.await;
        }
    }

    pub fn snapshot(&self) -> SidecarState {
        self.state.borrow().clone()
    }

    /// A fresh subscription always immediately observes the current state,
    /// then every subsequent transition.
    pub fn states(&self) -> watch::Receiver<SidecarState> {
        self.state.clone()
    }
}

struct Supervisor {
    config: SidecarConfig,
    token: String,
    job: Arc<ProcessJob>,
    state: watch::Sender<SidecarState>,
    commands: mpsc::Receiver<SupervisorCommand>,
    desired_running: bool,
    restart_attempt: u32,
    http: reqwest::Client,
}

impl Supervisor {
    async fn run(mut self) {
        loop {
            if !self.desired_running {
                match self.commands.recv().await {
                    // Every handle dropped: nothing can start us again.
                    None => return,
                    Some(SupervisorCommand::Start) => {
                        self.desired_running = true;
                        self.restart_attempt = 0;
                    }
                    Some(SupervisorCommand::Stop(ack)) => {
                        self.emit(SidecarState::Stopped);
                        let _ = ack.send(());
                    }
                }
                continue;
            }
            self.run_episode().await;
        }
    }

    /// One launch → ready/crash → restart-decision cycle.
    async fn run_episode(&mut self) {
        self.emit(SidecarState::Launching {
            restart_attempt: self.restart_attempt,
        });

        let mut child = match self.launch().await {
            Ok(child) => child,
            Err(reason) => {
                self.emit(SidecarState::Crashed {
                    reason,
                    restart_attempt: self.restart_attempt,
                });
                self.backoff().await;
                return;
            }
        };
        let pid = child.id().unwrap_or_default();

        let readiness = poll_readiness(self.http.clone(), self.config.readiness_url());
        tokio::pin!(readiness);
        let mut readiness_settled = false;

        loop {
            tokio::select! {
                // `Child::wait`, `Sleep` and `Receiver::recv` are all
                // cancel-safe, so losing a select branch never drops work.
                exit = child.wait() => {
                    let reason = describe_exit(exit);
                    if !self.desired_running {
                        self.emit(SidecarState::Stopped);
                        return;
                    }
                    self.emit(SidecarState::Crashed {
                        reason,
                        restart_attempt: self.restart_attempt,
                    });
                    self.backoff().await;
                    return;
                }
                outcome = &mut readiness, if !readiness_settled => {
                    readiness_settled = true;
                    match outcome {
                        Ok(()) => {
                            self.restart_attempt = 0;
                            self.emit(SidecarState::Ready { pid });
                        }
                        Err(reason) => {
                            self.emit(SidecarState::Crashed {
                                reason,
                                restart_attempt: self.restart_attempt,
                            });
                            // A readiness timeout does not mean the child
                            // died — it is still running and holding the
                            // port. Kill it before restarting so the next
                            // launch can bind.
                            self.terminate(&mut child).await;
                            self.backoff().await;
                            return;
                        }
                    }
                }
                command = self.commands.recv() => {
                    match command {
                        None => {
                            self.terminate(&mut child).await;
                            return;
                        }
                        // Already running: `start` is idempotent.
                        Some(SupervisorCommand::Start) => {}
                        Some(SupervisorCommand::Stop(ack)) => {
                            self.desired_running = false;
                            self.terminate(&mut child).await;
                            self.emit(SidecarState::Stopped);
                            let _ = ack.send(());
                            return;
                        }
                    }
                }
            }
        }
    }

    async fn launch(&self) -> Result<Child, String> {
        let envelope = BootstrapEnvelope::new(
            self.config.port,
            Some(self.config.base_dir.to_string_lossy().into_owned()),
            self.config.host.clone(),
            self.token.clone(),
            self.config.tailscale_serve_enabled,
            self.config.tailscale_serve_port,
        );
        let bootstrap_line = envelope
            .encode_line()
            .map_err(|error| format!("failed to encode bootstrap envelope: {error}"))?;

        let (stdout, stderr) = open_log_handles(&self.config.log_directory)
            .map_err(|error| format!("failed to open sidecar log files: {error}"))?;

        let mut command = Command::new(&self.config.node_path);
        command
            .arg(&self.config.entry_path)
            .args(["--mode", "desktop"])
            // The server reads exactly one line off this descriptor before
            // anything else; fd 0 is stdin on every platform.
            .args(["--bootstrap-fd", "0"])
            .args(["--port", &self.config.port.to_string()])
            .args(["--host", &self.config.host])
            .arg("--base-dir")
            .arg(&self.config.base_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        no_window(&mut command);

        let mut child = command.spawn().map_err(|error| {
            format!(
                "failed to spawn node at {}: {error}",
                self.config.node_path.display()
            )
        })?;

        // Job membership first, so a crash between spawn and the bootstrap
        // write still cannot orphan the child.
        if let Some(pid) = child.id() {
            if let Err(error) = self.job.assign(pid) {
                // Not fatal: the supervisor's own kill path still applies,
                // only the crash-safety backstop is missing.
                eprintln!("sidecar: could not assign pid {pid} to the job object: {error}");
            }
        }

        if let Some(mut stdin) = child.stdin.take() {
            // The child may already have exited (immediate crash) before we
            // could write; the `wait` branch observes that and restarts.
            let _ = stdin
                .write_all(format!("{bootstrap_line}\n").as_bytes())
                .await;
            let _ = stdin.flush().await;
            // Dropping the handle closes stdin, matching the TS spawner's
            // `endOnDone: true` single-chunk stdin stream.
        }

        Ok(child)
    }

    /// Graceful request, 2s grace, then force-kill the whole tree.
    ///
    /// Windows has no SIGTERM. `taskkill /T` (no `/F`) posts WM_CLOSE and a
    /// console control event, which a windowless Node child usually ignores —
    /// so it is genuinely best-effort here, and `TerminateJobObject` is the
    /// path that always works. Keeping the grace period anyway means a server
    /// build that *does* handle the console event still gets to flush SQLite.
    async fn terminate(&self, child: &mut Child) {
        request_graceful_shutdown(child).await;

        if tokio::time::timeout(TERMINATE_GRACE, child.wait())
            .await
            .is_err()
        {
            // Kills node *and* every provider CLI it spawned.
            self.job.terminate();
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }

    /// Sleeps out the restart backoff while staying responsive to `stop()`.
    async fn backoff(&mut self) {
        if !self.desired_running {
            return;
        }
        let delay = backoff_delay(self.restart_attempt);
        self.restart_attempt = self.restart_attempt.saturating_add(1);

        let sleep = tokio::time::sleep(delay);
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                () = &mut sleep => return,
                command = self.commands.recv() => {
                    match command {
                        None => {
                            self.desired_running = false;
                            return;
                        }
                        Some(SupervisorCommand::Start) => {}
                        Some(SupervisorCommand::Stop(ack)) => {
                            self.desired_running = false;
                            self.emit(SidecarState::Stopped);
                            let _ = ack.send(());
                            return;
                        }
                    }
                }
            }
        }
    }

    fn emit(&self, state: SidecarState) {
        let _ = self.state.send(state);
    }
}

#[cfg(windows)]
async fn request_graceful_shutdown(child: &mut Child) {
    let Some(pid) = child.id() else { return };
    let mut command = Command::new("taskkill");
    command
        .args(["/PID", &pid.to_string(), "/T"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    no_window(&mut command);
    let _ = command.status().await;
}

#[cfg(not(windows))]
async fn request_graceful_shutdown(child: &mut Child) {
    // The non-Windows build exists so the shared supervisor logic stays
    // testable on the development host; SIGTERM is the natural analogue.
    let _ = child.start_kill();
}

fn describe_exit(exit: std::io::Result<std::process::ExitStatus>) -> String {
    match exit {
        Ok(status) => match status.code() {
            Some(code) => format!("exited with code {code}"),
            None => "terminated by signal".to_owned(),
        },
        Err(error) => format!("could not observe the sidecar's exit: {error}"),
    }
}

/// Polls `GET /.well-known/t3/environment` until it answers 2xx or the
/// readiness window closes.
async fn poll_readiness(client: reqwest::Client, url: String) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + READINESS_TIMEOUT;
    loop {
        if let Ok(response) = client.get(&url).send().await {
            if response.status().is_success() {
                return Ok(());
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!("timed out waiting for readiness at {url}"));
        }
        tokio::time::sleep(READINESS_POLL_INTERVAL).await;
    }
}

/// Exponential backoff mirroring the macOS supervisor and the TS reference:
/// 500ms, 1s, 2s, 4s, 8s, capped at 10s from attempt 5 onward.
pub fn backoff_delay(attempt: u32) -> Duration {
    let multiplier = 1u64.checked_shl(attempt).unwrap_or(u64::MAX);
    let millis = INITIAL_RESTART_DELAY_MS
        .checked_mul(multiplier)
        .unwrap_or(MAX_RESTART_DELAY_MS)
        .min(MAX_RESTART_DELAY_MS);
    Duration::from_millis(millis)
}

/// Opens (rotating) stdout/stderr log files under `<baseDir>/logs/sidecar/`.
/// Each new run rotates the previous file to `<name>.log.1` before truncating
/// a fresh one, keeping one prior session's output alongside the current.
fn open_log_handles(directory: &Path) -> std::io::Result<(std::fs::File, std::fs::File)> {
    std::fs::create_dir_all(directory)?;
    let stdout_path = directory.join("stdout.log");
    let stderr_path = directory.join("stderr.log");
    rotate(&stdout_path);
    rotate(&stderr_path);
    Ok((
        std::fs::File::create(&stdout_path)?,
        std::fs::File::create(&stderr_path)?,
    ))
}

fn rotate(path: &Path) {
    if !path.exists() {
        return;
    }
    let rotated = path.with_extension("log.1");
    let _ = std::fs::remove_file(&rotated);
    let _ = std::fs::rename(path, &rotated);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_matches_the_macos_ladder() {
        assert_eq!(backoff_delay(0), Duration::from_millis(500));
        assert_eq!(backoff_delay(1), Duration::from_millis(1_000));
        assert_eq!(backoff_delay(2), Duration::from_millis(2_000));
        assert_eq!(backoff_delay(3), Duration::from_millis(4_000));
        assert_eq!(backoff_delay(4), Duration::from_millis(8_000));
        assert_eq!(backoff_delay(5), Duration::from_millis(10_000));
        assert_eq!(backoff_delay(64), Duration::from_millis(10_000));
        assert_eq!(backoff_delay(u32::MAX), Duration::from_millis(10_000));
    }

    #[test]
    fn states_serialize_to_the_frontend_shape() {
        let launching = serde_json::to_value(SidecarState::Launching { restart_attempt: 2 })
            .expect("serializes");
        assert_eq!(launching["kind"], "launching");
        assert_eq!(launching["restartAttempt"], 2);

        let ready = serde_json::to_value(SidecarState::Ready { pid: 4242 }).expect("serializes");
        assert_eq!(ready["kind"], "ready");
        assert_eq!(ready["pid"], 4242);

        let crashed = serde_json::to_value(SidecarState::Crashed {
            reason: "exited with code 1".to_owned(),
            restart_attempt: 0,
        })
        .expect("serializes");
        assert_eq!(crashed["kind"], "crashed");
        assert_eq!(crashed["reason"], "exited with code 1");

        assert_eq!(
            serde_json::to_value(SidecarState::Idle).expect("serializes")["kind"],
            "idle"
        );
        assert_eq!(
            serde_json::to_value(SidecarState::Stopped).expect("serializes")["kind"],
            "stopped"
        );
    }

    #[test]
    fn exit_descriptions_name_the_code() {
        let status = std::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" })
            .args(if cfg!(windows) {
                ["/C", "exit 3"]
            } else {
                ["-c", "exit 3"]
            })
            .status()
            .expect("runs");
        assert_eq!(describe_exit(Ok(status)), "exited with code 3");
    }

    #[test]
    fn log_handles_rotate_one_generation() {
        let dir =
            std::env::temp_dir().join(format!("sergecode-sidecar-logs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let (mut out, _err) = open_log_handles(&dir).expect("opens");
        std::io::Write::write_all(&mut out, b"first run").expect("writes");
        drop(out);

        let (_out, _err) = open_log_handles(&dir).expect("reopens");
        let rotated = std::fs::read_to_string(dir.join("stdout.log.1")).expect("rotated exists");
        assert_eq!(rotated, "first run");
        assert_eq!(
            std::fs::read_to_string(dir.join("stdout.log")).expect("fresh exists"),
            ""
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
