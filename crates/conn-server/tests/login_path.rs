//! The server reads the login shell's `PATH` before it detects Codex.
//!
//! The binary starts with a stand-in login shell (`$SHELL`) whose `PATH` holds a stub `codex`,
//! and an inherited `PATH` without one. Codex must be among the providers the server names at
//! start. No real `codex` runs: the stub is the only one on either `PATH`, and the inherited
//! `PATH` is `/usr/bin:/bin`.
#![cfg(unix)]

use std::{
    io::{BufRead, BufReader},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};

struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn executable(path: &Path, text: &str) {
    std::fs::write(path, text).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn codex_found_only_on_the_login_shell_path_is_a_provider() {
    let dir = TempDir(std::env::temp_dir().join(format!(
        "conn-login-path-{}-{}",
        std::process::id(),
        conn_support::time::now_ms()
    )));
    let bin = dir.0.join("login-bin");
    std::fs::create_dir_all(&bin).unwrap();
    // A stub that answers any call and does nothing.
    executable(
        &bin.join("codex"),
        "#!/bin/sh\necho 'codex-cli 0.0.0'\nexit 0\n",
    );
    // `<shell> -ilc <capture>`: the profile sets PATH, then the capture runs.
    let shell = dir.0.join("login-shell");
    executable(
        &shell,
        &format!(
            "#!/bin/sh\nPATH='{}:/usr/bin:/bin'; export PATH\nexec /bin/sh -c \"$2\"\n",
            bin.display()
        ),
    );
    let mut child = Command::new(env!("CARGO_BIN_EXE_conn-server"))
        .args([
            "serve",
            "--listen",
            "127.0.0.1:0",
            "--no-browser",
            "--state-dir",
        ])
        .arg(dir.0.join("state"))
        .arg(&dir.0)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("SHELL", &shell)
        .env("HOME", &dir.0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(names) = line.strip_prefix("providers: ") {
                let _ = tx.send(names.to_owned());
                return;
            }
        }
    });
    let names = rx.recv_timeout(Duration::from_secs(60));
    // Stop the server by its own handle before any assertion.
    let _ = child.kill();
    let _ = child.wait();
    let names = names.expect("the server named its providers");
    assert!(
        names.split(", ").any(|n| n == "codex"),
        "codex is not a provider: {names}"
    );
}
