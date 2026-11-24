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
//! - A press on a workspace tile that moves 6px drags it (`@dnd-kit` `PointerSensor`), up and
//!   down only, over the other tiles, which make room; a drop saves the new order. A
//!   right-click on a tile opens its menu (`Remove workspace`). "All projects" and `+` stay put.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use conn_desktop::orbit::OrbitWorkspace;
use conn_state::RightPanelTab;
use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::assets::IconName;
use gpui_kit::{
    AnyElement, Bounds, Context, InteractiveElement as _, IntoElement, MouseButton, MouseDownEvent,
    ParentElement as _, Pixels, Point, SharedString, StatefulInteractiveElement as _, Styled as _,
    TestSupportExt as _, WindowControlArea, anchored, canvas, deferred, div, point, px,
};

use crate::a11y::ConnA11yExt as _;
use crate::app::ConnApp;
use crate::icons;
use crate::panels::chrome::ConnTooltipExt as _;
use crate::shell::WORKSPACE_RAIL_WIDTH_PX;
use crate::sidebar::thread_menu::{
    MENU_FONT_PX, MENU_ICON_PX, MENU_LINE_PX, MENU_ROW_HEIGHT_PX, MENU_ROW_RADIUS_PX, menu_surface,
};
use crate::sidebar::workspace_order::{self, Gesture, Pickup};
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

/// The open workspace menu: which tile it belongs to and where the pointer was.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RailMenuAnchor {
    pub(crate) workspace_id: String,
    pub(crate) workspace_name: String,
    pub(crate) position: Point<Pixels>,
}

/// The rail's pointer gesture (a press on a tile, and the drag it becomes) with the extents the
/// tiles were last painted at, which a drag measures its slots from.
#[derive(Default)]
pub(crate) struct RailGesture {
    pub(crate) state: Gesture,
    bounds: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
}

impl RailGesture {
    /// The pointer moved with the button down; see [`Gesture::moved`]. Whether the rail needs
    /// to be drawn again.
    pub(crate) fn pointer_moved(
        &mut self,
        position: Point<Pixels>,
        workspaces: &[OrbitWorkspace],
    ) -> bool {
        let Self { state, bounds } = self;
        let bounds = bounds.borrow();
        state.moved((f32::from(position.x), f32::from(position.y)), |held| {
            let slots = workspaces
                .iter()
                .map(|w| Some((w.id.clone(), f32::from(bounds.get(&w.id)?.center().y))))
                .collect::<Option<Vec<_>>>()?;
            let tile = bounds.get(held)?;
            Some(Pickup {
                slots,
                left: f32::from(tile.left()),
                top: f32::from(tile.top()),
            })
        })
    }
}

/// Records where a tile is painted, for a drag's slots.
fn measure_tile(bounds: &Rc<RefCell<HashMap<String, Bounds<Pixels>>>>, id: &str) -> AnyElement {
    let bounds = Rc::clone(bounds);
    let id = id.to_owned();
    canvas(
        move |painted, _, _| {
            bounds.borrow_mut().insert(id, painted);
        },
        |_, _, _, _| {},
    )
    .absolute()
    .size_full()
    .into_any_element()
}

/// The images painted for the workspaces that have one, by workspace id.
pub(crate) type WorkspaceImages = HashMap<String, (String, Option<Arc<gpui_kit::Image>>)>;

/// The `28px` tile of a workspace (`WorkspaceBadge`): its image, or its icon or first letter on
/// its colour.
fn workspace_tile(ws: &OrbitWorkspace, images: &WorkspaceImages, tokens: &Tokens) -> AnyElement {
    let image = images.get(&ws.id).and_then(|(_, image)| image.clone());
    let badge = crate::workspace_editor::workspace_badge(
        &ws.name,
        &ws.color,
        ws.icon.as_deref(),
        image,
        RAIL_TILE_SIZE_PX,
        RAIL_TILE_RADIUS_PX,
        tokens.primary,
    );
    // The same `28px` tile of the same radius for a letter, an icon and an image.
    div()
        .id(SharedString::from(format!("rail-badge-{}", ws.id)))
        .test_support()
        .a11y_group(
            SharedString::from(format!("rail.workspace.{}.badge", ws.id)),
            format!("Badge {}", ws.name),
        )
        .size(px(RAIL_TILE_SIZE_PX))
        .flex_shrink_0()
        .child(badge)
        .into_any_element()
}

/// The tile lifted under the pointer (`z-10 opacity-70` in Conn): it keeps its column and
/// follows the pointer up and down (`restrictToVerticalAxis`).
fn render_held_tile(
    ws: &OrbitWorkspace,
    images: &WorkspaceImages,
    drag: &workspace_order::Drag,
    is_active: bool,
    tokens: &Tokens,
) -> AnyElement {
    let tile = rail_button(
        SharedString::from(format!("rail-ws-held-{}", ws.id)),
        is_active,
        tokens,
        workspace_tile(ws, images, tokens),
        |_, _, _| {},
    )
    .opacity(0.7);
    deferred(
        anchored()
            .position(point(px(drag.left()), px(drag.top())))
            .snap_to_window_with_margin(px(0.0))
            .child(tile),
    )
    .with_priority(7)
    .into_any_element()
}

/// Renders the anchored workspace menu (`Remove workspace`), styled like the Thread Actions menu.
#[must_use]
pub(crate) fn render_rail_menu(
    anchor: &RailMenuAnchor,
    tokens: &Tokens,
    cx: &mut Context<'_, ConnApp>,
) -> AnyElement {
    let destructive = hsla(tokens.destructive);
    let highlight = hsla(tokens.shell_highlight);
    let workspace_id = anchor.workspace_id.clone();
    let workspace_name = anchor.workspace_name.clone();
    let edit_id = anchor.workspace_id.clone();
    let fg = hsla(tokens.foreground);
    // `Edit…` (`WorkspaceRail.tsx` context menu): opens the workspace editor.
    let edit = div()
        .id("rail-menu-edit")
        .test_support()
        .a11y(
            gpui_kit::Role::MenuItem,
            "rail.menu.edit-workspace",
            "Edit…",
        )
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .w_full()
        .min_h(px(MENU_ROW_HEIGHT_PX))
        .px(px(8.0))
        .py(px(4.0))
        .rounded(px(MENU_ROW_RADIUS_PX))
        .text_size(px(MENU_FONT_PX))
        .line_height(px(MENU_LINE_PX))
        .text_color(fg)
        .cursor_pointer()
        .hover(move |s| s.bg(highlight))
        .child(icons::concept("superhero/edit.svg", MENU_ICON_PX, fg))
        .child(div().flex_1().min_w_0().truncate().child("Edit…"))
        .on_click(cx.listener(move |app, _, window, cx| {
            cx.stop_propagation();
            app.open_workspace_editor(Some(edit_id.clone()), window, cx);
        }));
    let remove = div()
        .id("rail-menu-remove")
        .test_support()
        .a11y(
            gpui_kit::Role::MenuItem,
            "rail.menu.remove-workspace",
            "Remove workspace",
        )
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .w_full()
        .min_h(px(MENU_ROW_HEIGHT_PX))
        .px(px(8.0))
        .py(px(4.0))
        .rounded(px(MENU_ROW_RADIUS_PX))
        .text_size(px(MENU_FONT_PX))
        .line_height(px(MENU_LINE_PX))
        .text_color(destructive)
        .cursor_pointer()
        .hover(move |s| s.bg(highlight))
        .child(icons::concept(
            "superhero/delete.svg",
            MENU_ICON_PX,
            destructive,
        ))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .child("Remove workspace"),
        )
        .on_click(cx.listener(move |app, _, window, cx| {
            cx.stop_propagation();
            app.confirm_remove_workspace(workspace_id.clone(), workspace_name.clone(), window, cx);
        }));
    let list = menu_surface(SharedString::from("rail-menu"), tokens)
        .a11y(gpui_kit::Role::Menu, "rail.menu", "Workspace actions")
        .child(edit)
        .child(remove);
    deferred(
        anchored()
            .position(anchor.position)
            .snap_to_window_with_margin(px(8.0))
            .child(list),
    )
    .with_priority(6)
    .into_any_element()
}

/// Renders the vertical workspace rail matching real Conn (`WorkspaceRail.tsx`).
#[must_use]
pub(crate) fn render_workspace_rail(
    workspaces: &[OrbitWorkspace],
    images: &WorkspaceImages,
    active_workspace: Option<&str>,
    tokens: &Tokens,
    geometry: &ShellGeometry,
    gesture: &RailGesture,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::Stateful<gpui_kit::Div> {
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
    )
    .a11y_button("rail.all-projects", "All projects")
    .aria_selected(all_active)
    .conn_tooltip("All projects", tokens);

    // While a tile is held the others have made room for it (`SortableContext`): the list is
    // drawn in the order a drop would leave, with an empty slot where the held tile will land.
    let held = gesture.state.drag();
    let shown: Vec<&OrbitWorkspace> = match held {
        Some(drag) => workspace_order::preview(workspaces, &drag.id, &drag.over),
        None => workspaces.iter().collect(),
    };
    let mut workspace_btns: Vec<AnyElement> = shown
        .into_iter()
        .map(|ws| {
            if held.is_some_and(|drag| drag.id == ws.id) {
                return div()
                    .id(SharedString::from(format!("rail-ws-slot-{}", ws.id)))
                    .size(px(RAIL_BUTTON_SIZE_PX))
                    .flex_shrink_0()
                    .into_any_element();
            }
            let ws_id = ws.id.clone();
            let is_active = active_workspace == Some(ws.id.as_str());
            let ax_id = SharedString::from(format!("rail.workspace.{}", ws.id));
            let press_id = ws.id.clone();
            let menu_id = ws.id.clone();
            let menu_name = ws.name.clone();
            rail_button(
                SharedString::from(format!("rail-ws-{}", ws.id)),
                is_active,
                tokens,
                workspace_tile(ws, images, tokens),
                cx.listener(move |app, _event, _window, cx| {
                    // The click that ends a drag selects nothing.
                    if !app.rail_click_suppressed() {
                        app.select_workspace(Some(ws_id.clone()), cx);
                    }
                }),
            )
            // A press that moves 6px drags the tile (`PointerSensor` `distance: 6`).
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |app, event: &MouseDownEvent, _window, cx| {
                    app.rail_tile_pressed(&press_id, event.position, cx);
                }),
            )
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |app, event: &MouseDownEvent, _window, cx| {
                    cx.stop_propagation();
                    app.open_rail_menu(menu_id.clone(), menu_name.clone(), event.position, cx);
                }),
            )
            .child(measure_tile(&gesture.bounds, &ws.id))
            .test_support()
            .a11y_button(ax_id, format!("Workspace {}", ws.name))
            .aria_selected(is_active)
            // Conn's tooltip: the name, then the hint `drag to reorder`.
            .conn_tooltip(format!("{} · drag to reorder", ws.name), tokens)
            .into_any_element()
        })
        .collect();
    let held_tile = held.and_then(|drag| {
        let ws = workspaces.iter().find(|w| w.id == drag.id)?;
        let is_active = active_workspace == Some(ws.id.as_str());
        Some(render_held_tile(ws, images, drag, is_active, tokens))
    });
    workspace_btns.extend(held_tile);

    let add_workspace_btn = rail_button(
        "rail-new-workspace",
        false,
        tokens,
        icons::chrome(IconName::Plus, muted),
        cx.listener(|app, _event, window, cx| {
            app.open_workspace_editor(None, window, cx);
        }),
    )
    .test_support()
    .a11y_button("rail.new-workspace", "New workspace")
    .conn_tooltip("New workspace", tokens);

    let usage_btn = rail_button(
        "rail-usage",
        false,
        tokens,
        icons::chrome(IconName::ChartNoAxesColumn, muted),
        cx.listener(|app, _event, _window, cx| {
            app.activate_or_toggle_right_panel_tab(RightPanelTab::Tasks, cx);
        }),
    )
    .a11y_button("rail.tasks", "Tasks & usage")
    .conn_tooltip("Tasks & usage", tokens);

    let pull_requests_btn = rail_button(
        "rail-pull-requests",
        false,
        tokens,
        icons::concept(icons::PULL_REQUEST, icons::CHROME_ICON_PX, muted),
        cx.listener(|app, _event, _window, cx| {
            app.activate_or_toggle_right_panel_tab(RightPanelTab::LinkedItems, cx);
        }),
    )
    .a11y_button("rail.pull-requests", "Pull requests")
    .conn_tooltip("Pull requests", tokens);

    let settings_btn = rail_button(
        "rail-settings",
        false,
        tokens,
        icons::chrome(IconName::Settings, muted),
        cx.listener(|app, _event, window, cx| {
            app.open_settings(window, cx);
        }),
    )
    .a11y_button("rail.settings", "Settings")
    .aria_keyshortcuts("Meta+,")
    .conn_tooltip("Settings (⌘,)", tokens);

    div()
        .id("workspace-rail")
        .a11y(gpui_kit::Role::Navigation, "rail.container", "Workspace rail")
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
                .window_control_area(WindowControlArea::Drag)
                .on_mouse_down(MouseButton::Left, |event: &MouseDownEvent, window, _| {
                    if event.click_count == 2 {
                        window.zoom_window();
                    } else {
                        window.start_window_move();
                    }
                }),
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
                        .children(workspace_btns)
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
