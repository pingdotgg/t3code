//! Context strip workspace selector and searchable branch picker
//! (`BranchToolbarEnvModeSelector.tsx`, `BranchToolbarBranchSelector.tsx`, `BranchPicker.tsx`).
//! Ref logic lives in `chat/composer_state.rs`; mutations go to the app as [`BranchAction`]s.

use conn_contract::rpc::vcs::list_refs;
use conn_contract::{VcsListRefsInput, VcsRef};
use conn_theme::Tokens;
use gpui_kit::component::input::{Escape, Input, InputEvent, InputState, MoveDown, MoveUp};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, FontWeight, InteractiveElement as _,
    IntoElement as _, MouseButton, ParentElement as _, StatefulInteractiveElement as _,
    Styled as _, Subscription, Window, deferred, div, px,
};

use super::super::color::hsla;
use super::super::composer_state::{
    BranchPickerRow, PreviousWorktree, RefEntry, branch_picker_rows, branch_trigger_label,
    ref_badge, sanitize_new_ref_name,
};
use super::super::icons;
use super::{Composer, ComposerEvent};
use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome::ConnTooltipExt as _;

/// Refs requested per `vcs.listRefs` page.
const REF_PAGE_SIZE: i64 = 100;
/// Popup width (`w-80`).
const PICKER_WIDTH_PX: f32 = 320.0;
/// Ref list max height (`max-h-56`).
const LIST_MAX_HEIGHT_PX: f32 = 224.0;
const START_FROM_REMOTE_TOOLTIP: &str = "Uses the latest commit of the base branch’s tracked remote branch, even if its name differs. Otherwise uses the same-named branch on origin. Uses your local branch if that remote branch is missing.";

/// Branch and workspace changes the app carries out (`vcs.switchRef`, `vcs.createRef`,
/// `thread.metadata.update`, or the draft's launch settings).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BranchAction {
    SelectRef(RefEntry),
    CreateRef(String),
    StartFromOrigin(bool),
    UsePreviousWorktree(PreviousWorktree),
    /// `Current checkout` (`false`) or `New worktree` (`true`) on a draft.
    WorkspaceMode(bool),
}

/// Workspace facts for the strip, pushed by the app on every sync.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct BranchContext {
    pub(crate) project_cwd: Option<String>,
    pub(crate) worktree_path: Option<String>,
    pub(crate) branch: Option<String>,
    pub(crate) start_from_origin: bool,
    pub(crate) previous_worktree: Option<PreviousWorktree>,
    /// A turn runs, so the thread cannot move to another worktree.
    pub(crate) worktree_change_blocked: bool,
}

/// Picker state owned by the composer.
pub(super) struct BranchUi {
    pub(super) context: BranchContext,
    pub(super) picker_open: bool,
    pub(super) workspace_menu_open: bool,
    search: Entity<InputState>,
    refs: Vec<RefEntry>,
    total: i64,
    next_cursor: Option<i64>,
    loading: bool,
    error: Option<String>,
    highlighted: usize,
    generation: u64,
    _search_sub: Subscription,
}

impl BranchUi {
    pub(super) fn new(window: &mut Window, cx: &mut Context<'_, Composer>) -> Self {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search refs..."));
        let sub = cx.subscribe_in(
            &search,
            window,
            |composer, _, event: &InputEvent, window, cx| match event {
                InputEvent::Change => {
                    composer.branch.highlighted = 0;
                    composer.load_refs(false, cx);
                }
                InputEvent::PressEnter { .. } => composer.pick_highlighted_branch_row(window, cx),
                _ => {}
            },
        );
        Self {
            context: BranchContext::default(),
            picker_open: false,
            workspace_menu_open: false,
            search,
            refs: Vec::new(),
            total: 0,
            next_cursor: None,
            loading: false,
            error: None,
            highlighted: 0,
            generation: 0,
            _search_sub: sub,
        }
    }

    fn branch_cwd(&self) -> Option<String> {
        self.context
            .worktree_path
            .clone()
            .or_else(|| self.context.project_cwd.clone())
    }
}

fn ref_entry(r: VcsRef) -> RefEntry {
    RefEntry {
        name: r.name,
        is_remote: r.is_remote == Some(true),
        current: r.current,
        is_default: r.is_default,
        worktree_path: r.worktree_path,
    }
}

impl Composer {
    /// Updates the workspace facts shown in the context strip.
    pub(crate) fn set_branch_context(
        &mut self,
        context: BranchContext,
        cx: &mut Context<'_, Self>,
    ) {
        if self.branch.context == context {
            return;
        }
        let cwd_changed = self.branch.context.worktree_path != context.worktree_path
            || self.branch.context.project_cwd != context.project_cwd;
        self.branch.context = context;
        if cwd_changed {
            self.branch.refs.clear();
            self.branch.next_cursor = None;
            self.branch.total = 0;
        }
        cx.notify();
    }

    /// A new worktree draft picks its base ref instead of switching the checkout.
    fn selecting_worktree_base(&self) -> bool {
        self.is_draft && self.worktree_active && self.branch.context.worktree_path.is_none()
    }

    /// `⌘⇧G` / trigger click: opens the picker and focuses `Search refs...`.
    pub(super) fn toggle_branch_picker(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.branch.picker_open {
            self.close_branch_popups(window, cx);
            return;
        }
        self.close_overlays(cx);
        self.branch.picker_open = true;
        self.branch.highlighted = 0;
        self.branch.search.update(cx, |input, cx| {
            input.set_value("", window, cx);
            input.focus(window, cx);
        });
        self.load_refs(false, cx);
        cx.notify();
    }

    /// `⌘⇧X` / trigger click: opens the workspace menu on drafts.
    pub(super) fn toggle_workspace_menu(&mut self, cx: &mut Context<'_, Self>) {
        if !self.is_draft {
            return;
        }
        let open = !self.branch.workspace_menu_open;
        self.close_overlays(cx);
        self.branch.workspace_menu_open = open;
        cx.notify();
    }

    /// Closes the picker or workspace menu and returns focus to the editor (`finalFocus`).
    pub(super) fn close_branch_popups(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.branch.picker_open || self.branch.workspace_menu_open {
            self.branch.picker_open = false;
            self.branch.workspace_menu_open = false;
            self.focus_input(window, cx);
            cx.notify();
        }
    }

    pub(super) fn branch_popup_open(&self) -> bool {
        self.branch.picker_open || self.branch.workspace_menu_open
    }

    fn branch_rows(&self, cx: &Context<'_, Self>) -> Vec<BranchPickerRow> {
        let query = self.branch.search.read(cx).value().to_string();
        branch_picker_rows(&self.branch.refs, &query, !self.selecting_worktree_base())
    }

    /// Fetches the first page for the current query, or (`more`) the next page.
    fn load_refs(&mut self, more: bool, cx: &mut Context<'_, Self>) {
        let (Some(conn), Some(cwd)) = (self.connection.clone(), self.branch.branch_cwd()) else {
            return;
        };
        let cursor = if more {
            match self.branch.next_cursor {
                Some(cursor) if !self.branch.loading => Some(cursor),
                _ => return,
            }
        } else {
            None
        };
        let query = sanitize_new_ref_name(&self.branch.search.read(cx).value());
        self.branch.generation = self.branch.generation.wrapping_add(1);
        let generation = self.branch.generation;
        self.branch.loading = true;
        self.branch.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let payload = VcsListRefsInput {
                cwd,
                query: (!query.is_empty()).then_some(query),
                cursor,
                include_matching_remote_refs: None,
                ref_kind: None,
                refresh: None,
                limit: Some(REF_PAGE_SIZE),
            };
            let res = conn
                .call::<list_refs::Payload, list_refs::Success>("vcs.listRefs", &payload)
                .await;
            let _ = this.update(cx, |composer, cx| {
                if composer.branch.generation != generation {
                    return;
                }
                composer.branch.loading = false;
                match res {
                    Ok(result) => {
                        let refs = result.refs.into_iter().map(ref_entry);
                        if cursor.is_some() {
                            composer.branch.refs.extend(refs);
                        } else {
                            composer.branch.refs = refs.collect();
                        }
                        composer.branch.total = result.total_count;
                        composer.branch.next_cursor = result.next_cursor;
                    }
                    Err(err) => composer.branch.error = Some(err.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn move_branch_highlight(&mut self, delta: isize, cx: &mut Context<'_, Self>) {
        let len = self.branch_rows(cx).len();
        if len == 0 {
            return;
        }
        let current = self.branch.highlighted.min(len - 1);
        self.branch.highlighted = current
            .checked_add_signed(delta)
            .map_or(len - 1, |next| next % len);
        // Reaching the end of the loaded refs pulls the next page (`onEndReached`).
        if self.branch.highlighted + 1 >= len {
            self.load_refs(true, cx);
        }
        cx.notify();
    }

    fn pick_highlighted_branch_row(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let rows = self.branch_rows(cx);
        if let Some(row) = rows.get(self.branch.highlighted).cloned() {
            self.pick_branch_row(row, window, cx);
        }
    }

    fn pick_branch_row(
        &mut self,
        row: BranchPickerRow,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let action = match row {
            BranchPickerRow::Ref(idx) => match self.branch.refs.get(idx) {
                Some(entry) => BranchAction::SelectRef(entry.clone()),
                None => return,
            },
            BranchPickerRow::Create(name) => BranchAction::CreateRef(name),
        };
        self.close_branch_popups(window, cx);
        cx.emit(ComposerEvent::Branch(action));
    }

    fn pick_workspace(
        &mut self,
        action: BranchAction,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if let BranchAction::WorkspaceMode(worktree) = action {
            self.worktree_active = worktree;
        }
        self.close_branch_popups(window, cx);
        cx.emit(ComposerEvent::Branch(action));
    }

    /// `⌘⇧L`: reuse the project's most recent worktree on a draft.
    pub(super) fn use_previous_worktree(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if !self.is_draft {
            return;
        }
        if let Some(seed) = self.branch.context.previous_worktree.clone() {
            self.pick_workspace(BranchAction::UsePreviousWorktree(seed), window, cx);
        }
    }

    /// Left side of the strip: the workspace selector (drafts) or locked label (threads).
    pub(super) fn render_workspace_control(
        &self,
        tokens: &Tokens,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let fg = hsla(tokens.foreground);
        let muted = hsla(tokens.muted_foreground);
        let hover_bg = hsla(tokens.shell_highlight);
        let worktree_path = self.branch.context.worktree_path.as_deref();
        // `FolderGit2Icon` (new worktree) and `FolderGitIcon` (current worktree) share one glyph.
        let icon = if self.worktree_active || worktree_path.is_some() {
            "superhero/folder-git.svg"
        } else {
            "superhero/folder.svg"
        };

        if !self.is_draft {
            // `resolveLockedWorkspaceLabel`.
            let label = worktree_path
                .and_then(|p| p.rsplit('/').find(|s| !s.is_empty()))
                .map_or_else(
                    || {
                        if self.worktree_active {
                            "Worktree"
                        } else {
                            "Local checkout"
                        }
                        .to_owned()
                    },
                    str::to_owned,
                );
            let tip = worktree_path.map_or_else(|| label.clone(), str::to_owned);
            return div()
                .id("composer-workspace-locked")
                .flex()
                .flex_row()
                .items_center()
                .gap(px(4.0))
                .h(px(22.0))
                .px(px(6.0))
                .min_w_0()
                .text_color(muted.opacity(0.7))
                .conn_tooltip(tip, tokens)
                .child(icons::icon(icon, 12.0, muted))
                .child(div().min_w_0().truncate().child(label))
                .into_any_element();
        }

        // `resolveEnvModeLabel` / `resolveCurrentWorkspaceLabel`.
        let label = if self.worktree_active && worktree_path.is_none() {
            "New worktree"
        } else if worktree_path.is_some() {
            "Current worktree"
        } else {
            "Current checkout"
        };
        let open = self.branch.workspace_menu_open;
        let trigger = div()
            .id("composer-workspace-mode")
            .a11y_button("composer.workspace-mode", format!("Workspace: {label}"))
            .aria_expanded(open)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.0))
            .h(px(22.0))
            .px(px(6.0))
            .rounded(px(6.0))
            .min_w_0()
            .cursor_pointer()
            .text_color(if open { fg } else { muted })
            .when(open, |el| el.bg(hover_bg))
            .hover(move |s| s.bg(hover_bg).text_color(fg))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(|composer, _, _, cx| composer.toggle_workspace_menu(cx)))
            .conn_tooltip(format!("{label} · ⌘⇧X"), tokens)
            .child(icons::icon(icon, 12.0, if open { fg } else { muted }))
            .child(div().min_w_0().truncate().child(label));

        let mut slot = div().relative().min_w_0().child(trigger);
        if open {
            slot = slot.child(
                deferred(
                    div()
                        .absolute()
                        .bottom_full()
                        .left_0()
                        .mb(px(4.0))
                        .child(self.render_workspace_menu(tokens, cx)),
                )
                .with_priority(3),
            );
        }
        slot.into_any_element()
    }

    fn render_workspace_menu(&self, tokens: &Tokens, cx: &mut Context<'_, Self>) -> AnyElement {
        let fg = hsla(tokens.foreground);
        let muted = hsla(tokens.muted_foreground);
        let highlight = hsla(tokens.foreground.with_alpha(0.09));
        let worktree_path = self.branch.context.worktree_path.as_deref();
        let current_label = if worktree_path.is_some() {
            "Current worktree"
        } else {
            "Current checkout"
        };
        let local_selected = !self.worktree_active;
        let item = |id: &'static str,
                    icon: &'static str,
                    label: String,
                    subtitle: Option<String>,
                    selected: bool,
                    action: BranchAction,
                    cx: &mut Context<'_, Self>| {
            div()
                .id(id)
                .a11y_button(format!("composer.workspace.{id}"), label.clone())
                .aria_selected(selected)
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.0))
                .min_h(px(28.0))
                .px(px(8.0))
                .py(px(4.0))
                .rounded(px(8.0))
                .cursor_pointer()
                .text_size(px(14.0))
                .line_height(px(20.0))
                .text_color(fg)
                .hover(move |s| s.bg(highlight))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |composer, _, window, cx| {
                    composer.pick_workspace(action.clone(), window, cx);
                }))
                .child(icons::icon(icon, 16.0, muted))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .child(div().truncate().child(label))
                        .when_some(subtitle, |el, sub| {
                            el.child(
                                div()
                                    .truncate()
                                    .text_size(px(12.0))
                                    .line_height(px(16.0))
                                    .text_color(muted)
                                    .child(sub),
                            )
                        }),
                )
                .child(if selected {
                    icons::icon("superhero/check.svg", 14.0, fg).into_any_element()
                } else {
                    div().size(px(14.0)).into_any_element()
                })
        };

        let mut menu = super::footer::popover_surface("composer-workspace-menu", tokens)
            .min_w(px(220.0))
            .max_w(px(336.0))
            .flex()
            .flex_col()
            .child(
                div()
                    .px(px(8.0))
                    .py(px(6.0))
                    .text_size(px(12.0))
                    .line_height(px(16.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(muted)
                    .child("Workspace"),
            )
            .child(item(
                "current",
                if worktree_path.is_some() {
                    "superhero/folder-git.svg"
                } else {
                    "superhero/folder.svg"
                },
                current_label.to_owned(),
                None,
                local_selected,
                BranchAction::WorkspaceMode(false),
                cx,
            ))
            .child(item(
                "new-worktree",
                "superhero/folder-git.svg",
                "New worktree".to_owned(),
                None,
                self.worktree_active,
                BranchAction::WorkspaceMode(true),
                cx,
            ));
        if let Some(seed) = self.branch.context.previous_worktree.clone()
            && worktree_path != Some(seed.worktree_path.as_str())
        {
            menu = menu.child(item(
                "previous-worktree",
                "superhero/history.svg",
                "Previous worktree".to_owned(),
                seed.branch.clone(),
                false,
                BranchAction::UsePreviousWorktree(seed),
                cx,
            ));
        }
        menu.into_any_element()
    }

    /// Branch trigger (`GitBranchIcon` + label) and its picker popup.
    pub(super) fn render_branch_control(
        &self,
        tokens: &Tokens,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let fg = hsla(tokens.foreground);
        let muted = hsla(tokens.muted_foreground);
        let hover_bg = hsla(tokens.shell_highlight);
        let branch = self.branch.context.branch.as_deref();
        let is_remote = branch.and_then(|b| {
            self.branch
                .refs
                .iter()
                .find(|r| r.name == b)
                .map(|r| r.is_remote)
        });
        let label = branch_trigger_label(
            branch,
            self.selecting_worktree_base(),
            self.branch.context.start_from_origin,
            is_remote,
        );
        let open = self.branch.picker_open;
        let trigger = div()
            .id("composer-branch-picker")
            .a11y_button("composer.branch-picker", format!("Branch: {label}"))
            .aria_expanded(open)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.0))
            .h(px(22.0))
            .px(px(6.0))
            .rounded(px(6.0))
            .min_w_0()
            .cursor_pointer()
            .text_color(if open { fg } else { muted })
            .when(open, |el| el.bg(hover_bg))
            .hover(move |s| s.bg(hover_bg).text_color(fg))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(|composer, _, window, cx| {
                composer.toggle_branch_picker(window, cx);
            }))
            .child(icons::icon(
                "superhero/branch.svg",
                12.0,
                if open { fg } else { muted },
            ))
            .child(div().min_w_0().truncate().child(label));

        let mut slot = div().relative().min_w_0().child(trigger);
        if open {
            slot = slot.child(
                deferred(
                    div()
                        .absolute()
                        .bottom_full()
                        .right_0()
                        .mb(px(4.0))
                        .child(self.render_branch_popup(tokens, cx)),
                )
                .with_priority(3),
            );
        }
        slot.into_any_element()
    }

    fn render_branch_popup(&self, tokens: &Tokens, cx: &mut Context<'_, Self>) -> AnyElement {
        let fg = hsla(tokens.foreground);
        let muted = hsla(tokens.muted_foreground);
        let highlight_bg = hsla(tokens.foreground.with_alpha(0.09));
        let divider = hsla(tokens.glass_divider);
        let search_border = hsla(tokens.border.with_alpha(0.70));
        let rows = self.branch_rows(cx);
        let highlighted = self.branch.highlighted.min(rows.len().saturating_sub(1));
        let project_cwd = self.branch.context.project_cwd.as_deref();
        let blocked = self.branch.context.worktree_change_blocked;

        let search = div().px(px(12.0)).pt(px(10.0)).child(
            div()
                .relative()
                .pb(px(6.0))
                .border_b_1()
                .border_color(search_border)
                .child(div().absolute().left_0().top(px(5.0)).child(icons::icon(
                    "superhero/search.svg",
                    16.0,
                    muted.opacity(0.55),
                )))
                .child(
                    div().h(px(26.0)).pl(px(20.0)).child(
                        Input::new(&self.branch.search)
                            .appearance(false)
                            .text_size(px(14.0)),
                    ),
                ),
        );

        let status_row = |text: String| {
            div()
                .px(px(12.0))
                .py(px(6.0))
                .text_size(px(12.0))
                .line_height(px(16.0))
                .text_color(muted)
                .child(text)
        };

        let mut list = div()
            .id("composer-branch-list")
            .flex()
            .flex_col()
            .max_h(px(LIST_MAX_HEIGHT_PX))
            .overflow_y_scroll()
            .px(px(4.0))
            .py(px(8.0));
        if rows.is_empty() && !self.branch.loading {
            list = list.child(
                div()
                    .p(px(8.0))
                    .text_center()
                    .text_size(px(14.0))
                    .line_height(px(20.0))
                    .text_color(muted)
                    .child("No refs found."),
            );
        }
        for (idx, row) in rows.into_iter().enumerate() {
            let (label, badge): (String, Option<&'static str>) = match &row {
                BranchPickerRow::Ref(i) => match self.branch.refs.get(*i) {
                    Some(entry) => (entry.name.clone(), ref_badge(entry, project_cwd)),
                    None => continue,
                },
                BranchPickerRow::Create(name) => (format!("Create new ref \"{name}\""), None),
            };
            list = list.child(
                div()
                    .id(("composer-branch-row", idx))
                    .a11y_button(format!("composer.branch.{idx}"), label.clone())
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .min_h(px(28.0))
                    .px(px(8.0))
                    .py(px(4.0))
                    .rounded(px(8.0))
                    .cursor_pointer()
                    .text_size(px(14.0))
                    .line_height(px(20.0))
                    .text_color(fg)
                    .when(idx == highlighted, |el| el.bg(highlight_bg))
                    .on_mouse_move(cx.listener(move |composer, _, _, cx| {
                        if composer.branch.highlighted != idx {
                            composer.branch.highlighted = idx;
                            cx.notify();
                        }
                    }))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |composer, _, window, cx| {
                        composer.pick_branch_row(row.clone(), window, cx);
                    }))
                    .child(div().flex_1().min_w_0().truncate().child(label))
                    .when_some(badge, |el, badge| {
                        el.child(
                            div()
                                .flex_shrink_0()
                                .text_size(px(10.0))
                                .line_height(px(14.0))
                                .text_color(muted.opacity(0.45))
                                .child(badge),
                        )
                    }),
            );
        }

        let mut popup = div()
            .id("composer-branch-popup")
            .w(px(PICKER_WIDTH_PX))
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(px(12.0))
            .bg(hsla(tokens.popover))
            .border_1()
            .border_color(hsla(tokens.foreground.with_alpha(0.08)))
            .shadow(vec![crate::panels::header::dropdown_glass_shadow(tokens)])
            .occlude()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .capture_action(cx.listener(|composer, _: &MoveUp, _, cx| {
                composer.move_branch_highlight(-1, cx);
                cx.stop_propagation();
            }))
            .capture_action(cx.listener(|composer, _: &MoveDown, _, cx| {
                composer.move_branch_highlight(1, cx);
                cx.stop_propagation();
            }))
            .capture_action(cx.listener(|composer, _: &Escape, window, cx| {
                composer.close_branch_popups(window, cx);
                cx.stop_propagation();
            }))
            .child(search)
            .child(list);

        if self.selecting_worktree_base() {
            let checked = self.branch.context.start_from_origin;
            let weak = cx.weak_entity();
            popup = popup.child(
                div()
                    .id("composer-branch-start-from-remote")
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(12.0))
                    .px(px(12.0))
                    .py(px(8.0))
                    .border_t_1()
                    .border_color(divider)
                    .text_size(px(13.0))
                    .line_height(px(20.0))
                    .conn_tooltip(START_FROM_REMOTE_TOOLTIP, tokens)
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.0))
                            .min_w_0()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(muted)
                            .child(icons::icon("superhero/refresh.svg", 12.0, muted))
                            .child(div().truncate().child("Start from remote")),
                    )
                    .child(crate::settings::controls::pill_switch(
                        "composer-start-from-remote",
                        checked,
                        tokens,
                        move |_, cx| {
                            let _ = weak.update(cx, |_, cx| {
                                cx.emit(ComposerEvent::Branch(BranchAction::StartFromOrigin(
                                    !checked,
                                )));
                            });
                        },
                    )),
            );
        }
        if blocked {
            popup = popup.child(status_row(
                "Stop the current turn to switch worktrees.".to_owned(),
            ));
        }
        if let Some(err) = &self.branch.error {
            popup = popup.child(status_row(err.clone()));
        }
        let status = if self.branch.loading && self.branch.refs.is_empty() {
            Some("Loading refs...".to_owned())
        } else if self.branch.loading {
            Some("Loading more refs...".to_owned())
        } else if self.branch.next_cursor.is_some() {
            Some(format!(
                "Showing {} of {} refs",
                self.branch.refs.len(),
                self.branch.total
            ))
        } else {
            None
        };
        if let Some(status) = status {
            popup = popup.child(status_row(status));
        }
        popup.into_any_element()
    }
}
