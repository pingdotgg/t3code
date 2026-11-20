//! `conn-server environment link-orbit`: links this environment to a T3 server Orbit lists,
//! without the pairing code leaving this process, as T3's `OrbitEnvironmentLink.ts` does. As
//! its own Node, the server asks the Orbit Gateway (`/api/v1/conn`) for a one-time pairing
//! link, takes the code from it and links with [`PeerLinks`]. The code and the link never
//! reach the result, an error, a log or storage.
//!
//! Orbit knows callers by their WireGuard address, so the request carries no credential. It
//! goes through the system `curl`, as T3's `OrbitGateway.ts`: the system curl trusts the system
//! CA store, where Orbit installs its root CA.

use std::{sync::Arc, time::Duration};

use serde_json::{Value, json};

use crate::peers::{LinkInput, PeerLinkError, PeerLinks};

pub const DEFAULT_GATEWAY_URL: &str = "https://gateway.orbit";
const REQUEST_TIMEOUT_SECONDS: u64 = 60;
/// How long a pairing's Operation is followed (`OPERATION_TIMEOUT_MS`).
const OPERATION_TIMEOUT: Duration = Duration::from_secs(60);
const MIN_POLL: Duration = Duration::from_millis(500);
const MAX_POLL: Duration = Duration::from_secs(15);
/// The largest Gateway answer read (`curl` output).
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

/// `OrbitEnvironmentLinkError`: a code scripts branch on and a message that says what to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrbitLinkError {
    pub code: &'static str,
    pub message: String,
}

fn link_error(code: &'static str, message: impl Into<String>) -> OrbitLinkError {
    OrbitLinkError {
        code,
        message: message.into(),
    }
}

/// `OrbitGatewayError`: the Gateway's code, or `gateway.unreachable` /
/// `gateway.response_invalid`, and its details.
#[derive(Clone, Debug)]
struct GatewayError {
    code: String,
    details: Value,
}

fn gateway_error(code: &str) -> GatewayError {
    GatewayError {
        code: code.to_owned(),
        details: json!({}),
    }
}

/// One environment of `GET /environments`.
struct Environment {
    environment_id: String,
    label: String,
    url: String,
    status: String,
}

/// A Gateway transport: `(method, path below /api/v1/conn)` to `(status, body)`, or `Err` when
/// the Gateway could not be reached.
pub type Transport = Arc<
    dyn Fn(&'static str, String) -> conn_engine::BoxFuture<'static, Result<(u16, String), String>>
        + Send
        + Sync,
>;

/// `OrbitGateway.request` through the system curl.
pub fn curl_transport(gateway_url: &str) -> Transport {
    let base = gateway_url.trim_end_matches('/').to_owned();
    Arc::new(move |method, path| {
        let url = format!("{base}/api/v1/conn{path}");
        Box::pin(async move {
            tokio::task::spawn_blocking(move || curl(method, &url))
                .await
                .map_err(|e| e.to_string())?
        })
    })
}

fn curl(method: &str, url: &str) -> Result<(u16, String), String> {
    // A shell PATH can put another curl (e.g. Homebrew's) first.
    let binary = if std::path::Path::new("/usr/bin/curl").exists() {
        "/usr/bin/curl"
    } else {
        "curl"
    };
    let output = std::process::Command::new(binary)
        // `-q` first: no `.curlrc`, so no configured trace file ever holds a pairing link.
        .args([
            "-q",
            "-sS",
            "--max-time",
            &REQUEST_TIMEOUT_SECONDS.to_string(),
            "-X",
            method,
            "-H",
            "accept: application/json",
            "-w",
            "\n%{http_code}",
            url,
        ])
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("Could not run curl: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim().lines().last().unwrap_or_default().to_owned();
        return Err(if detail.is_empty() {
            "Orbit is not reachable from this machine.".to_owned()
        } else {
            format!("Orbit is not reachable from this machine: {detail}")
        });
    }
    if output.stdout.len() > MAX_RESPONSE_BYTES {
        return Err("Orbit answered with too much data.".to_owned());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    // curl's `-w '\n%{http_code}'`: the body, then the status on the last line.
    let (body, status) = stdout.rsplit_once('\n').unwrap_or(("", &stdout));
    let status: u16 = status
        .trim()
        .parse()
        .ok()
        .filter(|s| *s > 0)
        .ok_or_else(|| "Orbit returned no HTTP status.".to_owned())?;
    Ok((status, body.to_owned()))
}

/// The Gateway's `/api/v1/conn` client, as far as a link needs it (`createOrbitGatewayClient`).
struct Gateway {
    transport: Transport,
}

impl Gateway {
    /// One call: the envelope's `data`, or the Gateway's error.
    async fn call(&self, method: &'static str, path: String) -> Result<Value, GatewayError> {
        let (status, body) = (self.transport)(method, path)
            .await
            .map_err(|_| gateway_error("gateway.unreachable"))?;
        let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        if !(200..300).contains(&status) {
            let error = &parsed["error"];
            return Err(GatewayError {
                code: error["code"]
                    .as_str()
                    .unwrap_or("gateway.request_failed")
                    .to_owned(),
                details: error
                    .get("details")
                    .filter(|d| d.is_object())
                    .cloned()
                    .unwrap_or_else(|| json!({})),
            });
        }
        match parsed.get("data") {
            Some(data) if parsed.is_object() => Ok(data.clone()),
            _ => Err(gateway_error("gateway.response_invalid")),
        }
    }

    async fn environments(&self) -> Result<Vec<Environment>, GatewayError> {
        let data = self.call("GET", "/environments".to_owned()).await?;
        let Some(rows) = data.as_array() else {
            return Err(gateway_error("gateway.response_invalid"));
        };
        rows.iter()
            .map(|row| {
                let text = |key: &str| row[key].as_str().map(str::to_owned);
                match (
                    text("environment_id"),
                    text("label"),
                    text("url"),
                    text("status").filter(|s| s == "registered" || s == "session_expired"),
                ) {
                    (Some(environment_id), Some(label), Some(url), Some(status)) => {
                        Ok(Environment {
                            environment_id,
                            label,
                            url,
                            status,
                        })
                    }
                    _ => Err(gateway_error("gateway.response_invalid")),
                }
            })
            .collect()
    }

    /// Mints a one-time pairing link, following the Gateway's Operation. Returns the link and
    /// the environment it pairs with.
    async fn pair(&self, environment_id: &str) -> Result<(String, String), GatewayError> {
        let path = format!(
            "/environments/{}/pairings",
            conn_support::ids::encode_component(environment_id)
        );
        let mut data = self.call("POST", path.clone()).await?;
        // The Gateway mints the link in an Operation (202). Follow it, then read the link once.
        if !data["pairing_url"].is_string() {
            let operation = self.settle(data).await?;
            let Some(pairing) = operation["result"]["pairing_id"].as_u64() else {
                return Err(gateway_error("gateway.response_invalid"));
            };
            data = self.call("GET", format!("{path}/{pairing}")).await?;
        }
        match (
            data["pairing_url"].as_str(),
            data["pairing"]["environment_id"].as_str(),
            data["pairing"]["expires_at"].as_str(),
        ) {
            (Some(url), Some(environment), Some(_)) => Ok((url.to_owned(), environment.to_owned())),
            _ => Err(gateway_error("gateway.response_invalid")),
        }
    }

    /// Polls an Operation until it ends; returns it when it succeeded.
    async fn settle(&self, started: Value) -> Result<Value, GatewayError> {
        let deadline = tokio::time::Instant::now() + OPERATION_TIMEOUT;
        let mut operation = started;
        loop {
            let (Some(id), Some(status)) = (operation["id"].as_u64(), operation["status"].as_str())
            else {
                return Err(gateway_error("gateway.response_invalid"));
            };
            if status == "succeeded" {
                return Ok(operation);
            }
            if !matches!(status, "queued" | "running" | "waiting") {
                return Err(GatewayError {
                    code: operation["error_code"]
                        .as_str()
                        .unwrap_or("operation.failed")
                        .to_owned(),
                    details: json!({"operation_id": id}),
                });
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Err(GatewayError {
                    code: "operation.timeout".to_owned(),
                    details: json!({"operation_id": id}),
                });
            }
            let asked = operation["poll_after_seconds"]
                .as_f64()
                .filter(|s| s.is_finite() && *s > 0.0)
                .map_or(Duration::ZERO, |s| {
                    Duration::from_secs_f64(s.min(MAX_POLL.as_secs_f64()))
                });
            let wait = asked.clamp(MIN_POLL, MAX_POLL).min(deadline - now);
            tokio::time::sleep(wait).await;
            operation = self.call("GET", format!("/operations/{id}")).await?;
        }
    }
}

/// A Gateway failure in words an agent can act on: only codes and our own text, never the
/// Gateway's body (`gatewayFailure`).
fn gateway_failure(error: &GatewayError, environment_id: &str) -> OrbitLinkError {
    match error.code.as_str() {
        "peer.identity_unknown" | "node_access.required" => link_error(
            "node_access_required",
            format!(
                "This machine's Node may not pair with {environment_id}. Give it Node access to the Node that serves it, then try again."
            ),
        ),
        "conn.session_expired" => link_error(
            "session_expired",
            format!(
                "Orbit's session on {environment_id} expired. That server renews it when it registers again (on its next start); try again after that."
            ),
        ),
        "operation.timeout" => {
            let operation = match &error.details["operation_id"] {
                Value::Number(n) => n.to_string(),
                Value::String(s) => s.clone(),
                _ => "unknown".to_owned(),
            };
            link_error(
                "pairing_pending",
                format!(
                    "Orbit is still minting the pairing for {environment_id} (Operation {operation}). No second pairing was started. Try again in a minute; that starts a new pairing."
                ),
            )
        }
        "gateway.unreachable" => link_error(
            "gateway_unreachable",
            "The Orbit Gateway did not answer. Check this machine's WireGuard link to Orbit.",
        ),
        code => link_error(
            "pairing_failed",
            format!(
                "Orbit could not pair with {environment_id} ({code}). Check that the server runs and is registered with Orbit, then try again."
            ),
        ),
    }
}

/// `linkFailure`: a refusal from the link itself.
fn peer_failure(error: PeerLinkError) -> OrbitLinkError {
    match error.reason {
        "peer_disabled" => link_error(
            "target_links_off",
            "Linked environments is off on that server. Turn on linkedEnvironmentsEnabled in its settings (Settings → Labs), then try again.",
        ),
        "disabled" => link_error("links_off", error.message),
        // PeerLinks' own text: it names addresses and reasons, never the code.
        _ => link_error("link_failed", error.message),
    }
}

/// The one-time code in a `…/pair#token=<code>` link.
fn pairing_code(pairing_url: &str) -> Option<String> {
    let (before, fragment) = pairing_url.split_once('#')?;
    if !(before.starts_with("http://") || before.starts_with("https://")) {
        return None;
    }
    fragment
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(key, _)| *key == "token")
        .map(|(_, value)| value.trim().to_owned())
        .filter(|code| !code.is_empty())
}

/// `OrbitEnvironmentLink.link`: the link's `PeerLink` on success.
pub async fn link(
    links: &Arc<PeerLinks>,
    transport: Transport,
    environment_id: &str,
    access: &str,
) -> Result<Value, OrbitLinkError> {
    if !links.enabled() {
        return Err(link_error("links_off", conn_mcp::LINKS_OFF_HERE));
    }
    let gateway = Gateway { transport };
    let environments = gateway
        .environments()
        .await
        .map_err(|e| gateway_failure(&e, environment_id))?;
    let Some(environment) = environments
        .into_iter()
        .find(|e| e.environment_id == environment_id)
    else {
        return Err(link_error(
            "environment_not_found",
            format!(
                "Orbit lists no environment {environment_id}. Use an environment_id from conn-environment-list."
            ),
        ));
    };
    if environment.status == "session_expired" {
        return Err(gateway_failure(
            &gateway_error("conn.session_expired"),
            environment_id,
        ));
    }
    // One pairing per call: `pair` follows the Operation it starts and never starts another.
    let (pairing_url, paired) = gateway
        .pair(&environment.environment_id)
        .await
        .map_err(|e| gateway_failure(&e, environment_id))?;
    let code = pairing_code(&pairing_url).filter(|_| paired == environment.environment_id);
    let Some(code) = code else {
        return Err(link_error(
            "pairing_failed",
            "Orbit returned a pairing link this version cannot use. Update Orbit, then try again.",
        ));
    };
    // Only an address that proves to be this environment receives the code.
    links
        .link(LinkInput {
            url: environment.url,
            alternate_urls: None,
            pairing_code: code.clone(),
            access: access.to_owned(),
            expected_environment_id: Some(environment.environment_id),
            expected_label: Some(environment.label),
        })
        .await
        .map_err(|error| {
            // A peer's refusal may quote what it was sent: the code never leaves this process.
            let mut failure = peer_failure(error);
            failure.message = failure.message.replace(&code, "<pairing code>");
            failure
        })
}

/// The engine of a CLI run: links live in files, so the command needs no engine. A link never
/// records a card from the command line.
struct NoEngine;

impl conn_engine::Engine for NoEngine {
    fn dispatch(
        &self,
        _command: conn_contract::Command,
    ) -> conn_engine::BoxFuture<
        '_,
        Result<
            conn_contract::DispatchCommandResult,
            conn_engine::EngineError<conn_contract::DispatchCommandError>,
        >,
    > {
        Box::pin(std::future::ready(Err(conn_engine::EngineError::Internal(
            "no engine on the command line".into(),
        ))))
    }

    fn subscribe_shell(
        &self,
        _input: conn_contract::SubscribeShellInput,
    ) -> conn_engine::BoxFuture<
        '_,
        Result<
            conn_engine::Subscription<
                conn_contract::ShellStreamItem,
                conn_contract::GetShellSnapshotError,
            >,
            conn_engine::EngineError<conn_contract::GetShellSnapshotError>,
        >,
    > {
        Box::pin(std::future::ready(Err(conn_engine::EngineError::Internal(
            "no engine on the command line".into(),
        ))))
    }

    fn subscribe_thread(
        &self,
        _input: conn_contract::SubscribeThreadInput,
    ) -> conn_engine::BoxFuture<
        '_,
        Result<
            conn_engine::Subscription<
                conn_contract::ThreadStreamItem,
                conn_contract::GetThreadProjectionError,
            >,
            conn_engine::EngineError<conn_contract::GetThreadProjectionError>,
        >,
    > {
        Box::pin(std::future::ready(Err(conn_engine::EngineError::Internal(
            "no engine on the command line".into(),
        ))))
    }
}

/// `t3 environment link-orbit`: links from the state folder, whether or not its server runs.
/// Prints what T3's command prints; returns the exit code.
pub fn run_cli(
    state_dir: &std::path::Path,
    environment_id: &str,
    access: &str,
    gateway_url: &str,
) -> i32 {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("conn-server: cannot start: {error}");
            return 1;
        }
    };
    let environment = match crate::environment::Environment::load(
        state_dir,
        None,
        state_dir.to_owned(),
        crate::restart::Restart::default(),
    ) {
        Ok(environment) => Arc::new(environment),
        Err(error) => {
            eprintln!("could not read {}: {error}", state_dir.display());
            return 1;
        }
    };
    let links = PeerLinks::new(environment, Arc::new(NoEngine));
    let linked = runtime.block_on(link(
        &links,
        curl_transport(gateway_url),
        environment_id,
        access,
    ));
    match linked {
        Ok(link) => {
            println!(
                "Linked {} ({}) with {} access, until {}.\n",
                link["label"].as_str().unwrap_or_default(),
                link["environmentId"].as_str().unwrap_or_default(),
                link["access"].as_str().unwrap_or_default(),
                link["expiresAt"].as_str().unwrap_or_default(),
            );
            0
        }
        Err(error) => {
            // Scripts branch on the code, so it leads the message.
            eprintln!("{}: {}", error.code, error.message);
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_code_comes_from_the_fragment() {
        assert_eq!(
            pairing_code("https://h.test/pair#token=ABC"),
            Some("ABC".into())
        );
        assert_eq!(
            pairing_code("http://h.test/pair#x=1&token= C "),
            Some("C".into())
        );
        assert_eq!(pairing_code("https://h.test/pair?token=ABC"), None);
        assert_eq!(pairing_code("https://h.test/pair#token="), None);
        assert_eq!(pairing_code("pair#token=ABC"), None);
    }

    #[test]
    fn gateway_codes_become_link_codes() {
        let code = |c: &str| gateway_failure(&gateway_error(c), "env").code;
        assert_eq!(code("node_access.required"), "node_access_required");
        assert_eq!(code("peer.identity_unknown"), "node_access_required");
        assert_eq!(code("conn.session_expired"), "session_expired");
        assert_eq!(code("gateway.unreachable"), "gateway_unreachable");
        assert_eq!(code("conn.request_refused"), "pairing_failed");
        let pending = gateway_failure(
            &GatewayError {
                code: "operation.timeout".into(),
                details: json!({"operation_id": 7}),
            },
            "env",
        );
        assert_eq!(pending.code, "pairing_pending");
        assert!(pending.message.contains("Operation 7"));
    }
}
