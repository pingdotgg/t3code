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
//!     button (`SquareMenu` -> `superhero/panel-menu.svg`, `16px`), which opens the
//!     `ThreadDetailsCard` popover (`details_card.rs`).
//!   - When the right panel is closed, Conn shows the `gap-1` (`4px`) ghost toggle
//!     trio: thread details (`panel-menu`), terminal drawer (`panel-bottom`), and
//!     right panel (`sidebar-right`).
//! - The project chip starts a new thread in that project; the thread title opens the
//!   Thread Actions menu (hover chevron, click after `500ms`), double-click renames inline,
//!   and right-click anywhere on the header opens the same menu.

pub(crate) mod details_card;

use gpui_kit::TestSupportExt as _;

use conn_state::{LayoutState, RightPanelTab, ShellState};
use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::{
    Context, Entity, InteractiveElement as _, MouseButton, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, WindowControlArea, div, px,
};

use crate::a11y::ConnA11yExt as _;
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

/// Header state the chat header reads from `ConnApp`.
pub(crate) struct ChatHeaderProps<'a> {
    pub(crate) shell: &'a ShellState,
    pub(crate) layout: &'a LayoutState,
    pub(crate) draft_project_id: Option<&'a str>,
    /// Whether the Thread Details card is open (`SquareMenu` pressed).
    pub(crate) details_open: bool,
    /// The header title is being renamed inline with this input.
    pub(crate) header_rename: Option<&'a Entity<InputState>>,
    pub(crate) tokens: &'a Tokens,
    pub(crate) geometry: &'a ShellGeometry,
}

/// Renders the 44px transparent chat header matching real Conn.
#[must_use]
pub(crate) fn render_chat_header(
    props: &ChatHeaderProps<'_>,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let (shell, layout, draft_project_id, tokens, geometry) = (
        props.shell,
        props.layout,
        props.draft_project_id,
        props.tokens,
        props.geometry,
    );
    let fg = hsla(tokens.foreground);
    let muted = hsla(tokens.muted_foreground);
    let separator_color = hsla_alpha(tokens.muted_foreground, 0.55);
    let sidebar_hover_bg = hsla(tokens.sidebar_row_hover);

    let active_thread = layout
        .selected_thread_id
        .as_deref()
        .and_then(|id| shell.find_thread(id));
    let active_project = active_thread
        .and_then(|t| shell.project(&t.project_id))
        .or_else(|| draft_project_id.and_then(|id| shell.project(id)));

    let thread_title = if draft_project_id.is_some() {
        "New thread"
    } else {
        active_thread
            .map(|t| t.title.as_str())
            .unwrap_or("New thread")
    };

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
                .a11y_button("header.open-sidebar", "Show sidebar")
                .aria_keyshortcuts("Meta+B")
                .flex()
                .items_center()
                .justify_center()
                .size(px(HEADER_CONTROL_BTN_PX))
                .flex_shrink_0()
                .rounded(px(SIDEBAR_TOGGLE_RADIUS_PX))
                .cursor_pointer()
                .hover(move |s| s.bg(sidebar_hover_bg))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
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
        .id("header-breadcrumb")
        .a11y_group("header.breadcrumb", "Thread breadcrumb")
        .flex()
        .flex_row()
        .items_center()
        .gap(px(12.0))
        .min_w_0()
        .flex_1()
        .overflow_hidden()
        .text_size(px(BREADCRUMB_FONT_SIZE_PX));

    if let Some(project) = active_project {
        let project_id = project.id.clone();
        breadcrumb = breadcrumb
            .child(
                div()
                    .id("header-project-chip")
                    .a11y_button("header.project", format!("New thread in {}", project.title))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .flex_shrink_0()
                    .max_w(px(160.0))
                    .overflow_hidden()
                    .rounded(px(4.0))
                    .cursor_pointer()
                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                    .text_color(muted)
                    .hover(move |s| s.text_color(fg))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |app, _, window, cx| {
                        app.start_new_thread(Some(project_id.clone()), Some(window), cx);
                    }))
                    .conn_tooltip(format!("New thread in {}", project.title), tokens)
                    .child(render_project_favicon(
                        project,
                        BREADCRUMB_FAVICON_PX,
                        tokens,
                    ))
                    .child(div().min_w_0().truncate().child(project.title.clone())),
            )
            .child(div().flex_shrink_0().text_color(separator_color).child("/"));
    }

    let server_thread = draft_project_id.is_none() && active_thread.is_some();
    if let Some(rename_input) = props.header_rename.filter(|_| server_thread) {
        // Inline header rename: `ring-1 ring-inset ring-ring/50`, commits on Enter and blur.
        breadcrumb = breadcrumb.child(
            div()
                .id("header-thread-rename")
                .a11y_group("header.thread-title.rename", "Rename thread")
                .flex_1()
                .min_w_0()
                .px(px(4.0))
                .rounded(px(4.0))
                .border_1()
                .border_color(hsla_alpha(tokens.ring, 0.50))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_key_down(cx.listener(|app, event: &gpui_kit::KeyDownEvent, _, cx| {
                    if event.keystroke.key == "escape" {
                        app.cancel_thread_rename(cx);
                        cx.stop_propagation();
                    }
                }))
                .child(
                    Input::new(rename_input)
                        .appearance(false)
                        .text_size(px(BREADCRUMB_FONT_SIZE_PX)),
                ),
        );
    } else if let Some(thread) = active_thread.filter(|_| server_thread) {
        // Thread title button: hover chevron, click opens the Thread Actions menu after the
        // `500ms` double-click window, double-click renames.
        let menu_id = thread.id.clone();
        let rename_id = thread.id.clone();
        let rename_title = thread.title.clone();
        let chevron_id = thread.id.clone();
        breadcrumb = breadcrumb.child(
            div()
                .id("header-thread-title")
                .a11y_button(
                    "header.thread-title",
                    format!("Thread actions for {thread_title}"),
                )
                .group("header-thread-title")
                .flex()
                .flex_row()
                .items_center()
                .gap(px(4.0))
                .min_w_0()
                .max_w_full()
                .rounded(px(4.0))
                .cursor_pointer()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(
                    cx.listener(move |app, event: &gpui_kit::ClickEvent, window, cx| {
                        if event.click_count() >= 2 {
                            app.start_header_rename(
                                rename_id.clone(),
                                rename_title.clone(),
                                window,
                                cx,
                            );
                        } else {
                            app.schedule_header_title_menu(menu_id.clone(), event.position(), cx);
                        }
                    }),
                )
                .conn_tooltip(thread_title.to_owned(), tokens)
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                        .text_color(fg)
                        .child(thread_title.to_owned()),
                )
                .child(
                    div()
                        .id("header-thread-title-chevron")
                        .a11y_button("header.thread-title.menu", "Open thread actions menu")
                        .flex_shrink_0()
                        .opacity(0.0)
                        .group_hover("header-thread-title", |s| s.opacity(1.0))
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(
                            cx.listener(move |app, event: &gpui_kit::ClickEvent, _, cx| {
                                cx.stop_propagation();
                                app.open_thread_menu(chevron_id.clone(), event.position(), cx);
                            }),
                        )
                        .child(icons::concept("superhero/chevron-down.svg", 14.0, muted)),
                ),
        );
    } else {
        breadcrumb = breadcrumb.child(
            div()
                .id("header-thread-title")
                .a11y(
                    gpui_kit::Role::Heading,
                    "header.thread-title",
                    thread_title.to_owned(),
                )
                .min_w_0()
                .flex_1()
                .overflow_hidden()
                .truncate()
                .font_weight(gpui_kit::FontWeight::MEDIUM)
                .text_color(fg)
                .conn_tooltip(thread_title.to_owned(), tokens)
                .child(thread_title.to_owned()),
        );
    }

    left_group = left_group.child(breadcrumb);

    // Right-side controls (`ThreadPanelHeaderControl` / `PanelLayoutControls`):
    // When the right panel is open, only the thread details/linked items button sits on
    // the chat header; when closed, the terminal and right-panel toggles join it.
    let details_active = props.details_open;
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
                cx.listener(|app, _event, window, cx| {
                    app.toggle_thread_details(window, cx);
                }),
            )
            .test_support()
            .a11y_button("header.thread-details", "Toggle thread details panel")
            .aria_selected(details_active)
            .conn_tooltip("Toggle thread details", tokens),
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
                .a11y_button("header.toggle-terminal", "Toggle terminal")
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
                .a11y_button("header.toggle-right-panel", "Toggle right panel")
                .aria_keyshortcuts("Meta+Alt+B")
                .conn_tooltip("Toggle right panel (⌘⌥B)", tokens),
            );
    }

    let menu_thread = active_thread
        .filter(|_| draft_project_id.is_none())
        .map(|t| t.id.clone());
    div()
        .id("chat-header-bar")
        .a11y(gpui_kit::Role::Toolbar, "header.bar", "Thread header")
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
        .on_mouse_down(MouseButton::Left, |event, window, _| {
            if event.click_count == 2 {
                window.zoom_window();
            } else {
                window.start_window_move();
            }
        })
        .on_mouse_down(
            MouseButton::Right,
            cx.listener(move |app, event: &gpui_kit::MouseDownEvent, _, cx| {
                if let Some(thread_id) = &menu_thread {
                    cx.stop_propagation();
                    app.open_thread_menu(thread_id.clone(), event.position, cx);
                }
            }),
        )
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
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(on_click)
        .child(icons::concept(icon_path, icons::CHROME_ICON_PX, icon_color));

    if pressed {
        btn = btn.bg(hover_bg);
    }

    btn
}
