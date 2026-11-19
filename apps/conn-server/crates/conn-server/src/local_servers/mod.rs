//! Local servers for previews, as T3's `PortDiscovery` (`apps/server/src/preview/
//! PortScanner.ts`) finds and stops them: the loopback listeners a thread's terminal or agent
//! started, plus the configured preview URLs that answer as web pages. A client subscribes
//! (`subscribeDiscoveredLocalServers`); while one does and a client is in the foreground, the
//! scan runs every 3 seconds and each subscriber gets its list when it changes.
//! `preview.stopLocalServer` stops a listed server's process group, never this server, an agent
//! CLI or a shell.
//!
//! Listeners: `/proc/net/tcp{,6}` and a bounded fd walk on Linux, else `lsof`. Owners: a
//! terminal's process tree while it runs a command (T3 registers it from its subprocess poll;
//! here it is read from the process table at the scan), or `T3CODE_THREAD_ID` in the
//! listener's launch environment (`/proc/<pid>/environ`, or `ps -E` on macOS). Only owned
//! listeners are listed without a request; configured URLs get one GET without redirects.
//! Windows is not served. `T3CODE_PORT_DISCOVERY=0` turns listener discovery off.

pub mod parse;

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

pub use parse::{AGENT_THREAD_ENV, Owner, Server, Snapshot};
use parse::{AgentListener, Row};

const POLL_INTERVAL: Duration = Duration::from_secs(3);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const LSOF_MAX_OUTPUT: usize = 1024 * 1024;
const PS_MAX_OUTPUT: usize = 8 * 1024 * 1024;
const PROC_FD_WALK_LIMIT: usize = 50_000;
const SOCKET_OWNER_ATTEMPTS: u32 = 3;
const WEB_PROBE_TIMEOUT: Duration = Duration::from_secs(1);
const WEB_PROBE_CACHE_TTL: Duration = Duration::from_secs(15);
const STOP_GRACE: Duration = Duration::from_secs(3);
const STOP_POLL_INTERVAL: Duration = Duration::from_millis(250);
/// Subscribers kept at once; a client holds one per open Servers panel.
const MAX_SUBSCRIBERS: usize = 64;

/// `PreviewStopLocalServerError.reason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopError {
    NotFound,
    SharedGroup,
    Unsupported,
    SignalFailed,
}

impl StopError {
    pub fn reason(self) -> &'static str {
        match self {
            Self::NotFound => "not-found",
            Self::SharedGroup => "shared-group",
            Self::Unsupported => "unsupported",
            Self::SignalFailed => "signal-failed",
        }
    }
}

/// The running terminals' shells: (thread, terminal, shell pid). A shell with no child owns
/// nothing ([`descendants`]).
pub type TerminalShells = Arc<dyn Fn() -> Vec<(String, String, i64)> + Send + Sync>;
/// Whether a client is in the foreground (`shouldRunOpportunisticWork`).
pub type Foreground = Arc<dyn Fn() -> bool + Send + Sync>;

struct Subscriber {
    id: u64,
    configured: Vec<String>,
    last: Vec<Server>,
    /// The latest list: a subscriber that falls behind gets the newest one, never a stale one.
    tx: tokio::sync::watch::Sender<Vec<Server>>,
}

struct ProbeEntry {
    pid: Option<i64>,
    is_web: bool,
    expires: Instant,
}

#[derive(Default)]
struct Caches {
    probes: HashMap<String, ProbeEntry>,
    socket_owners: HashMap<String, (i64, Option<String>)>,
    socket_misses: HashMap<String, u32>,
    /// Each current listener pid's agent thread, or `None` without one; read once per pid.
    agent_threads: HashMap<i64, Option<AgentListener>>,
    lsof_missing: bool,
}

struct Inner {
    terminals: TerminalShells,
    foreground: Foreground,
    discovery: bool,
    server_pid: i64,
    subscribers: Mutex<Vec<Subscriber>>,
    retained: AtomicU64,
    /// Subscriptions still taking their first scan.
    pending: std::sync::atomic::AtomicUsize,
    next_id: AtomicU64,
    polling: AtomicBool,
    caches: Mutex<Caches>,
    scan: tokio::sync::Mutex<()>,
}

/// The port scanner. Cheap to clone.
#[derive(Clone)]
pub struct LocalServers(Arc<Inner>);

impl std::fmt::Debug for LocalServers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalServers").finish_non_exhaustive()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Runs a command with a deadline and an output cap; `None` when it could not run or finish.
async fn run(program: &str, args: &[String], max: usize) -> Result<(i32, String), RunError> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .envs(conn_support::login_env::vars());
    conn_support::spawn_guard::check(command.as_std());
    let child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            RunError::NotFound
        } else {
            RunError::Failed
        }
    })?;
    let output = tokio::time::timeout(COMMAND_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| RunError::Failed)?
        .map_err(|_| RunError::Failed)?;
    if output.stdout.len() > max {
        return Err(RunError::Failed);
    }
    Ok((
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).into_owned(),
    ))
}

#[derive(Debug, PartialEq, Eq)]
enum RunError {
    NotFound,
    Failed,
}

impl LocalServers {
    pub fn new(terminals: TerminalShells, foreground: Foreground) -> Self {
        let discovery = std::env::var("T3CODE_PORT_DISCOVERY").as_deref() != Ok("0");
        Self(Arc::new(Inner {
            terminals,
            foreground,
            discovery,
            server_pid: i64::from(std::process::id()),
            subscribers: Mutex::new(Vec::new()),
            retained: AtomicU64::new(0),
            pending: std::sync::atomic::AtomicUsize::new(0),
            next_id: AtomicU64::new(1),
            polling: AtomicBool::new(false),
            caches: Mutex::new(Caches::default()),
            scan: tokio::sync::Mutex::new(()),
        }))
    }

    /// `subscribeDiscoveredLocalServers`: the first list at once, then each change. The
    /// subscription runs in its own task, so a caller that goes away mid-scan still releases
    /// what it retained.
    pub async fn subscribe(
        &self,
        configured: Vec<String>,
    ) -> Result<mpsc::Receiver<Value>, String> {
        let configured = parse::normalize_configured_urls(&configured);
        {
            // Counted with the ones still scanning, under one lock, so the cap holds.
            let subscribers = lock(&self.0.subscribers);
            if subscribers.len() + self.0.pending.load(Ordering::SeqCst) >= MAX_SUBSCRIBERS {
                return Err("Too many local server subscriptions.".into());
            }
            self.0.pending.fetch_add(1, Ordering::SeqCst);
        }
        let (out, rx) = mpsc::channel::<Value>(4);
        let scanner = self.clone();
        tokio::spawn(async move {
            let was_idle = scanner.retain_now();
            let setup = async {
                if was_idle {
                    scanner.poll_tick().await;
                }
                parse::project(&scanner.scan_snapshot(&configured).await, &configured)
            };
            // T3 runs the first scan in the stream's scope: a client that leaves stops it, and
            // its slot and retention come back at once.
            let initial = tokio::select! {
                () = out.closed() => None,
                initial = setup => Some(initial),
            };
            let Some(initial) = initial else {
                scanner.0.pending.fetch_sub(1, Ordering::SeqCst);
                scanner.release().await;
                return;
            };
            let (tx, mut changes) = tokio::sync::watch::channel(initial.clone());
            let id = scanner.0.next_id.fetch_add(1, Ordering::Relaxed);
            {
                let mut subscribers = lock(&scanner.0.subscribers);
                subscribers.push(Subscriber {
                    id,
                    configured,
                    last: initial.clone(),
                    tx,
                });
                scanner.0.pending.fetch_sub(1, Ordering::SeqCst);
            }
            if out.send(list_json(&initial)).await.is_ok() {
                loop {
                    tokio::select! {
                        () = out.closed() => break,
                        changed = changes.changed() => {
                            if changed.is_err() {
                                break;
                            }
                            let servers = changes.borrow_and_update().clone();
                            if out.send(list_json(&servers)).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            }
            lock(&scanner.0.subscribers).retain(|s| s.id != id);
            scanner.release().await;
        });
        Ok(rx)
    }

    /// Counts one more retainer and starts the poller; `true` when nobody retained before (T3
    /// then runs one poll at once). Synchronous, so a cancelled caller always knows to release.
    fn retain_now(&self) -> bool {
        let was_idle = self.0.retained.fetch_add(1, Ordering::SeqCst) == 0;
        if !self.0.polling.swap(true, Ordering::SeqCst) {
            let scanner = self.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(POLL_INTERVAL).await;
                    if scanner.0.retained.load(Ordering::SeqCst) == 0 {
                        scanner.0.polling.store(false, Ordering::SeqCst);
                        // A retain that came in after the check restarts the loop itself.
                        if scanner.0.retained.load(Ordering::SeqCst) == 0
                            || scanner.0.polling.swap(true, Ordering::SeqCst)
                        {
                            break;
                        }
                    }
                    if (scanner.0.foreground)() {
                        scanner.poll_tick().await;
                    }
                }
            });
        }
        was_idle
    }

    async fn release(&self) {
        let left = self
            .0
            .retained
            .fetch_sub(1, Ordering::SeqCst)
            .saturating_sub(1);
        if left > 0 {
            return;
        }
        // Unscanned pids can be reused, so the per-pid caches go while nobody looks.
        let _scan = self.0.scan.lock().await;
        let mut caches = lock(&self.0.caches);
        caches.socket_owners.clear();
        caches.socket_misses.clear();
        caches.agent_threads.clear();
    }

    /// `pollTick`: one scan for every subscriber's URLs; each gets its list when it changed.
    async fn poll_tick(&self) {
        let configured: Vec<String> = {
            let subscribers = lock(&self.0.subscribers);
            let mut all: Vec<String> = Vec::new();
            for url in subscribers.iter().flat_map(|s| s.configured.iter()) {
                if !all.contains(url) {
                    all.push(url.clone());
                }
            }
            all
        };
        let snapshot = self.scan_snapshot(&configured).await;
        let mut subscribers = lock(&self.0.subscribers);
        for s in subscribers.iter_mut() {
            let next = parse::project(&snapshot, &s.configured);
            if next != s.last {
                s.last.clone_from(&next);
                s.tx.send_replace(next);
            }
        }
    }

    async fn poll_if_retained(&self) {
        if self.0.retained.load(Ordering::SeqCst) > 0 {
            self.poll_tick().await;
        }
    }

    /// `scan` with the configured URLs normalized and projected.
    pub async fn scan(&self, configured: &[String]) -> Vec<Server> {
        let configured = parse::normalize_configured_urls(configured);
        parse::project(&self.scan_snapshot(&configured).await, &configured)
    }

    async fn scan_snapshot(&self, configured: &[String]) -> Snapshot {
        let _scan = self.0.scan.lock().await;
        self.scan_unlocked(configured).await
    }

    async fn scan_unlocked(&self, configured: &[String]) -> Snapshot {
        if !self.0.discovery || cfg!(windows) {
            return self.probe_web(Vec::new(), configured).await;
        }
        let shells = (self.0.terminals)();
        let table = if shells.is_empty() {
            BTreeMap::new()
        } else {
            process_table().await.unwrap_or_default()
        };
        let mut terminal_owners: HashMap<i64, Owner> = HashMap::new();
        for (thread, terminal, shell) in shells {
            for pid in descendants(&table, shell) {
                terminal_owners.insert(
                    pid,
                    Owner {
                        terminal: Some((thread.clone(), terminal.clone())),
                        agent: None,
                    },
                );
            }
        }
        let listeners = if cfg!(target_os = "linux") {
            match self.proc_listeners(&terminal_owners).await {
                Some(listeners) => Some(listeners),
                None => self.lsof_listeners(&terminal_owners).await,
            }
        } else {
            self.lsof_listeners(&terminal_owners).await
        };
        let listeners = match listeners {
            Some(listeners) => listeners,
            None if lock(&self.0.caches).lsof_missing && cfg!(target_os = "linux") => self
                .proc_listeners(&terminal_owners)
                .await
                .unwrap_or_default(),
            None => Vec::new(),
        };
        self.probe_web(listeners, configured).await
    }

    async fn lsof_listeners(&self, terminal_owners: &HashMap<i64, Owner>) -> Option<Vec<Server>> {
        if lock(&self.0.caches).lsof_missing {
            return None;
        }
        let args: Vec<String> = ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"]
            .map(str::to_owned)
            .to_vec();
        match run("lsof", &args, LSOF_MAX_OUTPUT).await {
            Ok((_, stdout)) => {
                let owners = self
                    .with_agent_owners(terminal_owners, &parse::lsof_process_ids(&stdout))
                    .await;
                Some(parse::parse_lsof(&stdout, &owners))
            }
            Err(RunError::NotFound) => {
                lock(&self.0.caches).lsof_missing = true;
                None
            }
            Err(RunError::Failed) => None,
        }
    }

    /// `withAgentOwners`: listeners with an agent's thread in their environment, apart from the
    /// agent CLIs themselves.
    async fn with_agent_owners(
        &self,
        terminal_owners: &HashMap<i64, Owner>,
        pids: &[i64],
    ) -> HashMap<i64, Owner> {
        let wanted: Vec<i64> = pids
            .iter()
            .copied()
            .filter(|pid| !terminal_owners.contains_key(pid))
            .collect();
        let unread: Vec<i64> = {
            let caches = lock(&self.0.caches);
            wanted
                .iter()
                .copied()
                .filter(|pid| !caches.agent_threads.contains_key(pid))
                .collect()
        };
        let read = if unread.is_empty() {
            HashMap::new()
        } else {
            read_agent_threads(&unread, self.0.server_pid).await
        };
        let mut owners = terminal_owners.clone();
        let mut caches = lock(&self.0.caches);
        let mut next = HashMap::new();
        for pid in wanted {
            let listener = caches
                .agent_threads
                .get(&pid)
                .cloned()
                .or_else(|| read.get(&pid).cloned());
            if let Some(listener) = listener {
                if let Some(agent) = &listener
                    && !agent.is_agent_cli
                {
                    owners.insert(
                        pid,
                        Owner {
                            terminal: None,
                            agent: Some(agent.thread_id.clone()),
                        },
                    );
                }
                next.insert(pid, listener);
            }
        }
        caches.agent_threads = next;
        owners
    }

    /// `scanProcListeners`: `None` when the tables or the owners cannot be read.
    async fn proc_listeners(&self, terminal_owners: &HashMap<i64, Owner>) -> Option<Vec<Server>> {
        let tables = tokio::task::spawn_blocking(|| {
            let mut readable = Vec::new();
            for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
                match std::fs::read_to_string(path) {
                    Ok(text) => readable.push(text),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return None,
                }
            }
            Some(readable)
        })
        .await
        .ok()??;
        let header = |t: &str| {
            let fields: Vec<&str> = t.split_whitespace().take(4).collect();
            matches!(
                fields.as_slice(),
                [
                    "sl",
                    "local_address",
                    "rem_address" | "remote_address",
                    "st"
                ]
            )
        };
        if tables.is_empty() || !tables.iter().all(|t| header(t)) {
            return None;
        }
        let listeners: Vec<(u16, String)> = tables
            .iter()
            .flat_map(|t| parse::parse_proc_net_tcp(t))
            .collect();
        let inodes: HashSet<String> = listeners.iter().map(|(_, i)| i.clone()).collect();
        let unseen: HashSet<String> = {
            let caches = lock(&self.0.caches);
            inodes
                .iter()
                .filter(|i| {
                    !caches.socket_owners.contains_key(*i)
                        && caches.socket_misses.get(*i).copied().unwrap_or(0)
                            < SOCKET_OWNER_ATTEMPTS
                })
                .cloned()
                .collect()
        };
        let lsof_missing = lock(&self.0.caches).lsof_missing;
        let found = if unseen.is_empty() {
            HashMap::new()
        } else {
            let wanted = unseen.clone();
            tokio::task::spawn_blocking(move || find_socket_owners(&wanted, lsof_missing))
                .await
                .ok()??
        };
        let owners: HashMap<String, (i64, Option<String>)> = {
            let mut caches = lock(&self.0.caches);
            let mut owners: HashMap<String, (i64, Option<String>)> = caches
                .socket_owners
                .drain()
                .chain(found.clone())
                .filter(|(inode, _)| inodes.contains(inode))
                .collect();
            let mut misses: HashMap<String, u32> = caches
                .socket_misses
                .drain()
                .filter(|(inode, _)| inodes.contains(inode))
                .collect();
            for inode in &unseen {
                if !found.contains_key(inode) {
                    *misses.entry(inode.clone()).or_insert(0) += 1;
                }
            }
            caches.socket_owners.clone_from(&owners);
            caches.socket_misses = misses;
            owners.shrink_to_fit();
            owners
        };
        let mut pids: Vec<i64> = owners.values().map(|(pid, _)| *pid).collect();
        pids.sort_unstable();
        pids.dedup();
        let server_owners = self.with_agent_owners(terminal_owners, &pids).await;
        let mut seen: BTreeMap<u16, Server> = BTreeMap::new();
        for (port, inode) in listeners {
            let socket_owner = owners.get(&inode);
            let owner = socket_owner.and_then(|(pid, _)| server_owners.get(pid));
            if let Some(existing) = seen.get_mut(&port)
                && (existing.pid.is_some() || socket_owner.is_none())
            {
                if owner.is_none() {
                    existing.owner = Owner::default();
                }
                continue;
            }
            let existed = seen.contains_key(&port);
            seen.insert(
                port,
                Server::listener(
                    port,
                    socket_owner.and_then(|(_, name)| name.clone()),
                    socket_owner.map(|(pid, _)| *pid),
                    if existed {
                        Owner::default()
                    } else {
                        owner.cloned().unwrap_or_default()
                    },
                ),
            );
        }
        Some(seen.into_values().collect())
    }

    /// `probeWebServers`: only configured URLs get a request; owned listeners are listed
    /// without one.
    async fn probe_web(&self, servers: Vec<Server>, configured: &[String]) -> Snapshot {
        let now = Instant::now();
        let by_key: HashMap<String, &Server> = servers
            .iter()
            .map(|s| (parse::server_key(&s.host, s.port), s))
            .collect();
        let mut groups: Vec<(Server, String, String)> = Vec::new();
        for raw in configured {
            let Ok(url) = url::Url::parse(raw) else {
                continue;
            };
            let port = parse::url_port(&url);
            let key = parse::server_key(url.host_str().unwrap_or_default(), port);
            let resource = parse::probe_key(raw);
            if groups.iter().any(|(_, _, r)| *r == resource) {
                continue;
            }
            let server = by_key.get(&key).map_or_else(
                || Server {
                    host: url.host_str().unwrap_or_default().to_owned(),
                    port,
                    url: raw.clone(),
                    process_name: None,
                    pid: None,
                    owner: Owner::default(),
                    has_agent_field: false,
                },
                |s| (*s).clone(),
            );
            groups.push((server, raw.clone(), resource));
        }
        let cached: HashMap<String, (Option<i64>, bool, Instant)> = lock(&self.0.caches)
            .probes
            .iter()
            .map(|(k, e)| (k.clone(), (e.pid, e.is_web, e.expires)))
            .collect();
        let mut fresh: Vec<(usize, bool)> = Vec::new();
        let mut probes = Vec::new();
        for (index, (server, url, resource)) in groups.iter().enumerate() {
            match cached.get(resource) {
                Some((pid, _, expires)) if *pid == server.pid && *expires > now => {}
                _ => probes.push((index, url.clone())),
            }
        }
        // `WEB_PROBE_CONCURRENCY` is 16; at most 32 URLs, so two rounds.
        for chunk in probes.chunks(16) {
            let results = futures_util::future::join_all(
                chunk
                    .iter()
                    .map(|(index, url)| async move { (*index, probe_web_url(url).await) }),
            )
            .await;
            fresh.extend(results);
        }
        let completed = Instant::now();
        let mut snapshot = Snapshot {
            discovered: servers.iter().filter(|s| s.is_owned()).cloned().collect(),
            configured: HashMap::new(),
        };
        let mut caches = lock(&self.0.caches);
        caches.probes.retain(|_, e| e.expires > completed);
        for (index, (server, url, resource)) in groups.into_iter().enumerate() {
            let is_web = match fresh.iter().find(|(i, _)| *i == index) {
                Some((_, is_web)) => {
                    caches.probes.insert(
                        resource.clone(),
                        ProbeEntry {
                            pid: server.pid,
                            is_web: *is_web,
                            expires: completed + WEB_PROBE_CACHE_TTL,
                        },
                    );
                    *is_web
                }
                None => cached.get(&resource).is_some_and(|(_, w, _)| *w),
            };
            if is_web {
                snapshot
                    .configured
                    .insert(resource, Server { url, ..server });
            }
        }
        snapshot
    }

    /// `preview.stopLocalServer`: only a server this scan lists as a thread's.
    pub async fn stop(&self, pid: i64, port: i64) -> Result<(), StopError> {
        if cfg!(windows) {
            return Err(StopError::Unsupported);
        }
        {
            // A socket can outlive its cached owner: confirm it with a fresh read.
            let _scan = self.0.scan.lock().await;
            let mut caches = lock(&self.0.caches);
            caches.socket_owners.retain(|_, (owner, _)| *owner != pid);
            caches.agent_threads.remove(&pid);
        }
        let listed = self
            .scan(&[])
            .await
            .iter()
            .any(|s| s.pid == Some(pid) && i64::from(s.port) == port && s.is_owned());
        if !listed {
            return Err(StopError::NotFound);
        }
        let table = process_table().await.ok_or(StopError::SignalFailed)?;
        if !table.contains_key(&pid) {
            return Ok(());
        }
        let group = parse::stoppable_process_group(&table, pid, self.0.server_pid)
            .ok_or(StopError::SharedGroup)?;
        if !signal_group(group, rustix::process::Signal::TERM)? {
            return Ok(());
        }
        let members: Vec<i64> = table
            .values()
            .filter(|r| r.pgid == group)
            .map(|r| r.pid)
            .collect();
        let deadline = Instant::now() + STOP_GRACE;
        let mut stopped = false;
        while Instant::now() < deadline {
            tokio::time::sleep(STOP_POLL_INTERVAL).await;
            let running = process_table().await.is_some_and(|current| {
                members
                    .iter()
                    .any(|m| current.get(m).is_some_and(|r| r.pgid == group))
            });
            if !running {
                stopped = true;
                break;
            }
        }
        if !stopped {
            signal_group(group, rustix::process::Signal::KILL)?;
        }
        // Subscribers see the server leave now rather than on the next poll.
        self.poll_if_retained().await;
        Ok(())
    }
}

/// `true` when the group got the signal, `false` when it had already exited.
fn signal_group(group: i64, signal: rustix::process::Signal) -> Result<bool, StopError> {
    let pid = i32::try_from(group)
        .ok()
        .filter(|g| *g > 1)
        .and_then(rustix::process::Pid::from_raw)
        .ok_or(StopError::SignalFailed)?;
    match rustix::process::kill_process_group(pid, signal) {
        Ok(()) => Ok(true),
        Err(rustix::io::Errno::SRCH) => Ok(false),
        Err(_) => Err(StopError::SignalFailed),
    }
}

/// `ps -A -o pid=,ppid=,pgid=`; `None` when `ps` fails, so an empty table never reads as every
/// process having exited.
async fn process_table() -> Option<BTreeMap<i64, Row>> {
    let args: Vec<String> = ["-A", "-o", "pid=,ppid=,pgid="].map(str::to_owned).to_vec();
    match run("ps", &args, PS_MAX_OUTPUT).await {
        Ok((0, stdout)) => Some(parse::parse_process_table(&stdout)),
        _ => None,
    }
}

/// A shell and every process below it (T3's terminal `processIds`), when it runs a command.
fn descendants(table: &BTreeMap<i64, Row>, root: i64) -> Vec<i64> {
    let mut children: HashMap<i64, Vec<i64>> = HashMap::new();
    for row in table.values() {
        children.entry(row.ppid).or_default().push(row.pid);
    }
    if children.get(&root).is_none_or(Vec::is_empty) {
        return Vec::new();
    }
    let mut out = vec![root];
    let mut pending = vec![root];
    while let Some(parent) = pending.pop() {
        for child in children.get(&parent).map(Vec::as_slice).unwrap_or_default() {
            if !out.contains(child) {
                out.push(*child);
                pending.push(*child);
            }
        }
    }
    out
}

/// `readAgentThreads` for pids not read yet.
async fn read_agent_threads(pids: &[i64], server_pid: i64) -> HashMap<i64, Option<AgentListener>> {
    if cfg!(target_os = "linux") {
        let pids = pids.to_vec();
        return tokio::task::spawn_blocking(move || {
            pids.into_iter()
                .map(|pid| {
                    let thread =
                        std::fs::read(format!("/proc/{pid}/environ"))
                            .ok()
                            .and_then(|raw| {
                                parse::parse_proc_environ_thread(&String::from_utf8_lossy(&raw))
                            });
                    let listener = thread.map(|thread_id| {
                        let parent = std::fs::read_to_string(format!("/proc/{pid}/stat"))
                            .ok()
                            .and_then(|s| parse::parse_proc_stat_parent(&s));
                        AgentListener {
                            thread_id,
                            is_agent_cli: parent == Some(server_pid),
                        }
                    });
                    (pid, listener)
                })
                .collect()
        })
        .await
        .unwrap_or_default();
    }
    let list = pids
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let args: Vec<String> = ["-E", "-ww", "-o", "pid=,ppid=,command=", "-p", &list]
        .map(str::to_owned)
        .to_vec();
    match run("ps", &args, PS_MAX_OUTPUT).await {
        Ok((_, stdout)) => parse::parse_ps_environment_threads(&stdout, server_pid),
        Err(_) => HashMap::new(),
    }
}

/// `findSocketOwners`: walks `/proc/<pid>/fd` for the sockets, at most 50,000 links.
fn find_socket_owners(
    inodes: &HashSet<String>,
    lsof_missing: bool,
) -> Option<HashMap<String, (i64, Option<String>)>> {
    let mut owners: HashMap<String, (i64, Option<String>)> = HashMap::new();
    let entries = std::fs::read_dir("/proc").ok()?;
    let mut budget = PROC_FD_WALK_LIMIT;
    for entry in entries.flatten() {
        if owners.len() == inodes.len() || budget == 0 {
            break;
        }
        let name = entry.file_name();
        let Some(pid_text) = name
            .to_str()
            .filter(|n| n.bytes().all(|b| b.is_ascii_digit()))
        else {
            continue;
        };
        let Ok(fds) = std::fs::read_dir(Path::new("/proc").join(pid_text).join("fd")) else {
            continue;
        };
        let mut matched = Vec::new();
        for fd in fds.flatten().take(budget) {
            budget = budget.saturating_sub(1);
            let Ok(link) = std::fs::read_link(fd.path()) else {
                continue;
            };
            let link = link.to_string_lossy();
            if let Some(inode) = link
                .strip_prefix("socket:[")
                .and_then(|l| l.strip_suffix(']'))
                && inodes.contains(inode)
                && !owners.contains_key(inode)
            {
                matched.push(inode.to_owned());
            }
        }
        if matched.is_empty() {
            continue;
        }
        let process_name = std::fs::read_to_string(Path::new("/proc").join(pid_text).join("comm"))
            .ok()
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty());
        let Ok(pid) = pid_text.parse::<i64>() else {
            continue;
        };
        for inode in matched {
            owners.insert(inode, (pid, process_name.clone()));
        }
    }
    if budget == 0 && owners.len() < inodes.len() && !lsof_missing {
        return None;
    }
    Some(owners)
}

/// `probeWebUrl`: an HTML page, or a redirect with a location, within one second.
async fn probe_web_url(raw: &str) -> bool {
    tokio::time::timeout(WEB_PROBE_TIMEOUT, probe(raw))
        .await
        .unwrap_or(false)
}

async fn probe(raw: &str) -> bool {
    use http_body_util::Empty;
    use hyper::body::Bytes;
    use hyper_util::rt::TokioIo;
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    let host = url
        .host_str()
        .unwrap_or_default()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    let port = parse::url_port(&url);
    let Ok(tcp) = tokio::net::TcpStream::connect((host.as_str(), port)).await else {
        return false;
    };
    let path = match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_owned(),
    };
    let authority = url.port().map_or_else(
        || url.host_str().unwrap_or_default().to_owned(),
        |p| format!("{}:{p}", url.host_str().unwrap_or_default()),
    );
    let Ok(request) = hyper::Request::get(path)
        .header("host", authority)
        .header("accept", "*/*")
        .body(Empty::<Bytes>::new())
    else {
        return false;
    };
    let response = if url.scheme() == "https" {
        let Ok(tls) = conn_support::tls::client_config() else {
            return false;
        };
        let Ok(name) = rustls::pki_types::ServerName::try_from(host.clone()) else {
            return false;
        };
        let Ok(stream) = tokio_rustls::TlsConnector::from(tls)
            .connect(name, tcp)
            .await
        else {
            return false;
        };
        let Ok((mut sender, connection)) =
            hyper::client::conn::http1::handshake(TokioIo::new(stream)).await
        else {
            return false;
        };
        tokio::spawn(async move {
            let _ = connection.await;
        });
        sender.send_request(request).await
    } else {
        let Ok((mut sender, connection)) =
            hyper::client::conn::http1::handshake(TokioIo::new(tcp)).await
        else {
            return false;
        };
        tokio::spawn(async move {
            let _ = connection.await;
        });
        sender.send_request(request).await
    };
    let Ok(response) = response else {
        return false;
    };
    let status = response.status().as_u16();
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .unwrap_or_default()
            .to_owned()
    };
    if matches!(status, 301 | 302 | 303 | 307 | 308) && !header("location").is_empty() {
        return true;
    }
    if !(200..300).contains(&status) || status == 204 || status == 205 {
        return false;
    }
    let content_type = header("content-type");
    let media = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    media == "text/html" || media == "application/xhtml+xml"
}

/// `DiscoveredLocalServerList`.
fn list_json(servers: &[Server]) -> Value {
    json!({
        "servers": servers.iter().map(Server::to_json).collect::<Vec<_>>(),
        "scannedAt": conn_support::time::now_iso(),
        "configuredUrlProbing": true,
    })
}

/// The running terminals, for [`LocalServers::new`].
pub fn terminal_shells(terminals: Option<conn_terminal::TerminalManager>) -> TerminalShells {
    Arc::new(move || {
        terminals
            .as_ref()
            .map(|t| {
                t.list()
                    .into_iter()
                    // Every running shell: a background job (`server &`) is no foreground
                    // job, but T3 still owns it through the shell's process tree.
                    .filter(|s| matches!(s.status, conn_contract::TerminalSessionStatus::Running))
                    .filter_map(|s| Some((s.thread_id, s.terminal_id, s.pid?)))
                    .collect()
            })
            .unwrap_or_default()
    })
}

/// The settings map for the foreground gate.
pub type Settings = Arc<dyn Fn() -> Map<String, Value> + Send + Sync>;

#[cfg(test)]
mod tests {
    use super::*;

    /// Subscriptions that leave during a slow first scan give their slot and retention back
    /// at once, so a reconnect is not refused (Codex review, round 2).
    #[tokio::test]
    async fn a_subscription_left_during_its_first_scan_frees_its_slot() {
        let scanner = LocalServers::new(Arc::new(Vec::new), Arc::new(|| false));
        let held = scanner.0.scan.lock().await;
        let mut lists = Vec::new();
        for _ in 0..MAX_SUBSCRIBERS {
            lists.push(scanner.subscribe(Vec::new()).await.expect("a slot"));
        }
        assert!(
            scanner.subscribe(Vec::new()).await.is_err(),
            "the cap holds"
        );
        drop(lists);
        for _ in 0..100 {
            if scanner.0.pending.load(Ordering::SeqCst) == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(scanner.0.pending.load(Ordering::SeqCst), 0);
        assert_eq!(scanner.0.retained.load(Ordering::SeqCst), 0);
        let mut again = scanner.subscribe(Vec::new()).await.expect("a slot again");
        drop(held);
        let first = tokio::time::timeout(Duration::from_secs(20), again.recv())
            .await
            .expect("a first list")
            .expect("open");
        assert!(first["servers"].is_array());
    }
}
