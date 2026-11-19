//! The pure parts of `PortScanner.ts`: what `lsof`, `/proc` and `ps` print, read as T3 reads
//! them, the configured URL rules, the projection a subscriber sees, and the process group a
//! stop may signal. `tools/local-servers-diff.mjs` runs T3's functions and these on the same
//! inputs.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{Value, json};

/// `AGENT_THREAD_ENV`: agents start with it set to their thread; their jobs inherit it.
pub const AGENT_THREAD_ENV: &str = "T3CODE_THREAD_ID";
/// `CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS`.
pub const CONFIGURED_MAX_ITEMS: usize = 32;
/// `PREVIEW_URL_MAX_LENGTH`.
pub const URL_MAX_LENGTH: usize = 2_048;
/// `PROC_TCP_LISTEN`.
const PROC_TCP_LISTEN: &str = "0A";

/// Who started a listener: a thread's terminal, or an agent (`ServerOwner`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Owner {
    pub terminal: Option<(String, String)>,
    pub agent: Option<String>,
}

impl Owner {
    fn is_owned(&self) -> bool {
        self.terminal.is_some() || self.agent.is_some()
    }
}

/// `DiscoveredLocalServer`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Server {
    pub host: String,
    pub port: u16,
    pub url: String,
    pub process_name: Option<String>,
    pub pid: Option<i64>,
    pub owner: Owner,
    /// False for a configured URL with no listener behind it: T3 leaves `agent` out there.
    pub has_agent_field: bool,
}

impl Server {
    pub fn listener(
        port: u16,
        process_name: Option<String>,
        pid: Option<i64>,
        owner: Owner,
    ) -> Self {
        Self {
            host: "localhost".into(),
            port,
            url: format!("http://localhost:{port}"),
            process_name,
            pid,
            owner,
            has_agent_field: true,
        }
    }

    pub fn is_owned(&self) -> bool {
        self.owner.is_owned()
    }

    pub fn to_json(&self) -> Value {
        let mut value = json!({
            "host": self.host,
            "port": self.port,
            "url": self.url,
            "processName": self.process_name,
            "pid": self.pid,
            "terminal": self.owner.terminal.as_ref().map(|(thread, terminal)| json!({"threadId": thread, "terminalId": terminal})),
        });
        if self.has_agent_field {
            value["agent"] = self
                .owner
                .agent
                .as_ref()
                .map_or(Value::Null, |thread| json!({"threadId": thread}));
        }
        value
    }
}

/// `Number.parseInt(text, 10)` for the digits it starts with (sign and leading space allowed).
pub fn js_parse_int(text: &str) -> Option<i64> {
    let text = text.trim_start();
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    let value: i64 = digits.get(..end).filter(|d| !d.is_empty())?.parse().ok()?;
    Some(if negative { -value } else { value })
}

/// `LSOF_LOCAL_HOST_TOKENS`.
fn lsof_local_host(host: &str) -> bool {
    matches!(
        host,
        "localhost" | "127.0.0.1" | "0.0.0.0" | "::1" | "*" | "[::]" | "[::1]"
    )
}

/// `isLoopbackHost`.
pub fn is_loopback_host(host: &str) -> bool {
    matches!(
        host,
        "localhost" | "127.0.0.1" | "0.0.0.0" | "::1" | "[::1]"
    )
}

/// `parsePortFromLsofName`.
pub fn lsof_port(name: &str) -> Option<u16> {
    let token = name.split(' ').next().unwrap_or_default().trim();
    let colon = token.rfind(':')?;
    let host = token.get(..colon)?;
    let port = token.get(colon + 1..)?;
    if !lsof_local_host(host) {
        return None;
    }
    let port = js_parse_int(port)?;
    u16::try_from(port).ok().filter(|p| *p > 0)
}

fn lsof_pid(value: &str) -> Option<i64> {
    js_parse_int(value).filter(|p| *p > 0)
}

/// `parseLsofOutput` of `lsof -iTCP -sTCP:LISTEN -P -n -F pcn`.
pub fn parse_lsof(raw: &str, owners: &HashMap<i64, Owner>) -> Vec<Server> {
    let mut seen: BTreeMap<u16, Server> = BTreeMap::new();
    let mut pid: Option<i64> = None;
    let mut process_name: Option<String> = None;
    for line in raw.split('\n') {
        let mut chars = line.chars();
        let Some(tag) = chars.next() else {
            continue;
        };
        let value = chars.as_str();
        match tag {
            'p' => {
                pid = lsof_pid(value);
                process_name = None;
            }
            'c' => {
                let name = value.trim();
                process_name = (!name.is_empty()).then(|| name.to_owned());
            }
            'n' => {
                let Some(port) = lsof_port(value) else {
                    continue;
                };
                let owner = pid.and_then(|p| owners.get(&p));
                if let Some(existing) = seen.get_mut(&port) {
                    if owner.is_none() {
                        existing.owner = Owner::default();
                    }
                    continue;
                }
                seen.insert(
                    port,
                    Server::listener(
                        port,
                        process_name.clone(),
                        pid,
                        owner.cloned().unwrap_or_default(),
                    ),
                );
            }
            _ => {}
        }
    }
    seen.into_values().collect()
}

/// `lsofProcessIds`: processes holding a loopback or wildcard listener.
pub fn lsof_process_ids(raw: &str) -> Vec<i64> {
    let mut pids: Vec<i64> = Vec::new();
    let mut pid: Option<i64> = None;
    for line in raw.split('\n') {
        if let Some(value) = line.strip_prefix('p') {
            pid = lsof_pid(value);
        } else if let (Some(name), Some(p)) = (line.strip_prefix('n'), pid)
            && lsof_port(name).is_some()
            && !pids.contains(&p)
        {
            pids.push(p);
        }
    }
    pids
}

/// `procLocalAddress`: each 32-bit word of the hex address is little-endian.
pub fn proc_local_address(hex: &str) -> bool {
    match hex.len() {
        8 => hex == "00000000" || hex == "0100007F",
        32 => {
            hex.bytes().all(|b| b == b'0')
                || hex == format!("{}01000000", "0".repeat(24))
                || (hex.starts_with(&format!("{}FFFF0000", "0".repeat(16)))
                    && hex.get(24..).is_some_and(proc_local_address))
        }
        _ => false,
    }
}

/// `parseProcNetTcp`: loopback or wildcard listeners, as (port, socket inode).
pub fn parse_proc_net_tcp(raw: &str) -> Vec<(u16, String)> {
    let mut listeners = Vec::new();
    for line in raw.split('\n').skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let mut local = fields.get(1).map(|f| f.split(':')).into_iter().flatten();
        let (Some(address), Some(port_hex)) = (local.next(), local.next()) else {
            continue;
        };
        if fields.get(3) != Some(&PROC_TCP_LISTEN) || address.is_empty() || port_hex.is_empty() {
            continue;
        }
        if !proc_local_address(&address.to_uppercase()) {
            continue;
        }
        // `Number.parseInt(portHex, 16)`: the leading hex digits.
        let end = port_hex
            .find(|c: char| !c.is_ascii_hexdigit())
            .unwrap_or(port_hex.len());
        let Some(port) = port_hex
            .get(..end)
            .and_then(|h| u32::from_str_radix(h, 16).ok())
            .and_then(|p| u16::try_from(p).ok())
            .filter(|p| *p > 0)
        else {
            continue;
        };
        let Some(inode) = fields.get(9).filter(|i| !i.is_empty()) else {
            continue;
        };
        listeners.push((port, (*inode).to_owned()));
    }
    listeners
}

/// `parseProcEnvironThread`.
pub fn parse_proc_environ_thread(raw: &str) -> Option<String> {
    let prefix = format!("{AGENT_THREAD_ENV}=");
    raw.split('\0')
        .find_map(|entry| entry.strip_prefix(&prefix))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

/// `parseProcStatParent`: the field after the command, which can hold spaces.
pub fn parse_proc_stat_parent(raw: &str) -> Option<i64> {
    let after = raw.get(raw.rfind(')').map_or(0, |i| i + 1)..)?;
    let parent = after.trim().split(' ').nth(1)?;
    // `Number(...)`: the whole field must be a number; an empty one is 0.
    if parent.is_empty() {
        return Some(0);
    }
    parent.parse::<i64>().ok()
}

/// A listener started with an agent's thread in its environment (`AgentListener`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentListener {
    pub thread_id: String,
    /// The agent CLI itself (a direct child of this server): its ports are not servers it
    /// started.
    pub is_agent_cli: bool,
}

/// `AGENT_THREAD_ASSIGNMENT`: `(?:^|\s)T3CODE_THREAD_ID=(\S+)`.
fn agent_thread_assignment(text: &str) -> Option<&str> {
    let needle = format!("{AGENT_THREAD_ENV}=");
    let mut from = 0;
    while let Some(found) = text.get(from..).and_then(|rest| rest.find(&needle)) {
        let at = from + found;
        let before = text.get(..at).and_then(|b| b.chars().next_back());
        if before.is_none_or(char::is_whitespace) {
            let value = text.get(at + needle.len()..).unwrap_or_default();
            let end = value.find(char::is_whitespace).unwrap_or(value.len());
            if end > 0 {
                return value.get(..end);
            }
        }
        from = at + needle.len();
    }
    None
}

/// `parsePsEnvironmentThreads` of `ps -E -ww -o pid=,ppid=,command=`.
pub fn parse_ps_environment_threads(
    raw: &str,
    server_pid: i64,
) -> HashMap<i64, Option<AgentListener>> {
    let mut threads = HashMap::new();
    for line in raw.split('\n') {
        // `^\s*(\d+)\s+(\d+)\s(.*)$`
        let rest = line.trim_start();
        let pid_end = rest
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(rest.len());
        let Some(pid) = rest.get(..pid_end).filter(|d| !d.is_empty()) else {
            continue;
        };
        let rest = rest.get(pid_end..).unwrap_or_default();
        let trimmed = rest.trim_start();
        if trimmed.len() == rest.len() {
            continue;
        }
        let ppid_end = trimmed
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(trimmed.len());
        let Some(ppid) = trimmed.get(..ppid_end).filter(|d| !d.is_empty()) else {
            continue;
        };
        let Some(command) = trimmed
            .get(ppid_end..)
            .and_then(|c| c.strip_prefix(char::is_whitespace))
        else {
            continue;
        };
        let (Ok(pid), Ok(ppid)) = (pid.parse::<i64>(), ppid.parse::<i64>()) else {
            continue;
        };
        threads.insert(
            pid,
            agent_thread_assignment(command).map(|thread| AgentListener {
                thread_id: thread.to_owned(),
                is_agent_cli: ppid == server_pid,
            }),
        );
    }
    threads
}

/// One row of `ps -A -o pid=,ppid=,pgid=`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Row {
    pub pid: i64,
    pub ppid: i64,
    pub pgid: i64,
}

/// `parseProcessTable`.
pub fn parse_process_table(raw: &str) -> BTreeMap<i64, Row> {
    let mut rows = BTreeMap::new();
    for line in raw.split('\n') {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let number = |i: usize| fields.get(i).and_then(|f| f.parse::<i64>().ok());
        if let (Some(pid), Some(ppid), Some(pgid)) = (number(0), number(1), number(2)) {
            rows.insert(pid, Row { pid, ppid, pgid });
        }
    }
    rows
}

/// `stoppableProcessGroup`: the group a stop signals, or `None` when it also holds this
/// server, one of its ancestors, or a direct child (agent CLIs and terminal shells).
pub fn stoppable_process_group(
    table: &BTreeMap<i64, Row>,
    pid: i64,
    server_pid: i64,
) -> Option<i64> {
    let group = table.get(&pid)?.pgid;
    if group <= 1 {
        return None;
    }
    let mut guarded: HashSet<i64> = HashSet::from([server_pid]);
    let mut parent = table.get(&server_pid).map(|r| r.ppid);
    while let Some(p) = parent.filter(|p| *p > 1 && !guarded.contains(p)) {
        guarded.insert(p);
        parent = table.get(&p).map(|r| r.ppid);
    }
    if table
        .values()
        .any(|row| row.pgid == group && (guarded.contains(&row.pid) || row.ppid == server_pid))
    {
        return None;
    }
    Some(group)
}

/// `normalizeConfiguredUrls`: at most 32 loopback http(s) URLs, `0.0.0.0` as `localhost`,
/// each once.
pub fn normalize_configured_urls(urls: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in urls.iter().take(CONFIGURED_MAX_ITEMS) {
        if raw.encode_utf16().count() > URL_MAX_LENGTH {
            continue;
        }
        let Ok(mut url) = url::Url::parse(raw) else {
            continue;
        };
        if !matches!(url.scheme(), "http" | "https") {
            continue;
        }
        if !url.host_str().is_some_and(is_loopback_host) {
            continue;
        }
        if url.host_str() == Some("0.0.0.0") && url.set_host(Some("localhost")).is_err() {
            continue;
        }
        let href = url.to_string();
        if href.encode_utf16().count() <= URL_MAX_LENGTH && !out.contains(&href) {
            out.push(href);
        }
    }
    out
}

/// `localServerKey`.
pub fn server_key(host: &str, port: u16) -> String {
    if is_loopback_host(host) {
        format!("loopback:{port}")
    } else {
        format!("{}:{port}", host.to_lowercase())
    }
}

/// `urlPort`.
pub fn url_port(url: &url::Url) -> u16 {
    url.port()
        .unwrap_or(if url.scheme() == "http" { 80 } else { 443 })
}

/// `webProbeCacheKey`: the URL without its fragment.
pub fn probe_key(raw: &str) -> String {
    url::Url::parse(raw).map_or_else(
        |_| raw.to_owned(),
        |mut url| {
            url.set_fragment(None);
            url.to_string()
        },
    )
}

/// `WebProbeSnapshot`: the owned listeners, and the configured URLs that answered as web
/// pages, by their probe key.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub discovered: Vec<Server>,
    pub configured: HashMap<String, Server>,
}

/// `projectWebProbeSnapshot`: what one subscriber sees for its configured URLs.
pub fn project(snapshot: &Snapshot, configured_urls: &[String]) -> Vec<Server> {
    let mut visible: Vec<(String, Server)> = Vec::new();
    let mut first_configured: HashMap<String, String> = HashMap::new();
    for raw in normalize_configured_urls(configured_urls) {
        let Ok(url) = url::Url::parse(&raw) else {
            continue;
        };
        let key = server_key(url.host_str().unwrap_or_default(), url_port(&url));
        first_configured
            .entry(key.clone())
            .or_insert_with(|| raw.clone());
        if visible.iter().any(|(k, _)| *k == key) {
            continue;
        }
        if let Some(server) = snapshot.configured.get(&probe_key(&raw)) {
            visible.push((
                key,
                Server {
                    url: raw.clone(),
                    ..server.clone()
                },
            ));
        }
    }
    for server in &snapshot.discovered {
        let key = server_key(&server.host, server.port);
        if visible.iter().any(|(k, _)| *k == key) {
            continue;
        }
        let shown = match first_configured.get(&key) {
            Some(url) => Server {
                url: url.clone(),
                ..server.clone()
            },
            None => server.clone(),
        };
        visible.push((key, shown));
    }
    let mut servers: Vec<Server> = visible.into_iter().map(|(_, s)| s).collect();
    servers.sort_by_key(|s| s.port);
    servers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lsof_listeners_and_owners() {
        let raw = "p100\ncnode\nn*:3000\nn127.0.0.1:3000\np200\ncvite\nn[::1]:5173\nn10.0.0.1:9\np300\nn*:3000\n";
        let owners = HashMap::from([(
            100,
            Owner {
                terminal: None,
                agent: Some("t".into()),
            },
        )]);
        let servers = parse_lsof(raw, &owners);
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].port, 3000);
        assert_eq!(servers[0].pid, Some(100));
        assert!(
            !servers[0].is_owned(),
            "a second, unowned process on the port clears the owner"
        );
        assert_eq!(servers[1].process_name.as_deref(), Some("vite"));
        assert_eq!(lsof_process_ids(raw), [100, 200, 300]);
    }

    #[test]
    fn proc_tables_read_loopback_listeners() {
        let raw = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1\n   1: 0200007F:0BB9 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2 1\n   2: 00000000:0050 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 3 1\n";
        assert_eq!(parse_proc_net_tcp(raw), [(3000, "12345".to_owned())]);
        assert!(proc_local_address("0000000000000000FFFF00000100007F"));
        assert!(proc_local_address("00000000000000000000000001000000"));
    }

    #[test]
    fn stop_never_signals_this_server_or_its_children() {
        let table = parse_process_table(
            "1 0 1\n10 1 10\n20 10 20\n25 20 25\n30 25 30\n31 30 30\n40 20 40\n",
        );
        assert_eq!(stoppable_process_group(&table, 31, 20), Some(30));
        assert_eq!(
            stoppable_process_group(&table, 40, 20),
            None,
            "a direct child of the server"
        );
        assert_eq!(stoppable_process_group(&table, 10, 20), None, "an ancestor");
        assert_eq!(stoppable_process_group(&table, 99, 20), None);
    }

    #[test]
    fn ps_environments_name_agent_threads() {
        let raw = "  12 1 node server.js T3CODE_THREAD_ID=thread-a HOME=/x\n13 99 codex T3CODE_THREAD_ID=thread-b\n14 1 sh -c XT3CODE_THREAD_ID=no\n";
        let threads = parse_ps_environment_threads(raw, 99);
        assert_eq!(
            threads[&12],
            Some(AgentListener {
                thread_id: "thread-a".into(),
                is_agent_cli: false
            })
        );
        assert_eq!(threads[&13].as_ref().map(|a| a.is_agent_cli), Some(true));
        assert_eq!(threads[&14], None);
        assert_eq!(parse_proc_stat_parent("7 (a) b) S 42 7"), Some(42));
    }

    #[test]
    fn configured_urls_are_loopback_and_unique() {
        let urls: Vec<String> = [
            "http://0.0.0.0:3000",
            "http://localhost:3000/",
            "https://example.com",
            "ftp://localhost",
            "http://[::1]:8080/a#x",
        ]
        .map(str::to_owned)
        .to_vec();
        assert_eq!(
            normalize_configured_urls(&urls),
            ["http://localhost:3000/", "http://[::1]:8080/a#x"]
        );
    }
}
