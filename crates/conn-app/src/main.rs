//! Conn native desktop application entry point (GPUI).

mod app;
#[cfg(feature = "automation")]
mod automation;
mod colour_space;
mod commands;
mod fixture;
mod fonts;
mod header;
mod icons;
mod live;
mod palette;
mod settings;
mod shell;
mod sidebar;
mod superhero;
mod theme;

use app::ConnApp;
use conn_theme::Tokens;
use gpui_kit::{
    AppContext as _, Bounds, TitlebarOptions, WindowBackgroundAppearance, WindowBounds,
    WindowOptions, point, px, size,
};

/// Default window size matching a comfortable Conn desktop workspace.
const DEFAULT_WINDOW_WIDTH_PX: f32 = 1440.0;
const DEFAULT_WINDOW_HEIGHT_PX: f32 = 900.0;
/// Minimum usable window size.
const MIN_WINDOW_WIDTH_PX: f32 = 760.0;
const MIN_WINDOW_HEIGHT_PX: f32 = 480.0;

/// macOS traffic-light position matching `../conn/apps/desktop/src/window/DesktopWindow.ts`:
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
    #[cfg(feature = "cef")]
    if let Some(code) = conn_web::maybe_run_subprocess() {
        std::process::exit(code);
    }

    let application = gpui_kit::application().with_assets(superhero::AppAssets);
    application.run(|cx| {
        gpui_kit::init(cx);
        fonts::register(cx);
        colour_space::install(cx);
        let theme = live::initial_theme();
        let tokens = Tokens::derive(&theme);
        theme::apply_kit_theme(&tokens, cx);
        let server = live::server_config_from_env();
        app::register_keybindings(cx);

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
                window_background: WindowBackgroundAppearance::Blurred,
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
        window
            .update(cx, |_, window, _| window.activate_window())
            .ok();
        #[cfg(feature = "automation")]
        automation::serve(&app, window, cx);
        #[cfg(not(feature = "automation"))]
        let _ = (window, app);
    });
}
