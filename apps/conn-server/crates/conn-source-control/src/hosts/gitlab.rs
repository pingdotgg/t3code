//! GitLab (`packages/source-control-gitlab`): discovery through `glab`.
//!
//! `glab --version` and `glab auth status`, then `glab auth status --all` once when the first
//! answer is signed out (`GitLabSourceControlProvider.discovery`). The server holds no GitLab
//! credential: `glab` uses its own login.

use conn_contract::{
    ServerProviderAuthStatus, SourceControlProviderAuth, SourceControlProviderDiscoveryItem,
};

use super::DiscoveryContext;
use crate::discovery::{
    CliSpec, DEFAULT_PROBE_TIMEOUT, ProbeContext, ProbeOutput, first_safe_auth_line,
    parse_cli_host, probe_cli, provider_auth,
};

pub const KIND: &str = "gitlab";
const INSTALL_HINT: &str = "Install the GitLab command-line tool (`glab`) from https://gitlab.com/gitlab-org/cli or your package manager (for example `brew install glab`).";

fn spec() -> CliSpec {
    CliSpec {
        kind: KIND,
        label: "GitLab",
        executable: "glab",
        version_args: &["--version"],
        auth_args: vec!["auth".into(), "status".into()],
        auth_retry_args: Some(vec!["auth".into(), "status".into(), "--all".into()]),
        probe_timeout: DEFAULT_PROBE_TIMEOUT,
        install_hint: INSTALL_HINT,
    }
}

/// `HOST_LINE_PATTERN`: `^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:.]+\])(?::\d+)?$`, `i`.
fn is_host_line(line: &str) -> bool {
    let (name, port) = if let Some(rest) = line.strip_prefix('[') {
        match rest.split_once(']') {
            Some((inside, after)) => {
                let ok = !inside.is_empty()
                    && inside
                        .chars()
                        .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.');
                if !ok {
                    return false;
                }
                ("x", after)
            }
            None => return false,
        }
    } else {
        match line.find(':') {
            Some(i) => (
                line.get(..i).unwrap_or_default(),
                line.get(i..).unwrap_or_default(),
            ),
            None => (line, ""),
        }
    };
    let name_ok = {
        let first = name.chars().next();
        let last = name.chars().last();
        first.is_some_and(|c| c.is_ascii_alphanumeric())
            && last.is_some_and(|c| c.is_ascii_alphanumeric())
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    };
    let port_ok = port.is_empty()
        || port
            .strip_prefix(':')
            .is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    name_ok && port_ok
}

fn find_ascii_ci(haystack: &str, needle: &str, from: usize) -> Vec<usize> {
    let hay = haystack.as_bytes();
    let pat = needle.as_bytes();
    let mut out = Vec::new();
    if pat.is_empty() || hay.len() < pat.len() {
        return out;
    }
    for start in from..=hay.len() - pat.len() {
        if hay
            .get(start..start + pat.len())
            .is_some_and(|w| w.eq_ignore_ascii_case(pat))
        {
            out.push(start);
        }
    }
    out
}

/// `\s+([^\s(]+)` at `at`: at least one white space, then the capture.
fn capture_after_space(text: &str, at: usize, need_space: bool) -> Option<String> {
    let rest = text.get(at..)?;
    let body = rest.trim_start();
    if need_space && body.len() == rest.len() {
        return None;
    }
    let token: String = body
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != '(')
        .collect();
    (!token.is_empty()).then_some(token)
}

/// `/Logged in to .<q> <key>\s+([^\s(]+)/iu` with `<q>` `+?` (lazy, at least one character)
/// or `*` (greedy). `.` stops at a newline; `\s+` may cross one.
fn logged_in(text: &str, key: &str, lazy: bool) -> Option<String> {
    const LEAD: &str = "logged in to ";
    for start in find_ascii_ci(text, LEAD, 0) {
        let from = start + LEAD.len();
        let line_end = text
            .get(from..)
            .and_then(|r| r.find('\n'))
            .map_or(text.len(), |i| from + i);
        let line = text.get(..line_end).unwrap_or_default();
        let mut keys: Vec<usize> = find_ascii_ci(line, key, from)
            .into_iter()
            .filter(|k| *k >= from + usize::from(lazy))
            .collect();
        if !lazy {
            keys.reverse();
        }
        for k in keys {
            if let Some(found) = capture_after_space(text, k + key.len(), true) {
                return Some(found);
            }
        }
    }
    None
}

/// `/account:\s*([^\s(]+)/iu`.
fn account_colon(text: &str) -> Option<String> {
    find_ascii_ci(text, "account:", 0)
        .into_iter()
        .find_map(|k| capture_after_space(text, k + "account:".len(), false))
}

/// One host block of `glab auth status` (`GitLabAuthStatusHost`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthHost {
    pub host: String,
    pub account: Option<String>,
}

/// `parseGitLabAuthStatusHosts`: a host line starts at column 0; indented lines belong to it.
pub fn parse_auth_status_hosts(text: &str) -> Vec<AuthHost> {
    let mut hosts = Vec::new();
    let mut current: Option<(String, Vec<&str>)> = None;
    let flush = |current: &mut Option<(String, Vec<&str>)>, hosts: &mut Vec<AuthHost>| {
        if let Some((host, lines)) = current.take() {
            let account = logged_in(&lines.join("\n"), " as", true)
                .map(|a| a.trim().to_owned())
                .filter(|a| !a.is_empty());
            hosts.push(AuthHost { host, account });
        }
    };
    for raw in text.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if raw.len() == raw.trim_start().len() && is_host_line(line) {
            flush(&mut current, &mut hosts);
            current = Some((line.to_lowercase(), Vec::new()));
            continue;
        }
        if let Some((_, lines)) = current.as_mut() {
            lines.push(line);
        }
    }
    flush(&mut current, &mut hosts);
    hosts
}

/// `parseGitLabAuth`.
pub fn parse_auth(output: &ProbeOutput) -> SourceControlProviderAuth {
    let text = output.combined();
    let signed_in = parse_auth_status_hosts(&text)
        .into_iter()
        .find(|h| h.account.is_some());
    let account = signed_in
        .as_ref()
        .and_then(|h| h.account.clone())
        .or_else(|| logged_in(&text, " as", false))
        .or_else(|| logged_in(&text, " account", false))
        .or_else(|| account_colon(&text));
    let host = signed_in.map(|h| h.host).or_else(|| parse_cli_host(&text));
    if let Some(account) = account {
        return provider_auth(
            ServerProviderAuthStatus::Authenticated,
            Some(&account),
            host.as_deref(),
            None,
        );
    }
    if output.exit_code != 0 {
        let detail = first_safe_auth_line(&text)
            .unwrap_or_else(|| "Run `glab auth login` to authenticate GitLab CLI.".into());
        return provider_auth(
            ServerProviderAuthStatus::Unauthenticated,
            None,
            host.as_deref(),
            Some(&detail),
        );
    }
    let detail = first_safe_auth_line(&text)
        .unwrap_or_else(|| "GitLab CLI auth status could not be parsed.".into());
    provider_auth(
        ServerProviderAuthStatus::Unknown,
        None,
        host.as_deref(),
        Some(&detail),
    )
}

pub async fn discover(ctx: DiscoveryContext<'_>) -> SourceControlProviderDiscoveryItem {
    let env = ctx.probe_env(&[]);
    probe_cli(
        ProbeContext {
            cwd: ctx.cwd,
            env: &env,
        },
        &spec(),
        parse_auth,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        discovery::{some, stub::StubDir},
        hosts::{Endpoints, Environment},
        settings::Settings,
    };

    fn output(stdout: &str, stderr: &str, exit_code: i32) -> ProbeOutput {
        ProbeOutput {
            stdout: stdout.into(),
            stderr: stderr.into(),
            exit_code,
        }
    }

    // gitLabDiscovery.test.ts: "reads the account from glab output without status marks"
    #[test]
    fn reads_the_account_without_marks() {
        let auth = parse_auth(&output(
            "gitlab.com\nLogged in to gitlab.com as gitlab-user\n",
            "",
            0,
        ));
        assert_eq!(
            auth.status,
            ServerProviderAuthStatus::Authenticated,
            "status"
        );
        assert_eq!(auth.account, some("gitlab-user"), "account");
    }

    #[test]
    fn parses_host_blocks() {
        let text = "gitlab.com\n  x gitlab.com: API call failed: 401 Unauthorized\n  ! No token found\nself-hosted.example.test:8443\n  ✓ Logged in to self-hosted.example.test:8443 as gitlab-user (/home/u/.config/glab-cli/config.yml)\n  ✓ Token found: ******\n";
        assert_eq!(
            parse_auth_status_hosts(text),
            vec![
                AuthHost {
                    host: "gitlab.com".into(),
                    account: None
                },
                AuthHost {
                    host: "self-hosted.example.test:8443".into(),
                    account: Some("gitlab-user".into())
                },
            ],
            "blocks"
        );
    }

    async fn probe_with(stubs: &StubDir) -> SourceControlProviderDiscoveryItem {
        let settings = Settings::default();
        let env = Environment::fixed([]);
        let endpoints = Endpoints::default();
        let child_env = stubs.path_env();
        discover(DiscoveryContext {
            cwd: &stubs.dir,
            home: None,
            settings: &settings,
            env: &env,
            endpoints: &endpoints,
            child_env: &child_env,
        })
        .await
    }

    const DEFAULT_HOST_ONLY: &str = "gitlab.gnome.org\n  x gitlab.gnome.org: API call failed: GET https://gitlab.gnome.org/api/v4/user: 401 {message: 401 Unauthorized}\n";

    // "reports a signed-in host when glab's default host is signed out"
    #[tokio::test(flavor = "current_thread")]
    async fn retries_with_all_when_signed_out() {
        let stubs = StubDir::new("glab-all");
        let all = format!(
            "gitlab.com\n  ✓ Logged in to gitlab.com as gitlab-user (/home/user/.config/glab-cli/config.yml)\n{DEFAULT_HOST_ONLY}"
        );
        stubs.executable(
            "glab",
            &[],
            &format!(
                "if [ \"$1\" = --version ]; then echo 'glab 1.124.0'; exit 0; fi\ncase \"$*\" in *--all*) printf '%s' '{all}';; *) printf '%s' '{DEFAULT_HOST_ONLY}';; esac\nexit 1"
            ),
        );
        let item = probe_with(&stubs).await;
        assert_eq!(
            item.auth.status,
            ServerProviderAuthStatus::Authenticated,
            "status"
        );
        assert_eq!(item.auth.account, some("gitlab-user"), "account");
        assert_eq!(item.auth.host, some("gitlab.com"), "host");
        let log = stubs.log("glab");
        assert!(log.contains("argv auth status\n"), "{log}");
        assert!(log.contains("argv auth status --all\n"), "{log}");
    }

    // "skips --all when the current glab host is signed in"
    #[tokio::test(flavor = "current_thread")]
    async fn skips_all_when_signed_in() {
        let stubs = StubDir::new("glab-signed-in");
        stubs.executable(
            "glab",
            &[],
            "if [ \"$1\" = --version ]; then echo 'glab 1.124.0'; exit 0; fi\nprintf 'gitlab.example.test\\n  ✓ Logged in to gitlab.example.test as gitlab-user\\n'",
        );
        let item = probe_with(&stubs).await;
        assert_eq!(
            item.auth.status,
            ServerProviderAuthStatus::Authenticated,
            "status"
        );
        assert!(!stubs.log("glab").contains("--all"), "no retry");
        assert_eq!(item.version, some("glab 1.124.0"), "version");
    }

    // "keeps glab's own sign-out detail when glab predates --all"
    #[tokio::test(flavor = "current_thread")]
    async fn keeps_the_sign_out_detail() {
        let stubs = StubDir::new("glab-old");
        stubs.executable(
            "glab",
            &[],
            "if [ \"$1\" = --version ]; then echo 'glab 1.53.0'; exit 0; fi\ncase \"$*\" in *--all*) echo 'unknown flag: --all' >&2;; *) echo 'No GitLab instances have been authenticated with glab.' >&2;; esac\nexit 1",
        );
        let item = probe_with(&stubs).await;
        assert_eq!(
            item.auth.status,
            ServerProviderAuthStatus::Unauthenticated,
            "status"
        );
        assert_eq!(
            item.auth.detail,
            some("No GitLab instances have been authenticated with glab."),
            "detail"
        );
    }
}
