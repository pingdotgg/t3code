//! Cursor Origin (`packages/source-control-cursor-origin`): discovery.
//!
//! Discovery is the managed probe of `OriginSourceControlProvider.makeDiscovery`: `origin
//! --version` and `origin auth status --json`. When that says authenticated, the account becomes
//! the slug of the first `user` namespace from `GET <api>/v1/origin/namespaces`, with the
//! session token that `origin auth token` prints as the bearer (`OriginCli.personalNamespace`).
//! Any failure of that lookup leaves the account empty.
//!
//! Known difference: T3 keeps the session token for five minutes (`SESSION_TTL_MS`) and a
//! failed read for ten seconds. This server reads it on each discovery.

use std::time::Duration;

use conn_contract::{
    ServerProviderAuthStatus, SourceControlDiscoveryStatus, SourceControlProviderAuth,
    SourceControlProviderDiscoveryItem,
};
use serde_json::Value;

use super::DiscoveryContext;
use crate::{
    discovery::{
        CliSpec, DEFAULT_PROBE_TIMEOUT, ProbeCommand, ProbeContext, ProbeOutput, none, probe_cli,
        provider_auth, run_probe, some,
    },
    http::{self, HttpRequest, HttpResponse, Method},
    secret::Secret,
};

pub const KIND: &str = "cursor-origin";
const INSTALL_HINT: &str = "Install the Origin CLI with `curl -fsSL https://downloads.cursor.com/origin/install.sh | sh`, then run `origin auth login`.";
const SIGN_IN_DETAIL: &str = "Run `origin auth login` to sign in to Cursor Origin.";
const AUTH_HOST: &str = "origin.cursor.com";
/// `API_BASE_URL` in `OriginCli.ts`.
pub const DEFAULT_API_BASE: &str = "https://api.cursor.com";
/// `DEFAULT_TIMEOUT_MS` of the `origin auth token` child.
const TOKEN_TIMEOUT: Duration = Duration::from_secs(30);
/// `MAX_OUTPUT_BYTES` of the namespaces response.
const MAX_RESPONSE_BYTES: usize = 8_000_000;

fn spec() -> CliSpec {
    CliSpec {
        kind: KIND,
        label: "Cursor Origin",
        executable: "origin",
        version_args: &["--version"],
        auth_args: ["auth", "status", "--json"].map(String::from).to_vec(),
        auth_retry_args: None,
        probe_timeout: DEFAULT_PROBE_TIMEOUT,
        install_hint: INSTALL_HINT,
    }
}

/// `OriginAuthStatusSchema`: only the fields discovery reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthStatus {
    pub authenticated: bool,
    pub token_valid: Option<bool>,
    pub email: Option<String>,
}

/// `parseOriginAuthStatus`: `None` when the text is not that shape. `tokenValid` must be a
/// boolean when present; `account` may be missing or null, and so may its `email`.
pub fn parse_auth_status(raw: &str) -> Option<AuthStatus> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let object = value.as_object()?;
    let authenticated = object.get("authenticated")?.as_bool()?;
    let token_valid = match object.get("tokenValid") {
        None => None,
        Some(Value::Bool(valid)) => Some(*valid),
        Some(_) => return None,
    };
    let email = match object.get("account") {
        None | Some(Value::Null) => None,
        Some(Value::Object(account)) => match account.get("email") {
            None | Some(Value::Null) => None,
            Some(Value::String(email)) => Some(email.clone()),
            Some(_) => return None,
        },
        Some(_) => return None,
    };
    Some(AuthStatus {
        authenticated,
        token_valid,
        email,
    })
}

/// `originAccount`: the signed-in account's trimmed email.
fn origin_account(status: Option<&AuthStatus>) -> Option<&str> {
    let status = status?;
    if !status.authenticated || status.token_valid == Some(false) {
        return None;
    }
    status
        .email
        .as_deref()
        .map(str::trim)
        .filter(|email| !email.is_empty())
}

/// `discovery.parseAuth`.
pub fn parse_auth(output: &ProbeOutput) -> SourceControlProviderAuth {
    let Some(status) = parse_auth_status(&output.stdout) else {
        return provider_auth(ServerProviderAuthStatus::Unknown, None, None, None);
    };
    if status.authenticated && status.token_valid != Some(false) {
        provider_auth(
            ServerProviderAuthStatus::Authenticated,
            origin_account(Some(&status)),
            Some(AUTH_HOST),
            None,
        )
    } else {
        provider_auth(
            ServerProviderAuthStatus::Unauthenticated,
            None,
            None,
            Some(SIGN_IN_DETAIL),
        )
    }
}

/// The session token: `origin auth token` with `NO_COLOR=1`, run in the server's cwd. `None`
/// for a missing CLI, a non-zero exit or a blank answer (`currentToken`).
async fn session_token(ctx: DiscoveryContext<'_>) -> Option<Secret> {
    let mut command = ProbeCommand::new(
        "CursorOrigin.authToken",
        "origin",
        &["auth", "token"],
        ctx.cwd,
    );
    command.timeout = TOKEN_TIMEOUT;
    command.allow_non_zero_exit = true;
    command.env = ctx.probe_env(&[("NO_COLOR", "1".into())]);
    let output = run_probe(command).await.ok()?;
    if output.exit_code != 0 {
        return None;
    }
    // The probe keeps 8000 bytes of stdout; a session token is far shorter.
    Secret::non_empty(output.stdout)
}

/// `OriginCli.send`: one GET with the bearer token.
async fn get_namespaces(base: &str, token: &Secret) -> Option<HttpResponse> {
    let request = HttpRequest::new(Method::Get, format!("{base}/v1/origin/namespaces"))
        .secret_header("authorization", "Bearer ", token.clone())
        .header("accept", "application/json");
    let response = http::send(request).await.ok()?;
    (!response.truncated && response.body.len() <= MAX_RESPONSE_BYTES).then_some(response)
}

/// `OriginNamespaceListSchema` and `personalNamespace`: the slug of the first `user` namespace.
/// Every entry must have a string `slug` and `type`, or the list does not decode. A blank body
/// reads as `{}`.
fn personal_namespace_slug(body: &str) -> Option<String> {
    let body = if body.trim().is_empty() { "{}" } else { body };
    let value: Value = serde_json::from_str(body).ok()?;
    let namespaces = match value.as_object()?.get("namespaces") {
        None | Some(Value::Null) => return None,
        Some(Value::Array(entries)) => entries,
        Some(_) => return None,
    };
    let mut first_user: Option<&str> = None;
    for entry in namespaces {
        let namespace = entry.as_object()?.get("namespace")?.as_object()?;
        let slug = namespace.get("slug")?.as_str()?;
        let kind = namespace.get("type")?.as_str()?;
        if kind == "user" && first_user.is_none() {
            first_user = Some(slug);
        }
    }
    first_user
        .filter(|slug| !slug.is_empty())
        .map(str::to_owned)
}

/// `personalNamespace`: the token, one request, and on a 401 one more with a fresh token (a
/// refused token may have been rotated by `origin auth login`).
async fn personal_namespace(ctx: DiscoveryContext<'_>) -> Option<String> {
    let base = ctx
        .endpoints
        .cursor_origin_api
        .as_deref()
        .unwrap_or(DEFAULT_API_BASE);
    let token = session_token(ctx).await?;
    let mut response = get_namespaces(base, &token).await?;
    if response.status == 401 {
        let fresh = session_token(ctx).await?;
        response = get_namespaces(base, &fresh).await?;
    }
    if !(200..300).contains(&response.status) {
        return None;
    }
    personal_namespace_slug(&response.text())
}

/// `makeDiscovery(...).probe`.
pub async fn discover(ctx: DiscoveryContext<'_>) -> SourceControlProviderDiscoveryItem {
    let env = ctx.probe_env(&[]);
    let probe = ProbeContext {
        cwd: ctx.cwd,
        env: &env,
    };
    let mut item = probe_cli(probe, &spec(), parse_auth).await;
    if item.status != SourceControlDiscoveryStatus::Available
        || item.auth.status != ServerProviderAuthStatus::Authenticated
    {
        return item;
    }
    // The account is the namespace slug, which owns the repositories, not the email.
    item.auth.account = personal_namespace(ctx).await.map_or_else(none, some);
    item
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use super::*;
    use crate::{
        discovery::stub::StubDir,
        hosts::{Endpoints, Environment},
        http::fake,
        settings::Settings,
    };

    fn answer(stdout: &str) -> ProbeOutput {
        ProbeOutput {
            stdout: stdout.into(),
            stderr: String::new(),
            exit_code: 0,
        }
    }

    // No T3 test covers Origin discovery. These cases come from `parseAuth`,
    // `OriginAuthStatusSchema` and `originAccount`.
    #[test]
    fn parses_the_auth_status_as_the_schema_does() {
        let signed_in = parse_auth(&answer(
            r#"{"authenticated":true,"tokenValid":true,"account":{"email":" me@example.test "},"extra":1}"#,
        ));
        assert_eq!(signed_in.status, ServerProviderAuthStatus::Authenticated);
        assert_eq!(signed_in.account, some("me@example.test"), "trimmed email");
        assert_eq!(signed_in.host, some("origin.cursor.com"));
        assert_eq!(signed_in.detail, none());

        // `tokenValid` missing counts as valid; a missing account is still signed in.
        let no_account = parse_auth(&answer(r#"{"authenticated":true,"account":null}"#));
        assert_eq!(no_account.status, ServerProviderAuthStatus::Authenticated);
        assert_eq!(no_account.account, none());
        let blank_email = parse_auth(&answer(
            r#"{"authenticated":true,"account":{"email":"  "}}"#,
        ));
        assert_eq!(blank_email.account, none());

        for stdout in [
            r#"{"authenticated":false}"#,
            r#"{"authenticated":true,"tokenValid":false,"account":{"email":"a@b.c"}}"#,
        ] {
            let auth = parse_auth(&answer(stdout));
            assert_eq!(
                auth.status,
                ServerProviderAuthStatus::Unauthenticated,
                "{stdout}"
            );
            assert_eq!(auth.detail, some(SIGN_IN_DETAIL), "{stdout}");
            assert_eq!(auth.account, none(), "{stdout}");
            assert_eq!(auth.host, none(), "{stdout}");
        }

        for stdout in [
            "",
            "not json",
            "[]",
            r#"{"tokenValid":true}"#,
            r#"{"authenticated":"yes"}"#,
            r#"{"authenticated":true,"tokenValid":null}"#,
            r#"{"authenticated":true,"account":"me"}"#,
            r#"{"authenticated":true,"account":{"email":3}}"#,
        ] {
            let auth = parse_auth(&answer(stdout));
            assert_eq!(auth.status, ServerProviderAuthStatus::Unknown, "{stdout}");
            assert_eq!(auth.detail, none(), "{stdout}");
        }
    }

    #[test]
    fn picks_the_first_user_namespace() {
        let slug = |body: &str| personal_namespace_slug(body);
        assert_eq!(
            slug(
                r#"{"namespaces":[{"namespace":{"slug":"acme","type":"org"}},{"namespace":{"slug":"me","type":"user"}},{"namespace":{"slug":"me2","type":"user"}}]}"#
            ),
            Some("me".into())
        );
        assert_eq!(
            slug(r#"{"namespaces":[{"namespace":{"slug":"acme","type":"org"}}]}"#),
            None
        );
        assert_eq!(slug(r#"{"namespaces":null}"#), None);
        assert_eq!(slug("{}"), None);
        assert_eq!(slug(""), None, "a blank body reads as {{}}");
        assert_eq!(
            slug(
                r#"{"namespaces":[{"namespace":{"slug":"","type":"user"}},{"namespace":{"slug":"me","type":"user"}}]}"#
            ),
            None,
            "an empty slug on the first user fails, as `slug ?` does"
        );
        assert_eq!(
            slug(
                r#"{"namespaces":[{"namespace":{"slug":"me","type":"user"}},{"namespace":{"slug":"x"}}]}"#
            ),
            None,
            "one entry that does not decode fails the list"
        );
    }

    const SIGNED_IN: &str =
        r#"{"authenticated":true,"tokenValid":true,"account":{"email":"me@example.test"}}"#;

    /// An `origin` that answers each command and records `NO_COLOR`.
    fn origin(stubs: &StubDir, status_json: &str, token_exit: u8) -> String {
        stubs.executable(
            "origin",
            &["NO_COLOR"],
            &format!(
                "case \"$1\" in --version) echo 'origin 0.9.1';; auth) case \"$2\" in status) echo '{status_json}';; token) echo '  fake-origin-token  '; exit {token_exit};; esac;; esac"
            ),
        )
    }

    async fn run(stubs: &StubDir, base: Option<&str>) -> SourceControlProviderDiscoveryItem {
        let settings = Settings::default();
        let env = Environment::fixed([]);
        let endpoints = Endpoints {
            cursor_origin_api: base.map(str::to_owned),
            ..Endpoints::default()
        };
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

    fn header<'a>(request: &'a fake::Recorded, name: &str) -> Option<&'a str> {
        request
            .headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    const NAMESPACES: &str = r#"{"namespaces":[{"namespace":{"slug":"acme","type":"org"}},{"namespace":{"slug":"nick","type":"user"}}]}"#;

    #[tokio::test(flavor = "current_thread")]
    async fn the_account_is_the_personal_namespace_slug() {
        let stubs = StubDir::new("origin-ok");
        let _origin = origin(&stubs, SIGNED_IN, 0);
        let server = fake::serve(|_| (200, NAMESPACES.into())).await;
        let item = run(&stubs, Some(&server.base)).await;

        assert_eq!(item.status, SourceControlDiscoveryStatus::Available);
        assert_eq!(item.kind, "cursor-origin");
        assert_eq!(item.label, "Cursor Origin");
        assert_eq!(item.version, some("origin 0.9.1"));
        assert_eq!(item.install_hint, INSTALL_HINT);
        assert_eq!(item.auth.status, ServerProviderAuthStatus::Authenticated);
        assert_eq!(item.auth.account, some("nick"), "the slug, not the email");
        assert_eq!(item.auth.host, some("origin.cursor.com"));

        let requests = server.requests.lock().expect("lock").clone();
        assert_eq!(requests.len(), 1);
        let request = requests.first().expect("one request");
        assert_eq!(
            (request.method.as_str(), request.path.as_str()),
            ("GET", "/v1/origin/namespaces")
        );
        assert_eq!(
            header(request, "authorization"),
            Some("Bearer fake-origin-token")
        );
        assert_eq!(header(request, "accept"), Some("application/json"));

        let log = stubs.log("origin");
        assert!(log.contains("argv --version\n"), "{log}");
        assert!(log.contains("argv auth status --json\n"), "{log}");
        assert!(log.contains("argv auth token\n  env NO_COLOR=1\n"), "{log}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_failed_lookup_leaves_the_account_empty() {
        // No user namespace, an HTTP error, an unreadable body, a failing token command.
        let cases: [(&str, u16, &str, u8); 4] = [
            (
                "no user",
                200,
                r#"{"namespaces":[{"namespace":{"slug":"acme","type":"org"}}]}"#,
                0,
            ),
            ("http error", 500, r#"{"message":"boom"}"#, 0),
            ("bad body", 200, "not json", 0),
            ("no token", 200, NAMESPACES, 1),
        ];
        for (name, status, body, token_exit) in cases {
            let stubs = StubDir::new("origin-fail");
            let _origin = origin(&stubs, SIGNED_IN, token_exit);
            let body = body.to_owned();
            let server = fake::serve(move |_| (status, body.clone())).await;
            let item = run(&stubs, Some(&server.base)).await;
            assert_eq!(
                item.auth.status,
                ServerProviderAuthStatus::Authenticated,
                "{name}"
            );
            assert_eq!(item.auth.account, none(), "{name}");
            assert_eq!(item.auth.host, some("origin.cursor.com"), "{name}");
            let sent = server.requests.lock().expect("lock").len();
            assert_eq!(sent, usize::from(token_exit == 0), "{name}: requests");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_refused_token_is_read_again_once() {
        let stubs = StubDir::new("origin-401");
        let _origin = origin(&stubs, SIGNED_IN, 0);
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let server = fake::serve(move |_| {
            if seen.fetch_add(1, Ordering::SeqCst) == 0 {
                (401, r#"{"message":"expired"}"#.into())
            } else {
                (200, NAMESPACES.into())
            }
        })
        .await;
        let item = run(&stubs, Some(&server.base)).await;
        assert_eq!(item.auth.account, some("nick"));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let log = stubs.log("origin");
        assert_eq!(log.matches("argv auth token\n").count(), 2, "{log}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn no_request_unless_authenticated() {
        let server = fake::serve(|_| (200, NAMESPACES.into())).await;

        let stubs = StubDir::new("origin-out");
        let _origin = origin(&stubs, r#"{"authenticated":false}"#, 0);
        let item = run(&stubs, Some(&server.base)).await;
        assert_eq!(item.auth.status, ServerProviderAuthStatus::Unauthenticated);
        assert_eq!(item.auth.detail, some(SIGN_IN_DETAIL));
        assert_eq!(item.auth.account, none());
        assert!(!stubs.log("origin").contains("argv auth token"));

        // A CLI that is not installed.
        let empty = StubDir::new("origin-missing");
        let settings = Settings::default();
        let env = Environment::fixed([]);
        let endpoints = Endpoints {
            cursor_origin_api: Some(server.base.clone()),
            ..Endpoints::default()
        };
        let child_env: Vec<(&'static str, std::ffi::OsString)> =
            vec![("PATH", std::ffi::OsString::from(&empty.dir))];
        let missing = discover(DiscoveryContext {
            cwd: &empty.dir,
            home: None,
            settings: &settings,
            env: &env,
            endpoints: &endpoints,
            child_env: &child_env,
        })
        .await;
        assert_eq!(missing.status, SourceControlDiscoveryStatus::Missing);
        assert_eq!(missing.install_hint, INSTALL_HINT);
        assert_eq!(missing.auth.status, ServerProviderAuthStatus::Unknown);
        assert!(
            server.requests.lock().expect("lock").is_empty(),
            "no request"
        );
    }
}
