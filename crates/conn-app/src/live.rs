//! The live `conn-server` connection: a dedicated Tokio runtime (GPUI's main thread has none),
//! connection settings from the environment, and the theme the app starts with.
//!
//! Environment:
//! - `CONN_GPUI_SERVER`: server base URL, such as `http://127.0.0.1:3891`. Unset: demo fixture.
//! - `CONN_GPUI_TOKEN` or `CONN_GPUI_TOKEN_FILE`: a bearer token (`conn-server auth session issue
//!   --token-only`). Else `CONN_GPUI_PAIRING_URL` (`http://host:port/pair#token=CODE`).
//! - `CONN_GPUI_THEME`: a built-in theme id (default `dark-mono`, Nick's dark theme).

use std::sync::LazyLock;

use conn_client::{Credential, ServerConfig};
use conn_theme::{ThemeDefinition, Tokens};

#[expect(
    clippy::expect_used,
    reason = "without its runtime the app can reach no server, so it stops with why"
)]
pub(crate) static RT: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("conn-client")
        .enable_all()
        .build()
        .expect("a tokio runtime")
});

/// The server to connect to, or `None` to run on the demo fixture.
pub(crate) fn server_config_from_env() -> Option<ServerConfig> {
    let token = std::env::var("CONN_GPUI_TOKEN").ok().or_else(|| {
        std::env::var("CONN_GPUI_TOKEN_FILE")
            .ok()
            .and_then(|path| std::fs::read_to_string(path).ok())
    });
    if let Some(token) = token.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()) {
        let base = std::env::var("CONN_GPUI_SERVER").ok()?;
        let http_base_url = url::Url::parse(&base).ok()?;
        return Some(ServerConfig {
            http_base_url,
            credential: Credential::Bearer(token),
        });
    }
    let pairing = std::env::var("CONN_GPUI_PAIRING_URL").ok()?;
    let url = url::Url::parse(&pairing).ok()?;
    let code = url.fragment()?.strip_prefix("token=")?.to_owned();
    let mut http_base_url = url;
    http_base_url.set_path("/");
    http_base_url.set_fragment(None);
    Some(ServerConfig {
        http_base_url,
        credential: Credential::PairingCode(code),
    })
}

/// The theme to start with: `CONN_GPUI_THEME`, else Dark Mono.
pub(crate) fn initial_theme() -> ThemeDefinition {
    let id = std::env::var("CONN_GPUI_THEME").unwrap_or_else(|_| "dark-mono".to_owned());
    conn_theme::theme_by_id(&id)
        .or_else(|| conn_theme::builtin_themes().into_iter().next())
        .unwrap_or_else(|| ThemeDefinition {
            id: "empty".into(),
            name: "Empty".into(),
            appearance: conn_theme::Appearance::Dark,
            roles: std::collections::BTreeMap::new(),
        })
}

/// Tokens for a theme id, if it is a built-in theme.
pub(crate) fn tokens_for(theme_id: &str) -> Option<(ThemeDefinition, Tokens)> {
    let theme = conn_theme::theme_by_id(theme_id)?;
    let tokens = Tokens::derive(&theme);
    Some((theme, tokens))
}
