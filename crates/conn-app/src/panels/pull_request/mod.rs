//! The Pull request surface (`PullRequestDetailPanel`, `PullRequestDetailLayout`,
//! `PullRequestSummaryTab`, `PullRequestTimelineTab`, `PullRequestCodeTab`,
//! `PullRequestActionsMenu`, `PullRequestTitleEditor`, `PullRequestCommentForm`).

mod header;
mod logic;
mod markdown;
mod tabs;

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::Duration;

use conn_client::{Connection, StreamId};
use conn_contract::rpc::git::resolve_pull_request;
use conn_contract::rpc::orchestration::get_thread_projection;
use conn_contract::rpc::pull_requests::{
    activity, comment, detail, diff_file_contents, files_viewed, invalidate, list, reply_to_thread,
    run_action, set_files_viewed, set_thread_resolution, update,
};
use conn_contract::rpc::review::get_diff_preview;
use conn_contract::{
    GitPullRequestRefInput, OrchestrationV2ThreadProjection, PullRequestAction,
    PullRequestActionInput, PullRequestActionInputUpdateMethod, PullRequestActivity,
    PullRequestCommentInput, PullRequestDetail, PullRequestDetailAutoMergeMethod,
    PullRequestDiffFileContentsInput, PullRequestFileViewedState, PullRequestInvalidateInput,
    PullRequestListInput, PullRequestListState, PullRequestRef, PullRequestSetFilesViewedInput,
    PullRequestSetFilesViewedInputFilesItem, PullRequestThreadReplyInput,
    PullRequestThreadResolutionInput, PullRequestUpdateInput,
    ReviewDiffFileContentsInputChangeType, ReviewDiffPreviewInput,
};
use conn_theme::Tokens;
use gpui_kit::component::input::{InputEvent, InputState, TextareaState};
use gpui_kit::component::v_flex;
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, ClipboardItem, Context, Entity, IntoElement, KeyDownEvent, MouseButton,
    ParentElement, Render, ScrollHandle, Styled, Subscription, Window, div,
};
use serde_json::json;

use self::header::{
    ConfirmableAction, HeaderCallbacks, render_detail_ghost, render_header_body,
    render_title_header, render_unavailable_state,
};
use self::logic::{
    CommentFilter, DetailTab, ResolvedPullRequestTarget, ReviewOutcome, TimelineOrder,
    build_unified_diff_from_contents, classify_checks, describe_rpc_error, latest_review_outcomes,
    now_epoch_ms, open_on_host_label, parse_pull_request_url, resolve_thread_pr_target,
};
use self::tabs::{
    CodeFileEntry, FileDiffState, TabCallbacks, render_checks_tab, render_checks_tab_trailing,
    render_code_tab, render_code_tab_trailing, render_description_tab, render_floating_composer,
    render_tab_bar, render_timeline_tab, render_timeline_tab_trailing,
};
use super::chrome;
use super::color::to_hsla;
use super::diff_parser::parse_unified_diff;

const CLOCK_TICK_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
enum PanelState {
    NoConnection,
    NoThread,
    Resolving,
    NoPullRequest,
    LoadingDetail {
        target: ResolvedPullRequestTarget,
    },
    Error {
        target: Option<ResolvedPullRequestTarget>,
        code: Option<String>,
        message: String,
    },
    Ready {
        target: ResolvedPullRequestTarget,
        detail: Box<PullRequestDetail>,
    },
}

/// The Pull request panel entity.
pub(crate) struct PullRequestPanel {
    tokens: Tokens,
    connection: Option<Connection>,
    workspace_root: Option<String>,
    thread_id: Option<String>,
    state: PanelState,
    generation: u64,
    refresh_stream_id: Option<StreamId>,
    refreshing: bool,
    notice: Option<String>,
    now_ms: i64,

    // Activity (`pullRequests.activity`)
    activity: Option<PullRequestActivity>,
    activity_loading: bool,
    activity_error: Option<String>,

    // Header / Title / Body editing
    editing_title: bool,
    title_input: Entity<InputState>,
    title_saving: bool,
    editing_body: bool,
    body_input: Entity<TextareaState>,
    body_saving: bool,
    copied_branch: bool,

    // Actions menu & mutations
    actions_menu_open: bool,
    selected_merge_method: Option<PullRequestDetailAutoMergeMethod>,
    pending_action: Option<PullRequestAction>,
    armed_confirm: Option<ConfirmableAction>,

    // Tabs & Timeline state
    active_tab: DetailTab,
    timeline_order: TimelineOrder,
    comment_filter: CommentFilter,
    filter_menu_open: bool,
    expanded_groups: HashSet<String>,
    expanded_threads: HashMap<String, bool>,
    replying_thread: Option<String>,
    reply_input: Entity<TextareaState>,
    reply_submitting: bool,

    // Floating comment composer
    composer_open: bool,
    comment_input: Entity<TextareaState>,
    comment_text: String,
    comment_submitting: bool,

    // Code tab state
    code_files: Vec<CodeFileEntry>,
    code_files_loading: bool,
    code_files_error: Option<String>,
    code_selected_path: Option<String>,
    code_diffs: HashMap<String, FileDiffState>,
    files_viewed: HashMap<String, PullRequestFileViewedState>,
    code_tree_open: bool,
    code_word_wrap: bool,

    scroll_handle: ScrollHandle,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for PullRequestPanel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PullRequestPanel")
            .field("workspace_root", &self.workspace_root)
            .field("thread_id", &self.thread_id)
            .field("active_tab", &self.active_tab)
            .finish_non_exhaustive()
    }
}

impl Drop for PullRequestPanel {
    fn drop(&mut self) {
        if let (Some(conn), Some(stream_id)) = (&self.connection, self.refresh_stream_id.take()) {
            conn.cancel_stream(stream_id);
        }
    }
}

impl PullRequestPanel {
    pub(crate) fn new(
        tokens: Tokens,
        connection: Option<Connection>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let title_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("Pull request title"));
        let body_input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder("Describe this pull request")
                .auto_grow(6, 18)
        });
        let comment_input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder("Leave a comment")
                .auto_grow(3, 12)
        });
        let reply_input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder("Write a reply")
                .auto_grow(2, 8)
        });

        let comment_sub = cx.subscribe(&comment_input, |this, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.comment_text = input.read(cx).value().to_string();
                cx.notify();
            }
        });
        let title_sub = cx.subscribe_in(
            &title_input,
            window,
            |this, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    this.save_title(window, cx);
                }
            },
        );

        let initial_state = if connection.is_some() {
            PanelState::NoThread
        } else {
            PanelState::NoConnection
        };

        let mut panel = Self {
            tokens,
            connection,
            workspace_root: None,
            thread_id: None,
            state: initial_state,
            generation: 0,
            refresh_stream_id: None,
            refreshing: false,
            notice: None,
            now_ms: now_epoch_ms(),
            activity: None,
            activity_loading: false,
            activity_error: None,
            editing_title: false,
            title_input,
            title_saving: false,
            editing_body: false,
            body_input,
            body_saving: false,
            copied_branch: false,
            actions_menu_open: false,
            selected_merge_method: None,
            pending_action: None,
            armed_confirm: None,
            active_tab: DetailTab::Summary,
            timeline_order: TimelineOrder::Newest,
            comment_filter: CommentFilter::default(),
            filter_menu_open: false,
            expanded_groups: HashSet::new(),
            expanded_threads: HashMap::new(),
            replying_thread: None,
            reply_input,
            reply_submitting: false,
            composer_open: false,
            comment_input,
            comment_text: String::new(),
            comment_submitting: false,
            code_files: Vec::new(),
            code_files_loading: false,
            code_files_error: None,
            code_selected_path: None,
            code_diffs: HashMap::new(),
            files_viewed: HashMap::new(),
            code_tree_open: true,
            code_word_wrap: false,
            scroll_handle: ScrollHandle::new(),
            _subscriptions: vec![comment_sub, title_sub],
        };

        panel.start_background_loops(cx);
        panel
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    /// The selected thread and its project folder.
    pub(crate) fn set_thread(
        &mut self,
        workspace_root: Option<String>,
        thread_id: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.workspace_root == workspace_root && self.thread_id == thread_id {
            return;
        }
        self.workspace_root = workspace_root;
        self.thread_id = thread_id;
        self.reset_transient_ui();
        self.resolve_and_load(cx);
    }

    /// Shows one pull request, opened from Linked items or Tasks, until the thread changes
    /// (Conn opens a `pull-request` surface for that reference).
    pub(crate) fn open_pull_request(
        &mut self,
        project_id: String,
        host: Option<String>,
        repository: String,
        number: i64,
        url: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        self.reset_transient_ui();
        let target = ResolvedPullRequestTarget {
            reference: PullRequestRef {
                project_id,
                host,
                expected_account_id: None,
                allow_stale: None,
                repository,
                number,
            },
            url,
        };
        self.load_pull_request(target, false, cx);
    }

    fn reset_transient_ui(&mut self) {
        self.editing_title = false;
        self.editing_body = false;
        self.actions_menu_open = false;
        self.filter_menu_open = false;
        self.armed_confirm = None;
        self.pending_action = None;
        self.copied_branch = false;
        self.notice = None;
        self.activity = None;
        self.activity_loading = false;
        self.activity_error = None;
        self.expanded_groups.clear();
        self.expanded_threads.clear();
        self.replying_thread = None;
        self.composer_open = false;
        self.code_files.clear();
        self.code_files_loading = false;
        self.code_files_error = None;
        self.code_selected_path = None;
        self.code_diffs.clear();
        self.files_viewed.clear();
    }

    fn start_background_loops(&mut self, cx: &mut Context<'_, Self>) {
        // Minute clock tick so relative timestamps stay current.
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(CLOCK_TICK_INTERVAL).await;
                if this
                    .update(cx, |panel, cx| {
                        panel.now_ms = now_epoch_ms();
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();

        // Live refresh subscription via `pullRequests.subscribeRefreshes`.
        if let Some(conn) = self.connection.clone() {
            let (stream_id, mut rx) =
                conn.stream_json("pullRequests.subscribeRefreshes", json!({}));
            self.refresh_stream_id = Some(stream_id);
            cx.spawn(async move |this, cx| {
                while rx.recv().await.is_some() {
                    let ok = this
                        .update(cx, |panel, cx| {
                            panel.refresh_quietly(cx);
                        })
                        .is_ok();
                    if !ok {
                        break;
                    }
                }
            })
            .detach();
        }
    }

    fn active_target(&self) -> Option<ResolvedPullRequestTarget> {
        match &self.state {
            PanelState::LoadingDetail { target } | PanelState::Ready { target, .. } => {
                Some(target.clone())
            }
            PanelState::Error { target, .. } => target.clone(),
            _ => None,
        }
    }

    fn resolve_and_load(&mut self, cx: &mut Context<'_, Self>) {
        self.generation = self.generation.wrapping_add(1);
        let generation = self.generation;

        let Some(conn) = self.connection.clone() else {
            self.state = PanelState::NoConnection;
            cx.notify();
            return;
        };
        let Some(thread_id) = self.thread_id.clone() else {
            self.state = PanelState::NoThread;
            cx.notify();
            return;
        };
        let workspace_root = self.workspace_root.clone();
        self.state = PanelState::Resolving;
        cx.notify();

        cx.spawn(async move |this, cx| {
            let resolved =
                resolve_pr_for_thread(&conn, &thread_id, workspace_root.as_deref()).await;
            let _ = this.update(cx, |panel, cx| {
                if panel.generation != generation {
                    return;
                }
                match resolved {
                    Ok(Some(target)) => {
                        panel.load_pull_request(target, false, cx);
                    }
                    Ok(None) => {
                        panel.state = PanelState::NoPullRequest;
                        cx.notify();
                    }
                    Err((code, message)) => {
                        panel.state = PanelState::Error {
                            target: None,
                            code,
                            message,
                        };
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }

    fn load_pull_request(
        &mut self,
        target: ResolvedPullRequestTarget,
        quiet: bool,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        self.generation = self.generation.wrapping_add(1);
        let generation = self.generation;
        if !quiet {
            self.state = PanelState::LoadingDetail {
                target: target.clone(),
            };
            self.activity = None;
            self.activity_error = None;
        }
        self.activity_loading = self.activity.is_none();
        self.refreshing = true;
        cx.notify();

        // 1. Fetch `pullRequests.detail`
        let detail_ref = PullRequestRef {
            allow_stale: Some(false),
            ..target.reference.clone()
        };
        let conn_detail = conn.clone();
        let target_detail = target.clone();
        cx.spawn(async move |this, cx| {
            let res = conn_detail
                .call::<detail::Payload, detail::Success>("pullRequests.detail", &detail_ref)
                .await;
            let _ = this.update(cx, |panel, cx| {
                if panel.generation != generation {
                    return;
                }
                panel.refreshing = false;
                panel.now_ms = now_epoch_ms();
                match res {
                    Ok(pr_detail) => {
                        let need_code = panel.active_tab == DetailTab::Code;
                        let target_next = ResolvedPullRequestTarget {
                            reference: target_detail.reference.clone(),
                            url: Some(pr_detail.url.clone()),
                        };
                        panel.state = PanelState::Ready {
                            target: target_next,
                            detail: Box::new(pr_detail),
                        };
                        if need_code {
                            panel.load_code_tab_data(cx);
                        }
                    }
                    Err(err) => {
                        let (code, message) = describe_rpc_error(&err);
                        if !quiet || !matches!(panel.state, PanelState::Ready { .. }) {
                            panel.state = PanelState::Error {
                                target: Some(target_detail),
                                code,
                                message,
                            };
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();

        // 2. Fetch `pullRequests.activity`
        let activity_ref = target.reference;
        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<activity::Payload, activity::Success>(
                    "pullRequests.activity",
                    &activity_ref,
                )
                .await;
            let _ = this.update(cx, |panel, cx| {
                if panel.generation != generation {
                    return;
                }
                panel.activity_loading = false;
                match res {
                    Ok(act) => {
                        panel.activity = Some(act);
                        panel.activity_error = None;
                    }
                    Err(err) => {
                        if panel.activity.is_none() {
                            panel.activity_error = Some(describe_rpc_error(&err).1);
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn refresh_quietly(&mut self, cx: &mut Context<'_, Self>) {
        if let Some(target) = self.active_target() {
            self.load_pull_request(target, true, cx);
        } else if matches!(self.state, PanelState::NoPullRequest) && self.thread_id.is_some() {
            self.resolve_and_load(cx);
        }
    }

    fn refresh_from_host(&mut self, cx: &mut Context<'_, Self>) {
        self.actions_menu_open = false;
        let Some(conn) = self.connection.clone() else {
            return;
        };
        let Some(target) = self.active_target() else {
            self.resolve_and_load(cx);
            return;
        };
        self.refreshing = true;
        cx.notify();
        let inv = PullRequestInvalidateInput {
            reference: Some(target.reference.clone()),
            files_viewed_only: None,
        };
        cx.spawn(async move |this, cx| {
            let _ = conn
                .call::<invalidate::Payload, invalidate::Success>("pullRequests.invalidate", &inv)
                .await;
            let _ = this.update(cx, |panel, cx| {
                panel.load_pull_request(target, true, cx);
            });
        })
        .detach();
    }

    fn perform_action(
        &mut self,
        action: PullRequestAction,
        merge_method: Option<PullRequestDetailAutoMergeMethod>,
        update_method: Option<PullRequestActionInputUpdateMethod>,
        cx: &mut Context<'_, Self>,
    ) {
        self.actions_menu_open = false;
        self.armed_confirm = None;
        if self.pending_action.is_some() {
            return;
        }
        let (Some(conn), Some(target)) = (self.connection.clone(), self.active_target()) else {
            return;
        };
        self.pending_action = Some(action);
        self.notice = None;
        cx.notify();

        let payload = PullRequestActionInput {
            stack_number: None,
            expected_stack_heads: None,
            project_id: target.reference.project_id.clone(),
            host: target.reference.host.clone(),
            expected_account_id: target.reference.expected_account_id.clone(),
            allow_stale: None,
            repository: target.reference.repository.clone(),
            number: target.reference.number,
            action,
            merge_method,
            update_method,
            reply_with_summary: None,
        };

        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<run_action::Payload, run_action::Success>(
                    "pullRequests.runAction",
                    &payload,
                )
                .await;
            let _ = this.update(cx, |panel, cx| {
                panel.pending_action = None;
                match res {
                    Ok(_) => {
                        panel.refresh_from_host(cx);
                    }
                    Err(err) => {
                        panel.notice = Some(describe_rpc_error(&err).1);
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }

    fn save_title(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.title_saving {
            return;
        }
        let next = self.title_input.read(cx).value().trim().to_owned();
        let current = match &self.state {
            PanelState::Ready { detail, .. } => detail.title.as_str(),
            _ => return,
        };
        if next.is_empty() || next == current {
            self.editing_title = false;
            cx.notify();
            return;
        }
        let (Some(conn), Some(target)) = (self.connection.clone(), self.active_target()) else {
            return;
        };
        self.title_saving = true;
        self.editing_title = false;
        self.notice = None;
        cx.notify();

        let payload = PullRequestUpdateInput {
            project_id: target.reference.project_id.clone(),
            host: target.reference.host.clone(),
            expected_account_id: target.reference.expected_account_id.clone(),
            allow_stale: None,
            repository: target.reference.repository.clone(),
            number: target.reference.number,
            title: Some(next.clone()),
            body: None,
            maintainer_can_modify: None,
        };

        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<update::Payload, update::Success>("pullRequests.update", &payload)
                .await;
            let _ = this.update(cx, |panel, cx| {
                panel.title_saving = false;
                match res {
                    Ok(()) => {
                        if let PanelState::Ready { detail, .. } = &mut panel.state {
                            detail.title = next;
                        }
                        panel.refresh_quietly(cx);
                    }
                    Err(err) => {
                        panel.editing_title = true;
                        panel.notice = Some(format!(
                            "The title could not be saved: {}",
                            describe_rpc_error(&err).1
                        ));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn save_body(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.body_saving {
            return;
        }
        let next = self.body_input.read(cx).value().to_string();
        let (Some(conn), Some(target)) = (self.connection.clone(), self.active_target()) else {
            return;
        };
        self.body_saving = true;
        self.notice = None;
        cx.notify();

        let payload = PullRequestUpdateInput {
            project_id: target.reference.project_id.clone(),
            host: target.reference.host.clone(),
            expected_account_id: target.reference.expected_account_id.clone(),
            allow_stale: None,
            repository: target.reference.repository.clone(),
            number: target.reference.number,
            title: None,
            body: Some(next.clone()),
            maintainer_can_modify: None,
        };

        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<update::Payload, update::Success>("pullRequests.update", &payload)
                .await;
            let _ = this.update(cx, |panel, cx| {
                panel.body_saving = false;
                match res {
                    Ok(()) => {
                        panel.editing_body = false;
                        if let PanelState::Ready { detail, .. } = &mut panel.state {
                            detail.body = next;
                        }
                        panel.refresh_quietly(cx);
                    }
                    Err(err) => {
                        panel.notice = Some(format!(
                            "Could not save the description: {}",
                            describe_rpc_error(&err).1
                        ));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn submit_comment(
        &mut self,
        follow_up: Option<PullRequestAction>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if self.comment_submitting {
            return;
        }
        let body = self.comment_input.read(cx).value().trim().to_owned();
        if body.is_empty() {
            return;
        }
        let (Some(conn), Some(target)) = (self.connection.clone(), self.active_target()) else {
            return;
        };
        self.comment_submitting = true;
        self.armed_confirm = None;
        self.notice = None;
        cx.notify();

        let payload = PullRequestCommentInput {
            project_id: target.reference.project_id.clone(),
            host: target.reference.host.clone(),
            expected_account_id: target.reference.expected_account_id.clone(),
            allow_stale: None,
            repository: target.reference.repository.clone(),
            number: target.reference.number,
            body,
        };
        let comment_input = self.comment_input.clone();
        let window_handle = window.window_handle();

        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<comment::Payload, comment::Success>("pullRequests.comment", &payload)
                .await;
            let _ = cx.update_window(window_handle, |_, window, cx| {
                let _ = this.update(cx, |panel, cx| {
                    panel.comment_submitting = false;
                    match res {
                        Ok(()) => {
                            panel.comment_text.clear();
                            comment_input
                                .update(cx, |s, cx| s.set_value(String::new(), window, cx));
                            panel.composer_open = false;
                            if let Some(action) = follow_up {
                                panel.perform_action(action, None, None, cx);
                            } else {
                                panel.refresh_quietly(cx);
                            }
                        }
                        Err(err) => {
                            panel.notice = Some(format!(
                                "Could not post the comment: {}",
                                describe_rpc_error(&err).1
                            ));
                        }
                    }
                    cx.notify();
                });
            });
        })
        .detach();
    }

    fn submit_thread_reply(
        &mut self,
        thread_id: String,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if self.reply_submitting {
            return;
        }
        let body = self.reply_input.read(cx).value().trim().to_owned();
        if body.is_empty() {
            return;
        }
        let (Some(conn), Some(target)) = (self.connection.clone(), self.active_target()) else {
            return;
        };
        self.reply_submitting = true;
        self.notice = None;
        cx.notify();

        let payload = PullRequestThreadReplyInput {
            project_id: target.reference.project_id.clone(),
            host: target.reference.host.clone(),
            expected_account_id: target.reference.expected_account_id.clone(),
            allow_stale: None,
            repository: target.reference.repository.clone(),
            number: target.reference.number,
            thread_id,
            body,
        };
        let reply_input = self.reply_input.clone();
        let window_handle = window.window_handle();

        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<reply_to_thread::Payload, reply_to_thread::Success>(
                    "pullRequests.replyToThread",
                    &payload,
                )
                .await;
            let _ = cx.update_window(window_handle, |_, window, cx| {
                let _ = this.update(cx, |panel, cx| {
                    panel.reply_submitting = false;
                    match res {
                        Ok(()) => {
                            panel.replying_thread = None;
                            reply_input.update(cx, |s, cx| s.set_value(String::new(), window, cx));
                            panel.refresh_quietly(cx);
                        }
                        Err(err) => {
                            panel.notice = Some(format!(
                                "Reply could not be posted: {}",
                                describe_rpc_error(&err).1
                            ));
                        }
                    }
                    cx.notify();
                });
            });
        })
        .detach();
    }

    fn set_thread_resolved(
        &mut self,
        thread_id: String,
        resolved: bool,
        cx: &mut Context<'_, Self>,
    ) {
        let (Some(conn), Some(target)) = (self.connection.clone(), self.active_target()) else {
            return;
        };
        let payload = PullRequestThreadResolutionInput {
            project_id: target.reference.project_id.clone(),
            host: target.reference.host.clone(),
            expected_account_id: target.reference.expected_account_id.clone(),
            allow_stale: None,
            repository: target.reference.repository.clone(),
            number: target.reference.number,
            thread_id,
            resolved,
        };
        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<set_thread_resolution::Payload, set_thread_resolution::Success>(
                    "pullRequests.setThreadResolution",
                    &payload,
                )
                .await;
            let _ = this.update(cx, |panel, cx| {
                match res {
                    Ok(()) => panel.refresh_quietly(cx),
                    Err(err) => {
                        panel.notice = Some(format!(
                            "The conversation could not be updated: {}",
                            describe_rpc_error(&err).1
                        ));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn load_code_tab_data(&mut self, cx: &mut Context<'_, Self>) {
        let (Some(conn), PanelState::Ready { target, detail }) =
            (self.connection.clone(), &self.state)
        else {
            return;
        };
        let generation = self.generation;
        let pr_ref = target.reference.clone();
        let base_branch = detail.base_branch.clone();
        let cwd = if detail.workspace_root.is_empty() {
            self.workspace_root.clone()
        } else {
            Some(detail.workspace_root.clone())
        };
        let review_paths: Vec<String> = self
            .activity
            .as_ref()
            .map(|a| {
                let mut seen = HashSet::new();
                a.review_threads
                    .iter()
                    .filter(|t| seen.insert(t.path.clone()))
                    .map(|t| t.path.clone())
                    .collect()
            })
            .unwrap_or_default();

        self.code_files_loading = true;
        self.code_files_error = None;
        cx.notify();

        cx.spawn(async move |this, cx| {
            // 1. Query `pullRequests.filesViewed` for host file list & viewed states.
            let viewed_res = conn
                .call::<files_viewed::Payload, files_viewed::Success>(
                    "pullRequests.filesViewed",
                    &pr_ref,
                )
                .await;

            // 2. Also query `review.getDiffPreview` against the local checkout when available,
            //    giving changed file stats & unified diff patches immediately.
            let preview_res = if let Some(cwd) = cwd {
                let input = ReviewDiffPreviewInput {
                    cwd,
                    base_ref: Some(base_branch),
                    commit_sha: None,
                    ignore_whitespace: None,
                    source_kind: None,
                    tracked_only: Some(true),
                    metadata_only: None,
                    file: None,
                };
                conn.call::<get_diff_preview::Payload, get_diff_preview::Success>(
                    "review.getDiffPreview",
                    &input,
                )
                .await
                .ok()
            } else {
                None
            };

            let _ = this.update(cx, |panel, cx| {
                if panel.generation != generation {
                    return;
                }
                panel.code_files_loading = false;

                let mut files_map: HashMap<String, CodeFileEntry> = HashMap::new();
                let mut order: Vec<String> = Vec::new();

                if let Ok(viewed) = &viewed_res {
                    panel.files_viewed.clear();
                    for item in &viewed.files {
                        panel.files_viewed.insert(item.path.clone(), item.state);
                        if !files_map.contains_key(&item.path) {
                            order.push(item.path.clone());
                            files_map.insert(
                                item.path.clone(),
                                CodeFileEntry {
                                    path: item.path.clone(),
                                    old_path: item.path.clone(),
                                    additions: None,
                                    deletions: None,
                                },
                            );
                        }
                    }
                }

                if let Some(preview) = preview_res {
                    for source in preview.sources {
                        for parsed in parse_unified_diff(&source.diff) {
                            let path = parsed
                                .new_path
                                .clone()
                                .or_else(|| parsed.old_path.clone())
                                .unwrap_or_else(|| parsed.display_path.clone());
                            let old_path = parsed.old_path.clone().unwrap_or_else(|| path.clone());
                            if !files_map.contains_key(&path) {
                                order.push(path.clone());
                            }
                            files_map.insert(
                                path.clone(),
                                CodeFileEntry {
                                    path: path.clone(),
                                    old_path,
                                    additions: Some(parsed.additions),
                                    deletions: Some(parsed.deletions),
                                },
                            );
                            panel
                                .code_diffs
                                .entry(path)
                                .or_insert(FileDiffState::Loaded(parsed));
                        }
                    }
                }

                for path in review_paths {
                    if !files_map.contains_key(&path) {
                        order.push(path.clone());
                        files_map.insert(
                            path.clone(),
                            CodeFileEntry {
                                path: path.clone(),
                                old_path: path,
                                additions: None,
                                deletions: None,
                            },
                        );
                    }
                }

                panel.code_files = order
                    .into_iter()
                    .filter_map(|p| files_map.remove(&p))
                    .collect();

                if panel.code_files.is_empty()
                    && let Err(err) = viewed_res
                {
                    panel.code_files_error = Some(describe_rpc_error(&err).1);
                }

                if let Some(first) = panel.code_files.first().map(|f| f.path.clone()) {
                    let selected = panel
                        .code_selected_path
                        .clone()
                        .filter(|p| panel.code_files.iter().any(|f| &f.path == p))
                        .unwrap_or(first);
                    panel.select_code_file(selected, cx);
                } else {
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn select_code_file(&mut self, path: String, cx: &mut Context<'_, Self>) {
        self.code_selected_path = Some(path.clone());
        let needs_fetch = matches!(
            self.code_diffs.get(&path),
            None | Some(FileDiffState::Idle | FileDiffState::Error(_))
        );
        if !needs_fetch {
            cx.notify();
            return;
        }
        let (Some(conn), Some(target)) = (self.connection.clone(), self.active_target()) else {
            cx.notify();
            return;
        };
        let old_path = self
            .code_files
            .iter()
            .find(|f| f.path == path)
            .map_or_else(|| path.clone(), |f| f.old_path.clone());
        let generation = self.generation;
        self.code_diffs.insert(path.clone(), FileDiffState::Loading);
        cx.notify();

        let payload = PullRequestDiffFileContentsInput {
            project_id: target.reference.project_id.clone(),
            host: target.reference.host.clone(),
            expected_account_id: target.reference.expected_account_id.clone(),
            allow_stale: None,
            repository: target.reference.repository.clone(),
            number: target.reference.number,
            commit: None,
            change_type: if old_path != path {
                ReviewDiffFileContentsInputChangeType::RenameChanged
            } else {
                ReviewDiffFileContentsInputChangeType::Change
            },
            old_path: old_path.clone(),
            new_path: path.clone(),
        };

        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<diff_file_contents::Payload, diff_file_contents::Success>(
                    "pullRequests.diffFileContents",
                    &payload,
                )
                .await;
            let _ = this.update(cx, |panel, cx| {
                if panel.generation != generation {
                    return;
                }
                match res {
                    Ok(contents) => {
                        let diff = build_unified_diff_from_contents(
                            &old_path,
                            &path,
                            &contents.old_contents,
                            &contents.new_contents,
                        );
                        if let Some(entry) = panel.code_files.iter_mut().find(|f| f.path == path) {
                            entry.additions = Some(diff.additions);
                            entry.deletions = Some(diff.deletions);
                        }
                        panel.code_diffs.insert(path, FileDiffState::Loaded(diff));
                    }
                    Err(err) => {
                        panel
                            .code_diffs
                            .insert(path, FileDiffState::Error(describe_rpc_error(&err).1));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn toggle_file_viewed(&mut self, path: String, viewed: bool, cx: &mut Context<'_, Self>) {
        let (Some(conn), Some(target)) = (self.connection.clone(), self.active_target()) else {
            return;
        };
        let previous = self.files_viewed.insert(
            path.clone(),
            if viewed {
                PullRequestFileViewedState::Viewed
            } else {
                PullRequestFileViewedState::Unviewed
            },
        );
        cx.notify();

        let revision = match &self.state {
            PanelState::Ready { detail, .. } => detail.head_sha.clone(),
            _ => None,
        };
        let payload = PullRequestSetFilesViewedInput {
            project_id: target.reference.project_id.clone(),
            host: target.reference.host.clone(),
            expected_account_id: target.reference.expected_account_id.clone(),
            allow_stale: None,
            repository: target.reference.repository.clone(),
            number: target.reference.number,
            files: vec![PullRequestSetFilesViewedInputFilesItem {
                path: path.clone(),
                viewed,
                revision,
            }],
        };

        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<set_files_viewed::Payload, set_files_viewed::Success>(
                    "pullRequests.setFilesViewed",
                    &payload,
                )
                .await;
            let _ = this.update(cx, |panel, cx| {
                if let Err(err) = res {
                    if let Some(prev) = previous {
                        panel.files_viewed.insert(path, prev);
                    } else {
                        panel.files_viewed.remove(&path);
                    }
                    panel.notice = Some(format!(
                        "Could not update viewed state: {}",
                        describe_rpc_error(&err).1
                    ));
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn open_external_url(&mut self, url: String, cx: &mut Context<'_, Self>) {
        self.actions_menu_open = false;
        if let Err(err) = std::process::Command::new("open").arg(&url).spawn() {
            self.notice = Some(format!("Could not open {url}: {err}"));
            cx.notify();
        }
    }
}

/// Resolves the PR reference for a thread using:
/// 1. `orchestration.getThreadProjection` (`pull_requests`, `linked_pull_request`, `branch_pull_request`)
/// 2. `git.resolvePullRequest` for the thread's branch
/// 3. `pullRequests.list` for the thread's project matching the thread's branch
async fn resolve_pr_for_thread(
    conn: &Connection,
    thread_id: &str,
    workspace_root: Option<&str>,
) -> Result<Option<ResolvedPullRequestTarget>, (Option<String>, String)> {
    let projection: OrchestrationV2ThreadProjection = conn
        .call::<get_thread_projection::Payload, get_thread_projection::Success>(
            "orchestration.getThreadProjection",
            &conn_contract::OrchestrationV2GetThreadProjectionInput {
                thread_id: thread_id.to_owned(),
            },
        )
        .await
        .map_err(|err| describe_rpc_error(&err))?;

    let thread = &projection.thread;
    if let Some(target) = resolve_thread_pr_target(thread) {
        return Ok(Some(target));
    }

    let cwd = thread
        .worktree_path
        .as_deref()
        .or(workspace_root)
        .map(ToOwned::to_owned);
    if let (Some(cwd), Some(branch)) = (cwd, thread.branch.clone()) {
        if let Ok(resolved) = conn
            .call::<resolve_pull_request::Payload, resolve_pull_request::Success>(
                "git.resolvePullRequest",
                &GitPullRequestRefInput {
                    cwd,
                    reference: branch.clone(),
                },
            )
            .await
            && let Some(parsed) = parse_pull_request_url(&resolved.pull_request.url)
        {
            return Ok(Some(ResolvedPullRequestTarget {
                reference: PullRequestRef {
                    project_id: thread.project_id.clone(),
                    host: Some(parsed.host),
                    expected_account_id: None,
                    allow_stale: None,
                    repository: parsed.repository,
                    number: resolved.pull_request.number,
                },
                url: Some(resolved.pull_request.url),
            }));
        }

        // Fallback: check open PRs in this project matching the thread's head branch.
        let list_input = PullRequestListInput {
            state: PullRequestListState::Open,
            involvement: None,
            filters: None,
            project_id: Some(thread.project_id.clone()),
            project_ids: None,
            host: None,
            limit: Some(30),
            cursors: None,
            query: None,
        };
        if let Ok(list_res) = conn
            .call::<list::Payload, list::Success>("pullRequests.list", &list_input)
            .await
            && let Some(entry) = list_res
                .entries
                .into_iter()
                .find(|e| e.head_branch == branch)
        {
            return Ok(Some(ResolvedPullRequestTarget {
                reference: PullRequestRef {
                    project_id: entry.project_id,
                    host: Some(entry.host),
                    expected_account_id: None,
                    allow_stale: None,
                    repository: entry.repository,
                    number: entry.number,
                },
                url: Some(entry.url),
            }));
        }
    }

    Ok(None)
}

impl Render for PullRequestPanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let entity = cx.entity();
        let bg = to_hsla(self.tokens.shell_card);

        let content: AnyElement = match &self.state {
            PanelState::NoConnection => render_unavailable_state(
                &self.tokens,
                "Pull requests unavailable",
                "Connect to a Conn server to browse pull requests.",
                None,
                None,
            ),
            PanelState::NoThread => render_unavailable_state(
                &self.tokens,
                "No pull request",
                "Select a thread to view its pull request.",
                None,
                None,
            ),
            PanelState::Resolving => render_detail_ghost(&self.tokens, None),
            PanelState::LoadingDetail { target } => {
                render_detail_ghost(&self.tokens, Some(target.reference.number))
            }
            PanelState::NoPullRequest => render_unavailable_state(
                &self.tokens,
                "No pull request",
                "No pull request is linked to this thread or its current branch.",
                Some(Rc::new(move |_, cx| {
                    entity.update(cx, |p, cx| p.resolve_and_load(cx))
                })),
                None,
            ),
            PanelState::Error {
                target,
                code,
                message,
            } => {
                let (title, desc) = if code.as_deref() == Some("not-found")
                    && let Some(t) = target
                {
                    (
                        format!("Pull request #{} not found", t.reference.number),
                        "It may be an issue rather than a pull request, or this account can't see it."
                            .to_owned(),
                    )
                } else if code.as_deref() == Some("unavailable") {
                    ("Pull requests unavailable".to_owned(), message.clone())
                } else {
                    ("Could not load pull requests".to_owned(), message.clone())
                };
                let host_link = target.as_ref().and_then(|t| t.url.clone()).map(|url| {
                    let entity = entity.clone();
                    let label = open_on_host_label("");
                    (
                        url,
                        label,
                        Rc::new(move |u: String, _: &mut Window, cx: &mut gpui_kit::App| {
                            entity.update(cx, |p, cx| p.open_external_url(u, cx));
                        })
                            as Rc<dyn Fn(String, &mut Window, &mut gpui_kit::App)>,
                    )
                });
                let retry_target = target.clone();
                render_unavailable_state(
                    &self.tokens,
                    title,
                    desc,
                    Some(Rc::new({
                        let entity = entity.clone();
                        move |_, cx| {
                            let target = retry_target.clone();
                            entity.update(cx, |p, cx| {
                                if let Some(t) = target {
                                    p.load_pull_request(t, false, cx);
                                } else {
                                    p.resolve_and_load(cx);
                                }
                            });
                        }
                    })),
                    host_link,
                )
            }
            PanelState::Ready { detail, .. } => {
                let comments = self
                    .activity
                    .as_ref()
                    .map_or(&[][..], |a| a.comments.as_slice());
                let review_threads = self
                    .activity
                    .as_ref()
                    .map_or(&[][..], |a| a.review_threads.as_slice());
                let commits = self
                    .activity
                    .as_ref()
                    .map_or(&[][..], |a| a.commits.as_slice());
                let comment_count = self.activity.as_ref().map_or(0, |a| a.comment_count);
                let approval_count = latest_review_outcomes(comments, commits)
                    .iter()
                    .filter(|e| e.outcome == ReviewOutcome::Approved && !e.stale)
                    .count();
                let checks_state = classify_checks(&detail.checks);

                let header_cb = HeaderCallbacks {
                    on_start_edit_title: Rc::new({
                        let entity = entity.clone();
                        let current_title = detail.title.clone();
                        move |window, cx| {
                            let title = current_title.clone();
                            entity.update(cx, |p, cx| {
                                p.editing_title = true;
                                p.title_input
                                    .update(cx, |s, cx| s.set_value(title, window, cx));
                                cx.notify();
                            });
                        }
                    }),
                    on_cancel_edit_title: Rc::new({
                        let entity = entity.clone();
                        move |_, cx| {
                            entity.update(cx, |p, cx| {
                                p.editing_title = false;
                                cx.notify();
                            });
                        }
                    }),
                    on_save_title: Rc::new({
                        let entity = entity.clone();
                        move |window, cx| entity.update(cx, |p, cx| p.save_title(window, cx))
                    }),
                    on_toggle_actions_menu: Rc::new({
                        let entity = entity.clone();
                        move |_, cx| {
                            entity.update(cx, |p, cx| {
                                p.actions_menu_open = !p.actions_menu_open;
                                p.filter_menu_open = false;
                                if !p.actions_menu_open {
                                    p.armed_confirm = None;
                                }
                                cx.notify();
                            });
                        }
                    }),
                    on_refresh_from_host: Rc::new({
                        let entity = entity.clone();
                        move |_, cx| entity.update(cx, |p, cx| p.refresh_from_host(cx))
                    }),
                    on_perform_action: Rc::new({
                        let entity = entity.clone();
                        move |action, merge_method, update_method, _, cx| {
                            entity.update(cx, |p, cx| {
                                p.perform_action(action, merge_method, update_method, cx);
                            });
                        }
                    }),
                    on_arm_confirm: Rc::new({
                        let entity = entity.clone();
                        move |armed, _, cx| {
                            entity.update(cx, |p, cx| {
                                p.armed_confirm = armed;
                                cx.notify();
                            });
                        }
                    }),
                    on_select_merge_method: Rc::new({
                        let entity = entity.clone();
                        move |method, _, cx| {
                            entity.update(cx, |p, cx| {
                                p.selected_merge_method = Some(method);
                                p.actions_menu_open = false;
                                cx.notify();
                            });
                        }
                    }),
                    on_copy_branch: Rc::new({
                        let entity = entity.clone();
                        move |branch, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(branch));
                            entity.update(cx, |p, cx| {
                                p.copied_branch = true;
                                cx.notify();
                                cx.spawn(async move |this, cx| {
                                    cx.background_executor()
                                        .timer(Duration::from_millis(1600))
                                        .await;
                                    let _ = this.update(cx, |p, cx| {
                                        p.copied_branch = false;
                                        cx.notify();
                                    });
                                })
                                .detach();
                            });
                        }
                    }),
                    on_open_url: Rc::new({
                        let entity = entity.clone();
                        move |url, _, cx| entity.update(cx, |p, cx| p.open_external_url(url, cx))
                    }),
                };

                let tab_cb = TabCallbacks {
                    on_select_tab: Rc::new({
                        let entity = entity.clone();
                        move |tab, _, cx| {
                            entity.update(cx, |p, cx| {
                                p.active_tab = tab;
                                p.filter_menu_open = false;
                                if tab == DetailTab::Code
                                    && p.code_files.is_empty()
                                    && !p.code_files_loading
                                {
                                    p.load_code_tab_data(cx);
                                }
                                cx.notify();
                            });
                        }
                    }),
                    on_start_edit_body: Rc::new({
                        let entity = entity.clone();
                        let current_body = detail.body.clone();
                        move |window, cx| {
                            let body = current_body.clone();
                            entity.update(cx, |p, cx| {
                                p.editing_body = true;
                                p.body_input
                                    .update(cx, |s, cx| s.set_value(body, window, cx));
                                cx.notify();
                            });
                        }
                    }),
                    on_cancel_edit_body: Rc::new({
                        let entity = entity.clone();
                        move |_, cx| {
                            entity.update(cx, |p, cx| {
                                p.editing_body = false;
                                cx.notify();
                            });
                        }
                    }),
                    on_save_body: Rc::new({
                        let entity = entity.clone();
                        move |window, cx| entity.update(cx, |p, cx| p.save_body(window, cx))
                    }),
                    on_approve_workflows: Rc::new({
                        let entity = entity.clone();
                        move |_, cx| {
                            entity.update(cx, |p, cx| {
                                p.perform_action(
                                    PullRequestAction::ApproveWorkflows,
                                    None,
                                    None,
                                    cx,
                                );
                            });
                        }
                    }),
                    on_open_url: Rc::new({
                        let entity = entity.clone();
                        move |url, _, cx| entity.update(cx, |p, cx| p.open_external_url(url, cx))
                    }),
                    on_toggle_timeline_order: Rc::new({
                        let entity = entity.clone();
                        move |_, cx| {
                            entity.update(cx, |p, cx| {
                                p.timeline_order = p.timeline_order.toggled();
                                cx.notify();
                            });
                        }
                    }),
                    on_toggle_filter_menu: Rc::new({
                        let entity = entity.clone();
                        move |_, cx| {
                            entity.update(cx, |p, cx| {
                                p.filter_menu_open = !p.filter_menu_open;
                                p.actions_menu_open = false;
                                cx.notify();
                            });
                        }
                    }),
                    on_toggle_filter_bots: Rc::new({
                        let entity = entity.clone();
                        move |_, cx| {
                            entity.update(cx, |p, cx| {
                                p.comment_filter.bots = !p.comment_filter.bots;
                                cx.notify();
                            });
                        }
                    }),
                    on_toggle_filter_resolved: Rc::new({
                        let entity = entity.clone();
                        move |_, cx| {
                            entity.update(cx, |p, cx| {
                                p.comment_filter.resolved = !p.comment_filter.resolved;
                                cx.notify();
                            });
                        }
                    }),
                    on_toggle_group: Rc::new({
                        let entity = entity.clone();
                        move |key, _, cx| {
                            entity.update(cx, |p, cx| {
                                if !p.expanded_groups.remove(&key) {
                                    p.expanded_groups.insert(key);
                                }
                                cx.notify();
                            });
                        }
                    }),
                    on_toggle_thread: Rc::new({
                        let entity = entity.clone();
                        move |tid, _, cx| {
                            entity.update(cx, |p, cx| {
                                let next = !p.expanded_threads.get(&tid).copied().unwrap_or(true);
                                p.expanded_threads.insert(tid, next);
                                cx.notify();
                            });
                        }
                    }),
                    on_resolve_thread: Rc::new({
                        let entity = entity.clone();
                        move |tid, resolved, _, cx| {
                            entity.update(cx, |p, cx| p.set_thread_resolved(tid, resolved, cx));
                        }
                    }),
                    on_start_reply: Rc::new({
                        let entity = entity.clone();
                        move |tid, window, cx| {
                            entity.update(cx, |p, cx| {
                                p.replying_thread = tid;
                                p.reply_input
                                    .update(cx, |s, cx| s.set_value(String::new(), window, cx));
                                cx.notify();
                            });
                        }
                    }),
                    on_submit_reply: Rc::new({
                        let entity = entity.clone();
                        move |tid, window, cx| {
                            entity.update(cx, |p, cx| p.submit_thread_reply(tid, window, cx));
                        }
                    }),
                    on_select_code_file: Rc::new({
                        let entity = entity.clone();
                        move |path, _, cx| {
                            entity.update(cx, |p, cx| p.select_code_file(path, cx));
                        }
                    }),
                    on_toggle_file_viewed: Rc::new({
                        let entity = entity.clone();
                        move |path, viewed, _, cx| {
                            entity.update(cx, |p, cx| p.toggle_file_viewed(path, viewed, cx));
                        }
                    }),
                    on_toggle_code_wrap: Rc::new({
                        let entity = entity.clone();
                        move |_, cx| {
                            entity.update(cx, |p, cx| {
                                p.code_word_wrap = !p.code_word_wrap;
                                cx.notify();
                            });
                        }
                    }),
                    on_toggle_code_tree: Rc::new({
                        let entity = entity.clone();
                        move |_, cx| {
                            entity.update(cx, |p, cx| {
                                p.code_tree_open = !p.code_tree_open;
                                cx.notify();
                            });
                        }
                    }),
                    on_reload_code: Rc::new({
                        let entity = entity.clone();
                        move |_, cx| {
                            entity.update(cx, |p, cx| {
                                p.code_diffs.clear();
                                p.load_code_tab_data(cx);
                            });
                        }
                    }),
                    on_toggle_composer: Rc::new({
                        let entity = entity.clone();
                        move |_, cx| {
                            entity.update(cx, |p, cx| {
                                p.composer_open = !p.composer_open;
                                p.actions_menu_open = false;
                                p.filter_menu_open = false;
                                cx.notify();
                            });
                        }
                    }),
                    on_submit_comment: Rc::new({
                        let entity = entity.clone();
                        move |follow_up, window, cx| {
                            entity.update(cx, |p, cx| p.submit_comment(follow_up, window, cx));
                        }
                    }),
                    on_arm_confirm: Rc::new(move |armed, _, cx| {
                        entity.update(cx, |p, cx| {
                            p.armed_confirm = armed;
                            cx.notify();
                        });
                    }),
                };

                let title_header = render_title_header(
                    &self.tokens,
                    detail,
                    checks_state,
                    self.editing_title,
                    &self.title_input,
                    self.title_saving,
                    self.selected_merge_method,
                    self.pending_action,
                    self.armed_confirm,
                    self.actions_menu_open,
                    self.refreshing,
                    &header_cb,
                );

                let header_body = render_header_body(
                    &self.tokens,
                    detail,
                    comments,
                    commits,
                    self.now_ms,
                    self.copied_branch,
                    self.pending_action,
                    &header_cb,
                );

                let viewed_count = self
                    .files_viewed
                    .values()
                    .filter(|s| **s == PullRequestFileViewedState::Viewed)
                    .count();
                let trailing: Option<AnyElement> = match self.active_tab {
                    DetailTab::Summary => None,
                    DetailTab::Checks => Some(render_checks_tab_trailing(
                        &self.tokens,
                        detail,
                        checks_state,
                        self.pending_action,
                        self.armed_confirm,
                        &tab_cb,
                    )),
                    DetailTab::Timeline => Some(render_timeline_tab_trailing(
                        &self.tokens,
                        comment_count,
                        commits.len(),
                        approval_count,
                        self.activity_loading,
                        self.comment_filter,
                        self.filter_menu_open,
                        self.timeline_order,
                        &tab_cb,
                    )),
                    DetailTab::Code => Some(render_code_tab_trailing(
                        &self.tokens,
                        self.code_files.len(),
                        viewed_count,
                        self.code_tree_open,
                        self.code_word_wrap,
                        &tab_cb,
                    )),
                };

                let tab_bar = render_tab_bar(
                    &self.tokens,
                    self.active_tab,
                    detail.capabilities.diff,
                    trailing,
                    &tab_cb,
                );

                let tab_body: AnyElement = match self.active_tab {
                    DetailTab::Summary => render_description_tab(
                        &self.tokens,
                        detail,
                        self.editing_body,
                        &self.body_input,
                        self.body_saving,
                        &tab_cb,
                    ),
                    DetailTab::Checks => render_checks_tab(&self.tokens, detail, &tab_cb),
                    DetailTab::Timeline => render_timeline_tab(
                        &self.tokens,
                        detail,
                        comments,
                        review_threads,
                        commits,
                        self.activity_loading,
                        self.activity_error.as_deref(),
                        self.timeline_order,
                        self.comment_filter,
                        &self.expanded_groups,
                        &self.expanded_threads,
                        self.replying_thread.as_deref(),
                        &self.reply_input,
                        self.reply_submitting,
                        self.now_ms,
                        &tab_cb,
                    ),
                    DetailTab::Code => render_code_tab(
                        &self.tokens,
                        detail,
                        &self.code_files,
                        self.code_files_loading,
                        self.code_files_error.as_deref(),
                        self.code_selected_path.as_deref(),
                        &self.code_diffs,
                        &self.files_viewed,
                        detail.capabilities.viewed_files.is_some(),
                        self.code_tree_open,
                        self.code_word_wrap,
                        &tab_cb,
                    ),
                };

                let composer = render_floating_composer(
                    &self.tokens,
                    detail,
                    self.composer_open,
                    &self.comment_input,
                    self.comment_text.trim().is_empty(),
                    self.comment_submitting,
                    self.armed_confirm,
                    &tab_cb,
                );

                let mut root = v_flex()
                    .relative()
                    .size_full()
                    .bg(bg)
                    .child(title_header)
                    .when_some(self.notice.as_ref(), |el, notice| {
                        el.child(chrome::warning_notice(&self.tokens, notice.clone()))
                    })
                    .child(
                        div()
                            .id("pr-detail-scroll")
                            .track_scroll(&self.scroll_handle)
                            .flex_1()
                            .min_h_0()
                            .w_full()
                            .overflow_y_scroll()
                            .child(
                                v_flex()
                                    .w_full()
                                    .min_w_0()
                                    .child(header_body)
                                    .child(tab_bar)
                                    .child(tab_body),
                            ),
                    );
                if let Some(composer_el) = composer {
                    root = root.child(composer_el);
                }
                root.into_any_element()
            }
        };

        v_flex()
            .id("pull-request-panel")
            .size_full()
            .bg(bg)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|panel, _, _, cx| {
                    if panel.actions_menu_open
                        || panel.filter_menu_open
                        || panel.armed_confirm.is_some()
                    {
                        panel.actions_menu_open = false;
                        panel.filter_menu_open = false;
                        panel.armed_confirm = None;
                        cx.notify();
                    }
                }),
            )
            .on_key_down(cx.listener(|panel, event: &KeyDownEvent, window, cx| {
                let key = event.keystroke.key.as_str();
                if key == "escape" {
                    if panel.actions_menu_open || panel.filter_menu_open || panel.composer_open {
                        panel.actions_menu_open = false;
                        panel.filter_menu_open = false;
                        panel.composer_open = false;
                        panel.armed_confirm = None;
                        cx.notify();
                    } else if panel.editing_title {
                        panel.editing_title = false;
                        cx.notify();
                    } else if panel.editing_body {
                        panel.editing_body = false;
                        cx.notify();
                    }
                } else if key == "enter"
                    && (event.keystroke.modifiers.platform || event.keystroke.modifiers.control)
                    && panel.composer_open
                {
                    panel.submit_comment(None, window, cx);
                }
            }))
            .child(content)
    }
}
