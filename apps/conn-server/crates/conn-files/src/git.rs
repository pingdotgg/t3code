//! Short `git` calls that classify files: `ls-files` and `check-ignore`. Blocking; each call
//! gets one helper thread that feeds stdin and kills git at its deadline, so a stuck git ends.

use std::{
    io::{Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub(crate) struct Output {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    /// Stdout went past `max_output` and git was stopped.
    pub truncated: bool,
}

fn command(cwd: &Path, args: &[&str], stdin: bool) -> std::io::Result<Child> {
    Command::new("git")
        .args(["-c", "core.fsmonitor=false", "-c", "core.quotePath=false"])
        .args(args)
        .current_dir(cwd)
        .envs(conn_support::login_env::vars())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(if stdin { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
}

/// Runs git and collects stdout, up to `max_output` bytes.
pub(crate) fn run(
    cwd: &Path,
    args: &[&str],
    stdin: Option<Vec<u8>>,
    max_output: usize,
    timeout: Duration,
) -> Option<Output> {
    let mut stdout = Vec::new();
    let mut truncated = false;
    let code = stream(cwd, args, stdin, timeout, &mut |reader| {
        let mut chunk = [0u8; 16 * 1024];
        loop {
            let n = reader.read(&mut chunk).ok()?;
            if n == 0 {
                return Some(());
            }
            if stdout.len() + n > max_output {
                truncated = true;
                return None;
            }
            stdout.extend_from_slice(&chunk[..n]);
        }
    })?;
    Some(Output {
        code,
        stdout,
        truncated,
    })
}

/// `read` returns `None` to stop early; git is then killed. The outer `None` means git did
/// not start; the inner one that it did not finish on its own.
fn stream(
    cwd: &Path,
    args: &[&str],
    stdin: Option<Vec<u8>>,
    timeout: Duration,
    read: &mut dyn FnMut(&mut dyn Read) -> Option<()>,
) -> Option<Option<i32>> {
    let mut child = command(cwd, args, stdin.is_some()).ok()?;
    let mut out = child.stdout.take()?;
    let input = child.stdin.take();
    let deadline = Instant::now() + timeout;
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let watchdog = thread::spawn(move || {
        if let (Some(mut pipe), Some(bytes)) = (input, stdin) {
            let _ = pipe.write_all(&bytes);
        }
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                return status.code();
            }
            let stopped = stop_rx.try_recv().is_ok();
            if stopped || Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            thread::sleep(Duration::from_millis(5));
        }
    });
    let finished = read(&mut out).is_some();
    if !finished {
        let _ = stop_tx.send(());
    }
    drop(out);
    let code = watchdog.join().ok()?;
    Some(if finished { code } else { None })
}
