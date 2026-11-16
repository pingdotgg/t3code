//! Executable fixtures written outside the test process to avoid inherited writable fds.

use std::{
    io,
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

/// Writes and chmods a stub in a child, so concurrent test forks cannot inherit its write fd.
#[cfg(unix)]
pub fn executable(path: &Path, text: &str) -> io::Result<()> {
    let mut child = Command::new("/bin/sh")
        .args(["-c", "cat > \"$1\" && chmod 755 \"$1\"", "stub-writer"])
        .arg(path)
        .env_clear()
        .env("HOME", "")
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::piped())
        .spawn()?;
    let written = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("stub writer has no stdin"))
        .and_then(|mut stdin| stdin.write_all(text.as_bytes()));
    let status = child.wait()?;
    written?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other("stub writer failed"))
    }
}
