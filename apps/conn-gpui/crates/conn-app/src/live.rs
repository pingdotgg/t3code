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

/// Returns `true` when `CONN_GPUI_DEMO=1` explicitly forces the offline demo fixture.
pub(crate) fn demo_mode_enabled() -> bool {
    std::env::var("CONN_GPUI_DEMO")
        .map(|v| matches!(v.trim(), "1" | "true" | "on" | "yes"))
        .unwrap_or(false)
}

/// Startup server target resolved from explicit env vars or persisted desktop sessions.
pub(crate) struct StartupServer {
    pub(crate) config: ServerConfig,
    pub(crate) label: Option<String>,
    pub(crate) orbit_server_id: Option<String>,
}

/// Resolves the initial `conn-server` target to connect to on launch:
/// 1. Explicit env vars (`CONN_GPUI_SERVER` / `CONN_GPUI_PAIRING_URL`) always win.
/// 2. Unless `CONN_GPUI_DEMO=1`, the most recently used saved direct server (`server.json`)
///    or cached Orbit Node/Instance session (`orbit-sessions.json`).
pub(crate) fn startup_server() -> Option<StartupServer> {
    if let Some(config) = server_config_from_env() {
        return Some(StartupServer {
            config,
            label: None,
            orbit_server_id: None,
        });
    }
    if demo_mode_enabled() {
        return None;
    }

    let direct = conn_desktop::server_store::SavedServerConfig::load_default().and_then(|saved| {
        let http_base_url = url::Url::parse(&saved.url).ok()?;
        Some((
            saved.updated_at_unix,
            StartupServer {
                config: ServerConfig {
                    http_base_url,
                    credential: Credential::Bearer(saved.bearer),
                },
                label: saved.label,
                orbit_server_id: None,
            },
        ))
    });

    let orbit = if crate::orbit_sync::orbit_sync_enabled_by_env() {
        let store = conn_desktop::orbit::OrbitSessionStore::load_default();
        store
            .active_server_id
            .as_deref()
            .and_then(|sid| store.sessions.get(sid))
            .and_then(|session| {
                if session.bearer.trim().is_empty() {
                    return None;
                }
                let http_base_url = url::Url::parse(&session.url).ok()?;
                Some((
                    session.paired_at_unix,
                    StartupServer {
                        config: ServerConfig {
                            http_base_url,
                            credential: Credential::Bearer(session.bearer.clone()),
                        },
                        label: Some(session.label.clone()),
                        orbit_server_id: Some(session.server_id.clone()),
                    },
                ))
            })
    } else {
        None
    };

    match (direct, orbit) {
        (Some((d_ts, d_srv)), Some((o_ts, o_srv))) => {
            if d_ts >= o_ts {
                Some(d_srv)
            } else {
                Some(o_srv)
            }
        }
        (Some((_, srv)), None) | (None, Some((_, srv))) => Some(srv),
        (None, None) => None,
    }
}

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

/// `CONN_GPUI_WINDOW=x,y,width,height` in points, if set and valid.
pub(crate) fn window_from_env() -> Option<[f32; 4]> {
    let raw = std::env::var("CONN_GPUI_WINDOW").ok()?;
    let parts: Vec<f32> = raw
        .split(',')
        .map(|p| p.trim().parse::<f32>())
        .collect::<Result<_, _>>()
        .ok()?;
    match parts.as_slice() {
        [x, y, w, h] if *w > 0.0 && *h > 0.0 => Some([*x, *y, *w, *h]),
        _ => None,
    }
}

/// `CONN_GPUI_THEME_FILE`: a Conn theme JSON file to use and to watch for edits (dev loop).
pub(crate) fn theme_file_from_env() -> Option<std::path::PathBuf> {
    std::env::var_os("CONN_GPUI_THEME_FILE").map(std::path::PathBuf::from)
}

/// Reads and parses a Conn theme JSON file into its definition and tokens.
pub(crate) fn load_theme_file(path: &std::path::Path) -> Result<(ThemeDefinition, Tokens), String> {
    let json = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("theme-file")
        .to_owned();
    let theme = conn_theme::parse_theme_json(&id, &json).map_err(|e| e.to_string())?;
    let tokens = Tokens::derive(&theme);
    Ok((theme, tokens))
}
