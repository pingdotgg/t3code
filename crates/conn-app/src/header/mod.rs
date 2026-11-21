//! 44px transparent glass chat header, 28px circular action buttons, and
//! pill `ToolbarGroup` right-panel toggles.
//!
//! Matches `docs/design-spec.md` §3–4, `../conn/apps/web/src/components/chat/ChatHeader.tsx`,
//! `../conn/apps/web/src/components/WorkspaceBreadcrumb.tsx`, and
//! `../conn/apps/web/src/components/ToolbarGroup.tsx`:
//! - Header height: `44px` (`--shell-header-height`), transparent over frosted frame.
//! - Sidebar toggle sits at `x = 90px` directly right of the macOS traffic lights
//!   when the sidebar is collapsed (matching its open position in `thread_list.rs`).
//! - Breadcrumb typography: `14px` (`text-sm`), project monogram (`14px`) + muted
//!   project label + `/` + medium foreground thread title.
//! - Right controls inset: `11px` (`--workspace-controls-right`).
//! - Circular header buttons: `28px`, rest `shell_header_control`, hover `shell_header_control_hover`.
//! - `ToolbarGroup`: `32px` height, `9999px` pill radius, `3px` inner padding,
//!   `shell_control` fill, `1px` `shell_divider_header` border, `24px` ghost buttons
//!   inside whose active state brightens the icon to `foreground` with no fill.

use conn_state::{LayoutState, RightPanelTab, ShellState};
use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::assets::IconName;
use gpui_kit::{
    Context, InteractiveElement as _, ParentElement as _, StatefulInteractiveElement as _,
    Styled as _, WindowControlArea, div, px,
};

use crate::app::ConnApp;
use crate::icons;
use crate::shell::MACOS_TRAFFIC_LIGHTS_INSET_PX;
use crate::sidebar::render_project_monogram;
use crate::theme::{hsla, hsla_alpha};

const HEADER_ACTION_BTN_PX: f32 = 28.0;
const TOOLBAR_INNER_PADDING_PX: f32 = 3.0;
const TOOLBAR_BUTTON_SIZE_PX: f32 = 24.0;
const BREADCRUMB_FONT_SIZE_PX: f32 = 14.0;
const BREADCRUMB_MONOGRAM_PX: f32 = 14.0;
const SIDEBAR_TOGGLE_RADIUS_PX: f32 = 6.0;

/// Primary right-panel toggles shown in the chat header's `ToolbarGroup`.
const HEADER_PANEL_TOGGLES: [RightPanelTab; 4] = [
    RightPanelTab::Files,
    RightPanelTab::Diff,
    RightPanelTab::Terminal,
    RightPanelTab::Browser,
];

/// Renders the 44px transparent chat header.
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
    let separator_color = hsla_alpha(tokens.muted_foreground, 0.70);
    let sidebar_hover_bg = hsla(tokens.sidebar_row_hover);

    let active_thread = layout
        .selected_thread_id
        .as_deref()
        .and_then(|id| shell.thread(id));
    let active_project = active_thread.and_then(|t| shell.project(&t.project_id));

    let project_name = active_project
        .map(|p| p.title.as_str())
        .unwrap_or("No project");
    let thread_title = active_thread
        .map(|t| t.title.as_str())
        .unwrap_or("New thread");

    // When the sidebar is collapsed, clear the macOS traffic lights (`90px`)
    // so the reopen-sidebar toggle sits at the exact same x=90px coordinate.
    let left_pad = if layout.sidebar_open {
        px(16.0)
    } else {
        px(MACOS_TRAFFIC_LIGHTS_INSET_PX)
    };

    let mut left_group = div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(12.0))
        .flex_1()
        .min_w_0();

    if !layout.sidebar_open {
        left_group = left_group.child(
            div()
                .id("header-open-sidebar")
                .flex()
                .items_center()
                .justify_center()
                .size(px(HEADER_ACTION_BTN_PX))
                .flex_shrink_0()
                .rounded(px(SIDEBAR_TOGGLE_RADIUS_PX))
                .cursor_pointer()
                .hover(move |s| s.bg(sidebar_hover_bg))
                .on_click(cx.listener(|app, _event, _window, cx| {
                    app.toggle_sidebar(cx);
                }))
                .child(icons::chrome(IconName::PanelLeft, muted)),
        );
    }

    // 14px breadcrumb (`ChatHeader.tsx` + `WorkspaceBreadcrumb.tsx`):
    // [14px project monogram + muted project label] / [medium foreground thread title].
    let mut breadcrumb = div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .min_w_0()
        .flex_1()
        .text_size(px(BREADCRUMB_FONT_SIZE_PX));

    if active_project.is_some() {
        breadcrumb = breadcrumb
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .flex_shrink_0()
                    .max_w(px(160.0))
                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                    .text_color(muted)
                    .child(render_project_monogram(
                        project_name,
                        BREADCRUMB_MONOGRAM_PX,
                        tokens,
                    ))
                    .child(div().min_w_0().truncate().child(project_name.to_owned())),
            )
            .child(div().flex_shrink_0().text_color(separator_color).child("/"));
    }

    breadcrumb = breadcrumb.child(
        div()
            .min_w_0()
            .flex_1()
            .truncate()
            .font_weight(gpui_kit::FontWeight::MEDIUM)
            .text_color(fg)
            .child(thread_title.to_owned()),
    );

    left_group = left_group.child(breadcrumb);

    // Right-side controls: ToolbarGroup pill + 28px circular button, 11px right inset.
    let toolbar_group = render_panel_toolbar_group(layout, tokens, geometry, cx);
    let toggle_panel_btn = header_circle_button(
        "header-toggle-right-panel",
        IconName::PanelRight,
        layout.right_panel_open,
        tokens,
        cx.listener(|app, _event, _window, cx| {
            app.toggle_right_panel(cx);
        }),
    );

    let right_group = div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .flex_shrink_0()
        .child(toolbar_group)
        .child(toggle_panel_btn);

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

/// Renders a `28px` circular chat header button (`shell_header_control` rest,
/// `shell_header_control_hover` hover; active brightens icon to `foreground`).
#[must_use]
pub(crate) fn header_circle_button(
    id: impl Into<gpui_kit::ElementId>,
    icon_name: IconName,
    active: bool,
    tokens: &Tokens,
    on_click: impl Fn(&gpui_kit::ClickEvent, &mut gpui_kit::Window, &mut gpui_kit::App) + 'static,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let rest_bg = hsla(tokens.shell_header_control);
    let hover_bg = hsla(tokens.shell_header_control_hover);
    let icon_color = if active {
        hsla(tokens.foreground)
    } else {
        hsla(tokens.muted_foreground)
    };

    div()
        .id(id)
        .flex()
        .items_center()
        .justify_center()
        .size(px(HEADER_ACTION_BTN_PX))
        .flex_shrink_0()
        .rounded(px(9999.0))
        .bg(rest_bg)
        .cursor_pointer()
        .hover(move |s| s.bg(hover_bg))
        .on_click(on_click)
        .child(icons::chrome(icon_name, icon_color))
}

/// Renders Conn's pill `ToolbarGroup` (`h-8`, `3px` padding, `24px` ghost buttons).
fn render_panel_toolbar_group(
    layout: &LayoutState,
    tokens: &Tokens,
    geometry: &ShellGeometry,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::Div {
    let fg = hsla(tokens.foreground);
    let muted = hsla(tokens.muted_foreground);
    let hover_bg = hsla(tokens.shell_highlight);

    let mut buttons = Vec::with_capacity(HEADER_PANEL_TOGGLES.len());
    for (idx, tab) in HEADER_PANEL_TOGGLES.into_iter().enumerate() {
        let pressed = layout.right_panel_open && layout.right_panel_tab == tab;
        // Pressed toggles keep no fill and brighten their icon to `foreground`.
        let icon_color = if pressed { fg } else { muted };

        buttons.push(
            div()
                .id(("header-panel-toggle", idx))
                .flex()
                .items_center()
                .justify_center()
                .size(px(TOOLBAR_BUTTON_SIZE_PX))
                .rounded(px(9999.0))
                .cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .on_click(cx.listener(move |app, _event, _window, cx| {
                    app.activate_or_toggle_right_panel_tab(tab, cx);
                }))
                .child(icons::chrome(icons::right_panel_tab_icon(tab), icon_color)),
        );
    }

    div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(2.0))
        .h(px(geometry.toolbar_height_px))
        .px(px(TOOLBAR_INNER_PADDING_PX))
        .rounded(px(9999.0))
        .bg(hsla(tokens.shell_control))
        .border_1()
        .border_color(hsla(tokens.shell_divider_header))
        .children(buttons)
}
