//! The Codex runtime a managed instance uses, as T3's `CodexInstallation.resolveLocal` finds
//! a local one (`apps/server/src/provider/CodexInstallation.ts`).
//!
//! T3 takes a supported `codex` on `PATH` before it downloads its own. This server never
//! downloads: Orbit's agent bundle puts `codex` on `PATH`, and Orbit's `~/.codex/config.toml`
//! sends its model calls to the AI router with the key Orbit issues (`ORBIT_MODEL_KEY`). So a
//! managed instance here is that runtime, signed in through the router; no ChatGPT tokens.

use std::path::{Path, PathBuf};
use std::time::Duration;

use conn_provider_support::probe::{CommandError, spawn_and_collect};

/// T3's limit for the two checks of a local runtime together.
const CHECK_TIMEOUT: Duration = Duration::from_secs(5);

/// A `codex` that `--version` and `app-server --help` accept.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalRuntime {
    /// The path found on `PATH`, symlinks kept (version managers dispatch by name).
    pub executable_path: PathBuf,
    pub version: String,
}

/// `resolveLocal`: `codex` on the environment's `PATH`, a script or a binary with its
/// `codex-code-mode-host` beside it, whose `--version` is exactly `codex-cli X.Y.Z` and whose
/// `app-server --help` exits 0, within 5 s. Blocking file reads run on a blocking thread.
pub async fn local_runtime(environment: Vec<(String, String)>) -> Option<LocalRuntime> {
    let path_var = environment
        .iter()
        .find(|(name, _)| name == "PATH")
        .map(|(_, value)| value.clone());
    let found = tokio::task::spawn_blocking(move || {
        let found = crate::launch::find_executable(
            Path::new("codex"),
            path_var.as_deref().map(std::ffi::OsStr::new),
        )?;
        has_code_mode_host(&std::fs::canonicalize(&found).ok()?).then_some(found)
    })
    .await
    .ok()??;
    let program = found.to_str()?.to_owned();
    let check = async {
        let output = spawn_and_collect(&program, &["--version"], &environment, None, CHECK_TIMEOUT)
            .await
            .ok()??;
        if output.code != 0 {
            return None;
        }
        let version = cli_version(&output.stdout)?;
        match spawn_and_collect(
            &program,
            &["app-server", "--help"],
            &environment,
            None,
            CHECK_TIMEOUT,
        )
        .await
        {
            Ok(Some(help)) if help.code == 0 => Some(version),
            Ok(_) | Err(CommandError::NotFound | CommandError::Failed(_)) => None,
        }
    };
    let version = tokio::time::timeout(CHECK_TIMEOUT, check).await.ok()??;
    Some(LocalRuntime {
        executable_path: found,
        version,
    })
}

/// `/^codex-cli (\d+\.\d+\.\d+)$/` on the trimmed output.
fn cli_version(stdout: &str) -> Option<String> {
    let version = stdout.trim().strip_prefix("codex-cli ")?;
    let mut parts = version.split('.');
    let numeric = |part: Option<&str>| {
        part.is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    };
    (numeric(parts.next())
        && numeric(parts.next())
        && numeric(parts.next())
        && parts.next().is_none())
    .then(|| version.to_owned())
}

/// `hasCodeModeHost` on Unix: a script (`#!`), or a non-empty executable
/// `codex-code-mode-host` beside the real file.
fn has_code_mode_host(real: &Path) -> bool {
    use std::io::Read;
    let mut header = [0_u8; 2];
    let script = std::fs::File::open(real)
        .and_then(|mut file| file.read_exact(&mut header))
        .is_ok()
        && header == *b"#!";
    if script {
        return true;
    }
    let Some(host) = real.parent().map(|dir| dir.join("codex-code-mode-host")) else {
        return false;
    };
    let Ok(info) = std::fs::metadata(&host) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        info.is_file() && info.len() > 0 && info.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        info.is_file() && info.len() > 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_version_must_be_exactly_codex_cli_and_three_numbers() {
        assert_eq!(
            cli_version("codex-cli 0.166.0\n").as_deref(),
            Some("0.166.0")
        );
        assert_eq!(cli_version("codex-cli 0.160.0-alpha.1"), None);
        assert_eq!(cli_version("codex 0.166.0"), None);
        assert_eq!(cli_version("codex-cli 0.166"), None);
        assert_eq!(cli_version("codex-cli 0.166.0 extra"), None);
    }

    #[test]
    fn a_binary_needs_its_code_mode_host_and_a_script_does_not() {
        let dir = std::env::temp_dir().join(format!("conn-codex-install-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let script = dir.join("script");
        std::fs::write(&script, "#!/bin/sh\n").expect("write");
        assert!(has_code_mode_host(&script));
        let binary = dir.join("codex");
        std::fs::write(&binary, [0x7f, b'E', b'L', b'F']).expect("write");
        assert!(!has_code_mode_host(&binary));
        let host = dir.join("codex-code-mode-host");
        std::fs::write(&host, "x").expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&host, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        assert!(has_code_mode_host(&binary));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
