//! The device tools this machine installs with npm (`DeviceToolchain.ts`): expo-device-hub for
//! the local host, and agent-device for the launchers agents run. Pinned in
//! `deviceToolVersions.json`, installed under `<base>/tools/<name>/<version>`.

use std::{
    cmp::Ordering,
    path::{Path, PathBuf},
    time::Duration,
};

use serde_json::{Value, json};

use crate::{
    generated::{AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION},
    process::Run,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tool {
    Hub,
    Agent,
}

impl Tool {
    pub(crate) fn package(self) -> &'static str {
        match self {
            Tool::Hub => "expo-device-hub",
            Tool::Agent => "agent-device",
        }
    }

    pub(crate) fn version(self) -> &'static str {
        match self {
            Tool::Hub => DEVICE_HUB_VERSION,
            Tool::Agent => AGENT_DEVICE_VERSION,
        }
    }

    fn entry(self) -> &'static [&'static str] {
        match self {
            Tool::Hub => &["dist", "server", "cli.mjs"],
            Tool::Agent => &["bin", "agent-device.mjs"],
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ToolPaths {
    pub(crate) install_dir: PathBuf,
    pub(crate) entry: PathBuf,
    pub(crate) sentinel: PathBuf,
}

pub(crate) fn paths(base: &Path, tool: Tool, version: &str) -> ToolPaths {
    let install_dir = base.join("tools").join(tool.package()).join(version);
    let mut entry = install_dir.join("node_modules").join(tool.package());
    for part in tool.entry() {
        entry = entry.join(part);
    }
    ToolPaths {
        sentinel: install_dir.join(".install-complete"),
        install_dir,
        entry,
    }
}

/// Blocking: reads two files.
pub(crate) fn is_installed(paths: &ToolPaths, version: &str) -> bool {
    paths.entry.exists()
        && std::fs::read_to_string(&paths.sentinel).is_ok_and(|s| s.trim() == version)
}

#[derive(Debug, PartialEq)]
pub(crate) enum InstallError {
    NpmMissing,
    Failed {
        step: String,
        exit_code: Option<i64>,
    },
}

impl InstallError {
    pub(crate) fn message(&self, tool: Tool) -> String {
        match self {
            InstallError::NpmMissing => crate::host::NPM_MISSING.into(),
            InstallError::Failed { step, exit_code } => format!(
                "Installing {} failed while {step}{}.",
                tool.package(),
                exit_code
                    .map(|c| format!(" (exit code {c})"))
                    .unwrap_or_default()
            ),
        }
    }
}

static INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// `ensureTool`: installs the pinned version with npm into a staging folder, then publishes it.
pub(crate) async fn ensure(base: &Path, tool: Tool) -> Result<ToolPaths, InstallError> {
    let _guard = INSTALL_LOCK.lock().await;
    let target = paths(base, tool, tool.version());
    let check = target.clone();
    if blocking(move || is_installed(&check, tool.version())).await {
        return Ok(target);
    }
    let failed = |step: &str| InstallError::Failed {
        step: step.into(),
        exit_code: None,
    };
    let install_dir = target.install_dir.clone();
    let staging = blocking(move || -> std::io::Result<PathBuf> {
        let _ = std::fs::remove_dir_all(&install_dir);
        let parent = install_dir.parent().unwrap_or(&install_dir).to_path_buf();
        std::fs::create_dir_all(&parent)?;
        let staging = parent.join(format!(".staging-{}", conn_support::uuid_v4()));
        std::fs::create_dir(&staging)?;
        Ok(staging)
    })
    .await
    .map_err(|_| failed("preparing the install directory"))?;
    let result = install_into(&staging, &target, tool).await;
    let cleanup = staging.clone();
    blocking(move || {
        let _ = std::fs::remove_dir_all(cleanup);
    })
    .await;
    result.map(|()| target)
}

async fn install_into(staging: &Path, target: &ToolPaths, tool: Tool) -> Result<(), InstallError> {
    let spec = format!("{}@{}", tool.package(), tool.version());
    let staging_text = staging.display().to_string();
    let install_args = vec![
        "install".to_owned(),
        "--prefix".to_owned(),
        staging_text,
        "--no-fund".to_owned(),
        "--no-audit".to_owned(),
        spec,
    ];
    let timeout = Duration::from_secs(600);
    let mut out = Run::new("npm", install_args.clone())
        .timeout(timeout)
        .output()
        .await;
    if out.not_found {
        let mut dlx = vec!["--package=npm@11".to_owned(), "dlx".into(), "npm".into()];
        dlx.extend(install_args);
        out = Run::new("pnpm", dlx).timeout(timeout).output().await;
        if out.not_found {
            return Err(InstallError::NpmMissing);
        }
    }
    if !out.ok() {
        return Err(InstallError::Failed {
            step: "running npm install".into(),
            exit_code: out.code.map(i64::from),
        });
    }
    let mut staged = staging.join("node_modules").join(tool.package());
    for part in tool.entry() {
        staged = staged.join(part);
    }
    let staging = staging.to_path_buf();
    let target = target.clone();
    let version = tool.version();
    blocking(move || {
        if !staged.exists() {
            return Err(InstallError::Failed {
                step: "verifying the installed entry point".into(),
                exit_code: None,
            });
        }
        std::fs::write(staging.join(".install-complete"), format!("{version}\n")).map_err(
            |_| InstallError::Failed {
                step: "recording the completed install".into(),
                exit_code: None,
            },
        )?;
        if std::fs::rename(&staging, &target.install_dir).is_err()
            && !is_installed(&target, version)
        {
            return Err(InstallError::Failed {
                step: "publishing the install".into(),
                exit_code: None,
            });
        }
        Ok(())
    })
    .await
}

/// `deviceToolVersions`: the pinned and installed versions of both tools here.
pub(crate) fn versions(
    base: &Path,
    running_hub: Option<&str>,
    running_agent: Option<&str>,
) -> Value {
    let inspect = |tool: Tool, running: Option<&str>| {
        let dir = base.join("tools").join(tool.package());
        let mut installed: Vec<String> = std::fs::read_dir(&dir)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter_map(|e| e.file_name().into_string().ok())
                    .filter(|v| is_version(v) && is_installed(&paths(base, tool, v), v))
                    .collect()
            })
            .unwrap_or_default();
        installed.sort();
        json!({
            "requiredVersion": tool.version(),
            "installedVersions": installed,
            "runningVersion": running,
        })
    };
    json!({ "hub": inspect(Tool::Hub, running_hub), "agent": inspect(Tool::Agent, running_agent) })
}

/// `^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$`
fn is_version(text: &str) -> bool {
    let (core, pre) = match text.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (text, None),
    };
    let numbers: Vec<&str> = core.split('.').collect();
    numbers.len() == 3
        && numbers
            .iter()
            .all(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        && pre.is_none_or(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        })
}

/// `localeCompare(…, { numeric: true })` for version text: digit runs compare as numbers.
fn natural(a: &str, b: &str) -> Ordering {
    let split = |s: &str| -> Vec<(bool, String)> {
        let mut parts: Vec<(bool, String)> = Vec::new();
        for c in s.chars() {
            let digit = c.is_ascii_digit();
            match parts.last_mut() {
                Some((d, text)) if *d == digit => text.push(c),
                _ => parts.push((digit, c.to_string())),
            }
        }
        parts
    };
    let (pa, pb) = (split(a), split(b));
    for (x, y) in pa.iter().zip(pb.iter()) {
        let order = if x.0 && y.0 {
            let (nx, ny) = (x.1.trim_start_matches('0'), y.1.trim_start_matches('0'));
            nx.len().cmp(&ny.len()).then_with(|| nx.cmp(ny))
        } else {
            x.1.cmp(&y.1)
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    pa.len().cmp(&pb.len())
}

/// `deviceToolInstallMessage`.
pub(crate) fn install_message(name: &str, tool: Option<&Value>) -> String {
    let Some(tool) = tool else {
        return format!("Installing {name}…");
    };
    let required = tool["requiredVersion"].as_str().unwrap_or_default();
    let installed: Vec<&str> = tool["installedVersions"]
        .as_array()
        .map(|list| list.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let previous = tool["runningVersion"]
        .as_str()
        .or_else(|| installed.iter().copied().max_by(|a, b| natural(a, b)));
    match previous {
        Some(previous) if !installed.contains(&required) => {
            format!("Updating {name} from {previous} to {required}…")
        }
        _ => format!("Installing {name} {required}…"),
    }
}

pub(crate) async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    match tokio::task::spawn_blocking(work).await {
        Ok(value) => value,
        // The blocking pool only fails when the runtime shuts down; the server is stopping.
        Err(error) => std::panic::resume_unwind(error.into_panic()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_messages_follow_t3() {
        assert_eq!(
            install_message("device hub", None),
            "Installing device hub…",
            "none"
        );
        let tool = json!({"requiredVersion":"0.22.1","installedVersions":["0.9.0","0.21.0"],"runningVersion":null});
        assert_eq!(
            install_message("device hub", Some(&tool)),
            "Updating device hub from 0.21.0 to 0.22.1…",
            "update"
        );
        let fresh =
            json!({"requiredVersion":"0.22.1","installedVersions":[],"runningVersion":null});
        assert_eq!(
            install_message("agent tools", Some(&fresh)),
            "Installing agent tools 0.22.1…",
            "fresh"
        );
    }

    #[test]
    fn versions_are_checked_like_the_regex() {
        assert!(is_version("0.21.36"), "plain");
        assert!(is_version("1.2.3-beta.1"), "pre");
        assert!(!is_version("1.2"), "short");
        assert!(!is_version("1.2.3-"), "empty pre");
    }
}
