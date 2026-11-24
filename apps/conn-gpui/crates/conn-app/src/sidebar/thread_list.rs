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

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use conn_desktop::orbit::{OrbitWorkspace, workspace_matches_project};
use conn_state::sidebar_drag::{
    self, DropVerb, OptimisticDrop, Section, SweepAction, order_by_preferred,
};
use conn_state::thread_search::find_search_token_ranges;
use conn_state::{
    LayoutState, MoreState, PendingSubagentRequest, ProjectShell, SETTLED_MORE_ROW,
    SETTLED_SHELF_ROW, ShelfInput, ShelfView, ShellState, ThreadSelection, ThreadShell, TreeRow,
    jump_hint_label, jump_hint_number, more_label, search_highlight_index, shelf_view, sort_active,
    sort_pinned,
};
use conn_theme::{Appearance, ShellGeometry, Tokens};
use gpui_kit::Focusable as _;
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
use crate::app::{ConnApp, PressMode};
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
/// Distance from the sidebar's bottom edge to the bottom of its last slim row's text
/// (`8px` content inset + the `8px` below a `20px` line in a `36px` row). The composer card
/// uses it as its bottom gap so both bottoms line up.
pub(crate) const SIDEBAR_LAST_LINE_BOTTOM_INSET_PX: f32 =
    SIDEBAR_CONTENT_INSET_PX + (SLIM_ROW_HEIGHT_PX - 20.0) / 2.0;
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

/// Ties the lifetime of the thread a row is built for to the row, which a closure cannot say.
fn row_builder<'a, F>(build: F) -> F
where
    F: Fn(&'a ThreadShell, usize, RowFocus) -> RowCtx<'a>,
{
    build
}

/// What the rows wear beyond what the shell says about their thread.
pub(crate) struct SidebarMarks<'a> {
    /// The threads that carry a jump number while `⌘` is held, in the order of their numbers
    /// (`jumpLabelByKey`); empty while the hints are hidden.
    pub(crate) jump_order: &'a [String],
    /// The threads picked with `⌘`-click and `Shift`-click for a bulk action.
    pub(crate) selection: &'a ThreadSelection,
    /// The Settled shelf.
    pub(crate) shelf: ShelfMarks,
    /// What the server found in the threads' messages.
    pub(crate) search: SearchMarks<'a>,
    /// A drop the server has not caught up with.
    pub(crate) pending_drop: Option<(&'a OptimisticDrop, &'a ThreadShell)>,
    /// The row held and moved over the list.
    pub(crate) drag: Option<DragMarks<'a>>,
    /// The run of rows swept with a Settle or Un-settle button.
    pub(crate) sweep: Option<SweepMarks<'a>>,
}

/// A held row (`dragState`): where it came from, where it would land, and the lists as they
/// would be with it there (`createSidebarSortingStrategy`).
pub(crate) struct DragMarks<'a> {
    pub(crate) held: &'a str,
    pub(crate) from: Section,
    pub(crate) target: Option<Section>,
    pub(crate) pinned: &'a [String],
    pub(crate) active: &'a [String],
    pub(crate) settled: &'a [String],
}

/// The rows a sweep covers, and what they will get (`SidebarActionSweep`).
pub(crate) struct SweepMarks<'a> {
    pub(crate) keys: &'a [String],
    pub(crate) action: SweepAction,
}

/// What a row wears while a drag or sweep is going on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
enum RowDrag {
    #[default]
    None,
    /// The held row, lifted, with the badge of where it would land.
    Held(Option<DropVerb>),
    /// A row the sweep covers.
    Swept(DropVerb),
}

/// The Settled shelf's state (`settledShelfExpanded`, `settledVisibleCount`, `olderSettledShelf`).
#[derive(Clone, Copy, Debug)]
pub(crate) struct ShelfMarks {
    pub(crate) expanded: bool,
    /// Rows the shelf shows when open.
    pub(crate) visible_count: usize,
    /// Whether an older page is on its way or failed.
    pub(crate) more: MoreState,
}

/// One message hit shown under a result (`ThreadSearchMatchExcerpt`).
#[derive(Clone, Debug)]
pub(crate) struct Excerpt {
    pub(crate) source: conn_contract::OrchestrationThreadSearchSource,
    pub(crate) snippet: String,
}

/// The message search of the sidebar box.
#[derive(Clone, Copy)]
pub(crate) struct SearchMarks<'a> {
    /// The threads listed for their messages, in the order the matches were ranked.
    pub(crate) order: &'a [String],
    /// The hit of each such thread.
    pub(crate) excerpts: &'a std::collections::HashMap<String, Excerpt>,
    /// The query the hits were found for, which lags the box while a search runs.
    pub(crate) matched_query: &'a str,
    /// A search is on its way (`threadSearch.isPending`).
    pub(crate) pending: bool,
    /// No environment could run the search (`threadSearch.failed`).
    pub(crate) failed: bool,
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
    workspaces: &[OrbitWorkspace],
    active_workspace: Option<&str>,
    drafts: &DraftSidebar<'_>,
    marks: &SidebarMarks<'_>,
    search_input: &Entity<InputState>,
    search_highlight: Option<&str>,
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
    let search_focused = search_input.focus_handle(cx).is_focused(window);

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
    // The button shows the project it filters to (`ProjectFavicon`, `size-4`), else the filter
    // glyph.
    let filter_icon = active_workspace
        .and_then(|id| shell.project(id))
        .map_or_else(
            || header_icon(IconName::ListFilter, tokens),
            |project| render_project_favicon(project, ROW_FAVICON_PX, tokens).into_any_element(),
        );
    if has_projects {
        let mut filter_slot = div().relative().child(
            sidebar_header_icon_btn(
                "sidebar-filter-projects",
                filter_icon,
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
                header_icon(IconName::FolderPlus, tokens),
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
            header_icon(IconName::SquarePen, tokens),
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
        // `focus-within:bg-sidebar-row-hover focus-within:ring-1 focus-within:ring-inset
        // focus-within:ring-ring/70`.
        .when(search_focused, |el| {
            el.bg(hover_bg).shadow(vec![gpui_kit::BoxShadow {
                color: hsla_alpha(tokens.ring, 0.70),
                offset: gpui_kit::point(px(0.0), px(0.0)),
                blur_radius: px(0.0),
                spread_radius: px(1.0),
                inset: true,
            }])
        })
        .child(icons::chrome(IconName::Search, search_icon_color))
        .child(
            div().flex_1().min_w_0().child(
                Input::new(search_input)
                    .appearance(false)
                    .text_size(px(TITLE_FONT_SIZE_PX)),
            ),
        );
    if has_query {
        search_box = search_box.child(
            div()
                .id("sidebar-search-clear")
                .test_support()
                .a11y_button("sidebar.search.clear", "Clear thread search")
                .flex()
                .items_center()
                .justify_center()
                .size(px(18.0))
                .flex_shrink_0()
                .rounded(px(4.0))
                .cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .on_click(cx.listener(|app, _, window, cx| {
                    // Conn gives the keyboard back to the search box (`onClearSearch`, `focus()`).
                    app.clear_sidebar_search(true, window, cx);
                }))
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
    let now_secs = current_unix_secs();
    // A subagent that is open keeps its parent's row current (`routeRowThreadKey`).
    let selected_id = layout
        .selected_thread_id
        .as_deref()
        .map(|id| shell.listed_ancestor(id).unwrap_or(id));
    let row_flags = |thread: &ThreadShell| {
        (
            selected_id == Some(thread.id.as_str()),
            renaming_thread_id == Some(thread.id.as_str()),
        )
    };
    let lists = sidebar_lists(
        shell,
        workspaces,
        active_workspace,
        &search_query,
        marks.search.order,
        marks.pending_drop,
    );
    let settled_expanded = marks.shelf.expanded;
    let shelf = shelf_of(
        &lists,
        shell,
        workspaces,
        active_workspace,
        selected_id,
        settled_expanded,
        marks.shelf.visible_count,
    );
    // A held row shows where it would land: the lists are what they would be with it there.
    let held_lists = marks.drag.as_ref().filter(|_| !has_query).map(|drag| {
        let threads = |ids: &[String]| -> Vec<&ThreadShell> {
            ids.iter().filter_map(|id| shell.find_thread(id)).collect()
        };
        (
            threads(drag.pinned),
            threads(drag.active),
            threads(drag.settled),
        )
    });
    let SidebarLists {
        pinned,
        active,
        settled: settled_threads,
        messages,
        ..
    } = lists;
    let (pinned, active) = match &held_lists {
        Some((held_pinned, held_active, _)) => (held_pinned.clone(), held_active.clone()),
        None => (pinned, active),
    };
    // Search lists its results flat, in one list the arrow keys walk (`SidebarSearchResultRow`);
    // the highlighted one is what `Enter` opens.
    let result_ids: Vec<String> = if has_query {
        pinned
            .iter()
            .chain(&active)
            .chain(&settled_threads)
            .chain(&messages)
            .map(|thread| thread.id.clone())
            .collect()
    } else {
        Vec::new()
    };
    let highlighted_id = search_highlight_index(&result_ids, search_highlight)
        .and_then(|at| result_ids.get(at).map(String::as_str));

    let mut thread_rows: Vec<gpui_kit::AnyElement> =
        Vec::with_capacity(pinned.len() + active.len() + drafts.rows.len() + 2);
    // The row of `thread`, whatever list it is in.
    let row_of = row_builder(|thread: &ThreadShell, row_key: usize, focus: RowFocus| {
        let (selected, is_renaming) = row_flags(thread);
        RowCtx {
            row_key,
            thread,
            project: shell.project(&thread.project_id),
            selected,
            picked: marks.selection.contains(&thread.id),
            jump_hint: jump_hint_number(marks.jump_order, &thread.id).map(jump_hint_label),
            is_renaming,
            unsent_draft: drafts.unsent_threads.contains(&thread.id),
            rename_input,
            now_secs,
            sidebar_width: layout.sidebar_width,
            hover_open: hover.open_for == Some(thread.id.as_str()),
            hover_rect: hover.rect,
            environment_label: hover.environment_label,
            subagent_request: shell.subagent_request(&thread.id),
            drag: row_drag(marks, &thread.id),
            focus,
            tokens,
        }
    });
    if has_query {
        // Search swaps the list for slim result rows, which are not tab stops
        // (`SidebarSearchResultRow`, `tabIndex={-1}`): the keyboard stays in the search box and
        // the arrow keys work the highlight. Drafts return when the search clears.
        let settled_ids: HashSet<&str> = settled_threads
            .iter()
            .chain(&messages)
            .filter(|t| ShellState::is_settled(t))
            .map(|t| t.id.as_str())
            .collect();
        let message_ids: HashSet<&str> = messages.iter().map(|t| t.id.as_str()).collect();
        for (idx, thread) in pinned
            .iter()
            .chain(&active)
            .chain(&settled_threads)
            .chain(&messages)
            .enumerate()
        {
            let result = SearchResultRow {
                row_key: idx,
                thread,
                project: shell.project(&thread.project_id),
                settled: settled_ids.contains(thread.id.as_str()),
                open: selected_id == Some(thread.id.as_str()),
                highlighted: highlighted_id == Some(thread.id.as_str()),
                now_secs,
                hover_open: hover.open_for == Some(thread.id.as_str()),
                hover_rect: hover.rect,
                environment_label: hover.environment_label,
                // Only a thread listed for its messages shows the message (`searchMatch`).
                excerpt: message_ids
                    .contains(thread.id.as_str())
                    .then(|| marks.search.excerpts.get(&thread.id))
                    .flatten(),
                matched_query: marks.search.matched_query,
                bounds: tree.result_bounds(&thread.id),
                tokens,
            };
            thread_rows.push(render_search_result_row(&result, cx));
        }
    } else {
        thread_rows.extend(render_draft_block(&drafts.rows, tree, tokens, cx));
        let dragging = marks.drag.as_ref();
        let held_from = dragging.map(|drag| drag.from);
        let target = dragging.and_then(|drag| drag.target);
        // `SidebarDragBoundary`: while a row is held, a label opens above each section.
        if dragging.is_some() {
            thread_rows.push(render_drag_boundary(
                "Pinned",
                target == Some(Section::Pinned),
                tokens,
            ));
        }
        for (idx, thread) in pinned.iter().enumerate() {
            let focus = tree.row(TreeRow::leaf(thread.id.clone()), cx);
            let row = row_of(thread, idx, focus);
            thread_rows.push(render_thread_card(&row, cx).into_any_element());
        }
        if dragging.is_some() {
            thread_rows.push(render_drag_boundary(
                "Active",
                target == Some(Section::Active),
                tokens,
            ));
            if sidebar_drag::placeholder_hint(Section::Active, held_from, active.len(), target) {
                thread_rows.push(render_section_placeholder(
                    "Active",
                    target == Some(Section::Active),
                    tokens,
                ));
            }
        } else if !pinned.is_empty() {
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
            let focus = tree.row(TreeRow::leaf(thread.id.clone()), cx);
            let row = row_of(thread, 10_000 + idx, focus);
            thread_rows.push(render_thread_card(&row, cx).into_any_element());
        }
    }

    // Settled shelf (`SidebarSectionHeader` in `Sidebar.tsx`): always shown, with its count
    // (Conn shows "Settled 0"), pushed to the bottom of the list with `mt-auto`. Search hides it
    // and lists the settled threads that match among the results.
    let settled_count = shelf.count;
    let shelf_rows: Vec<String> = match &held_lists {
        // The held row sits in the shelf while it would settle there (`projected`).
        Some((_, _, held_settled)) => held_settled.iter().map(|t| t.id.clone()).collect(),
        None => shelf.rows.clone(),
    };

    let no_matches = has_query && result_ids.is_empty();

    let mut list_scroll = div()
        .id("sidebar-thread-scroll")
        .test_support()
        .a11y(
            if has_query {
                gpui_kit::Role::ListBox
            } else {
                gpui_kit::Role::List
            },
            "sidebar.thread-list",
            if has_query {
                "Thread search results"
            } else {
                "Threads"
            },
        )
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
                .child(if marks.search.pending {
                    "Searching thread messages…"
                } else if marks.search.failed {
                    "Couldn't search thread messages"
                } else {
                    "No threads found"
                }),
        );
    }

    if !has_query {
        let header_focus = tree.row(TreeRow::group(SETTLED_SHELF_ROW, settled_expanded), cx);
        let header_ring = focus_ring(tokens);
        // `tone`: `accent` over the drop target, `emphasized` while a row is held.
        let held_row = marks.drag.is_some();
        let header_target =
            marks.drag.as_ref().and_then(|drag| drag.target) == Some(Section::Settled);
        let muted = if header_target {
            hsla(tokens.primary)
        } else if held_row {
            hsla_alpha(tokens.sidebar_foreground, 0.80)
        } else {
            muted
        };
        let settled_header = div()
            .id("sidebar-settled-footer")
            .test_support()
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
                app.toggle_settled_shelf(cx);
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

        if let Some(drag) = &marks.drag
            && sidebar_drag::placeholder_hint(
                Section::Settled,
                Some(drag.from),
                shelf_rows.len(),
                drag.target,
            )
        {
            list_scroll = list_scroll.child(render_section_placeholder(
                "Settled",
                drag.target == Some(Section::Settled),
                tokens,
            ));
        }

        // A collapsed shelf still shows the open settled thread (`routeThreadOnly`); an open one
        // shows a page of rows, and `Show more` reads the next (`SETTLED_TAIL_*`).
        for (idx, id) in shelf_rows.iter().enumerate() {
            let Some(thread) = shell.find_thread(id) else {
                continue;
            };
            let focus = tree.row(TreeRow::child(thread.id.clone(), SETTLED_SHELF_ROW), cx);
            let row = row_of(thread, 100_000 + idx, focus);
            list_scroll = list_scroll.child(render_settled_row(&row, cx));
        }
        if shelf.has_more(settled_expanded) {
            let focus = tree.row(TreeRow::child(SETTLED_MORE_ROW, SETTLED_SHELF_ROW), cx);
            list_scroll = list_scroll.child(render_show_more(
                &shelf,
                marks.shelf.more,
                focus,
                tokens,
                cx,
            ));
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
    icon: gpui_kit::AnyElement,
    tokens: &Tokens,
    on_click: impl Fn(&gpui_kit::ClickEvent, &mut gpui_kit::Window, &mut gpui_kit::App) + 'static,
) -> gpui_kit::Stateful<gpui_kit::Div> {
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
        .child(icon)
}

/// The glyph of a sidebar header button.
fn header_icon(name: IconName, tokens: &Tokens) -> gpui_kit::AnyElement {
    icons::chrome(name, hsla_alpha(tokens.sidebar_muted_foreground, 0.80)).into_any_element()
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

/// [`resolve_listed_row_status`] for a thread whose subagents ask nothing.
#[must_use]
pub(crate) fn resolve_row_status(thread: &ThreadShell) -> Option<RowStatus> {
    resolve_listed_row_status(thread, None)
}

/// Port of `resolveSidebarThreadStatus` plus the unseen-completion `Done` pill
/// (`hasUnseenCompletion`: the latest run completed after the last visit). What a subagent, side
/// chat or delegated task asks of the user counts as the thread's own request
/// (`pendingSubagentRequest`).
#[must_use]
pub(crate) fn resolve_listed_row_status(
    thread: &ThreadShell,
    subagent: Option<PendingSubagentRequest>,
) -> Option<RowStatus> {
    use conn_contract::OrchestrationV2PendingRuntimeRequestSummaryKind as Kind;
    use conn_contract::OrchestrationV2ShellThreadStatus as Status;
    let own = thread.pending_runtime_request.as_ref().map(|r| r.kind);
    if subagent == Some(PendingSubagentRequest::Approval)
        || own.is_some_and(|kind| !matches!(kind, Kind::UserInput | Kind::AuthRefresh))
    {
        return Some(RowStatus::Approval);
    }
    if subagent == Some(PendingSubagentRequest::UserInput) || own == Some(Kind::UserInput) {
        return Some(RowStatus::Input);
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
    /// Picked with `⌘`-click or `Shift`-click for a bulk action (`isSelected`).
    picked: bool,
    /// The jump number shown while `⌘` is held (`jumpHintLabel`), as `⌘3`.
    jump_hint: Option<String>,
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
    /// What its subagents, side chats and delegated tasks ask of the user
    /// (`pendingSubagentRequest`).
    subagent_request: Option<PendingSubagentRequest>,
    /// The row is held, or swept over.
    drag: RowDrag,
    /// What the row needs to take the keyboard.
    focus: RowFocus,
    tokens: &'a Tokens,
}

impl RowCtx<'_> {
    /// `bg-sidebar-row-selected`: picked for a bulk action, or covered by a sweep.
    fn picked_look(&self) -> bool {
        self.picked || matches!(self.drag, RowDrag::Swept(_))
    }

    /// The badge the row wears while it is held or swept.
    fn drop_verb(&self) -> Option<DropVerb> {
        match self.drag {
            RowDrag::None | RowDrag::Held(None) => None,
            RowDrag::Held(Some(verb)) | RowDrag::Swept(verb) => Some(verb),
        }
    }

    /// The row wears the open thread's look.
    fn lit(&self) -> bool {
        self.selected
    }

    /// `aria-selected`: the open thread, or a thread picked for a bulk action.
    fn aria_selected(&self) -> bool {
        self.selected || self.picked
    }
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

/// The look of a row while files are dragged over it (`isFileDragOver`): `ring-1 ring-inset
/// ring-primary/70`, and the hover fill unless the row has a stronger one.
#[derive(Clone, Copy)]
struct DropLook {
    ring: gpui_kit::Hsla,
    fill: Option<gpui_kit::Hsla>,
}

impl DropLook {
    fn new(tokens: &Tokens, has_fill: bool) -> Self {
        Self {
            ring: hsla_alpha(tokens.primary, 0.70),
            fill: (!has_fill).then(|| hsla(tokens.sidebar_row_hover)),
        }
    }

    fn apply(self, style: gpui_kit::StyleRefinement) -> gpui_kit::StyleRefinement {
        let style = style.shadow(vec![gpui_kit::BoxShadow {
            color: self.ring,
            offset: gpui_kit::point(px(0.0), px(0.0)),
            blur_radius: px(0.0),
            spread_radius: px(1.0),
            inset: true,
        }]);
        match self.fill {
            Some(fill) => style.bg(fill),
            None => style,
        }
    }
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
    let drop_id = thread.id.clone();
    let press_id = thread.id.clone();
    let drop_look = DropLook::new(ctx.tokens, ctx.lit() || ctx.picked);
    let row = row
        // Files dropped on a row go to that thread (`handleThreadFileDrop`).
        .drag_over::<gpui_kit::ExternalPaths>(move |style, _, _, _| drop_look.apply(style))
        .on_drop(cx.listener(
            move |app, dropped: &gpui_kit::ExternalPaths, window, cx| {
                app.thread_files_dropped(&drop_id, dropped.paths().to_vec(), window, cx);
            },
        ))
        .on_hover(cx.listener(move |app, hovered: &bool, _, cx| {
            app.thread_hover_changed(&hover_id, *hovered, cx);
        }))
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |app, event: &gpui_kit::MouseDownEvent, _, cx| {
                app.dismiss_thread_hover(cx);
                // A press that moves `DRAG_DISTANCE_PX` drags the row (`SidebarPointerSensor`);
                // `⌘`, `Shift` and `Ctrl` pick rows instead.
                let m = event.modifiers;
                let plain = !(m.platform || m.control || m.shift || m.alt);
                app.row_pressed(&press_id, event.position, PressMode::Drag, plain, cx);
            }),
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
            app.thread_row_clicked(&select_id, &modifiers, window, cx);
        }),
    )
    .on_mouse_down(
        MouseButton::Right,
        cx.listener(move |app, event: &gpui_kit::MouseDownEvent, _, cx| {
            cx.stop_propagation();
            app.open_row_menu(menu_id.clone(), event.position, cx);
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

/// What a row wears for the drag or sweep going on (`dropVerb`, `sweepAction`).
fn row_drag(marks: &SidebarMarks<'_>, id: &str) -> RowDrag {
    if let Some(drag) = &marks.drag
        && drag.held == id
    {
        return RowDrag::Held(sidebar_drag::drop_verb(drag.from, drag.target));
    }
    if let Some(sweep) = &marks.sweep
        && sweep.keys.iter().any(|key| key == id)
    {
        return RowDrag::Swept(sweep.action.verb());
    }
    RowDrag::None
}

/// `SidebarDragBoundary`: the label a section gets while a row is held, `h-6` with a rule after
/// it; the section the row would land in shows it in `primary`.
fn render_drag_boundary(
    label: &'static str,
    target: bool,
    tokens: &Tokens,
) -> gpui_kit::AnyElement {
    let (text, rule) = if target {
        (hsla(tokens.primary), hsla_alpha(tokens.primary, 0.50))
    } else {
        (
            hsla_alpha(tokens.sidebar_foreground, 0.80),
            hsla_alpha(tokens.sidebar_foreground, 0.25),
        )
    };
    div()
        .id(SharedString::from(format!("sidebar-drag-boundary-{label}")))
        .test_support()
        .a11y_group(
            SharedString::from(format!("sidebar.drag.boundary.{}", label.to_lowercase())),
            label,
        )
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .w_full()
        .h(px(conn_state::sidebar_drag::BOUNDARY_LABEL_HEIGHT_PX))
        .px(px(8.0))
        .flex_shrink_0()
        .child(
            div()
                .flex_shrink_0()
                .text_size(px(META_FONT_SIZE_PX))
                .line_height(px(META_LINE_HEIGHT_PX))
                .font_weight(gpui_kit::FontWeight::MEDIUM)
                .text_color(text)
                .child(label),
        )
        .child(div().h(px(1.0)).flex_1().bg(rule))
        .into_any_element()
}

/// `SidebarSectionPlaceholder`: the dashed `h-9` hint an empty section shows while a row is held.
fn render_section_placeholder(
    label: &'static str,
    target: bool,
    tokens: &Tokens,
) -> gpui_kit::AnyElement {
    let (border, fill, text) = if target {
        (
            hsla_alpha(tokens.primary, 0.40),
            Some(hsla_alpha(tokens.primary, 0.05)),
            hsla(tokens.primary),
        )
    } else {
        (
            hsla_alpha(tokens.sidebar_foreground, 0.25),
            None,
            hsla_alpha(tokens.sidebar_foreground, 0.80),
        )
    };
    div()
        .id(SharedString::from(format!("sidebar-placeholder-{label}")))
        .test_support()
        .a11y_group(
            SharedString::from(format!("sidebar.drag.placeholder.{}", label.to_lowercase())),
            label,
        )
        .flex()
        .items_center()
        .justify_center()
        .w_full()
        .h(px(SLIM_ROW_HEIGHT_PX))
        .mx(px(2.0))
        .flex_shrink_0()
        .rounded(px(CARD_RADIUS_PX))
        .border_1()
        .border_dashed()
        .border_color(border)
        .when_some(fill, |el, fill| el.bg(fill))
        .text_size(px(META_FONT_SIZE_PX))
        .line_height(px(META_LINE_HEIGHT_PX))
        .text_color(text)
        .child(label)
        .into_any_element()
}

/// `dropVerbBadge`: where the held row would land, or what a sweep will do to a swept row
/// (`h-5 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-2xs font-medium`).
fn render_drop_badge(verb: DropVerb, tokens: &Tokens) -> gpui_kit::AnyElement {
    let primary = hsla(tokens.primary);
    let icon = match verb {
        DropVerb::Pin => "superhero/pin.svg",
        DropVerb::Unpin => "superhero/unpin.svg",
        DropVerb::Settle => "superhero/check-circle.svg",
        DropVerb::Unsettle => "superhero/undo.svg",
    };
    div()
        .id(SharedString::from(format!(
            "sidebar-drop-badge-{}",
            verb.label()
        )))
        .test_support()
        .a11y_group(SharedString::from("sidebar.drop-verb"), verb.label())
        .flex()
        .flex_row()
        .items_center()
        .gap(px(4.0))
        .ml_auto()
        .h(px(20.0))
        .px(px(6.0))
        .flex_shrink_0()
        .rounded(px(2.0))
        .border_1()
        .border_color(hsla_alpha(tokens.primary, 0.40))
        .bg(hsla_alpha(tokens.primary, 0.10))
        .text_size(px(10.0))
        .line_height(px(14.0))
        .font_weight(gpui_kit::FontWeight::MEDIUM)
        .text_color(primary)
        .child(icons::concept(icon, 12.0, primary))
        .child(verb.label())
        .into_any_element()
}

/// The footer of the open Settled shelf: `Show N more`, `Loading`, or the retry for an older page
/// that failed (`data-sidebar-row="settled:more"`). Its label is the whole of what it does.
fn render_show_more(
    shelf: &ShelfView,
    state: MoreState,
    focus: RowFocus,
    tokens: &Tokens,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::AnyElement {
    let label = more_label(state, shelf.hidden);
    let muted = hsla(tokens.sidebar_muted_foreground);
    let fg = hsla(tokens.sidebar_foreground);
    let hover_bg = hsla(tokens.sidebar_row_hover);
    let ring = focus_ring(tokens);
    let loading = state == MoreState::Loading;
    div()
        .id("sidebar-settled-more")
        .test_support()
        .a11y_button("sidebar.settled-more", label.clone())
        .relative()
        .track_focus(&focus.handle)
        .focus_visible(move |s| s.shadow(vec![ring]))
        .on_key_down(cx.listener(|app, event: &gpui_kit::KeyDownEvent, window, cx| {
            app.sidebar_row_key(SETTLED_MORE_ROW, event, window, cx);
        }))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(10.0))
        .w_full()
        .h(px(SLIM_ROW_HEIGHT_PX))
        .px(px(ROW_HORIZONTAL_INSET_PX))
        .flex_shrink_0()
        .rounded(px(ROW_RADIUS_PX))
        .text_size(px(TITLE_FONT_SIZE_PX))
        .line_height(px(TITLE_LINE_HEIGHT_PX))
        .text_color(muted)
        .when(!loading, |el| {
            el.cursor_pointer().hover(move |s| s.bg(hover_bg).text_color(fg))
        })
        .on_click(cx.listener(|app, _, _, cx| app.show_more_settled(cx)))
        // Plus means "add", so revealing more uses a chevron.
        .child(icons::sized(IconName::ChevronDown, 16.0, muted))
        .child(label)
        .child(measure_row(&focus))
        .into_any_element()
}

/// `ThreadSearchMatchExcerpt`: who wrote the message and the words of the snippet that matched,
/// on one line under the result's title.
fn render_excerpt(excerpt: &Excerpt, query: &str, tokens: &Tokens) -> gpui_kit::AnyElement {
    use conn_contract::OrchestrationThreadSearchSource as Source;
    let label = conn_state::thread_search::excerpt_label(excerpt.source);
    let tag_color = match excerpt.source {
        Source::User => hsla(tokens.info_foreground),
        Source::Assistant => hsla(tokens.success_foreground),
    };
    let prefix = format!("{label} ");
    let mut highlights: Vec<(std::ops::Range<usize>, gpui_kit::HighlightStyle)> = vec![(
        0..label.len(),
        gpui_kit::HighlightStyle {
            color: Some(tag_color),
            ..gpui_kit::HighlightStyle::default()
        },
    )];
    for range in find_search_token_ranges(&excerpt.snippet, query) {
        highlights.push((
            prefix.len() + range.start..prefix.len() + range.end,
            gpui_kit::HighlightStyle {
                color: Some(hsla(tokens.foreground)),
                font_weight: Some(gpui_kit::FontWeight::SEMIBOLD),
                ..gpui_kit::HighlightStyle::default()
            },
        ));
    }
    let text = format!("{prefix}{}", excerpt.snippet);
    div()
        .w_full()
        .min_w_0()
        .truncate()
        .text_size(px(META_FONT_SIZE_PX))
        .line_height(px(META_LINE_HEIGHT_PX))
        .text_color(hsla_alpha(tokens.muted_foreground, 0.85))
        .child(gpui_kit::StyledText::new(text).with_highlights(highlights))
        .into_any_element()
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
    let status = resolve_listed_row_status(thread, row.subagent_request);
    let recede = should_recede(status, row.lit());
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
            crate::panels::chrome::sidebar_status_dot_rings(tokens, row.lit());
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

    // Hover-only icon-only settle control (`CircleCheckIcon`, `size-3.5`). While `⌘` is held the
    // jump number takes the slot, and the controls in it are hidden (`JUMP_HINT_SLOT_CLASS_NAME`).
    if row.unsent_draft && row.jump_hint.is_none() {
        line1 = line1.child(render_discard_thread_draft_button(row, &group, cx));
    }
    let settle_id = thread.id.clone();
    let press_id = thread.id.clone();
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
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |app, event: &gpui_kit::MouseDownEvent, _, cx| {
                cx.stop_propagation();
                // Dragging on from the button sweeps the rows below or above it.
                app.row_pressed(
                    &press_id,
                    event.position,
                    PressMode::Sweep(SweepAction::Settle),
                    true,
                    cx,
                );
            }),
        )
        .on_click(cx.listener(move |app, _, _, cx| {
            cx.stop_propagation();
            if !app.click_suppressed() {
                app.settle_thread(settle_id.clone(), true, cx);
            }
        }))
        .conn_tooltip("Settle thread", tokens)
        .child(icons::concept("superhero/check-circle.svg", 14.0, muted));
    line1 = match (&row.jump_hint, row.drop_verb()) {
        (_, Some(verb)) => line1.child(render_drop_badge(verb, tokens)),
        (Some(label), None) => line1.child(render_jump_hint(row, label)),
        (None, None) if matches!(row.drag, RowDrag::Held(_)) => line1,
        (None, None) => line1.child(settle_btn),
    };

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
        .aria_selected(row.aria_selected())
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

    // The held row is lifted: `bg-sidebar-row-active text-sidebar-foreground opacity-100
    // shadow-lg` over the sidebar fill.
    // Active row: `bg-sidebar-row-active` + `border-t-(--shell-divider-raised)/50`;
    // light mode adds `ring-1 ring-inset ring-sidebar-border/70` inside that top border.
    if matches!(row.drag, RowDrag::Held(_)) {
        card = card
            .bg(active_bg)
            .border_color(hsla_alpha(tokens.shell_divider_raised, 0.50))
            .shadow_lg()
            .hover(move |s| s.bg(active_bg));
    } else if row.lit() {
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
    } else if row.picked_look() {
        // `isSelected`: `bg-sidebar-row-selected`, with the light ring of the active row.
        let picked_bg = hsla(tokens.sidebar_row_selected);
        card = card
            .bg(picked_bg)
            .border_color(gpui_kit::transparent_black())
            .hover(move |s| s.bg(picked_bg));
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
            .text_color(if row.lit() { fg } else { secondary })
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

    let unsent_discard = (row.unsent_draft && row.jump_hint.is_none())
        .then(|| render_discard_thread_draft_button(row, &group, cx));
    let unsettle_id = thread.id.clone();
    let press_id = thread.id.clone();
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
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |app, event: &gpui_kit::MouseDownEvent, _, cx| {
                        cx.stop_propagation();
                        app.row_pressed(
                            &press_id,
                            event.position,
                            PressMode::Sweep(SweepAction::Unsettle),
                            true,
                            cx,
                        );
                    }),
                )
                .on_click(cx.listener(move |app, _, _, cx| {
                    cx.stop_propagation();
                    if !app.click_suppressed() {
                        app.settle_thread(unsettle_id.clone(), false, cx);
                    }
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
        .aria_selected(row.aria_selected())
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
        .children(unsent_discard);
    slim = match (&row.jump_hint, row.drop_verb()) {
        (_, Some(verb)) => slim.child(render_drop_badge(verb, tokens)),
        (Some(label), None) => slim.child(div().ml_auto().child(render_jump_hint(row, label))),
        (None, None) if matches!(row.drag, RowDrag::Held(_)) => slim,
        (None, None) => slim.child(time_slot),
    };
    slim = attach_row_keyboard(attach_row_interactions(slim, row, cx), row, cx);
    if matches!(row.drag, RowDrag::Held(_)) {
        slim = slim
            .bg(active_bg)
            .border_color(hsla(tokens.shell_divider_raised))
            .shadow_lg()
            .hover(move |s| s.bg(active_bg));
    } else if row.lit() {
        slim = slim
            .bg(active_bg)
            .border_color(hsla(tokens.shell_divider_raised))
            .hover(move |s| s.bg(active_bg));
        if tokens.appearance == Appearance::Light {
            slim = slim
                .border_1()
                .border_color(hsla_alpha(tokens.sidebar_border, 0.70));
        }
    } else if row.picked_look() {
        let picked_bg = hsla(tokens.sidebar_row_selected);
        slim = slim
            .bg(picked_bg)
            .border_color(gpui_kit::transparent_black())
            .hover(move |s| s.bg(picked_bg));
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

/// `JumpHintBadge`: the `Kbd` (`h-5 min-w-5 rounded px-1 text-xs font-medium`, `bg-foreground/7`,
/// `text-muted-foreground`) that takes a row's right slot while `⌘` is held. Purely visual
/// (`aria-hidden`): the shortcut is `⌘1`..`⌘9`.
fn render_jump_hint(row: &RowCtx<'_>, label: &str) -> gpui_kit::AnyElement {
    let tokens = row.tokens;
    let badge = div()
        .id(("thread-jump-hint", row.row_key))
        .flex()
        .items_center()
        .justify_center()
        .flex_shrink_0()
        .h(px(20.0))
        .min_w(px(20.0))
        .px(px(4.0))
        .rounded(px(4.0))
        .bg(hsla_alpha(tokens.foreground, 0.07))
        .text_size(px(META_FONT_SIZE_PX))
        .line_height(px(META_LINE_HEIGHT_PX))
        .font_weight(gpui_kit::FontWeight::MEDIUM)
        .text_color(hsla(tokens.muted_foreground))
        .child(label.to_owned());
    #[cfg(test)]
    let badge = badge.test_support().a11y_group(
        SharedString::from(format!("test.sidebar.thread.{}.jump-hint", row.thread.id)),
        SharedString::from(label.to_owned()),
    );
    badge.into_any_element()
}

/// One result of the sidebar search (`SidebarSearchResultRow`).
struct SearchResultRow<'a> {
    row_key: usize,
    thread: &'a ThreadShell,
    project: Option<&'a ProjectShell>,
    /// On the Settled shelf: a quieter favicon and title.
    settled: bool,
    /// The thread is open (`isRouteActive`).
    open: bool,
    /// The arrow keys are on it, so `Enter` opens it (`isHighlighted`).
    highlighted: bool,
    now_secs: i64,
    hover_open: bool,
    hover_rect: &'a RowRectCell,
    environment_label: Option<&'a str>,
    /// The message that put the thread in the results, for a thread listed for its messages.
    excerpt: Option<&'a Excerpt>,
    /// The query `excerpt` was found for, which lags the box while a search runs.
    matched_query: &'a str,
    /// Where the row is painted, to scroll the highlighted result into view.
    bounds: std::rc::Rc<std::cell::Cell<Option<gpui_kit::Bounds<gpui_kit::Pixels>>>>,
    tokens: &'a Tokens,
}

/// The slim result row Conn lists while searching (`SidebarSearchResultRow`): `min-h-9
/// rounded-lg px-2.5 py-1 gap-2.5 text-sm`, a `size-4` favicon, the title (`font-medium`,
/// `font-normal` when settled), and the age (`w-8 text-right text-xs text-muted-foreground/55`).
/// The highlighted and open results wear the active row's fill. The row is a listbox option and
/// not a tab stop (`tabIndex={-1}`): a press keeps the keyboard in the search box, as `Enter` does
/// (`onPointerDown` `preventDefault`), and the pointer moves the highlight (`onMouseMove`).
fn render_search_result_row(
    row: &SearchResultRow<'_>,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::AnyElement {
    let tokens = row.tokens;
    let thread = row.thread;
    let fg = hsla(tokens.foreground);
    let sidebar_fg = hsla(tokens.sidebar_foreground);
    let secondary = hsla(tokens.sidebar_muted_foreground);
    let hover_bg = hsla(tokens.sidebar_row_hover);
    let active_bg = hsla(tokens.sidebar_row_active);
    let lit = row.highlighted || row.open;
    let quiet = row.settled && !lit;
    let group = SharedString::from(format!("sidebar-result-{}", row.row_key));
    let regenerating = thread
        .title_regeneration
        .as_ref()
        .is_some_and(Option::is_some);

    let favicon = row.project.map_or_else(
        || render_project_monogram("No project", ROW_FAVICON_PX, tokens),
        |p| render_project_favicon(p, ROW_FAVICON_PX, tokens),
    );
    // GPUI has no grayscale filter; `opacity-40` carries the muted look and hover restores it.
    let favicon_slot = div()
        .flex()
        .items_center()
        .flex_shrink_0()
        .when(quiet, |slot| {
            slot.opacity(0.4)
                .group_hover(group.clone(), |s| s.opacity(1.0))
        })
        .child(favicon);

    let title = div()
        .flex_1()
        .min_w_0()
        .truncate()
        .text_size(px(TITLE_FONT_SIZE_PX))
        .line_height(px(TITLE_LINE_HEIGHT_PX))
        .font_weight(if row.settled {
            gpui_kit::FontWeight::NORMAL
        } else {
            gpui_kit::FontWeight::MEDIUM
        })
        .text_color(if regenerating {
            hsla(tokens.muted_foreground)
        } else if quiet {
            hsla_alpha(tokens.sidebar_muted_foreground, 0.70)
        } else {
            fg
        })
        .when(quiet && !regenerating, |title| {
            title.group_hover(group.clone(), move |s| s.text_color(fg))
        })
        .child(thread.title.clone());

    let age = div()
        .w(px(32.0))
        .flex_shrink_0()
        .text_right()
        .text_size(px(META_FONT_SIZE_PX))
        .line_height(px(META_LINE_HEIGHT_PX))
        .text_color(hsla_alpha(tokens.muted_foreground, 0.55))
        .child(
            format_compact_relative_age_at(thread_time_timestamp(thread), row.now_secs)
                .unwrap_or_default(),
        );

    let thread_id = row.thread.id.clone();
    let hover_id = row.thread.id.clone();
    let highlight_id = row.thread.id.clone();
    let drop_id = row.thread.id.clone();
    let drop_look = DropLook::new(tokens, lit);
    let bounds = std::rc::Rc::clone(&row.bounds);
    let label = match row.project {
        Some(project) if !project.title.is_empty() => {
            format!("{}, {}", thread.title, project.title)
        }
        _ => thread.title.clone(),
    };
    let mut result = div()
        .id(("thread-search-result", row.row_key))
        .a11y(
            gpui_kit::Role::ListBoxOption,
            SharedString::from(format!("sidebar.search-result.{}", thread.id)),
            label,
        )
        .when(row.open, |el| el.aria_description("Open thread"))
        .aria_selected(row.highlighted)
        .group(group)
        .relative()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(10.0))
        .w_full()
        .min_h(px(SLIM_ROW_HEIGHT_PX))
        .px(px(ROW_HORIZONTAL_INSET_PX))
        .py(px(4.0))
        .rounded(px(ROW_RADIUS_PX))
        .cursor_pointer()
        .text_color(if lit { sidebar_fg } else { secondary })
        .on_mouse_move(cx.listener(move |app, _, _, cx| {
            app.highlight_search_result(&highlight_id, cx);
        }))
        .drag_over::<gpui_kit::ExternalPaths>(move |style, _, _, _| drop_look.apply(style))
        .on_drop(cx.listener(
            move |app, dropped: &gpui_kit::ExternalPaths, window, cx| {
                app.thread_files_dropped(&drop_id, dropped.paths().to_vec(), window, cx);
            },
        ))
        .on_hover(cx.listener(move |app, hovered: &bool, _, cx| {
            app.thread_hover_changed(&hover_id, *hovered, cx);
        }))
        // The keyboard stays in the search box: the root would take it on a press.
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|app, _, _, cx| {
                app.dismiss_thread_hover(cx);
                cx.stop_propagation();
            }),
        )
        .on_click(cx.listener(move |app, _, window, cx| {
            app.open_thread_row(&thread_id, window, cx);
        }))
        .child(favicon_slot)
        .child(
            div()
                .flex()
                .flex_col()
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(10.0))
                        .min_w_0()
                        .child(title)
                        .child(age),
                )
                .children(
                    row.excerpt
                        .map(|excerpt| render_excerpt(excerpt, row.matched_query, tokens)),
                ),
        )
        .child(
            canvas(
                move |painted, _, _| bounds.set(Some(painted)),
                |_, _, _, _| {},
            )
            .absolute()
            .size_full(),
        );
    result = if lit {
        result.bg(active_bg).hover(move |s| s.bg(active_bg))
    } else {
        result.hover(move |s| s.bg(hover_bg).text_color(sidebar_fg))
    };
    if row.hover_open {
        result = result.child(render_thread_hover_card(
            thread,
            row.project,
            row.environment_label,
            row.hover_rect,
            cx.entity().downgrade(),
            tokens,
        ));
    }
    div()
        .w_full()
        .child(result.test_support())
        .into_any_element()
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

/// Active thread ids in sidebar order: pinned (`pinOrderKey`) first, then active
/// (`activeOrderKey`).
#[must_use]
pub(crate) fn ordered_active_thread_ids(shell: &ShellState) -> Vec<String> {
    let (mut pinned, mut active): (Vec<&ThreadShell>, Vec<&ThreadShell>) = shell
        .top_level_active_threads()
        .partition(|t| t.pinned_at.as_ref().is_some_and(Option::is_some));
    sort_pinned(&mut pinned);
    sort_active(&mut active);
    pinned
        .into_iter()
        .chain(active)
        .map(|t| t.id.clone())
        .collect()
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

/// The threads the sidebar lists for `query`, each group in display order.
pub(crate) struct SidebarLists<'a> {
    pub(crate) pinned: Vec<&'a ThreadShell>,
    pub(crate) active: Vec<&'a ThreadShell>,
    /// Every settled thread the client holds, whether the shelf lists it or not, newest settle
    /// first.
    pub(crate) settled: Vec<&'a ThreadShell>,
    /// The settled threads the shelf may list: those at or above its frontier.
    pub(crate) listed_settled: Vec<&'a ThreadShell>,
    /// Threads listed only because a message matches the search, in the order it ranked them.
    pub(crate) messages: Vec<&'a ThreadShell>,
}

/// A drop the server has not caught up with, and the thread as the drop leaves it.
pub(crate) type PendingDropRef<'a> = Option<(&'a OptimisticDrop, &'a ThreadShell)>;

/// The pinned, active and settled threads of the open scope that match `query` (every thread
/// for an empty one), with a drop in flight held where it landed (`partitionSidebarThreads`).
/// One place decides it, for the list, the search results and traversal.
#[must_use]
pub(crate) fn sidebar_lists<'a>(
    shell: &'a ShellState,
    workspaces: &[OrbitWorkspace],
    active_workspace: Option<&str>,
    query: &str,
    message_order: &[String],
    pending: PendingDropRef<'a>,
) -> SidebarLists<'a> {
    let in_scope = |thread: &&ThreadShell| {
        project_in_scope(shell, workspaces, active_workspace, &thread.project_id)
    };
    let title_match = |thread: &&ThreadShell| {
        thread_matches_search(thread, shell.project(&thread.project_id), query)
    };
    let held_out = pending.map(|(drop, _)| drop.id.as_str());
    let kept = |thread: &&ThreadShell| Some(thread.id.as_str()) != held_out;
    let (mut pinned, mut active): (Vec<&ThreadShell>, Vec<&ThreadShell>) = shell
        .top_level_active_threads()
        .filter(kept)
        .partition(|t| t.pinned_at.as_ref().is_some_and(Option::is_some));
    let mut settled: Vec<&ThreadShell> = shell
        .all_settled_threads()
        .into_iter()
        .filter(kept)
        .collect();
    let mut listed_settled: Vec<&ThreadShell> = shell
        .top_level_settled_threads()
        .into_iter()
        .filter(kept)
        .collect();
    if let Some((drop, thread)) = pending {
        match drop.section {
            Section::Pinned => pinned.push(thread),
            Section::Active => active.push(thread),
            // It settles now, so it is the newest.
            Section::Settled => {
                settled.insert(0, thread);
                listed_settled.insert(0, thread);
            }
        }
    }
    sort_pinned(&mut pinned);
    sort_active(&mut active);
    if let Some((drop, _)) = pending
        && let Some(order) = &drop.order
    {
        let list = match drop.section {
            Section::Pinned => Some(&mut pinned),
            Section::Active => Some(&mut active),
            Section::Settled => None,
        };
        if let Some(list) = list {
            let ids: Vec<String> = list.iter().map(|t| t.id.clone()).collect();
            let by_id: HashMap<&str, &ThreadShell> =
                list.iter().map(|t| (t.id.as_str(), *t)).collect();
            let ordered: Vec<&ThreadShell> = order_by_preferred(&ids, order)
                .iter()
                .filter_map(|id| by_id.get(id.as_str()).copied())
                .collect();
            *list = ordered;
        }
    }
    let scoped = |list: &mut Vec<&ThreadShell>| list.retain(|t| in_scope(t) && title_match(t));
    scoped(&mut pinned);
    scoped(&mut active);
    scoped(&mut settled);
    scoped(&mut listed_settled);
    // Threads a message matches, past those the title already lists.
    let messages = if message_order.is_empty() {
        Vec::new()
    } else {
        let listed: HashSet<&str> = pinned
            .iter()
            .chain(&active)
            .chain(&settled)
            .map(|t| t.id.as_str())
            .collect();
        let candidates: HashMap<&str, &ThreadShell> = shell
            .top_level_active_threads()
            .chain(shell.all_settled_threads())
            .filter(|t| in_scope(t))
            .map(|t| (t.id.as_str(), t))
            .collect();
        message_order
            .iter()
            .filter(|id| !listed.contains(id.as_str()))
            .filter_map(|id| candidates.get(id.as_str()).copied())
            .collect()
    };
    SidebarLists {
        pinned,
        active,
        settled,
        listed_settled,
        messages,
    }
}

/// The Settled shelf as drawn for `lists`: its rows, the count in its header and what is left to
/// show (`visibleSettledThreads`, `sidebarSettledCount`).
#[must_use]
pub(crate) fn shelf_of(
    lists: &SidebarLists<'_>,
    shell: &ShellState,
    workspaces: &[OrbitWorkspace],
    active_workspace: Option<&str>,
    open: Option<&str>,
    expanded: bool,
    visible_count: usize,
) -> ShelfView {
    let ids = |threads: &[&ThreadShell]| -> Vec<String> {
        threads.iter().map(|t| t.id.clone()).collect()
    };
    let scope: Option<HashSet<String>> = active_workspace.map(|_| {
        shell
            .projects
            .iter()
            .filter(|p| project_in_scope(shell, workspaces, active_workspace, &p.id))
            .map(|p| p.id.clone())
            .collect()
    });
    shelf_view(&ShelfInput {
        listed: &ids(&lists.listed_settled),
        held: &ids(&lists.settled),
        unloaded: shell.unloaded_older_settled(scope.as_ref()),
        open,
        expanded,
        visible_count,
    })
}

/// [`shelf_of`] for the lists the scope holds with no search.
#[must_use]
pub(crate) fn settled_shelf(
    shell: &ShellState,
    workspaces: &[OrbitWorkspace],
    active_workspace: Option<&str>,
    pending: PendingDropRef<'_>,
    open: Option<&str>,
    expanded: bool,
    visible_count: usize,
) -> ShelfView {
    let lists = sidebar_lists(shell, workspaces, active_workspace, "", &[], pending);
    shelf_of(
        &lists,
        shell,
        workspaces,
        active_workspace,
        open,
        expanded,
        visible_count,
    )
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
    fn a_subagents_request_counts_as_the_threads_own_and_the_stronger_one_wins() {
        use conn_contract::OrchestrationV2PendingRuntimeRequestSummary as Request;
        use conn_contract::OrchestrationV2PendingRuntimeRequestSummaryKind as Kind;
        let shell = crate::fixture::demo_shell_state();
        let mut thread = shell
            .find_thread("thread-sqlite-wal")
            .expect("fixture thread")
            .clone();
        thread.pending_runtime_request = None;
        assert_eq!(
            resolve_listed_row_status(&thread, Some(PendingSubagentRequest::Approval)),
            Some(RowStatus::Approval)
        );
        assert_eq!(
            resolve_listed_row_status(&thread, Some(PendingSubagentRequest::UserInput)),
            Some(RowStatus::Input)
        );
        // Its own approval is stronger than a question one of its subagents asks.
        thread.pending_runtime_request = Some(Request {
            id: "req".to_owned(),
            kind: Kind::Permission,
            created_at: "2026-11-21T00:54:00.000Z".to_owned(),
            blocking: Some(true),
            user_only: None,
        });
        assert_eq!(
            resolve_listed_row_status(&thread, Some(PendingSubagentRequest::UserInput)),
            Some(RowStatus::Approval)
        );
    }

    #[test]
    fn a_drop_in_flight_holds_the_thread_where_it_landed_in_every_list() {
        let shell = crate::fixture::demo_shell_state();
        let held = shell
            .top_level_active_threads()
            .next()
            .expect("an active thread")
            .clone();
        let plain = sidebar_lists(&shell, &[], None, "", &[], None);
        assert!(plain.active.iter().any(|t| t.id == held.id));

        let mut settled = held.clone();
        sidebar_drag::apply_drop(
            &mut settled,
            Section::Settled,
            "2026-11-23T10:00:00.000Z",
            None,
        );
        let drop = OptimisticDrop::new(
            &sidebar_drag::DropPlan::Settle,
            &held.id,
            Section::Active,
            Section::Settled,
            "2026-11-23T10:00:00.000Z",
            &HashMap::new(),
            &HashMap::new(),
        )
        .expect("a settle is a drop");
        let lists = sidebar_lists(&shell, &[], None, "", &[], Some((&drop, &settled)));
        assert!(!lists.active.iter().any(|t| t.id == held.id));
        assert_eq!(
            lists.settled.first().map(|t| t.id.as_str()),
            Some(held.id.as_str()),
            "it is the newest settled thread"
        );
        assert_eq!(
            lists.listed_settled.first().map(|t| t.id.as_str()),
            Some(held.id.as_str())
        );
        let shelf = shelf_of(&lists, &shell, &[], None, None, true, 10);
        assert_eq!(shelf.rows.first(), Some(&held.id));
    }

    #[test]
    fn threads_a_message_matches_follow_the_title_matches_and_leave_out_those_already_listed() {
        let shell = crate::fixture::demo_shell_state();
        let mut threads = shell.top_level_active_threads();
        let by_title = threads.next().expect("a thread").clone();
        let by_message = threads.next().expect("another thread").clone();
        let order = vec![by_message.id.clone(), by_title.id.clone()];
        let lists = sidebar_lists(&shell, &[], None, &by_title.title, &order, None);
        assert!(lists.active.iter().any(|t| t.id == by_title.id));
        assert_eq!(
            lists
                .messages
                .iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>(),
            [by_message.id.as_str()],
            "the title match is not listed twice, and the message match follows"
        );
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
