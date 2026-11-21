//! Leftmost workspace rail (`WorkspaceRail.tsx` parity).
//!
//! Geometry (`../conn/apps/web/src/components/sidebar/WorkspaceRail.tsx`):
//! - Width: `54px` (`w-13.5`).
//! - Top `44px` drag spacer clearing the macOS traffic lights.
//! - First button ("All projects") sits `5px` below the `44px` header so the
//!   `38px` button centers on the `32px` search row (`44 + 8 + 16 = 68px` ==
//!   `44 + 5 + 19 = 68px`).
//! - Rail button: `38px x 38px` (`size-9.5`), `10px` radius (`rounded-rail`).
//! - Inner workspace tile: `28px x 28px` (`size-7`), `5px` radius (`rounded-tile`,
//!   concentric `10px - 5px` inset), muted monogram tinted from theme tokens.
//! - Active workspace: `2px` inset ring (`sidebar_foreground` @ 90%) over
//!   `sidebar_row_active`, leaving a visible `3px` gap around the `28px` tile.
//! - Bottom utility column: Usage (`ChartNoAxesColumn`) and Settings (`Settings`).

use conn_state::ShellState;
use conn_theme::{Appearance, ShellGeometry, Tokens};
use gpui_kit::assets::IconName;
use gpui_kit::{
    Context, InteractiveElement as _, ParentElement as _, StatefulInteractiveElement as _,
    Styled as _, WindowControlArea, div, px,
};

use crate::app::ConnApp;
use crate::icons;
use crate::shell::WORKSPACE_RAIL_WIDTH_PX;
use crate::sidebar::{project_monogram, project_monogram_color};
use crate::theme::{hsla, hsla_alpha};

const RAIL_BUTTON_SIZE_PX: f32 = 38.0;
const RAIL_BUTTON_RADIUS_PX: f32 = 10.0;
const RAIL_TILE_SIZE_PX: f32 = 28.0;
const RAIL_TILE_RADIUS_PX: f32 = 5.0;
/// `8px (--sidebar-content-inset) - 3px (0.75 * 4px)` so the 38px button centers
/// on the 32px search row inside the sidebar card (`WorkspaceRail.tsx:256`).
const RAIL_TOP_ALIGN_OFFSET_PX: f32 = 5.0;

/// Renders the vertical workspace rail.
#[must_use]
pub(crate) fn render_workspace_rail(
    shell: &ShellState,
    active_workspace: Option<&str>,
    tokens: &Tokens,
    geometry: &ShellGeometry,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::Div {
    let all_active = active_workspace.is_none();
    let tile_bg_alpha = match tokens.appearance {
        Appearance::Light => 0.14,
        Appearance::Dark => 0.18,
    };

    let mut workspace_tiles = Vec::with_capacity(shell.projects.len());
    for (idx, project) in shell.projects.iter().enumerate() {
        let project_id = project.id.clone();
        let active = active_workspace == Some(project.id.as_str());
        let monogram = project_monogram(&project.title);
        let accent = project_monogram_color(&project.title, tokens);

        let tile = div()
            .flex()
            .items_center()
            .justify_center()
            .size(px(RAIL_TILE_SIZE_PX))
            .rounded(px(RAIL_TILE_RADIUS_PX))
            .bg(hsla_alpha(accent, tile_bg_alpha))
            .text_color(hsla(accent))
            .text_size(px(12.0))
            .font_weight(gpui_kit::FontWeight::SEMIBOLD)
            .child(monogram);

        workspace_tiles.push(rail_button(
            ("rail-ws", idx),
            active,
            tokens,
            tile,
            cx.listener(move |app, _event, _window, cx| {
                app.select_workspace(Some(project_id.clone()), cx);
            }),
        ));
    }

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
                hsla(tokens.sidebar_muted_foreground)
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
        icons::chrome(IconName::Plus, hsla(tokens.sidebar_muted_foreground)),
        cx.listener(|_app, _event, _window, _cx| {}),
    );

    let usage_btn = rail_button(
        "rail-usage",
        false,
        tokens,
        icons::chrome(
            IconName::ChartNoAxesColumn,
            hsla(tokens.sidebar_muted_foreground),
        ),
        cx.listener(|_app, _event, _window, _cx| {}),
    );

    let settings_btn = rail_button(
        "rail-settings",
        false,
        tokens,
        icons::chrome(IconName::Settings, hsla(tokens.sidebar_muted_foreground)),
        cx.listener(|_app, _event, _window, _cx| {}),
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
        // Main workspace tiles column.
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
                        .children(workspace_tiles)
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
