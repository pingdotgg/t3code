//! Leftmost workspace rail (`WorkspaceRail.tsx` parity).
//!
//! Geometry:
//! - Width: `54px` (`w-13.5`).
//! - Top `44px` drag spacer clearing the macOS traffic lights.
//! - Rail button: `38px x 38px` (`size-9.5`), `10px` radius (`rounded-rail`).
//! - Inner workspace tile: `28px x 28px` (`size-7`), `5px` radius (`rounded-tile`,
//!   concentric `10px - 5px` inset).
//! - Active workspace: `2px` inset ring (`sidebar_foreground` @ 90%) over
//!   `sidebar_row_active`, leaving a visible gap around the inner `28px` tile.

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

const RAIL_BUTTON_SIZE_PX: f32 = 38.0;
const RAIL_BUTTON_RADIUS_PX: f32 = 10.0;
const RAIL_TILE_SIZE_PX: f32 = 28.0;
const RAIL_TILE_RADIUS_PX: f32 = 5.0;

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

    let mut workspace_tiles = Vec::with_capacity(shell.projects.len());
    for (idx, project) in shell.projects.iter().enumerate() {
        let project_id = project.id.clone();
        let active = active_workspace == Some(project.id.as_str());
        let monogram = project
            .title
            .chars()
            .next()
            .map(|c| c.to_ascii_uppercase().to_string())
            .unwrap_or_else(|| "?".into());

        // Cycle semantic theme accents (no hardcoded hex literals).
        let (tile_bg, tile_fg) = match idx % 3 {
            0 => (hsla(tokens.info), hsla(tokens.primary_foreground)),
            1 => (hsla(tokens.success), hsla(tokens.primary_foreground)),
            _ => (hsla(tokens.warning), hsla(tokens.primary_foreground)),
        };

        let tile = div()
            .flex()
            .items_center()
            .justify_center()
            .size(px(RAIL_TILE_SIZE_PX))
            .rounded(px(RAIL_TILE_RADIUS_PX))
            .bg(tile_bg)
            .text_color(tile_fg)
            .text_size(px(14.0))
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
                .gap(px(8.0))
                .pt(px(8.0))
                .child(all_projects_btn)
                .children(workspace_tiles)
                .child(add_workspace_btn),
        )
        // Bottom utility actions.
        .child(
            div()
                .flex()
                .flex_col()
                .w_full()
                .flex_shrink_0()
                .items_center()
                .gap(px(8.0))
                .pb(px(8.0))
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
