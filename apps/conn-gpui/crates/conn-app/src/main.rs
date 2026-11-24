//! Conn native desktop application entry point (GPUI).

mod a11y;
mod app;
#[cfg(feature = "automation")]
mod automation;
mod colour_space;
pub(crate) use conn_client::commands;
mod drafts;
mod file_icons;
mod fixture;
mod fonts;
mod header;
mod icons;
mod live;
mod menus;
mod orbit_sync;
mod palette;
mod runtime_warmup;
mod settings;
mod shell;
mod sidebar;
mod stderr_log;
mod superhero;
mod terminal_settings;
mod theme;
#[cfg(test)]
mod ui_tests;
mod vibrancy;
mod workspace_editor;
mod workspace_image;

use std::sync::Arc;
use std::time::Duration;

use app::ConnApp;
use conn_theme::Tokens;
use futures::AsyncReadExt as _;
use futures::future::BoxFuture;
use gpui_kit::http_client::{
    AsyncBody, HttpClient, Inner as AsyncBodyInner, RedirectPolicy, RequestTimeout, Url, anyhow,
    http,
};
use gpui_kit::{
    AppContext as _, Bounds, TitlebarOptions, WindowBackgroundAppearance, WindowBounds,
    WindowOptions, point, px, size,
};

/// Default request timeout for GPUI asset fetches (avatars, remote images).
const HTTP_CLIENT_TIMEOUT: Duration = Duration::from_secs(15);
const HTTP_CLIENT_USER_AGENT: &str = "conn-gpui/0.1";

/// Minimal GPUI [`HttpClient`] backed by the workspace `reqwest` client on [`live::RT`].
///
/// GPUI's background executor is not a Tokio runtime, so every `reqwest` call executes inside
/// `live::RT` and resolves back into GPUI's future cleanly.
#[derive(Debug)]
struct ReqwestHttpClient {
    follow_client: reqwest::Client,
    no_redirect_client: reqwest::Client,
    user_agent: http::HeaderValue,
}

impl ReqwestHttpClient {
    fn new() -> Result<Self, reqwest::Error> {
        let follow_client = reqwest::Client::builder()
            .user_agent(HTTP_CLIENT_USER_AGENT)
            .timeout(HTTP_CLIENT_TIMEOUT)
            .build()?;
        let no_redirect_client = reqwest::Client::builder()
            .user_agent(HTTP_CLIENT_USER_AGENT)
            .timeout(HTTP_CLIENT_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            follow_client,
            no_redirect_client,
            user_agent: http::HeaderValue::from_static(HTTP_CLIENT_USER_AGENT),
        })
    }
}

impl HttpClient for ReqwestHttpClient {
    fn user_agent(&self) -> Option<&http::HeaderValue> {
        Some(&self.user_agent)
    }

    fn proxy(&self) -> Option<&Url> {
        None
    }

    fn send(
        &self,
        req: http::Request<AsyncBody>,
    ) -> BoxFuture<'static, gpui_kit::http_client::Result<http::Response<AsyncBody>>> {
        let (parts, mut body) = req.into_parts();
        let redirect_policy = parts
            .extensions
            .get::<RedirectPolicy>()
            .cloned()
            .unwrap_or_default();
        let request_timeout = parts.extensions.get::<RequestTimeout>().copied();
        let client = match redirect_policy {
            RedirectPolicy::NoFollow => self.no_redirect_client.clone(),
            RedirectPolicy::FollowLimit(_) | RedirectPolicy::FollowAll => {
                self.follow_client.clone()
            }
        };

        Box::pin(async move {
            let body_bytes = if matches!(body.0, AsyncBodyInner::Empty) {
                Vec::new()
            } else {
                let mut buf = Vec::new();
                body.read_to_end(&mut buf).await?;
                buf
            };

            let method = reqwest::Method::from_bytes(parts.method.as_str().as_bytes())
                .map_err(|err| anyhow!("invalid HTTP method: {err}"))?;
            let uri = parts.uri.to_string();
            let headers = parts.headers;

            let task = live::RT.spawn(async move {
                let mut builder = client.request(method, uri);
                for (name, value) in &headers {
                    builder = builder.header(name.as_str(), value.as_bytes());
                }
                if let Some(RequestTimeout(timeout)) = request_timeout {
                    builder = builder.timeout(timeout);
                }
                if !body_bytes.is_empty() {
                    builder = builder.body(body_bytes);
                }

                let response = builder.send().await?;
                let status = response.status().as_u16();
                let resp_headers = response.headers().clone();
                let resp_bytes = response.bytes().await?;
                Ok::<_, reqwest::Error>((status, resp_headers, resp_bytes))
            });

            let (status, resp_headers, resp_bytes) = task
                .await
                .map_err(|err| anyhow!("HTTP task join error: {err}"))?
                .map_err(|err| anyhow!("HTTP request failed: {err}"))?;

            let mut response_builder = http::Response::builder().status(status);
            for (name, value) in &resp_headers {
                if let (Ok(h_name), Ok(h_val)) = (
                    http::header::HeaderName::from_bytes(name.as_str().as_bytes()),
                    http::header::HeaderValue::from_bytes(value.as_bytes()),
                ) {
                    response_builder = response_builder.header(h_name, h_val);
                }
            }
            response_builder
                .body(AsyncBody::from(resp_bytes.to_vec()))
                .map_err(|err| anyhow!("failed to build HTTP response: {err}"))
        })
    }
}

/// Default window size matching a comfortable Conn desktop workspace.
const DEFAULT_WINDOW_WIDTH_PX: f32 = 1440.0;
const DEFAULT_WINDOW_HEIGHT_PX: f32 = 900.0;
/// Minimum usable window size.
const MIN_WINDOW_WIDTH_PX: f32 = 760.0;
const MIN_WINDOW_HEIGHT_PX: f32 = 480.0;

/// macOS traffic-light position matching `apps/desktop/src/window/DesktopWindow.ts`:
/// - `x = 16.0` (Conn's `setWindowButtonPosition({ x: 16, ... })`).
/// - `y = 15.0` (`MACOS_SHELL_HEADER_HEIGHT (44) / 2 - MACOS_WINDOW_BUTTON_RADIUS (7) = 15`).
///
/// In `gpui-pre-macos`, `titlebar_container` height is set to
/// `button_height (14) + 2 * y (30) = 44px`, placing the buttons' vertical center
/// at `y + button_height / 2 = 22px` — centered on the 44px glass header.
const MACOS_TRAFFIC_LIGHT_X_PX: f32 = 16.0;
const MACOS_TRAFFIC_LIGHT_Y_PX: f32 = 15.0;

mod chat;

mod panels;

fn main() {
    if let Some(code) = conn_web::maybe_run_subprocess() {
        std::process::exit(code);
    }

    stderr_log::install();
    let (url_tx, url_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    for arg in std::env::args().skip(1) {
        if conn_desktop::control::parse_deep_link(&arg).is_some() {
            let _ = url_tx.send(arg);
        }
    }

    let mut application = gpui_kit::application().with_assets(superhero::AppAssets);
    application.on_open_urls(move |urls| {
        for url in urls {
            let _ = url_tx.send(url);
        }
    });
    match ReqwestHttpClient::new() {
        Ok(http_client) => {
            application = application.with_http_client(Arc::new(http_client));
        }
        Err(error) => {
            eprintln!("conn-app: could not initialize HTTP client for remote assets: {error}");
        }
    }
    application.run(|cx| {
        gpui_kit::init(cx);
        fonts::register(cx);
        colour_space::install(cx);
        vibrancy::install(cx);
        let theme = live::initial_theme();
        let tokens = Tokens::derive(&theme);
        theme::apply_kit_theme(&tokens, cx);
        vibrancy::sync_appearance(tokens.appearance);
        let server = live::startup_server();
        app::register_keybindings(cx);
        terminal_settings::init(cx);
        menus::install(cx);
        app::start_frame_log(cx);

        // `CONN_GPUI_WINDOW=x,y,width,height` (points, top-left origin) places the window
        // exactly, so captures line up with a reference app at the same frame.
        let bounds = live::window_from_env().map_or_else(
            || {
                Bounds::centered(
                    None,
                    size(px(DEFAULT_WINDOW_WIDTH_PX), px(DEFAULT_WINDOW_HEIGHT_PX)),
                    cx,
                )
            },
            |[x, y, w, h]| Bounds::new(point(px(x), px(y)), size(px(w), px(h))),
        );

        #[expect(
            clippy::expect_used,
            reason = "with no main window there is no desktop app to run"
        )]
        let (window, app) = gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some("Conn".into()),
                    appears_transparent: true,
                    traffic_light_position: Some(point(
                        px(MACOS_TRAFFIC_LIGHT_X_PX),
                        px(MACOS_TRAFFIC_LIGHT_Y_PX),
                    )),
                }),
                // Transparent: `vibrancy.rs` adds Conn's untouched under-window material behind it.
                window_background: WindowBackgroundAppearance::Transparent,
                app_owns_titlebar_drag: true,
                window_min_size: Some(size(px(MIN_WINDOW_WIDTH_PX), px(MIN_WINDOW_HEIGHT_PX))),
                app_id: Some("conn".into()),
                ..Default::default()
            },
            cx,
            move |window, cx| cx.new(|cx| ConnApp::new(theme.id, tokens, server, window, cx)),
        )
        .expect("failed to open Conn main window");
        // Become the active app with the window in front, as a launched app should.
        cx.activate(true);
        // Chromium starts in the background once the window has painted, so the Browser tab
        // finds it running.
        runtime_warmup::begin_after_launch(cx);
        window
            .update(cx, |_, window, cx| {
                menus::install_main_window(window, cx);
                window.activate_window();
            })
            .ok();
        let (control_tx, control_rx) =
            tokio::sync::mpsc::unbounded_channel::<conn_desktop::control::IncomingControlRequest>();
        let control_server = start_desktop_control_socket(control_tx);
        app.update(cx, |app, cx| {
            app.attach_activation_channels(url_rx, control_rx, control_server, window, cx);
        });
        #[cfg(feature = "automation")]
        automation::serve(&app, window, cx);
        #[cfg(not(feature = "automation"))]
        let _ = (window, app);
    });
}

fn start_desktop_control_socket(
    tx: tokio::sync::mpsc::UnboundedSender<conn_desktop::control::IncomingControlRequest>,
) -> Option<conn_desktop::control::ControlServerHandle> {
    if std::env::var_os("CONN_GPUI_DISABLE_CONTROL_SOCKET").is_some() {
        return None;
    }
    let state_dir = std::env::var_os("CONN_GPUI_CONTROL_STATE_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            let home = std::env::var_os("HOME")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            home.join(".t3").join("userdata")
        });
    let uid = nix_uid();
    let address = conn_desktop::control::resolve_control_socket_address(
        &state_dir,
        &std::env::temp_dir(),
        uid,
    );
    let _guard = live::RT.enter();
    match conn_desktop::control::start_control_server(&address, tx) {
        Ok(handle) => {
            eprintln!(
                "conn-app: control socket listening at {}",
                handle.address().display()
            );
            Some(handle)
        }
        Err(err) => {
            eprintln!("conn-app: could not start desktop control socket: {err}");
            None
        }
    }
}

#[cfg(unix)]
fn nix_uid() -> Option<u32> {
    // SAFETY: `libc::getuid` is an always-safe POSIX syscall returning the process's real UID.
    Some(unsafe { libc::getuid() })
}

#[cfg(not(unix))]
fn nix_uid() -> Option<u32> {
    None
}

#[cfg(test)]
mod http_client_tests {
    use futures::AsyncReadExt as _;
    use gpui_kit::http_client::{AsyncBody, HttpClient as _};
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpListener;

    use super::ReqwestHttpClient;

    #[test]
    fn reqwest_http_client_fetches_and_follows_redirects() {
        let client = ReqwestHttpClient::new().ok();
        assert!(client.is_some(), "ReqwestHttpClient should construct");
        let Some(client) = client else {
            return;
        };
        assert_eq!(
            client.user_agent().and_then(|v| v.to_str().ok()),
            Some("conn-gpui/0.1"),
            "user agent header should identify conn-gpui"
        );

        let result: gpui_kit::http_client::Result<_> = crate::live::RT.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await?;
            let addr = listener.local_addr()?;

            let server = tokio::spawn(async move {
                for _ in 0..2 {
                    let Ok((mut stream, _)) = listener.accept().await else {
                        break;
                    };
                    let mut req_buf = [0_u8; 1024];
                    let n = stream.read(&mut req_buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&req_buf[..n]);
                    let response = if req.starts_with("GET /redirect ") {
                        "HTTP/1.1 302 Found\r\nLocation: /avatar.png\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    } else {
                        "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 4\r\nConnection: close\r\n\r\nPNG!"
                    };
                    let _ = stream.write_all(response.as_bytes()).await;
                }
            });

            let url = format!("http://{addr}/redirect");
            let mut resp = client.get(&url, AsyncBody::empty(), true).await?;
            let status = resp.status();
            let mut bytes = Vec::new();
            resp.body_mut().read_to_end(&mut bytes).await?;
            let _ = server.await;
            gpui_kit::http_client::Result::Ok((status, bytes))
        });

        let Ok((status, bytes)) = result else {
            panic!("loopback HTTP GET should succeed: {result:?}");
        };
        assert_eq!(status, 200, "redirect should resolve to 200 OK");
        assert_eq!(bytes, b"PNG!", "response body bytes should round-trip");
    }
}
