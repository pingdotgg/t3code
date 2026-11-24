//! The toolbar's Orbit tool, GPUI-free (`apps/web/src/laravelToolbar/orbit.ts`,
//! `apps/desktop/src/ipc/methods/orbitTool.ts`): the Orbit Instance that serves the page, its
//! processes, logs and dependencies, through the Orbit Gateway.
//!
//! Only the calls in [`OrbitCall`] exist, with integer ids and the listed query keys. Reads follow
//! the page; writes (process actions, log streams) go only to the thread's own Instance, and a
//! process action also checks that the process belongs to that Instance.

use std::time::Duration;

use serde_json::{Map, Value};
use url::Url;

pub use conn_orbit::gateway::DEFAULT_ORBIT_GATEWAY_URL;

/// `unknown`: Orbit could not observe the runtime (container Instances, for now).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessStatus {
    Running,
    Starting,
    Crashed,
    Stopped,
    Unknown,
}

impl ProcessStatus {
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Starting => "starting",
            Self::Crashed => "crashed",
            Self::Stopped => "stopped",
            Self::Unknown => "unknown",
        }
    }

    /// Processes that may be up: their actions and log follow stay available.
    #[must_use]
    pub const fn may_be_up(self) -> bool {
        matches!(self, Self::Running | Self::Starting | Self::Unknown)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessAction {
    Start,
    Stop,
    Restart,
}

impl ProcessAction {
    #[must_use]
    pub const fn word(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrbitProcess {
    pub id: i64,
    pub name: String,
    pub command: Option<String>,
    pub status: ProcessStatus,
    /// Percent of one core.
    pub cpu: Option<f64>,
    pub memory_bytes: Option<f64>,
}

#[must_use]
pub fn has_process_warning(processes: &[OrbitProcess]) -> bool {
    processes
        .iter()
        .any(|p| matches!(p.status, ProcessStatus::Crashed | ProcessStatus::Stopped))
}

/// The Orbit Instance behind the page's domain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrbitPage {
    pub domain: String,
    pub instance_id: i64,
    pub node_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dependency {
    pub id: String,
    pub name: String,
    pub version: String,
    pub constraint: Option<String>,
    pub development: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OrbitDependencies {
    pub composer: Option<Vec<Dependency>>,
    pub javascript: Option<Vec<Dependency>>,
    pub package_manager: Option<String>,
    pub composer_error: Option<String>,
    pub javascript_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogLine {
    pub id: usize,
    /// Local clock time, when the line carries a timestamp.
    pub time: Option<String>,
    pub text: String,
}

fn record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn text(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn integer(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64)
}

/// systemd and Docker report different words. When the Gateway could not observe the runtime, its
/// own `status` decides; a missing answer is never shown as a crash.
#[must_use]
pub fn process_status(data: Option<&Map<String, Value>>) -> ProcessStatus {
    let get = |key: &str| text(data.and_then(|d| d.get(key)));
    let running = |word: &str| matches!(word, "active" | "running");
    let starting =
        |word: &str| matches!(word, "activating" | "reloading" | "restarting" | "created");
    let runtime = get("runtime_status");
    let wanted = get("desired_state") == "running";
    if running(runtime) {
        return ProcessStatus::Running;
    }
    if starting(runtime) {
        return ProcessStatus::Starting;
    }
    if runtime == "failed" {
        return ProcessStatus::Crashed;
    }
    // A failed start or step matters only while the process should run.
    if wanted && (!get("error_code").is_empty() || !get("failed_step").is_empty()) {
        return ProcessStatus::Crashed;
    }
    if !matches!(runtime, "" | "unknown") {
        return if wanted {
            ProcessStatus::Crashed
        } else {
            ProcessStatus::Stopped
        };
    }
    let status = get("status");
    if running(status) {
        return ProcessStatus::Running;
    }
    if starting(status) {
        return ProcessStatus::Starting;
    }
    if status == "failed" {
        return if wanted {
            ProcessStatus::Crashed
        } else {
            ProcessStatus::Stopped
        };
    }
    if wanted {
        ProcessStatus::Unknown
    } else {
        ProcessStatus::Stopped
    }
}

/// One process of the Gateway's process list.
#[must_use]
pub fn parse_process(value: &Value) -> Option<OrbitProcess> {
    let data = value.as_object()?;
    let id = integer(data.get("id"))?;
    let name = data
        .get("name")?
        .as_str()
        .filter(|n| !n.is_empty())?
        .to_owned();
    let config = record(data.get("runtime_config"));
    let command = config
        .and_then(|c| c.get("command"))
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|command| !command.is_empty())
        .or_else(|| {
            config
                .and_then(|c| c.get("image"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        });
    Some(OrbitProcess {
        id,
        name,
        command,
        status: process_status(Some(data)),
        cpu: finite(data.get("cpu")),
        memory_bytes: finite(data.get("memory_bytes")),
    })
}

/// A journald `short-iso` line: `2026-10-02T07:24:48+00:00 beast pi-server[3099520]: message`.
fn split_journal_line(line: &str) -> Option<(&str, &str)> {
    let (stamp, rest) = line.split_once(char::is_whitespace)?;
    let bytes = stamp.as_bytes();
    let shaped = stamp.len() >= 19
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && stamp[..4].chars().all(|c| c.is_ascii_digit());
    if !shaped {
        return None;
    }
    // host, then `unit[pid]:` and the message.
    let rest = rest.trim_start();
    let (_host, rest) = rest.split_once(char::is_whitespace)?;
    let rest = rest.trim_start();
    let colon = rest.find(':')?;
    if rest[..colon].contains(char::is_whitespace) {
        return None;
    }
    let message = rest[colon + 1..]
        .strip_prefix(' ')
        .unwrap_or(&rest[colon + 1..]);
    Some((stamp, message))
}

fn local_time(stamp: &str) -> Option<String> {
    use chrono::{DateTime, Local, NaiveDateTime, TimeZone as _};
    let zoned = DateTime::parse_from_rfc3339(stamp)
        .or_else(|_| DateTime::parse_from_str(stamp, "%Y-%m-%dT%H:%M:%S%z"))
        .ok()
        .map(|time| time.with_timezone(&Local));
    let time = zoned.or_else(|| {
        NaiveDateTime::parse_from_str(stamp, "%Y-%m-%dT%H:%M:%S")
            .ok()
            .and_then(|naive| Local.from_local_datetime(&naive).single())
    })?;
    Some(time.format("%H:%M:%S").to_string())
}

/// Splits a log tail into lines, with the journal's host and unit prefix removed.
#[must_use]
pub fn parse_log_lines(log: &str) -> Vec<LogLine> {
    log.split('\n')
        .filter(|line| !line.trim().is_empty() && *line != "-- No entries --")
        .enumerate()
        .map(|(id, line)| match split_journal_line(line) {
            Some((stamp, message)) => LogLine {
                id,
                time: local_time(stamp),
                text: message.to_owned(),
            },
            None => LogLine {
                id,
                time: None,
                text: line.to_owned(),
            },
        })
        .collect()
}

const LEVELS: [&str; 8] = [
    "INFO", "WARNING", "WARN", "ERROR", "DONE", "RUNNING", "FAILED", "FAIL",
];

/// A log line cut around its level words (INFO, ERROR, ...): `(text, level)`.
#[must_use]
pub fn split_log_levels(line: &str) -> Vec<(String, Option<&'static str>)> {
    let bytes = line.as_bytes();
    let boundary = |index: usize| {
        index == 0
            || index >= bytes.len()
            || !(bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
    };
    let mut out: Vec<(String, Option<&'static str>)> = Vec::new();
    let mut plain = String::new();
    let mut i = 0;
    while i < line.len() {
        if !line.is_char_boundary(i) {
            i += 1;
            continue;
        }
        let before_ok = i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_');
        let hit = before_ok
            .then(|| {
                LEVELS
                    .iter()
                    .copied()
                    .find(|level| line[i..].starts_with(level) && boundary(i + level.len()))
            })
            .flatten();
        if let Some(level) = hit {
            if !plain.is_empty() {
                out.push((std::mem::take(&mut plain), None));
            }
            out.push((level.to_owned(), Some(level)));
            i += level.len();
        } else {
            let c = line[i..].chars().next().unwrap_or(' ');
            plain.push(c);
            i += c.len_utf8();
        }
    }
    if !plain.is_empty() {
        out.push((plain, None));
    }
    out
}

/// Decodes the saved lockfile inventory; root constraints are absent for transitive packages.
#[must_use]
pub fn parse_dependencies(value: &Value) -> OrbitDependencies {
    let data = value.as_object();
    let mut errors: [Option<String>; 2] = [None, None];
    let mut read = |slot: usize, ecosystem: &str| -> Option<Vec<Dependency>> {
        let inventory = record(data.and_then(|d| d.get(ecosystem)));
        if let Some(code) = inventory
            .and_then(|i| i.get("error_code"))
            .and_then(Value::as_str)
        {
            errors[slot] = Some(code.to_owned());
        }
        let graph =
            record(record(inventory.and_then(|i| i.get("snapshot"))).and_then(|s| s.get("graph")));
        let resolutions = graph?.get("resolutions")?.as_array()?;
        let requirements = graph
            .and_then(|g| g.get("requirements"))
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let root = |id: &str| {
            requirements.iter().filter_map(Value::as_object).find(|r| {
                r.get("from").is_some_and(Value::is_null)
                    && r.get("to").and_then(Value::as_str) == Some(id)
                    && r.get("kind").and_then(Value::as_str) == Some("dependency")
            })
        };
        Some(
            resolutions
                .iter()
                .filter_map(Value::as_object)
                .filter_map(|resolution| {
                    let name = resolution.get("name")?.as_str()?.to_owned();
                    let version = resolution.get("version")?.as_str()?.to_owned();
                    let id = resolution
                        .get("id")
                        .and_then(Value::as_str)
                        .map_or_else(|| format!("{name}@{version}"), ToOwned::to_owned);
                    let constraint = resolution
                        .get("id")
                        .and_then(Value::as_str)
                        .and_then(root)
                        .and_then(|r| r.get("constraint"))
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned);
                    let development = resolution.get("development").and_then(Value::as_bool)
                        == Some(true)
                        && resolution.get("regular").and_then(Value::as_bool) != Some(true);
                    Some(Dependency {
                        id,
                        name,
                        version,
                        constraint,
                        development,
                    })
                })
                .collect(),
        )
    };
    let composer = read(0, "composer");
    let javascript = read(1, "javascript");
    let hashes = record(
        record(
            record(record(data.and_then(|d| d.get("javascript"))).and_then(|j| j.get("snapshot")))
                .and_then(|s| s.get("source")),
        )
        .and_then(|s| s.get("file_hashes")),
    );
    let has = |file: &str| {
        hashes
            .and_then(|h| h.get(file))
            .is_some_and(|v| !v.is_null() && v != &Value::Bool(false) && v.as_str() != Some(""))
    };
    let package_manager = if has("pnpm-lock.yaml") {
        Some("pnpm")
    } else if has("bun.lock") || has("bun.lockb") {
        Some("bun")
    } else if has("yarn.lock") {
        Some("yarn")
    } else if has("package-lock.json") || has("npm-shrinkwrap.json") {
        Some("npm")
    } else {
        None
    };
    let [composer_error, javascript_error] = errors;
    OrbitDependencies {
        composer,
        javascript,
        package_manager: package_manager.map(ToOwned::to_owned),
        composer_error,
        javascript_error,
    }
}

// ─── The calls ──────────────────────────────────────────────────────────────

/// How long the Gateway may take to return a process log tail.
pub const LOG_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_LINES: u32 = 5_000;

/// Every call the Orbit tool makes (the main process's `ROUTES`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrbitCall {
    Resolve {
        domain: String,
    },
    Nodes,
    Processes {
        instance_id: i64,
    },
    ProcessLogs {
        process_id: i64,
        lines: u32,
    },
    ProcessAction {
        process_id: i64,
        action: ProcessAction,
    },
    Dependencies {
        instance_id: i64,
    },
    InstanceLogs {
        instance_id: i64,
        lines: u32,
    },
}

/// A Gateway request: method, path, query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrbitRequest {
    pub method: &'static str,
    pub path: String,
    pub query: Vec<(&'static str, String)>,
    pub timeout: Duration,
}

fn valid_domain(domain: &str) -> bool {
    let bytes = domain.as_bytes();
    !domain.is_empty()
        && domain.len() <= 253
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && domain
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

impl OrbitCall {
    /// The request, or why the call is refused (bad ids, a domain with odd characters).
    ///
    /// # Errors
    /// A message when an id is not positive, `lines` is out of range or the domain is not a name.
    pub fn request(&self) -> Result<OrbitRequest, String> {
        let id = |value: i64| {
            if value > 0 {
                Ok(value)
            } else {
                Err("That Gateway path is not allowed.".to_owned())
            }
        };
        let lines = |value: u32| {
            if (1..=MAX_LINES).contains(&value) {
                Ok(value.to_string())
            } else {
                Err("That Gateway query is not allowed.".to_owned())
            }
        };
        let request = |method, path: String, query, timeout| OrbitRequest {
            method,
            path,
            query,
            timeout,
        };
        Ok(match self {
            Self::Resolve { domain } => {
                if !valid_domain(domain) {
                    return Err("That Gateway query is not allowed.".to_owned());
                }
                request(
                    "GET",
                    "/api/v1/instances/resolve".to_owned(),
                    vec![("domain", domain.clone())],
                    DEFAULT_TIMEOUT,
                )
            }
            Self::Nodes => request(
                "GET",
                "/api/v1/nodes".to_owned(),
                Vec::new(),
                DEFAULT_TIMEOUT,
            ),
            Self::Processes { instance_id } => request(
                "GET",
                "/api/v1/processes".to_owned(),
                vec![
                    ("target_type", "instance".to_owned()),
                    ("target_id", id(*instance_id)?.to_string()),
                ],
                DEFAULT_TIMEOUT,
            ),
            Self::ProcessLogs {
                process_id,
                lines: n,
            } => request(
                "GET",
                format!("/api/v1/processes/{}/logs", id(*process_id)?),
                vec![("lines", lines(*n)?)],
                LOG_TIMEOUT,
            ),
            Self::ProcessAction { process_id, action } => request(
                "POST",
                format!("/api/v1/processes/{}/{}", id(*process_id)?, action.word()),
                Vec::new(),
                Duration::from_secs(120),
            ),
            Self::Dependencies { instance_id } => request(
                "GET",
                format!("/api/v1/instances/{}/dependencies", id(*instance_id)?),
                Vec::new(),
                DEFAULT_TIMEOUT,
            ),
            Self::InstanceLogs {
                instance_id,
                lines: n,
            } => request(
                "GET",
                format!("/api/v1/instances/{}/logs", id(*instance_id)?),
                vec![("lines", lines(*n)?)],
                DEFAULT_TIMEOUT,
            ),
        })
    }

    /// Whether the call writes: only process actions do here.
    #[must_use]
    pub const fn is_write(&self) -> bool {
        matches!(self, Self::ProcessAction { .. })
    }
}

/// Why a call failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OrbitToolError {
    #[error("{message}")]
    Api {
        status: u16,
        code: String,
        message: String,
    },
    #[error("{0}")]
    Refused(String),
    #[error("{0}")]
    Network(String),
}

impl OrbitToolError {
    #[must_use]
    pub fn is_not_found(&self) -> bool {
        matches!(self, Self::Api { status: 404, .. })
    }
}

/// The Gateway's JSON answer: `data` of a 2xx, or the API error.
///
/// # Errors
/// [`OrbitToolError::Api`] for a non-2xx status.
pub fn decode_response(status: u16, body: &str) -> Result<Value, OrbitToolError> {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    if (200..300).contains(&status) {
        return Ok(parsed
            .as_ref()
            .and_then(|v| v.get("data"))
            .cloned()
            .unwrap_or(Value::Null));
    }
    let error = parsed.as_ref().and_then(|v| v.get("error"));
    let field = |key: &str| {
        error
            .and_then(|e| e.get(key))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    };
    Err(OrbitToolError::Api {
        status,
        code: field("code").unwrap_or_else(|| format!("http.{status}")),
        message: field("message").unwrap_or_else(|| format!("Orbit answered with HTTP {status}.")),
    })
}

/// Writes go only to the thread's own Instance: the process must be in that Instance's list.
///
/// # Errors
/// [`OrbitToolError::Refused`] without an own Instance, for another Instance, or for a process
/// the own Instance does not run.
pub fn check_write(
    page_instance: i64,
    own_instance: Option<i64>,
    process_id: i64,
    own_processes: &[OrbitProcess],
) -> Result<(), OrbitToolError> {
    let refuse = |why: &str| Err(OrbitToolError::Refused(why.to_owned()));
    let Some(own) = own_instance else {
        return refuse(
            "This thread does not run in an Orbit Instance, so it cannot change another one.",
        );
    };
    if own != page_instance {
        return refuse("This page belongs to another Orbit Instance than this thread's.");
    }
    if !own_processes.iter().any(|p| p.id == process_id) {
        return refuse("That process is not part of this thread's Orbit Instance.");
    }
    Ok(())
}

/// The Gateway client of the tool. A fresh client per use is cheap; keep one for connection reuse.
#[derive(Debug, Clone)]
pub struct OrbitToolClient {
    http: reqwest::Client,
    base: Url,
}

impl OrbitToolClient {
    /// A client for [`DEFAULT_ORBIT_GATEWAY_URL`]. Redirects are off, so no answer can lead a call
    /// off the allowlist.
    ///
    /// # Errors
    /// [`OrbitToolError::Network`] when the HTTP client cannot start.
    pub fn new() -> Result<Self, OrbitToolError> {
        let base = Url::parse(DEFAULT_ORBIT_GATEWAY_URL)
            .map_err(|e| OrbitToolError::Network(e.to_string()))?;
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| OrbitToolError::Network(e.to_string()))?;
        Ok(Self { http, base })
    }

    /// Sends one allowed call and returns its `data`.
    ///
    /// # Errors
    /// Refusals, network failures and the API's errors.
    pub async fn call(&self, call: &OrbitCall) -> Result<Value, OrbitToolError> {
        let request = call.request().map_err(OrbitToolError::Refused)?;
        let mut url = self
            .base
            .join(&request.path)
            .map_err(|e| OrbitToolError::Network(e.to_string()))?;
        if !request.query.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in &request.query {
                pairs.append_pair(key, value);
            }
        }
        let method = if request.method == "POST" {
            reqwest::Method::POST
        } else {
            reqwest::Method::GET
        };
        let response = self
            .http
            .request(method, url)
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(request.timeout)
            .send()
            .await
            .map_err(network_error)?;
        let status = response.status().as_u16();
        let body = response.text().await.map_err(network_error)?;
        decode_response(status, &body)
    }

    /// The Instance behind `domain`, none for a domain Orbit does not serve.
    ///
    /// # Errors
    /// Errors other than the Gateway's 404.
    pub async fn resolve_page(&self, domain: &str) -> Result<Option<OrbitPage>, OrbitToolError> {
        let resolved = match self
            .call(&OrbitCall::Resolve {
                domain: domain.to_owned(),
            })
            .await
        {
            Ok(value) => value,
            Err(error) if error.is_not_found() => return Ok(None),
            Err(error) => return Err(error),
        };
        let Some(instance_id) = integer(resolved.get("instance_id")) else {
            return Ok(None);
        };
        let node_id = integer(resolved.get("node_id"));
        let node_name = match node_id {
            Some(node_id) => self.node_name(node_id).await,
            None => None,
        };
        Ok(Some(OrbitPage {
            domain: domain.to_owned(),
            instance_id,
            node_name,
        }))
    }

    async fn node_name(&self, node_id: i64) -> Option<String> {
        let nodes = self.call(&OrbitCall::Nodes).await.ok()?;
        nodes.as_array()?.iter().find_map(|node| {
            (integer(node.get("id")) == Some(node_id))
                .then(|| {
                    node.get("name")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                })
                .flatten()
        })
    }

    /// The processes of an Instance.
    ///
    /// # Errors
    /// Network and API errors.
    pub async fn processes(&self, instance_id: i64) -> Result<Vec<OrbitProcess>, OrbitToolError> {
        let data = self.call(&OrbitCall::Processes { instance_id }).await?;
        Ok(data
            .as_array()
            .map(|list| list.iter().filter_map(parse_process).collect())
            .unwrap_or_default())
    }

    /// The saved dependency inventory of an Instance.
    ///
    /// # Errors
    /// Network and API errors.
    pub async fn dependencies(
        &self,
        instance_id: i64,
    ) -> Result<OrbitDependencies, OrbitToolError> {
        Ok(parse_dependencies(
            &self.call(&OrbitCall::Dependencies { instance_id }).await?,
        ))
    }

    /// A process's log tail.
    ///
    /// # Errors
    /// Network and API errors.
    pub async fn process_logs(
        &self,
        process_id: i64,
        lines: u32,
    ) -> Result<String, OrbitToolError> {
        let data = self
            .call(&OrbitCall::ProcessLogs { process_id, lines })
            .await?;
        Ok(data
            .get("logs")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned())
    }

    /// The application log tail (`storage/logs/laravel.log`) of an Instance.
    ///
    /// # Errors
    /// Network and API errors.
    pub async fn instance_logs(
        &self,
        instance_id: i64,
        lines: u32,
    ) -> Result<String, OrbitToolError> {
        let data = self
            .call(&OrbitCall::InstanceLogs { instance_id, lines })
            .await?;
        Ok(data
            .get("logs")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned())
    }

    /// Starts, stops or restarts a process of the thread's own Instance.
    ///
    /// # Errors
    /// [`OrbitToolError::Refused`] by the own-Instance guard, then network and API errors.
    pub async fn act(
        &self,
        page_instance: i64,
        own_instance: Option<i64>,
        process_id: i64,
        action: ProcessAction,
    ) -> Result<(), OrbitToolError> {
        let own_processes = match own_instance {
            Some(own) if own == page_instance => self.processes(own).await?,
            _ => Vec::new(),
        };
        check_write(page_instance, own_instance, process_id, &own_processes)?;
        self.call(&OrbitCall::ProcessAction { process_id, action })
            .await
            .map(|_| ())
    }
}

fn network_error(error: reqwest::Error) -> OrbitToolError {
    if error.is_timeout() {
        OrbitToolError::Network("The Orbit Gateway did not answer in time.".to_owned())
    } else {
        OrbitToolError::Network(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn status(runtime: Option<&str>, desired: &str, extra: Value) -> ProcessStatus {
        let mut data = json!({ "desired_state": desired });
        if let Some(runtime) = runtime {
            data["runtime_status"] = json!(runtime);
        }
        for (key, value) in extra.as_object().cloned().unwrap_or_default() {
            data[key] = value;
        }
        process_status(data.as_object())
    }

    #[test]
    fn maps_systemd_and_docker_states_and_the_gateway_status_when_the_runtime_is_unobserved() {
        use ProcessStatus::{Crashed, Running, Starting, Stopped, Unknown};
        let none = json!({});
        assert_eq!(status(Some("active"), "running", none.clone()), Running);
        assert_eq!(status(Some("running"), "running", none.clone()), Running);
        assert_eq!(
            status(Some("activating"), "running", none.clone()),
            Starting
        );
        assert_eq!(status(Some("inactive"), "running", none.clone()), Crashed);
        assert_eq!(status(Some("failed"), "stopped", none.clone()), Crashed);
        assert_eq!(status(Some("inactive"), "stopped", none.clone()), Stopped);
        assert_eq!(status(Some("exited"), "stopped", none.clone()), Stopped);
        assert_eq!(
            status(Some("unknown"), "running", json!({ "status": "active" })),
            Running
        );
        assert_eq!(
            status(None, "running", json!({ "status": "active" })),
            Running
        );
        assert_eq!(status(Some("unknown"), "running", none.clone()), Unknown);
        assert_eq!(
            status(Some(""), "running", json!({ "status": null })),
            Unknown
        );
        assert_eq!(status(Some("unknown"), "stopped", none), Stopped);
        assert_eq!(
            status(Some("unknown"), "running", json!({ "status": "failed" })),
            Crashed
        );
        assert_eq!(
            status(
                Some("unknown"),
                "running",
                json!({ "error_code": "process.start_failed" })
            ),
            Crashed
        );
        assert_eq!(
            status(
                Some("unknown"),
                "running",
                json!({ "failed_step": "start" })
            ),
            Crashed
        );
        assert_eq!(
            status(
                Some("unknown"),
                "stopped",
                json!({ "error_code": "process.start_failed" })
            ),
            Stopped
        );
        assert_eq!(process_status(None), ProcessStatus::Stopped);
    }

    #[test]
    fn reads_a_process_from_the_gateways_process_list() {
        let process = parse_process(&json!({
            "id": 7, "name": "vite", "runtime_config": { "command": ["vp", "run", "dev"] },
            "desired_state": "running", "runtime_status": "active", "cpu": 1.5, "memory_bytes": 1024
        }))
        .expect("a process");
        assert_eq!(
            process,
            OrbitProcess {
                id: 7,
                name: "vite".into(),
                command: Some("vp run dev".into()),
                status: ProcessStatus::Running,
                cpu: Some(1.5),
                memory_bytes: Some(1024.0)
            }
        );
        let image = parse_process(
            &json!({ "id": 9, "name": "db", "runtime_config": { "image": "mysql:8.4" } }),
        );
        assert_eq!(image.and_then(|p| p.command).as_deref(), Some("mysql:8.4"));
        let container = parse_process(&json!({
            "id": 12, "name": "vp-dev", "runtime": "systemd", "runtime_config": { "command": ["vp", "dev"] },
            "desired_state": "running", "status": "active", "runtime_status": "unknown",
            "error_code": null, "failed_step": null, "cpu": 0.4, "memory_bytes": 2048
        }));
        assert_eq!(container.map(|p| p.status), Some(ProcessStatus::Running));
        assert_eq!(parse_process(&json!({ "name": "no id" })), None);
    }

    #[test]
    fn strips_the_journal_prefix_from_log_lines() {
        let lines = parse_log_lines(
            "2026-10-02T07:24:48+00:00 beast pi-server[3099520]: listening on 3774\nplain container line\n",
        );
        assert_eq!(
            lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(),
            ["listening on 3774", "plain container line"]
        );
        let time = lines[0].time.as_deref().unwrap_or_default();
        assert_eq!(time.len(), 8);
        assert_eq!(time.matches(':').count(), 2);
        assert_eq!(lines[1].time, None);
        assert!(parse_log_lines("-- No entries --\n").is_empty());
    }

    #[test]
    fn cuts_level_words_out_of_a_log_line() {
        assert_eq!(
            split_log_levels("worker ERROR failed job"),
            vec![
                ("worker ".to_owned(), None),
                ("ERROR".to_owned(), Some("ERROR")),
                (" failed job".to_owned(), None),
            ]
        );
        assert_eq!(
            split_log_levels("INFORMATION x"),
            vec![("INFORMATION x".to_owned(), None)]
        );
    }

    #[test]
    fn keeps_missing_scans_distinct_from_an_empty_inventory() {
        let missing = parse_dependencies(&json!({
            "composer": { "state": "unknown" },
            "javascript": { "error_code": "dependencies.read_failed" }
        }));
        assert_eq!(missing.composer, None);
        assert_eq!(missing.javascript, None);
        assert_eq!(missing.package_manager, None);
        assert_eq!(
            missing.javascript_error.as_deref(),
            Some("dependencies.read_failed")
        );
        let empty = parse_dependencies(
            &json!({ "composer": { "snapshot": { "graph": { "resolutions": [] } } } }),
        );
        assert_eq!(empty.composer, Some(Vec::new()));
    }

    #[test]
    fn matches_root_requirements_by_resolution_id_and_keeps_multiple_versions() {
        let data = parse_dependencies(&json!({
            "javascript": { "snapshot": {
                "source": { "file_hashes": { "bun.lock": "hash", "package-lock.json": null } },
                "graph": {
                    "resolutions": [
                        { "id": "vue", "name": "vue", "version": "3.5.22", "regular": true, "development": true },
                        { "id": "vue@3.4", "name": "vue", "version": "3.4.0", "regular": false, "development": true }
                    ],
                    "requirements": [
                        { "from": null, "to": "vue", "constraint": "^3.5", "kind": "dependency" },
                        { "from": "other", "to": "vue@3.4", "constraint": "^3.4", "kind": "dependency" }
                    ]
                }
            } }
        }));
        assert_eq!(data.package_manager.as_deref(), Some("bun"));
        assert_eq!(
            data.javascript,
            Some(vec![
                Dependency {
                    id: "vue".into(),
                    name: "vue".into(),
                    version: "3.5.22".into(),
                    constraint: Some("^3.5".into()),
                    development: false
                },
                Dependency {
                    id: "vue@3.4".into(),
                    name: "vue".into(),
                    version: "3.4.0".into(),
                    constraint: None,
                    development: true
                },
            ])
        );
    }

    #[test]
    fn builds_only_the_allowed_requests_with_integer_ids() {
        let resolve = OrbitCall::Resolve {
            domain: "dlf.test".into(),
        }
        .request()
        .expect("allowed");
        assert_eq!(
            (resolve.method, resolve.path.as_str()),
            ("GET", "/api/v1/instances/resolve")
        );
        assert_eq!(resolve.query, vec![("domain", "dlf.test".to_owned())]);
        let action = OrbitCall::ProcessAction {
            process_id: 4,
            action: ProcessAction::Restart,
        }
        .request()
        .expect("allowed");
        assert_eq!(
            (action.method, action.path.as_str()),
            ("POST", "/api/v1/processes/4/restart")
        );
        assert!(
            OrbitCall::Resolve {
                domain: "../x".into()
            }
            .request()
            .is_err()
        );
        assert!(
            OrbitCall::Resolve {
                domain: "a b".into()
            }
            .request()
            .is_err()
        );
        assert!(OrbitCall::Processes { instance_id: 0 }.request().is_err());
        assert!(
            OrbitCall::ProcessLogs {
                process_id: 1,
                lines: 5_001
            }
            .request()
            .is_err()
        );
        assert!(
            OrbitCall::InstanceLogs {
                instance_id: -3,
                lines: 200
            }
            .request()
            .is_err()
        );
        assert!(
            OrbitCall::ProcessAction {
                process_id: 1,
                action: ProcessAction::Stop
            }
            .is_write()
        );
        assert!(!OrbitCall::Nodes.is_write());
    }

    #[test]
    fn writes_need_the_threads_own_instance_and_a_process_of_it() {
        let process = |id| OrbitProcess {
            id,
            name: "p".into(),
            command: None,
            status: ProcessStatus::Running,
            cpu: None,
            memory_bytes: None,
        };
        let own = [process(4)];
        assert!(check_write(27, Some(27), 4, &own).is_ok());
        assert!(matches!(
            check_write(27, None, 4, &own),
            Err(OrbitToolError::Refused(_))
        ));
        assert!(matches!(
            check_write(27, Some(9), 4, &own),
            Err(OrbitToolError::Refused(_))
        ));
        assert!(matches!(
            check_write(27, Some(27), 5, &own),
            Err(OrbitToolError::Refused(_))
        ));
    }

    #[test]
    fn unwraps_data_and_reads_api_errors() {
        assert_eq!(
            decode_response(200, r#"{"data":{"a":1}}"#).ok(),
            Some(json!({ "a": 1 }))
        );
        assert_eq!(decode_response(200, "").ok(), Some(Value::Null));
        let error = decode_response(
            404,
            r#"{"error":{"code":"dependencies.target_not_found","message":"No"}}"#,
        )
        .expect_err("an error");
        assert!(error.is_not_found());
        assert_eq!(error.to_string(), "No");
        assert_eq!(
            decode_response(502, "").expect_err("an error").to_string(),
            "Orbit answered with HTTP 502."
        );
    }
}
