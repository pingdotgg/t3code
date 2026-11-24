//! Starting a shell on a PTY, and the one task that owns it.
//!
//! The PTY master is non-blocking and registered with tokio's reactor, so a terminal costs
//! one task and two file descriptors, not a thread. The shell is a session leader with the
//! PTY as its controlling terminal: when the master closes (also when this server dies, even
//! by SIGKILL), the kernel sends SIGHUP to the shell, and the shell passes it to its jobs.

use std::{
    collections::BTreeMap,
    ffi::OsString,
    io,
    os::{fd::OwnedFd, unix::process::ExitStatusExt},
    path::Path,
    time::Duration,
};

use rustix::{
    event::{PollFd, PollFlags},
    process::{Pid, Signal},
};
use tokio::{io::AsyncReadExt, process::Child, sync::oneshot};

/// Variables a terminal must not inherit from the server (as `createTerminalSpawnEnv`).
const DROPPED_ENV: &[&str] = &[
    "PORT",
    "ELECTRON_RENDERER_PORT",
    "ELECTRON_RUN_AS_NODE",
    "TMUX",
    "TMUX_PANE",
    "STY",
    "WINDOW",
    "ZELLIJ",
    "ZELLIJ_SESSION_NAME",
    "ZELLIJ_PANE_ID",
];
const DROPPED_ENV_PREFIXES: &[&str] = &["T3CODE_", "VITE_", "CONN_SERVER_"];

/// One read from the PTY. Larger output arrives as several events.
pub(crate) const READ_BYTES: usize = 8 * 1024;

pub(crate) struct Spawned {
    pub reader: pty_process::OwnedReadPty,
    pub writer: pty_process::OwnedWritePty,
    /// A duplicate of the master for ioctls (resize, foreground group).
    pub control: OwnedFd,
    pub child: Child,
    pub pid: i32,
    /// The shell executable that started (`session.shell` in T3's manager).
    pub shell: String,
}

/// The environment a shell gets: the server's, minus server-only variables, plus terminal
/// settings, plus the client's `env` (with `~` and `$HOME` expanded).
pub(crate) fn shell_env(
    runtime: &BTreeMap<String, String>,
    version: &str,
) -> Vec<(OsString, OsString)> {
    let mut env: BTreeMap<OsString, OsString> = std::env::vars_os()
        .filter(|(key, _)| {
            let key = key.to_string_lossy();
            let upper = key.to_ascii_uppercase();
            !DROPPED_ENV.contains(&key.as_ref())
                && !DROPPED_ENV_PREFIXES.iter().any(|p| upper.starts_with(p))
        })
        .collect();
    // The login shell's PATH, as T3's `process.env` carries it (`conn_support::login_env`).
    for (key, value) in conn_support::login_env::vars() {
        env.insert(key.into(), value);
    }
    let had_colorterm = env.contains_key(&OsString::from("COLORTERM"));
    env.insert("TERM".into(), "xterm-256color".into());
    env.insert("TERM_PROGRAM".into(), "t3code".into());
    env.insert("TERM_PROGRAM_VERSION".into(), version.into());
    let home = std::env::var("HOME").unwrap_or_default();
    for (key, value) in runtime {
        env.insert(key.into(), expand_home(value, &home).into());
    }
    if !had_colorterm && !runtime.contains_key("COLORTERM") {
        env.insert("COLORTERM".into(), "truecolor".into());
    }
    // fish asks the terminal questions at start; replayed history would answer them again.
    let fish = env
        .get(&OsString::from("fish_features"))
        .map(|v| v.to_string_lossy().into_owned());
    match fish {
        Some(v) if v.contains("query-term") => {}
        Some(v) if !v.is_empty() => {
            env.insert("fish_features".into(), format!("{v},no-query-term").into());
        }
        _ => {
            env.insert("fish_features".into(), "no-query-term".into());
        }
    }
    env.into_iter().collect()
}

fn expand_home(value: &str, home: &str) -> String {
    if home.is_empty() {
        return value.to_owned();
    }
    let value = if value == "~" {
        home.to_owned()
    } else if let Some(rest) = value.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else {
        value.to_owned()
    };
    value.replace("${HOME}", home).replace("$HOME", home)
}

/// Shells to try, in order: `$SHELL`, then the usual ones.
pub fn shell_candidates() -> Vec<String> {
    let mut shells: Vec<String> = Vec::new();
    if let Ok(shell) = std::env::var("SHELL") {
        let shell = shell
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_matches(['"', '\''])
            .to_owned();
        if !shell.is_empty() {
            shells.push(shell);
        }
    }
    for shell in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if !shells.iter().any(|s| s == shell) {
            shells.push(shell.into());
        }
    }
    shells
}

fn shell_args(shell: &str) -> &'static [&'static str] {
    match Path::new(shell).file_name().and_then(|n| n.to_str()) {
        Some("zsh") => &["-o", "nopromptsp"],
        Some("bash") if cfg!(target_os = "macos") => &["-l"],
        _ => &[],
    }
}

/// Starts the first shell of `shells` that exists.
pub(crate) fn spawn(
    shells: &[String],
    cwd: &str,
    env: &[(OsString, OsString)],
    cols: u16,
    rows: u16,
) -> io::Result<Spawned> {
    let mut last = io::Error::new(io::ErrorKind::NotFound, "no shell to start");
    for shell in shells {
        match spawn_one(shell, cwd, env, cols, rows) {
            Ok(spawned) => return Ok(spawned),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                last = io::Error::new(error.kind(), format!("{shell}: {error}"));
            }
            Err(error) => return Err(io::Error::new(error.kind(), format!("{shell}: {error}"))),
        }
    }
    Err(io::Error::new(
        last.kind(),
        format!(
            "Failed to start a shell (tried {}): {last}",
            shells.join(", ")
        ),
    ))
}

/// Lets every later child start with the default action of a signal this process inherited
/// as ignored. node-pty resets every signal to its default in the shell; `std` resets only
/// `SIGPIPE`. A child inherits an ignored signal across `exec`, so a server started with
/// `SIGINT` ignored (a background job of a shell without job control) gave shells whose
/// commands ignore Ctrl-C, and `nohup` gave shells that ignore `terminal.close`'s SIGHUP.
/// `exec` resets a handled signal to its default, so this process handles each such signal
/// instead, and drops it, as ignoring did. Linux only: it reads `SigIgn` from `/proc`.
#[cfg(target_os = "linux")]
fn stop_passing_on_ignored_signals() {
    use tokio::signal::unix::{SignalKind, signal};
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let ignored = std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|status| {
                let mask = status.lines().find_map(|l| l.strip_prefix("SigIgn:"))?;
                u64::from_str_radix(mask.trim(), 16).ok()
            })
            .unwrap_or(0);
        let kinds = [
            SignalKind::hangup(),
            SignalKind::interrupt(),
            SignalKind::quit(),
            SignalKind::terminate(),
            SignalKind::user_defined1(),
            SignalKind::user_defined2(),
            SignalKind::from_raw(Signal::TSTP.as_raw()),
        ];
        for kind in kinds {
            let bit = u32::try_from(kind.as_raw_value() - 1)
                .ok()
                .and_then(|n| 1u64.checked_shl(n));
            if bit.is_some_and(|bit| ignored & bit != 0) {
                // The handler stays installed after the stream is dropped.
                let _ = signal(kind);
            }
        }
    });
}

fn spawn_one(
    shell: &str,
    cwd: &str,
    env: &[(OsString, OsString)],
    cols: u16,
    rows: u16,
) -> io::Result<Spawned> {
    #[cfg(target_os = "linux")]
    stop_passing_on_ignored_signals();
    let (pty, pts) = pty_process::open().map_err(to_io)?;
    pty.resize(pty_process::Size::new(rows, cols))
        .map_err(to_io)?;
    // Close-on-exec, or every later shell would inherit this master and keep it open.
    let control = rustix::io::fcntl_dupfd_cloexec(&pty, 0)?;
    let child = pty_process::Command::new(shell)
        .args(shell_args(shell))
        .current_dir(cwd)
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .spawn(pts)
        .map_err(to_io)?;
    let pid = child
        .id()
        .and_then(|p| i32::try_from(p).ok())
        .ok_or_else(|| io::Error::other("the shell has no pid"))?;
    let (reader, writer) = pty.into_split();
    Ok(Spawned {
        reader,
        writer,
        control,
        child,
        pid,
        shell: shell.to_owned(),
    })
}

fn to_io(error: pty_process::Error) -> io::Error {
    match error {
        pty_process::Error::Io(e) => e,
        pty_process::Error::Rustix(e) => e.into(),
        other => io::Error::other(other.to_string()),
    }
}

pub(crate) fn resize(control: &OwnedFd, cols: u16, rows: u16) -> io::Result<()> {
    let size = rustix::termios::Winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    Ok(rustix::termios::tcsetwinsize(control, size)?)
}

/// The PTY's foreground process group, `None` when it cannot be read.
pub(crate) fn foreground_group(control: &OwnedFd) -> Option<i32> {
    Some(
        rustix::termios::tcgetpgrp(control)
            .ok()?
            .as_raw_nonzero()
            .get(),
    )
}

/// The PTY's foreground process group, when it is not the shell's own: a command runs.
pub(crate) fn foreground_job(control: &OwnedFd, shell_pid: i32) -> Option<i32> {
    foreground_group(control).filter(|group| *group != shell_pid)
}

/// Whether the shell itself holds the PTY's foreground. An unreadable group counts as not:
/// an idle close must never guess.
pub(crate) fn shell_in_foreground(control: &OwnedFd, shell_pid: i32) -> bool {
    foreground_group(control) == Some(shell_pid)
}

/// Whether the PTY holds output the reader has not taken yet. `poll` on the master checks the
/// queue the reader drains on Linux and macOS; `FIONREAD` reads the other queue on macOS. A
/// failed poll counts as pending.
pub(crate) fn output_pending(control: &OwnedFd) -> bool {
    let mut fds = [PollFd::new(control, PollFlags::IN)];
    let now = rustix::event::Timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    rustix::event::poll(&mut fds, Some(&now))
        .map_or(true, |_| fds[0].revents().contains(PollFlags::IN))
}

/// What a finished shell reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Exit {
    pub code: Option<i64>,
    pub signal: Option<i64>,
}

/// What the PTY task reports to its owner.
pub(crate) enum Report {
    Output(Vec<u8>),
    Exited(Exit),
}

/// How long the shell has to leave after SIGHUP before it gets SIGKILL.
pub(crate) struct KillPolicy {
    pub grace: Duration,
}

/// Reads output until the shell has exited and the PTY is drained, or until `kill` fires or
/// its sender is dropped (then the shell gets `default_grace`). `report` runs synchronously
/// for each read and for the exit; it decides nothing.
pub(crate) async fn run(
    mut reader: pty_process::OwnedReadPty,
    mut child: Child,
    control: std::sync::Arc<OwnedFd>,
    pid: i32,
    mut kill: oneshot::Receiver<KillPolicy>,
    default_grace: Duration,
    mut report: impl FnMut(Report),
) {
    let mut buf = vec![0u8; READ_BYTES];
    let mut exit: Option<Exit> = None;
    loop {
        tokio::select! {
            read = reader.read(&mut buf) => match read {
                Ok(n) if n > 0 => report(Report::Output(buf[..n].to_vec())),
                // EOF or EIO: every holder of the PTY's other end is gone.
                _ => break,
            },
            status = child.wait(), if exit.is_none() => {
                exit = Some(status.map_or(Exit { code: None, signal: None }, |s| Exit {
                    code: s.code().map(i64::from),
                    signal: s.signal().map(i64::from),
                }));
                // A background job may keep the PTY open forever: read what is there, then stop.
                drain(&mut reader, &mut buf, &mut report).await;
                break;
            }
            policy = &mut kill => {
                let grace = policy.map_or(default_grace, |p| p.grace);
                let groups = groups(&control, pid);
                // Close our end first: a shell exiting with unread output would block on it.
                drop(reader);
                drop(control);
                stop(&mut child, &groups, grace).await;
                return;
            }
        }
    }
    let exit = match exit {
        Some(exit) => exit,
        None => match reap(&mut child).await {
            Ok(s) => Exit {
                code: s.code().map(i64::from),
                signal: s.signal().map(i64::from),
            },
            Err(_) => Exit {
                code: None,
                signal: None,
            },
        },
    };
    report(Report::Exited(exit));
}

async fn drain(
    reader: &mut pty_process::OwnedReadPty,
    buf: &mut [u8],
    report: &mut impl FnMut(Report),
) {
    let quiet = Duration::from_millis(50);
    while let Ok(Ok(n)) = tokio::time::timeout(quiet, reader.read(buf)).await {
        if n == 0 {
            break;
        }
        report(Report::Output(buf[..n].to_vec()));
    }
}

/// The shell's process group and the running command's, if one runs.
fn groups(control: &OwnedFd, pid: i32) -> Vec<Pid> {
    [Some(pid), foreground_job(control, pid)]
        .into_iter()
        .flatten()
        .filter_map(Pid::from_raw)
        .collect()
}

/// SIGHUP to `groups` (what closing a terminal window sends; shells pass it on to their
/// background jobs), then SIGKILL if the shell is still there after `grace`. The first group
/// is the shell's.
async fn stop(child: &mut Child, groups: &[Pid], grace: Duration) {
    for group in groups {
        let _ = rustix::process::kill_process_group(*group, Signal::HUP);
    }
    let exited = !grace.is_zero() && tokio::time::timeout(grace, reap(child)).await.is_ok();
    for (i, group) in groups.iter().enumerate() {
        // After a clean exit only the command's group may remain.
        if !exited || i > 0 {
            let _ = rustix::process::kill_process_group(*group, Signal::KILL);
        }
    }
    if !exited {
        let _ = reap(child).await;
    }
}

/// Waits for the shell to end. Also polls, because tokio's SIGCHLD wake-up can be missed
/// when several runtimes come and go in one process (as in tests).
async fn reap(child: &mut Child) -> io::Result<std::process::ExitStatus> {
    let mut delay = Duration::from_millis(5);
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        tokio::select! {
            status = child.wait() => return status,
            () = tokio::time::sleep(delay) => delay = (delay * 2).min(Duration::from_millis(200)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_shell_environment() {
        let runtime = BTreeMap::from([
            ("CONN_TEST".to_owned(), "~/x:$HOME/y".to_owned()),
            ("COLORTERM".to_owned(), String::new()),
        ]);
        let env: BTreeMap<_, _> = shell_env(&runtime, "1.2.3")
            .into_iter()
            .map(|(k, v)| (k.into_string().unwrap(), v.into_string().unwrap()))
            .collect();
        let home = std::env::var("HOME").unwrap();
        assert_eq!(env["CONN_TEST"], format!("{home}/x:{home}/y"));
        assert_eq!(env["COLORTERM"], "");
        assert_eq!(env["TERM"], "xterm-256color");
        assert_eq!(env["TERM_PROGRAM_VERSION"], "1.2.3");
        assert!(env["fish_features"].contains("no-query-term"));
        assert!(!env.keys().any(|k| k.starts_with("T3CODE_") || k == "TMUX"));
    }

    #[test]
    fn lists_shell_candidates_once() {
        let shells = shell_candidates();
        assert!(shells.contains(&"/bin/sh".to_owned()));
        let mut unique = shells.clone();
        unique.dedup();
        assert_eq!(unique.len(), shells.len());
    }
}
