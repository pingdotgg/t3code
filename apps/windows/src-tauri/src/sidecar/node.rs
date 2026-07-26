//! Locates a usable `node.exe` for spawning the t3 server.
//!
//! Windows counterpart of `apps/mac/Sources/SidecarKit/NodeRuntimeLocator.swift`,
//! with one deliberate simplification: there is no login-shell PATH probe.
//! macOS needs one because a Finder-launched GUI process inherits a minimal
//! `PATH` that omits Homebrew and every version manager. On Windows the user
//! `PATH` comes from the registry and is inherited by GUI processes as-is, so
//! scanning `PATH` directly finds what a terminal would find. PATH repair
//! beyond that stays the server's own job (`os-jank.ts fixPath()`).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

/// Executable file name probed on every candidate directory.
#[cfg(windows)]
pub const NODE_EXECUTABLE: &str = "node.exe";
#[cfg(not(windows))]
pub const NODE_EXECUTABLE: &str = "node";

const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SemanticVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl SemanticVersion {
    /// Parses `node --version` output ("v22.16.0"). Pre-release/build
    /// metadata suffixes are dropped — the engines predicate only ever
    /// compares the numeric triple.
    pub fn parse(raw: &str) -> Option<Self> {
        let text = raw.trim();
        let text = text.strip_prefix('v').unwrap_or(text);
        let text = match text.find(['-', '+']) {
            Some(index) => &text[..index],
            None => text,
        };

        let mut parts = text.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
        Some(Self {
            major,
            minor,
            patch,
        })
    }

    /// Pure predicate mirroring `apps/server/package.json`'s `engines.node`
    /// range: `^22.16 || ^23.11 || >=24.10`.
    pub fn satisfies_engine_range(&self) -> bool {
        match self.major {
            0..=21 => false,
            22 => (self.minor, self.patch) >= (16, 0),
            23 => (self.minor, self.patch) >= (11, 0),
            24 => (self.minor, self.patch) >= (10, 0),
            _ => true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocatedNode {
    pub path: PathBuf,
    pub version: SemanticVersion,
}

#[derive(Debug, thiserror::Error)]
pub enum LocatorError {
    #[error("no node runtime satisfying ^22.16 || ^23.11 || >=24.10 was found")]
    NotFound,
}

/// Candidate paths in priority order, excluding the `SERGECODE_NODE` override
/// and the cached path (which the caller tries first). Pure over its inputs so
/// the ordering is unit-testable on any host.
///
/// `path_var` is the raw `PATH` value; `env` looks up the remaining Windows
/// directory variables. Duplicates are removed while preserving priority.
pub fn candidate_paths<F>(path_var: Option<&str>, env: F) -> Vec<PathBuf>
where
    F: Fn(&str) -> Option<String>,
{
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(path_var) = path_var {
        for entry in std::env::split_paths(path_var) {
            if entry.as_os_str().is_empty() {
                continue;
            }
            candidates.push(entry.join(NODE_EXECUTABLE));
        }
    }

    // Version managers and installers that do not always export onto PATH for
    // GUI processes (nvm-windows rewrites its symlink target, Volta and Scoop
    // shim through their own bin directories).
    let well_known: [(&str, &[&str]); 7] = [
        ("ProgramFiles", &["nodejs"]),
        ("ProgramFiles(x86)", &["nodejs"]),
        ("LOCALAPPDATA", &["Programs", "nodejs"]),
        ("LOCALAPPDATA", &["Volta", "bin"]),
        ("ProgramData", &["chocolatey", "bin"]),
        ("USERPROFILE", &["scoop", "apps", "nodejs", "current"]),
        ("NVM_SYMLINK", &[]),
    ];
    for (variable, segments) in well_known {
        let Some(root) = env(variable) else { continue };
        if root.is_empty() {
            continue;
        }
        let mut candidate = PathBuf::from(root);
        for segment in segments {
            candidate.push(segment);
        }
        candidates.push(candidate.join(NODE_EXECUTABLE));
    }

    let mut seen = Vec::with_capacity(candidates.len());
    candidates.retain(|candidate| {
        if seen.iter().any(|existing| existing == candidate) {
            false
        } else {
            seen.push(candidate.clone());
            true
        }
    });
    candidates
}

/// Runs `<path> --version` and returns the trimmed stdout, or `None` when the
/// binary is missing, fails, or overruns the probe timeout.
async fn probe_version(path: &Path) -> Option<String> {
    let mut command = Command::new(path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    no_window(&mut command);

    let output = tokio::time::timeout(VERSION_PROBE_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

async fn validated_node(path: &Path) -> Option<LocatedNode> {
    if !path.is_file() {
        return None;
    }
    let version = SemanticVersion::parse(&probe_version(path).await?)?;
    version.satisfies_engine_range().then(|| LocatedNode {
        path: path.to_path_buf(),
        version,
    })
}

/// Finds a usable node binary, in priority order:
/// 1. `$SERGECODE_NODE` override
/// 2. previously cached path, if it is still usable
/// 3. `PATH` entries
/// 4. well-known install locations
///
/// Each candidate must exist and report a version satisfying the server's
/// engines range.
pub async fn locate(cached_path: Option<&Path>) -> Result<LocatedNode, LocatorError> {
    if let Some(override_path) = std::env::var_os("SERGECODE_NODE") {
        if !override_path.is_empty() {
            if let Some(located) = validated_node(Path::new(&override_path)).await {
                return Ok(located);
            }
        }
    }

    if let Some(cached_path) = cached_path {
        if let Some(located) = validated_node(cached_path).await {
            return Ok(located);
        }
    }

    let path_var = std::env::var("PATH").ok();
    for candidate in candidate_paths(path_var.as_deref(), |name| std::env::var(name).ok()) {
        if let Some(located) = validated_node(&candidate).await {
            return Ok(located);
        }
    }

    Err(LocatorError::NotFound)
}

/// Suppresses the console window Windows would otherwise flash for a child
/// process spawned from a GUI application. No-op elsewhere.
pub fn no_window(command: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

#[cfg(windows)]
use std::os::windows::process::CommandExt as _;

/// Convenience for callers holding raw `node --version` output.
pub fn version_satisfies(raw: &str) -> bool {
    SemanticVersion::parse(raw).is_some_and(|version| version.satisfies_engine_range())
}

/// True when `name` is the node executable this platform looks for.
pub fn is_node_executable(name: &OsStr) -> bool {
    name.eq_ignore_ascii_case(OsStr::new(NODE_EXECUTABLE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_node_version_output() {
        assert_eq!(
            SemanticVersion::parse("v24.18.0"),
            Some(SemanticVersion {
                major: 24,
                minor: 18,
                patch: 0
            })
        );
        assert_eq!(
            SemanticVersion::parse("  22.16  "),
            Some(SemanticVersion {
                major: 22,
                minor: 16,
                patch: 0
            })
        );
        assert_eq!(
            SemanticVersion::parse("v25.0.0-rc.1"),
            Some(SemanticVersion {
                major: 25,
                minor: 0,
                patch: 0
            })
        );
        assert_eq!(SemanticVersion::parse("not-a-version"), None);
        assert_eq!(SemanticVersion::parse("v24"), None);
    }

    #[test]
    fn engine_range_matches_the_server_manifest() {
        // ^22.16 || ^23.11 || >=24.10
        assert!(!version_satisfies("v21.9.0"));
        assert!(!version_satisfies("v22.15.9"));
        assert!(version_satisfies("v22.16.0"));
        assert!(version_satisfies("v22.20.4"));
        assert!(!version_satisfies("v23.10.0"));
        assert!(version_satisfies("v23.11.0"));
        assert!(!version_satisfies("v24.9.9"));
        assert!(version_satisfies("v24.10.0"));
        assert!(version_satisfies("v25.0.0"));
    }

    // `std::env::split_paths` uses the *host* separator, and a Windows drive
    // letter would split on the macOS/Linux `:`. These cases use
    // separator-neutral directory names so the ordering contract is asserted
    // identically on every development host and on the Windows runner.
    fn join_path_var(entries: &[&str]) -> String {
        std::env::join_paths(entries)
            .expect("joins")
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn path_entries_come_before_well_known_locations() {
        let path_var = join_path_var(&["tools", "other"]);
        let candidates = candidate_paths(Some(&path_var), |name| match name {
            "ProgramFiles" => Some("program-files".to_owned()),
            _ => None,
        });
        assert_eq!(candidates[0], PathBuf::from("tools").join(NODE_EXECUTABLE));
        assert_eq!(candidates[1], PathBuf::from("other").join(NODE_EXECUTABLE));
        assert_eq!(
            candidates[2],
            PathBuf::from("program-files")
                .join("nodejs")
                .join(NODE_EXECUTABLE)
        );
    }

    #[test]
    fn deduplicates_repeated_candidates() {
        let path_var = join_path_var(&["dup", "dup"]);
        let candidates = candidate_paths(Some(&path_var), |_| None);
        assert_eq!(candidates.len(), 1);
    }

    #[test]
    fn a_path_entry_and_a_well_known_root_do_not_duplicate_each_other() {
        let path_var = join_path_var(&["shared"]);
        let candidates = candidate_paths(Some(&path_var), |name| {
            (name == "NVM_SYMLINK").then(|| "shared".to_owned())
        });
        assert_eq!(candidates.len(), 1);
    }

    #[test]
    fn empty_environment_yields_no_candidates() {
        assert!(candidate_paths(None, |_| None).is_empty());
        assert!(candidate_paths(None, |_| Some(String::new())).is_empty());
    }
}
