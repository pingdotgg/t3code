//! Thread Actions menu shared by sidebar row right-click and the chat header title
//! (`threadActionMenu.logic.ts` `buildThreadActionMenuItems`, `Sidebar.tsx`
//! `handleThreadContextMenu`, `useThreadActionMenu.ts`).
//!
//! Conn shows this as a native context menu. GPUI draws it as an anchored `dropdown-glass`
//! popup at the pointer with the same items, order, labels, separators, and `Copy` submenu.
//! Out of scope per `docs/scope.md`: `Snooze` / `Wake`, `Share with guest`, `Archive thread`.

use conn_state::{ShellState, ThreadShell};
use conn_theme::Tokens;
use gpui_kit::{
    AnyElement, Context, FocusHandle, InteractiveElement as _, IntoElement as _, MouseButton,
    ParentElement as _, Pixels, Point, SharedString, StatefulInteractiveElement as _, Styled as _,
    TestSupportExt as _, anchored, deferred, div, px,
};

use crate::a11y::ConnA11yExt as _;
use crate::app::ConnApp;
use crate::icons;
use crate::panels::header::dropdown_glass_shadow;
use crate::theme::{hsla, hsla_alpha};

/// `menu.tsx` popup geometry (`rounded-xl`, `p-1`, `min-w-[10rem]`), rows
/// `min-h-7 rounded-lg px-2 py-1 gap-2 text-sm`.
pub(super) const MENU_RADIUS_PX: f32 = 12.0;
pub(super) const MENU_ROW_RADIUS_PX: f32 = 8.0;
pub(super) const MENU_ROW_HEIGHT_PX: f32 = 28.0;
const MENU_MIN_WIDTH_PX: f32 = 180.0;
pub(super) const MENU_FONT_PX: f32 = 14.0;
pub(super) const MENU_LINE_PX: f32 = 20.0;
pub(super) const MENU_ICON_PX: f32 = 16.0;
/// Row icons draw at 80% opacity; disabled rows at 64%.
pub(super) const MENU_ICON_OPACITY: f32 = 0.8;
const MENU_DISABLED_OPACITY: f32 = 0.64;

/// One thread action (`ThreadActionMenuId`), limited to what `conn-gpui` ships.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum ThreadMenuAction {
    Pin,
    Unpin,
    Settle,
    Unsettle,
    Rename,
    RegenerateTitle,
    MarkUnread,
    FilterByProject,
    Copy,
    CopyPath,
    CopyBranch,
    CopyThread,
    CopyThreadId,
    ProjectSettings,
    Delete,
    /// `Discard draft` on a new-thread draft row.
    DiscardDraft,
}

impl ThreadMenuAction {
    /// Stable AccessKit identifier for automation and headless GPUI tests.
    #[must_use]
    pub(crate) fn ax_id(self) -> &'static str {
        match self {
            Self::Pin => "thread-menu.pin",
            Self::Unpin => "thread-menu.unpin",
            Self::Settle => "thread-menu.settle",
            Self::Unsettle => "thread-menu.unsettle",
            Self::Rename => "thread-menu.rename",
            Self::RegenerateTitle => "thread-menu.regenerate-title",
            Self::MarkUnread => "thread-menu.mark-unread",
            Self::FilterByProject => "thread-menu.filter-project",
            Self::Copy => "thread-menu.copy",
            Self::CopyPath => "thread-menu.copy.path",
            Self::CopyBranch => "thread-menu.copy.branch",
            Self::CopyThread => "thread-menu.copy.thread",
            Self::CopyThreadId => "thread-menu.copy.thread-id",
            Self::ProjectSettings => "thread-menu.project-settings",
            Self::Delete => "thread-menu.delete",
            Self::DiscardDraft => "thread-menu.discard-draft",
        }
    }
}

/// One menu row (`ContextMenuItem<ThreadActionMenuId>`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ThreadMenuItem {
    pub(crate) action: ThreadMenuAction,
    pub(crate) label: String,
    /// Superheroicons concept path (Lucide name mapped through the Conn manifest).
    pub(crate) icon: &'static str,
    pub(crate) disabled: bool,
    pub(crate) destructive: bool,
    pub(crate) separator_before: bool,
    pub(crate) children: Vec<ThreadMenuItem>,
}

impl ThreadMenuItem {
    fn new(action: ThreadMenuAction, label: impl Into<String>, icon: &'static str) -> Self {
        Self {
            action,
            label: label.into(),
            icon,
            disabled: false,
            destructive: false,
            separator_before: false,
            children: Vec::new(),
        }
    }

    fn separated(mut self) -> Self {
        self.separator_before = true;
        self
    }
}

/// Project scope entry for `Filter by <project>` / `Show all projects`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProjectFilterState {
    pub(crate) label: String,
    pub(crate) is_active: bool,
}

/// Inputs to [`build_thread_action_menu_items`] (`ThreadActionMenuState`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ThreadMenuState {
    pub(crate) branch: Option<String>,
    pub(crate) project_filter: Option<ProjectFilterState>,
    pub(crate) is_pinned: bool,
    pub(crate) is_settled: bool,
    pub(crate) is_regenerating_title: bool,
}

impl ThreadMenuState {
    /// Derives the menu state for `thread` from the shell and the active project scope.
    #[must_use]
    pub(crate) fn for_thread(
        shell: &ShellState,
        thread: &ThreadShell,
        active_scope: Option<&str>,
    ) -> Self {
        let project_filter = shell
            .project(&thread.project_id)
            .filter(|p| p.archived_at.as_ref().is_none_or(Option::is_none))
            .map(|p| ProjectFilterState {
                label: p.title.clone(),
                is_active: active_scope == Some(p.id.as_str()),
            });
        Self {
            branch: thread.branch.clone().filter(|b| !b.is_empty()),
            project_filter,
            is_pinned: thread.pinned_at.as_ref().is_some_and(Option::is_some),
            is_settled: ShellState::is_settled(thread),
            is_regenerating_title: thread
                .title_regeneration
                .as_ref()
                .is_some_and(Option::is_some),
        }
    }
}

/// Port of `buildThreadActionMenuItems` for the in-scope actions.
#[must_use]
pub(crate) fn build_thread_action_menu_items(state: &ThreadMenuState) -> Vec<ThreadMenuItem> {
    use ThreadMenuAction as A;
    let mut items = Vec::with_capacity(12);
    items.push(if state.is_pinned {
        ThreadMenuItem::new(A::Unpin, "Unpin thread", "superhero/unpin.svg")
    } else {
        ThreadMenuItem::new(A::Pin, "Pin thread", "superhero/pin.svg")
    });
    items.push(if state.is_settled {
        ThreadMenuItem::new(
            A::Unsettle,
            "Un-settle thread",
            "superhero/check-circle.svg",
        )
    } else {
        ThreadMenuItem::new(A::Settle, "Settle thread", "superhero/check-circle.svg")
    });
    items.push(ThreadMenuItem::new(A::Rename, "Rename thread", "superhero/edit.svg").separated());
    let mut regenerate = ThreadMenuItem::new(
        A::RegenerateTitle,
        if state.is_regenerating_title {
            "Regenerating…"
        } else {
            "Regenerate title"
        },
        "superhero/refresh.svg",
    );
    regenerate.disabled = state.is_regenerating_title;
    items.push(regenerate);
    items.push(ThreadMenuItem::new(
        A::MarkUnread,
        "Mark unread",
        "superhero/mail-open.svg",
    ));
    if let Some(filter) = &state.project_filter {
        items.push(ThreadMenuItem::new(
            A::FilterByProject,
            if filter.is_active {
                "Show all projects".to_owned()
            } else {
                format!("Filter by {}", filter.label)
            },
            "superhero/file-tree.svg",
        ));
    }
    let mut copy = ThreadMenuItem::new(A::Copy, "Copy", "superhero/copy.svg").separated();
    copy.children.push(ThreadMenuItem::new(
        A::CopyPath,
        "Path",
        "superhero/folder.svg",
    ));
    if state.branch.is_some() {
        copy.children.push(ThreadMenuItem::new(
            A::CopyBranch,
            "Branch",
            "superhero/branch.svg",
        ));
    }
    copy.children.push(ThreadMenuItem::new(
        A::CopyThread,
        "Thread",
        "superhero/thread.svg",
    ));
    copy.children.push(ThreadMenuItem::new(
        A::CopyThreadId,
        "Thread ID",
        "superhero/hash.svg",
    ));
    items.push(copy);
    items.push(ThreadMenuItem::new(
        A::ProjectSettings,
        "Project settings",
        "superhero/settings.svg",
    ));
    let mut delete = ThreadMenuItem::new(A::Delete, "Delete", "superhero/delete.svg").separated();
    delete.destructive = true;
    items.push(delete);
    items
}

/// The menu of the threads picked for a bulk action (`handleMultiSelectContextMenu`): the rows of
/// `conn_state::bulk_menu`, each running the thread action of the same name on every picked thread.
#[must_use]
pub(crate) fn build_bulk_menu_items(facts: conn_state::BulkFacts) -> Vec<ThreadMenuItem> {
    use ThreadMenuAction as A;
    use conn_state::BulkAction;
    conn_state::bulk_menu(facts)
        .into_iter()
        .map(|entry| {
            let (action, icon) = match entry.action {
                BulkAction::Unpin => (A::Unpin, "superhero/unpin.svg"),
                BulkAction::Settle => (A::Settle, "superhero/check-circle.svg"),
                BulkAction::RegenerateTitles => (A::RegenerateTitle, "superhero/refresh.svg"),
                BulkAction::MarkUnread => (A::MarkUnread, "superhero/mail-open.svg"),
                BulkAction::Delete => (A::Delete, "superhero/delete.svg"),
            };
            let mut item = ThreadMenuItem::new(action, entry.label, icon);
            item.disabled = entry.disabled;
            item.destructive = entry.destructive;
            item
        })
        .collect()
}

/// What a sidebar draft row's menu offers (`buildDraftActionMenuItems`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct DraftMenuState {
    /// The draft has a workspace path to copy.
    pub(crate) has_path: bool,
    pub(crate) has_branch: bool,
    /// The draft's project exists, so its settings can open.
    pub(crate) has_project: bool,
}

/// Port of `buildDraftActionMenuItems`: `Copy` (path, branch), `Project settings`, then a
/// destructive `Discard draft`.
#[must_use]
pub(crate) fn build_draft_action_menu_items(state: DraftMenuState) -> Vec<ThreadMenuItem> {
    use ThreadMenuAction as A;
    let mut copy = ThreadMenuItem::new(A::Copy, "Copy", "superhero/copy.svg");
    copy.disabled = !state.has_path && !state.has_branch;
    if state.has_path {
        copy.children.push(ThreadMenuItem::new(
            A::CopyPath,
            "Path",
            "superhero/folder.svg",
        ));
    }
    if state.has_branch {
        copy.children.push(ThreadMenuItem::new(
            A::CopyBranch,
            "Branch",
            "superhero/branch.svg",
        ));
    }
    let mut items = vec![copy];
    if state.has_project {
        items.push(ThreadMenuItem::new(
            A::ProjectSettings,
            "Project settings",
            "superhero/settings.svg",
        ));
    }
    let mut discard =
        ThreadMenuItem::new(A::DiscardDraft, "Discard draft", "superhero/delete.svg").separated();
    discard.destructive = true;
    items.push(discard);
    items
}

/// Where the keyboard is in an open menu: the highlighted row of each level. The pointer moves it
/// too (Conn focuses the row under the pointer), so there is one highlight.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct MenuCursor {
    /// The highlighted row of the menu; none while it has only just opened with the pointer.
    pub(crate) root: Option<usize>,
    /// The highlighted row of the open submenu.
    pub(crate) sub: Option<usize>,
    /// The keyboard is in the submenu.
    pub(crate) in_sub: bool,
}

/// Where the open Thread Actions menu sits and which thread it acts on.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ThreadMenuAnchor {
    /// The thread id, or the draft id for a draft row's menu.
    pub(crate) thread_id: String,
    /// The menu belongs to a new-thread draft row ([`build_draft_action_menu_items`]).
    pub(crate) draft: bool,
    /// The menu acts on every thread picked for a bulk action ([`build_bulk_menu_items`]).
    pub(crate) bulk: bool,
    /// Window-space pointer position of the right-click (or the header chevron click).
    pub(crate) position: Point<Pixels>,
    /// Whether the `Copy` submenu is open.
    pub(crate) copy_open: bool,
    /// The highlighted rows.
    pub(crate) cursor: MenuCursor,
}

/// Submenu close grace period when the pointer moves onto a sibling top-level row
/// so diagonal motion from `Copy` toward lower submenu rows does not close it early.
pub(crate) const SUBMENU_CLOSE_DELAY: std::time::Duration = std::time::Duration::from_millis(150);

/// Whether a rendered menu list is the root context menu or a nested submenu.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MenuLevel {
    Root,
    Submenu,
}

/// How hovering a row should affect the open `Copy` submenu.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SubmenuHoverIntent {
    /// Open the submenu immediately and cancel any pending close.
    Open,
    /// Keep the submenu open and cancel any pending close (pointer is inside the submenu).
    KeepOpen,
    /// Schedule closing the submenu after [`SUBMENU_CLOSE_DELAY`] unless the pointer reaches it.
    CloseSoon,
}

#[must_use]
fn submenu_hover_intent(level: MenuLevel, has_children: bool) -> SubmenuHoverIntent {
    match (level, has_children) {
        (MenuLevel::Submenu, _) => SubmenuHoverIntent::KeepOpen,
        (MenuLevel::Root, true) => SubmenuHoverIntent::Open,
        (MenuLevel::Root, false) => SubmenuHoverIntent::CloseSoon,
    }
}

/// Opens the submenu to the left of the parent menu when opening to the right would clip
/// past the window's right edge.
#[must_use]
fn submenu_opens_left(anchor_x: Pixels, viewport_w: Pixels) -> bool {
    anchor_x + px(MENU_MIN_WIDTH_PX * 2.0 + 16.0) > viewport_w
}

/// Aligns the submenu's bottom edge to the `Copy` row when opening downward would clip
/// past the bottom of the window.
#[must_use]
fn submenu_opens_upward(anchor_y: Pixels, item_count: usize, viewport_h: Pixels) -> bool {
    let submenu_h = item_count as f32 * MENU_ROW_HEIGHT_PX + 16.0;
    anchor_y + px(submenu_h) > viewport_h
}

/// Renders the anchored `dropdown-glass` Thread Actions menu.
#[must_use]
pub(crate) fn render_thread_action_menu(
    items: &[ThreadMenuItem],
    anchor: &ThreadMenuAnchor,
    viewport: gpui_kit::Size<Pixels>,
    focus: &FocusHandle,
    tokens: &Tokens,
    cx: &mut Context<'_, ConnApp>,
) -> AnyElement {
    let list = render_menu_list(
        "thread-menu",
        items,
        anchor,
        MenuLevel::Root,
        viewport,
        Some(focus),
        tokens,
        cx,
    );
    deferred(
        anchored()
            .position(anchor.position)
            .snap_to_window_with_margin(px(8.0))
            .child(list),
    )
    .with_priority(6)
    .into_any_element()
}

pub(super) fn menu_surface(id: SharedString, tokens: &Tokens) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .occlude()
        .flex()
        .flex_col()
        .min_w(px(MENU_MIN_WIDTH_PX))
        .p(px(4.0))
        .rounded(px(MENU_RADIUS_PX))
        .bg(hsla(tokens.popover))
        .border_1()
        .border_color(hsla(tokens.foreground.with_alpha(0.08)))
        .shadow(vec![dropdown_glass_shadow(tokens)])
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
}

#[expect(
    clippy::too_many_arguments,
    reason = "renders one menu level from the anchor, viewport, focus and theme"
)]
fn render_menu_list(
    id_prefix: &'static str,
    items: &[ThreadMenuItem],
    anchor: &ThreadMenuAnchor,
    level: MenuLevel,
    viewport: gpui_kit::Size<Pixels>,
    focus: Option<&FocusHandle>,
    tokens: &Tokens,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let fg = hsla(tokens.popover_foreground);
    let destructive = hsla(tokens.destructive);
    let muted = hsla(tokens.muted_foreground);
    let highlight = hsla(tokens.shell_highlight);
    let separator = hsla_alpha(tokens.foreground, 0.08);
    let (menu_ax_id, menu_ax_label) = match level {
        MenuLevel::Root if anchor.draft => ("thread-menu", "Draft actions"),
        MenuLevel::Root => ("thread-menu", "Thread actions"),
        MenuLevel::Submenu => ("thread-menu.copy.submenu", "Copy"),
    };
    let mut list = menu_surface(SharedString::from(id_prefix), tokens).a11y(
        gpui_kit::Role::Menu,
        menu_ax_id,
        menu_ax_label,
    );
    // The menu takes the keyboard; its keys come from the app (`intercept_keystroke`).
    if let Some(focus) = focus {
        list = list.track_focus(focus);
    }
    let highlighted_row = match level {
        MenuLevel::Root => anchor.cursor.root,
        MenuLevel::Submenu => anchor.cursor.sub.filter(|_| anchor.cursor.in_sub),
    };

    for (idx, item) in items.iter().enumerate() {
        if item.separator_before && idx > 0 {
            list = list.child(div().mx(px(-4.0)).my(px(4.0)).h(px(1.0)).bg(separator));
        }
        let text_color = if item.destructive { destructive } else { fg };
        let icon_color = if item.destructive {
            destructive
        } else {
            muted.opacity(MENU_ICON_OPACITY)
        };
        let has_children = !item.children.is_empty();
        let hover_intent = submenu_hover_intent(level, has_children);
        let highlighted = highlighted_row == Some(idx) && !item.disabled;
        let action = item.action;
        let thread_id = anchor.thread_id.clone();
        let is_draft = anchor.draft;
        let mut row = div()
            .id(SharedString::from(format!("{id_prefix}-{idx}")))
            .test_support()
            .a11y(gpui_kit::Role::MenuItem, action.ax_id(), item.label.clone())
            .aria_selected(highlighted)
            .relative()
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
            .text_color(text_color)
            .child(icons::concept(item.icon, MENU_ICON_PX, icon_color))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .child(item.label.clone()),
            );

        if has_children {
            row = row.child(icons::concept(
                "superhero/chevron-right.svg",
                MENU_ICON_PX,
                fg.opacity(MENU_ICON_OPACITY),
            ));
        }

        if has_children {
            row = row.aria_expanded(anchor.copy_open);
        }
        if item.disabled {
            row = row.opacity(MENU_DISABLED_OPACITY);
        } else {
            if highlighted {
                row = row.bg(highlight);
            }
            row = row
                .cursor_pointer()
                .on_hover(cx.listener(move |app, hovered: &bool, _, cx| {
                    if *hovered {
                        app.highlight_thread_menu_row(level == MenuLevel::Submenu, idx, cx);
                        match hover_intent {
                            SubmenuHoverIntent::Open => app.open_thread_menu_copy_submenu(cx),
                            SubmenuHoverIntent::KeepOpen => app.keep_thread_menu_copy_open(cx),
                            SubmenuHoverIntent::CloseSoon => {
                                app.schedule_thread_menu_copy_close(cx);
                            }
                        }
                    }
                }))
                .on_click(cx.listener(move |app, _, window, cx| {
                    cx.stop_propagation();
                    if has_children {
                        app.open_thread_menu_copy_submenu(cx);
                    } else if is_draft {
                        app.run_draft_menu_action(thread_id.clone(), action, window, cx);
                    } else {
                        app.run_thread_menu_action(thread_id.clone(), action, window, cx);
                    }
                }));
        }

        if has_children && anchor.copy_open {
            row = row.bg(highlight);
            let submenu = render_menu_list(
                "thread-menu-copy",
                &item.children,
                anchor,
                MenuLevel::Submenu,
                viewport,
                None,
                tokens,
                cx,
            );
            let mut bridge = div()
                .id("thread-menu-copy-bridge")
                .occlude()
                .absolute()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
                .on_hover(cx.listener(|app, hovered: &bool, _, cx| {
                    if *hovered {
                        app.keep_thread_menu_copy_open(cx);
                    }
                }))
                .child(submenu);
            bridge =
                if submenu_opens_upward(anchor.position.y, item.children.len(), viewport.height) {
                    bridge.bottom(px(-4.0))
                } else {
                    bridge.top(px(-4.0))
                };
            bridge = if submenu_opens_left(anchor.position.x, viewport.width) {
                bridge.right_full().pr(px(6.0))
            } else {
                bridge.left_full().pl(px(6.0))
            };
            row = row.child(bridge);
        }
        list = list.child(row);
    }
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(items: &[ThreadMenuItem]) -> Vec<&str> {
        items.iter().map(|i| i.label.as_str()).collect()
    }

    #[test]
    fn default_menu_matches_conn_order() {
        let state = ThreadMenuState {
            branch: Some("feat/x".to_owned()),
            project_filter: Some(ProjectFilterState {
                label: "conn".to_owned(),
                is_active: false,
            }),
            ..ThreadMenuState::default()
        };
        let items = build_thread_action_menu_items(&state);
        assert_eq!(
            labels(&items),
            vec![
                "Pin thread",
                "Settle thread",
                "Rename thread",
                "Regenerate title",
                "Mark unread",
                "Filter by conn",
                "Copy",
                "Project settings",
                "Delete",
            ]
        );
        let copy = items
            .iter()
            .find(|i| i.action == ThreadMenuAction::Copy)
            .expect("copy submenu");
        assert_eq!(
            labels(&copy.children),
            vec!["Path", "Branch", "Thread", "Thread ID"]
        );
        let separated: Vec<&str> = items
            .iter()
            .filter(|i| i.separator_before)
            .map(|i| i.label.as_str())
            .collect();
        assert_eq!(separated, vec!["Rename thread", "Copy", "Delete"]);
        assert!(items.last().is_some_and(|i| i.destructive));
    }

    #[test]
    fn menu_flips_pinned_settled_regenerating_and_filter_states() {
        let state = ThreadMenuState {
            branch: None,
            project_filter: Some(ProjectFilterState {
                label: "conn".to_owned(),
                is_active: true,
            }),
            is_pinned: true,
            is_settled: true,
            is_regenerating_title: true,
        };
        let items = build_thread_action_menu_items(&state);
        let names = labels(&items);
        assert!(names.contains(&"Unpin thread"));
        assert!(names.contains(&"Un-settle thread"));
        assert!(names.contains(&"Show all projects"));
        let regen = items
            .iter()
            .find(|i| i.action == ThreadMenuAction::RegenerateTitle)
            .expect("regenerate row");
        assert_eq!(regen.label, "Regenerating…");
        assert!(regen.disabled);
        let copy = items
            .iter()
            .find(|i| i.action == ThreadMenuAction::Copy)
            .expect("copy submenu");
        assert_eq!(labels(&copy.children), vec!["Path", "Thread", "Thread ID"]);
    }

    #[test]
    fn draft_menu_matches_conn_order_and_hides_what_the_draft_lacks() {
        let full = build_draft_action_menu_items(DraftMenuState {
            has_path: true,
            has_branch: true,
            has_project: true,
        });
        assert_eq!(
            labels(&full),
            vec!["Copy", "Project settings", "Discard draft"]
        );
        assert_eq!(labels(&full[0].children), vec!["Path", "Branch"]);
        assert!(!full[0].disabled);
        let discard = full.last().expect("discard row");
        assert!(discard.destructive && discard.separator_before);
        assert_eq!(discard.action, ThreadMenuAction::DiscardDraft);

        let bare = build_draft_action_menu_items(DraftMenuState::default());
        assert_eq!(labels(&bare), vec!["Copy", "Discard draft"]);
        assert!(bare[0].disabled && bare[0].children.is_empty());
    }

    #[test]
    fn menu_icons_exist_in_embedded_assets() {
        use gpui_kit::AssetSource as _;
        let assets = crate::superhero::AppAssets;
        let state = ThreadMenuState {
            branch: Some("b".to_owned()),
            project_filter: Some(ProjectFilterState {
                label: "p".to_owned(),
                is_active: false,
            }),
            ..ThreadMenuState::default()
        };
        let mut paths = vec!["superhero/unpin.svg", "superhero/chevron-right.svg"];
        for item in build_thread_action_menu_items(&state) {
            paths.push(item.icon);
            paths.extend(item.children.iter().map(|c| c.icon));
        }
        for path in paths {
            assert!(
                assets.load(path).ok().flatten().is_some(),
                "menu icon `{path}` must exist"
            );
        }
    }

    #[test]
    fn hovering_submenu_item_keeps_submenu_open_and_never_closes_it() {
        assert_eq!(
            submenu_hover_intent(MenuLevel::Root, true),
            SubmenuHoverIntent::Open,
            "hovering parent Copy row opens submenu immediately"
        );
        assert_eq!(
            submenu_hover_intent(MenuLevel::Submenu, false),
            SubmenuHoverIntent::KeepOpen,
            "hovering any child row inside the submenu must keep the submenu open"
        );
        assert_eq!(
            submenu_hover_intent(MenuLevel::Submenu, true),
            SubmenuHoverIntent::KeepOpen,
            "nested submenu row also keeps submenu open"
        );
        assert_eq!(
            submenu_hover_intent(MenuLevel::Root, false),
            SubmenuHoverIntent::CloseSoon,
            "hovering a non-submenu sibling schedules a delayed close"
        );
    }

    #[test]
    fn submenu_flips_left_only_near_right_window_edge() {
        assert!(
            !submenu_opens_left(px(180.0), px(1200.0)),
            "sidebar context menu opens submenu to the right"
        );
        assert!(
            submenu_opens_left(px(950.0), px(1200.0)),
            "right-edge context menu flips submenu to the left to stay inside viewport"
        );
        assert!(
            !submenu_opens_upward(px(200.0), 4, px(800.0)),
            "mid-window context menu opens submenu downward"
        );
        assert!(
            submenu_opens_upward(px(740.0), 4, px(800.0)),
            "bottom-edge context menu aligns submenu upward to stay inside viewport"
        );
    }
}
