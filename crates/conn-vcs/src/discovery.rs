//! `server.discoverSourceControl`: which VCS and forge CLIs this machine has.
//!
//! Probes `git` and `jj` as `SourceControlDiscovery.ts` does (`--version`, 5 s, 8 KB), and the
//! GitHub and GitLab CLIs (`gh`, `glab`) for their version and login. Other forges the
//! TypeScript server knows (Azure DevOps, Forgejo, Bitbucket, ...) are left out: this server
//! has no `pullRequests.*` or `sourceControl.*` yet, so nothing could use them.

use std::{path::Path, process::Stdio, time::Duration};

use conn_contract::{
    ServerProviderAuthStatus, SourceControlDiscoveryResult, SourceControlDiscoveryStatus,
    SourceControlProviderAuth, SourceControlProviderAuthAccountsItem,
    SourceControlProviderDiscoveryItem, VcsDiscoveryItem, VcsDiscoveryItemDetail,
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
    if exe == "gh"
        && let Ok(p) = probe(cwd, exe, &["auth", "status", "--json", "hosts"]).await
        && let Some(parsed) = github_auth(&p.stdout)
    {
        return parsed;
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

/// Reads `gh auth status --json hosts`: every account per host, and the active, logged-in
/// one (github.com first) as the account in use. `None` when the output is not that shape.
pub fn github_auth(json: &str) -> Option<SourceControlProviderAuth> {
    #[derive(serde::Deserialize)]
    struct Status {
        hosts: std::collections::BTreeMap<String, Vec<Entry>>,
    }
    #[derive(serde::Deserialize)]
    struct Entry {
        #[serde(default)]
        login: String,
        #[serde(default)]
        active: bool,
        #[serde(default)]
        state: String,
    }
    let status: Status = serde_json::from_str(json).ok()?;
    let accounts: Vec<SourceControlProviderAuthAccountsItem> = status
        .hosts
        .iter()
        .flat_map(|(host, entries)| {
            entries
                .iter()
                .map(move |e| SourceControlProviderAuthAccountsItem {
                    host: host.clone(),
                    account: e.login.clone(),
                    active: e.active,
                    authenticated: e.state == "success",
                    error: None,
                    environment_variable: None,
                })
        })
        .collect();
    let chosen = accounts
        .iter()
        .filter(|a| a.active && a.authenticated)
        .min_by_key(|a| a.host != "github.com");
    Some(match chosen {
        Some(account) => SourceControlProviderAuth {
            status: ServerProviderAuthStatus::Authenticated,
            account: some(account.account.clone()),
            host: some(account.host.clone()),
            detail: none(),
            accounts: Some(accounts.clone()),
        },
        None => SourceControlProviderAuth {
            status: ServerProviderAuthStatus::Unauthenticated,
            account: none(),
            host: none(),
            detail: some("Run `gh auth login` on the server."),
            accounts: Some(accounts),
        },
    })
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

    #[test]
    fn reads_github_accounts() {
        let json = r#"{"hosts":{"ghe.example.com":[{"state":"success","active":true,"host":"ghe.example.com","login":"a"}],
            "github.com":[{"state":"error","active":false,"login":"b"},{"state":"success","active":true,"login":"c"}]}}"#;
        let auth = github_auth(json).expect("parses");
        assert_eq!(auth.status, ServerProviderAuthStatus::Authenticated);
        assert_eq!(auth.account, some("c"), "github.com wins over another host");
        assert_eq!(auth.accounts.as_ref().map(Vec::len), Some(3));
        let none_logged_in = github_auth(r#"{"hosts":{}}"#).expect("parses");
        assert_eq!(
            none_logged_in.status,
            ServerProviderAuthStatus::Unauthenticated
        );
        assert!(github_auth("not json").is_none());
    }
}
