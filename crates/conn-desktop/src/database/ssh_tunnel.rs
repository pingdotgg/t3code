//! An SSH tunnel for the Database panel (Conn's `sshTunnel.ts`).
//!
//! It runs the system `ssh`, so `~/.ssh/config` aliases and `known_hosts` apply. It
//! authenticates with the given agent socket, or the user's own agent when none is given. Conn
//! stores no SSH key. The tunnel lives as long as the database connection that uses it.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt as _;
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;
use tokio::time::Instant;

/// The system `ssh`.
pub const SSH_BINARY: &str = "/usr/bin/ssh";

const READY_TIMEOUT: Duration = Duration::from_secs(20);
const STDERR_KEEP: usize = 2_000;

/// Where the tunnel goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshTunnelTarget {
    /// An `~/.ssh/config` alias or address.
    pub host: String,
    pub port: Option<u16>,
    pub user: Option<String>,
    /// An SSH agent socket. `None` uses the user's own agent and keys.
    pub agent: Option<String>,
    /// The database as the SSH server reaches it.
    pub remote_host: String,
    pub remote_port: u16,
}

/// Why the tunnel did not open. The messages are Conn's.
#[derive(Debug, thiserror::Error)]
pub enum SshTunnelError {
    /// A value would reach `ssh` as an option or split into two arguments.
    #[error("The SSH {label} of this connection is not valid.")]
    InvalidValue { label: &'static str },
    #[error("No free local port for the SSH tunnel.")]
    NoFreePort(#[source] std::io::Error),
    #[error("SSH could not start: {0}")]
    Spawn(#[source] std::io::Error),
    /// `ssh` exited before the forward accepted connections.
    #[error("{0}")]
    Failed(String),
    #[error("SSH to {host} did not open the tunnel within 20 seconds.")]
    Timeout { host: String },
}

/// An open tunnel. Dropping it stops `ssh`.
#[derive(Debug)]
pub struct SshTunnel {
    local_port: u16,
    child: Child,
}

impl SshTunnel {
    /// The local port that forwards to the database.
    pub fn local_port(&self) -> u16 {
        self.local_port
    }

    /// Stops `ssh`.
    pub fn close(&mut self) {
        // The process may have exited already; there is nothing to do then.
        let _ = self.child.start_kill();
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.close();
    }
}

/// Values that reach `ssh` as arguments: never option-like, never with whitespace.
fn assert_word(value: &str, label: &'static str) -> Result<(), SshTunnelError> {
    if value.is_empty()
        || value.starts_with('-')
        || value.chars().any(|c| c.is_whitespace() || c == '\0')
    {
        return Err(SshTunnelError::InvalidValue { label });
    }
    Ok(())
}

/// The `ssh` arguments for one forward.
pub fn ssh_tunnel_arguments(
    target: &SshTunnelTarget,
    local_port: u16,
) -> Result<Vec<String>, SshTunnelError> {
    assert_word(&target.host, "host")?;
    if let Some(user) = &target.user {
        assert_word(user, "user")?;
    }
    assert_word(&target.remote_host, "database host")?;
    let remote_host = if target.remote_host.contains(':') {
        format!("[{}]", target.remote_host)
    } else {
        target.remote_host.clone()
    };
    let mut args: Vec<String> = vec![
        "-N".into(),
        "-T".into(),
        "-L".into(),
        format!(
            "127.0.0.1:{local_port}:{remote_host}:{}",
            target.remote_port
        ),
    ];
    if target.agent.is_some() {
        // A socket path may have spaces (`Group Containers`), which `-o` would split; the path
        // goes through the environment instead.
        args.extend(["-o".into(), "IdentityAgent=SSH_AUTH_SOCK".into()]);
    }
    for option in [
        "BatchMode=yes",
        "ExitOnForwardFailure=yes",
        // A server seen for the first time is remembered, as TablePlus does; a changed key still fails.
        "StrictHostKeyChecking=accept-new",
        "ServerAliveInterval=30",
    ] {
        args.extend(["-o".into(), option.into()]);
    }
    if let Some(port) = target.port {
        args.extend(["-p".into(), port.to_string()]);
    }
    if let Some(user) = &target.user {
        args.extend(["-l".into(), user.clone()]);
    }
    args.extend(["--".into(), target.host.clone()]);
    Ok(args)
}

async fn free_port() -> Result<u16, SshTunnelError> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(SshTunnelError::NoFreePort)?;
    let port = listener
        .local_addr()
        .map_err(SshTunnelError::NoFreePort)?
        .port();
    Ok(port)
}

async fn accepts(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).await.is_ok()
}

/// Reads `ssh`'s stderr to the end and keeps its last characters.
fn collect_stderr(child: &mut Child) -> Option<JoinHandle<String>> {
    let mut stderr = child.stderr.take()?;
    Some(tokio::spawn(async move {
        let mut kept = String::new();
        let mut buffer = [0u8; 1024];
        while let Ok(read) = stderr.read(&mut buffer).await {
            if read == 0 {
                break;
            }
            kept.push_str(&String::from_utf8_lossy(&buffer[..read]));
            if kept.len() > STDERR_KEEP {
                let mut cut = kept.len() - STDERR_KEEP;
                while !kept.is_char_boundary(cut) {
                    cut += 1;
                }
                kept.drain(..cut);
            }
        }
        kept
    }))
}

fn failure_message(target: &SshTunnelTarget, stderr: &str, exited: &str) -> String {
    let reason = stderr.trim().lines().rev().find(|line| !line.is_empty());
    let lower = stderr.to_lowercase();
    let key_problem = ["permission denied", "publickey", "agent"]
        .iter()
        .any(|needle| lower.contains(needle));
    let mut message = format!("SSH to {} failed", target.host);
    match reason {
        Some(reason) => message.push_str(&format!(": {reason}")),
        None => message.push_str(&format!(" ({exited})")),
    }
    if key_problem {
        // Conn writes `..` after a reason that ends in a period; one is enough.
        if !message.ends_with('.') {
            message.push('.');
        }
        message.push_str(if target.agent.is_some() {
            " Check that Vault is unlocked and holds the server's key."
        } else {
            " Check that your SSH agent holds the server's key."
        });
    }
    message
}

/// Opens the tunnel with `ssh_binary` (normally [`SSH_BINARY`]) and returns once its local port
/// accepts connections.
pub async fn open_ssh_tunnel(
    target: &SshTunnelTarget,
    ssh_binary: &Path,
) -> Result<SshTunnel, SshTunnelError> {
    let local_port = free_port().await?;
    let mut command = Command::new(ssh_binary);
    command
        .args(ssh_tunnel_arguments(target, local_port)?)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(agent) = &target.agent {
        command.env("SSH_AUTH_SOCK", agent);
    }
    let mut child = command.spawn().map_err(SshTunnelError::Spawn)?;
    let stderr = collect_stderr(&mut child);
    let mut tunnel = SshTunnel { local_port, child };

    let deadline = Instant::now() + READY_TIMEOUT;
    while Instant::now() < deadline {
        if let Ok(Some(status)) = tunnel.child.try_wait() {
            let exited = match status.code() {
                Some(code) => format!("exit code {code}"),
                None => "signal".to_owned(),
            };
            let text = match stderr {
                Some(handle) => tokio::time::timeout(Duration::from_secs(1), handle)
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .unwrap_or_default(),
                None => String::new(),
            };
            return Err(SshTunnelError::Failed(failure_message(
                target, &text, &exited,
            )));
        }
        // Another process can take the port between `free_port` and ssh's bind; ssh then
        // exits (`ExitOnForwardFailure`). So a listener only counts while ssh still runs.
        if accepts(local_port).await {
            tokio::time::sleep(Duration::from_millis(150)).await;
            if matches!(tunnel.child.try_wait(), Ok(None)) {
                return Ok(tunnel);
            }
            continue;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tunnel.close();
    Err(SshTunnelError::Timeout {
        host: target.host.clone(),
    })
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests assert and use ? for setup"
)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use tokio::io::AsyncWriteExt as _;

    use super::*;

    fn target() -> SshTunnelTarget {
        SshTunnelTarget {
            host: "sfmain1".into(),
            port: Some(2222),
            user: Some("forge".into()),
            agent: Some("/tmp/vault-agent.sock".into()),
            remote_host: "127.0.0.1".into(),
            remote_port: 3306,
        }
    }

    #[test]
    fn forwards_a_local_port_with_the_host_after_double_dash() -> Result<(), SshTunnelError> {
        assert_eq!(
            ssh_tunnel_arguments(&target(), 50_000)?,
            [
                "-N",
                "-T",
                "-L",
                "127.0.0.1:50000:127.0.0.1:3306",
                "-o",
                "IdentityAgent=SSH_AUTH_SOCK",
                "-o",
                "BatchMode=yes",
                "-o",
                "ExitOnForwardFailure=yes",
                "-o",
                "StrictHostKeyChecking=accept-new",
                "-o",
                "ServerAliveInterval=30",
                "-p",
                "2222",
                "-l",
                "forge",
                "--",
                "sfmain1",
            ]
        );
        let bare = SshTunnelTarget {
            remote_host: "::1".into(),
            port: None,
            user: None,
            agent: None,
            ..target()
        };
        let args = ssh_tunnel_arguments(&bare, 1)?;
        assert_eq!(args[3], "127.0.0.1:1:[::1]:3306");
        assert!(
            !args.iter().any(|arg| arg.starts_with("IdentityAgent")),
            "without an agent socket, ssh uses the user's own agent"
        );
        Ok(())
    }

    #[test]
    fn refuses_option_like_or_spaced_values() {
        for bad in [
            SshTunnelTarget {
                host: "-oProxyCommand=evil".into(),
                ..target()
            },
            SshTunnelTarget {
                user: Some("-l".into()),
                ..target()
            },
            SshTunnelTarget {
                remote_host: "a b".into(),
                ..target()
            },
        ] {
            let error = ssh_tunnel_arguments(&bad, 1).map(|_| ()).err();
            assert!(
                error.is_some_and(|error| error.to_string().contains("not valid")),
                "{bad:?} must be refused"
            );
        }
    }

    fn fake_ssh(dir: &Path, name: &str, body: &str) -> std::io::Result<std::path::PathBuf> {
        let path = dir.join(name);
        std::fs::write(&path, body)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
        Ok(path)
    }

    #[tokio::test]
    async fn reports_why_ssh_failed() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let refused = fake_ssh(
            dir.path(),
            "refused",
            "#!/bin/sh\necho 'forge@sfmain1: Permission denied (publickey).' >&2\nexit 255\n",
        )?;
        let error = open_ssh_tunnel(&target(), &refused)
            .await
            .map(|_| ())
            .err()
            .ok_or("the tunnel must fail")?;
        assert_eq!(
            error.to_string(),
            "SSH to sfmain1 failed: forge@sfmain1: Permission denied (publickey). Check that Vault is unlocked and holds the server's key."
        );
        Ok(())
    }

    /// A stand-in for `ssh -N -L` that forwards the local port to the remote target. It needs
    /// `python3`; the test passes trivially without it.
    #[tokio::test]
    async fn resolves_once_the_local_port_carries_traffic() -> Result<(), Box<dyn std::error::Error>>
    {
        let Some(python) = ["/usr/bin/python3", "/opt/homebrew/bin/python3"]
            .into_iter()
            .find(|path| Path::new(path).exists())
        else {
            return Ok(());
        };
        let dir = tempfile::tempdir()?;
        let forwarding = fake_ssh(
            dir.path(),
            "forward",
            &format!(
                r#"#!{python} -I
import os, socket, sys, threading
if os.environ.get("SSH_AUTH_SOCK") != "/tmp/vault-agent.sock":
    sys.stderr.write("wrong agent"); sys.exit(1)
_, local_port, remote_host, remote_port = sys.argv[sys.argv.index("-L") + 1].split(":")
server = socket.socket(); server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", int(local_port))); server.listen()
def pipe(a, b):
    try:
        while (data := a.recv(4096)):
            b.sendall(data)
    except OSError:
        pass
while True:
    client, _ = server.accept()
    upstream = socket.create_connection((remote_host, int(remote_port)))
    threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
    threading.Thread(target=pipe, args=(upstream, client), daemon=True).start()
"#
            ),
        )?;
        let echo = TcpListener::bind(("127.0.0.1", 0)).await?;
        let echo_port = echo.local_addr()?.port();
        let echo_task = tokio::spawn(async move {
            while let Ok((mut socket, _)) = echo.accept().await {
                tokio::spawn(async move {
                    let (mut read, mut write) = socket.split();
                    let _ = tokio::io::copy(&mut read, &mut write).await;
                });
            }
        });

        let mut tunnel = open_ssh_tunnel(
            &SshTunnelTarget {
                remote_port: echo_port,
                ..target()
            },
            &forwarding,
        )
        .await?;
        let mut socket = TcpStream::connect(("127.0.0.1", tunnel.local_port())).await?;
        socket.write_all(b"ping").await?;
        let mut reply = [0u8; 4];
        tokio::time::timeout(Duration::from_secs(5), socket.read_exact(&mut reply)).await??;
        tunnel.close();
        echo_task.abort();

        assert_eq!(&reply, b"ping");
        Ok(())
    }
}
