//! The probe for `tools/sealed-run-check.mjs`: reports the environment a test binary sees.
//!
//! It does nothing unless `$TMPDIR/conn-sealed-probe.request` exists. The check writes that
//! file (one line: a marker token), runs this test through plain `cargo test`, and reads
//! `$TMPDIR/conn-sealed-probe.txt`. The report holds paths and variable names, never a value
//! of another variable.

use std::fmt::Write as _;

#[test]
fn sealed_environment_report() {
    let tmp = std::env::temp_dir();
    let Ok(request) = std::fs::read_to_string(tmp.join("conn-sealed-probe.request")) else {
        return;
    };
    let token = request.trim();
    let mut out = String::new();
    for name in [
        "HOME",
        "PATH",
        "SHELL",
        "GIT_CONFIG_GLOBAL",
        "CONN_UNSEALED",
    ] {
        let value = std::env::var(name).unwrap_or_default();
        let value = if !token.is_empty() && value.contains(token) {
            "<holds the marker>".to_owned()
        } else {
            value
        };
        writeln!(out, "{name}={value}").unwrap();
    }
    for (name, value) in std::env::vars_os() {
        let name = name.to_string_lossy();
        writeln!(out, "name={name}").unwrap();
        if !token.is_empty() && value.to_string_lossy().contains(token) {
            writeln!(out, "marker={name}").unwrap();
        }
    }
    // The planted case of 2026-11-15: a test that starts `codex` from PATH.
    let codex = match std::process::Command::new("codex")
        .arg("--version")
        .output()
    {
        Ok(output) => format!("ran (exit {:?})", output.status.code()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => "not found".to_owned(),
        Err(error) => format!("error {error}"),
    };
    writeln!(out, "codex={codex}").unwrap();
    std::fs::write(tmp.join("conn-sealed-probe.txt"), out).unwrap();
}
