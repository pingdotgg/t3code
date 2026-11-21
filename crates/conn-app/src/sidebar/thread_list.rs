//! Thread sidebar column (`Sidebar.tsx`, `SidebarThreadHeader.tsx`, `SidebarThreadRow.tsx` parity).
//!
//! Layout matching real Conn (`apps/web/src/components/sidebar/`):
//! - `44px` transparent header with the sidebar toggle at `x = 90px` from the
//!   window edge (`36px` inside the sidebar column, right of macOS traffic lights).
//! - Inset panel card:
//!   - Fixed top `SidebarGroup` (`p-2` = `8px`): `"Search"` (`h-8`, `text-sm font-medium`)
//!     + trailing `28x28` icon buttons (`ListFilter`, `FolderPlus`, `SquarePen`).
//!   - Scrollable `SidebarGroup` (`px-2 pb-2`, `gap-px`): two-line card rows
//!     (`SidebarThreadRow.tsx` `variant="card"`):
//!     - Outer wrapper: `py-0.5` (`2px`), card `rounded-lg` (`8px`), `px-2.5 py-2` (`10px`/`8px`),
//!       `border-t` (`--shell-divider-raised/50` when active, transparent otherwise).
//!     - Line 1 (`h-5`, `gap-1.5`): `16px` project favicon/monogram wrapped in `StatusDotBadge`
//!       (`6px` corner status dot for working / attention / failed / unread) + `14px` medium title.
//!     - Line 2 (`mt-1`, `ps-5.5` = `22px`, `gap-1.5`, `text-xs` = `12px`, muted):
//!       `14px` provider icon · project name · branch (when present) · compact relative age.
//!   - `Settled` collapsible section header (`SidebarSectionHeader`) pushed to the
//!     bottom (`mt-auto`) when settled threads exist; hidden when empty.

use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use conn_state::{LayoutState, ProjectShell, ShellState, ThreadActivity, ThreadShell};
use conn_theme::{Appearance, ShellGeometry, Tokens};
use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::{
    Context, Entity, InteractiveElement as _, IntoElement as _, MouseButton, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, WindowControlArea, deferred, div, px,
};

use crate::app::ConnApp;
use crate::fixture::thread_activity;
use crate::icons;
use crate::panels::chrome::ConnTooltipExt as _;
use crate::shell::{CardJoin, MACOS_TRAFFIC_LIGHTS_INSET_PX, WORKSPACE_RAIL_WIDTH_PX, inset_card};
use crate::sidebar::{render_project_favicon, render_project_monogram};
use crate::theme::{hsla, hsla_alpha};

/// `--sidebar-content-inset: 0.5rem` (`8px`).
const SIDEBAR_CONTENT_INSET_PX: f32 = 8.0;
/// `--sidebar-row-content-inset: 0.625rem` (`10px`).
const ROW_HORIZONTAL_INSET_PX: f32 = 10.0;
/// `rounded-lg` (`--radius: 0.5rem` = `8px`) on thread cards and icon controls.
const ROW_RADIUS_PX: f32 = 8.0;
/// `rounded-md` (`6px`) on the search field and collapsible section header.
const SEARCH_RADIUS_PX: f32 = 6.0;
/// `size-7` (`28px`) for `SidebarHeaderIconButton` and `SidebarTrigger`.
const HEADER_ICON_BTN_PX: f32 = 28.0;
/// `size-4` (`16px`) for `ProjectFavicon` / `ProjectMonogram` in thread rows.
const ROW_FAVICON_PX: f32 = 16.0;
/// `ps-5.5` (`22px` = `16px` favicon + `6px` gap) aligning line 2 under the title.
const META_LINE_INDENT_PX: f32 = 22.0;
/// `text-sm` (`14px` / `20px`) for search field and thread row titles.
const TITLE_FONT_SIZE_PX: f32 = 14.0;
const TITLE_LINE_HEIGHT_PX: f32 = 20.0;
/// `text-xs` (`12px` / `16px`) for line-2 metadata and Settled section header.
const META_FONT_SIZE_PX: f32 = 12.0;
const META_LINE_HEIGHT_PX: f32 = 16.0;
/// `size-1.5` (`6px`) corner dot in `StatusDotBadge.tsx`.
const STATUS_DOT_PX: f32 = 6.0;
/// Left offset inside the sidebar header so the toggle sits at `x = 90px`
/// (`--desktop-window-controls-inset`) directly right of the traffic lights.
const SIDEBAR_TOGGLE_LEFT_OFFSET_PX: f32 = MACOS_TRAFFIC_LIGHTS_INSET_PX - WORKSPACE_RAIL_WIDTH_PX;
/// Sentinel key stored in `collapsed_projects` to toggle the Settled shelf
/// without requiring a new field on `ConnApp`.
const SETTLED_SHELF_TOGGLE_KEY: &str = "__settled__";

/// Status dot state matching `StatusDotBadge.tsx`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StatusDotState {
    Working,
    Waiting,
    #[expect(
        dead_code,
        reason = "ready for unread-completion tracking in LayoutState"
    )]
    Done,
    Failed,
}

impl StatusDotState {
    fn from_activity(activity: ThreadActivity) -> Option<Self> {
        match activity {
            ThreadActivity::Working => Some(Self::Working),
            ThreadActivity::NeedsAttention => Some(Self::Waiting),
            ThreadActivity::Failed => Some(Self::Failed),
            ThreadActivity::Idle => None,
        }
    }
}

/// Renders the thread sidebar column (`layout.sidebar_width` wide).
#[expect(
    clippy::too_many_arguments,
    reason = "renders the sidebar from borrowed shell, layout, search, and theme state"
)]
#[must_use]
pub(crate) fn render_thread_sidebar(
    shell: &ShellState,
    layout: &LayoutState,
    active_workspace: Option<&str>,
    collapsed_projects: &HashSet<String>,
    search_input: &Entity<InputState>,
    renaming_thread_id: Option<&str>,
    rename_input: &Entity<InputState>,
    filter_menu_open: bool,
    tokens: &Tokens,
    geometry: &ShellGeometry,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::Div {
    let fg = hsla(tokens.sidebar_foreground);
    let muted = hsla(tokens.sidebar_muted_foreground);
    let search_icon_color = hsla_alpha(tokens.sidebar_muted_foreground, 0.85);
    let hover_bg = hsla(tokens.sidebar_row_hover);
    let has_projects = !shell.projects.is_empty();
    let search_query = search_input.read(cx).value().to_string();
    let has_query = !search_query.trim().is_empty();

    // 44px transparent header above the inset thread card.
    // Places the sidebar toggle directly right of the macOS traffic lights
    // (`x = 90px` from window left edge, matching `AppSidebarLayout.tsx`).
    let sidebar_header = div()
        .flex()
        .flex_row()
        .items_center()
        .justify_start()
        .w_full()
        .h(px(geometry.header_height_px))
        .flex_shrink_0()
        .pl(px(SIDEBAR_TOGGLE_LEFT_OFFSET_PX))
        .window_control_area(WindowControlArea::Drag)
        .child(
            div()
                .id("sidebar-collapse-btn")
                .flex()
                .items_center()
                .justify_center()
                .size(px(HEADER_ICON_BTN_PX))
                .rounded(px(ROW_RADIUS_PX))
                .cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .on_click(cx.listener(|app, _event, _window, cx| {
                    app.toggle_sidebar(cx);
                }))
                .child(icons::chrome(IconName::PanelLeftClose, muted)),
        );

    // Top row (`SidebarThreadHeader.tsx`): "Search" soft field + trailing icon buttons.
    let mut header_actions = div().flex().flex_row().items_center().flex_shrink_0();
    if has_projects {
        let mut filter_slot = div().relative().child(
            sidebar_header_icon_btn(
                "sidebar-filter-projects",
                IconName::ListFilter,
                tokens,
                cx.listener(|app, _event, _window, cx| {
                    cx.stop_propagation();
                    app.toggle_sidebar_filter_menu(cx);
                }),
            )
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .conn_tooltip(
                if active_workspace.is_some() {
                    "Filter by project (active)"
                } else {
                    "Filter by project"
                },
                tokens,
            ),
        );
        if filter_menu_open {
            filter_slot = filter_slot.child(render_project_filter_menu(
                shell,
                active_workspace,
                tokens,
                geometry,
                cx,
            ));
        }
        header_actions = header_actions.child(filter_slot).child(
            sidebar_header_icon_btn(
                "sidebar-add-project",
                IconName::FolderPlus,
                tokens,
                cx.listener(|app, _event, window, cx| app.add_project_via_picker(window, cx)),
            )
            .conn_tooltip("Add project", tokens),
        );
    }
    header_actions = header_actions.child(
        sidebar_header_icon_btn(
            "sidebar-new-thread",
            IconName::SquarePen,
            tokens,
            cx.listener(|app, _event, _window, cx| app.start_new_thread(None, cx)),
        )
        .conn_tooltip("New thread (⌘N)", tokens),
    );

    let mut search_box = div()
        .id("sidebar-search")
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .flex_1()
        .min_w_0()
        .h(px(geometry.toolbar_height_px))
        .px(px(8.0))
        .rounded(px(SEARCH_RADIUS_PX))
        .cursor_text()
        .text_size(px(TITLE_FONT_SIZE_PX))
        .line_height(px(TITLE_LINE_HEIGHT_PX))
        .font_weight(gpui_kit::FontWeight::MEDIUM)
        .text_color(fg)
        .hover(move |s| s.bg(hover_bg))
        .child(icons::chrome(IconName::Search, search_icon_color))
        .child(
            div().flex_1().min_w_0().child(
                Input::new(search_input)
                    .appearance(false)
                    .text_size(px(TITLE_FONT_SIZE_PX)),
            ),
        );
    if has_query {
        let search_to_clear = search_input.clone();
        search_box = search_box.child(
            div()
                .id("sidebar-search-clear")
                .flex()
                .items_center()
                .justify_center()
                .size(px(18.0))
                .flex_shrink_0()
                .rounded(px(4.0))
                .cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .on_click(move |_, window, cx| {
                    search_to_clear.update(cx, |state, cx| {
                        state.set_value(String::new(), window, cx);
                    });
                })
                .child(icons::concept("superhero/close.svg", 12.0, muted)),
        );
    }

    let top_row = div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(4.0))
        .w_full()
        .flex_shrink_0()
        .p(px(SIDEBAR_CONTENT_INSET_PX))
        .child(search_box)
        .child(header_actions);

    // Flat list of threads, scoped to `active_workspace` and live sidebar search when set.
    let now_secs = current_unix_secs();
    let visible_threads: Vec<&ThreadShell> = shell
        .threads
        .iter()
        .filter(|thread| active_workspace.is_none_or(|ws| ws == thread.project_id))
        .filter(|thread| {
            thread_matches_search(thread, shell.project(&thread.project_id), &search_query)
        })
        .collect();

    let mut thread_rows = Vec::with_capacity(visible_threads.len());
    for (idx, thread) in visible_threads.into_iter().enumerate() {
        let project = shell.project(&thread.project_id);
        let selected = layout.selected_thread_id.as_deref() == Some(thread.id.as_str());
        let is_renaming = renaming_thread_id == Some(thread.id.as_str());
        let activity = thread_activity(shell, thread);
        thread_rows.push(render_thread_card(
            idx,
            thread,
            project,
            selected,
            false,
            is_renaming,
            rename_input,
            activity,
            now_secs,
            tokens,
            cx,
        ));
    }

    // Settled shelf (`SidebarSectionHeader` in `Sidebar.tsx`): always shown, with its count
    // (Conn shows "Settled 0"), pushed to the bottom of the list with `mt-auto`.
    let settled_threads: Vec<&ThreadShell> = shell
        .archived_threads
        .iter()
        .filter(|thread| active_workspace.is_none_or(|ws| ws == thread.project_id))
        .filter(|thread| {
            thread_matches_search(thread, shell.project(&thread.project_id), &search_query)
        })
        .collect();
    let settled_count = settled_threads.len();
    let settled_expanded = collapsed_projects.contains(SETTLED_SHELF_TOGGLE_KEY);

    let no_matches = has_query && thread_rows.is_empty() && settled_count == 0;

    let mut list_scroll = div()
        .id("sidebar-thread-scroll")
        .flex()
        .flex_col()
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .px(px(SIDEBAR_CONTENT_INSET_PX))
        .pb(px(SIDEBAR_CONTENT_INSET_PX))
        .gap(px(1.0))
        .children(thread_rows);

    if no_matches {
        list_scroll = list_scroll.child(
            div()
                .px(px(ROW_HORIZONTAL_INSET_PX))
                .py(px(12.0))
                .text_size(px(geometry.ui_font_size_px))
                .line_height(px(geometry.ui_line_height_px))
                .text_color(muted)
                .child("No matching threads"),
        );
    }

    {
        let settled_header = div()
            .id("sidebar-settled-footer")
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .w_full()
            .h(px(geometry.toolbar_height_px))
            .mt_auto()
            .px(px(8.0))
            .flex_shrink_0()
            .rounded(px(SEARCH_RADIUS_PX))
            .cursor_pointer()
            .text_size(px(META_FONT_SIZE_PX))
            .line_height(px(META_LINE_HEIGHT_PX))
            .text_color(muted)
            .hover(move |s| s.bg(hover_bg))
            .on_click(cx.listener(|app, _event, _window, cx| {
                app.toggle_project_collapsed(SETTLED_SHELF_TOGGLE_KEY, cx);
            }))
            .child(
                div()
                    .flex_shrink_0()
                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                    .child("Settled"),
            )
            .child(div().flex_1())
            .child(
                div()
                    .flex_shrink_0()
                    .font_weight(gpui_kit::FontWeight::NORMAL)
                    .child(settled_count.to_string()),
            )
            .child(icons::caret(settled_expanded, muted));

        list_scroll = list_scroll.child(settled_header);

        if settled_expanded {
            for (idx, thread) in settled_threads.into_iter().enumerate() {
                let project = shell.project(&thread.project_id);
                let selected = layout.selected_thread_id.as_deref() == Some(thread.id.as_str());
                let is_renaming = renaming_thread_id == Some(thread.id.as_str());
                list_scroll = list_scroll.child(render_thread_card(
                    100_000 + idx,
                    thread,
                    project,
                    selected,
                    true,
                    is_renaming,
                    rename_input,
                    ThreadActivity::Idle,
                    now_secs,
                    tokens,
                    cx,
                ));
            }
        }
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
    .child(top_row)
    .child(list_scroll);

    div()
        .flex()
        .flex_col()
        .w(px(layout.sidebar_width))
        .h_full()
        .flex_shrink_0()
        .child(sidebar_header)
        .child(card)
}

fn sidebar_header_icon_btn(
    id: impl Into<gpui_kit::ElementId>,
    icon_name: IconName,
    tokens: &Tokens,
    on_click: impl Fn(&gpui_kit::ClickEvent, &mut gpui_kit::Window, &mut gpui_kit::App) + 'static,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let icon_color = hsla_alpha(tokens.sidebar_muted_foreground, 0.80);
    let hover_bg = hsla(tokens.sidebar_row_hover);

    div()
        .id(id)
        .flex()
        .items_center()
        .justify_center()
        .size(px(HEADER_ICON_BTN_PX))
        .flex_shrink_0()
        .rounded(px(ROW_RADIUS_PX))
        .cursor_pointer()
        .hover(move |s| s.bg(hover_bg))
        .on_click(on_click)
        .child(icons::chrome(icon_name, icon_color))
}

/// Popover menu listing "All projects" plus every registered project for scoping the sidebar.
fn render_project_filter_menu(
    shell: &ShellState,
    active_workspace: Option<&str>,
    tokens: &Tokens,
    geometry: &ShellGeometry,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::AnyElement {
    let fg = hsla(tokens.popover_foreground);
    let muted = hsla(tokens.muted_foreground);
    let hover_bg = hsla(tokens.shell_highlight);

    let mut menu = div()
        .id("sidebar-project-filter-menu")
        .absolute()
        .top_full()
        .right_0()
        .mt(px(4.0))
        .w(px(210.0))
        .max_h(px(280.0))
        .overflow_y_scroll()
        .rounded(px(10.0))
        .bg(hsla(tokens.popover))
        .border_1()
        .border_color(hsla(tokens.shell_inner_border))
        .shadow_md()
        .p(px(4.0))
        .flex()
        .flex_col()
        .gap(px(2.0))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());

    let all_active = active_workspace.is_none();
    menu = menu.child(
        div()
            .id("sidebar-filter-all")
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .h(px(28.0))
            .px(px(8.0))
            .rounded(px(6.0))
            .cursor_pointer()
            .text_size(px(geometry.ui_font_size_px))
            .line_height(px(geometry.ui_line_height_px))
            .text_color(fg)
            .hover(move |s| s.bg(hover_bg))
            .on_click(cx.listener(|app, _, _, cx| {
                cx.stop_propagation();
                app.select_workspace(None, cx);
            }))
            .child(div().flex_1().truncate().child("All projects"))
            .child(if all_active {
                icons::concept("superhero/check.svg", 14.0, fg).into_any_element()
            } else {
                div().size(px(14.0)).into_any_element()
            }),
    );

    for (idx, project) in shell.projects.iter().enumerate() {
        let project_id = project.id.clone();
        let is_active = active_workspace == Some(project.id.as_str());
        menu = menu.child(
            div()
                .id(("sidebar-filter-project", idx))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.0))
                .h(px(28.0))
                .px(px(8.0))
                .rounded(px(6.0))
                .cursor_pointer()
                .text_size(px(geometry.ui_font_size_px))
                .line_height(px(geometry.ui_line_height_px))
                .text_color(if is_active { fg } else { muted })
                .hover(move |s| s.bg(hover_bg).text_color(fg))
                .on_click(cx.listener(move |app, _, _, cx| {
                    cx.stop_propagation();
                    app.select_workspace(Some(project_id.clone()), cx);
                }))
                .child(render_project_favicon(project, 14.0, tokens))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .child(project.title.clone()),
                )
                .child(if is_active {
                    icons::concept("superhero/check.svg", 14.0, fg).into_any_element()
                } else {
                    div().size(px(14.0)).into_any_element()
                }),
        );
    }

    deferred(menu).with_priority(3).into_any_element()
}

#[expect(
    clippy::too_many_arguments,
    reason = "pure view helper taking borrowed thread, project, rename, and theme slices"
)]
fn render_thread_card(
    row_key: usize,
    thread: &ThreadShell,
    project: Option<&ProjectShell>,
    selected: bool,
    is_settled: bool,
    is_renaming: bool,
    rename_input: &Entity<InputState>,
    activity: ThreadActivity,
    now_secs: i64,
    tokens: &Tokens,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::Div {
    let fg = hsla(tokens.foreground);
    let muted = hsla(tokens.sidebar_muted_foreground);
    let hover_bg = hsla(tokens.sidebar_row_hover);
    let selected_bg = hsla(tokens.sidebar_row_selected);
    let active_bg = hsla(tokens.sidebar_row_active);
    let thread_id = thread.id.clone();

    let project_name = project.map(|p| p.title.as_str());
    let provider_hint = thread.provider_instance_id.as_str();
    // Conn: `opacity-60` on the provider mark in the meta line.
    let provider_mark =
        icons::provider_mark(provider_hint, 14.0, hsla_alpha(tokens.foreground, 0.60)).opacity(0.6);

    // Line 1 (`h-5`, `gap-1.5`): 16px project favicon (with corner StatusDotBadge) + 14px medium title.
    let favicon = project.map_or_else(
        || render_project_monogram("No project", ROW_FAVICON_PX, tokens),
        |p| render_project_favicon(p, ROW_FAVICON_PX, tokens),
    );
    let leading_icon = render_status_dot_badge(
        favicon,
        StatusDotState::from_activity(activity),
        selected,
        tokens,
    );

    let rename_thread_id = thread.id.clone();
    let rename_initial_title = thread.title.clone();
    let rename_btn = div()
        .id(("thread-rename-btn", row_key))
        .flex()
        .items_center()
        .justify_center()
        .size(px(20.0))
        .flex_shrink_0()
        .rounded(px(5.0))
        .opacity(0.0)
        .group_hover("sidebar-row", |s| s.opacity(1.0))
        .hover(move |s| s.bg(hover_bg))
        .cursor_pointer()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(cx.listener(move |app, _event, window, cx| {
            cx.stop_propagation();
            app.start_thread_rename(
                rename_thread_id.clone(),
                rename_initial_title.clone(),
                window,
                cx,
            );
        }))
        .child(icons::concept("superhero/edit.svg", 13.0, muted))
        .conn_tooltip("Rename thread", tokens);

    let settle_thread_id = thread.id.clone();
    let settle_icon = if is_settled {
        "superhero/undo.svg"
    } else {
        "superhero/check.svg"
    };
    let settle_tooltip = if is_settled {
        "Un-settle thread"
    } else {
        "Settle thread"
    };
    let settle_btn = div()
        .id(("thread-settle-btn", row_key))
        .flex()
        .items_center()
        .justify_center()
        .size(px(20.0))
        .flex_shrink_0()
        .rounded(px(5.0))
        .opacity(0.0)
        .group_hover("sidebar-row", |s| s.opacity(1.0))
        .hover(move |s| s.bg(hover_bg))
        .cursor_pointer()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(cx.listener(move |app, _event, _window, cx| {
            cx.stop_propagation();
            app.settle_thread(settle_thread_id.clone(), !is_settled, cx);
        }))
        .child(icons::concept(settle_icon, 13.0, muted))
        .conn_tooltip(settle_tooltip, tokens);

    let title_slot = if is_renaming {
        div()
            .flex_1()
            .min_w_0()
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
                    .text_size(px(TITLE_FONT_SIZE_PX)),
            )
            .into_any_element()
    } else {
        div()
            .flex_1()
            .min_w_0()
            .truncate()
            .text_size(px(TITLE_FONT_SIZE_PX))
            .line_height(px(TITLE_LINE_HEIGHT_PX))
            .font_weight(gpui_kit::FontWeight::MEDIUM)
            .text_color(fg)
            .child(thread.title.clone())
            .into_any_element()
    };

    let mut line1 = div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .w_full()
        .h(px(TITLE_LINE_HEIGHT_PX))
        .min_w_0()
        .child(leading_icon)
        .child(title_slot);
    if !is_renaming {
        line1 = line1.child(rename_btn).child(settle_btn);
    }

    // Line 2 (`cardMetaLine` in `SidebarThreadRow.tsx:1357-1392`):
    // `mt-1 flex min-w-0 items-center gap-1.5 ps-5.5 text-secondary-label text-xs`
    // Contents: provider icon · project · branch · relative age
    let timestamp_iso = thread
        .latest_user_message_at
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&thread.updated_at);
    let age = format_compact_relative_age_at(timestamp_iso, now_secs).unwrap_or_default();

    let mut line2 = div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .w_full()
        .mt(px(4.0))
        .pl(px(META_LINE_INDENT_PX))
        .min_w_0()
        .text_size(px(META_FONT_SIZE_PX))
        .line_height(px(META_LINE_HEIGHT_PX))
        .text_color(muted)
        .child(
            div()
                .flex()
                .items_center()
                .flex_shrink_0()
                .child(provider_mark),
        );

    if let Some(name) = project_name {
        line2 = line2.child(div().flex_shrink_0().child("·")).child(
            div()
                .min_w_0()
                .max_w(px(92.0))
                .flex_shrink_0()
                .truncate()
                .child(name.to_owned()),
        );
    }

    if let Some(branch) = thread.branch.as_deref().filter(|b| !b.is_empty()) {
        line2 = line2
            .child(div().flex_shrink_0().child("·"))
            .child(div().min_w_0().truncate().child(branch.to_owned()));
    }

    if !age.is_empty() {
        line2 = line2
            .child(div().flex_shrink_0().child("·"))
            .child(div().flex_shrink_0().child(age));
    }

    let mut card = div()
        .id(("thread-row", row_key))
        .group("sidebar-row")
        .flex()
        .flex_col()
        .w_full()
        .px(px(ROW_HORIZONTAL_INSET_PX))
        .py(px(SIDEBAR_CONTENT_INSET_PX))
        .rounded(px(ROW_RADIUS_PX))
        .border_t_1()
        .cursor_pointer()
        .on_click(cx.listener(move |app, _event, _window, cx| {
            app.select_thread(thread_id.clone(), cx);
        }))
        .child(line1)
        .child(line2);

    // Active row: `bg-sidebar-row-active` + `border-t-(--shell-divider-raised)/50`;
    // Light mode adds `ring-1 ring-inset ring-sidebar-border/70`.
    if selected {
        card = card
            .bg(active_bg)
            .border_color(hsla_alpha(tokens.shell_divider_raised, 0.50))
            .hover(move |s| s.bg(active_bg));
        if tokens.appearance == Appearance::Light {
            card = card
                .border_1()
                .border_color(hsla_alpha(tokens.sidebar_border, 0.70));
        }
    } else {
        card = card
            .border_color(gpui_kit::transparent_black())
            .hover(move |s| s.bg(hover_bg))
            .active(move |s| s.bg(selected_bg));
    }

    // Outer `li` wrapper carries `py-0.5` (`2px`) matching `SidebarThreadRow.tsx:1610`.
    div().w_full().py(px(2.0)).child(card)
}

/// Wraps a 16px leading project icon with Conn's `StatusDotBadge` (`StatusDotBadge.tsx`):
/// a 6px (`size-1.5`) dot at `top: -1px, right: -1px` with a cutout border.
fn render_status_dot_badge(
    icon: gpui_kit::Div,
    state: Option<StatusDotState>,
    selected: bool,
    tokens: &Tokens,
) -> gpui_kit::Div {
    let mut wrapper = div()
        .relative()
        .flex()
        .items_center()
        .justify_center()
        .flex_shrink_0()
        .child(icon);

    if let Some(dot_state) = state {
        let dot_color = match dot_state {
            StatusDotState::Working => hsla(tokens.info),
            StatusDotState::Waiting => hsla_alpha(tokens.muted_foreground, 0.70),
            StatusDotState::Done => hsla(tokens.success),
            StatusDotState::Failed => hsla(tokens.destructive),
        };
        // Ring color blends the cutout cleanly into the row behind the icon.
        let ring_color = if selected {
            hsla(tokens.shell_control)
        } else {
            hsla(tokens.shell_card)
        };
        wrapper = wrapper.child(
            div()
                .absolute()
                .top(px(-2.0))
                .right(px(-2.0))
                .size(px(STATUS_DOT_PX + 2.0))
                .rounded_full()
                .bg(dot_color)
                .border(px(1.5))
                .border_color(ring_color),
        );
    }

    wrapper
}

/// Provider glyph tint matching `ProviderInstanceIcon.tsx` (`opacity-60`):
/// Claude uses the theme's warm warning role; OpenAI/Codex and others use
/// `foreground` at 60% opacity.
fn current_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Formats an ISO-8601 timestamp relative to `now_secs` (Unix epoch seconds)
/// matching Conn's `compactSidebarTimeLabel(formatRelativeTimeLabel(...))`:
/// `< 60s` -> `"now"`, `< 60m` -> `"5m"`, `< 24h` -> `"3h"`, `>= 24h` -> `"2d"` / `"247d"`.
#[must_use]
pub(crate) fn format_compact_relative_age_at(iso: &str, now_secs: i64) -> Option<String> {
    let ts_secs = parse_iso8601_unix_secs(iso)?;
    let elapsed_secs = (now_secs - ts_secs).max(0);
    if elapsed_secs < 60 {
        return Some("now".to_owned());
    }
    let minutes = elapsed_secs / 60;
    if minutes < 60 {
        return Some(format!("{minutes}m"));
    }
    let hours = minutes / 60;
    if hours < 24 {
        return Some(format!("{hours}h"));
    }
    let days = hours / 24;
    Some(format!("{days}d"))
}

/// Parses an RFC 3339 / ISO-8601 timestamp (`YYYY-MM-DDTHH:MM:SS(.frac)?(Z|±HH:MM)`)
/// into Unix epoch seconds.
fn parse_iso8601_unix_secs(iso: &str) -> Option<i64> {
    let s = iso.trim();
    if s.len() < 20 {
        return None;
    }
    let bytes = s.as_bytes();
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || (bytes[10] != b'T' && bytes[10] != b't' && bytes[10] != b' ')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }

    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: u32 = s.get(5..7)?.parse().ok()?;
    let day: u32 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    let second: i64 = s.get(17..19)?.parse().ok()?;

    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || !(0..=23).contains(&hour)
        || !(0..=59).contains(&minute)
        || !(0..=60).contains(&second)
    {
        return None;
    }

    let mut rest = s.get(19..)?;
    if let Some(after_dot) = rest.strip_prefix('.') {
        let digits = after_dot.bytes().take_while(u8::is_ascii_digit).count();
        rest = after_dot.get(digits..)?;
    }

    let tz_offset_secs: i64 = if rest == "Z" || rest == "z" {
        0
    } else if rest.len() == 6
        && (rest.starts_with('+') || rest.starts_with('-'))
        && rest.as_bytes()[3] == b':'
    {
        let sign: i64 = if rest.starts_with('+') { 1 } else { -1 };
        let tz_h: i64 = rest.get(1..3)?.parse().ok()?;
        let tz_m: i64 = rest.get(4..6)?.parse().ok()?;
        if !(0..=23).contains(&tz_h) || !(0..=59).contains(&tz_m) {
            return None;
        }
        sign * (tz_h * 3600 + tz_m * 60)
    } else {
        return None;
    };

    let days = days_from_civil(year, month, day);
    Some(days * 86_400 + hour * 3600 + minute * 60 + second - tz_offset_secs)
}

/// Howard Hinnant's civil-to-days algorithm (days since 1970-01-01).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = i64::from(month);
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Matches a thread against the sidebar search query: every whitespace-separated term must appear
/// case-insensitively in the thread title, project title, or branch name.
#[must_use]
fn thread_matches_search(
    thread: &ThreadShell,
    project: Option<&ProjectShell>,
    query: &str,
) -> bool {
    thread_fields_match_search(
        &thread.title,
        project.map(|p| p.title.as_str()),
        thread.branch.as_deref(),
        query,
    )
}

#[must_use]
fn thread_fields_match_search(
    title: &str,
    project_title: Option<&str>,
    branch: Option<&str>,
    query: &str,
) -> bool {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return true;
    }
    let title = title.to_ascii_lowercase();
    let project_title = project_title
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let branch = branch.map(str::to_ascii_lowercase).unwrap_or_default();
    trimmed.split_whitespace().all(|term| {
        let needle = term.to_ascii_lowercase();
        title.contains(&needle) || project_title.contains(&needle) || branch.contains(&needle)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_search_matches_title_project_and_branch() {
        let title = "Fix macOS vibrancy shell color";
        let project = Some("conn-gpui");
        let branch = Some("feat/vibrancy-fix");

        assert!(
            thread_fields_match_search(title, project, branch, ""),
            "empty query matches all threads"
        );
        assert!(
            thread_fields_match_search(title, project, branch, "vibrancy"),
            "matches thread title case-insensitively"
        );
        assert!(
            thread_fields_match_search(title, project, branch, "gpui VIBRANCY"),
            "multi-term query matches across project title and thread title"
        );
        assert!(
            thread_fields_match_search(title, project, branch, "feat/vibrancy"),
            "matches branch name"
        );
        assert!(
            !thread_fields_match_search(title, project, branch, "vibrancy missing"),
            "rejects when any term does not match"
        );
    }

    #[test]
    fn relative_age_formats_seconds_minutes_hours_days() {
        let now = parse_iso8601_unix_secs("2026-11-21T12:00:00.000Z").expect("valid reference");

        assert_eq!(
            format_compact_relative_age_at("2026-11-21T11:59:30.000Z", now).as_deref(),
            Some("now")
        );
        assert_eq!(
            format_compact_relative_age_at("2026-11-21T12:05:00.000Z", now).as_deref(),
            Some("now")
        );
        assert_eq!(
            format_compact_relative_age_at("2026-11-21T11:55:00.000Z", now).as_deref(),
            Some("5m")
        );
        assert_eq!(
            format_compact_relative_age_at("2026-11-21T09:00:00.000Z", now).as_deref(),
            Some("3h")
        );
        assert_eq!(
            format_compact_relative_age_at("2026-11-19T12:00:00.000Z", now).as_deref(),
            Some("2d")
        );
        assert_eq!(
            format_compact_relative_age_at("2026-03-19T12:00:00.000Z", now).as_deref(),
            Some("247d")
        );
    }

    #[test]
    fn relative_age_handles_timezone_offsets_and_invalid_input() {
        let now = parse_iso8601_unix_secs("2026-11-21T12:00:00Z").expect("valid reference");
        // 13:00+02:00 == 11:00Z -> 1h ago
        assert_eq!(
            format_compact_relative_age_at("2026-11-21T13:00:00+02:00", now).as_deref(),
            Some("1h")
        );
        assert_eq!(format_compact_relative_age_at("not-a-timestamp", now), None);
        assert_eq!(format_compact_relative_age_at("", now), None);
    }
}
