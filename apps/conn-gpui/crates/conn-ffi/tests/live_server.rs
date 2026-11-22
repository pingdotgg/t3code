//! Live end-to-end test against a disposable `conn-server`.
//!
//! Gated on `CONN_SERVER_BIN` (spawns an isolated `conn-server` in a temp directory) or
//! `CONN_FFI_PAIRING_URL` (connects to an already-running disposable `conn-server` such as one
//! started via `scripts/dev-server.sh start`). Never touches `~/.t3`.

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, mpsc as std_mpsc};
use std::time::{Duration, Instant};

use conn_client::{Connection, Credential, ServerConfig};
use conn_ffi::{
    ConnCore, CoreListener, FfiConnectionStatus, FfiCredential, FfiSendMode, FfiShellSnapshot,
    FfiThreadSnapshot,
};
use serde_json::json;

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[derive(Default)]
struct LiveState {
    bearer: Option<String>,
    connected: bool,
    failed: Option<String>,
    latest_shell: Option<FfiShellSnapshot>,
    latest_thread: Option<FfiThreadSnapshot>,
}

#[derive(Default)]
struct LiveListener {
    inner: Mutex<LiveState>,
    notify: Condvar,
}

impl LiveListener {
    fn wait_for<F>(&self, timeout: Duration, mut pred: F) -> Result<(), String>
    where
        F: FnMut(&LiveState) -> bool,
    {
        let deadline = Instant::now() + timeout;
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "live listener lock poisoned".to_owned())?;
        while !pred(&guard) {
            if let Some(reason) = &guard.failed {
                return Err(format!("connection failed: {reason}"));
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Err("timed out waiting for expected live event".to_owned());
            };
            let (next, res) = self
                .notify
                .wait_timeout(guard, remaining)
                .map_err(|_| "live listener condvar poisoned".to_owned())?;
            guard = next;
            if res.timed_out() && !pred(&guard) {
                if let Some(reason) = &guard.failed {
                    return Err(format!("connection failed: {reason}"));
                }
                return Err("timed out waiting for expected live event".to_owned());
            }
        }
        Ok(())
    }
}

impl CoreListener for LiveListener {
    fn on_status(&self, status: FfiConnectionStatus) {
        if let Ok(mut guard) = self.inner.lock() {
            match status {
                FfiConnectionStatus::Connected => guard.connected = true,
                FfiConnectionStatus::Failed { message } => guard.failed = Some(message),
                FfiConnectionStatus::Connecting | FfiConnectionStatus::Reconnecting { .. } => {}
            }
            self.notify.notify_all();
        }
    }

    fn on_bearer_issued(&self, token: String) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.bearer = Some(token);
            self.notify.notify_all();
        }
    }

    fn on_shell(&self, snapshot: FfiShellSnapshot) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.latest_shell = Some(snapshot);
            self.notify.notify_all();
        }
    }

    fn on_thread(&self, snapshot: FfiThreadSnapshot) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.latest_thread = Some(snapshot);
            self.notify.notify_all();
        }
    }

    fn on_error(&self, _message: String) {}
}

fn parse_pairing_url(raw: &str) -> Result<(String, String), Box<dyn std::error::Error>> {
    let parsed = url::Url::parse(raw.trim())?;
    let code = parsed
        .fragment()
        .and_then(|frag| frag.strip_prefix("token="))
        .ok_or("pairingUrl missing #token= fragment")?
        .to_owned();
    let base_url = parsed.origin().ascii_serialization();
    Ok((base_url, code))
}

fn init_temp_git_repo(dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let run_git = |args: &[&str]| -> Result<(), Box<dyn std::error::Error>> {
        let status = Command::new("git")
            .args([
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
            ])
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "conn-ffi-test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "conn-ffi-test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if !status.success() {
            return Err(format!("git {args:?} exited with {status}").into());
        }
        Ok(())
    };

    run_git(&["init", "-q", "-b", "main"])?;
    std::fs::write(dir.join("README.md"), "hello conn-ffi\n")?;
    run_git(&["add", "."])?;
    run_git(&["commit", "-qm", "initial commit"])?;
    Ok(())
}

fn spawn_disposable_server(
    server_bin: &str,
) -> Result<(tempfile::TempDir, tempfile::TempDir, ChildGuard, String), Box<dyn std::error::Error>>
{
    let state_dir = tempfile::tempdir()?;
    let project_dir = tempfile::tempdir()?;
    init_temp_git_repo(project_dir.path())?;
    let project_canonical = std::fs::canonicalize(project_dir.path())?;

    let mut child = Command::new(server_bin)
        .arg("--listen")
        .arg("127.0.0.1:0")
        .arg("--state-dir")
        .arg(state_dir.path())
        .arg("--project")
        .arg(&project_canonical)
        .env("CONN_MODEL_MANIFEST_URL", "off")
        .env("CONN_SERVER_INERT", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let stdout = child
        .stdout
        .take()
        .ok_or("failed to capture conn-server stdout")?;
    let guard = ChildGuard(child);

    let (url_tx, url_rx) = std_mpsc::channel::<String>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(rest) = line.split("pairingUrl:").nth(1) {
                let candidate = rest.split_whitespace().next().unwrap_or("");
                if !candidate.is_empty() {
                    let _ = url_tx.send(candidate.to_owned());
                    break;
                }
            }
        }
    });

    let pairing_url = url_rx
        .recv_timeout(Duration::from_secs(20))
        .map_err(|err| format!("timed out waiting for pairingUrl from conn-server: {err}"))?;
    Ok((state_dir, project_dir, guard, pairing_url))
}

fn seed_thread_on_fresh_server(
    server_url: &str,
    bearer: &str,
    project_id: &str,
    core: &ConnCore,
) -> Result<String, Box<dyn std::error::Error>> {
    let thread_id = conn_client::commands::new_thread_id();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let config = ServerConfig {
        http_base_url: url::Url::parse(server_url)?,
        credential: Credential::Bearer(bearer.to_owned()),
    };
    let (conn, _events) = Connection::start(config, rt.handle());
    let create_cmd = json!({
        "type": "thread.create",
        "commandId": format!("ffi-live-create-{thread_id}"),
        "threadId": thread_id,
        "projectId": project_id,
        "title": "Live FFI test thread",
        "modelSelection": { "instanceId": "claudeAgent", "model": "haiku" },
        "runtimeMode": "full-access",
        "interactionMode": "default",
        "createdBy": "user",
        "creationSource": "web",
    });
    rt.block_on(async {
        conn.call_json("orchestration.dispatchCommand", create_cmd)
            .await
    })?;
    conn.close();

    // Dispatch one user message via ConnCore::send_message so the thread has a non-empty timeline.
    futures::executor::block_on(core.send_message(
        thread_id.clone(),
        "Hello from conn-ffi live test".to_owned(),
        FfiSendMode::Auto,
    ))?;
    Ok(thread_id)
}

#[test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test uses assert! for diffs while propagating setup errors with ?"
)]
fn connects_with_pairing_code_receives_shell_and_opens_thread()
-> Result<(), Box<dyn std::error::Error>> {
    let (_state_dir, _proj_dir, _child, pairing_url) =
        if let Ok(url) = std::env::var("CONN_FFI_PAIRING_URL") {
            (None, None, None, url)
        } else if let Ok(server_bin) = std::env::var("CONN_SERVER_BIN") {
            let (state_dir, proj_dir, child, url) = spawn_disposable_server(&server_bin)?;
            (Some(state_dir), Some(proj_dir), Some(child), url)
        } else {
            return Ok(());
        };

    let (server_url, code) = parse_pairing_url(&pairing_url)?;
    let listener = Arc::new(LiveListener::default());
    let core = ConnCore::connect(
        server_url.clone(),
        FfiCredential::PairingCode { code },
        listener.clone(),
    )?;

    listener.wait_for(Duration::from_secs(20), |s| {
        s.connected
            && s.bearer.as_deref().is_some_and(|t| !t.is_empty())
            && s.latest_shell
                .as_ref()
                .is_some_and(|sh| sh.synchronized && !sh.projects.is_empty())
    })?;

    let (existing_thread_id, project_id, bearer) = {
        let guard = listener
            .inner
            .lock()
            .map_err(|_| "live listener lock poisoned")?;
        let shell = guard
            .latest_shell
            .as_ref()
            .ok_or("missing shell snapshot after wait")?;
        let existing = shell
            .threads
            .iter()
            .find(|t| !t.settled)
            .or_else(|| shell.threads.first())
            .map(|t| t.id.clone());
        let project_id = shell
            .projects
            .first()
            .ok_or("shell snapshot had no projects")?
            .id
            .clone();
        let bearer = guard
            .bearer
            .clone()
            .ok_or("bearer token missing after pairing")?;
        (existing, project_id, bearer)
    };

    let target_thread_id = match existing_thread_id {
        Some(id) => id,
        None => {
            let created_id = seed_thread_on_fresh_server(&server_url, &bearer, &project_id, &core)?;
            listener.wait_for(Duration::from_secs(20), |s| {
                s.latest_shell
                    .as_ref()
                    .is_some_and(|sh| sh.threads.iter().any(|t| t.id == created_id))
            })?;
            created_id
        }
    };

    core.open_thread(target_thread_id.clone());

    listener.wait_for(Duration::from_secs(20), |s| {
        s.latest_thread
            .as_ref()
            .is_some_and(|th| th.thread_id == target_thread_id && !th.entries.is_empty())
    })?;

    {
        let guard = listener
            .inner
            .lock()
            .map_err(|_| "live listener lock poisoned")?;
        let thread = guard
            .latest_thread
            .as_ref()
            .ok_or("missing thread snapshot after open_thread")?;
        assert_eq!(thread.thread_id, target_thread_id);
        assert!(
            !thread.entries.is_empty(),
            "opened thread must yield non-empty timeline entries"
        );
    }

    core.close_thread(target_thread_id);

    // Launch a new thread via ConnCore::launch_thread and stop it via ConnCore::stop_thread.
    let launched_id = futures::executor::block_on(
        core.launch_thread(project_id, "Hello from conn-ffi launch_thread".to_owned()),
    )?;
    assert!(
        !launched_id.is_empty(),
        "launch_thread must return a non-empty thread id"
    );
    listener.wait_for(Duration::from_secs(20), |s| {
        s.latest_thread
            .as_ref()
            .is_some_and(|th| th.thread_id == launched_id && !th.entries.is_empty())
    })?;
    futures::executor::block_on(core.stop_thread(launched_id.clone()))?;
    core.close_thread(launched_id);

    core.disconnect();
    Ok(())
}
