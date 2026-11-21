use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc as std_mpsc;
use std::time::Duration;

use conn_client::{ClientEvent, Connection, ConnectionStatus, Credential, ServerConfig};
use conn_contract::OrchestrationV2ShellStreamItem;
use serde_json::json;

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
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
            .env("GIT_AUTHOR_NAME", "conn-client-test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "conn-client-test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if !status.success() {
            return Err(format!("git {:?} exited with {status}", args).into());
        }
        Ok(())
    };

    run_git(&["init", "-q", "-b", "main"])?;
    std::fs::write(dir.join("README.md"), "hello conn-client\n")?;
    run_git(&["add", "."])?;
    run_git(&["commit", "-qm", "initial commit"])?;
    Ok(())
}

#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test uses assert! for diffs while propagating setup errors with ?"
)]
async fn connects_to_live_conn_server_and_receives_shell_snapshot()
-> Result<(), Box<dyn std::error::Error>> {
    let Ok(server_bin) = std::env::var("CONN_SERVER_BIN") else {
        return Ok(());
    };

    let state_dir = tempfile::tempdir()?;
    let project_dir = tempfile::tempdir()?;
    init_temp_git_repo(project_dir.path())?;
    let project_canonical = std::fs::canonicalize(project_dir.path())?;

    let mut child = Command::new(&server_bin)
        .arg("--listen")
        .arg("127.0.0.1:0")
        .arg("--state-dir")
        .arg(state_dir.path())
        .arg("--project")
        .arg(&project_canonical)
        .env("CONN_MODEL_MANIFEST_URL", "off")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let stdout = child
        .stdout
        .take()
        .ok_or("failed to capture conn-server stdout")?;
    let _guard = ChildGuard(child);

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

    let pairing_url_str = url_rx
        .recv_timeout(Duration::from_secs(20))
        .map_err(|err| format!("timed out waiting for pairingUrl from conn-server: {err}"))?;
    let pairing_url = url::Url::parse(&pairing_url_str)?;
    let code = pairing_url
        .fragment()
        .and_then(|frag| frag.strip_prefix("token="))
        .ok_or("pairingUrl missing #token= fragment")?
        .to_owned();
    let http_base_url = url::Url::parse(&pairing_url.origin().ascii_serialization())?;

    let config = ServerConfig {
        http_base_url,
        credential: Credential::PairingCode(code),
    };
    let (conn, mut events) = Connection::start(config, &tokio::runtime::Handle::current());
    conn.subscribe_shell();

    let mut bearer_issued = false;
    let mut connected = false;
    let mut snapshot_has_project = false;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while tokio::time::Instant::now() < deadline && !snapshot_has_project {
        let Some(event) = tokio::time::timeout(Duration::from_secs(5), events.recv()).await? else {
            return Err("event channel closed unexpectedly".into());
        };
        match event {
            ClientEvent::BearerIssued(token) => {
                assert!(
                    !token.is_empty(),
                    "BearerIssued must carry a non-empty access token"
                );
                bearer_issued = true;
            }
            ClientEvent::Status(ConnectionStatus::Connected) => {
                connected = true;
            }
            ClientEvent::Status(ConnectionStatus::Failed(reason)) => {
                return Err(format!("connection failed: {reason}").into());
            }
            ClientEvent::Shell(OrchestrationV2ShellStreamItem::Snapshot(snap)) => {
                let want = project_canonical.to_string_lossy();
                snapshot_has_project = snap
                    .snapshot
                    .projects
                    .iter()
                    .any(|p| p.workspace_root == want.as_ref());
            }
            _ => {}
        }
    }

    assert!(
        bearer_issued,
        "pairing code exchange must emit ClientEvent::BearerIssued"
    );
    assert!(connected, "client must reach ConnectionStatus::Connected");
    assert!(
        snapshot_has_project,
        "subscribeShell snapshot must include the temporary git project"
    );

    let server_config = conn.call_json("server.getConfig", json!({})).await?;
    assert!(
        server_config.is_object(),
        "server.getConfig must return a JSON object, got {server_config}"
    );

    conn.close();
    Ok(())
}
