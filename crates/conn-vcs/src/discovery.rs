//! `server.discoverSourceControl`: which VCS and forge CLIs this machine has.
//!
//! Probes `git` and `jj` as `SourceControlDiscovery.ts` does (`--version`, 5 s, 8 KB), and the
//! GitHub and GitLab CLIs (`gh`, `glab`) for their version and login. Other forges the
//! TypeScript server knows (Azure DevOps, Forgejo, Bitbucket, ...) are left out: this server
//! has no `pullRequests.*` or `sourceControl.*` yet, so nothing could use them.

use std::{path::Path, process::Stdio, time::Duration};

use conn_contract::{
    ServerProviderAuthStatus, SourceControlDiscoveryResult, SourceControlDiscoveryStatus,
    SourceControlProviderAuth, SourceControlProviderDiscoveryItem, VcsDiscoveryItem,
    VcsDiscoveryItemDetail, VcsDiscoveryItemDetailNone, VcsDiscoveryItemDetailSome, VcsDriverKind,
    lit,
};
use tokio::io::AsyncReadExt;

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
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => ProbeError::Missing,
            _ => ProbeError::Failed(format!("`{exe} {}` failed.", args.join(" "))),
        })?;
    let mut stdout = child
        .stdout
        .take()
        .expect("piped")
        .take(PROBE_MAX_BYTES as u64);
    let mut stderr = child
        .stderr
        .take()
        .expect("piped")
        .take(PROBE_MAX_BYTES as u64);
    let work = async {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let _ = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
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

fn auth(
    status: ServerProviderAuthStatus,
    host: Option<String>,
    detail: Option<String>,
) -> SourceControlProviderAuth {
    SourceControlProviderAuth {
        status,
        account: none(),
        host: host.map_or_else(none, some),
        detail: detail.map_or_else(none, some),
        accounts: None,
    }
}

/// `gh auth status` / `glab auth status`: exit 0 means logged in. Without a CLI, unknown.
async fn cli_auth(
    cwd: &Path,
    exe: &str,
    available: bool,
    host: &str,
    hint: &str,
) -> SourceControlProviderAuth {
    if !available {
        return auth(ServerProviderAuthStatus::Unknown, None, Some(hint.into()));
    }
    match probe(cwd, exe, &["auth", "status"]).await {
        Ok(p) if p.code == Some(0) => auth(
            ServerProviderAuthStatus::Authenticated,
            Some(host.into()),
            None,
        ),
        Ok(_) => auth(
            ServerProviderAuthStatus::Unauthenticated,
            Some(host.into()),
            Some(format!("Run `{exe} auth login` on the server.")),
        ),
        Err(ProbeError::Missing) => {
            auth(ServerProviderAuthStatus::Unknown, None, Some(hint.into()))
        }
        Err(ProbeError::Failed(detail)) => {
            auth(ServerProviderAuthStatus::Unknown, None, Some(detail))
        }
    }
}

async fn provider_item(
    cwd: &Path,
    kind: &str,
    label: &str,
    exe: &str,
    host: &str,
    hint: &str,
) -> SourceControlProviderDiscoveryItem {
    let v = version(cwd, exe, &["--version"], hint).await;
    let available = v.status == SourceControlDiscoveryStatus::Available;
    SourceControlProviderDiscoveryItem {
        kind: kind.into(),
        label: label.into(),
        executable: Some(exe.into()),
        auth: cli_auth(cwd, exe, available, host, hint).await,
        status: v.status,
        version: v.version,
        install_hint: v.install_hint,
        detail: v.detail,
        app_sign_in: None,
    }
}

pub async fn discover(cwd: &Path) -> SourceControlDiscoveryResult {
    let (git, jj, github, gitlab) = tokio::join!(
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
        provider_item(
            cwd,
            "github",
            "GitHub",
            "gh",
            "github.com",
            "Install the GitHub command-line tool (`gh`) via https://cli.github.com/ or your package manager (for example `brew install gh`).",
        ),
        provider_item(
            cwd,
            "gitlab",
            "GitLab",
            "glab",
            "gitlab.com",
            "Install the GitLab command-line tool (`glab`) from https://gitlab.com/gitlab-org/cli or your package manager (for example `brew install glab`).",
        ),
    );
    SourceControlDiscoveryResult {
        version_control_systems: vec![git, jj],
        source_control_providers: vec![github, gitlab],
    }
}
