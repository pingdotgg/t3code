//! The Orbit MCP network wait (`codexMcpNetworkGate.ts`, a Conn addition to the T3 server).
//!
//! Codex starts MCP servers once per thread, so after a reboot it can spawn before the Orbit
//! network is up. Before the first spawn the gate holds until every enabled `*.orbit` MCP URL
//! in `$CODEX_HOME/config.toml` accepts TCP, up to `T3CODE_CODEX_MCP_WAIT_SECONDS` (default
//! 120, 0 disables), then goes ahead either way. It runs once per provider, as TS caches it
//! per config file for the server's life.

use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

/// The variable that sets the budget in seconds.
pub const WAIT_ENV: &str = "T3CODE_CODEX_MCP_WAIT_SECONDS";
const DEFAULT_WAIT_SECONDS: f64 = 120.0;
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const RETRY_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpHost {
    pub host: String,
    pub port: u16,
}

impl McpHost {
    fn label(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

/// `McpNetworkGateResult`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GateResult {
    pub hosts: Vec<String>,
    pub ready: bool,
    pub waited: Duration,
    pub pending: Vec<String>,
}

/// What the gate reads: the config file and the budget.
#[derive(Clone, Debug, PartialEq)]
pub struct Gate {
    pub config_path: PathBuf,
    pub budget: Duration,
}

impl Gate {
    /// From the spawn environment, looked up as `{...process.env, ...environment}` in TS:
    /// `CODEX_HOME` or `$HOME/.codex`, and the budget variable.
    pub fn from_env(lookup: impl Fn(&str) -> Option<String>) -> Gate {
        let seconds = lookup(WAIT_ENV)
            .map(|raw| raw.trim().to_owned())
            .filter(|raw| !raw.is_empty())
            .map(|raw| raw.parse::<f64>().unwrap_or(f64::NAN))
            .unwrap_or(DEFAULT_WAIT_SECONDS);
        let budget = if seconds.is_finite() && seconds > 0.0 {
            Duration::from_secs_f64(seconds.min(1e9))
        } else {
            Duration::ZERO
        };
        let home = lookup("CODEX_HOME")
            .filter(|h| !h.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(lookup("HOME").unwrap_or_default()).join(".codex"));
        Gate {
            config_path: home.join("config.toml"),
            budget,
        }
    }

    /// Reads the config and waits. Never fails: an unreadable config means no hosts.
    pub async fn wait(&self) -> GateResult {
        let path = self.config_path.clone();
        let text = tokio::task::spawn_blocking(move || std::fs::read_to_string(path))
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        let hosts = orbit_mcp_hosts(&text);
        if self.budget.is_zero() || hosts.is_empty() {
            return GateResult {
                hosts: hosts.iter().map(McpHost::label).collect(),
                ready: true,
                waited: Duration::ZERO,
                pending: Vec::new(),
            };
        }
        wait_for_hosts(&hosts, self.budget, RETRY_INTERVAL).await
    }
}

/// `orbitMcpHosts`: enabled `[mcp_servers.<name>]` URLs whose host ends in `.orbit`, in the
/// order their tables first appear, without repeats.
pub fn orbit_mcp_hosts(config_toml: &str) -> Vec<McpHost> {
    // (name, url, enabled), in first-seen order.
    let mut servers: Vec<(String, Option<String>, bool)> = Vec::new();
    let mut current: Option<String> = None;
    for line in config_toml.lines() {
        if let Some(header) = table_header(line) {
            current = server_name(header).map(str::to_owned);
            if let Some(name) = &current
                && !servers.iter().any(|(n, _, _)| n == name)
            {
                servers.push((name.clone(), None, true));
            }
            continue;
        }
        let Some(entry) = current
            .as_ref()
            .and_then(|name| servers.iter_mut().find(|(n, _, _)| n == name))
        else {
            continue;
        };
        if let Some(url) = quoted_value(line, "url") {
            entry.1 = Some(url);
        }
        if enabled_false(line) {
            entry.2 = false;
        }
    }
    let mut hosts: Vec<McpHost> = Vec::new();
    for (_, url, enabled) in servers {
        let Some(host) = url.filter(|_| enabled).and_then(|u| parse_url(&u)) else {
            continue;
        };
        if host.host.ends_with(".orbit") && !hosts.contains(&host) {
            hosts.push(host);
        }
    }
    hosts
}

/// `^\s*\[([^\]]+)\]\s*(#.*)?$`
fn table_header(line: &str) -> Option<&str> {
    let rest = line.trim_start().strip_prefix('[')?;
    let end = rest.find(']')?;
    let inner = rest.get(..end)?;
    let after = rest.get(end + 1..)?.trim_start();
    (!inner.is_empty() && (after.is_empty() || after.starts_with('#'))).then_some(inner)
}

/// `^mcp_servers\.("[^"]+"|[^.]+)$` on the trimmed header.
fn server_name(header: &str) -> Option<&str> {
    let name = header.trim().strip_prefix("mcp_servers.")?;
    let quoted = name.len() > 2
        && name.starts_with('"')
        && name.ends_with('"')
        && !name[1..name.len() - 1].contains('"');
    (quoted || (!name.is_empty() && !name.contains('.'))).then_some(name)
}

/// `^\s*<key>\s*=\s*["']([^"']+)["']`
fn quoted_value(line: &str, key: &str) -> Option<String> {
    let rest = line.trim_start().strip_prefix(key)?;
    let rest = rest.trim_start().strip_prefix('=')?.trim_start();
    let rest = rest.strip_prefix(['"', '\''])?;
    let end = rest.find(['"', '\''])?;
    (end > 0).then(|| rest[..end].to_owned())
}

/// `^\s*enabled\s*=\s*false\b`
fn enabled_false(line: &str) -> bool {
    let Some(rest) = line.trim_start().strip_prefix("enabled") else {
        return false;
    };
    let Some(rest) = rest.trim_start().strip_prefix('=') else {
        return false;
    };
    let Some(after) = rest.trim_start().strip_prefix("false") else {
        return false;
    };
    !after.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')
}

/// The host and port of an absolute URL as `new URL()` reads them: the hostname lowercased,
/// the port from the URL or 80 for `http:` and 443 otherwise.
fn parse_url(url: &str) -> Option<McpHost> {
    let (scheme, rest) = url.trim().split_once("://")?;
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit_once('@').map_or(authority, |(_, a)| a);
    let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
        let (host, after) = v6.split_once(']')?;
        (host, after.strip_prefix(':'))
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        }
    };
    if host.is_empty() {
        return None;
    }
    let default = if scheme.eq_ignore_ascii_case("http") {
        80
    } else {
        443
    };
    let port = match port {
        None | Some("") => default,
        Some(p) => match p.parse::<u16>() {
            Ok(0) => default,
            Ok(p) => p,
            Err(_) => return None,
        },
    };
    Some(McpHost {
        host: host.to_ascii_lowercase(),
        port,
    })
}

/// Whether `host` resolves and accepts a TCP connection within `timeout`.
async fn probe(host: McpHost, timeout: Duration) -> bool {
    let connect = tokio::net::TcpStream::connect((host.host.as_str(), host.port));
    matches!(tokio::time::timeout(timeout, connect).await, Ok(Ok(_)))
}

/// `waitForMcpHosts`: probes the pending hosts together, every `interval`, until all
/// answered or the next round would pass `budget`.
pub async fn wait_for_hosts(hosts: &[McpHost], budget: Duration, interval: Duration) -> GateResult {
    let started = Instant::now();
    let mut pending: Vec<McpHost> = hosts.to_vec();
    while !pending.is_empty() {
        let timeout = PROBE_TIMEOUT.min(budget);
        let probes: Vec<_> = pending
            .iter()
            .cloned()
            .map(|host| tokio::spawn(probe(host, timeout)))
            .collect();
        let mut still = Vec::new();
        for (host, probe) in pending.into_iter().zip(probes) {
            if !probe.await.unwrap_or(false) {
                still.push(host);
            }
        }
        pending = still;
        if pending.is_empty() || started.elapsed() + interval >= budget {
            break;
        }
        tokio::time::sleep(interval).await;
    }
    GateResult {
        hosts: hosts.iter().map(McpHost::label).collect(),
        ready: pending.is_empty(),
        waited: started.elapsed(),
        pending: pending.iter().map(McpHost::label).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(host: &str, port: u16) -> McpHost {
        McpHost {
            host: host.into(),
            port,
        }
    }

    /// The TS test `orbitMcpHosts keeps enabled *.orbit MCP URLs only`.
    #[test]
    fn keeps_enabled_orbit_urls_only() {
        let toml = [
            r#"base_url = "http://10.44.0.3:8317/v1""#,
            "[mcp_servers.recall]",
            r#"url = "https://recall.orbit/mcp/recall""#,
            r#"bearer_token_env_var = "RECALL_MCP_TOKEN""#,
            "[mcp_servers.recall.env]",
            r#"url = "https://ignored.orbit/""#,
            "[mcp_servers.executor]",
            r#"url = "https://executor.orbit/mcp""#,
            "[mcp_servers.off]",
            r#"url = "https://off.orbit/mcp""#,
            "enabled = false",
            "[mcp_servers.linear]",
            r#"url = "https://mcp.linear.app/mcp""#,
            "[mcp_servers.local]",
            r#"url = "http://dev.orbit:8080/mcp""#,
        ]
        .join("\n");
        assert_eq!(
            orbit_mcp_hosts(&toml),
            [
                host("recall.orbit", 443),
                host("executor.orbit", 443),
                host("dev.orbit", 8080)
            ]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn passes_once_every_host_accepts() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let result = wait_for_hosts(
            &[host("127.0.0.1", port)],
            Duration::from_secs(5),
            Duration::from_millis(100),
        )
        .await;
        assert!(result.ready);
        assert!(result.pending.is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn gives_up_after_the_budget() {
        // Bound but not listening: a connection is refused, and no other process can take the
        // port while the test runs (a freed port was taken by another test run under load).
        let held = tokio::net::TcpSocket::new_v4().unwrap();
        held.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let port = held.local_addr().unwrap().port();
        let result = wait_for_hosts(
            &[host("127.0.0.1", port)],
            Duration::from_millis(400),
            Duration::from_millis(100),
        )
        .await;
        assert!(!result.ready);
        assert_eq!(result.pending, [format!("127.0.0.1:{port}")]);
        assert!(result.waited < Duration::from_secs(2));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn skips_the_wait_when_disabled_or_without_orbit_servers() {
        let home = std::env::temp_dir().join(format!("conn-codex-gate-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join("config.toml"),
            "[mcp_servers.recall]\nurl = \"https://recall.orbit/\"\n",
        )
        .unwrap();
        let home_str = home.to_string_lossy().into_owned();
        let disabled = Gate::from_env(|k| match k {
            "CODEX_HOME" => Some(home_str.clone()),
            WAIT_ENV => Some("0".into()),
            _ => None,
        })
        .wait()
        .await;
        assert_eq!(
            disabled,
            GateResult {
                hosts: vec!["recall.orbit:443".into()],
                ready: true,
                waited: Duration::ZERO,
                pending: vec![]
            }
        );
        let missing_home = home.join("missing").to_string_lossy().into_owned();
        let missing = Gate::from_env(|k| (k == "CODEX_HOME").then(|| missing_home.clone()))
            .wait()
            .await;
        assert!(missing.ready && missing.hosts.is_empty());
        let default = Gate::from_env(|k| (k == "HOME").then(|| "/h".to_owned()));
        assert_eq!(default.config_path, PathBuf::from("/h/.codex/config.toml"));
        assert_eq!(default.budget, Duration::from_secs(120));
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn urls_read_like_the_web_parser() {
        assert_eq!(
            parse_url("https://A.Orbit:8443/x"),
            Some(host("a.orbit", 8443))
        );
        assert_eq!(parse_url("http://u:p@x.orbit/"), Some(host("x.orbit", 80)));
        assert_eq!(parse_url("not a url"), None);
        assert_eq!(parse_url("https://x.orbit:99999/"), None);
    }
}
