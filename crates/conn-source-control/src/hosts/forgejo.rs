//! Forgejo / Gitea (`packages/source-control-forgejo`): discovery.
//!
//! Discovery is the managed probe of `ForgejoSourceControlProvider.makeDiscovery`. It reads
//! `git remote get-url origin`, the logins in fj's `keys.json`, and picks the login for the
//! remote. Then it asks `fj version` and `fj --host <url> whoami` (in the home folder) and, for a
//! signed-in login, `GET <url>/api/v1/user` for the account name. When `fj` is absent or knows no
//! login, the answer comes from `tea --version` and `tea login status --output json`.
//!
//! Not built: `refineUnknownRemote`, and `ForgejoCli`'s 30 s cache of a verified fj token. Without
//! the cache, each discovery runs `fj --host <url> whoami` a second time, as a cold T3 server
//! does. The token is read from `keys.json` after that run, as in T3. A host name that needs
//! IDNA or IPv4 number forms is kept as written: `parse_remote` compares the same text on both
//! sides.

use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    io::Read as _,
    path::{Path, PathBuf},
    time::Duration,
};

use conn_contract::{
    ServerProviderAuthStatus, SourceControlDiscoveryStatus, SourceControlProviderAuth,
    SourceControlProviderDiscoveryItem,
};
use conn_vcs::process::{GitCommand, OnLimit, ProcessError};
use serde::{Deserialize, Deserializer, de};

use super::DiscoveryContext;
use crate::{
    discovery::{
        ALL_EXIT_CODES, CliSpec, DEFAULT_PROBE_TIMEOUT, PROBE_MAX_BYTES, ProbeContext, ProbeOutput,
        classify_exit_detail, probe_cli, provider_auth, strip_prefix_ignore_case,
    },
    http::{self, HttpRequest, HttpResponse, Method},
    secret::Secret,
};

pub const KIND: &str = "forgejo";
const LABEL: &str = "Forgejo / Gitea";
const INSTALL_HINT: &str = "Install `fj` 0.6 or later from https://codeberg.org/forgejo-contrib/forgejo-cli and run `fj --host <server-url> auth add-token`, or install `tea` 0.16 or later from https://gitea.com/gitea/tea and run `tea login add` for each Forgejo or Gitea server.";
const OPERATION_REMOTE: &str = "source-control.discovery.remote";
const OPERATION_EXECUTE: &str = "ForgejoCli.execute";
/// `timeoutMs` of the `git remote get-url origin` probe.
const REMOTE_TIMEOUT: Duration = Duration::from_secs(5);
/// `ForgejoCli.execute`'s default and `requestFj`'s timeout.
const EXECUTE_TIMEOUT: Duration = Duration::from_secs(30);
/// A `keys.json` this large is not fj's.
const MAX_KEYS_BYTES: u64 = 1024 * 1024;

const STORAGE_UNREADABLE: &str = "Could not read fj authentication storage.";
const STORAGE_INVALID: &str = "fj authentication storage is invalid. Authenticate again with fj.";
const MISSING_CLI: &str =
    "Install Forgejo CLI (`fj` 0.6 or later) or Gitea CLI (`tea` 0.16 or later) and retry.";
const CLI_AUTHENTICATION: &str =
    "Authenticate this server with `fj auth login`, `fj auth add-token`, or `tea login add`.";
const CLI_FAILED: &str = "Forgejo CLI command failed.";
const NO_CREDENTIALS: &str = "fj has no credentials for this server.";
const NO_CREDENTIALS_AFTER_RENEWAL: &str =
    "fj has no credentials for this server. Authenticate again with fj.";
const INVALID_RESPONSE: &str = "Forgejo returned an oversized or invalid response.";
const INVALID_ACCOUNT: &str = "Forgejo returned an invalid account response.";
const REQUEST_FAILED: &str = "Forgejo API request failed or timed out.";

// ---------------------------------------------------------------------------------------------
// Remotes: `parseForgejoRemote`
// ---------------------------------------------------------------------------------------------

/// `parseForgejoRemote`'s answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Remote {
    /// Host name and the port, unless it is the scheme's default.
    pub host: String,
    pub hostname: String,
    pub ssh: bool,
    pub path: String,
}

/// `parseForgejoRemote`: an `http`, `https` or `ssh` URL, or an SCP-style remote.
pub fn parse_remote(value: &str) -> Option<Remote> {
    let is_url = ["https://", "http://", "ssh://"]
        .iter()
        .any(|prefix| strip_prefix_ignore_case(value, prefix).is_some());
    if is_url {
        parse_url_remote(value)
    } else {
        parse_scp_remote(value)
    }
}

fn without_git_suffix(path: &str) -> &str {
    path.strip_suffix(".git").unwrap_or(path)
}

/// `/^(?:[^@/]+@)?([^:/]+):([^/].*)$/` (`.` stops at a line terminator).
fn parse_scp_remote(value: &str) -> Option<Remote> {
    fn attempt(text: &str) -> Option<(&str, &str)> {
        let (host, rest) = text.split_once(':')?;
        if host.is_empty() || host.contains('/') {
            return None;
        }
        let mut chars = rest.chars();
        let first = chars.next()?;
        let line_terminator = |c: char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
        (first != '/' && !chars.any(line_terminator)).then_some((host, rest))
    }
    let with_user = value
        .split_once('@')
        .filter(|(user, _)| !user.is_empty() && !user.contains('/'))
        .and_then(|(_, rest)| attempt(rest));
    let (host, path) = with_user.or_else(|| attempt(value))?;
    let host = host.to_lowercase();
    Some(Remote {
        hostname: host.clone(),
        host,
        ssh: true,
        path: without_git_suffix(path).to_owned(),
    })
}

/// `new URL(value)` for the three schemes, reduced to what `parseForgejoRemote` reads.
fn parse_url_remote(value: &str) -> Option<Remote> {
    let cleaned: String = value
        .trim_matches(|c: char| c <= ' ')
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let (scheme, rest) = cleaned.split_once(':')?;
    let scheme = scheme.to_ascii_lowercase();
    let special = scheme != "ssh";
    let after = if special {
        rest.trim_start_matches(['/', '\\'])
    } else {
        rest.strip_prefix("//")?
    };
    let end = after
        .find(|c: char| matches!(c, '/' | '?' | '#') || (special && c == '\\'))
        .unwrap_or(after.len());
    let authority = after.get(..end)?;
    let tail = after.get(end..)?;

    let (credentials, host_port) = match authority.rsplit_once('@') {
        Some((_, host_port)) => (true, host_port),
        None => (false, authority),
    };
    if credentials && host_port.is_empty() {
        return None;
    }
    let (host_text, port_text) = if host_port.starts_with('[') {
        let close = host_port.find(']')?;
        let host = host_port.get(..=close)?;
        match host_port.get(close + 1..)? {
            "" => (host, None),
            more => (host, Some(more.strip_prefix(':')?)),
        }
    } else {
        match host_port.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (host_port, None),
        }
    };
    let default_port = match scheme.as_str() {
        "http" => Some(80),
        "https" => Some(443),
        _ => None,
    };
    let port = match port_text {
        None | Some("") => None,
        Some(digits) => {
            if !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let port: u16 = digits.parse().ok()?;
            (Some(port) != default_port).then_some(port)
        }
    };
    let hostname = url_hostname(host_text, special)?.to_lowercase();
    let host = match port {
        Some(port) => format!("{hostname}:{port}"),
        None => hostname.clone(),
    };

    let path_end = tail.find(['?', '#']).unwrap_or(tail.len());
    let raw_path = tail.get(..path_end)?;
    let path = url_path(raw_path, special);
    let path = path.trim_matches('/');
    Some(Remote {
        host,
        hostname,
        ssh: !special,
        path: without_git_suffix(path).to_owned(),
    })
}

/// The URL host parser, for `http`/`https` (a domain) and `ssh` (an opaque host).
fn url_hostname(text: &str, special: bool) -> Option<String> {
    if text.starts_with('[') {
        let inner = text.strip_prefix('[')?.strip_suffix(']')?;
        let valid = !inner.is_empty()
            && inner
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.');
        return valid.then(|| text.to_ascii_lowercase());
    }
    let forbidden = |c: char| {
        matches!(
            c,
            '\0' | '\t'
                | '\n'
                | '\r'
                | ' '
                | '#'
                | '/'
                | ':'
                | '<'
                | '>'
                | '?'
                | '@'
                | '['
                | '\\'
                | ']'
                | '^'
                | '|'
        )
    };
    if special {
        if text.is_empty() {
            return None;
        }
        let decoded = percent_decode(text)?;
        if decoded.is_empty()
            || decoded
                .chars()
                .any(|c| forbidden(c) || c == '%' || c.is_control())
        {
            return None;
        }
        Some(decoded.to_lowercase())
    } else if text.chars().any(forbidden) {
        None
    } else {
        Some(text.to_owned())
    }
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while let Some(&byte) = bytes.get(index) {
        let hex = |offset: usize| {
            bytes
                .get(index + offset)
                .and_then(|b| char::from(*b).to_digit(16))
        };
        match (byte, hex(1), hex(2)) {
            (b'%', Some(high), Some(low)) => {
                out.push(u8::try_from(high * 16 + low).ok()?);
                index += 3;
            }
            _ => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// The URL path parser: dot segments, `\` for special schemes, and the path percent-encode set.
fn url_path(raw: &str, special: bool) -> String {
    let normalized;
    let raw = if special {
        normalized = raw.replace('\\', "/");
        normalized.as_str()
    } else {
        raw
    };
    if raw.is_empty() {
        return String::new();
    }
    let body = raw.strip_prefix('/').unwrap_or(raw);
    let is_dots = |segment: &str, count: usize| {
        let lower = segment.to_ascii_lowercase();
        let dots = lower.replace("%2e", ".");
        dots.len() == count && dots.bytes().all(|b| b == b'.')
    };
    let parts: Vec<&str> = body.split('/').collect();
    let mut segments: Vec<String> = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        let last = index + 1 == parts.len();
        if is_dots(part, 2) {
            segments.pop();
            if last {
                segments.push(String::new());
            }
        } else if is_dots(part, 1) {
            if last {
                segments.push(String::new());
            }
        } else {
            segments.push(encode_path_segment(part));
        }
    }
    format!("/{}", segments.join("/"))
}

fn encode_path_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for c in segment.chars() {
        let encode = c <= '\u{1f}'
            || matches!(c, ' ' | '"' | '#' | '<' | '>' | '?' | '`' | '{' | '}')
            || c >= '\u{7f}';
        if encode {
            let mut buffer = [0u8; 4];
            for byte in c.encode_utf8(&mut buffer).bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn remote_host(url: &str) -> Option<String> {
    parse_remote(url).map(|remote| remote.host)
}

// ---------------------------------------------------------------------------------------------
// Logins: `ForgejoLoginSchema`, `matchForgejoLogin`, `publicLogins`
// ---------------------------------------------------------------------------------------------

/// A JSON string that, when present, is not `null` (`Schema.optional(Schema.String)`).
fn not_null<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

/// One login, as `tea login list --output json` prints it (`ForgejoLoginSchema`).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Login {
    pub name: String,
    pub url: String,
    #[serde(default, deserialize_with = "not_null")]
    pub ssh_host: Option<String>,
    #[serde(default, deserialize_with = "not_null")]
    pub valid: Option<String>,
    pub user: String,
    pub default: String,
}

/// `parseForgejoLogins`: no logins when the text is not that JSON shape.
pub fn parse_logins(raw: &str) -> Vec<Login> {
    serde_json::from_str(raw).unwrap_or_default()
}

/// What `matchForgejoLogin` takes besides the logins and the remote.
#[derive(Clone, Copy, Debug, Default)]
pub struct MatchOptions<'a> {
    pub requested_host: Option<&'a str>,
    pub host_only: bool,
}

/// `matchForgejoLogin`: the one login that serves the remote, or the default one when every
/// match is the same server.
pub fn match_login<'a>(
    logins: &'a [Login],
    remote: &Remote,
    options: MatchOptions<'_>,
) -> Option<&'a Login> {
    let requested = options.requested_host.map(str::to_lowercase);
    // `new Map(... [login.name, login])`: a later login of the same name replaces the value and
    // keeps the first position.
    let mut matches: Vec<&Login> = Vec::new();
    for login in logins {
        let Some(url) = parse_remote(&login.url) else {
            continue;
        };
        if requested.as_ref().is_some_and(|host| url.host != *host) {
            continue;
        }
        let serves = if remote.ssh {
            let ssh_host = login.ssh_host.as_deref().map(str::to_lowercase);
            ssh_host.as_deref() == Some(remote.host.as_str())
                || ssh_host.as_deref() == Some(remote.hostname.as_str())
                || url.hostname == remote.hostname
        } else {
            url.host == remote.host
                && ((options.host_only && remote.path.is_empty())
                    || url.path.is_empty()
                    || remote.path == url.path
                    || remote
                        .path
                        .strip_prefix(url.path.as_str())
                        .is_some_and(|rest| rest.starts_with('/')))
        };
        if !serves {
            continue;
        }
        match matches.iter_mut().find(|known| known.name == login.name) {
            Some(slot) => *slot = login,
            None => matches.push(login),
        }
    }
    if let [only] = matches.as_slice() {
        return Some(only);
    }
    let urls: HashSet<&str> = matches.iter().map(|login| login.url.as_str()).collect();
    if urls.len() == 1 {
        matches.into_iter().find(|login| login.default == "true")
    } else {
        None
    }
}

// ---------------------------------------------------------------------------------------------
// fj's `keys.json`
// ---------------------------------------------------------------------------------------------

/// A JSON object read in key order, a repeated key keeping its first place and last value.
#[derive(Debug)]
struct Ordered<T>(Vec<(String, T)>);

impl<T> Default for Ordered<T> {
    fn default() -> Self {
        Self(Vec::new())
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Ordered<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visit<T>(std::marker::PhantomData<T>);
        impl<'de, T: Deserialize<'de>> de::Visitor<'de> for Visit<T> {
            type Value = Ordered<T>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut out: Vec<(String, T)> = Vec::new();
                let mut index: HashMap<String, usize> = HashMap::new();
                while let Some((key, value)) = map.next_entry::<String, T>()? {
                    match index.get(&key).copied().and_then(|at| out.get_mut(at)) {
                        Some(slot) => slot.1 = value,
                        None => {
                            index.insert(key.clone(), out.len());
                            out.push((key, value));
                        }
                    }
                }
                Ok(Ordered(out))
            }
        }
        deserializer.deserialize_map(Visit(std::marker::PhantomData))
    }
}

#[derive(Debug, Deserialize)]
enum KeyKind {
    Application,
    OAuth,
}

fn secret_text<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Secret, D::Error> {
    String::deserialize(deserializer).map(Secret::new)
}

#[derive(Debug, Deserialize)]
struct RawHost {
    #[serde(rename = "type")]
    _kind: KeyKind,
    #[serde(deserialize_with = "secret_text")]
    token: Secret,
}

/// `ForgejoKeysSchema`.
#[derive(Debug, Deserialize)]
struct RawKeys {
    hosts: Ordered<RawHost>,
    #[serde(default)]
    aliases: Ordered<String>,
}

#[derive(Debug, Default)]
struct Keys {
    hosts: Vec<(String, Secret)>,
    aliases: Vec<(String, String)>,
}

impl Keys {
    fn token(&self, host: &str) -> Option<&Secret> {
        self.hosts
            .iter()
            .find(|(name, _)| name == host)
            .map(|(_, token)| token)
            .filter(|token| !token.expose().is_empty())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Platform {
    Macos,
    Linux,
}

const PLATFORM: Platform = if cfg!(target_os = "macos") {
    Platform::Macos
} else {
    Platform::Linux
};

/// `forgejoKeysPaths` for macOS and Linux.
fn keys_paths(home: &Path, data_home: Option<&str>, platform: Platform) -> Vec<PathBuf> {
    match platform {
        Platform::Macos => ["forgejo-cli", "Cyborus"]
            .iter()
            .map(|organization| {
                home.join("Library")
                    .join("Application Support")
                    .join(format!("{organization}.forgejo-cli"))
                    .join("keys.json")
            })
            .collect(),
        Platform::Linux => {
            let base = data_home
                .map(Path::new)
                .filter(|dir| dir.is_absolute())
                .map_or_else(|| home.join(".local").join("share"), Path::to_path_buf);
            vec![base.join("forgejo-cli").join("keys.json")]
        }
    }
}

enum FileRead {
    Absent,
    Bytes(Vec<u8>),
    Failed,
}

/// Blocking: reads at most [`MAX_KEYS_BYTES`]; a larger file counts as unreadable.
fn read_bounded(path: &Path) -> FileRead {
    match path.try_exists() {
        Ok(false) => return FileRead::Absent,
        Ok(true) => {}
        Err(_) => return FileRead::Failed,
    }
    let Ok(file) = std::fs::File::open(path) else {
        return FileRead::Failed;
    };
    let mut bytes = Vec::new();
    if file
        .take(MAX_KEYS_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > MAX_KEYS_BYTES
    {
        return FileRead::Failed;
    }
    FileRead::Bytes(bytes)
}

/// `readKeys`: the first `keys.json` that exists, or no keys.
async fn read_keys(ctx: &DiscoveryContext<'_>) -> Result<Keys, &'static str> {
    let Some(home) = ctx.home else {
        return Ok(Keys::default());
    };
    let data_home = ctx.env.get("XDG_DATA_HOME");
    for path in keys_paths(home, data_home.as_deref(), PLATFORM) {
        let read = tokio::task::spawn_blocking(move || read_bounded(&path))
            .await
            .map_err(|_| STORAGE_UNREADABLE)?;
        match read {
            FileRead::Absent => continue,
            FileRead::Failed => return Err(STORAGE_UNREADABLE),
            FileRead::Bytes(bytes) => {
                let raw: RawKeys = serde_json::from_str(&String::from_utf8_lossy(&bytes))
                    .map_err(|_| STORAGE_INVALID)?;
                return Ok(Keys {
                    hosts: raw
                        .hosts
                        .0
                        .into_iter()
                        .map(|(name, host)| (name, host.token))
                        .collect(),
                    aliases: raw.aliases.0,
                });
            }
        }
    }
    Ok(Keys::default())
}

/// `publicLogins`: one login per fj host (one per SSH alias of it), without a user name.
fn public_logins(keys: &Keys, remote_url: Option<&str>) -> Vec<Login> {
    let remote = remote_url.and_then(parse_remote);
    let explicit_http =
        remote_url.is_some_and(|url| strip_prefix_ignore_case(url, "http://").is_some());
    let mut aliases: HashMap<&str, Vec<&str>> = HashMap::new();
    for (alias, target) in &keys.aliases {
        aliases.entry(target).or_default().push(alias);
    }
    let mut logins = Vec::new();
    for (host, _) in &keys.hosts {
        let Some(url) = parse_remote(&format!("https://{host}")) else {
            continue;
        };
        // fj 0.6 drops URL mounts during whoami and OAuth renewal; tea supports them.
        if !url.path.is_empty() {
            continue;
        }
        // fj omits the scheme in storage. Only an explicit matching HTTP remote opts into HTTP.
        let http = explicit_http
            && remote
                .as_ref()
                .is_some_and(|remote| !remote.ssh && remote.host == url.host);
        let scheme = if http { "http" } else { "https" };
        let login = Login {
            name: host.clone(),
            url: format!("{scheme}://{host}"),
            ssh_host: None,
            valid: None,
            user: String::new(),
            default: "false".into(),
        };
        match aliases.get(host.as_str()) {
            Some(names) if !names.is_empty() => logins.extend(names.iter().map(|alias| Login {
                ssh_host: Some((*alias).to_owned()),
                ..login.clone()
            })),
            _ => logins.push(login),
        }
    }
    logins
}

// ---------------------------------------------------------------------------------------------
// Children: `ForgejoCli.execute`, `listLogins`
// ---------------------------------------------------------------------------------------------

/// `ForgejoCliError`'s `detail`, and whether it has `reason: "missing-cli"`.
#[derive(Clone, Copy, Debug)]
struct CliError {
    detail: &'static str,
    missing_cli: bool,
}

type Env = [(&'static str, OsString)];

/// `ForgejoCli.execute` for `fj`: 30 s, default output bound, a non-zero exit is an error.
async fn execute_fj(cwd: &Path, env: &Env, args: &[&str]) -> Result<(), CliError> {
    let mut command = GitCommand::host_cli(OPERATION_EXECUTE, "fj", cwd, args.iter().copied())
        .timeout(EXECUTE_TIMEOUT);
    command.env = env.to_vec();
    let error = |detail, missing_cli| CliError {
        detail,
        missing_cli,
    };
    match command.run().await {
        Ok(_) => Ok(()),
        Err(ProcessError::Spawn { .. }) => Err(error(MISSING_CLI, true)),
        Err(ProcessError::Exit { stderr, .. })
            if classify_exit_detail(&stderr) == "Authentication failed." =>
        {
            Err(error(CLI_AUTHENTICATION, false))
        }
        Err(_) => Err(error(CLI_FAILED, false)),
    }
}

/// `listLogins` for `fj`. A broken `keys.json` is an error unless `fj` is not installed:
/// stale credentials of an uninstalled fj must not disable an available tea login.
async fn list_logins(
    ctx: &DiscoveryContext<'_>,
    env: &Env,
    remote_url: Option<&str>,
) -> Result<Vec<Login>, CliError> {
    match read_keys(ctx).await {
        Ok(keys) => Ok(public_logins(&keys, remote_url)),
        Err(detail) => match execute_fj(ctx.cwd, env, &["version"]).await {
            Err(CliError {
                missing_cli: true, ..
            }) => Ok(Vec::new()),
            _ => Err(CliError {
                detail,
                missing_cli: false,
            }),
        },
    }
}

// ---------------------------------------------------------------------------------------------
// The account: `getAccount`
// ---------------------------------------------------------------------------------------------

/// `authenticateFj` without the cache: fj verifies (and renews) the login, then the token is
/// read from `keys.json`.
async fn authenticate_fj(
    ctx: &DiscoveryContext<'_>,
    env: &Env,
    home: &Path,
    login: &Login,
) -> Result<Secret, CliError> {
    let failure = |detail| CliError {
        detail,
        missing_cli: false,
    };
    read_keys(ctx).await.map_err(failure)?;
    // fj reads the cwd repository even with --host and fails on an unborn branch.
    execute_fj(home, env, &["--host", &login.url, "whoami"]).await?;
    // fj owns OAuth renewal. Re-read the file after it has refreshed an expired token.
    let keys = read_keys(ctx).await.map_err(failure)?;
    keys.token(&login.name)
        .cloned()
        .ok_or_else(|| failure(NO_CREDENTIALS_AFTER_RENEWAL))
}

/// `getAccount`: the user name Forgejo reports for the saved login, or the `detail` of the
/// failure.
async fn get_account(
    ctx: &DiscoveryContext<'_>,
    env: &Env,
    home: &Path,
    base_url: &str,
) -> Result<String, String> {
    let logins = list_logins(ctx, env, Some(base_url))
        .await
        .map_err(|e| e.detail.to_owned())?;
    let wanted = base_url.trim_end_matches('/');
    let login = logins
        .iter()
        .find(|login| login.url.trim_end_matches('/') == wanted)
        .ok_or_else(|| NO_CREDENTIALS.to_owned())?;
    let token = authenticate_fj(ctx, env, home, login)
        .await
        .map_err(|e| e.detail.to_owned())?;
    let root = ctx
        .endpoints
        .forgejo_api
        .as_deref()
        .unwrap_or(&login.url)
        .trim_end_matches('/');
    fetch_login(root, &token).await
}

fn split_origin(url: &str) -> Option<(&str, &str)> {
    let (_, after) = url.split_once("://")?;
    let offset = url.len() - after.len();
    let end = after.find('/').unwrap_or(after.len());
    Some((url.get(..offset + end)?, after.get(end..)?))
}

/// `apiUrl` for a `Location`: only an absolute URL or absolute path on the API's own origin,
/// under the API root, without credentials or dot segments, so the token never leaves the API.
fn redirect_target(response: &HttpResponse, current: &str, api_root: &str) -> Option<String> {
    if !matches!(response.status, 301 | 302 | 307 | 308) {
        return None;
    }
    let location = response.header("location").filter(|l| !l.is_empty())?;
    let (current_origin, _) = split_origin(current)?;
    let candidate = if location.contains("://") {
        location.to_owned()
    } else if location.starts_with('/') && !location.starts_with("//") {
        format!("{current_origin}{location}")
    } else {
        return None;
    };
    let candidate = candidate.split('#').next()?.to_owned();
    let (origin, rest) = split_origin(&candidate)?;
    let (root_origin, root_path) = split_origin(api_root)?;
    let path = rest.split('?').next()?;
    let dotted = path.split('/').any(|segment| {
        let lower = segment.to_ascii_lowercase().replace("%2e", ".");
        lower == "." || lower == ".."
    });
    (origin.eq_ignore_ascii_case(root_origin)
        && !origin.contains('@')
        && path.starts_with(root_path)
        && !dotted)
        .then_some(candidate)
}

/// `requestFj` for `user`, then the account decode: the `login` Forgejo reports, or the
/// `detail` of the failure.
async fn fetch_login(base: &str, token: &Secret) -> Result<String, String> {
    match tokio::time::timeout(EXECUTE_TIMEOUT, request_user(base, token)).await {
        Ok(result) => result,
        Err(_) => Err(REQUEST_FAILED.to_owned()),
    }
}

async fn request_user(base: &str, token: &Secret) -> Result<String, String> {
    let api_root = format!("{base}/api/v1/");
    let send = |url: String| {
        let request = HttpRequest::new(Method::Get, url).secret_header(
            "authorization",
            "token ",
            token.clone(),
        );
        async move {
            http::send(request)
                .await
                .map_err(|_| REQUEST_FAILED.to_owned())
        }
    };
    let mut url = format!("{api_root}user");
    let mut response = send(url.clone()).await?;
    // Forgejo redirects a renamed repository's API paths; the same request is re-sent.
    for _ in 0..5 {
        let Some(next) = redirect_target(&response, &url, &api_root) else {
            break;
        };
        url = next;
        response = send(url.clone()).await?;
    }
    let status = response.status;
    let text = if matches!(status, 204 | 205) {
        String::new()
    } else if response.truncated {
        return Err(INVALID_RESPONSE.to_owned());
    } else {
        String::from_utf8(response.body).map_err(|_| INVALID_RESPONSE.to_owned())?
    };
    if !(200..300).contains(&status) {
        return Err(if status == 404 {
            "Forgejo repository or pull request was not found.".to_owned()
        } else if text.is_empty() {
            format!(
                "Forgejo API request failed (HTTP {status}). Check this server's fj credentials and permissions."
            )
        } else {
            format!("Forgejo API request failed (HTTP {status}): {text}")
        });
    }
    #[derive(Deserialize)]
    struct User {
        login: String,
    }
    serde_json::from_str::<User>(&text)
        .ok()
        .filter(|user| !user.login.trim().is_empty())
        .map(|user| user.login)
        .ok_or_else(|| INVALID_ACCOUNT.to_owned())
}

// ---------------------------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------------------------

/// `discovery` (the `tea` spec).
fn tea_spec() -> CliSpec {
    CliSpec {
        kind: KIND,
        label: LABEL,
        executable: "tea",
        version_args: &["--version"],
        auth_args: vec![
            "login".into(),
            "status".into(),
            "--output".into(),
            "json".into(),
        ],
        auth_retry_args: None,
        probe_timeout: DEFAULT_PROBE_TIMEOUT,
        install_hint: INSTALL_HINT,
    }
}

/// The `fj` spec `makeDiscovery` derives from `discovery`.
fn fj_spec(login: Option<&Login>) -> CliSpec {
    CliSpec {
        executable: "fj",
        version_args: &["version"],
        auth_args: match login {
            Some(login) => vec!["--host".into(), login.url.clone(), "whoami".into()],
            None => vec!["auth".into(), "list".into()],
        },
        ..tea_spec()
    }
}

fn default_login(logins: &[Login]) -> Option<&Login> {
    logins
        .iter()
        .find(|login| login.default == "true")
        .or_else(|| logins.first())
}

/// `discovery.parseAuth`, for `tea login status --output json`.
fn parse_tea_auth(output: &ProbeOutput) -> SourceControlProviderAuth {
    let logins = parse_logins(&output.stdout);
    match default_login(&logins) {
        Some(login) => provider_auth(
            if login.valid.as_deref() == Some("true") {
                ServerProviderAuthStatus::Authenticated
            } else {
                ServerProviderAuthStatus::Unauthenticated
            },
            Some(&login.user),
            remote_host(&login.url).as_deref(),
            None,
        ),
        None => provider_auth(
            ServerProviderAuthStatus::Unauthenticated,
            None,
            None,
            Some("Run `tea login add` to authenticate a Forgejo or Gitea server."),
        ),
    }
}

/// `parseAuth` of the `fj` spec: `credentials_read` is whether `listLogins` succeeded.
fn parse_fj_auth(
    output: &ProbeOutput,
    credentials_read: bool,
    login: Option<&Login>,
) -> SourceControlProviderAuth {
    use ServerProviderAuthStatus::{Authenticated, Unauthenticated, Unknown};
    if !credentials_read {
        return provider_auth(
            Unknown,
            None,
            None,
            Some("Could not read fj authentication storage. Authenticate again with fj."),
        );
    }
    match login {
        Some(login) if output.exit_code == 0 => provider_auth(
            Authenticated,
            Some(&login.user),
            remote_host(&login.url).as_deref(),
            None,
        ),
        // fj prints this for transport failures (TLS, connect, DNS), never for a rejected token.
        Some(login) if output.stderr.contains("error sending request for url") => provider_auth(
            Unknown,
            None,
            remote_host(&login.url).as_deref(),
            Some(&format!(
                "Could not reach {} to verify the fj login.",
                login.url
            )),
        ),
        _ => provider_auth(
            Unauthenticated,
            None,
            None,
            Some("Authenticate this server with `fj --host <server-url> auth add-token`."),
        ),
    }
}

/// `git remote get-url origin` (5 s, 8000 bytes), or `""` when it fails in any way.
async fn origin_url(ctx: &DiscoveryContext<'_>, env: &Env) -> String {
    let mut command = GitCommand::new(OPERATION_REMOTE, ctx.cwd, ["remote", "get-url", "origin"])
        .timeout(REMOTE_TIMEOUT)
        .max_stdout(PROBE_MAX_BYTES, OnLimit::Fail)
        .allow_exit(ALL_EXIT_CODES);
    command.env = env.to_vec();
    match command.run().await {
        Ok(output) => String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        Err(_) => String::new(),
    }
}

/// `makeDiscovery(...).probe`.
pub async fn discover(ctx: DiscoveryContext<'_>) -> SourceControlProviderDiscoveryItem {
    let env = ctx.probe_env(&[]);
    let remote_url = origin_url(&ctx, &env).await;
    let remote_hint = Some(remote_url.as_str()).filter(|url| !url.is_empty());
    let credentials = list_logins(&ctx, &env, remote_hint).await;
    let logins = credentials.as_deref().unwrap_or_default();
    let login = parse_remote(&remote_url)
        .and_then(|remote| match_login(logins, &remote, MatchOptions::default()))
        .or_else(|| default_login(logins));
    // fj reads the cwd repository even with --host and fails on an unborn branch.
    let home = ctx.home.unwrap_or(ctx.cwd);
    let credentials_read = credentials.is_ok();
    let fj = probe_cli(
        ProbeContext {
            cwd: home,
            env: &env,
        },
        &fj_spec(login),
        |output| parse_fj_auth(output, credentials_read, login),
    )
    .await;
    if fj.status == SourceControlDiscoveryStatus::Available
        && (login.is_some() || !credentials_read)
    {
        let Some(login) =
            login.filter(|_| fj.auth.status == ServerProviderAuthStatus::Authenticated)
        else {
            return fj;
        };
        let host = remote_host(&login.url);
        let auth = match get_account(&ctx, &env, home, &login.url).await {
            Ok(account) => provider_auth(
                ServerProviderAuthStatus::Authenticated,
                Some(&account),
                host.as_deref(),
                None,
            ),
            Err(detail) => provider_auth(
                ServerProviderAuthStatus::Unknown,
                None,
                host.as_deref(),
                Some(&detail),
            ),
        };
        return SourceControlProviderDiscoveryItem { auth, ..fj };
    }
    let tea = probe_cli(
        ProbeContext {
            cwd: ctx.cwd,
            env: &env,
        },
        &tea_spec(),
        parse_tea_auth,
    )
    .await;
    // Discovery keeps the install hint only for an absent executable; a slow or broken fj
    // explains itself better than tea's install advice.
    let fj_absent =
        fj.status == SourceControlDiscoveryStatus::Missing && fj.install_hint == INSTALL_HINT;
    if tea.status == SourceControlDiscoveryStatus::Available || fj_absent {
        tea
    } else {
        fj
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::{
        discovery::{first_non_empty_line, none, some, stub::StubDir},
        hosts::{Endpoints, Environment},
        http::fake,
        settings::Settings,
    };

    // --- fixtures ---------------------------------------------------------------------------

    /// A temporary home folder, removed at the end. Tests never read a real fj keys file.
    struct TempHome {
        dir: PathBuf,
    }

    impl TempHome {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "conn-sc-forgejo-home-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).expect("home");
            Self {
                dir: dir.canonicalize().expect("canonical home"),
            }
        }

        fn keys_path(&self) -> PathBuf {
            keys_paths(&self.dir, None, PLATFORM)
                .into_iter()
                .next()
                .expect("a keys path")
        }

        fn write_keys(&self, json: &str) {
            let path = self.keys_path();
            std::fs::create_dir_all(path.parent().expect("parent")).expect("keys dir");
            std::fs::write(path, json).expect("keys");
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    const KEYS: &str =
        r#"{"hosts":{"forgejo.local:3000":{"type":"Application","token":"fj-token"}}}"#;
    const HTTP_REMOTE: &str = "http://forgejo.local:3000/maria/project.git";

    /// A stub that also records its working folder in `<name>.cwd`.
    fn stub(stubs: &StubDir, name: &str, body: &str) {
        let cwd_log = stubs.dir.join(format!("{name}.cwd"));
        let body = format!("pwd -P >> '{}'\n{body}", cwd_log.display());
        stubs.executable(
            name,
            &["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"],
            &body,
        );
    }

    fn cwd_of(stubs: &StubDir, name: &str) -> String {
        std::fs::read_to_string(stubs.dir.join(format!("{name}.cwd"))).unwrap_or_default()
    }

    fn git_stub(stubs: &StubDir, stdout: &str, exit: i32) {
        stub(
            stubs,
            "git",
            &format!("printf '%s' '{stdout}'; exit {exit}"),
        );
    }

    const FJ_OK: &str = "case \"$1\" in version) echo 'fj 0.10.0';; *) exit 0;; esac";
    const TEA_OK: &str = r#"if [ "$1" = --version ]; then echo 'tea version 0.16.0'; else echo '[{"name":"work","url":"http://forgejo.local:3000","user":"maria","default":"true","valid":"true"}]'; fi"#;

    /// `PATH` is the stub folder alone: a real `git`, `fj` or `tea` on the machine never answers.
    fn only_stubs(stubs: &StubDir) -> Vec<(&'static str, OsString)> {
        vec![("PATH", OsString::from(&stubs.dir))]
    }

    async fn run(
        stubs: &StubDir,
        home: &TempHome,
        endpoints: &Endpoints,
    ) -> SourceControlProviderDiscoveryItem {
        let settings = Settings::default();
        let env = Environment::fixed(Vec::<(&str, &str)>::new());
        let child_env = only_stubs(stubs);
        discover(DiscoveryContext {
            cwd: &stubs.dir,
            home: Some(&home.dir),
            settings: &settings,
            env: &env,
            endpoints,
            child_env: &child_env,
        })
        .await
    }

    fn detail(text: &str) -> conn_contract::VcsDiscoveryItemDetail {
        some(text)
    }

    fn login(name: &str, url: &str, ssh_host: Option<&str>, default: &str) -> Login {
        Login {
            name: name.into(),
            url: url.into(),
            ssh_host: ssh_host.map(Into::into),
            valid: None,
            user: "maria".into(),
            default: default.into(),
        }
    }

    fn remote(value: &str) -> Remote {
        parse_remote(value).expect("a remote")
    }

    fn output(stdout: &str) -> ProbeOutput {
        ProbeOutput {
            stdout: stdout.into(),
            stderr: String::new(),
            exit_code: 0,
        }
    }

    // --- remotes and logins -----------------------------------------------------------------

    #[test]
    fn parses_remotes_as_url_does() {
        let https = remote("HTTPS://Forgejo.Example.COM:443/Maria/Project.git/");
        assert_eq!(
            (https.host.as_str(), https.ssh, https.path.as_str()),
            ("forgejo.example.com", false, "Maria/Project"),
            "default port dropped, host lowercased, path trimmed"
        );
        let port = remote("http://forgejo.local:3000/maria/project.git");
        assert_eq!(port.host, "forgejo.local:3000", "port kept");
        assert_eq!(port.hostname, "forgejo.local", "hostname");
        let ssh = remote("ssh://git@Forgejo.local:22/maria/project.git");
        assert_eq!(
            (ssh.host.as_str(), ssh.ssh, ssh.path.as_str()),
            (
                "Forgejo.local:22".to_lowercase().as_str(),
                true,
                "maria/project"
            ),
            "ssh keeps port 22"
        );
        let dots = remote("https://h/a/./b/../c%2E/d e");
        assert_eq!(dots.path, "a/c%2E/d%20e", "dot segments and encoding");
        assert_eq!(
            remote("https://h\\a\\b").path,
            "a/b",
            "backslash in a special URL"
        );
        assert_eq!(
            remote("https://user:pw@h.example/a?x=1#y").path,
            "a",
            "credentials, query and fragment"
        );
        for invalid in [
            "https://",
            "https://h:99999/a",
            "https://h:x/a",
            "https://a b/c",
            "ssh://u@/p",
            "",
            "/local/path",
            "forgejo.local:/abs",
            "a/b:c",
        ] {
            assert_eq!(parse_remote(invalid), None, "{invalid}");
        }
    }

    #[test]
    fn parses_scp_remotes() {
        let user = remote("git@Forgejo.local:maria/project.git");
        assert_eq!(
            (user.host.as_str(), user.hostname.as_str(), user.ssh),
            ("forgejo.local", "forgejo.local", true),
            "user form"
        );
        assert_eq!(user.path, "maria/project", ".git dropped");
        assert_eq!(
            remote("forgejo.local:maria/project.git"),
            user,
            "the user name is optional"
        );
        assert_eq!(parse_remote("a:b\nc"), None, "a line break ends `.`");
    }

    // ForgejoSourceControlProvider.test.ts: "discovers Forgejo accounts and retains the server
    // port" (parseAuth and the matching half of refineUnknownRemote).
    #[test]
    fn discovers_accounts_and_retains_the_port() {
        let json = |valid: &str| {
            format!(
                r#"[{{"name":"work","url":"http://forgejo.local:3000","ssh_host":"git.forgejo.local","user":"maria","default":"true"{valid}}}]"#
            )
        };
        let auth = parse_tea_auth(&output(&json(r#","valid":"true""#)));
        assert_eq!(
            auth.status,
            ServerProviderAuthStatus::Authenticated,
            "status"
        );
        assert_eq!(auth.account, some("maria"), "account");
        assert_eq!(auth.host, some("forgejo.local:3000"), "host keeps the port");
        let revoked = parse_tea_auth(&output(&json(r#","valid":"false""#)));
        assert_eq!(
            revoked.status,
            ServerProviderAuthStatus::Unauthenticated,
            "revoked"
        );
        assert_eq!(
            first_non_empty_line("\u{1b}[1mtea version 0.16.0\u{1b}[0m\n").as_deref(),
            Some("tea version 0.16.0"),
            "version line"
        );
        let logins = parse_logins(&json(""));
        let matched = match_login(
            &logins,
            &remote("git@git.forgejo.local:maria/project.git"),
            MatchOptions::default(),
        );
        assert_eq!(
            matched.map(|l| l.url.as_str()),
            Some("http://forgejo.local:3000"),
            "the ssh alias names the login"
        );
        let none_at_all = parse_tea_auth(&output("[]"));
        assert_eq!(
            none_at_all.status,
            ServerProviderAuthStatus::Unauthenticated,
            "no login"
        );
        assert_eq!(
            none_at_all.detail,
            detail("Run `tea login add` to authenticate a Forgejo or Gitea server."),
            "no login detail"
        );
        assert_eq!(
            parse_tea_auth(&output("not json")).status,
            ServerProviderAuthStatus::Unauthenticated,
            "not JSON"
        );
    }

    // "does not choose a default Forgejo login across ambiguous SSH server ports"
    #[test]
    fn does_not_choose_a_default_across_ambiguous_ssh_ports() {
        let one = login(
            "one",
            "http://forgejo.local:3000",
            Some("forgejo.local"),
            "true",
        );
        let two = login(
            "two",
            "http://forgejo.local:4000",
            Some("forgejo.local"),
            "false",
        );
        let logins = vec![one, two];
        let scp = remote("git@forgejo.local:maria/project.git");
        assert_eq!(
            remote("forgejo.local:maria/project.git"),
            scp,
            "the user name is optional"
        );
        let plain = MatchOptions::default();
        assert!(match_login(&logins, &scp, plain).is_none(), "ambiguous");
        let requested = |host| MatchOptions {
            requested_host: Some(host),
            host_only: false,
        };
        assert_eq!(
            match_login(&logins, &scp, requested("forgejo.local:4000")).map(|l| l.name.as_str()),
            Some("two"),
            "the requested host picks one"
        );
        assert!(
            match_login(&logins, &scp, requested("other.local:4000")).is_none(),
            "an unknown requested host"
        );
        let alias = remote("git@ssh.forgejo.local:maria/project.git");
        assert!(
            match_login(&logins, &alias, requested("forgejo.local:4000")).is_none(),
            "another alias"
        );
        let https = remote("http://forgejo.local:4000/maria/project.git");
        assert_eq!(
            match_login(&logins, &https, plain).map(|l| l.name.as_str()),
            Some("two"),
            "an http remote"
        );
        let host_only = remote("http://forgejo.local:4000");
        let only = MatchOptions {
            requested_host: None,
            host_only: true,
        };
        assert_eq!(
            match_login(&logins, &host_only, only).map(|l| l.name.as_str()),
            Some("two"),
            "host only"
        );
        let mounted: Vec<Login> = logins
            .iter()
            .map(|l| Login {
                url: format!("http://forgejo.local:4000/{}", l.name),
                ..l.clone()
            })
            .collect();
        assert!(
            match_login(&mounted, &host_only, only).is_none(),
            "mounted logins do not serve a bare host"
        );
        let same_server = vec![
            login("a", "http://forgejo.local:3000", None, "false"),
            login("b", "http://forgejo.local:3000", None, "true"),
        ];
        assert_eq!(
            match_login(&same_server, &https_3000(), plain).map(|l| l.name.as_str()),
            Some("b"),
            "one server, the default login"
        );
    }

    fn https_3000() -> Remote {
        remote("http://forgejo.local:3000/maria/project.git")
    }

    #[test]
    fn logins_must_have_the_schema_shape() {
        assert!(
            parse_logins(r#"[{"name":"a","url":"u","user":"x","default":"true","valid":null}]"#)
                .is_empty(),
            "null is not a string"
        );
        assert!(
            parse_logins(r#"[{"name":"a","url":"u","user":"x"}]"#).is_empty(),
            "default is required"
        );
        assert_eq!(
            parse_logins(r#"[{"name":"a","url":"u","user":"x","default":"true","extra":1}]"#).len(),
            1,
            "extra fields are ignored"
        );
    }

    #[test]
    fn keys_paths_follow_forgejo_keys_paths() {
        let home = Path::new("/home/maria");
        assert_eq!(
            keys_paths(home, None, Platform::Linux),
            vec![PathBuf::from(
                "/home/maria/.local/share/forgejo-cli/keys.json"
            )],
            "linux default"
        );
        assert_eq!(
            keys_paths(home, Some("/data"), Platform::Linux),
            vec![PathBuf::from("/data/forgejo-cli/keys.json")],
            "XDG_DATA_HOME"
        );
        assert_eq!(
            keys_paths(home, Some("relative"), Platform::Linux),
            keys_paths(home, None, Platform::Linux),
            "a relative XDG_DATA_HOME is ignored"
        );
        assert_eq!(
            keys_paths(home, None, Platform::Macos),
            vec![
                PathBuf::from(
                    "/home/maria/Library/Application Support/forgejo-cli.forgejo-cli/keys.json"
                ),
                PathBuf::from(
                    "/home/maria/Library/Application Support/Cyborus.forgejo-cli/keys.json"
                ),
            ],
            "macOS, both organizations"
        );
    }

    #[test]
    fn public_logins_follow_the_keys() {
        let keys: RawKeys = serde_json::from_str(
            r#"{"hosts":{
                "forgejo.local:3000":{"type":"Application","token":"a"},
                "mounted.example/sub":{"type":"OAuth","token":"b"},
                "codeberg.org":{"type":"OAuth","token":"c"}},
              "aliases":{"ssh.codeberg.org":"codeberg.org","git.codeberg.org":"codeberg.org"}}"#,
        )
        .expect("keys");
        let keys = Keys {
            hosts: keys
                .hosts
                .0
                .into_iter()
                .map(|(n, h)| (n, h.token))
                .collect(),
            aliases: keys.aliases.0,
        };
        let logins = public_logins(&keys, None);
        let rows: Vec<(&str, &str, Option<&str>)> = logins
            .iter()
            .map(|l| (l.name.as_str(), l.url.as_str(), l.ssh_host.as_deref()))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("forgejo.local:3000", "https://forgejo.local:3000", None),
                (
                    "codeberg.org",
                    "https://codeberg.org",
                    Some("ssh.codeberg.org")
                ),
                (
                    "codeberg.org",
                    "https://codeberg.org",
                    Some("git.codeberg.org")
                ),
            ],
            "URL mounts are left out, one login per alias"
        );
        let http = public_logins(&keys, Some(HTTP_REMOTE));
        assert_eq!(
            http.first().map(|l| l.url.as_str()),
            Some("http://forgejo.local:3000"),
            "an explicit matching http remote opts into http"
        );
        assert_eq!(
            http.get(1).map(|l| l.url.as_str()),
            Some("https://codeberg.org"),
            "other hosts stay https"
        );
        let ssh = public_logins(&keys, Some("git@forgejo.local:3000/maria/p.git"));
        assert_eq!(
            ssh.first().map(|l| l.url.as_str()),
            Some("https://forgejo.local:3000"),
            "an ssh remote never opts into http"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn keys_file_reads_are_bounded_and_checked() {
        let settings = Settings::default();
        let env = Environment::fixed(Vec::<(&str, &str)>::new());
        let endpoints = Endpoints::default();
        let home = TempHome::new();
        let ctx = || DiscoveryContext {
            cwd: &home.dir,
            home: Some(&home.dir),
            settings: &settings,
            env: &env,
            endpoints: &endpoints,
            child_env: &[],
        };
        assert!(
            read_keys(&ctx()).await.expect("no file").hosts.is_empty(),
            "no keys file is no keys"
        );
        home.write_keys(KEYS);
        let keys = read_keys(&ctx()).await.expect("keys");
        assert_eq!(
            keys.token("forgejo.local:3000")
                .map(|t| t.expose().to_owned()),
            Some("fj-token".to_owned()),
            "token"
        );
        for (json, why) in [
            (
                r#"{"hosts":{"h":{"type":"Other","token":"t"}}}"#,
                "unknown type",
            ),
            (r#"{"hosts":{"h":{"type":"OAuth"}}}"#, "token required"),
            (r#"{"hosts":null}"#, "hosts must be an object"),
            (r#"{"hosts":{},"aliases":null}"#, "aliases must not be null"),
            ("[]", "an array"),
            ("not json", "not JSON"),
        ] {
            home.write_keys(json);
            assert_eq!(
                read_keys(&ctx()).await.expect_err(why),
                STORAGE_INVALID,
                "{why}"
            );
        }
        home.write_keys(r#"{"hosts":{"h":{"type":"OAuth","token":"t"}},"x":"unknown field"}"#);
        assert!(
            read_keys(&ctx()).await.is_ok(),
            "unknown fields are ignored"
        );
        home.write_keys(&format!(
            r#"{{"hosts":{{}},"pad":"{}"}}"#,
            "x".repeat(1024 * 1024)
        ));
        assert_eq!(
            read_keys(&ctx()).await.expect_err("too large"),
            STORAGE_UNREADABLE,
            "a file over 1 MiB is not read"
        );
        std::fs::remove_file(home.keys_path()).expect("remove");
        std::fs::create_dir_all(home.keys_path()).expect("a directory at the path");
        assert_eq!(
            read_keys(&ctx()).await.expect_err("directory"),
            STORAGE_UNREADABLE,
            "a directory is not readable"
        );
    }

    // --- discovery with stub executables ----------------------------------------------------

    // ForgejoSourceControlProvider.test.ts: "discovers fj first and retains configured
    // authentication failures instead of switching accounts" (scenarios authenticated, revoked,
    // missing, invalid-storage), with real keys.json, stub `git`/`fj`/`tea`, a fake server.
    #[tokio::test(flavor = "current_thread")]
    async fn discovers_fj_first_and_keeps_failures() {
        for scenario in ["authenticated", "revoked", "missing", "invalid-storage"] {
            let stubs = StubDir::new("forgejo-scenarios");
            let home = TempHome::new();
            let server = fake::serve(|_| (200, r#"{"login":"maria"}"#.into())).await;
            let endpoints = Endpoints {
                forgejo_api: Some(server.base.clone()),
                ..Endpoints::default()
            };
            home.write_keys(if scenario == "invalid-storage" {
                r#"{"hosts":42}"#
            } else {
                KEYS
            });
            git_stub(&stubs, HTTP_REMOTE, 0);
            if scenario != "missing" {
                let whoami_exit = i32::from(scenario == "revoked");
                stub(
                    &stubs,
                    "fj",
                    &format!(
                        "case \"$1\" in version) echo 'fj 0.10.0';; *) exit {whoami_exit};; esac"
                    ),
                );
            }
            stub(&stubs, "tea", TEA_OK);

            let item = run(&stubs, &home, &endpoints).await;

            let expect_tea = scenario == "missing";
            assert_eq!(
                item.executable.as_deref(),
                Some(if expect_tea { "tea" } else { "fj" }),
                "{scenario}: executable"
            );
            assert_eq!(
                item.auth.status,
                match scenario {
                    "revoked" => ServerProviderAuthStatus::Unauthenticated,
                    "invalid-storage" => ServerProviderAuthStatus::Unknown,
                    _ => ServerProviderAuthStatus::Authenticated,
                },
                "{scenario}: status"
            );
            if scenario != "revoked" && scenario != "invalid-storage" {
                assert_eq!(
                    item.auth.host,
                    some("forgejo.local:3000"),
                    "{scenario}: host"
                );
            }
            assert_eq!(
                item.auth.account,
                if scenario == "authenticated" || scenario == "missing" {
                    some("maria")
                } else {
                    none()
                },
                "{scenario}: account"
            );
            assert_eq!(
                !stubs.log("tea").is_empty(),
                expect_tea,
                "{scenario}: tea runs only when fj is absent"
            );
            if scenario != "missing" {
                assert!(
                    stubs.log("fj").contains("argv version\n"),
                    "{scenario}: fj version"
                );
            }
            match scenario {
                "authenticated" => {
                    let whoami = "argv --host http://forgejo.local:3000 whoami\n";
                    assert_eq!(
                        stubs.log("fj").matches(whoami).count(),
                        2,
                        "the probe and the account check each verify the login, as a cold T3 does"
                    );
                    assert_eq!(
                        server.requests.lock().expect("lock").len(),
                        1,
                        "one request"
                    );
                }
                "invalid-storage" => {
                    assert!(
                        stubs.log("fj").contains("argv auth list\n"),
                        "no login: fj auth list"
                    );
                    assert_eq!(
                        item.auth.detail,
                        detail(
                            "Could not read fj authentication storage. Authenticate again with fj."
                        ),
                        "detail"
                    );
                    assert!(
                        server.requests.lock().expect("lock").is_empty(),
                        "no account request"
                    );
                }
                _ => {}
            }
            if scenario != "missing" {
                // The probe runs in the home folder. Only `listLogins`'s `fj version` after a
                // broken keys file runs in the server's cwd, as in T3.
                let cwds = cwd_of(&stubs, "fj");
                let in_home = cwds
                    .lines()
                    .filter(|l| Some(*l) == home.dir.to_str())
                    .count();
                let expected = if scenario == "invalid-storage" {
                    cwds.lines().count().saturating_sub(1)
                } else {
                    cwds.lines().count()
                };
                assert_eq!(
                    in_home, expected,
                    "{scenario}: fj runs in the home folder: {cwds}"
                );
            }
        }
    }

    // "explains a slow fj instead of advising an install when tea is absent", with a broken
    // `fj version` instead of a 5 s timeout.
    #[tokio::test(flavor = "current_thread")]
    async fn explains_a_broken_fj_when_tea_is_absent() {
        let stubs = StubDir::new("forgejo-broken");
        let home = TempHome::new();
        // `git` is not on the children's PATH either: no origin remote.
        stub(&stubs, "fj", "echo 'fj: broken' >&2; exit 1");
        let item = run(&stubs, &home, &Endpoints::default()).await;
        assert_eq!(item.status, SourceControlDiscoveryStatus::Missing, "status");
        assert_eq!(item.executable.as_deref(), Some("fj"), "executable");
        assert!(
            item.install_hint
                .starts_with("`fj version` exited with status 1."),
            "{}",
            item.install_hint
        );
        assert!(!item.install_hint.contains("Install"), "no install advice");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn both_absent_keeps_the_forgejo_install_hint() {
        let stubs = StubDir::new("forgejo-absent");
        let home = TempHome::new();
        let item = run(&stubs, &home, &Endpoints::default()).await;
        assert_eq!(item.status, SourceControlDiscoveryStatus::Missing, "status");
        assert_eq!(item.executable.as_deref(), Some("tea"), "tea answers");
        assert_eq!(item.install_hint, INSTALL_HINT, "verbatim hint");
        assert_eq!(item.auth.detail, detail(INSTALL_HINT), "hint as detail");
    }

    // "does not call a valid fj login on an HTTP-only server unauthenticated": with no origin
    // remote the login is https, and a transport failure is unknown, never unauthenticated.
    #[tokio::test(flavor = "current_thread")]
    async fn a_transport_failure_is_not_unauthenticated() {
        let stubs = StubDir::new("forgejo-transport");
        let home = TempHome::new();
        home.write_keys(KEYS);
        git_stub(&stubs, "", 2);
        stub(
            &stubs,
            "fj",
            r#"case "$1" in version) echo 'fj v0.7.0';; --host) case "$2" in http://*) echo 'currently signed into maria@forgejo.local:3000';; *) echo "Error: error sending request for url ($2/api/v1/user?)" >&2; exit 1;; esac;; esac"#,
        );
        let item = run(&stubs, &home, &Endpoints::default()).await;
        assert_eq!(item.executable.as_deref(), Some("fj"), "executable");
        assert_eq!(
            item.auth.status,
            ServerProviderAuthStatus::Unknown,
            "status"
        );
        assert_eq!(
            item.auth.detail,
            detail("Could not reach https://forgejo.local:3000 to verify the fj login."),
            "detail"
        );
        assert_eq!(item.auth.host, some("forgejo.local:3000"), "host");
        assert!(
            stubs
                .log("fj")
                .contains("argv --host https://forgejo.local:3000 whoami\n"),
            "the https login"
        );
    }

    // The argv, working folders and environment of `git`, `fj` and `tea`, against T3's:
    // `["remote","get-url","origin"]`, `["version"]`, `["--host", login.url, "whoami"]`,
    // `["--version"]` and `["login","status","--output","json"]`.
    #[tokio::test(flavor = "current_thread")]
    async fn runs_the_children_as_t3_does() {
        let stubs = StubDir::new("forgejo-argv");
        let home = TempHome::new();
        home.write_keys(KEYS);
        git_stub(&stubs, HTTP_REMOTE, 0);
        // A broken fj, so that tea is asked as well.
        stub(&stubs, "fj", "exit 1");
        stub(&stubs, "tea", TEA_OK);
        let item = run(&stubs, &home, &Endpoints::default()).await;
        assert_eq!(item.executable.as_deref(), Some("tea"), "tea answered");
        assert_eq!(item.version, some("tea version 0.16.0"), "tea version");
        assert_eq!(item.auth.account, some("maria"), "tea account");

        let git = stubs.log("git");
        assert!(git.contains("argv remote get-url origin\n"), "{git}");
        let fj = stubs.log("fj");
        assert!(fj.contains("argv version\n"), "{fj}");
        assert!(
            fj.contains("argv --host http://forgejo.local:3000 whoami\n"),
            "{fj}"
        );
        assert_eq!(fj.matches("argv ").count(), 2, "{fj}");
        let tea = stubs.log("tea");
        assert!(tea.contains("argv --version\n"), "{tea}");
        assert!(tea.contains("argv login status --output json\n"), "{tea}");
        assert_eq!(tea.matches("argv ").count(), 2, "{tea}");

        let server_cwd = stubs.dir.canonicalize().expect("cwd");
        assert_eq!(
            cwd_of(&stubs, "git").trim(),
            server_cwd.to_str().unwrap_or_default(),
            "git cwd"
        );
        assert_eq!(
            cwd_of(&stubs, "tea").lines().next(),
            server_cwd.to_str(),
            "tea cwd"
        );
        assert!(
            cwd_of(&stubs, "fj")
                .lines()
                .all(|l| Some(l) == home.dir.to_str()),
            "fj runs in the home folder"
        );
        for (name, log) in [("fj", &fj), ("tea", &tea)] {
            assert!(
                log.contains("env GIT_CONFIG_KEY_0=safe.bareRepository"),
                "{name}: {log}"
            );
        }
        assert!(
            git.contains("env GIT_CONFIG_KEY_0=<unset>"),
            "git itself gets no host CLI guard: {git}"
        );
    }

    // --- the account request ----------------------------------------------------------------

    // ForgejoCli `getAccount`/`requestFj`: `GET <base>/api/v1/user` with `Authorization: token <t>`.
    #[tokio::test(flavor = "current_thread")]
    async fn asks_forgejo_for_the_user_with_a_token_header() {
        let server = fake::serve(|_| (200, r#"{"login":"maria","id":7}"#.into())).await;
        let account = fetch_login(&server.base, &Secret::new("fj-token")).await;
        assert_eq!(account.as_deref(), Ok("maria"), "account");
        let requests = server.requests.lock().expect("lock").clone();
        let request = requests.first().expect("one request");
        assert_eq!(
            (request.method.as_str(), request.path.as_str()),
            ("GET", "/api/v1/user"),
            "method and path"
        );
        let header = |name: &str| {
            request
                .headers
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(
            header("authorization"),
            Some("token fj-token"),
            "header shape"
        );
        assert_eq!(requests.len(), 1, "no other request");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn names_why_the_account_could_not_be_read() {
        let cases: [(u16, &str, &str); 8] = [
            (200, r#"{"login":"  "}"#, INVALID_ACCOUNT),
            (200, r#"{"name":"maria"}"#, INVALID_ACCOUNT),
            (200, "not json", INVALID_ACCOUNT),
            (204, "", INVALID_ACCOUNT),
            (
                401,
                "",
                "Forgejo API request failed (HTTP 401). Check this server's fj credentials and permissions.",
            ),
            (
                404,
                "{}",
                "Forgejo repository or pull request was not found.",
            ),
            (500, "boom", "Forgejo API request failed (HTTP 500): boom"),
            (
                302,
                "",
                "Forgejo API request failed (HTTP 302). Check this server's fj credentials and permissions.",
            ),
        ];
        for (status, body, expected) in cases {
            let body = body.to_owned();
            let server = fake::serve(move |_| (status, body.clone())).await;
            assert_eq!(
                fetch_login(&server.base, &Secret::new("fj-token")).await,
                Err(expected.to_owned()),
                "HTTP {status}"
            );
        }
        assert_eq!(
            fetch_login("http://127.0.0.1:1", &Secret::new("fj-token")).await,
            Err(REQUEST_FAILED.to_owned()),
            "no server"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_rejected_account_request_is_unknown_with_the_failure_detail() {
        let stubs = StubDir::new("forgejo-401");
        let home = TempHome::new();
        home.write_keys(KEYS);
        git_stub(&stubs, HTTP_REMOTE, 0);
        stub(&stubs, "fj", FJ_OK);
        let server = fake::serve(|_| (401, String::new())).await;
        let endpoints = Endpoints {
            forgejo_api: Some(server.base.clone()),
            ..Endpoints::default()
        };
        let item = run(&stubs, &home, &endpoints).await;
        assert_eq!(item.executable.as_deref(), Some("fj"), "fj answers");
        assert_eq!(
            item.auth.status,
            ServerProviderAuthStatus::Unknown,
            "status"
        );
        assert_eq!(
            item.auth.detail,
            detail(
                "Forgejo API request failed (HTTP 401). Check this server's fj credentials and permissions."
            ),
            "detail"
        );
        assert_eq!(item.auth.host, some("forgejo.local:3000"), "host");
    }

    #[test]
    fn follows_redirects_only_inside_the_api() {
        let root = "http://forgejo.local:3000/api/v1/";
        let current = "http://forgejo.local:3000/api/v1/user";
        let redirect = |status, location: &str| HttpResponse {
            status,
            headers: vec![("location".into(), location.into())],
            ..HttpResponse::default()
        };
        let target =
            |status, location: &str| redirect_target(&redirect(status, location), current, root);
        assert_eq!(
            target(307, "/api/v1/repos/new/name"),
            Some("http://forgejo.local:3000/api/v1/repos/new/name".into()),
            "an absolute path"
        );
        assert_eq!(
            target(301, "http://FORGEJO.local:3000/api/v1/x?y=1#z"),
            Some("http://FORGEJO.local:3000/api/v1/x?y=1".into()),
            "an absolute URL on the origin"
        );
        for (status, location) in [
            (200, "/api/v1/x"),
            (302, "/other"),
            (302, "http://evil.example/api/v1/x"),
            (302, "http://u@forgejo.local:3000/api/v1/x"),
            (302, "/api/v1/../x"),
            (302, "/api/v1/%2E%2e/x"),
            (302, "//evil.example/api/v1/x"),
            (302, "relative"),
            (302, ""),
        ] {
            assert_eq!(target(status, location), None, "{status} {location}");
        }
        let without_location = HttpResponse {
            status: 302,
            ..HttpResponse::default()
        };
        assert_eq!(
            redirect_target(&without_location, current, root),
            None,
            "no Location"
        );
    }
}
