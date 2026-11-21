//! 44px transparent glass chat header (`ChatHeader.tsx`, `WorkspaceBreadcrumb.tsx`,
//! and `PanelLayoutControls.tsx` parity).
//!
//! Geometry (`apps/web/src/components/ChatView.tsx`, `chat/ChatHeader.tsx`,
//! `chat/PanelLayoutControls.tsx`, `WorkspaceBreadcrumb.tsx`):
//! - Header height: `44px` (`--shell-header-height`), transparent over frosted frame.
//! - Left padding: `20px` (`sm:px-5`) when the sidebar is open; `90px`
//!   (`--desktop-window-controls-inset`) when collapsed so the `28px` sidebar
//!   reopen button stays at `x = 90px` right of the macOS traffic lights.
//! - Right padding: `11px` (`--workspace-controls-right`).
//! - Breadcrumb: `14px` (`text-sm`), `12px` (`sm:gap-3`) between segments:
//!   `14px` (`size-3.5`) project favicon + `6px` (`gap-1.5`) + muted project label,
//!   `/` in muted icon tone, and medium foreground thread title.
//! - Right controls (`ThreadPanelHeaderControl` / `PanelLayoutControls`):
//!   - When the right panel is open, Conn shows only the `28px` ghost thread-details
//!     button (`SquareMenu` -> `superhero/panel-menu.svg`, `16px`).
//!   - When the right panel is closed, Conn shows the `gap-1` (`4px`) ghost toggle
//!     trio: thread details (`panel-menu`), terminal drawer (`panel-bottom`), and
//!     right panel (`sidebar-right`).

use conn_state::{LayoutState, RightPanelTab, ShellState};
use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::assets::IconName;
use gpui_kit::{
    Context, InteractiveElement as _, ParentElement as _, StatefulInteractiveElement as _,
    Styled as _, WindowControlArea, div, px,
};

use crate::app::ConnApp;
use crate::icons;
use crate::panels::chrome::ConnTooltipExt as _;
use crate::shell::MACOS_TRAFFIC_LIGHTS_INSET_PX;
use crate::sidebar::render_project_favicon;
use crate::theme::{hsla, hsla_alpha};

/// `sm:h-7 sm:min-w-7` (`28px`) for `Toggle size="sm"` and `SidebarTrigger`.
const HEADER_CONTROL_BTN_PX: f32 = 28.0;
/// `sm:px-5` (`20px`) left padding on desktop when the sidebar is open.
const HEADER_LEFT_PAD_OPEN_PX: f32 = 20.0;
/// `text-sm` (`14px`) breadcrumb font size (`WorkspaceBreadcrumb.tsx`).
const BREADCRUMB_FONT_SIZE_PX: f32 = 14.0;
/// `size-3.5` (`14px`) project favicon inside the breadcrumb (`ChatHeader.tsx:296`).
const BREADCRUMB_FAVICON_PX: f32 = 14.0;
/// `--control-radius: 0.5rem` (`8px`) on `SidebarTrigger`.
const SIDEBAR_TOGGLE_RADIUS_PX: f32 = 8.0;

/// Renders the 44px transparent chat header matching real Conn.
#[must_use]
pub(crate) fn render_chat_header(
    shell: &ShellState,
    layout: &LayoutState,
    tokens: &Tokens,
    geometry: &ShellGeometry,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::Div {
    let fg = hsla(tokens.foreground);
    let muted = hsla(tokens.muted_foreground);
    let separator_color = hsla_alpha(tokens.muted_foreground, 0.55);
    let sidebar_hover_bg = hsla(tokens.sidebar_row_hover);

    let active_thread = layout
        .selected_thread_id
        .as_deref()
        .and_then(|id| shell.thread(id));
    let active_project = active_thread.and_then(|t| shell.project(&t.project_id));

    let thread_title = active_thread
        .map(|t| t.title.as_str())
        .unwrap_or("New thread");

    // When the sidebar is collapsed, clear the macOS traffic lights (`90px`)
    // so the reopen-sidebar toggle sits at the exact same x=90px coordinate.
    let left_pad = if layout.sidebar_open {
        px(HEADER_LEFT_PAD_OPEN_PX)
    } else {
        px(MACOS_TRAFFIC_LIGHTS_INSET_PX)
    };

    let mut left_group = div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(12.0))
        .flex_1()
        .min_w_0()
        .overflow_hidden();

    if !layout.sidebar_open {
        left_group = left_group.child(
            div()
                .id("header-open-sidebar")
                .flex()
                .items_center()
                .justify_center()
                .size(px(HEADER_CONTROL_BTN_PX))
                .flex_shrink_0()
                .rounded(px(SIDEBAR_TOGGLE_RADIUS_PX))
                .cursor_pointer()
                .hover(move |s| s.bg(sidebar_hover_bg))
                .on_click(cx.listener(|app, _event, _window, cx| {
                    app.toggle_sidebar(cx);
                }))
                .conn_tooltip("Show sidebar (⌘B)", tokens)
                .child(icons::chrome(IconName::PanelLeft, muted)),
        );
    }

    // 14px breadcrumb (`ChatHeader.tsx` + `WorkspaceBreadcrumb.tsx`, `sm:gap-3` = 12px):
    // [14px project favicon + 6px gap + muted project label] / [medium foreground thread title].
    let mut breadcrumb = div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(12.0))
        .min_w_0()
        .flex_1()
        .overflow_hidden()
        .text_size(px(BREADCRUMB_FONT_SIZE_PX));

    if let Some(project) = active_project {
        breadcrumb = breadcrumb
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .flex_shrink_0()
                    .max_w(px(160.0))
                    .overflow_hidden()
                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                    .text_color(muted)
                    .child(render_project_favicon(
                        project,
                        BREADCRUMB_FAVICON_PX,
                        tokens,
                    ))
                    .child(div().min_w_0().truncate().child(project.title.clone())),
            )
            .child(div().flex_shrink_0().text_color(separator_color).child("/"));
    }

    breadcrumb = breadcrumb.child(
        div()
            .min_w_0()
            .flex_1()
            .overflow_hidden()
            .truncate()
            .font_weight(gpui_kit::FontWeight::MEDIUM)
            .text_color(fg)
            .child(thread_title.to_owned()),
    );

    left_group = left_group.child(breadcrumb);

    // Right-side controls (`ThreadPanelHeaderControl` / `PanelLayoutControls`):
    // When the right panel is open, only the thread details/linked items button sits on
    // the chat header; when closed, the terminal and right-panel toggles join it.
    let details_active =
        layout.right_panel_open && layout.right_panel_tab == RightPanelTab::LinkedItems;
    let mut right_group = div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(4.0))
        .flex_shrink_0()
        .child(
            header_ghost_toggle(
                "header-thread-details",
                icons::PANEL_MENU,
                details_active,
                tokens,
                cx.listener(|app, _event, _window, cx| {
                    app.activate_or_toggle_right_panel_tab(RightPanelTab::LinkedItems, cx);
                }),
            )
            .conn_tooltip("Linked items", tokens),
        );

    if !layout.right_panel_open {
        right_group = right_group
            .child(
                header_ghost_toggle(
                    "header-toggle-terminal",
                    icons::PANEL_BOTTOM,
                    false,
                    tokens,
                    cx.listener(|app, _event, _window, cx| {
                        app.activate_or_toggle_right_panel_tab(RightPanelTab::Terminal, cx);
                    }),
                )
                .conn_tooltip("Terminal", tokens),
            )
            .child(
                header_ghost_toggle(
                    "header-toggle-right-panel",
                    icons::SIDEBAR_RIGHT,
                    false,
                    tokens,
                    cx.listener(|app, _event, _window, cx| {
                        app.toggle_right_panel(cx);
                    }),
                )
                .conn_tooltip("Toggle right panel (⌘⌥B)", tokens),
            );
    }

    div()
        .flex()
        .flex_row()
        .items_center()
        .justify_between()
        .gap(px(12.0))
        .w_full()
        .h(px(geometry.header_height_px))
        .flex_shrink_0()
        .pl(left_pad)
        .pr(px(geometry.workspace_controls_right_px))
        .window_control_area(WindowControlArea::Drag)
        .child(left_group)
        .child(right_group)
}

/// Renders a `28px` ghost toggle button matching Conn's `Toggle variant="ghost" size="sm"`
/// inside `[data-chat-header]` (`--control-radius: 9999px`, transparent rest,
/// `shell_highlight` hover, icon at `foreground @ 80%`).
fn header_ghost_toggle(
    id: impl Into<gpui_kit::ElementId>,
    icon_path: &'static str,
    pressed: bool,
    tokens: &Tokens,
    on_click: impl Fn(&gpui_kit::ClickEvent, &mut gpui_kit::Window, &mut gpui_kit::App) + 'static,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let hover_bg = hsla(tokens.shell_highlight);
    let icon_color = if pressed {
        hsla(tokens.foreground)
    } else {
        hsla_alpha(tokens.foreground, 0.80)
    };

    let mut btn = div()
        .id(id)
        .flex()
        .items_center()
        .justify_center()
        .size(px(HEADER_CONTROL_BTN_PX))
        .flex_shrink_0()
        .rounded(px(9999.0))
        .cursor_pointer()
        .hover(move |s| s.bg(hover_bg))
        .on_click(on_click)
        .child(icons::concept(icon_path, icons::CHROME_ICON_PX, icon_color));

    if pressed {
        btn = btn.bg(hover_bg);
    }

    btn
}
