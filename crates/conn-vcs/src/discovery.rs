//! The version control half of `server.discoverSourceControl`: `git` and `jj`, probed as
//! `SourceControlDiscovery.ts` does (`--version`, 5 s, 8 KB). The source control hosts are
//! probed by `conn-source-control`.

use std::{path::Path, process::Stdio, time::Duration};

use conn_contract::{
    SourceControlDiscoveryStatus, VcsDiscoveryItem, VcsDiscoveryItemDetail,
    VcsDiscoveryItemDetailNone, VcsDiscoveryItemDetailSome, VcsDriverKind, lit,
};
use tokio::io::{AsyncRead, AsyncReadExt};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const PROBE_MAX_BYTES: usize = 8_000;

fn some(value: impl Into<String>) -> VcsDiscoveryItemDetail {
    VcsDiscoveryItemDetail::Some(VcsDiscoveryItemDetailSome {
        tag: lit::Some,
        value: value.into(),
    })
}

fn none() -> VcsDiscoveryItemDetail {
    VcsDiscoveryItemDetail::None(VcsDiscoveryItemDetailNone { tag: lit::None2 })
}

struct Probe {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

enum ProbeError {
    Missing,
    Failed(String),
}

async fn probe(cwd: &Path, exe: &str, args: &[&str]) -> Result<Probe, ProbeError> {
    let mut child = tokio::process::Command::new(exe)
        .args(args)
        .current_dir(cwd)
        .envs(conn_support::login_env::vars())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => ProbeError::Missing,
            _ => ProbeError::Failed(format!("`{exe} {}` failed.", args.join(" "))),
        })?;
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let work = async {
        let (out, err) = tokio::join!(
            read_capped(stdout, PROBE_MAX_BYTES),
            read_capped(stderr, PROBE_MAX_BYTES)
        );
        let status = child.wait().await.ok();
        (out, err, status)
    };
    match tokio::time::timeout(PROBE_TIMEOUT, work).await {
        Ok((out, err, status)) => Ok(Probe {
            code: status.and_then(|s| s.code()),
            stdout: String::from_utf8_lossy(&out).into_owned(),
            stderr: String::from_utf8_lossy(&err).into_owned(),
        }),
        Err(_) => Err(ProbeError::Failed(format!(
            "`{exe} {}` timed out after {}ms.",
            args.join(" "),
            PROBE_TIMEOUT.as_millis()
        ))),
    }
}

/// Keeps the first `cap` bytes and reads on to the end, so a child that writes more than a
/// pipe holds never blocks on a full pipe.
async fn read_capped(pipe: Option<impl AsyncRead + Unpin>, cap: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let Some(mut pipe) = pipe else {
        return out;
    };
    // On the heap: an 8 KiB array would sit in every probe future (clippy's `large_futures`).
    let mut buf = vec![0u8; 8192];
    loop {
        match pipe.read(&mut buf).await {
            Ok(0) | Err(_) => return out,
            Ok(n) => {
                let room = cap.saturating_sub(out.len()).min(n);
                out.extend_from_slice(buf.get(..room).unwrap_or_default());
            }
        }
    }
}

fn first_line(probe: &Probe) -> Option<String> {
    [&probe.stdout, &probe.stderr]
        .iter()
        .flat_map(|s| s.lines())
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_owned)
}

struct Version {
    status: SourceControlDiscoveryStatus,
    version: VcsDiscoveryItemDetail,
    detail: VcsDiscoveryItemDetail,
    install_hint: String,
}

async fn version(cwd: &Path, exe: &str, args: &[&str], hint: &str) -> Version {
    let missing = |detail: String, hint: String| Version {
        status: SourceControlDiscoveryStatus::Missing,
        version: none(),
        detail: some(detail),
        install_hint: hint,
    };
    match probe(cwd, exe, args).await {
        Ok(p) if p.code == Some(0) => Version {
            status: SourceControlDiscoveryStatus::Available,
            version: first_line(&p).map_or_else(none, some),
            detail: none(),
            install_hint: hint.into(),
        },
        Ok(p) => {
            let detail = format!(
                "`{exe} {}` exited with status {}. Check the `{exe}` that the server's PATH resolves.",
                args.join(" "),
                p.code.unwrap_or(-1)
            );
            missing(detail.clone(), detail)
        }
        Err(ProbeError::Missing) => missing(format!("{exe} was not found on PATH."), hint.into()),
        Err(ProbeError::Failed(detail)) => {
            let hint = format!("{detail} Check the `{exe}` that the server's PATH resolves.");
            missing(detail, hint)
        }
    }
}

async fn vcs_item(
    cwd: &Path,
    kind: VcsDriverKind,
    label: &str,
    exe: &str,
    implemented: bool,
    hint: &str,
) -> VcsDiscoveryItem {
    let v = version(cwd, exe, &["--version"], hint).await;
    VcsDiscoveryItem {
        kind,
        implemented,
        label: label.into(),
        executable: Some(exe.into()),
        status: v.status,
        version: v.version,
        install_hint: v.install_hint,
        detail: v.detail,
    }
}

/// `git` and `jj`, probed at once, in `VCS_PROBES` order.
pub async fn version_control_systems(cwd: &Path) -> Vec<VcsDiscoveryItem> {
    let (git, jj) = tokio::join!(
        vcs_item(
            cwd,
            VcsDriverKind::Git,
            "Git",
            "git",
            true,
            "Install Git from https://git-scm.com/downloads or with your package manager.",
        ),
        vcs_item(
            cwd,
            VcsDriverKind::Jj,
            "Jujutsu",
            "jj",
            false,
            "Install Jujutsu with `brew install jj` or from https://github.com/jj-vcs/jj.",
        ),
    );
    vec![git, jj]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A CLI that writes more than a pipe holds must not stall the probe until its timeout.
    #[tokio::test(flavor = "current_thread")]
    async fn a_verbose_cli_does_not_stall_the_probe() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("conn-vcs-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stub = dir.join("verbose");
        std::fs::write(
            &stub,
            "#!/bin/sh\necho 'verbose 1.0'\nhead -c 300000 /dev/zero | tr '\\0' x\nhead -c 300000 /dev/zero >&2\nexit 0\n",
        )
        .unwrap();
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        let started = std::time::Instant::now();
        let result = probe(&dir, &stub.to_string_lossy(), &["--version"]).await;
        let elapsed = started.elapsed();
        let _ = std::fs::remove_dir_all(&dir);
        let Ok(p) = result else {
            panic!("the probe failed after {elapsed:?}")
        };
        assert_eq!(p.code, Some(0));
        assert_eq!(first_line(&p).as_deref(), Some("verbose 1.0"));
        assert!(p.stdout.len() <= PROBE_MAX_BYTES && p.stderr.len() <= PROBE_MAX_BYTES);
        assert!(elapsed < Duration::from_secs(2), "{elapsed:?}");
    }
}
