//! Leftmost workspace rail (`WorkspaceRail.tsx` parity).
//!
//! Geometry (`apps/web/src/components/sidebar/WorkspaceRail.tsx`, `index.css`):
//! - Width: `54px` (`w-13.5`).
//! - Top `44px` drag spacer clearing the macOS traffic lights.
//! - First button ("All projects") sits `5px` below the `44px` header so the
//!   `38px` button centers on the `32px` search row (`44 + 8 + 16 = 68px` ==
//!   `44 + 5 + 19 = 68px`).
//! - Rail button: `38px x 38px` (`size-9.5`), `11px` radius (`--radius-rail: calc(6px + 5px)`).
//! - Inner tile: `28px x 28px` (`size-7`), `6px` radius (`--radius-tile: 6px`).
//! - Active workspace: `2px` inset ring (`sidebar_foreground` @ 90%) over
//!   `sidebar_row_active`, leaving a concentric `5px` gap around the `28px` tile.
//! - Saved workspaces live between "All projects" and `+`; when there are none,
//!   Conn shows only "All projects" and `+` (never individual projects).
//! - Bottom utility column (`gap-2 pb-2`): Usage (`chart`), Pull Requests
//!   (`pull-request`), and Settings (`settings`).

use conn_state::ShellState;
use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::assets::IconName;
use gpui_kit::{
    Context, InteractiveElement as _, ParentElement as _, StatefulInteractiveElement as _,
    Styled as _, WindowControlArea, div, px,
};

use crate::app::ConnApp;
use crate::icons;
use crate::shell::WORKSPACE_RAIL_WIDTH_PX;
use crate::theme::{hsla, hsla_alpha};

/// `size-9.5` = `38px`.
const RAIL_BUTTON_SIZE_PX: f32 = 38.0;
/// `--radius-rail: calc(var(--radius-tile) + 5px)` = `11px`.
const RAIL_BUTTON_RADIUS_PX: f32 = 11.0;
/// `size-7` = `28px`.
const RAIL_TILE_SIZE_PX: f32 = 28.0;
/// `--radius-tile: 6px` (`index.css`).
const RAIL_TILE_RADIUS_PX: f32 = 6.0;
/// `8px (--sidebar-content-inset) - 3px (0.75 * 4px)` so the 38px button centers
/// on the 32px search row inside the sidebar card (`WorkspaceRail.tsx:252`).
const RAIL_TOP_ALIGN_OFFSET_PX: f32 = 5.0;

/// Renders the vertical workspace rail matching real Conn (`WorkspaceRail.tsx`).
#[must_use]
pub(crate) fn render_workspace_rail(
    _shell: &ShellState,
    active_workspace: Option<&str>,
    tokens: &Tokens,
    geometry: &ShellGeometry,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::Div {
    let all_active = active_workspace.is_none();
    let muted = hsla(tokens.sidebar_muted_foreground);

    let all_projects_tile = div()
        .flex()
        .items_center()
        .justify_center()
        .size(px(RAIL_TILE_SIZE_PX))
        .rounded(px(RAIL_TILE_RADIUS_PX))
        .bg(hsla_alpha(tokens.sidebar_foreground, 0.10))
        .child(icons::chrome(
            IconName::Layers,
            if all_active {
                hsla(tokens.sidebar_foreground)
            } else {
                muted
            },
        ));

    let all_projects_btn = rail_button(
        "rail-all-projects",
        all_active,
        tokens,
        all_projects_tile,
        cx.listener(|app, _event, _window, cx| {
            app.select_workspace(None, cx);
        }),
    );

    let add_workspace_btn = rail_button(
        "rail-new-workspace",
        false,
        tokens,
        icons::chrome(IconName::Plus, muted),
        cx.listener(|_app, _event, _window, _cx| {}),
    );

    let usage_btn = rail_button(
        "rail-usage",
        false,
        tokens,
        icons::chrome(IconName::ChartNoAxesColumn, muted),
        cx.listener(|_app, _event, _window, _cx| {}),
    );

    let pull_requests_btn = rail_button(
        "rail-pull-requests",
        false,
        tokens,
        icons::concept(icons::PULL_REQUEST, icons::CHROME_ICON_PX, muted),
        cx.listener(|_app, _event, _window, _cx| {}),
    );

    let settings_btn = rail_button(
        "rail-settings",
        false,
        tokens,
        icons::chrome(IconName::Settings, muted),
        cx.listener(|app, _event, window, cx| {
            app.open_settings(window, cx);
        }),
    );

    div()
        .flex()
        .flex_col()
        .w(px(WORKSPACE_RAIL_WIDTH_PX))
        .h_full()
        .flex_shrink_0()
        // Top drag spacer clearing the macOS traffic lights.
        .child(
            div()
                .w_full()
                .h(px(geometry.header_height_px))
                .flex_shrink_0()
                .window_control_area(WindowControlArea::Drag),
        )
        // Main workspace tiles column: "All projects" + saved workspaces (none yet) + "+".
        .child(
            div()
                .flex()
                .flex_col()
                .flex_1()
                .min_h_0()
                .w_full()
                .items_center()
                .pt(px(RAIL_TOP_ALIGN_OFFSET_PX))
                .child(all_projects_btn)
                .child(
                    div()
                        .id("rail-workspaces-scroll")
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_h_0()
                        .w_full()
                        .items_center()
                        .gap(px(8.0))
                        .mt(px(8.0))
                        .pb(px(8.0))
                        .overflow_y_scroll()
                        .child(add_workspace_btn),
                ),
        )
        // Bottom utility actions (`RailActions` in `WorkspaceRail.tsx`).
        .child(
            div()
                .flex()
                .flex_col()
                .w_full()
                .flex_shrink_0()
                .items_center()
                .gap(px(8.0))
                .pb(px(8.0))
                .child(usage_btn)
                .child(pull_requests_btn)
                .child(settings_btn),
        )
}

fn rail_button(
    id: impl Into<gpui_kit::ElementId>,
    active: bool,
    tokens: &Tokens,
    content: impl gpui_kit::IntoElement,
    on_click: impl Fn(&gpui_kit::ClickEvent, &mut gpui_kit::Window, &mut gpui_kit::App) + 'static,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let hover_bg = hsla(tokens.sidebar_row_hover);
    let active_bg = hsla(tokens.sidebar_row_active);
    let ring_color = hsla_alpha(tokens.sidebar_foreground, 0.90);

    let mut btn = div()
        .id(id)
        .relative()
        .flex()
        .items_center()
        .justify_center()
        .size(px(RAIL_BUTTON_SIZE_PX))
        .flex_shrink_0()
        .rounded(px(RAIL_BUTTON_RADIUS_PX))
        .cursor_pointer()
        .on_click(on_click)
        .child(content);

    if active {
        btn = btn
            .bg(active_bg)
            .border_2()
            .border_color(ring_color)
            .hover(move |s| s.bg(active_bg));
    } else {
        btn = btn.hover(move |s| s.bg(hover_bg));
    }

    btn
}
