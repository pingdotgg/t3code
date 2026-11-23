//! Thread sidebar column (`Sidebar.tsx`, `SidebarThreadHeader.tsx`, `SidebarThreadRow.tsx` parity).
//!
//! Layout matching real Conn (`apps/web/src/components/sidebar/`):
//! - `44px` transparent header with the sidebar toggle at `x = 90px` from the
//!   window edge (`36px` inside the sidebar column, right of macOS traffic lights).
//! - Inset panel card:
//!   - Fixed top `SidebarGroup` (`p-2` = `8px`): `"Search"` (`h-8`, `text-sm font-medium`)
//!     + trailing `28x28` icon buttons (`ListFilter`, `FolderPlus`, `SquarePen`).
//!   - Scrollable `SidebarGroup` (`px-2 pb-2`, `gap-px`): pinned cards, a subtle divider, then
//!     active cards (`SidebarThreadRow.tsx` `variant="card"`, two lines, `rounded-md`:
//!     line 1 favicon + status dot + title + pin + hover icon-only settle; line 2 provider ·
//!     project · branch · time).
//!   - `Settled` collapsible section pushed to the bottom (`mt-auto`) with `36px` slim rows; a
//!     collapsed shelf still shows the open settled thread (`routeThreadOnly`).
//! - Right-click on any row opens the Thread Actions menu (`thread_menu.rs`); double-click
//!   starts inline rename.
//! - Every row is a tab stop; the arrow keys move between rows (`tree.rs`, `attachSidebarTree`).

use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use conn_desktop::orbit::{OrbitWorkspace, workspace_matches_project};
use conn_state::{LayoutState, ProjectShell, SETTLED_SHELF_ROW, ShellState, ThreadShell, TreeRow};
use conn_theme::{Appearance, ShellGeometry, Tokens};
use gpui_kit::TestSupportExt as _;
use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    Context, Entity, InteractiveElement as _, IntoElement as _, MouseButton, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, WindowControlArea, canvas,
    deferred, div, px,
};

use crate::a11y::ConnA11yExt as _;
use crate::app::ConnApp;
use crate::icons;
use crate::panels::chrome::ConnTooltipExt as _;
use crate::shell::{CardJoin, MACOS_TRAFFIC_LIGHTS_INSET_PX, WORKSPACE_RAIL_WIDTH_PX, inset_card};
use crate::sidebar::drafts::{DraftSidebar, render_draft_block, render_draft_undo_notice};
use crate::sidebar::hover_card::render_thread_hover_card;
use crate::sidebar::hover_card_state::RowRectCell;
use crate::sidebar::tree::{RowFocus, SidebarTree, focus_ring};
use crate::sidebar::{render_project_favicon, render_project_monogram};
use crate::theme::{hsla, hsla_alpha};

/// `--sidebar-content-inset: 0.5rem` (`8px`).
const SIDEBAR_CONTENT_INSET_PX: f32 = 8.0;
/// `--sidebar-row-content-inset: 0.625rem` (`10px`).
const ROW_HORIZONTAL_INSET_PX: f32 = 10.0;
/// `rounded-lg` (`8px`) on sidebar icon controls and the thread card (`rowSurfaceClassName`).
const ROW_RADIUS_PX: f32 = 8.0;
/// `rounded-md` (`6px`) on slim rows and the card settle button.
const CARD_RADIUS_PX: f32 = 6.0;
/// `h-9` (`36px`) slim settled rows.
const SLIM_ROW_HEIGHT_PX: f32 = 36.0;
/// `rounded-md` (`6px`) on the search field and collapsible section header.
const SEARCH_RADIUS_PX: f32 = 6.0;
/// `size-7` (`28px`) for `SidebarHeaderIconButton` and `SidebarTrigger`.
const HEADER_ICON_BTN_PX: f32 = 28.0;
/// `size-4` (`16px`) for `ProjectFavicon` / `ProjectMonogram` in thread rows.
const ROW_FAVICON_PX: f32 = 16.0;
/// Gap between the favicon and the title. Conn web uses `gap-1.5` (`6px`); we add `2px` (#278).
const CARD_ICON_TITLE_GAP_PX: f32 = 8.0;
/// Line 2 indent (Conn `ps-5.5`): favicon + icon/title gap, so line 2 aligns under the title.
const META_LINE_INDENT_PX: f32 = ROW_FAVICON_PX + CARD_ICON_TITLE_GAP_PX;
/// Gap between line 1 and line 2. Conn web uses `mt-1` (`4px`); we add `2px` (#278).
const CARD_LINE_GAP_PX: f32 = 6.0;
/// `text-sm` (`14px` / `20px`) for search field and thread row titles.
const TITLE_FONT_SIZE_PX: f32 = 14.0;
const TITLE_LINE_HEIGHT_PX: f32 = 20.0;
/// `text-xs` (`12px` / `16px`) for line-2 metadata and Settled section header.
const META_FONT_SIZE_PX: f32 = 12.0;
const META_LINE_HEIGHT_PX: f32 = 16.0;
/// Left offset inside the sidebar header so the toggle sits at `x = 90px`
/// (`--desktop-window-controls-inset`) directly right of the traffic lights.
const SIDEBAR_TOGGLE_LEFT_OFFSET_PX: f32 = MACOS_TRAFFIC_LIGHTS_INSET_PX - WORKSPACE_RAIL_WIDTH_PX;
/// Sentinel key stored in `collapsed_projects` to toggle the Settled shelf
/// without requiring a new field on `ConnApp`.
pub(crate) const SETTLED_SHELF_TOGGLE_KEY: &str = "__settled__";

/// Renders the thread sidebar column (`layout.sidebar_width` wide).
#[expect(
    clippy::too_many_arguments,
    reason = "renders the sidebar from borrowed shell, layout, search, and theme state"
)]
#[must_use]
pub(crate) fn render_thread_sidebar(
    shell: &ShellState,
    layout: &LayoutState,
    workspaces: &[OrbitWorkspace],
    active_workspace: Option<&str>,
    drafts: &DraftSidebar<'_>,
    collapsed_projects: &HashSet<String>,
    search_input: &Entity<InputState>,
    renaming_thread_id: Option<&str>,
    rename_input: &Entity<InputState>,
    filter_menu_open: bool,
    hover: &ThreadHoverView<'_>,
    tree: &mut SidebarTree,
    tokens: &Tokens,
    geometry: &ShellGeometry,
    window: &mut Window,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    tree.begin();
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
        .on_mouse_down(MouseButton::Left, |event, window, _| {
            if event.click_count == 2 {
                window.zoom_window();
            } else {
                window.start_window_move();
            }
        })
        .child(
            div()
                .id("sidebar-collapse-btn")
                .a11y_button("sidebar.collapse", "Hide sidebar")
                .aria_keyshortcuts("Meta+B")
                .flex()
                .items_center()
                .justify_center()
                .size(px(HEADER_ICON_BTN_PX))
                .rounded(px(ROW_RADIUS_PX))
                .cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(|app, _event, _window, cx| {
                    app.toggle_sidebar(cx);
                }))
                .conn_tooltip("Hide sidebar (⌘B)", tokens)
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
            .a11y_button("sidebar.filter-projects", "Filter by project")
            .aria_expanded(filter_menu_open)
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
            .a11y_button("sidebar.add-project", "Add project")
            .conn_tooltip("Add project", tokens),
        );
    }
    header_actions = header_actions.child(
        sidebar_header_icon_btn(
            "sidebar-new-thread",
            IconName::SquarePen,
            tokens,
            cx.listener(|app, _event, window, cx| app.start_new_thread(None, Some(window), cx)),
        )
        .a11y_button("sidebar.new-thread", "New thread")
        .aria_keyshortcuts("Meta+N")
        .conn_tooltip("New thread (⌘N)", tokens),
    );

    let mut search_box = div()
        .id("sidebar-search")
        .a11y(gpui_kit::Role::Search, "sidebar.search", "Search threads")
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

    // Flat list of threads, scoped to `active_workspace` (either an Orbit workspace or a
    // direct project filter) and live sidebar search when set.
    let thread_in_scope = |thread: &ThreadShell| {
        project_in_scope(shell, workspaces, active_workspace, &thread.project_id)
    };

    let now_secs = current_unix_secs();
    let selected_id = layout.selected_thread_id.as_deref();
    let row_flags = |thread: &ThreadShell| {
        (
            selected_id == Some(thread.id.as_str()),
            renaming_thread_id == Some(thread.id.as_str()),
        )
    };
    let visible_threads: Vec<&ThreadShell> = shell
        .top_level_active_threads()
        .filter(|thread| thread_in_scope(thread))
        .filter(|thread| {
            thread_matches_search(thread, shell.project(&thread.project_id), &search_query)
        })
        .collect();
    // Pinned (`pinOrderKey` order) above a subtle divider, then Active.
    let (mut pinned, active): (Vec<&ThreadShell>, Vec<&ThreadShell>) = visible_threads
        .into_iter()
        .partition(|t| t.pinned_at.as_ref().is_some_and(Option::is_some));
    pinned.sort_by(|a, b| pin_order_key(a).cmp(&pin_order_key(b)));

    let mut thread_rows: Vec<gpui_kit::AnyElement> =
        Vec::with_capacity(pinned.len() + active.len() + drafts.rows.len() + 2);
    // Search lists threads only; drafts return when it clears (`SidebarDraftBlock`).
    if !has_query {
        thread_rows.extend(render_draft_block(&drafts.rows, tree, tokens, cx));
    }
    for (idx, thread) in pinned.iter().enumerate() {
        let row_key = idx;
        let (selected, is_renaming) = row_flags(thread);
        let row = RowCtx {
            row_key,
            thread,
            project: shell.project(&thread.project_id),
            selected,
            is_renaming,
            unsent_draft: drafts.unsent_threads.contains(&thread.id),
            rename_input,
            now_secs,
            sidebar_width: layout.sidebar_width,
            hover_open: hover.open_for == Some(thread.id.as_str()),
            hover_rect: hover.rect,
            environment_label: hover.environment_label,
            focus: tree.row(TreeRow::leaf(thread.id.clone()), cx),
            tokens,
        };
        thread_rows.push(render_thread_card(&row, cx).into_any_element());
    }
    if !pinned.is_empty() {
        // `pinned-divider`: a hairline between the Pinned and Active groups.
        thread_rows.push(
            div()
                .w_full()
                .px(px(ROW_HORIZONTAL_INSET_PX))
                .py(px(4.0))
                .child(div().h(px(1.0)).bg(hsla_alpha(tokens.sidebar_border, 0.60)))
                .into_any_element(),
        );
    }
    for (idx, thread) in active.iter().enumerate() {
        let row_key = 10_000 + idx;
        let (selected, is_renaming) = row_flags(thread);
        let row = RowCtx {
            row_key,
            thread,
            project: shell.project(&thread.project_id),
            selected,
            is_renaming,
            unsent_draft: drafts.unsent_threads.contains(&thread.id),
            rename_input,
            now_secs,
            sidebar_width: layout.sidebar_width,
            hover_open: hover.open_for == Some(thread.id.as_str()),
            hover_rect: hover.rect,
            environment_label: hover.environment_label,
            focus: tree.row(TreeRow::leaf(thread.id.clone()), cx),
            tokens,
        };
        thread_rows.push(render_thread_card(&row, cx).into_any_element());
    }

    // Settled shelf (`SidebarSectionHeader` in `Sidebar.tsx`): always shown, with its count
    // (Conn shows "Settled 0"), pushed to the bottom of the list with `mt-auto`.
    let settled_threads: Vec<&ThreadShell> = shell
        .top_level_settled_threads()
        .into_iter()
        .filter(|thread| thread_in_scope(thread))
        .filter(|thread| {
            thread_matches_search(thread, shell.project(&thread.project_id), &search_query)
        })
        .collect();
    let settled_count = settled_threads.len();
    let settled_expanded = collapsed_projects.contains(SETTLED_SHELF_TOGGLE_KEY);

    let no_matches = has_query && thread_rows.is_empty() && settled_count == 0;

    let mut list_scroll = div()
        .id("sidebar-thread-scroll")
        .a11y(gpui_kit::Role::List, "sidebar.thread-list", "Threads")
        .track_scroll(tree.scroll())
        .flex()
        .flex_col()
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        // `TooltipScrollDismissArea`: scrolling the list closes the hover card.
        .on_scroll(cx.listener(|app, _, _, cx| app.dismiss_thread_hover(cx)))
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
        let header_focus = tree.row(TreeRow::group(SETTLED_SHELF_ROW, settled_expanded), cx);
        let header_ring = focus_ring(tokens);
        let settled_header = div()
            .id("sidebar-settled-footer")
            .a11y_button(
                "sidebar.settled-toggle",
                format!("Settled ({settled_count})"),
            )
            .aria_expanded(settled_expanded)
            .relative()
            .track_focus(&header_focus.handle)
            .focus_visible(move |s| s.shadow(vec![header_ring]))
            .on_key_down(
                cx.listener(|app, event: &gpui_kit::KeyDownEvent, window, cx| {
                    app.sidebar_row_key(SETTLED_SHELF_ROW, event, window, cx);
                }),
            )
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
            .child(icons::caret(settled_expanded, muted))
            .child(measure_row(&header_focus));

        list_scroll = list_scroll.child(settled_header);

        // A collapsed shelf still shows the open settled thread (`routeThreadOnly`).
        let shown: Vec<&ThreadShell> = if settled_expanded {
            settled_threads
        } else {
            settled_threads
                .into_iter()
                .filter(|t| selected_id == Some(t.id.as_str()))
                .collect()
        };
        for (idx, thread) in shown.into_iter().enumerate() {
            let row_key = 100_000 + idx;
            let (selected, is_renaming) = row_flags(thread);
            let row = RowCtx {
                row_key,
                thread,
                project: shell.project(&thread.project_id),
                selected,
                is_renaming,
                unsent_draft: drafts.unsent_threads.contains(&thread.id),
                rename_input,
                now_secs,
                sidebar_width: layout.sidebar_width,
                hover_open: hover.open_for == Some(thread.id.as_str()),
                hover_rect: hover.rect,
                environment_label: hover.environment_label,
                focus: tree.row(TreeRow::child(thread.id.clone(), SETTLED_SHELF_ROW), cx),
                tokens,
            };
            list_scroll = list_scroll.child(render_settled_row(&row, cx));
        }
    }

    // The row that had the keyboard may be gone (a settled thread under a collapsed shelf, a
    // discarded draft); the keyboard goes to the row that took its place.
    if let Some(target) = tree.finish(window) {
        window.defer(cx, move |window, cx| window.focus(&target, cx));
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
    .child(list_scroll)
    .children(
        drafts
            .undo
            .map(|notice| render_draft_undo_notice(notice, drafts.undo_focus, tokens, cx)),
    );

    div()
        .id("sidebar-column")
        .a11y(
            gpui_kit::Role::Navigation,
            "sidebar.container",
            "Thread sidebar",
        )
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

/// Status pill in the card's top-right slot (`topStatus` in `SidebarThreadRow.tsx`).
/// `Request`, `Limited`, and `Woke` are out of scope (`docs/scope.md` #3, #9, #27).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RowStatus {
    Working,
    Goal,
    Waiting,
    Approval,
    Input,
    Failed,
    Done,
}

impl RowStatus {
    #[cfg(test)]
    #[must_use]
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Working => "Working",
            Self::Goal => "Goal",
            Self::Waiting => "Waiting",
            Self::Approval => "Approval",
            Self::Input => "Input",
            Self::Failed => "Failed",
            Self::Done => "Done",
        }
    }

    /// `TopStatusIcon`: `CircleDashed`, `CircleDotDashed`, `ShieldQuestion`,
    /// `MessageCircleQuestion`, `CircleAlert`, `CircleCheck` through the Conn manifest.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn icon(self) -> &'static str {
        match self {
            Self::Working | Self::Goal => "superhero/circle-dashed.svg",
            Self::Waiting => "superhero/circle-dashed-dot.svg",
            Self::Approval => "superhero/needs-approval.svg",
            Self::Input => "superhero/question.svg",
            Self::Failed => "superhero/error-circle.svg",
            Self::Done => "superhero/check-circle.svg",
        }
    }

    /// Conn's `STATUS_DOT_CLASS` (`StatusDotBadge.tsx`) gives `approval` and `input` the same grey
    /// as `waiting`, so a thread that needs the user looks idle. Here they get the warning token.
    #[must_use]
    pub(crate) fn dot_color(self, tokens: &Tokens) -> gpui_kit::Hsla {
        match self {
            Self::Working | Self::Goal => hsla(tokens.info),
            Self::Waiting => hsla_alpha(tokens.muted_foreground, 0.70),
            Self::Approval | Self::Input => hsla(tokens.warning),
            Self::Done => hsla(tokens.success),
            Self::Failed => hsla(tokens.destructive),
        }
    }
}

/// Port of `resolveSidebarThreadStatus` plus the unseen-completion `Done` pill
/// (`hasUnseenCompletion`: the latest run completed after the last visit).
#[must_use]
pub(crate) fn resolve_row_status(thread: &ThreadShell) -> Option<RowStatus> {
    use conn_contract::OrchestrationV2PendingRuntimeRequestSummaryKind as Kind;
    use conn_contract::OrchestrationV2ShellThreadStatus as Status;
    if let Some(request) = &thread.pending_runtime_request {
        match request.kind {
            Kind::UserInput => return Some(RowStatus::Input),
            Kind::AuthRefresh => {}
            _ => return Some(RowStatus::Approval),
        }
    }
    let running_like = matches!(
        thread.status,
        Status::Preparing | Status::Queued | Status::Starting | Status::Running | Status::Waiting
    ) || matches!(thread.activity_run_status, Some(Some(_)));
    if running_like {
        if thread.status == Status::Running && thread.blocked_on_thread_wait == Some(true) {
            return Some(RowStatus::Waiting);
        }
        let goal_active = thread
            .goal
            .as_ref()
            .and_then(Option::as_ref)
            .is_some_and(|g| g.status == conn_contract::OrchestrationV2ProviderGoalStatus::Active);
        return Some(if goal_active {
            RowStatus::Goal
        } else {
            RowStatus::Working
        });
    }
    if thread.status == Status::Failed {
        return Some(RowStatus::Failed);
    }
    has_unseen_completion(thread).then_some(RowStatus::Done)
}

/// `hasUnseenCompletion`: completion after the last visit (never for unvisited threads).
#[must_use]
pub(crate) fn has_unseen_completion(thread: &ThreadShell) -> bool {
    let Some(completed) = thread
        .latest_run_completed_at
        .as_ref()
        .and_then(Option::as_deref)
        .and_then(parse_iso8601_unix_secs)
    else {
        return false;
    };
    let Some(visited) = thread.last_visited_at.as_ref().and_then(Option::as_deref) else {
        return false;
    };
    parse_iso8601_unix_secs(visited).is_none_or(|v| completed > v)
}

/// Start time of the live elapsed label (`WorkingDuration`).
fn status_started_at(thread: &ThreadShell, status: RowStatus) -> Option<&str> {
    match status {
        RowStatus::Working | RowStatus::Goal => thread
            .activity_run_started_at
            .as_ref()
            .and_then(Option::as_deref)
            .or_else(|| {
                thread
                    .latest_run_started_at
                    .as_ref()
                    .and_then(Option::as_deref)
            }),
        RowStatus::Waiting => thread
            .latest_run_completed_at
            .as_ref()
            .and_then(Option::as_deref),
        _ => None,
    }
}

/// `formatWorkingDurationLabel`: `Ns`, `Nm`, then `Nh Nm`.
#[must_use]
pub(crate) fn format_working_duration(elapsed_secs: i64) -> String {
    let seconds = elapsed_secs.max(0);
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    format!("{}h {}m", minutes / 60, minutes % 60)
}

/// `shouldRecedeSidebarThread`: quiet idle and working rows that need no attention.
fn should_recede(status: Option<RowStatus>, is_active: bool) -> bool {
    if is_active {
        return false;
    }
    match status {
        None | Some(RowStatus::Working | RowStatus::Goal | RowStatus::Waiting) => true,
        Some(RowStatus::Approval) => true,
        Some(RowStatus::Input | RowStatus::Failed | RowStatus::Done) => false,
    }
}

/// `MiddleTruncate`: keeps the branch prefix and its unique tail (`feat/…-fix`).
#[must_use]
pub(crate) fn middle_truncate(value: &str, max_chars: usize) -> String {
    let count = value.chars().count();
    if count <= max_chars || max_chars < 5 {
        return value.to_owned();
    }
    let keep = max_chars - 1;
    let head = keep.div_ceil(2);
    let tail = keep - head;
    let head_str: String = value.chars().take(head).collect();
    let tail_str: String = value.chars().skip(count - tail).collect();
    format!("{head_str}…{tail_str}")
}

/// Branch character budget for the meta line after subtracting row insets, indent,
/// provider icon, project label, time label, dots, and flex gaps (`13px` text, ~7px/glyph).
fn branch_char_budget(
    sidebar_width: f32,
    project_width_px: f32,
    time_chars: usize,
    indented: bool,
) -> usize {
    let indent_px = if indented { META_LINE_INDENT_PX } else { 0.0 };
    let project_slot_px = if project_width_px > 0.0 {
        project_width_px + 18.0
    } else {
        0.0
    };
    let time_slot_px = if time_chars > 0 {
        (time_chars as f32) * 7.2 + 18.0
    } else {
        0.0
    };
    // Card horizontal insets (20px) + provider icon (12px) + branch dot/gap (18px).
    let fixed_px = 20.0 + indent_px + 12.0 + project_slot_px + 18.0 + time_slot_px;
    let usable = (sidebar_width - fixed_px).max(36.0);
    // Truncation toward zero is intended: a partial glyph does not fit.
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "width is clamped positive and small"
    )]
    let chars = (usable / 7.0) as usize;
    chars.max(5)
}

/// Shared row context for [`render_thread_card`] and [`render_settled_row`].
struct RowCtx<'a> {
    row_key: usize,
    thread: &'a ThreadShell,
    project: Option<&'a ProjectShell>,
    selected: bool,
    is_renaming: bool,
    /// The thread's composer holds unsent input (`useThreadHasUnsentDraft`).
    unsent_draft: bool,
    rename_input: &'a Entity<InputState>,
    now_secs: i64,
    sidebar_width: f32,
    hover_rect: &'a RowRectCell,
    /// This thread's hover flyout is open.
    hover_open: bool,
    environment_label: Option<&'a str>,
    /// What the row needs to take the keyboard.
    focus: RowFocus,
    tokens: &'a Tokens,
}

/// Sidebar hover flyout inputs from the app.
pub(crate) struct ThreadHoverView<'a> {
    /// Thread whose `ThreadHoverCard` is visible.
    /// Painted bounds of the open row.
    pub(crate) rect: &'a RowRectCell,
    pub(crate) open_for: Option<&'a str>,
    pub(crate) environment_label: Option<&'a str>,
}

/// Inline rename field (`ThreadRenameInput`): Enter and blur commit, Escape cancels.
fn render_rename_field(
    rename_input: &Entity<InputState>,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::AnyElement {
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
}

/// Right-click opens the Thread Actions menu; double-click starts inline rename; hovering opens
/// the delayed `ThreadHoverCard` flyout and a press closes it.
fn attach_row_interactions(
    row: gpui_kit::Stateful<gpui_kit::Div>,
    ctx: &RowCtx<'_>,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let thread = ctx.thread;
    let is_renaming = ctx.is_renaming;
    let select_id = thread.id.clone();
    let rename_id = thread.id.clone();
    let rename_title = thread.title.clone();
    let menu_id = thread.id.clone();
    let hover_id = thread.id.clone();
    let row = row
        .on_hover(cx.listener(move |app, hovered: &bool, _, cx| {
            app.thread_hover_changed(&hover_id, *hovered, cx);
        }))
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|app, _, _, cx| app.dismiss_thread_hover(cx)),
        )
        .when(ctx.hover_open, |row| {
            row.child(render_thread_hover_card(
                thread,
                ctx.project,
                ctx.environment_label,
                ctx.hover_rect,
                cx.entity().downgrade(),
                ctx.tokens,
            ))
        });
    row.on_click(
        cx.listener(move |app, event: &gpui_kit::ClickEvent, window, cx| {
            let modifiers = event.modifiers();
            if event.click_count() >= 2
                && !is_renaming
                && !(modifiers.platform || modifiers.control || modifiers.shift || modifiers.alt)
            {
                app.start_thread_rename(rename_id.clone(), rename_title.clone(), window, cx);
                return;
            }
            app.select_thread(select_id.clone(), cx);
        }),
    )
    .on_mouse_down(
        MouseButton::Right,
        cx.listener(move |app, event: &gpui_kit::MouseDownEvent, _, cx| {
            cx.stop_propagation();
            app.open_thread_menu(menu_id.clone(), event.position, cx);
        }),
    )
}

/// Records where a row is painted, for a menu opened below it and for scrolling it into view.
fn measure_row(focus: &RowFocus) -> gpui_kit::AnyElement {
    let bounds = std::rc::Rc::clone(&focus.bounds);
    canvas(
        move |painted, _, _| bounds.set(Some(painted)),
        |_, _, _, _| {},
    )
    .absolute()
    .size_full()
    .into_any_element()
}

/// The row takes the keyboard (`tabIndex={0}`, an inset ring while focused by keys), and its
/// keys move between rows, open it, rename it or open its menu (`attachSidebarTree`).
fn attach_row_keyboard(
    row_el: gpui_kit::Stateful<gpui_kit::Div>,
    ctx: &RowCtx<'_>,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let key = ctx.thread.id.clone();
    let ring = focus_ring(ctx.tokens);
    row_el
        .relative()
        .track_focus(&ctx.focus.handle)
        .focus_visible(move |s| s.shadow(vec![ring]))
        .on_key_down(
            cx.listener(move |app, event: &gpui_kit::KeyDownEvent, window, cx| {
                app.sidebar_row_key(&key, event, window, cx);
            }),
        )
        .child(measure_row(&ctx.focus))
}

/// `pinIndicator`: a `12px` pin that turns into the `PinOff` "Unpin thread" button on hover.
fn render_pin_indicator(
    row: &RowCtx<'_>,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let tokens = row.tokens;
    let rest = hsla_alpha(tokens.muted_foreground, 0.65);
    let hover = hsla(tokens.foreground);
    let thread_id = row.thread.id.clone();
    let group = SharedString::from(format!("sidebar-unpin-{}", row.row_key));
    div()
        .id(("thread-unpin-btn", row.row_key))
        .group(group.clone())
        .relative()
        .flex_shrink_0()
        .size(px(12.0))
        .rounded(px(2.0))
        .cursor_pointer()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(cx.listener(move |app, _, _, cx| {
            cx.stop_propagation();
            app.pin_thread(thread_id.clone(), false, cx);
        }))
        .conn_tooltip("Unpin thread", tokens)
        .child(
            div()
                .absolute()
                .inset_0()
                .group_hover(group.clone(), |s| s.invisible())
                .child(icons::concept("superhero/pin.svg", 12.0, rest)),
        )
        .child(
            div()
                .absolute()
                .inset_0()
                .invisible()
                .group_hover(group, |s| s.visible())
                .child(icons::concept("superhero/unpin.svg", 12.0, hover)),
        )
}

/// Active-thread card (`SidebarThreadRow.tsx` `variant="card"`, current Conn `origin/main`):
/// - Line 1 (`h-5 gap-1.5`): `StatusDotBadge` on `ProjectFavicon` (`16px`, 6px corner dot),
///   `text-sm` title (`font-normal text-foreground/75` when receded, `opacity-55` while
///   regenerating), optional `Pin` indicator, and hover-only icon-only `CircleCheck` settle button.
/// - Line 2 (`mt-1 ps-5.5 gap-1.5 text-ui text-secondary-label`): `12px` provider mark ·
///   project name · middle-truncated branch · live duration / relative time (`tabular-nums`).
fn render_thread_card(row: &RowCtx<'_>, cx: &mut Context<'_, ConnApp>) -> gpui_kit::Div {
    let tokens = row.tokens;
    let thread = row.thread;
    let fg = hsla(tokens.foreground);
    let secondary = hsla(tokens.sidebar_muted_foreground);
    let muted = hsla(tokens.muted_foreground);
    let hover_bg = hsla(tokens.sidebar_row_hover);
    let active_bg = hsla(tokens.sidebar_row_active);
    let status = resolve_row_status(thread);
    let recede = should_recede(status, row.selected);
    let is_pinned = thread.pinned_at.as_ref().is_some_and(Option::is_some);
    let regenerating = thread
        .title_regeneration
        .as_ref()
        .is_some_and(Option::is_some);
    let group = SharedString::from(format!("sidebar-row-{}", row.row_key));
    let tokens_warning = tokens.warning;

    // Line 1 (`flex h-5 min-w-0 items-center gap-1.5`):
    // StatusDotBadge(ProjectFavicon) + title + pinIndicator + hover-only settle icon button.
    let mut line1 = div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(CARD_ICON_TITLE_GAP_PX))
        .w_full()
        .h(px(TITLE_LINE_HEIGHT_PX))
        .min_w_0();

    if let Some(project) = row.project {
        let (dot_ring, dot_hover_ring) =
            crate::panels::chrome::sidebar_status_dot_rings(tokens, row.selected);
        let favicon_badge = div()
            .id(("thread-favicon-badge", row.row_key))
            .relative()
            .flex()
            .items_center()
            .flex_shrink_0()
            .child(render_project_favicon(project, ROW_FAVICON_PX, tokens));
        #[cfg(test)]
        let mut favicon_badge = favicon_badge.test_support().a11y_group(
            SharedString::from(format!("test.sidebar.thread.{}.favicon", thread.id)),
            SharedString::from(format!("Thread favicon: {}", thread.id)),
        );
        #[cfg(not(test))]
        let mut favicon_badge = favicon_badge;
        if let Some(status) = status {
            let cutout = crate::panels::chrome::status_dot_cutout(
                status.dot_color(tokens),
                dot_ring,
                dot_hover_ring.map(|hover| (group.clone(), hover)),
                false,
            );
            #[cfg(test)]
            let cutout = cutout
                .id(("thread-status-cutout", row.row_key))
                .test_support()
                .a11y_group(
                    SharedString::from(format!("test.sidebar.thread.{}.status-cutout", thread.id)),
                    SharedString::from(format!("Status cutout: {}", thread.id)),
                );
            favicon_badge = favicon_badge.child(cutout);
        }
        line1 = line1.child(favicon_badge);
    }

    let title_el = if row.is_renaming {
        render_rename_field(row.rename_input, cx)
    } else {
        let mut title = div()
            .flex_1()
            .min_w_0()
            .truncate()
            .text_size(px(TITLE_FONT_SIZE_PX))
            .line_height(px(TITLE_LINE_HEIGHT_PX));
        title = if recede {
            title
                .font_weight(gpui_kit::FontWeight::NORMAL)
                .text_color(hsla_alpha(tokens.foreground, 0.75))
                .group_hover(group.clone(), move |s| s.text_color(fg))
        } else if status == Some(RowStatus::Failed) {
            title
                .font_weight(gpui_kit::FontWeight::MEDIUM)
                .text_color(hsla_alpha(tokens.foreground, 0.95))
        } else {
            title
                .font_weight(gpui_kit::FontWeight::MEDIUM)
                .text_color(fg)
        };
        if regenerating {
            title = title.opacity(0.55);
        }
        title.child(thread.title.clone()).into_any_element()
    };
    line1 = line1.child(title_el);

    if row.unsent_draft {
        line1 = line1.child(render_unsent_indicator(row));
    }

    if is_pinned {
        line1 = line1.child(render_pin_indicator(row, cx));
    }

    // Hover-only icon-only settle control (`CircleCheckIcon`, `size-3.5`).
    if row.unsent_draft {
        line1 = line1.child(render_discard_thread_draft_button(row, &group, cx));
    }
    let settle_id = thread.id.clone();
    let settle_btn = div()
        .id(("thread-settle-btn", row.row_key))
        .a11y_button(
            SharedString::from(format!("sidebar.thread.{}.settle", thread.id)),
            "Settle thread",
        )
        .flex()
        .items_center()
        .justify_center()
        .h(px(TITLE_LINE_HEIGHT_PX))
        .pl(px(2.0))
        .pr(px(4.0))
        .mr(px(-4.0))
        .rounded(px(CARD_RADIUS_PX))
        .flex_shrink_0()
        .invisible()
        .group_hover(group.clone(), |s| s.visible())
        .cursor_pointer()
        .text_color(muted)
        .hover(move |s| s.text_color(fg))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(cx.listener(move |app, _, _, cx| {
            cx.stop_propagation();
            app.settle_thread(settle_id.clone(), true, cx);
        }))
        .conn_tooltip("Settle thread", tokens)
        .child(icons::concept("superhero/check-circle.svg", 14.0, muted));
    line1 = line1.child(settle_btn);

    // Line 2 (`cardMetaLine`: `mt-1 flex min-w-0 items-center gap-1.5 text-secondary-label text-ui`,
    // `ps-5.5` when project is present): agent · project · branch · time.
    let provider_mark = div()
        .flex()
        .items_center()
        .flex_shrink_0()
        .opacity(0.6)
        .child(icons::provider_mark(
            &thread.provider_instance_id,
            12.0,
            hsla_alpha(tokens.foreground, 0.60),
        ));
    let time_label = if let Some(s) = status
        && let Some(started) = status_started_at(thread, s).and_then(parse_iso8601_unix_secs)
    {
        format_working_duration(row.now_secs - started)
    } else {
        format_compact_relative_age_at(thread_time_timestamp(thread), row.now_secs)
            .unwrap_or_default()
    };
    let branch = thread.branch.as_deref().filter(|b| !b.is_empty());

    let mut line2 = div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .w_full()
        .mt(px(CARD_LINE_GAP_PX))
        .min_w_0()
        .text_size(px(13.0))
        .line_height(px(META_LINE_HEIGHT_PX))
        .text_color(secondary)
        .when(row.project.is_some(), |el| el.pl(px(META_LINE_INDENT_PX)))
        .child(provider_mark);

    let mut project_width_px = 0.0_f32;
    if let Some(project) = row.project
        && !project.title.is_empty()
    {
        let project_max_w = (row.sidebar_width * 0.36).clamp(64.0, 128.0);
        project_width_px = ((project.title.chars().count() as f32) * 7.0).min(project_max_w);
        line2 = line2.child("·").child(
            div()
                .max_w(px(project_max_w))
                .flex_shrink_0()
                .truncate()
                .child(project.title.clone()),
        );
    }

    if let Some(branch) = branch {
        let budget = branch_char_budget(
            row.sidebar_width,
            project_width_px,
            time_label.chars().count(),
            row.project.is_some(),
        );
        line2 = line2.child("·").child(
            div()
                .min_w_0()
                .truncate()
                .child(middle_truncate(branch, budget)),
        );
    }

    if !time_label.is_empty() {
        line2 = line2
            .child("·")
            .child(div().flex_shrink_0().child(time_label));
    }

    let mut card = div()
        .id(("thread-row", row.row_key))
        .a11y(
            gpui_kit::Role::ListItem,
            SharedString::from(format!("sidebar.thread.{}", thread.id)),
            thread.title.clone(),
        )
        .aria_selected(row.selected)
        .group(group)
        .flex()
        .flex_col()
        .w_full()
        .px(px(ROW_HORIZONTAL_INSET_PX))
        .py(px(SIDEBAR_CONTENT_INSET_PX))
        .rounded(px(ROW_RADIUS_PX))
        .border_t_1()
        .cursor_pointer()
        .child(line1)
        .child(line2);

    card = attach_row_keyboard(attach_row_interactions(card, row, cx), row, cx);

    // Active row: `bg-sidebar-row-active` + `border-t-(--shell-divider-raised)/50`;
    // light mode adds `ring-1 ring-inset ring-sidebar-border/70` inside that top border.
    if row.selected {
        card = card
            .bg(active_bg)
            .border_color(hsla_alpha(tokens.shell_divider_raised, 0.50))
            .hover(move |s| s.bg(active_bg));
        if tokens.appearance == Appearance::Light {
            card = card.relative().child(
                div()
                    .absolute()
                    .inset_0()
                    .rounded(px(ROW_RADIUS_PX))
                    .border_1()
                    .border_color(hsla_alpha(tokens.sidebar_border, 0.70)),
            );
        }
    } else if recede && matches!(status, Some(RowStatus::Working | RowStatus::Goal)) {
        card = card
            .border_color(gpui_kit::transparent_black())
            .opacity(0.7)
            .hover(move |s| s.bg(hover_bg).opacity(1.0));
        if row.unsent_draft {
            card = card
                .bg(unsent_surface(tokens))
                .hover(move |s| s.bg(unsent_surface_hover(tokens_warning)).opacity(1.0));
        }
    } else if row.unsent_draft {
        // `draftSurfaceClassName`: `bg-warning/4 hover:bg-warning/8`.
        card = card
            .border_color(gpui_kit::transparent_black())
            .bg(unsent_surface(tokens))
            .hover(move |s| s.bg(unsent_surface_hover(tokens_warning)));
    } else {
        card = card
            .border_color(gpui_kit::transparent_black())
            .hover(move |s| s.bg(hover_bg));
    }

    // Outer `li`: `py-0.5` (`2px`).
    div().w_full().py(px(2.0)).child(card.test_support())
}

/// Settled row (`SidebarThreadRow.tsx` slim variant, `h-9 gap-2.5 px-2.5`): grayscale `opacity-40`
/// favicon that regains color on hover, single-line muted title, and the `settled_at` time that
/// swaps to the `Undo2` "Un-settle thread" button on hover.
fn render_settled_row(row: &RowCtx<'_>, cx: &mut Context<'_, ConnApp>) -> gpui_kit::Div {
    let tokens = row.tokens;
    let thread = row.thread;
    let fg = hsla(tokens.foreground);
    let secondary = hsla(tokens.sidebar_muted_foreground);
    let muted = hsla(tokens.muted_foreground);
    let hover_bg = hsla(tokens.sidebar_row_hover);
    let active_bg = hsla(tokens.sidebar_row_active);
    let group = SharedString::from(format!("sidebar-row-{}", row.row_key));

    let favicon = row.project.map_or_else(
        || render_project_monogram("No project", ROW_FAVICON_PX, tokens),
        |p| render_project_favicon(p, ROW_FAVICON_PX, tokens),
    );
    // GPUI has no grayscale filter; `opacity-40` carries the muted look and hover restores it.
    let favicon_slot = div()
        .flex()
        .items_center()
        .flex_shrink_0()
        .opacity(0.4)
        .group_hover(group.clone(), |s| s.opacity(1.0))
        .child(favicon);

    let title_el = if row.is_renaming {
        render_rename_field(row.rename_input, cx)
    } else {
        div()
            .flex_1()
            .min_w_0()
            .truncate()
            .text_size(px(TITLE_FONT_SIZE_PX))
            .line_height(px(TITLE_LINE_HEIGHT_PX))
            .font_weight(gpui_kit::FontWeight::NORMAL)
            .text_color(if row.selected { fg } else { secondary })
            .group_hover(group.clone(), move |s| s.text_color(fg))
            .when(
                thread
                    .title_regeneration
                    .as_ref()
                    .is_some_and(Option::is_some),
                |s| s.opacity(0.55),
            )
            .child(thread.title.clone())
            .into_any_element()
    };

    let unsent_discard = row
        .unsent_draft
        .then(|| render_discard_thread_draft_button(row, &group, cx));
    let unsettle_id = thread.id.clone();
    let time_slot = div()
        .relative()
        .flex()
        .flex_row()
        .items_center()
        .justify_end()
        .h(px(24.0))
        .min_w(px(32.0))
        .ml_auto()
        .flex_shrink_0()
        .text_size(px(META_FONT_SIZE_PX))
        .line_height(px(META_LINE_HEIGHT_PX))
        .child(
            div()
                .text_color(secondary)
                .group_hover(group.clone(), |s| s.invisible())
                .child(
                    format_compact_relative_age_at(settled_thread_timestamp(thread), row.now_secs)
                        .unwrap_or_default(),
                ),
        )
        .child(
            div()
                .id(("thread-unsettle-btn", row.row_key))
                .a11y_button(
                    SharedString::from(format!("sidebar.thread.{}.unsettle", thread.id)),
                    "Un-settle thread",
                )
                .absolute()
                .top_0()
                .bottom_0()
                .right(px(-4.0))
                .flex()
                .items_center()
                .px(px(6.0))
                .rounded(px(CARD_RADIUS_PX))
                .invisible()
                .group_hover(group.clone(), |s| s.visible())
                .cursor_pointer()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |app, _, _, cx| {
                    cx.stop_propagation();
                    app.settle_thread(unsettle_id.clone(), false, cx);
                }))
                .conn_tooltip("Un-settle thread", tokens)
                .child(icons::concept("superhero/undo.svg", 14.0, muted)),
        );

    let mut slim = div()
        .id(("thread-row", row.row_key))
        .a11y(
            gpui_kit::Role::ListItem,
            SharedString::from(format!("sidebar.thread.{}", thread.id)),
            thread.title.clone(),
        )
        .aria_selected(row.selected)
        .group(group)
        .flex()
        .flex_row()
        .items_center()
        .gap(px(10.0))
        .w_full()
        .h(px(SLIM_ROW_HEIGHT_PX))
        .px(px(ROW_HORIZONTAL_INSET_PX))
        .rounded(px(CARD_RADIUS_PX))
        .border_t_1()
        .cursor_pointer()
        .child(favicon_slot)
        .children(row.unsent_draft.then(|| render_unsent_indicator(row)))
        .child(title_el)
        .children(unsent_discard)
        .child(time_slot);
    slim = attach_row_keyboard(attach_row_interactions(slim, row, cx), row, cx);
    if row.selected {
        slim = slim
            .bg(active_bg)
            .border_color(hsla(tokens.shell_divider_raised))
            .hover(move |s| s.bg(active_bg));
        if tokens.appearance == Appearance::Light {
            slim = slim
                .border_1()
                .border_color(hsla_alpha(tokens.sidebar_border, 0.70));
        }
    } else if row.unsent_draft {
        let warning = tokens.warning;
        slim = slim
            .border_color(gpui_kit::transparent_black())
            .bg(unsent_surface(tokens))
            .hover(move |s| s.bg(unsent_surface_hover(warning)));
    } else {
        slim = slim
            .border_color(gpui_kit::transparent_black())
            .hover(move |s| s.bg(hover_bg));
    }
    div().w_full().child(slim)
}

/// `draftSurfaceClassName` rest colour: `bg-warning/4`.
fn unsent_surface(tokens: &Tokens) -> gpui_kit::Hsla {
    hsla_alpha(tokens.warning, 0.04)
}

/// `draftSurfaceClassName` hover colour: `hover:bg-warning/8`.
fn unsent_surface_hover(warning: conn_theme::Rgba) -> gpui_kit::Hsla {
    hsla_alpha(warning, 0.08)
}

/// `draftIndicator`: the `SquarePen` mark (`text-warning-foreground`) on a thread with unsent
/// input, with the `Unsent draft` label.
fn render_unsent_indicator(row: &RowCtx<'_>) -> gpui_kit::AnyElement {
    div()
        .id(("thread-unsent-draft", row.row_key))
        .test_support()
        .a11y(
            gpui_kit::Role::Image,
            SharedString::from(format!("sidebar.thread.{}.unsent-draft", row.thread.id)),
            "Unsent draft",
        )
        .flex()
        .items_center()
        .flex_shrink_0()
        .child(icons::concept(
            "superhero/edit.svg",
            12.0,
            hsla(row.tokens.warning_foreground),
        ))
        .into_any_element()
}

/// The `X` that clears a thread's unsent input: shown on row hover or keyboard focus, and
/// pressed with `Enter` / `Space` (`handleDiscardDraftClick`).
fn render_discard_thread_draft_button(
    row: &RowCtx<'_>,
    group: &SharedString,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::AnyElement {
    let tokens = row.tokens;
    let muted = hsla(tokens.muted_foreground);
    let thread_id = row.thread.id.clone();
    let key_thread_id = row.thread.id.clone();
    div()
        .id(("thread-discard-draft-btn", row.row_key))
        .test_support()
        .a11y_button(
            SharedString::from(format!("sidebar.thread.{}.discard-draft", row.thread.id)),
            "Discard draft",
        )
        .flex()
        .items_center()
        .justify_center()
        .h(px(TITLE_LINE_HEIGHT_PX))
        .px(px(6.0))
        .rounded(px(CARD_RADIUS_PX))
        .flex_shrink_0()
        .cursor_pointer()
        // Not `invisible()`: a hidden element cannot take keyboard focus.
        .opacity(0.0)
        .group_hover(group.clone(), |s| s.opacity(1.0))
        .focus_visible(|s| s.opacity(1.0))
        .tab_index(0)
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_key_down(cx.listener(move |app, event: &gpui_kit::KeyDownEvent, window, cx| {
            if conn_state::is_activation_key(&event.keystroke.key) {
                cx.stop_propagation();
                app.discard_thread_draft_row(&key_thread_id, window, cx);
            }
        }))
        .on_click(cx.listener(move |app, _, window, cx| {
            cx.stop_propagation();
            app.discard_thread_draft_row(&thread_id, window, cx);
        }))
        .conn_tooltip("Discard draft", tokens)
        .child(icons::concept("superhero/close.svg", 12.0, muted))
        .into_any_element()
}

/// `threadTimeTimestamp`: last user message, else last update.
fn thread_time_timestamp(thread: &ThreadShell) -> &str {
    thread
        .latest_user_message_at
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&thread.updated_at)
}

/// `resolveSettledThreadTimestamp`: when the thread was settled (or archived).
fn settled_thread_timestamp(thread: &ThreadShell) -> &str {
    thread
        .settled_at
        .as_deref()
        .or(thread.archived_at.as_deref())
        .filter(|s| !s.is_empty())
        .unwrap_or(&thread.updated_at)
}

/// A project passes the sidebar's scope: no filter, an Orbit workspace that lists it, or the
/// directly filtered project.
#[must_use]
pub(crate) fn project_in_scope(
    shell: &ShellState,
    workspaces: &[OrbitWorkspace],
    active_workspace: Option<&str>,
    project_id: &str,
) -> bool {
    let Some(ws_id) = active_workspace else {
        return true;
    };
    match workspaces.iter().find(|ws| ws.id == ws_id) {
        Some(orbit_ws) => match shell.project(project_id) {
            Some(project) => workspace_matches_project(
                orbit_ws,
                &project.id,
                &project.title,
                &project.workspace_root,
            ),
            None => workspace_matches_project(orbit_ws, project_id, "", ""),
        },
        None => ws_id == project_id,
    }
}

/// Active thread ids in sidebar order: pinned (`pinOrderKey`) first, then active.
#[must_use]
pub(crate) fn ordered_active_thread_ids(shell: &ShellState) -> Vec<String> {
    let (mut pinned, active): (Vec<&ThreadShell>, Vec<&ThreadShell>) = shell
        .top_level_active_threads()
        .partition(|t| t.pinned_at.as_ref().is_some_and(Option::is_some));
    pinned.sort_by(|a, b| pin_order_key(a).cmp(&pin_order_key(b)));
    pinned
        .into_iter()
        .chain(active)
        .map(|t| t.id.clone())
        .collect()
}

/// `pinOrderKey` sort key: pinned threads with a key sort by it; the rest keep shell order.
fn pin_order_key(thread: &ThreadShell) -> (bool, &str) {
    match thread.pin_order_key.as_ref().and_then(Option::as_deref) {
        Some(key) => (false, key),
        None => (true, ""),
    }
}

/// Current Unix time in seconds.
pub(crate) fn current_unix_secs() -> i64 {
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
pub(crate) fn parse_iso8601_unix_secs(iso: &str) -> Option<i64> {
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
    fn working_duration_matches_conn_format() {
        assert_eq!(format_working_duration(-5), "0s");
        assert_eq!(format_working_duration(42), "42s");
        assert_eq!(format_working_duration(125), "2m");
        assert_eq!(format_working_duration(3 * 3600 + 7 * 60), "3h 7m");
    }

    #[test]
    fn middle_truncate_keeps_prefix_and_suffix() {
        assert_eq!(middle_truncate("main", 10), "main");
        let out = middle_truncate("feat/wave1-sidebar-context-header", 15);
        assert_eq!(out.chars().count(), 15);
        assert!(out.starts_with("feat/wa"));
        assert!(out.ends_with("header"));
        assert!(out.contains('…'));
    }

    #[test]
    fn status_labels_and_icons_exist() {
        use gpui_kit::AssetSource as _;
        let assets = crate::superhero::AppAssets;
        for status in [
            RowStatus::Working,
            RowStatus::Goal,
            RowStatus::Waiting,
            RowStatus::Approval,
            RowStatus::Input,
            RowStatus::Failed,
            RowStatus::Done,
        ] {
            assert!(!status.label().is_empty());
            assert!(
                assets.load(status.icon()).ok().flatten().is_some(),
                "status icon {} exists",
                status.icon()
            );
        }
        for path in [
            "superhero/pin.svg",
            "superhero/unpin.svg",
            "superhero/undo.svg",
            "superhero/check.svg",
            "superhero/folder-git.svg",
        ] {
            assert!(assets.load(path).ok().flatten().is_some(), "{path} exists");
        }
    }

    #[test]
    fn questions_and_approvals_get_the_yellow_warning_dot() {
        let theme = conn_theme::theme_by_id("dark-ocean").expect("built-in theme");
        let tokens = Tokens::derive(&theme);
        let warning = hsla(tokens.warning);
        assert_eq!(RowStatus::Input.dot_color(&tokens), warning);
        assert_eq!(RowStatus::Approval.dot_color(&tokens), warning);
        assert_ne!(RowStatus::Waiting.dot_color(&tokens), warning);
    }

    #[test]
    fn a_pending_request_resolves_to_input_or_approval_unless_auth_refresh() {
        use conn_contract::OrchestrationV2PendingRuntimeRequestSummary as Request;
        use conn_contract::OrchestrationV2PendingRuntimeRequestSummaryKind as Kind;
        let shell = crate::fixture::demo_shell_state();
        let mut thread = shell
            .find_thread("thread-theme-tokens")
            .expect("fixture thread with a pending request")
            .clone();
        let request = |kind| {
            Some(Request {
                id: "req".to_owned(),
                kind,
                created_at: "2026-11-21T00:54:00.000Z".to_owned(),
                blocking: Some(true),
                user_only: None,
            })
        };
        thread.pending_runtime_request = request(Kind::UserInput);
        assert_eq!(resolve_row_status(&thread), Some(RowStatus::Input));
        thread.pending_runtime_request = request(Kind::Permission);
        assert_eq!(resolve_row_status(&thread), Some(RowStatus::Approval));
        thread.pending_runtime_request = request(Kind::McpElicitation);
        assert_eq!(resolve_row_status(&thread), Some(RowStatus::Approval));
        thread.pending_runtime_request = request(Kind::AuthRefresh);
        assert_ne!(resolve_row_status(&thread), Some(RowStatus::Approval));
    }

    #[test]
    fn recede_rules_follow_conn() {
        assert!(should_recede(None, false));
        assert!(!should_recede(None, true));
        assert!(should_recede(Some(RowStatus::Working), false));
        assert!(!should_recede(Some(RowStatus::Input), false));
        assert!(!should_recede(Some(RowStatus::Done), false));
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
