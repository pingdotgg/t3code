//! GitCafe (`packages/source-control-gitcafe`): discovery.
//!
//! Discovery is the managed probe of `GitCafeSourceControlProvider.makeDiscovery`: `cafe
//! --version` and `cafe --host https://git.cafe/api --no-input --no-update-check auth status
//! --json`. A token saved in Settings (`sourceControlHosts.gitcafe.token`) goes to both
//! children as `CAFE_TOKEN` (`GitCafeCredentials.cliEnv`). A saved token this server cannot read
//! makes the auth unauthenticated, with the error text as detail.

use std::ffi::OsString;

use conn_contract::{
    ServerProviderAuthStatus, SourceControlProviderAuth, SourceControlProviderDiscoveryItem,
};
use serde_json::Value;

use super::DiscoveryContext;
use crate::discovery::provider_auth;
use crate::discovery::{CliSpec, DEFAULT_PROBE_TIMEOUT, ProbeContext, ProbeOutput, probe_cli};

pub const KIND: &str = "gitcafe";
const AUTH_HOST: &str = "git.cafe";
const INSTALL_HINT: &str = "Install the GitCafe CLI with `bun install -g @gitcafe/cli`, then run `cafe auth login --host https://git.cafe/api`, save a token in Settings, or set CAFE_TOKEN on the server.";
const UNREADABLE_DETAIL: &str = "GitCafe authentication status could not be read. Run `cafe auth login --host https://git.cafe/api`.";

fn spec() -> CliSpec {
    CliSpec {
        kind: KIND,
        label: "GitCafe",
        executable: "cafe",
        version_args: &["--version"],
        auth_args: [
            "--host",
            "https://git.cafe/api",
            "--no-input",
            "--no-update-check",
            "auth",
            "status",
            "--json",
        ]
        .map(String::from)
        .to_vec(),
        auth_retry_args: None,
        probe_timeout: DEFAULT_PROBE_TIMEOUT,
        install_hint: INSTALL_HINT,
    }
}

/// `schemaVersion: Schema.Literal(1)`.
fn is_schema_version_one(object: &serde_json::Map<String, Value>) -> bool {
    object
        .get("schemaVersion")
        .and_then(Value::as_f64)
        .is_some_and(|v| v == 1.0)
}

/// `decodeAuth`: the signed-in username, trimmed (`TrimmedNonEmptyString`).
fn decode_auth(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    if !is_schema_version_one(object) {
        return None;
    }
    let data = object.get("data")?.as_object()?;
    data.get("host")?.as_str()?;
    let username = data.get("username")?.as_str()?.trim();
    (!username.is_empty()).then(|| username.to_owned())
}

/// What `decodeFailure` reads from a `cafe` error line.
struct Failure {
    code: String,
    message: String,
    status: Option<f64>,
}

/// `decodeFailure`: `status` must be present, a number or null.
fn decode_failure(text: &str) -> Option<Failure> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    if !is_schema_version_one(object) {
        return None;
    }
    let error = object.get("error")?.as_object()?;
    let status = match error.get("status")? {
        Value::Null => None,
        Value::Number(n) => Some(n.as_f64()?),
        _ => return None,
    };
    Some(Failure {
        code: error.get("code")?.as_str()?.to_owned(),
        message: error.get("message")?.as_str()?.to_owned(),
        status,
    })
}

/// `cliFailure`: the whole output, then its lines from the last, the first that decodes.
fn cli_failure(output: &str) -> Option<Failure> {
    std::iter::once(output.trim())
        .chain(output.split('\n').rev().map(str::trim))
        .find_map(decode_failure)
}

/// `cliDiscovery.parseAuth`.
pub fn parse_auth(output: &ProbeOutput) -> SourceControlProviderAuth {
    use ServerProviderAuthStatus::{Authenticated, Unauthenticated, Unknown};
    if output.exit_code == 0
        && let Some(username) = decode_auth(output.stdout.trim())
    {
        return provider_auth(Authenticated, Some(&username), Some(AUTH_HOST), None);
    }
    if let Some(failure) = cli_failure(&output.stderr).or_else(|| cli_failure(&output.stdout)) {
        // Forbidden/offline responses do not establish that a login is gone.
        let status = if failure.code == "AUTHENTICATION_REQUIRED" || failure.status == Some(401.0) {
            Unauthenticated
        } else {
            Unknown
        };
        return provider_auth(status, None, Some(AUTH_HOST), Some(&failure.message));
    }
    provider_auth(Unknown, None, Some(AUTH_HOST), Some(UNREADABLE_DETAIL))
}

/// `makeDiscovery(...).probe`.
pub async fn discover(ctx: DiscoveryContext<'_>) -> SourceControlProviderDiscoveryItem {
    // `credentials.cliEnv("git.cafe")`: the saved token, or the reason it cannot be read.
    // Known difference: T3 reads Settings with `getWithSecrets` on every probe, so it can
    // resolve a secret reference; this server resolves none.
    let saved = ctx.settings.host(KIND).secret_field("token").require();
    let extra: Vec<(&'static str, OsString)> = match &saved {
        Ok(Some(token)) => vec![("CAFE_TOKEN", OsString::from(token.expose()))],
        Ok(None) | Err(_) => Vec::new(),
    };
    let env = ctx.probe_env(&extra);
    let probe = ProbeContext {
        cwd: ctx.cwd,
        env: &env,
    };
    let item = probe_cli(probe, &spec(), parse_auth).await;
    match saved {
        Err(message) => SourceControlProviderDiscoveryItem {
            auth: provider_auth(
                ServerProviderAuthStatus::Unauthenticated,
                None,
                Some(AUTH_HOST),
                Some(&message),
            ),
            ..item
        },
        Ok(_) => item,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        discovery::{none, some, stub::StubDir},
        hosts::{Endpoints, Environment},
        settings::Settings,
    };
    use conn_contract::SourceControlDiscoveryStatus;

    fn answer(stdout: &str, stderr: &str, exit_code: i32) -> ProbeOutput {
        ProbeOutput {
            stdout: stdout.into(),
            stderr: stderr.into(),
            exit_code,
        }
    }

    fn failure(code: &str, status: &str) -> String {
        format!(
            r#"{{"schemaVersion":1,"error":{{"code":"{code}","status":{status},"message":"Failure {code}"}}}}"#
        )
    }

    // GitCafeSourceControlProvider.test.ts: "reads a signed-in account and keeps transient
    // failures apart from sign-out".
    #[test]
    fn reads_a_signed_in_account_and_keeps_transient_failures_apart() {
        let signed_in = parse_auth(&answer(
            r#"{"schemaVersion":1,"data":{"host":"git.cafe","username":"alice"}}"#,
            "",
            0,
        ));
        assert_eq!(signed_in.status, ServerProviderAuthStatus::Authenticated);
        assert_eq!(signed_in.account, some("alice"));
        assert_eq!(signed_in.host, some("git.cafe"));

        let signed_out = parse_auth(&answer("", &failure("AUTHENTICATION_REQUIRED", "401"), 1));
        assert_eq!(signed_out.status, ServerProviderAuthStatus::Unauthenticated);
        assert_eq!(signed_out.detail, some("Failure AUTHENTICATION_REQUIRED"));

        for (code, status) in [("FORBIDDEN", "403"), ("NETWORK_ERROR", "null")] {
            let auth = parse_auth(&answer("", &failure(code, status), 1));
            assert_eq!(auth.status, ServerProviderAuthStatus::Unknown, "{code}");
        }
    }

    // Derived from `parseAuth` (no T3 test): a 401 alone, the failure in stdout, the failure on
    // the last line of noisy output, and output that is not a failure.
    #[test]
    fn reads_failures_from_either_stream_and_any_line() {
        let by_status = parse_auth(&answer("", &failure("OTHER", "401"), 1));
        assert_eq!(by_status.status, ServerProviderAuthStatus::Unauthenticated);

        let in_stdout = parse_auth(&answer(&failure("FORBIDDEN", "403"), "", 1));
        assert_eq!(in_stdout.status, ServerProviderAuthStatus::Unknown);
        assert_eq!(in_stdout.detail, some("Failure FORBIDDEN"));

        let noisy = format!(
            "warming up\r\n{}\r\n",
            failure("AUTHENTICATION_REQUIRED", "null")
        );
        let on_last_line = parse_auth(&answer("", &noisy, 1));
        assert_eq!(
            on_last_line.status,
            ServerProviderAuthStatus::Unauthenticated
        );

        // A signed-in answer with a failing exit code is not a sign-in.
        let bad_exit = parse_auth(&answer(
            r#"{"schemaVersion":1,"data":{"host":"git.cafe","username":"alice"}}"#,
            "",
            1,
        ));
        assert_eq!(bad_exit.status, ServerProviderAuthStatus::Unknown);
        assert_eq!(bad_exit.account, none());
        assert_eq!(
            bad_exit.detail,
            some(UNREADABLE_DETAIL),
            "the fixed text, with the host"
        );
        assert_eq!(bad_exit.host, some("git.cafe"));
    }

    // Derived from the schemas: `username` is trimmed and must not be blank; `schemaVersion`
    // must be 1; a failure's `status` key must be present.
    #[test]
    fn decodes_as_the_schemas_do() {
        let padded = parse_auth(&answer(
            r#"  {"schemaVersion":1,"data":{"host":"x","username":"  alice "}}  "#,
            "",
            0,
        ));
        assert_eq!(padded.account, some("alice"), "trimmed");
        for stdout in [
            r#"{"schemaVersion":1,"data":{"host":"x","username":"  "}}"#,
            r#"{"schemaVersion":2,"data":{"host":"x","username":"alice"}}"#,
            r#"{"schemaVersion":1,"data":{"username":"alice"}}"#,
            "not json",
        ] {
            let auth = parse_auth(&answer(stdout, "", 0));
            assert_eq!(auth.status, ServerProviderAuthStatus::Unknown, "{stdout}");
        }
        let no_status =
            r#"{"schemaVersion":1,"error":{"code":"AUTHENTICATION_REQUIRED","message":"m"}}"#;
        let auth = parse_auth(&answer("", no_status, 1));
        assert_eq!(auth.status, ServerProviderAuthStatus::Unknown, "no status");
        assert_eq!(auth.detail, some(UNREADABLE_DETAIL));
    }

    /// A `cafe` that is installed and signed in, recording `CAFE_TOKEN`.
    fn signed_in_cafe(stubs: &StubDir) -> String {
        stubs.executable(
            "cafe",
            &["CAFE_TOKEN"],
            "if [ \"$1\" = --version ]; then echo 'cafe 1.2.3'; exit 0; fi; echo '{\"schemaVersion\":1,\"data\":{\"host\":\"git.cafe\",\"username\":\"alice\"}}'",
        )
    }

    async fn discover_with(
        stubs: &StubDir,
        settings_json: &str,
    ) -> SourceControlProviderDiscoveryItem {
        let settings = Settings::new(serde_json::from_str(settings_json).expect("json"));
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

    // GitCafeCredentials.test.ts: "uses a token saved in Settings ..." (`cliEnv("git.cafe")`
    // is `{CAFE_TOKEN: "saved-token"}`), checked on the two `cafe` children.
    #[tokio::test(flavor = "current_thread")]
    async fn a_saved_token_reaches_both_cafe_children() {
        let stubs = StubDir::new("gitcafe-saved");
        let _cafe = signed_in_cafe(&stubs);
        let item = discover_with(
            &stubs,
            r#"{"sourceControlHosts":{"gitcafe":{"token":"saved-token"}}}"#,
        )
        .await;
        assert_eq!(item.status, SourceControlDiscoveryStatus::Available);
        assert_eq!(item.kind, "gitcafe");
        assert_eq!(item.version, some("cafe 1.2.3"));
        assert_eq!(item.auth.status, ServerProviderAuthStatus::Authenticated);
        assert_eq!(item.auth.account, some("alice"));
        assert_eq!(item.auth.host, some("git.cafe"));
        assert_eq!(item.install_hint, INSTALL_HINT);
        let log = stubs.log("cafe");
        assert!(
            log.contains("argv --version\n  env CAFE_TOKEN=saved-token\n"),
            "{log}"
        );
        assert!(
            log.contains("argv --host https://git.cafe/api --no-input --no-update-check auth status --json\n  env CAFE_TOKEN=saved-token\n"),
            "{log}"
        );
        assert_eq!(
            log.matches("env CAFE_TOKEN=saved-token").count(),
            2,
            "{log}"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn no_saved_token_adds_no_cafe_token() {
        let stubs = StubDir::new("gitcafe-unsaved");
        let _cafe = signed_in_cafe(&stubs);
        for settings in ["{}", r#"{"sourceControlHosts":{"gitcafe":{"token":"  "}}}"#] {
            let item = discover_with(&stubs, settings).await;
            assert_eq!(item.auth.status, ServerProviderAuthStatus::Authenticated);
        }
        let log = stubs.log("cafe");
        assert!(!log.contains("saved-token"), "{log}");
        // The stub shows the child's own variable; skip the check on a host that sets one.
        if std::env::var_os("CAFE_TOKEN").is_none() {
            assert_eq!(log.matches("env CAFE_TOKEN=<unset>").count(), 4, "{log}");
        }
    }

    // `cliEnv` fails with SettingsSecretUnresolvedError: the probe runs without the token and
    // the auth becomes unauthenticated, with the error message as detail.
    #[tokio::test(flavor = "current_thread")]
    async fn an_unreadable_saved_token_is_unauthenticated() {
        let stubs = StubDir::new("gitcafe-unreadable");
        let _cafe = signed_in_cafe(&stubs);
        let item = discover_with(
            &stubs,
            r#"{"sourceControlHosts":{"gitcafe":{"token":{"provider":"vault","reference":"op://v/cafe"}}}}"#,
        )
        .await;
        assert_eq!(item.status, SourceControlDiscoveryStatus::Available);
        assert_eq!(item.auth.status, ServerProviderAuthStatus::Unauthenticated);
        assert_eq!(item.auth.account, none());
        assert_eq!(item.auth.host, some("git.cafe"));
        assert_eq!(
            item.auth.detail,
            some(
                "Could not read the credential from the secret provider \"vault\". Unlock or fix it in Settings, then try again."
            )
        );
        let log = stubs.log("cafe");
        assert!(!log.contains("op://"), "{log}");
        assert_eq!(
            log.matches("argv").count(),
            2,
            "both probes still ran: {log}"
        );
    }

    // `probeSourceControlProvider`: a `cafe` that is not installed keeps its install hint.
    #[tokio::test(flavor = "current_thread")]
    async fn a_missing_cafe_keeps_the_install_hint() {
        let stubs = StubDir::new("gitcafe-missing");
        let settings = Settings::default();
        let env = Environment::fixed([]);
        let endpoints = Endpoints::default();
        // A PATH of an empty folder only: `cafe` is not found.
        let child_env: Vec<(&'static str, OsString)> = vec![("PATH", OsString::from(&stubs.dir))];
        let item = discover(DiscoveryContext {
            cwd: &stubs.dir,
            home: None,
            settings: &settings,
            env: &env,
            endpoints: &endpoints,
            child_env: &child_env,
        })
        .await;
        assert_eq!(item.status, SourceControlDiscoveryStatus::Missing);
        assert_eq!(item.install_hint, INSTALL_HINT);
        assert_eq!(item.auth.status, ServerProviderAuthStatus::Unknown);
        assert_eq!(item.auth.detail, some(INSTALL_HINT));
    }
}
