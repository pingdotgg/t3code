//! Thread sidebar column: 44px transparent header + inset card with
//! "New thread" row, soft search bar, collapsible project groups, and thread rows.

use std::collections::HashSet;

use conn_state::{LayoutState, ProjectShell, ShellState, ThreadActivity, ThreadShell};
use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::assets::IconName;
use gpui_kit::{
    Context, InteractiveElement as _, ParentElement as _, StatefulInteractiveElement as _,
    Styled as _, WindowControlArea, div, px,
};

use crate::app::ConnApp;
use crate::fixture::thread_activity;
use crate::icons;
use crate::shell::{CardJoin, inset_card};
use crate::theme::hsla;

const SIDEBAR_CONTENT_INSET_PX: f32 = 8.0;
const ROW_HORIZONTAL_INSET_PX: f32 = 10.0;
const ROW_RADIUS_PX: f32 = 8.0;
const ROW_HEIGHT_PX: f32 = 32.0;
const ACTIVITY_DOT_PX: f32 = 7.0;

/// Renders the thread sidebar column (`layout.sidebar_width` wide).
#[must_use]
pub(crate) fn render_thread_sidebar(
    shell: &ShellState,
    layout: &LayoutState,
    active_workspace: Option<&str>,
    collapsed_projects: &HashSet<String>,
    tokens: &Tokens,
    geometry: &ShellGeometry,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::Div {
    let fg = hsla(tokens.sidebar_foreground);
    let muted = hsla(tokens.sidebar_muted_foreground);
    let hover_bg = hsla(tokens.sidebar_row_hover);

    // 44px transparent header above the inset thread card.
    // Right-aligns the sidebar toggle button cleanly clear of the traffic lights.
    let sidebar_header = div()
        .flex()
        .flex_row()
        .items_center()
        .justify_end()
        .w_full()
        .h(px(geometry.header_height_px))
        .flex_shrink_0()
        .pr(px(10.0))
        .window_control_area(WindowControlArea::Drag)
        .child(
            div()
                .id("sidebar-collapse-btn")
                .flex()
                .items_center()
                .justify_center()
                .size(px(28.0))
                .rounded(px(9999.0))
                .cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .on_click(cx.listener(|app, _event, _window, cx| {
                    app.toggle_sidebar(cx);
                }))
                .child(icons::chrome(IconName::PanelLeft, muted)),
        );

    // "New thread" action row.
    let new_thread_row = div()
        .id("sidebar-new-thread")
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .w_full()
        .h(px(ROW_HEIGHT_PX))
        .px(px(ROW_HORIZONTAL_INSET_PX))
        .rounded(px(ROW_RADIUS_PX))
        .cursor_pointer()
        .text_size(px(geometry.ui_font_size_px))
        .line_height(px(geometry.ui_line_height_px))
        .text_color(fg)
        .hover(move |s| s.bg(hover_bg))
        .on_click(cx.listener(|_app, _event, _window, _cx| {}))
        .child(icons::chrome(IconName::SquarePen, muted))
        .child(div().flex_1().truncate().child("New thread"));

    // Soft search field (`h-8`, pill radius, `shell_field`, `shell_divider_header` border).
    let search_bar = div()
        .id("sidebar-search")
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .w_full()
        .h(px(geometry.toolbar_height_px))
        .px(px(10.0))
        .rounded(px(9999.0))
        .bg(hsla(tokens.shell_field))
        .border_1()
        .border_color(hsla(tokens.shell_divider_header))
        .text_size(px(geometry.ui_font_size_px))
        .line_height(px(geometry.ui_line_height_px))
        .text_color(hsla(tokens.placeholder))
        .child(icons::chrome(IconName::Search, muted))
        .child(div().flex_1().truncate().child("Search threads…"));

    // Filter projects by active workspace (None = All projects).
    let visible_projects: Vec<&ProjectShell> = shell
        .projects
        .iter()
        .filter(|project| active_workspace.is_none_or(|ws| ws == project.id))
        .collect();

    let mut project_sections = Vec::with_capacity(visible_projects.len());
    for (proj_idx, project) in visible_projects.into_iter().enumerate() {
        let collapsed = collapsed_projects.contains(&project.id);
        let threads: Vec<&ThreadShell> = shell.threads_for_project(&project.id).collect();
        project_sections.push(render_project_group(
            proj_idx,
            project,
            &threads,
            collapsed,
            shell,
            layout.selected_thread_id.as_deref(),
            tokens,
            geometry,
            cx,
        ));
    }

    // Inset panel card: joins the chat card on its right seam divider.
    let card = inset_card(
        tokens,
        geometry,
        CardJoin {
            left: false,
            right: true,
        },
    )
    .p(px(SIDEBAR_CONTENT_INSET_PX))
    .gap(px(6.0))
    .child(new_thread_row)
    .child(search_bar)
    .child(
        div()
            .id("sidebar-thread-scroll")
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .gap(px(4.0))
            .pt(px(4.0))
            .children(project_sections),
    );

    div()
        .flex()
        .flex_col()
        .w(px(layout.sidebar_width))
        .h_full()
        .flex_shrink_0()
        .child(sidebar_header)
        .child(card)
}

#[expect(
    clippy::too_many_arguments,
    reason = "pure view helper taking borrowed state slices"
)]
fn render_project_group(
    proj_idx: usize,
    project: &ProjectShell,
    threads: &[&ThreadShell],
    collapsed: bool,
    shell: &ShellState,
    selected_thread_id: Option<&str>,
    tokens: &Tokens,
    geometry: &ShellGeometry,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::Div {
    let fg = hsla(tokens.sidebar_foreground);
    let muted = hsla(tokens.sidebar_muted_foreground);
    let hover_bg = hsla(tokens.sidebar_row_hover);
    let project_id = project.id.clone();

    let mut header_row = div()
        .id(("project-group", proj_idx))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .w_full()
        .h(px(ROW_HEIGHT_PX))
        .px(px(ROW_HORIZONTAL_INSET_PX))
        .rounded(px(ROW_RADIUS_PX))
        .cursor_pointer()
        .hover(move |s| s.bg(hover_bg))
        .on_click(cx.listener(move |app, _event, _window, cx| {
            app.toggle_project_collapsed(&project_id, cx);
        }))
        .child(icons::chrome(IconName::Folder, muted))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(geometry.ui_font_size_px))
                .line_height(px(geometry.ui_line_height_px))
                .font_weight(gpui_kit::FontWeight::MEDIUM)
                .text_color(fg)
                .child(project.title.clone()),
        );

    if collapsed && !threads.is_empty() {
        header_row = header_row.child(
            div()
                .flex_shrink_0()
                .text_size(px(geometry.ui_font_size_px))
                .line_height(px(geometry.ui_line_height_px))
                .text_color(muted)
                .child(threads.len().to_string()),
        );
    }

    header_row = header_row.child(icons::caret(!collapsed, muted));

    let mut group = div()
        .flex()
        .flex_col()
        .w_full()
        .gap(px(2.0))
        .child(header_row);

    if !collapsed {
        let mut rows = Vec::with_capacity(threads.len());
        for (thread_idx, thread) in threads.iter().enumerate() {
            let selected = selected_thread_id == Some(thread.id.as_str());
            let activity = thread_activity(shell, thread);
            rows.push(render_thread_row(
                proj_idx * 1024 + thread_idx,
                thread,
                selected,
                activity,
                tokens,
                geometry,
                cx,
            ));
        }
        group = group.child(div().flex().flex_col().w_full().gap(px(1.0)).children(rows));
    }

    group
}

fn render_thread_row(
    row_key: usize,
    thread: &ThreadShell,
    selected: bool,
    activity: ThreadActivity,
    tokens: &Tokens,
    geometry: &ShellGeometry,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let fg = hsla(tokens.sidebar_foreground);
    let muted = hsla(tokens.sidebar_muted_foreground);
    let hover_bg = hsla(tokens.sidebar_row_hover);
    let selected_bg = hsla(tokens.sidebar_row_selected);
    let active_bg = hsla(tokens.sidebar_row_active);
    let thread_id = thread.id.clone();

    let status_indicator = render_activity_indicator(activity, tokens);

    let mut row = div()
        .id(("thread-row", row_key))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .w_full()
        .min_h(px(ROW_HEIGHT_PX))
        .pl(px(ROW_HORIZONTAL_INSET_PX + 10.0))
        .pr(px(ROW_HORIZONTAL_INSET_PX))
        .py(px(5.0))
        .rounded(px(ROW_RADIUS_PX))
        .cursor_pointer()
        .on_click(cx.listener(move |app, _event, _window, cx| {
            app.select_thread(thread_id.clone(), cx);
        }));

    if selected {
        row = row.bg(active_bg).hover(move |s| s.bg(active_bg));
    } else {
        row = row
            .hover(move |s| s.bg(hover_bg))
            .active(move |s| s.bg(selected_bg));
    }

    let title_color = if selected { fg } else { muted };

    let mut content = div().flex().flex_col().flex_1().min_w_0().child(
        div()
            .w_full()
            .truncate()
            .text_size(px(geometry.ui_font_size_px))
            .line_height(px(geometry.ui_line_height_px))
            .font_weight(if selected {
                gpui_kit::FontWeight::MEDIUM
            } else {
                gpui_kit::FontWeight::NORMAL
            })
            .text_color(title_color)
            .child(thread.title.clone()),
    );

    if let Some(branch) = thread.branch.as_deref() {
        content = content.child(
            div()
                .w_full()
                .truncate()
                .text_size(px(geometry.ui_font_size_px))
                .line_height(px(geometry.ui_line_height_px))
                .text_color(hsla(tokens.placeholder))
                .child(branch.to_owned()),
        );
    }

    row.child(status_indicator).child(content)
}

/// Renders a static, GPU-cheap activity dot/icon (no continuous repaint loop).
fn render_activity_indicator(
    activity: ThreadActivity,
    tokens: &Tokens,
) -> impl gpui_kit::IntoElement {
    let slot = div()
        .flex()
        .items_center()
        .justify_center()
        .size(px(14.0))
        .flex_shrink_0();

    match activity {
        ThreadActivity::Working => slot.child(
            div()
                .size(px(ACTIVITY_DOT_PX))
                .rounded(px(9999.0))
                .bg(hsla(tokens.info)),
        ),
        ThreadActivity::NeedsAttention => slot.child(
            div()
                .size(px(ACTIVITY_DOT_PX))
                .rounded(px(9999.0))
                .bg(hsla(tokens.warning)),
        ),
        ThreadActivity::Failed => slot.child(
            div()
                .size(px(ACTIVITY_DOT_PX))
                .rounded(px(9999.0))
                .bg(hsla(tokens.destructive)),
        ),
        ThreadActivity::Idle => slot.child(
            div()
                .size(px(ACTIVITY_DOT_PX - 2.0))
                .rounded(px(9999.0))
                .bg(hsla(tokens.shell_divider_header)),
        ),
    }
}
