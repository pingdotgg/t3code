//! A second line behind the sealed cargo runner (`tools/cargo-runner.mjs`): in a test binary of
//! a debug build, a provider or host CLI may start only from a stub, that is from a file under
//! the temp folder or this workspace. Anything else (`codex` found on this machine's `PATH`, a
//! CLI in `~/.local/bin`) stops the test binary with a message.
//!
//! [`check`] does nothing in a release build, nor outside a test binary (a debug server run by
//! hand starts its CLIs as usual). A test binary is one that cargo put in a `deps` folder.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// Provider, source control host and VCS CLIs (not git). The same list as `HOST_CLIS` in
/// `tools/sealed-env.mjs`; `tools/sealed-run-check.mjs` fails when they differ.
pub const HOST_CLIS: &[&str] = &[
    "claude",
    "codex",
    "grok",
    "gh",
    "glab",
    "fj",
    "tea",
    "az",
    "cafe",
    "origin",
    "cursor-agent",
    "opencode",
    "kiro-cli",
    "jj",
];

/// Stops a test binary that is about to start a provider or host CLI that is not a stub.
/// Call it just before `spawn`. A no-op in a release build and outside a test binary.
#[cfg(debug_assertions)]
pub fn check(command: &std::process::Command) {
    let in_test_binary = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.ends_with("deps")))
        .unwrap_or(false);
    if !in_test_binary {
        return;
    }
    let path = command
        .get_envs()
        .find(|(name, _)| *name == "PATH")
        .map_or_else(
            || std::env::var_os("PATH"),
            |(_, value)| value.map(OsStr::to_os_string),
        );
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let allowed = [std::env::temp_dir(), workspace];
    if let Some(why) = violation(command.get_program(), path.as_deref(), &allowed) {
        // Abort, not panic: a panic in a spawned task or a drop can be swallowed, and the test
        // would pass after a real CLI ran. Written to stderr itself: libtest captures
        // `eprintln!`, and an abort drops what it captured.
        use std::io::Write as _;
        let _ = writeln!(std::io::stderr(), "spawn guard: {why}");
        std::process::abort();
    }
}

/// A no-op in a release build.
#[cfg(not(debug_assertions))]
#[inline(always)]
pub fn check(_command: &std::process::Command) {}

/// Why starting `program` (looked up on `path` when it has no `/`) would run a CLI in
/// [`HOST_CLIS`] from outside `allowed`; `None` when it is no such CLI, a stub under `allowed`,
/// or not found (the spawn then fails).
pub fn violation(program: &OsStr, path: Option<&OsStr>, allowed: &[PathBuf]) -> Option<String> {
    let program_path = Path::new(program);
    let name = program_path.file_name()?.to_str()?;
    if !HOST_CLIS.contains(&name) {
        return None;
    }
    let resolved = if program_path.components().count() > 1 {
        program_path.to_path_buf()
    } else {
        std::env::split_paths(path?)
            .map(|dir| dir.join(name))
            .find(|candidate| candidate.is_file())?
    };
    let real = std::fs::canonicalize(&resolved).ok()?;
    let inside = allowed.iter().any(|root| {
        std::fs::canonicalize(root)
            .map(|root| real.starts_with(root))
            .unwrap_or(false)
    });
    if inside {
        return None;
    }
    Some(format!(
        "a test would start `{}` ({}), a provider or host CLI outside the test's stubs (the temp \
         folder or the workspace). Give the test a stub by path (AGENTS.md, \"Safety\").",
        program.to_string_lossy(),
        resolved.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn executable(dir: &Path, name: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let file = dir.join(name);
        crate::test_util::executable(&file, "#!/bin/sh\nexit 0\n").unwrap();
        file
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_outside_the_stubs_is_refused_and_a_stub_is_not() {
        let base = std::env::temp_dir().join(format!("conn-spawn-guard-{}", std::process::id()));
        let _scratch = Scratch(base.clone());
        let machine = base.join("machine-bin");
        let stubs = base.join("stubs");
        let outside = executable(&machine, "codex");
        let stub = executable(&stubs, "codex");
        executable(&machine, "git");
        let allowed = [stubs.clone()];
        let path = std::env::join_paths([&machine]).unwrap();

        let why = violation(OsStr::new("codex"), Some(&path), &allowed).unwrap();
        assert!(why.contains("`codex`"), "{why}");
        assert!(violation(outside.as_os_str(), None, &allowed).is_some());
        assert_eq!(violation(stub.as_os_str(), None, &allowed), None);
        let stub_first = std::env::join_paths([&stubs, &machine]).unwrap();
        assert_eq!(
            violation(OsStr::new("codex"), Some(&stub_first), &allowed),
            None
        );
        // Not a host CLI, not found, or a path that does not exist: no finding.
        assert_eq!(violation(OsStr::new("git"), Some(&path), &allowed), None);
        assert_eq!(violation(OsStr::new("gh"), Some(&path), &allowed), None);
        assert_eq!(
            violation(OsStr::new("/nonexistent/codex"), None, &allowed),
            None
        );
    }
}
