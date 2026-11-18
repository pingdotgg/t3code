//! The command line, with the names the TypeScript `t3` binary uses where Orbit, Conn desktop
//! or scripts call them (`apps/server/src/cli/*.ts`; see `DROP-IN.md`). Hand-parsed: a parser
//! crate costs more binary than this whole file.

use std::{
    io::{self, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Deserialize;
use serde_json::{Value, json};

use conn_support::time::iso_from_ms;

#[path = "cli_thread.rs"]
pub mod thread;

use crate::{
    auth::{
        self, AuthStore, PAIRING_CODE_TTL_MS, PairingRequest, SESSION_TTL_MS, STANDARD_SCOPES,
        SessionRequest,
    },
    home,
};

pub const USAGE: &str = "\
usage:
  conn-server [serve] [--host <host>] [--port <port>] [--listen <host:port>]
              [--base-dir <dir>] [--state-dir <dir>] [--project <dir>]... [--label <name>]
              [--mode web|desktop] [--bootstrap-fd <fd>] [--no-browser]
              [--session-idle-timeout <minutes>] [--sdk-host <path>]
              [--managed-provision <file>] [<cwd>]
  conn-server pair [--scopes <list>] [--ttl <ttl>] [--label <label>]
  conn-server auth pairing create [--scopes <list>] [--ttl <ttl>] [--label <label>] [--base-url <url>] [--json]
  conn-server auth pairing list [--json]
  conn-server auth pairing revoke <id>
  conn-server auth session issue [--scope <scope>]... [--scopes <list>] [--ttl <ttl>] [--label <label>] [--subject <s>] [--token-only] [--json]
  conn-server auth session list [--json]
  conn-server auth session revoke <session-id>
  conn-server project add <path> [--title <title>]
  conn-server thread list [--project <id or path>] [--json]
  conn-server thread start <project> <message or -> [--title <t>] [--provider <id> --model <slug>]
              [--worktree <base-ref> [--branch <name>]] [--wait] [--json]
  conn-server thread send <thread> <message or -> [--wait] [--json]
  conn-server thread show <thread> [--messages <n>] [--json]

A repeated --scope, or --scopes <list>, replaces the default scopes. thread --wait exits 1
when the run fails and 2 when it waits for an answer.
Every command takes --base-dir (or $T3CODE_HOME, default ~/.t3) or --state-dir.
--session-idle-timeout (or $CONN_SESSION_IDLE_TIMEOUT): minutes before an idle provider
session and its process close; 0 keeps them open. Default 30, as the T3 server.
--sdk-host (or $CONN_SDK_HOST): the SDK host that runs Claude's Agent SDK, a single executable or
an .mjs script run with node. Default: conn-sdk-host beside this binary, else
sdk-host/index.mjs beside it (the release tarball), else the checkout's
helpers/sdk-host/index.mjs.
Environment: T3CODE_HOME, T3CODE_PORT, T3CODE_HOST, T3CODE_MODE, T3CODE_BOOTSTRAP_FD, CONN_SERVER_BROWSER_PATH.";

pub const DEFAULT_PORT: u16 = 3773;

#[derive(Clone, Debug, PartialEq)]
pub struct ServeArgs {
    pub listen: SocketAddr,
    pub state_dir: PathBuf,
    /// Canonical folders from `--project` (and the current folder in the bare form).
    /// `serve` adds `projects.json` once it knows the final state directory.
    pub projects: Vec<(PathBuf, Option<String>)>,
    pub label: Option<String>,
    pub cwd: PathBuf,
    pub desktop: bool,
    pub bootstrap_fd: Option<u32>,
    /// How long an idle provider session stays open; `None` keeps it open.
    pub session_idle: Option<std::time::Duration>,
    /// `--sdk-host`: where the SDK host is. `None`: found by the provider.
    pub sdk_host: Option<PathBuf>,
    /// `--managed-provision`: the protected input of a managed target (`managed/provision.rs`).
    pub managed_provision: Option<PathBuf>,
}

#[derive(Debug, PartialEq)]
pub enum Command {
    Serve(ServeArgs),
    /// `acp-mcp-bridge`: the stdio MCP bridge an ACP agent starts (unlisted, as in T3).
    AcpMcpBridge,
    Pair {
        state_dir: PathBuf,
        scopes: Vec<String>,
        ttl_ms: u64,
        label: String,
    },
    PairingCreate {
        state_dir: PathBuf,
        scopes: Vec<String>,
        ttl_ms: u64,
        label: Option<String>,
        base_url: Option<String>,
        json: bool,
    },
    PairingList {
        state_dir: PathBuf,
        json: bool,
    },
    PairingRevoke {
        state_dir: PathBuf,
        id: String,
    },
    SessionIssue {
        state_dir: PathBuf,
        request: SessionArgs,
        token_only: bool,
        json: bool,
    },
    SessionList {
        state_dir: PathBuf,
        json: bool,
    },
    SessionRevoke {
        state_dir: PathBuf,
        id: String,
    },
    ProjectAdd {
        state_dir: PathBuf,
        path: PathBuf,
        title: Option<String>,
    },
    Thread {
        state_dir: PathBuf,
        command: thread::ThreadCommand,
    },
    Help,
    Version,
}

#[derive(Debug, PartialEq)]
pub struct SessionArgs {
    pub scopes: Vec<String>,
    pub ttl_ms: u64,
    pub label: Option<String>,
    pub subject: Option<String>,
}

/// Flags and positionals, before they mean anything.
struct Args {
    flags: Vec<(String, Option<String>)>,
    positionals: Vec<String>,
}

/// Flags that never take a value.
const SWITCHES: &[&str] = &[
    "--json",
    "--token-only",
    "--wait",
    "--no-browser",
    "--auto-bootstrap-project-from-cwd",
    "--tailscale-serve",
    "--lan",
    "--log-websocket-events",
    "--log-ws-events",
    "--help",
    "-h",
    "--version",
];

impl Args {
    fn parse(raw: Vec<String>) -> Result<Self, String> {
        let mut flags = Vec::new();
        let mut positionals = Vec::new();
        let mut iter = raw.into_iter();
        while let Some(arg) = iter.next() {
            if arg.starts_with('-') && arg.len() > 1 {
                if let Some((name, value)) = arg.split_once('=') {
                    flags.push((name.to_owned(), Some(value.to_owned())));
                } else if SWITCHES.contains(&arg.as_str()) {
                    flags.push((arg, None));
                } else {
                    let value = iter.next().ok_or_else(|| format!("{arg} needs a value"))?;
                    flags.push((arg, Some(value)));
                }
            } else {
                positionals.push(arg);
            }
        }
        Ok(Self { flags, positionals })
    }

    fn value(&self, name: &str) -> Option<String> {
        self.flags
            .iter()
            .rev()
            .find(|(n, _)| n == name)
            .and_then(|(_, v)| v.clone())
    }

    fn values(&self, name: &str) -> Vec<String> {
        self.flags
            .iter()
            .filter(|(n, _)| n == name)
            .filter_map(|(_, v)| v.clone())
            .collect()
    }

    fn has(&self, name: &str) -> bool {
        self.flags.iter().any(|(n, _)| n == name)
    }

    fn state_dir(&self) -> Result<PathBuf, String> {
        home::resolve_state_dir(
            self.value("--state-dir").map(PathBuf::from),
            self.value("--base-dir")
                .or_else(|| self.value("--home-dir"))
                .map(PathBuf::from),
        )
    }

    /// A repeated `--scope` (the T3 CLI's flag) or `--scopes <list>`; both replace the
    /// standard set. Duplicates go; the first place counts.
    fn scopes(&self) -> Result<Vec<String>, String> {
        let repeated = self.values("--scope");
        if !repeated.is_empty() {
            return auth::parse_scopes(&repeated.join(" "));
        }
        match self.value("--scopes") {
            Some(list) => auth::parse_scopes(&list),
            None => Ok(STANDARD_SCOPES.iter().map(|s| s.to_string()).collect()),
        }
    }

    fn ttl(&self, default: u64) -> Result<u64, String> {
        match self.value("--ttl") {
            Some(ttl) => auth::parse_ttl_ms(&ttl).ok_or_else(|| format!("invalid --ttl `{ttl}`")),
            None => Ok(default),
        }
    }

    /// Fails on a flag the command does not know.
    fn only(&self, known: &[&str]) -> Result<(), String> {
        const COMMON: &[&str] = &["--base-dir", "--home-dir", "--state-dir"];
        match self
            .flags
            .iter()
            .find(|(n, _)| !known.contains(&n.as_str()) && !COMMON.contains(&n.as_str()))
        {
            Some((name, _)) => Err(format!("unknown flag `{name}`")),
            None => Ok(()),
        }
    }
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// Reads a command line (without the program name).
pub fn parse(raw: Vec<String>) -> Result<Command, String> {
    let args = Args::parse(raw)?;
    if args.has("--help") || args.has("-h") {
        return Ok(Command::Help);
    }
    if args.has("--version") {
        return Ok(Command::Version);
    }
    let words: Vec<&str> = args.positionals.iter().map(String::as_str).collect();
    let state_dir = args.state_dir()?;
    let json = args.has("--json");
    match words.as_slice() {
        ["help", ..] => Ok(Command::Help),
        ["acp-mcp-bridge"] => Ok(Command::AcpMcpBridge),
        ["pair"] => {
            args.only(&["--scopes", "--ttl", "--label"])?;
            Ok(Command::Pair {
                state_dir,
                scopes: args.scopes()?,
                ttl_ms: args.ttl(PAIRING_CODE_TTL_MS)?,
                label: args.value("--label").unwrap_or_else(|| "t3 pair".into()),
            })
        }
        ["auth", "pairing", "create"] => {
            args.only(&[
                "--scope",
                "--scopes",
                "--ttl",
                "--label",
                "--base-url",
                "--json",
            ])?;
            Ok(Command::PairingCreate {
                state_dir,
                scopes: args.scopes()?,
                ttl_ms: args.ttl(PAIRING_CODE_TTL_MS)?,
                label: args.value("--label"),
                base_url: args.value("--base-url"),
                json,
            })
        }
        ["auth", "pairing", "list"] => {
            args.only(&["--json"])?;
            Ok(Command::PairingList { state_dir, json })
        }
        ["auth", "pairing", "revoke", id] => {
            args.only(&[])?;
            Ok(Command::PairingRevoke {
                state_dir,
                id: (*id).to_owned(),
            })
        }
        ["auth", "session", "issue"] => {
            args.only(&[
                "--scope",
                "--scopes",
                "--ttl",
                "--label",
                "--subject",
                "--token-only",
                "--json",
            ])?;
            Ok(Command::SessionIssue {
                state_dir,
                request: SessionArgs {
                    scopes: args.scopes()?,
                    ttl_ms: args.ttl(SESSION_TTL_MS)?,
                    label: args.value("--label"),
                    subject: args.value("--subject"),
                },
                token_only: args.has("--token-only"),
                json,
            })
        }
        ["auth", "session", "list"] => {
            args.only(&["--json"])?;
            Ok(Command::SessionList { state_dir, json })
        }
        ["auth", "session", "revoke", id] => {
            args.only(&[])?;
            Ok(Command::SessionRevoke {
                state_dir,
                id: (*id).to_owned(),
            })
        }
        ["project", "add", path] => {
            args.only(&["--title"])?;
            Ok(Command::ProjectAdd {
                state_dir,
                path: PathBuf::from(path),
                title: args.value("--title"),
            })
        }
        ["thread", ..] => thread_args(&args, &words, state_dir),
        [] | ["serve" | "start"] | ["serve" | "start", _] => serve_args(&args, state_dir),
        [cwd]
            if !matches!(*cwd, "pair" | "auth" | "project" | "thread")
                && Path::new(cwd).is_dir() =>
        {
            serve_args(&args, state_dir)
        }
        _ => Err(format!("unknown command `{}`", words.join(" "))),
    }
}

/// `thread list|start|send|show`, with the flags `apps/server/src/cli/thread.ts` takes.
fn thread_args(args: &Args, words: &[&str], state_dir: PathBuf) -> Result<Command, String> {
    use thread::ThreadCommand;
    let json = args.has("--json");
    let wait = args.has("--wait");
    let command = match words {
        ["thread", "list"] => {
            args.only(&["--project", "--json"])?;
            ThreadCommand::List {
                project: args.value("--project").unwrap_or_else(|| ".".into()),
                json,
            }
        }
        ["thread", "start", project, message] => {
            args.only(&[
                "--title",
                "--provider",
                "--model",
                "--worktree",
                "--branch",
                "--wait",
                "--json",
            ])?;
            ThreadCommand::Start {
                project: (*project).to_owned(),
                message: (*message).to_owned(),
                title: args.value("--title"),
                provider: args.value("--provider"),
                model: args.value("--model"),
                worktree: args.value("--worktree"),
                branch: args.value("--branch"),
                wait,
                json,
            }
        }
        ["thread", "send", thread, message] => {
            args.only(&["--wait", "--json"])?;
            ThreadCommand::Send {
                thread: (*thread).to_owned(),
                message: (*message).to_owned(),
                wait,
                json,
            }
        }
        ["thread", "show", thread] => {
            args.only(&["--messages", "--json"])?;
            let messages = match args.value("--messages") {
                Some(n) => n
                    .parse()
                    .map_err(|_| format!("--messages takes a whole number, not `{n}`"))?,
                None => 10,
            };
            ThreadCommand::Show {
                thread: (*thread).to_owned(),
                messages,
                json,
            }
        }
        _ => return Err(format!("unknown command `{}`", words.join(" "))),
    };
    Ok(Command::Thread { state_dir, command })
}

fn serve_args(args: &Args, state_dir: PathBuf) -> Result<Command, String> {
    args.only(&[
        "--listen",
        "--host",
        "--port",
        "--project",
        "--label",
        "--mode",
        "--bootstrap-fd",
        "--no-browser",
        "--auto-bootstrap-project-from-cwd",
        "--dev-url",
        "--tailscale-serve",
        "--tailscale-serve-port",
        "--lan",
        "--log-websocket-events",
        "--log-ws-events",
        "--session-idle-timeout",
        "--sdk-host",
        "--managed-provision",
    ])?;
    let subcommand = args.positionals.first().map(String::as_str);
    let positional_cwd = match subcommand {
        Some("serve" | "start") => args.positionals.get(1),
        _ => args.positionals.first(),
    };
    let cwd = match positional_cwd {
        Some(dir) => PathBuf::from(dir),
        None => std::env::current_dir().map_err(|e| format!("current folder: {e}"))?,
    };
    let cwd = std::fs::canonicalize(&cwd).map_err(|e| format!("{}: {e}", cwd.display()))?;
    let mode = args.value("--mode").or_else(|| env("T3CODE_MODE"));
    let desktop = match mode.as_deref() {
        None | Some("web") => false,
        Some("desktop") => true,
        Some(other) => return Err(format!("unknown --mode `{other}`")),
    };
    let bootstrap_fd = match args
        .value("--bootstrap-fd")
        .or_else(|| env("T3CODE_BOOTSTRAP_FD"))
    {
        Some(fd) => Some(
            fd.parse()
                .map_err(|_| format!("invalid --bootstrap-fd `{fd}`"))?,
        ),
        None => None,
    };
    let listen = match args.value("--listen") {
        Some(listen) => listen
            .parse()
            .map_err(|_| format!("--listen takes host:port, not `{listen}`"))?,
        None => {
            let host = args
                .value("--host")
                .or_else(|| env("T3CODE_HOST"))
                .unwrap_or_else(|| "127.0.0.1".into());
            let port = match args.value("--port").or_else(|| env("T3CODE_PORT")) {
                Some(port) => port.parse().map_err(|_| format!("invalid port `{port}`"))?,
                None => free_port(&host, DEFAULT_PORT),
            };
            resolve(&host, port)?
        }
    };
    let mut projects: Vec<(PathBuf, Option<String>)> = Vec::new();
    for dir in args.values("--project") {
        let root = std::fs::canonicalize(&dir).map_err(|e| format!("--project {dir}: {e}"))?;
        projects.push((root, None));
    }
    // The spike's default, kept for the bare form: no subcommand and no project named.
    let bare = subcommand.is_none_or(|s| s != "serve" && s != "start");
    if args.has("--auto-bootstrap-project-from-cwd") || (bare && projects.is_empty() && !desktop) {
        projects.push((cwd.clone(), None));
    }
    let session_idle = match args
        .value("--session-idle-timeout")
        .or_else(|| env("CONN_SESSION_IDLE_TIMEOUT"))
    {
        None => Some(conn_engine::DEFAULT_IDLE_SESSION),
        Some(minutes) => match minutes.parse::<u64>() {
            Ok(0) => None,
            Ok(minutes) => Some(std::time::Duration::from_secs(minutes.saturating_mul(60))),
            Err(_) => return Err(format!("invalid --session-idle-timeout `{minutes}`")),
        },
    };
    Ok(Command::Serve(ServeArgs {
        listen,
        state_dir,
        projects,
        label: args.value("--label"),
        cwd,
        desktop,
        bootstrap_fd,
        session_idle,
        sdk_host: args.value("--sdk-host").map(PathBuf::from),
        managed_provision: args.value("--managed-provision").map(PathBuf::from),
    }))
}

fn resolve(host: &str, port: u16) -> Result<SocketAddr, String> {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("{host}: {e}"))?
        .next()
        .ok_or_else(|| format!("{host}: no address"))
}

/// `findAvailablePort`: the first free port from `start` up.
fn free_port(host: &str, start: u16) -> u16 {
    (start..=u16::MAX)
        .find(|port| {
            resolve(host, *port)
                .ok()
                .is_some_and(|addr| TcpListener::bind(addr).is_ok())
        })
        .unwrap_or(0)
}

/// `DesktopBackendBootstrap`: the JSON line Conn desktop writes to `--bootstrap-fd`.
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBootstrapEnvelope {
    pub mode: Option<String>,
    pub port: Option<u16>,
    pub host: Option<String>,
    pub t3_home: Option<String>,
    pub desktop_bootstrap_token: Option<String>,
    pub desktop_bootstrap_secret: Option<String>,
}

impl std::fmt::Debug for DesktopBootstrapEnvelope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let redacted = |value: &Option<String>| value.as_ref().map(|_| "<redacted>");
        f.debug_struct("DesktopBootstrapEnvelope")
            .field("mode", &self.mode)
            .field("port", &self.port)
            .field("host", &self.host)
            .field("t3_home", &self.t3_home)
            .field(
                "desktop_bootstrap_token",
                &redacted(&self.desktop_bootstrap_token),
            )
            .field(
                "desktop_bootstrap_secret",
                &redacted(&self.desktop_bootstrap_secret),
            )
            .finish()
    }
}

/// How long the desktop has to write its bootstrap line, as in `bootstrap.ts`.
const BOOTSTRAP_TIMEOUT: Duration = Duration::from_millis(1000);
/// The longest bootstrap line we read. The real envelope is a few hundred bytes.
const MAX_BOOTSTRAP_LINE: usize = 64 * 1024;

/// Reads one line from `fd` within a second, as `bootstrap.ts` does. `None` when the fd is
/// not open, nothing complete arrives in time, or the line is longer than the cap.
pub fn read_bootstrap(fd: u32) -> Option<DesktopBootstrapEnvelope> {
    let file = match open_bootstrap_fd(fd) {
        Ok(file) => file,
        Err(error) => {
            eprintln!("conn-server: cannot read the bootstrap fd {fd}: {error}");
            return None;
        }
    };
    let line = match read_line_within(&file, BOOTSTRAP_TIMEOUT, MAX_BOOTSTRAP_LINE) {
        Ok(line) => line,
        Err(error) => {
            eprintln!("conn-server: ignoring the bootstrap envelope: {error}");
            return None;
        }
    };
    match serde_json::from_slice(line.trim_ascii()) {
        Ok(envelope) => Some(envelope),
        Err(error) => {
            eprintln!("conn-server: ignoring the bootstrap envelope: {error}");
            None
        }
    }
}

/// Opens `fd` through its path, as `bootstrap.ts` does. Where the path refuses (a socket
/// under `/proc/self/fd` gives ENXIO on Linux), reads the fd itself.
fn open_bootstrap_fd(fd: u32) -> io::Result<std::fs::File> {
    let path = if Path::new("/proc/self/fd").exists() {
        format!("/proc/self/fd/{fd}")
    } else {
        format!("/dev/fd/{fd}")
    };
    match std::fs::File::open(path) {
        Err(error) if reopen_refused(&error) => duplicate_fd(fd),
        result => result,
    }
}

/// `isBootstrapFdPathDuplicationError`: ENXIO, EINVAL, EPERM or EACCES.
fn reopen_refused(error: &io::Error) -> bool {
    use rustix::io::Errno;
    Errno::from_io_error(error).is_some_and(|errno| {
        [Errno::NXIO, Errno::INVAL, Errno::PERM, Errno::ACCESS].contains(&errno)
    })
}

/// A duplicate of our own `fd`, through `pidfd_getfd` on ourselves (Linux 5.6 or later),
/// which needs no `unsafe` here.
#[cfg(target_os = "linux")]
fn duplicate_fd(fd: u32) -> io::Result<std::fs::File> {
    use rustix::process::{PidfdFlags, PidfdGetfdFlags, getpid, pidfd_getfd, pidfd_open};
    let target = i32::try_from(fd).map_err(io::Error::other)?;
    let me = pidfd_open(getpid(), PidfdFlags::empty())?;
    Ok(std::fs::File::from(pidfd_getfd(
        &me,
        target,
        PidfdGetfdFlags::empty(),
    )?))
}

#[cfg(not(target_os = "linux"))]
fn duplicate_fd(_fd: u32) -> io::Result<std::fs::File> {
    Err(io::ErrorKind::Unsupported.into())
}

/// Reads up to the first newline, or to the end, within `timeout` and `cap` bytes. Waits
/// with `poll`, so a writer that stalls holds no thread.
fn read_line_within(file: &std::fs::File, timeout: Duration, cap: usize) -> io::Result<Vec<u8>> {
    use rustix::event::{PollFd, PollFlags, Timespec, poll};
    let deadline = std::time::Instant::now() + timeout;
    let mut line = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return Err(io::ErrorKind::TimedOut.into());
        }
        let wait = Timespec::try_from(left).map_err(io::Error::other)?;
        let mut fds = [PollFd::new(file, PollFlags::IN)];
        match poll(&mut fds, Some(&wait)) {
            Ok(0) => continue,
            Ok(_) => {}
            Err(rustix::io::Errno::INTR) => continue,
            Err(error) => return Err(error.into()),
        }
        let n = match (&*file).read(&mut chunk) {
            Ok(n) => n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        let read = chunk.get(..n).unwrap_or_default();
        let end = read.iter().position(|b| *b == b'\n');
        line.extend_from_slice(read.get(..end.unwrap_or(n)).unwrap_or_default());
        if line.len() > cap {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("the line is longer than {cap} bytes"),
            ));
        }
        if n == 0 || end.is_some() {
            return Ok(line);
        }
    }
}

impl ServeArgs {
    /// Applies the desktop envelope under the flags: flags and environment win, as in
    /// `cli/config.ts`, except that `t3Home` gives way only to `--state-dir`/`--base-dir`.
    pub fn apply_bootstrap(
        &mut self,
        envelope: &DesktopBootstrapEnvelope,
        explicit_listen: bool,
        explicit_home: bool,
    ) {
        if envelope.mode.as_deref() == Some("desktop") {
            self.desktop = true;
        }
        if !explicit_home && let Some(home) = &envelope.t3_home {
            self.state_dir = PathBuf::from(home).join("userdata");
        }
        if !explicit_listen {
            let host = envelope.host.clone().unwrap_or_else(|| "127.0.0.1".into());
            let port = envelope.port.unwrap_or(DEFAULT_PORT);
            if let Ok(addr) = resolve(&host, port) {
                self.listen = addr;
            }
        }
    }
}

/// Whether the command line or environment set the listen address or the home.
pub fn explicit_listen_and_home(raw: &[String]) -> (bool, bool) {
    let has = |names: &[&str]| {
        raw.iter().any(|a| {
            names
                .iter()
                .any(|n| a == n || a.starts_with(&format!("{n}=")))
        })
    };
    (
        has(&["--listen", "--host", "--port"])
            || env("T3CODE_PORT").is_some()
            || env("T3CODE_HOST").is_some(),
        has(&["--state-dir", "--base-dir", "--home-dir"]) || env("T3CODE_HOME").is_some(),
    )
}

/// Runs a command other than `serve`. Returns the exit code.
pub fn run(command: Command) -> i32 {
    if let Command::Thread { state_dir, command } = command {
        return thread::run(&state_dir, command);
    }
    if matches!(command, Command::AcpMcpBridge) {
        return crate::acp_mcp_bridge::main();
    }
    match run_inner(command) {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("{message}");
            1
        }
    }
}

fn open_auth(state_dir: &Path) -> Result<std::sync::Arc<AuthStore>, String> {
    AuthStore::open(state_dir.join("auth.json")).map_err(|e| {
        format!(
            "could not read {}: {e}",
            state_dir.join("auth.json").display()
        )
    })
}

fn print(text: String) {
    let mut out = io::stdout().lock();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}

/// What the T3 CLI's `auth` commands print: the formatted text, whose last line already ends
/// in a newline, through `Console.log`, which adds one more.
fn log(text: String) {
    print(format!("{text}\n"));
}

fn pretty(value: &Value) -> String {
    format!("{}\n", serde_json::to_string_pretty(value).expect("json"))
}

fn client_text(client: &conn_contract::AuthClientMetadata) -> String {
    let device = serde_json::to_value(client.device_type)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .filter(|d| d != "unknown");
    let details: Vec<String> = [
        client.label.clone(),
        device,
        client.os.clone(),
        client.browser.clone(),
        client.ip_address.clone(),
    ]
    .into_iter()
    .flatten()
    .filter(|s| !s.is_empty())
    .collect();
    if details.is_empty() {
        "unlabeled client".into()
    } else {
        details.join(" | ")
    }
}

fn run_inner(command: Command) -> Result<(), String> {
    match command {
        Command::Help => print(format!("{USAGE}\n")),
        Command::Version => print(format!(
            "conn-server {} (T3 server {} contract, contract digest {})\n",
            env!("CARGO_PKG_VERSION"),
            crate::environment::CONTRACT_SERVER_VERSION,
            conn_contract::contract_digest()
                .get(..12)
                .unwrap_or_default()
        )),
        Command::Serve(_) => return Err("serve runs from main".into()),
        Command::Thread { .. } | Command::AcpMcpBridge => {
            return Err("thread and acp-mcp-bridge run from run".into());
        }
        Command::Pair {
            state_dir,
            scopes,
            ttl_ms,
            label,
        } => {
            let runtime = home::read_runtime_state(&state_dir).ok_or_else(|| {
                format!("No running T3 server found for {}.", state_dir.display())
            })?;
            let issued = open_auth(&state_dir)?
                .issue_pairing(PairingRequest {
                    scopes,
                    label: Some(label.clone()),
                    ttl_ms,
                })
                .map_err(|e| e.to_string())?;
            let url = format!("{}/pair#token={}", runtime.origin, issued.code);
            print(format!(
                "Pairing with {label} ({origin}).\n\nPairing URL: {url}\nToken: {code}\nExpires: {expires}\n",
                origin = runtime.origin,
                code = issued.code,
                expires = iso_from_ms(issued.expires_at_ms),
            ));
        }
        Command::PairingCreate {
            state_dir,
            scopes,
            ttl_ms,
            label,
            base_url,
            json,
        } => {
            let issued = open_auth(&state_dir)?
                .issue_pairing(PairingRequest {
                    scopes,
                    label,
                    ttl_ms,
                })
                .map_err(|e| e.to_string())?;
            let pair_url = base_url
                .map(|base| format!("{}/pair#token={}", base.trim_end_matches('/'), issued.code));
            if json {
                let mut body = json!({ "id": issued.id, "credential": issued.code });
                if let Some(label) = &issued.label {
                    body["label"] = json!(label);
                }
                body["scopes"] = json!(issued.scopes);
                body["expiresAt"] = json!(iso_from_ms(issued.expires_at_ms));
                if let Some(url) = &pair_url {
                    body["pairUrl"] = json!(url);
                }
                log(pretty(&body));
            } else {
                let mut lines = vec![
                    format!("Issued client pairing token {}.", issued.id),
                    format!("Token: {}", issued.code),
                ];
                if let Some(url) = pair_url {
                    lines.push(format!("Pair URL: {url}"));
                }
                lines.push(format!("Expires at: {}", iso_from_ms(issued.expires_at_ms)));
                log(format!("{}\n", lines.join("\n")));
            }
        }
        Command::PairingList { state_dir, json } => {
            let links = open_auth(&state_dir)?.pairing_links();
            let scopes_of = |l: &conn_contract::AuthPairingLink| -> Vec<Value> {
                match &l.permissions {
                    Some(p) => p
                        .iter()
                        .map(|s| {
                            serde_json::to_value(s).expect("a scope literal always serializes")
                        })
                        .collect(),
                    None => l
                        .scopes
                        .iter()
                        .map(|s| {
                            serde_json::to_value(s).expect("a scope literal always serializes")
                        })
                        .collect(),
                }
            };
            if json {
                let rows: Vec<Value> = links
                    .iter()
                    .map(|l| {
                        let mut row = json!({ "id": l.id });
                        if let Some(label) = &l.label {
                            row["label"] = json!(label);
                        }
                        row["scopes"] = json!(scopes_of(l));
                        row["createdAt"] = json!(l.created_at);
                        row["expiresAt"] = json!(l.expires_at);
                        row
                    })
                    .collect();
                log(pretty(&json!(rows)));
            } else if links.is_empty() {
                log("No active pairing credentials.\n".into());
            } else {
                let blocks: Vec<String> = links
                    .iter()
                    .map(|l| {
                        let scopes: Vec<String> = scopes_of(l)
                            .iter()
                            .filter_map(|s| s.as_str().map(str::to_owned))
                            .collect();
                        format!(
                            "{}{}\n  scopes: {}\n  created: {}\n  expires: {}",
                            l.id,
                            l.label
                                .as_ref()
                                .map(|x| format!(" ({x})"))
                                .unwrap_or_default(),
                            scopes.join(" "),
                            l.created_at,
                            l.expires_at
                        )
                    })
                    .collect();
                log(format!("{}\n", blocks.join("\n\n")));
            }
        }
        Command::PairingRevoke { state_dir, id } => {
            let revoked = open_auth(&state_dir)?
                .revoke_pairing_link(&id)
                .map_err(|e| e.to_string())?;
            log(if revoked {
                format!("Revoked pairing credential {id}.\n")
            } else {
                format!("No active pairing credential found for {id}.\n")
            });
        }
        Command::SessionIssue {
            state_dir,
            request,
            token_only,
            json,
        } => {
            let issued = open_auth(&state_dir)?
                .issue_session(SessionRequest {
                    scopes: request.scopes,
                    label: request.label,
                    subject: request.subject,
                    ttl_ms: request.ttl_ms,
                })
                .map_err(|e| e.to_string())?;
            let p = &issued.principal;
            let client = issued.client.to_contract();
            if token_only {
                log(format!("{}\n", issued.token));
            } else if json {
                // `formatIssuedSession`: these keys in this order, the client as stored.
                #[derive(serde::Serialize)]
                #[serde(rename_all = "camelCase")]
                struct Issued<'a> {
                    session_id: &'a str,
                    token: &'a str,
                    method: &'a str,
                    scopes: &'a [String],
                    subject: &'a str,
                    client: &'a conn_contract::AuthClientMetadata,
                    expires_at: String,
                }
                let body = Issued {
                    session_id: &p.session_id,
                    token: &issued.token,
                    method: "bearer-access-token",
                    scopes: &p.scopes,
                    subject: &p.subject,
                    client: &client,
                    expires_at: iso_from_ms(p.expires_at_ms),
                };
                let text = serde_json::to_string_pretty(&body)
                    .map_err(|e| format!("could not print the session: {e}"))?;
                log(format!("{text}\n"));
            } else {
                log(format!(
                    "Issued bearer access token {}.\nScopes: {}\nToken: {}\nSubject: {}\nClient: {}\nExpires at: {}\n",
                    p.session_id,
                    p.scopes.join(" "),
                    issued.token,
                    p.subject,
                    client_text(&client),
                    iso_from_ms(p.expires_at_ms)
                ));
            }
        }
        Command::SessionList { state_dir, json } => {
            let sessions = open_auth(&state_dir)?.client_sessions(None);
            if json {
                let rows: Vec<Value> = sessions
                    .iter()
                    .map(|s| {
                        json!({
                            "sessionId": s.session_id,
                            "method": s.method,
                            "scopes": s.permissions.clone().unwrap_or_default(),
                            "subject": s.subject,
                            "client": s.client,
                            "connected": s.connected,
                            "issuedAt": s.issued_at,
                            "expiresAt": s.expires_at,
                            "lastConnectedAt": s.last_connected_at,
                        })
                    })
                    .collect();
                log(pretty(&json!(rows)));
            } else if sessions.is_empty() {
                log("No active sessions.\n".into());
            } else {
                let blocks: Vec<String> = sessions
                    .iter()
                    .map(|s| {
                        let scopes: Vec<String> = s
                            .permissions
                            .iter()
                            .flatten()
                            .flatten()
                            .filter_map(|x| serde_json::to_value(x).ok()?.as_str().map(str::to_owned))
                            .collect();
                        format!(
                            "{}{}\n  scopes: {}\n  method: bearer-access-token\n  subject: {}\n  client: {}\n  issued: {}\n  last connected: {}\n  expires: {}",
                            s.session_id,
                            if s.connected { " connected" } else { "" },
                            scopes.join(" "),
                            s.subject,
                            client_text(&s.client),
                            s.issued_at,
                            s.last_connected_at.as_deref().unwrap_or("never"),
                            s.expires_at
                        )
                    })
                    .collect();
                log(format!("{}\n", blocks.join("\n\n")));
            }
        }
        Command::SessionRevoke { state_dir, id } => {
            let revoked = open_auth(&state_dir)?
                .revoke_session(None, &id)
                .map_err(|e| e.to_string())?
                .unwrap_or(false);
            log(if revoked {
                format!("Revoked session {id}.\n")
            } else {
                format!("No active session found for {id}.\n")
            });
        }
        Command::ProjectAdd {
            state_dir,
            path,
            title,
        } => project_add(&state_dir, &path, title)?,
    }
    Ok(())
}

/// `project add`: records the folder in `projects.json` (read at every start), then asks a
/// running server to add it now (`POST /api/projects/mutate`, as the TypeScript CLI does).
fn project_add(state_dir: &Path, path: &Path, title: Option<String>) -> Result<(), String> {
    let root = std::fs::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let title = title
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty())
        .or_else(|| root.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "project".into());
    home::add_project(state_dir, &root, &title).map_err(|e| e.to_string())?;
    let root_text = root.to_string_lossy().into_owned();
    let project_id = conn_engine::SqliteEngine::project_id_for(&root_text);
    if let Some(runtime) = home::read_runtime_state(state_dir) {
        let added =
            add_to_running_server(state_dir, &runtime.origin, &project_id, &title, &root_text);
        if let Err(reason) = added {
            eprintln!(
                "The running server did not add it now ({reason}); it loads the project at its next start."
            );
        }
    }
    print(format!(
        "Added project {project_id} ({title}) at {root_text}.\n"
    ));
    Ok(())
}

fn add_to_running_server(
    state_dir: &Path,
    origin: &str,
    project_id: &str,
    title: &str,
    root: &str,
) -> Result<(), String> {
    let auth = open_auth(state_dir)?;
    let session = auth
        .issue_session(SessionRequest {
            scopes: vec!["orchestration:read".into(), "orchestration:operate".into()],
            label: Some("t3 project cli".into()),
            subject: None,
            ttl_ms: 5 * 60_000,
        })
        .map_err(|e| e.to_string())?;
    let body = json!({
        "type": "project.create",
        "commandId": conn_support::uuid_v4(),
        "projectId": project_id,
        "title": title,
        "workspaceRoot": root,
    });
    let result = http_post(origin, "/api/projects/mutate", &session.token, &body);
    let _ = auth.revoke_session(None, &session.principal.session_id);
    match result? {
        (200..=299, _) => Ok(()),
        (status, body) => Err(format!("HTTP {status} {}", body.trim())),
    }
}

/// One HTTP/1.1 POST with a JSON body to a local server.
fn http_post(
    origin: &str,
    path: &str,
    bearer: &str,
    body: &Value,
) -> Result<(u16, String), String> {
    let authority = origin
        .strip_prefix("http://")
        .ok_or_else(|| format!("unsupported origin {origin}"))?;
    let addr = authority
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or("no address")?;
    let mut stream =
        TcpStream::connect_timeout(&addr, Duration::from_secs(3)).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;
    let body = body.to_string();
    let request = format!(
        "POST {path} HTTP/1.1\r\nhost: {authority}\r\nauthorization: Bearer {bearer}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|e| e.to_string())?;
    let status = response
        .get(9..12)
        .and_then(|s| s.parse().ok())
        .ok_or("malformed response")?;
    let body = response
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_owned())
        .unwrap_or_default();
    Ok((status, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(line: &str) -> Vec<String> {
        line.split_whitespace().map(str::to_owned).collect()
    }

    #[test]
    fn reads_orbits_start_line() {
        let Command::Serve(serve) = parse(args(
            "serve --host=0.0.0.0 --port=3773 --no-browser --state-dir /tmp/x",
        ))
        .unwrap() else {
            panic!("not serve")
        };
        assert_eq!(serve.listen, "0.0.0.0:3773".parse().unwrap());
        assert_eq!(serve.state_dir, PathBuf::from("/tmp/x"));
        // `serve` offers no project of its own; `project add` names them.
        assert!(serve.projects.is_empty());
        assert!(!serve.desktop);
    }

    #[test]
    fn reads_the_auth_commands_orbit_runs() {
        assert_eq!(
            parse(args(
                "auth session issue --label Orbit --token-only --state-dir /s"
            ))
            .unwrap(),
            Command::SessionIssue {
                state_dir: "/s".into(),
                request: SessionArgs {
                    scopes: STANDARD_SCOPES.iter().map(|s| s.to_string()).collect(),
                    ttl_ms: SESSION_TTL_MS,
                    label: Some("Orbit".into()),
                    subject: None,
                },
                token_only: true,
                json: false,
            }
        );
        assert_eq!(
            parse(args("auth session list --json --state-dir /s")).unwrap(),
            Command::SessionList {
                state_dir: "/s".into(),
                json: true
            }
        );
        assert_eq!(
            parse(args(
                "project add /srv/workspace --title Web --state-dir /s"
            ))
            .unwrap(),
            Command::ProjectAdd {
                state_dir: "/s".into(),
                path: "/srv/workspace".into(),
                title: Some("Web".into())
            }
        );
        assert!(parse(args("auth session issue --bogus 1")).is_err());
        assert!(parse(args("auth session issue --scopes root")).is_err());
        assert!(parse(args("frobnicate")).is_err());
    }

    /// Conn desktop on Linux hands over a socket, which `/proc/self/fd/N` cannot reopen
    /// (ENXIO); the reader then reads the fd itself. On macOS `/dev/fd/N` opens it.
    #[cfg(unix)]
    #[test]
    fn reads_the_bootstrap_line_from_a_socket() {
        use std::os::fd::AsRawFd;
        let (mut writer, reader) = std::os::unix::net::UnixStream::pair().unwrap();
        writer
            .write_all(b"{\"mode\":\"desktop\",\"desktopBootstrapToken\":\"tok\"}\n")
            .unwrap();
        let fd = u32::try_from(reader.as_raw_fd()).unwrap();
        let envelope = read_bootstrap(fd).unwrap();
        assert_eq!(envelope.mode.as_deref(), Some("desktop"));
        assert_eq!(envelope.desktop_bootstrap_token.as_deref(), Some("tok"));
    }

    /// A writer that never finishes its line costs a second, not a thread forever, and a line
    /// past the cap is refused.
    #[cfg(unix)]
    #[test]
    fn a_stalled_or_oversized_bootstrap_line_is_refused() {
        use std::os::fd::AsRawFd;
        let (mut writer, reader) = std::os::unix::net::UnixStream::pair().unwrap();
        writer.write_all(b"{\"mode\":").unwrap();
        let started = std::time::Instant::now();
        assert!(read_bootstrap(u32::try_from(reader.as_raw_fd()).unwrap()).is_none());
        assert!(started.elapsed() < Duration::from_secs(3));

        let (mut writer, reader) = std::os::unix::net::UnixStream::pair().unwrap();
        let fd = u32::try_from(reader.as_raw_fd()).unwrap();
        let host = "h".repeat(MAX_BOOTSTRAP_LINE);
        let line = format!("{{\"mode\":\"desktop\",\"host\":\"{host}\"}}\n");
        let feeder = std::thread::spawn(move || {
            let _ = writer.write_all(line.as_bytes());
        });
        assert!(read_bootstrap(fd).is_none());
        drop(reader);
        feeder.join().unwrap();
    }

    #[test]
    fn falls_back_to_the_fd_where_t3_does() {
        for errno in [
            rustix::io::Errno::NXIO,
            rustix::io::Errno::INVAL,
            rustix::io::Errno::PERM,
            rustix::io::Errno::ACCESS,
        ] {
            assert!(reopen_refused(&io::Error::from(errno)));
        }
        assert!(!reopen_refused(&io::Error::from(rustix::io::Errno::BADF)));
    }

    #[test]
    fn the_desktop_envelope_fills_what_flags_leave_open() {
        let Command::Serve(mut serve) = parse(args("--bootstrap-fd 3 --state-dir /s")).unwrap()
        else {
            panic!()
        };
        assert_eq!(serve.bootstrap_fd, Some(3));
        let envelope: DesktopBootstrapEnvelope = serde_json::from_value(json!({
            "mode": "desktop", "noBrowser": true, "port": 3999, "host": "127.0.0.1",
            "t3Home": "/home/u/.t3", "desktopBootstrapToken": "tok", "tailscaleServeEnabled": false,
            "tailscaleServePort": 443,
        }))
        .unwrap();
        serve.apply_bootstrap(&envelope, false, true);
        assert!(serve.desktop);
        assert_eq!(serve.listen, "127.0.0.1:3999".parse().unwrap());
        assert_eq!(serve.state_dir, PathBuf::from("/s"));
        serve.apply_bootstrap(&envelope, false, false);
        assert_eq!(serve.state_dir, PathBuf::from("/home/u/.t3/userdata"));
    }
}
