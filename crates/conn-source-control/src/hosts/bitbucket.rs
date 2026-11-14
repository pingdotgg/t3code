//! Bitbucket (`packages/source-control-bitbucket`): discovery.
//!
//! Discovery is the `api` spec of `BitbucketSourceControlProvider.makeDiscovery`: there is no
//! CLI. `BitbucketApi.probeAuth` reads the saved credential (Settings first, then the
//! `T3CODE_BITBUCKET_*` variables) and asks `GET /user` what account it belongs to. Without a
//! credential nothing is sent, because Bitbucket answers an anonymous `/user` with 401.

use conn_contract::{
    ServerProviderAuthStatus, SourceControlProviderAuth, SourceControlProviderDiscoveryItem,
};
use conn_support::base64;
use serde_json::Value;

use super::{DiscoveryContext, Environment};
use crate::{
    discovery::{API_PROBE_TIMEOUT, api_item, provider_auth},
    http::{self, HttpRequest, Method},
    secret::Secret,
    settings::HostSettings,
};

pub const KIND: &str = "bitbucket";
const LABEL: &str = "Bitbucket";
const INSTALL_HINT: &str = "Add a Bitbucket token in Settings \u{2192} Source Control.";
const HOST: &str = "bitbucket.org";
/// `DEFAULT_API_BASE_URL`.
const DEFAULT_API_BASE_URL: &str = "https://api.bitbucket.org/2.0";
const BASE_URL_VARIABLE: &str = "T3CODE_BITBUCKET_API_BASE_URL";

/// `BitbucketCredential`.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Credential {
    AccessToken(Secret),
    ApiToken { email: String, api_token: Secret },
}

/// `HEADER_SAFE`: `/^[\x21-\x7e]+$/u`. A value with a space, a control character or a non-ASCII
/// character never reaches a header.
fn header_safe(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// `credentialFrom`. An absent value is the empty text.
fn credential_from(access_token: &str, email: &str, api_token: &str) -> Option<Credential> {
    if header_safe(access_token) {
        return Some(Credential::AccessToken(Secret::new(access_token)));
    }
    if header_safe(email) && header_safe(api_token) {
        return Some(Credential::ApiToken {
            email: email.to_owned(),
            api_token: Secret::new(api_token),
        });
    }
    None
}

fn expose(secret: Option<&Secret>) -> &str {
    secret.map_or("", Secret::expose)
}

/// `resolveCredential`: Settings, then the environment. `Err` is the unresolved secret
/// reference's message. The API token is read only when the access token is unusable.
fn resolve_credential(
    settings: &HostSettings<'_>,
    env: &Environment,
) -> Result<Option<Credential>, String> {
    let access_token = settings.secret_field("accessToken").require()?;
    let access_text = expose(access_token.as_ref());
    let api_token = if header_safe(access_text) {
        None
    } else {
        settings.secret_field("apiToken").require()?
    };
    let from_settings = credential_from(
        access_text,
        &settings.text("email"),
        expose(api_token.as_ref()),
    );
    Ok(from_settings.or_else(|| {
        let var = |name: &str| env.get(name).unwrap_or_default();
        credential_from(
            &var("T3CODE_BITBUCKET_ACCESS_TOKEN"),
            &var("T3CODE_BITBUCKET_EMAIL"),
            &var("T3CODE_BITBUCKET_API_TOKEN"),
        )
    }))
}

/// `authFromCredential`.
fn auth_from_credential(credential: Option<&Credential>) -> SourceControlProviderAuth {
    match credential {
        Some(Credential::AccessToken(_)) => provider_auth(
            ServerProviderAuthStatus::Unknown,
            None,
            Some(HOST),
            Some("An access token is configured."),
        ),
        Some(Credential::ApiToken { email, .. }) => provider_auth(
            ServerProviderAuthStatus::Unknown,
            Some(email),
            Some(HOST),
            Some("An API token is configured."),
        ),
        None => provider_auth(
            ServerProviderAuthStatus::Unauthenticated,
            None,
            Some(HOST),
            Some(
                "Add a Bitbucket token in Settings \u{2192} Source Control, or set the T3CODE_BITBUCKET_* environment variables on the server.",
            ),
        ),
    }
}

/// `BitbucketUserSchema` and `username ?? display_name ?? account_id`. Each field is absent or a
/// text with something in it once trimmed; any other value fails the decode, as it does in T3.
/// `Ok(None)` is a valid user with none of the three fields.
fn decode_account(body: &[u8]) -> Option<Option<String>> {
    let Value::Object(user) = serde_json::from_slice::<Value>(body).ok()? else {
        return None;
    };
    let mut account = None;
    for name in ["username", "display_name", "account_id"] {
        match user.get(name) {
            None => {}
            Some(Value::String(text)) if !text.trim().is_empty() => {
                account.get_or_insert_with(|| text.trim().to_owned());
            }
            Some(_) => return None,
        }
    }
    Some(account)
}

/// `apiUrl("/user")`: the base without trailing slashes, then the path.
fn user_url(env: &Environment) -> String {
    let base = env
        .get(BASE_URL_VARIABLE)
        .unwrap_or_else(|| DEFAULT_API_BASE_URL.to_owned());
    format!("{}/user", base.trim_end_matches('/'))
}

/// `config.baseUrl` without trailing slashes, for `apiUrl`.
pub(crate) fn api_base(env: &Environment) -> String {
    env.get(BASE_URL_VARIABLE)
        .unwrap_or_else(|| DEFAULT_API_BASE_URL.to_owned())
        .trim_end_matches('/')
        .to_owned()
}

/// `withAuth`: the saved credential (Settings, then the environment) as a bearer or basic
/// `authorization` header; no header without one. `Err` is an unresolved secret's message.
pub(crate) fn authorize(
    ctx: DiscoveryContext<'_>,
    request: HttpRequest,
) -> Result<HttpRequest, String> {
    let settings = ctx.settings.host(KIND);
    Ok(match resolve_credential(&settings, ctx.env)? {
        None => request,
        Some(credential) => with_credential(request, &credential),
    })
}

fn with_credential(request: HttpRequest, credential: &Credential) -> HttpRequest {
    match credential {
        Credential::AccessToken(token) => {
            request.secret_header("authorization", "Bearer ", token.clone())
        }
        Credential::ApiToken { email, api_token } => {
            let pair = format!("{email}:{}", api_token.expose());
            request.secret_header(
                "authorization",
                "Basic ",
                Secret::new(base64::encode(pair.as_bytes())),
            )
        }
    }
}

/// `GET /user` with the credential. `None` for any failure: no answer, a status outside 2xx, a
/// body that is not a user.
async fn ask_user(url: String, credential: &Credential) -> Option<Option<String>> {
    let request = with_credential(
        HttpRequest::new(Method::Get, url).header("accept", "application/json"),
        credential,
    );
    let response = http::send(request).await.ok()?;
    if !(200..300).contains(&response.status) || response.truncated {
        return None;
    }
    decode_account(&response.body)
}

/// `probeAuth`.
async fn probe_auth(ctx: DiscoveryContext<'_>) -> SourceControlProviderAuth {
    let settings = ctx.settings.host(KIND);
    let credential = match resolve_credential(&settings, ctx.env) {
        Ok(credential) => credential,
        Err(message) => {
            return provider_auth(
                ServerProviderAuthStatus::Unauthenticated,
                None,
                Some(HOST),
                Some(&message),
            );
        }
    };
    let Some(credential) = credential else {
        return auth_from_credential(None);
    };
    match ask_user(user_url(ctx.env), &credential).await {
        Some(account) => provider_auth(
            ServerProviderAuthStatus::Authenticated,
            account.as_deref(),
            Some(HOST),
            None,
        ),
        None => auth_from_credential(Some(&credential)),
    }
}

pub async fn discover(ctx: DiscoveryContext<'_>) -> SourceControlProviderDiscoveryItem {
    discover_within(ctx, API_PROBE_TIMEOUT).await
}

/// `discover` with the probe's time limit as a parameter, so a test need not wait 3 s.
async fn discover_within(
    ctx: DiscoveryContext<'_>,
    limit: std::time::Duration,
) -> SourceControlProviderDiscoveryItem {
    let auth = tokio::time::timeout(limit, probe_auth(ctx)).await.ok();
    api_item(KIND, LABEL, INSTALL_HINT, auth)
}

#[cfg(test)]
mod tests {
    use std::{path::Path, time::Duration};

    use conn_contract::VcsDiscoveryItemDetail;

    use super::*;
    use crate::{
        discovery::{none, some},
        hosts::Endpoints,
        http::fake,
        settings::Settings,
    };

    fn settings(json: &str) -> Settings {
        Settings::new(serde_json::from_str(json).expect("json"))
    }

    fn basic(pair: &str) -> String {
        format!("Basic {}", base64::encode(pair.as_bytes()))
    }

    async fn run(
        settings: &Settings,
        env: &Environment,
        limit: Duration,
    ) -> SourceControlProviderDiscoveryItem {
        let endpoints = Endpoints::default();
        discover_within(
            DiscoveryContext {
                cwd: Path::new("."),
                home: None,
                settings,
                env,
                endpoints: &endpoints,
                child_env: &[],
            },
            limit,
        )
        .await
    }

    async fn discover_with(
        settings: &Settings,
        env: &Environment,
    ) -> SourceControlProviderDiscoveryItem {
        run(settings, env, API_PROBE_TIMEOUT).await
    }

    fn detail_text(detail: &VcsDiscoveryItemDetail) -> String {
        match detail {
            VcsDiscoveryItemDetail::Some(s) => s.value.clone(),
            VcsDiscoveryItemDetail::None(_) => String::new(),
        }
    }

    fn authorization(server: &fake::FakeServer) -> Option<String> {
        server
            .requests
            .lock()
            .expect("lock")
            .last()?
            .headers
            .iter()
            .find(|(k, _)| k == "authorization")
            .map(|(_, v)| v.clone())
    }

    fn request_count(server: &fake::FakeServer) -> usize {
        server.requests.lock().expect("lock").len()
    }

    fn env_for(server: &fake::FakeServer, extra: &[(&str, &str)]) -> Environment {
        let mut pairs = vec![(BASE_URL_VARIABLE, server.base.as_str())];
        pairs.extend_from_slice(extra);
        Environment::fixed(pairs)
    }

    const ENV_API_TOKEN: [(&str, &str); 2] = [
        ("T3CODE_BITBUCKET_EMAIL", "user@example.com"),
        ("T3CODE_BITBUCKET_API_TOKEN", "token"),
    ];

    #[test]
    fn the_item_is_the_api_spec_item() {
        let item = api_item(KIND, LABEL, INSTALL_HINT, None);
        assert_eq!(item.kind, "bitbucket");
        assert_eq!(item.label, "Bitbucket");
        assert_eq!(
            item.install_hint,
            "Add a Bitbucket token in Settings \u{2192} Source Control."
        );
    }

    // BitbucketApi.test.ts: "reports the account Bitbucket confirms for the configured
    // credential".
    #[tokio::test(flavor = "current_thread")]
    async fn reports_the_account_bitbucket_confirms() {
        let server = fake::serve(|_| (200, r#"{"username":"bitbucket-user"}"#.into())).await;
        let item = discover_with(&Settings::default(), &env_for(&server, &ENV_API_TOKEN)).await;
        assert_eq!(item.auth.status, ServerProviderAuthStatus::Authenticated);
        assert_eq!(item.auth.account, some("bitbucket-user"));
        assert_eq!(item.auth.host, some("bitbucket.org"));
        assert_eq!(item.auth.detail, none());
        assert_eq!(
            item.status,
            conn_contract::SourceControlDiscoveryStatus::Available
        );
    }

    // The `account` fallbacks of `probeAuth`: username, display_name, account_id, none.
    #[tokio::test(flavor = "current_thread")]
    async fn falls_back_through_the_user_fields() {
        let cases = [
            (
                r#"{"username":" u ","display_name":"D","account_id":"A"}"#,
                some("u"),
            ),
            (r#"{"display_name":" D ","account_id":"A"}"#, some("D")),
            (r#"{"account_id":"A"}"#, some("A")),
            (r#"{}"#, none()),
        ];
        for (body, account) in cases {
            let body = body.to_owned();
            let server = fake::serve(move |_| (200, body.clone())).await;
            let item = discover_with(&Settings::default(), &env_for(&server, &ENV_API_TOKEN)).await;
            assert_eq!(item.auth.status, ServerProviderAuthStatus::Authenticated);
            assert_eq!(item.auth.account, account);
        }
    }

    // `BitbucketUserSchema`: a blank or non-text field fails the decode, so the credential is
    // reported as configured.
    #[tokio::test(flavor = "current_thread")]
    async fn a_body_that_is_not_a_user_reports_the_configured_credential() {
        for body in [
            r#"{"username":"  "}"#,
            r#"{"username":"u","display_name":7}"#,
            r#"{"account_id":null}"#,
            "[]",
            "not json",
        ] {
            let server = fake::serve(move |_| (200, body.into())).await;
            let item = discover_with(&Settings::default(), &env_for(&server, &ENV_API_TOKEN)).await;
            assert_eq!(
                item.auth.status,
                ServerProviderAuthStatus::Unknown,
                "{body}"
            );
            assert_eq!(item.auth.account, some("user@example.com"), "{body}");
            assert_eq!(
                detail_text(&item.auth.detail),
                "An API token is configured.",
                "{body}"
            );
        }
    }

    // "prefers credentials saved in settings over the environment, without a restart".
    #[tokio::test(flavor = "current_thread")]
    async fn settings_win_over_the_environment() {
        let server = fake::serve(|_| (200, r#"{"username":"bitbucket-user"}"#.into())).await;
        let env = env_for(&server, &ENV_API_TOKEN);

        discover_with(&Settings::default(), &env).await;
        assert_eq!(
            authorization(&server),
            Some(basic("user@example.com:token"))
        );

        let saved = settings(
            r#"{"sourceControlHosts":{"bitbucket":{"email":"saved@example.com","apiToken":"saved-api-token"}}}"#,
        );
        discover_with(&saved, &env).await;
        assert_eq!(
            authorization(&server),
            Some(basic("saved@example.com:saved-api-token"))
        );

        let saved = settings(
            r#"{"sourceControlHosts":{"bitbucket":{"accessToken":"saved-access-token"}}}"#,
        );
        discover_with(&saved, &env).await;
        assert_eq!(
            authorization(&server),
            Some("Bearer saved-access-token".to_owned())
        );

        let saved =
            settings(r#"{"sourceControlHosts":{"bitbucket":{"accessToken":"","apiToken":""}}}"#);
        discover_with(&saved, &env).await;
        assert_eq!(
            authorization(&server),
            Some(basic("user@example.com:token"))
        );

        // A reference left in place is one its secret provider could not read: nothing is sent.
        let requests = request_count(&server);
        let saved = settings(
            r#"{"sourceControlHosts":{"bitbucket":{"accessToken":{"provider":"vault","reference":"bb#token"}}}}"#,
        );
        let item = discover_with(&saved, &env).await;
        assert_eq!(item.auth.status, ServerProviderAuthStatus::Unauthenticated);
        assert!(detail_text(&item.auth.detail).contains("\"vault\""));
        assert_eq!(item.auth.host, some("bitbucket.org"));
        assert_eq!(item.auth.account, none());
        assert_eq!(request_count(&server), requests, "no request");
        // The listPullRequests half of that test is not discovery.
    }

    // The API token is read only when the access token is unusable, as in `resolveCredential`.
    #[tokio::test(flavor = "current_thread")]
    async fn an_unreadable_api_token_matters_only_without_an_access_token() {
        let server = fake::serve(|_| (200, r#"{"username":"u"}"#.into())).await;
        let env = env_for(&server, &[]);
        let reference = r#"{"provider":"vault","reference":"r"}"#;

        let saved = settings(&format!(
            r#"{{"sourceControlHosts":{{"bitbucket":{{"accessToken":"tok","apiToken":{reference}}}}}}}"#
        ));
        let item = discover_with(&saved, &env).await;
        assert_eq!(item.auth.status, ServerProviderAuthStatus::Authenticated);
        assert_eq!(authorization(&server), Some("Bearer tok".to_owned()));

        let requests = request_count(&server);
        let saved = settings(&format!(
            r#"{{"sourceControlHosts":{{"bitbucket":{{"email":"e@x.y","apiToken":{reference}}}}}}}"#
        ));
        let item = discover_with(&saved, &env).await;
        assert_eq!(item.auth.status, ServerProviderAuthStatus::Unauthenticated);
        assert_eq!(request_count(&server), requests);
    }

    // "never puts a saved token that is unsafe for an HTTP header on the wire".
    #[tokio::test(flavor = "current_thread")]
    async fn a_header_unsafe_token_is_ignored() {
        let server = fake::serve(|_| (200, r#"{"username":"bitbucket-user"}"#.into())).await;
        let env = env_for(&server, &ENV_API_TOKEN);
        let saved =
            settings(r#"{"sourceControlHosts":{"bitbucket":{"accessToken":"saved\ntoken"}}}"#);
        discover_with(&saved, &env).await;
        assert_eq!(
            authorization(&server),
            Some(basic("user@example.com:token"))
        );
    }

    // With nothing usable anywhere, no header is sent and no request is made.
    #[tokio::test(flavor = "current_thread")]
    async fn a_header_unsafe_token_alone_sends_nothing() {
        let server = fake::serve(|_| (200, r#"{"username":"u"}"#.into())).await;
        let saved =
            settings(r#"{"sourceControlHosts":{"bitbucket":{"accessToken":"saved\ntoken"}}}"#);
        let env = env_for(&server, &[("T3CODE_BITBUCKET_ACCESS_TOKEN", "has space")]);
        let item = discover_with(&saved, &env).await;
        assert_eq!(item.auth.status, ServerProviderAuthStatus::Unauthenticated);
        assert_eq!(
            request_count(&server),
            0,
            "no request, so no authorization header"
        );
        assert_eq!(authorization(&server), None);
    }

    // "reports saved credentials as configured when Bitbucket cannot confirm them".
    #[tokio::test(flavor = "current_thread")]
    async fn reports_saved_credentials_as_configured_when_bitbucket_cannot_confirm() {
        let server = fake::serve(|_| (401, String::new())).await;
        let env = env_for(&server, &[]);

        let item = discover_with(&Settings::default(), &env).await;
        assert_eq!(item.auth.status, ServerProviderAuthStatus::Unauthenticated);
        assert_eq!(item.auth.host, some("bitbucket.org"));
        assert_eq!(
            detail_text(&item.auth.detail),
            "Add a Bitbucket token in Settings \u{2192} Source Control, or set the T3CODE_BITBUCKET_* environment variables on the server."
        );
        assert_eq!(request_count(&server), 0, "no credential, no request");

        let saved = settings(
            r#"{"sourceControlHosts":{"bitbucket":{"accessToken":"saved-access-token"}}}"#,
        );
        let item = discover_with(&saved, &env).await;
        assert_eq!(item.auth.status, ServerProviderAuthStatus::Unknown);
        assert_eq!(item.auth.account, none());
        assert_eq!(item.auth.host, some("bitbucket.org"));
        assert_eq!(item.auth.detail, some("An access token is configured."));
        assert_eq!(request_count(&server), 1);
    }

    // The request: method, path relative to the base, `accept`, and both authorization shapes.
    #[tokio::test(flavor = "current_thread")]
    async fn sends_get_user_with_accept_and_the_authorization_shape() {
        let server = fake::serve(|_| (200, r#"{"username":"u"}"#.into())).await;
        // A trailing slash on the base is dropped.
        let base = format!("{}//", server.base);
        let env = Environment::fixed([
            (BASE_URL_VARIABLE, base.as_str()),
            ("T3CODE_BITBUCKET_ACCESS_TOKEN", "fake"),
        ]);
        discover_with(&Settings::default(), &env).await;
        let env = Environment::fixed([
            (BASE_URL_VARIABLE, server.base.as_str()),
            ("T3CODE_BITBUCKET_EMAIL", "fake@email.test"),
            ("T3CODE_BITBUCKET_API_TOKEN", "fake"),
        ]);
        discover_with(&Settings::default(), &env).await;

        let requests = server.requests.lock().expect("lock").clone();
        assert_eq!(requests.len(), 2);
        for request in &requests {
            assert_eq!(
                (request.method.as_str(), request.path.as_str()),
                ("GET", "/user")
            );
            let accept = request.headers.iter().find(|(k, _)| k == "accept");
            assert_eq!(accept.map(|(_, v)| v.as_str()), Some("application/json"));
        }
        let header = |i: usize| {
            requests
                .get(i)
                .and_then(|r| r.headers.iter().find(|(k, _)| k == "authorization"))
                .map(|(_, v)| v.clone())
        };
        assert_eq!(header(0), Some("Bearer fake".to_owned()));
        assert_eq!(header(1), Some(basic("fake@email.test:fake")));
    }

    // `Config.String` from the environment is not trimmed or blank-checked: a blank variable is
    // an unusable value, so the other credential applies.
    #[tokio::test(flavor = "current_thread")]
    async fn the_environment_access_token_wins_over_the_environment_api_token() {
        let server = fake::serve(|_| (200, r#"{"username":"u"}"#.into())).await;
        let env = env_for(
            &server,
            &[
                ("T3CODE_BITBUCKET_ACCESS_TOKEN", "env-access"),
                ("T3CODE_BITBUCKET_EMAIL", "e@x.y"),
                ("T3CODE_BITBUCKET_API_TOKEN", "t"),
            ],
        );
        discover_with(&Settings::default(), &env).await;
        assert_eq!(authorization(&server), Some("Bearer env-access".to_owned()));

        let env = env_for(
            &server,
            &[
                ("T3CODE_BITBUCKET_ACCESS_TOKEN", " "),
                ("T3CODE_BITBUCKET_EMAIL", "e@x.y"),
                ("T3CODE_BITBUCKET_API_TOKEN", "t"),
            ],
        );
        discover_with(&Settings::default(), &env).await;
        assert_eq!(authorization(&server), Some(basic("e@x.y:t")));
    }

    #[test]
    fn only_printable_ascii_is_header_safe() {
        assert!(header_safe("abc~!"));
        for bad in ["", " ", "a b", "a\nb", "t\u{e9}", "a\u{7f}"] {
            assert!(!header_safe(bad), "{bad:?}");
        }
    }

    // `Effect.timeoutOption(API_PROBE_TIMEOUT)` in the `api` spec. The server accepts and never
    // answers; the limit is shortened so the test is fast.
    #[tokio::test(flavor = "current_thread")]
    async fn a_slow_answer_is_unknown() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let held = tokio::spawn(async move {
            let mut sockets = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                sockets.push(socket);
            }
        });
        let env = Environment::fixed([
            (BASE_URL_VARIABLE, base.as_str()),
            ("T3CODE_BITBUCKET_ACCESS_TOKEN", "fake"),
        ]);
        let item = run(&Settings::default(), &env, Duration::from_millis(200)).await;
        held.abort();
        assert_eq!(item.auth.status, ServerProviderAuthStatus::Unknown);
        assert_eq!(item.auth.account, none());
        assert_eq!(
            item.auth.detail,
            some("The hosting service did not answer in time. Refresh to try again.")
        );
        assert_eq!(
            item.status,
            conn_contract::SourceControlDiscoveryStatus::Available
        );
    }

    // The real `API_PROBE_TIMEOUT` is 3 s, on tokio's paused clock.
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn the_probe_limit_is_three_seconds() {
        assert_eq!(API_PROBE_TIMEOUT, Duration::from_secs(3));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let held = tokio::spawn(async move {
            let mut sockets = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                sockets.push(socket);
            }
        });
        let env = Environment::fixed([
            (BASE_URL_VARIABLE, base.as_str()),
            ("T3CODE_BITBUCKET_ACCESS_TOKEN", "fake"),
        ]);
        let started = tokio::time::Instant::now();
        let item = discover_with(&Settings::default(), &env).await;
        held.abort();
        assert_eq!(started.elapsed(), Duration::from_secs(3));
        assert_eq!(
            item.auth.detail,
            some("The hosting service did not answer in time. Refresh to try again.")
        );
    }
}
