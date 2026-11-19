//! What an agent gets from `device_open` (`AgentDeviceTarget.ts`, `AgentDeviceShim.ts` and the
//! device toolkit): a session name, a config file that points agent-device at the host's
//! daemon, and a launcher with those flags built in.

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use serde_json::{Value, json};

use crate::{
    generated::{LAUNCHER_SCRIPT, LAUNCHER_SOURCE},
    host::AgentEndpoint,
    http,
    model::Device,
    process::Run,
};

fn key(value: &str) -> String {
    let mut hex = conn_support::hex::hex(&conn_support::hmac::sha256(value.as_bytes()));
    hex.truncate(24);
    hex
}

/// `agentDeviceSession`.
pub(crate) fn session_name(thread_id: &str, host_id: &str, device_id: &str) -> String {
    format!(
        "t3-{}",
        key(&json!([thread_id, host_id, device_id]).to_string())
    )
}

/// `agentDeviceConfigPath`: one file per host.
pub(crate) fn config_path(state_dir: &Path, host_id: &str) -> PathBuf {
    state_dir
        .join("device")
        .join("hosts")
        .join(format!("{}.json", key(host_id)))
}

/// `writeAgentDeviceConfig`. Blocking.
pub(crate) fn write_config(file: &Path, endpoint: &AgentEndpoint) -> std::io::Result<()> {
    let content = json!({
        "daemonBaseUrl": endpoint.base_url,
        "daemonAuthToken": endpoint.token,
    })
    .to_string();
    if std::fs::read_to_string(file).is_ok_and(|current| current == content) {
        return Ok(());
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    conn_support::fs::write_atomic(file, content.as_bytes(), 0o600)
}

/// `agentDeviceTargetArgs`.
pub(crate) fn target_args(device: &Device, agent_device_id: &str) -> Vec<String> {
    if device.platform == "ios" {
        vec![
            "--platform".into(),
            "ios".into(),
            "--udid".into(),
            agent_device_id.into(),
        ]
    } else {
        vec![
            "--platform".into(),
            "android".into(),
            "--serial".into(),
            agent_device_id.into(),
        ]
    }
}

fn shell_single(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

/// Writes a launcher into `dir` and returns the executable agents run. Blocking.
fn write_launcher(
    dir: &Path,
    node: &str,
    entry: &str,
    bound: &[String],
) -> std::io::Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::create_dir_all(dir)?;
    let launcher = dir.join("agent-device-launcher.mjs");
    let source = LAUNCHER_SOURCE
        .replacen("\"/@@NODE@@\"", &Value::from(node).to_string(), 1)
        .replacen("\"/@@ENTRY@@\"", &Value::from(entry).to_string(), 1)
        .replacen("[\"@@BOUND@@\"]", &json!(bound).to_string(), 1);
    std::fs::write(&launcher, source)?;
    let script = LAUNCHER_SCRIPT
        .replace("'/@@NODE@@'", &shell_single(node))
        .replacen(
            "'/@@LAUNCHER@@'",
            &shell_single(&launcher.display().to_string()),
            1,
        );
    let path = dir.join("agent-device");
    std::fs::write(&path, script)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    Ok(path)
}

/// `ensureAgentDeviceShim` and `bindAgentDeviceLauncher`. Blocking.
pub(crate) fn bind_launcher(
    state_dir: &Path,
    node: &str,
    entry: &str,
    session: &str,
    target_args: &[String],
) -> std::io::Result<String> {
    write_launcher(&state_dir.join("device").join("bin"), node, entry, &[])?;
    let path = write_launcher(
        &state_dir.join("device").join("targets").join(session),
        node,
        entry,
        target_args,
    )?;
    Ok(path.display().to_string())
}

/// `pruneAgentDeviceLaunchers`. Blocking.
pub(crate) fn prune_launchers(state_dir: &Path, live: &[String]) {
    let dir = state_dir.join("device").join("targets");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !live.contains(&name) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// How long a launcher's `close` may take (`release`, 15 s in T3).
pub(crate) const RELEASE_TIMEOUT: Duration = Duration::from_secs(15);

/// Ends the agent-device session behind a launcher (`release`); best effort, within `timeout`.
pub(crate) async fn release_launcher(node: &str, launcher: &str, timeout: Duration) {
    let script = Path::new(launcher)
        .parent()
        .map(|dir| dir.join("agent-device-launcher.mjs"))
        .unwrap_or_default();
    let _ = Run::new(node, [script.display().to_string(), "close".into()])
        .env("ELECTRON_RUN_AS_NODE", "1")
        .timeout(timeout)
        .output()
        .await;
}

/// `releaseAgentDeviceSession`: closes a session on a running daemon; one already gone counts.
pub(crate) async fn release_session(endpoint: &AgentEndpoint, session: &str) -> Result<(), String> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": session,
        "method": "agent_device.command",
        "params": { "command": "close", "session": session, "positionals": [], "flags": {} },
    });
    let auth = format!("Bearer {}", endpoint.token);
    let answer = http::fetch(
        "POST",
        &format!("{}/rpc", endpoint.base_url),
        &[("authorization", &auth)],
        Some(&body),
        Duration::from_secs(15),
        http::MAX_JSON_BYTES,
    )
    .await?;
    if answer.status != 404 && !(200..300).contains(&answer.status) {
        return Err(format!("HTTP {}", answer.status));
    }
    let value: Value = serde_json::from_slice(&answer.body).map_err(|e| e.to_string())?;
    if value.pointer("/result/ok") == Some(&Value::Bool(true))
        || value.pointer("/error/data/code").and_then(Value::as_str) == Some("SESSION_NOT_FOUND")
    {
        Ok(())
    } else {
        Err("unexpected close answer".into())
    }
}

fn shell_word(value: &str) -> String {
    let safe = !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_./:-".contains(c));
    if safe {
        value.to_owned()
    } else {
        shell_single(value)
    }
}

/// `agentDeviceQuickStart` for a bound launcher on a machine host (no target flags).
pub(crate) fn quick_start(device: &Device, command: &str) -> String {
    let executable = shell_word(command);
    let run = |args: &str| format!("{executable} {args}");
    let note = if device.platform == "ios" {
        "First use builds an XCTest runner and can take a couple of minutes; later commands are fast."
    } else {
        "The Android snapshot helper installs itself on first use."
    };
    let density = if device.platform == "ios" {
        "iOS saves 1x points; add --pixel-density <n> (3 on most iPhones) for device resolution, "
    } else {
        ""
    };
    [
        format!("The user is watching {} ({}) in the Device panel.", device.name, device.version),
        format!("Drive it with {executable}. It is bound to this device and session, so it needs no --platform, --udid, --serial, --config or --session flags. Use this exact path; login shells may reset PATH."),
        "Every app launch, deep link, tap, text entry, alert, setting, screenshot and recording on this device goes through it. Run open <bundle-or-package-id> (apps lists them) before snapshots, CLI screenshots or input; it starts the session they need. Use device_screenshot just to look.".into(),
        format!("  {}  # restarts the app; Expo dev clients connect to their Metro, --metro-port <port> picks it", run("open <bundle-or-package-id> --relaunch")),
        format!("  {}", run("open <bundle-or-package-id> <deep-link-url>")),
        format!("  {}  # accessibility tree with @eN refs", run("snapshot -i")),
        format!("  {}", run("press @e3 --settle")),
        format!("  {}", run("fill @e5 \"text\" --settle")),
        format!("  {}", run("alert accept")),
        format!("  {}  # also text-size, permission grant <name>", run("settings appearance dark")),
        format!("  {}  # {density}or call device_screenshot to look", run("screenshot /tmp/shot.png")),
        format!("  {}  # then record stop", run("record start --scope device /tmp/run.mp4")),
        format!("  {}", run("install <app> <path-to-.app-or-.apk>")),
        format!("Prefer snapshot refs over coordinates. Run {executable} help <command> for flags and {executable} help workflow for guides."),
        "Do not use simctl, idb, adb or ssh for those actions. They stay fine for builds, installs, code sync, Metro, port forwards, logs, test runners and what this command cannot do; come back to it for every UI action and screenshot so the user can watch.".into(),
        "Each device_open returns its own command; opening another device does not retarget this one.".into(),
        "The command is removed when the device closes or T3 Code restarts. If it is missing, call device_open again.".into(),
        note.into(),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn testdata() -> Value {
        serde_json::from_str(include_str!("../testdata/quickstart.json")).unwrap_or(Value::Null)
    }

    #[test]
    fn quick_start_matches_t3() {
        let data = testdata();
        let cases = data["quickStarts"].as_array().cloned().unwrap_or_default();
        assert!(!cases.is_empty(), "cases");
        for case in cases {
            let device: Device =
                serde_json::from_value(case["device"].clone()).unwrap_or_else(|e| panic!("{e}"));
            assert_eq!(
                quick_start(&device, case["command"].as_str().unwrap_or_default()),
                case["text"].as_str().unwrap_or_default(),
                "quick start for {}",
                device.name
            );
        }
    }

    #[test]
    fn session_names_match_t3() {
        let data = testdata();
        for case in data["sessions"].as_array().cloned().unwrap_or_default() {
            let s = |k: &str| case[k].as_str().unwrap_or_default().to_owned();
            assert_eq!(
                session_name(&s("threadId"), &s("hostId"), &s("deviceId")),
                s("session"),
                "session name"
            );
        }
    }

    #[test]
    fn writes_a_bound_launcher() {
        let dir =
            std::env::temp_dir().join(format!("conn-devices-launcher-{}", conn_support::uuid_v4()));
        let path = bind_launcher(
            &dir,
            "/usr/bin/node",
            "/tools/agent-device.mjs",
            "t3-x",
            &["--udid".into(), "u 1".into()],
        )
        .unwrap_or_default();
        let script = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(
            script.contains("exec '/usr/bin/node' '"),
            "wrapper: {script}"
        );
        let source =
            std::fs::read_to_string(dir.join("device/targets/t3-x/agent-device-launcher.mjs"))
                .unwrap_or_default();
        assert!(
            source.contains(r#"const bound = ["--udid","u 1"];"#),
            "bound flags"
        );
        assert!(!source.contains("@@"), "no placeholders");
        prune_launchers(&dir, &[]);
        assert!(!dir.join("device/targets/t3-x").exists(), "pruned");
        let _ = std::fs::remove_dir_all(dir);
    }
}
