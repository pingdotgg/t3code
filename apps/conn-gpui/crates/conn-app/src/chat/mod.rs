//! Conn chat card view: messages timeline, collapsible thinking/tool rows,
//! working indicator, empty state, and bottom composer.

mod approval_card;
mod approval_state;
mod cache;
mod cards;
mod color;
mod composer;
mod composer_state;
pub(crate) use self::composer_state::{
    APPROVAL_FEEDBACK_PLAIN_TEXT, APPROVAL_REDIRECT_RETRY, ApprovalSendPlan, HeldDraft, RefEntry,
    ThreadWorkspace, approval_arrived, approval_redirect_notice, branch_selection_target,
    local_branch_name_from_remote_ref, plan_approval_send, previous_worktree,
};
mod draft_hero;
mod icons;
pub(crate) mod markdown;
mod provider_banner;
mod question_logic;
mod question_panel;
mod spinner;
mod toc;

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::rc::Rc;

use conn_contract::ChatAttachment;
use conn_state::{
    EntryTiming, ItemStatus, RunStatus, RunTiming, ThreadState, TimelineEntry,
    TurnCheckpointSummary,
};
use conn_theme::Tokens;
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FollowMode, FontWeight,
    InteractiveElement, IntoElement, ListAlignment, ListOffset, ListState, ParentElement, Render,
    SharedString, StatefulInteractiveElement, Styled, Subscription, Window, div, list, px,
    relative,
};

use self::cache::{CachedRow, RowCache, VirtualItem};
use self::color::{hsla, hsla_alpha, message_highlight, muted_icon, prose_foreground};
pub(crate) use self::composer::{BranchAction, BranchContext, SendDispatch};
use self::composer::{Composer, ComposerEvent};
use self::spinner::{SHIMMER_STEP_INTERVAL, TurningArc, shimmer_text};
use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome::ConnTooltipExt as _;

/// Centered chat content lane width matching Conn's `--chat-content-max-width` (`46rem`).
const CHAT_CONTENT_MAX_WIDTH_PX: f32 = 736.0;
/// Horizontal lane padding matching `.chat-composer-lane` / `.messages-timeline-scroll` (`3rem`).
const CHAT_LANE_PADDING_X_PX: f32 = 48.0;
/// User bubble radius matching Conn's `--radius-bubble: calc(var(--radius) + 6px)` (`8px + 6px`).
const BUBBLE_RADIUS_PX: f32 = 14.0;
/// Tight corner radius where consecutive user bubbles meet (`rounded-tr-md` / `rounded-br-md`).
const BUBBLE_GROUPED_RADIUS_PX: f32 = 6.0;
/// Overdraw distance past the viewport for GPUI's virtualized `ListState` (matches Threadbear).
const LIST_OVERDRAW_PX: f32 = 600.0;
/// Body text typography matching Conn's `text-sm leading-relaxed` (`14px` / `22.75px`).
const BODY_FONT_PX: f32 = 14.0;
const BODY_LINE_HEIGHT_PX: f32 = 22.75;
/// Standard panel chrome typography (`text-ui`: `13px` / `20px`).
const UI_FONT_PX: f32 = 13.0;
const UI_LINE_HEIGHT_PX: f32 = 20.0;
const MONO_FONT_FAMILY: &str = crate::theme::MONO_FONT;

/// Project option selectable from the new-thread draft hero's project combobox.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DraftProjectOption {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) pinned: bool,
    /// The server's scratch ("no project") project; hidden from the combobox.
    pub(crate) is_scratch: bool,
    /// Shell record for the row favicon.
    pub(crate) shell: conn_state::ProjectShell,
}

/// View state rendered while composing a brand-new thread before `orchestration.launchThread`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DraftViewInfo {
    /// The draft's id; its text and attachments are stored under it, whatever project it targets.
    pub(crate) draft_id: String,
    pub(crate) project_id: String,
    pub(crate) project_title: String,
    pub(crate) projects: Vec<DraftProjectOption>,
    pub(crate) launching: bool,
    /// The draft targets the server's scratch project (`isScratchDraft`).
    pub(crate) is_scratch: bool,
    /// The server offers a scratch workspace (`scratchWorkspaceRoot`).
    pub(crate) scratch_available: bool,
}

/// One human user bubble's render inputs.
struct UserBubble<'a> {
    id: &'a str,
    text: &'a str,
    attachments: &'a [ChatAttachment],
    is_steer: bool,
    created_at: Option<&'a str>,
    grouped_with_previous: bool,
    grouped_with_next: bool,
}

/// Events emitted by [`ChatView`] to the host shell.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ChatEvent {
    Send {
        text: String,
        attachments: Vec<conn_contract::ChatAttachment>,
        /// Steer or queue while a turn runs.
        dispatch: SendDispatch,
        /// The draft an approval send left in the composer (see [`ChatView::settle_held_draft`]).
        held_draft: Option<HeldDraft>,
    },
    /// Continue an interrupted thread (`Resume thread`).
    Resume,
    /// Start a new thread that implements the proposed plan.
    ImplementPlanInNewThread {
        text: String,
    },
    Stop,
    /// Answer an approval row: `decision` is `accept` or `decline`.
    Approval {
        entry_id: String,
        decision: String,
    },
    ModelSelected {
        instance_id: String,
        model: String,
        options: Option<serde_json::Map<String, serde_json::Value>>,
    },
    /// Open the Diff panel for one turn (`onOpenTurnDiff(runId, filePath)`), scoped to the
    /// run's checkpoint ordinal and, when given, focused on `file_path`.
    OpenTurnDiff {
        run_id: String,
        app_run_ordinal: Option<i64>,
        file_path: Option<String>,
    },
    /// Open another thread (a subagent's child thread).
    OpenThread(String),
    /// Fork the thread from a completed assistant response's run (`thread.fork`).
    ForkFromRun {
        run_id: String,
    },
    /// Open a workspace-relative file in the right panel's File preview tab.
    OpenFile(String),
    /// Switch the thread's runtime permission mode (`thread.runtime-mode.set`).
    RuntimeModeSelected(String),
    /// Switch the thread's interaction mode (`thread.interaction-mode.set`).
    InteractionModeSelected(String),
    /// Workspace or branch change from the composer context strip.
    Branch(composer::BranchAction),
    /// Switch which project a new-thread draft will launch in.
    DraftProjectSelected(String),
    /// Retarget the draft at the server's scratch project (`or start without a project`).
    DraftStartScratch,
    /// `Add project` from the draft project combobox.
    DraftAddProject,
    /// `Open provider setup` for an instance (the status banner, the model picker).
    OpenProviderSetup(String),
    /// Start a new thread from the empty state CTA.
    StartNewThread,
    /// Open Settings → Connections from the empty/offline state.
    OpenConnections,
    /// A built-in `/` slash command selected from the composer command menu.
    SlashCommand(String),
    /// Request the next older history page for the active bounded thread.
    LoadEarlierHistory,
    /// Promote a queued message to steer the active turn (or start it when stopped).
    PromoteQueuedMessage {
        run_id: String,
    },
    /// Remove a queued message from the queue (`queued-run.cancel`).
    CancelQueuedMessage {
        run_id: String,
    },
    /// Save an edit to a queued message (`queued-run.edit`).
    EditQueuedMessage {
        run_id: String,
        text: String,
        attachments: Option<Vec<ChatAttachment>>,
    },
}

/// GPUI entity rendering the Conn chat card (timeline + composer).
pub(crate) struct ChatView {
    tokens: Tokens,
    has_thread: bool,
    has_projects: bool,
    connected: bool,
    draft: Option<DraftViewInfo>,
    hero: draft_hero::DraftHeroState,
    error_banner: Option<String>,
    /// The live provider catalog the status banner reads.
    server_config: std::sync::Arc<conn_state::providers::ServerConfigState>,
    /// Scopes banner dismissals to one environment.
    environment_key: Option<String>,
    /// Banner keys the user dismissed this session.
    dismissed_provider_banners: HashSet<String>,
    provider_refreshing: bool,
    thread_id: Option<String>,
    thread_title: Option<String>,
    synchronized: bool,
    working: bool,
    has_more_history: bool,
    loading_earlier: bool,
    working_started_at_ms: Option<i64>,
    _working_tick: Option<gpui_kit::Task<()>>,
    cache: RowCache,
    /// [`ThreadState::revision`] last synced into `cache`; `set_thread` skips re-syncing an
    /// unchanged timeline (the shell calls it after every event batch, for any stream).
    synced_revision: Option<u64>,
    /// Thread opened at this instant and not painted yet (`CONN_GPUI_PERF_LOG`).
    perf_open: Option<(String, std::time::Instant)>,
    entry_timings: HashMap<String, EntryTiming>,
    run_timings: HashMap<String, RunTiming>,
    turn_checkpoints: HashMap<String, TurnCheckpointSummary>,
    expanded_ids: HashSet<String>,
    wrapped_code_keys: HashSet<String>,
    copied_code_key: Option<String>,
    model_label: String,
    /// Project root; tool row paths under it show relative, as in Conn.
    workspace_root: Option<String>,
    list_state: ListState,
    toc_hovered_slot: Option<usize>,
    toc_pinned_slot: Option<usize>,
    editing_queued_run_id: Option<String>,
    composer: Entity<Composer>,
    _input_sub: Subscription,
    /// Live connection for card actions (answers, secrets, omitted tool output).
    connection: Option<conn_client::Connection>,
    /// The latest run when it was interrupted (`You stopped after ...`).
    interrupted_run_id: Option<String>,
    /// Copy button currently showing its check (`MessageCopyButton`).
    copied_message_key: Option<String>,
    _copy_reset: Option<gpui_kit::Task<()>>,
    /// Ids of pending question and secret cards that need input fields.
    pending_card_ids: Vec<String>,
    /// The thread's first pending approval; a composer send declines it.
    pending_approval: Option<composer_state::PendingApprovalPrompt>,
    /// The first pending question request, which a composer send answers.
    pending_question_id: Option<String>,
    /// Pending approvals and the first pending question (entry id, request id), before the
    /// typing guard hides any of them.
    incoming_approvals: Vec<conn_state::PendingApproval>,
    incoming_question: Option<(String, String)>,
    /// Holds requests that arrive while the user types (`useComposerTypingGuard`).
    typing_guard: composer_state::TypingGuard,
    _typing_guard_idle: Option<gpui_kit::Task<()>>,
    user_input_cards: HashMap<String, cards::UserInputCardState>,
    /// The pending question's banner: lead-in, scroll, and what keeps the digit shortcuts live.
    question_panel: question_panel::QuestionPanelState,
    secret_forms: HashMap<String, cards::SecretFormState>,
    /// Runs whose changed-files tree has every folder expanded.
    changed_files_expanded: HashSet<String>,
    /// Per-run folder expansion overrides (`path -> expanded`).
    changed_files_dir_overrides: HashMap<String, HashMap<String, bool>>,
    /// Tool output fetched on demand for rows whose output the snapshot omitted.
    fetched_details: HashMap<String, cards::DetailFetch>,
}

/// Snapshot of virtualized timeline & TOC metrics (used for diagnostics and automation).
#[cfg(feature = "automation")]
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TimelineMetrics {
    pub(crate) total_entries: usize,
    pub(crate) virtual_items: usize,
    pub(crate) toc_turns: usize,
    pub(crate) parsed_markdown_rows: usize,
    pub(crate) active_toc_turn: Option<usize>,
    pub(crate) scroll_top_item: usize,
    pub(crate) following_tail: bool,
    pub(crate) at_bottom: bool,
    pub(crate) toc_open: bool,
}

impl fmt::Debug for ChatView {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ChatView")
            .field("has_thread", &self.has_thread)
            .field("thread_id", &self.thread_id)
            .field("working", &self.working)
            .field("row_count", &self.cache.rows().len())
            .field("model_label", &self.model_label)
            .finish_non_exhaustive()
    }
}

impl EventEmitter<ChatEvent> for ChatView {}

impl ChatView {
    /// Creates a new [`ChatView`] styled with `tokens`.
    pub(crate) fn new(
        tokens: Tokens,
        connection: Option<conn_client::Connection>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let list_state = ListState::new(0, ListAlignment::Top, px(LIST_OVERDRAW_PX));
        list_state.set_follow_mode(FollowMode::Tail);
        let weak = cx.weak_entity();
        list_state.set_scroll_handler(move |_, _, cx| {
            let weak = weak.clone();
            // GPUI holds the list borrow while dispatching scroll callbacks; notify after.
            cx.defer(move |cx| {
                let _ = weak.update(cx, |view, cx| {
                    view.maybe_request_earlier_history(cx);
                    cx.notify();
                });
            });
        });

        let composer = cx.new(|cx| Composer::new(tokens.clone(), connection.clone(), window, cx));
        let input_sub = cx.subscribe(
            &composer,
            |this, _, event: &ComposerEvent, cx| match event {
                ComposerEvent::Send {
                    text,
                    attachments,
                    dispatch,
                    held_draft,
                } => {
                    this.scroll_to_latest(cx);
                    cx.emit(ChatEvent::Send {
                        text: text.clone(),
                        attachments: attachments.clone(),
                        dispatch: *dispatch,
                        held_draft: held_draft.clone(),
                    });
                    cx.notify();
                }
                ComposerEvent::AnswerQuestion { text } => {
                    this.answer_pending_question(text, cx);
                }
                ComposerEvent::TypingGuard(input) => {
                    if this.typing_guard.update(*input, std::time::Instant::now()) {
                        this.apply_typing_guard(cx);
                    }
                    this.schedule_typing_guard_idle(cx);
                }
                ComposerEvent::Resume => cx.emit(ChatEvent::Resume),
                ComposerEvent::ImplementPlanInNewThread { text } => {
                    cx.emit(ChatEvent::ImplementPlanInNewThread { text: text.clone() });
                }
                ComposerEvent::EditQueuedMessage {
                    run_id,
                    text,
                    attachments,
                } => {
                    this.editing_queued_run_id = None;
                    cx.emit(ChatEvent::EditQueuedMessage {
                        run_id: run_id.clone(),
                        text: text.clone(),
                        attachments: attachments.clone(),
                    });
                    cx.notify();
                }
                ComposerEvent::CancelEditQueuedMessage => {
                    if this.editing_queued_run_id.take().is_some() {
                        cx.notify();
                    }
                }
                ComposerEvent::Stop => cx.emit(ChatEvent::Stop),
                ComposerEvent::ModelSelected {
                    instance_id,
                    model,
                    options,
                } => {
                    cx.emit(ChatEvent::ModelSelected {
                        instance_id: instance_id.clone(),
                        model: model.clone(),
                        options: options.clone(),
                    });
                }
                ComposerEvent::RuntimeModeSelected(mode) => {
                    cx.emit(ChatEvent::RuntimeModeSelected(mode.clone()));
                }
                ComposerEvent::InteractionModeSelected(mode) => {
                    cx.emit(ChatEvent::InteractionModeSelected(mode.clone()));
                }
                ComposerEvent::Branch(action) => cx.emit(ChatEvent::Branch(action.clone())),
                ComposerEvent::SlashCommand(command) => {
                    cx.emit(ChatEvent::SlashCommand(command.clone()));
                }
                ComposerEvent::OpenProviderSetup(instance_id) => {
                    cx.emit(ChatEvent::OpenProviderSetup(instance_id.clone()));
                }
            },
        );

        let hero = draft_hero::DraftHeroState::new(window, cx);
        Self {
            tokens,
            has_thread: false,
            has_projects: false,
            connected: false,
            draft: None,
            hero,
            error_banner: None,
            server_config: std::sync::Arc::default(),
            environment_key: None,
            dismissed_provider_banners: HashSet::new(),
            provider_refreshing: false,
            thread_id: None,
            thread_title: None,
            synchronized: true,
            working: false,
            has_more_history: false,
            loading_earlier: false,
            working_started_at_ms: None,
            _working_tick: None,
            cache: RowCache::default(),
            synced_revision: None,
            perf_open: None,
            entry_timings: HashMap::new(),
            run_timings: HashMap::new(),
            turn_checkpoints: HashMap::new(),
            expanded_ids: HashSet::new(),
            wrapped_code_keys: HashSet::new(),
            copied_code_key: None,
            model_label: "Default model".to_owned(),
            workspace_root: None,
            list_state,
            toc_hovered_slot: None,
            toc_pinned_slot: None,
            editing_queued_run_id: None,
            composer,
            _input_sub: input_sub,
            connection,
            interrupted_run_id: None,
            copied_message_key: None,
            _copy_reset: None,
            pending_card_ids: Vec::new(),
            pending_approval: None,
            pending_question_id: None,
            incoming_approvals: Vec::new(),
            incoming_question: None,
            typing_guard: composer_state::TypingGuard::default(),
            _typing_guard_idle: None,
            user_input_cards: HashMap::new(),
            question_panel: question_panel::QuestionPanelState::new(cx),
            secret_forms: HashMap::new(),
            changed_files_expanded: HashSet::new(),
            changed_files_dir_overrides: HashMap::new(),
            fetched_details: HashMap::new(),
        }
    }

    /// Replaces the active theme tokens and triggers a repaint.
    /// Updates the live `conn-server` connection inside the composer (for Orbit Node/Instance switching).
    pub(crate) fn set_connection(
        &mut self,
        connection: Option<conn_client::Connection>,
        cx: &mut Context<'_, Self>,
    ) {
        self.connected = connection.is_some();
        self.connection = connection.clone();
        self.composer
            .update(cx, |c, cx| c.set_connection(connection, cx));
        cx.notify();
    }

    /// Stages local file paths into the composer attachment strip (used by automation and tests).
    #[cfg(any(test, feature = "automation"))]
    pub(crate) fn attach_paths(
        &mut self,
        paths: Vec<std::path::PathBuf>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.composer
            .update(cx, |composer, cx| composer.attach_paths(paths, window, cx));
    }

    /// Returns the child composer entity for headless GPUI tests.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn error_for_test(&self) -> Option<String> {
        self.error_banner.clone()
    }

    #[cfg(test)]
    pub(crate) fn composer_for_test(&self) -> Entity<Composer> {
        self.composer.clone()
    }

    /// Returns the composer's currently resolved `(instance_id, model_slug, options)` selection.
    #[must_use]
    pub(crate) fn current_model_selection(
        &self,
        cx: &gpui_kit::App,
    ) -> Option<(
        String,
        String,
        Option<serde_json::Map<String, serde_json::Value>>,
    )> {
        self.composer.read(cx).current_model_selection()
    }

    /// Moves keyboard focus into the composer input.
    pub(crate) fn focus_composer(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        self.composer.update(cx, |c, cx| c.focus_input(window, cx));
    }

    /// The composer's live draft, to compare with an approval send's [`HeldDraft`].
    pub(crate) fn held_draft(&self, cx: &App) -> HeldDraft {
        self.composer.read(cx).held_draft(cx)
    }

    /// Ends an approval send; with `clear`, empties the composer if its draft is unchanged.
    pub(crate) fn settle_held_draft(
        &mut self,
        clear: Option<&HeldDraft>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> bool {
        self.composer
            .update(cx, |c, cx| c.settle_held_draft(clear, window, cx))
    }

    /// Restores or sets the composer textarea text (for example if a launch fails).
    pub(crate) fn set_draft_text(
        &mut self,
        text: String,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.composer
            .update(cx, |c, cx| c.set_draft_text(text, window, cx));
    }

    /// Toggles keeping the `BranchToolbar` context strip visible below the composer on active threads.
    pub(crate) fn set_persist_context_strip(&mut self, persist: bool, cx: &mut Context<'_, Self>) {
        self.composer
            .update(cx, |c, cx| c.set_persist_context_strip(persist, cx));
    }

    /// Updates empty-state context flags (whether projects exist and whether a live server is
    /// connected).
    pub(crate) fn set_shell_availability(
        &mut self,
        has_projects: bool,
        connected: bool,
        cx: &mut Context<'_, Self>,
    ) {
        if self.has_projects != has_projects || self.connected != connected {
            self.has_projects = has_projects;
            self.connected = connected;
            cx.notify();
        }
    }

    /// Enters or updates draft new-thread mode (when `Some`), or leaves draft mode (`None`).
    pub(crate) fn set_draft(&mut self, draft: Option<DraftViewInfo>, cx: &mut Context<'_, Self>) {
        let is_draft = draft.is_some();
        let launching = draft.as_ref().is_some_and(|d| d.launching);
        if self.draft != draft {
            if !is_draft {
                self.hero.menu_open = false;
            }
            self.draft = draft;
            cx.notify();
        }
        self.composer
            .update(cx, |c, cx| c.set_draft_mode(is_draft, launching, cx));
    }

    /// Displays (or clears) a dismissible error banner directly above the composer.
    pub(crate) fn set_error(&mut self, error: Option<String>, cx: &mut Context<'_, Self>) {
        if self.error_banner != error {
            self.error_banner = error;
            cx.notify();
        }
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        if self.tokens == tokens {
            return;
        }
        self.composer
            .update(cx, |c, cx| c.set_tokens(tokens.clone(), cx));
        self.tokens = tokens;
        cx.notify();
    }

    /// Updates the rendered thread state.
    ///
    /// Fast even on huge threads: Markdown is parsed lazily when a row enters the
    /// virtualized viewport, and streaming updates splice only the changed tail of
    /// GPUI's `ListState` while preserving measured heights above.
    pub(crate) fn set_thread(
        &mut self,
        thread: Option<&ThreadState>,
        title: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        let title_changed = self.thread_title != title;
        self.thread_title = title;

        let Some(thread) = thread else {
            self.synced_revision = None;
            self.has_thread = false;
            self.thread_id = None;
            self.synchronized = true;
            self.working = false;
            self.has_more_history = false;
            self.loading_earlier = false;
            self.working_started_at_ms = None;
            self._working_tick = None;
            self.cache.clear();
            self.entry_timings.clear();
            self.run_timings.clear();
            self.turn_checkpoints.clear();
            self.expanded_ids.clear();
            self.wrapped_code_keys.clear();
            self.copied_code_key = None;
            self.toc_hovered_slot = None;
            self.toc_pinned_slot = None;
            self.editing_queued_run_id = None;
            self.reset_card_state();
            self.list_state.reset(0);
            self.list_state.set_follow_mode(FollowMode::Tail);
            self.composer.update(cx, |c, cx| {
                c.set_working(false, cx);
                c.set_can_resume(false, cx);
                c.set_plan_follow_up(None, cx);
                c.set_context_window(None, cx);
                c.clear_edit_queued_if_missing(&[], cx);
            });
            cx.notify();
            return;
        };

        let switched_thread = self.thread_id.as_deref() != Some(thread.thread_id.as_str());
        if switched_thread {
            self.thread_id = Some(thread.thread_id.clone());
            self.expanded_ids.clear();
            self.wrapped_code_keys.clear();
            self.copied_code_key = None;
            self.toc_hovered_slot = None;
            self.toc_pinned_slot = None;
            self.editing_queued_run_id = None;
            self.working_started_at_ms = None;
            self.reset_card_state();
        } else if self.has_thread
            && self.synced_revision == Some(thread.revision)
            && self.has_more_history == thread.has_more_history
            && self.loading_earlier == thread.loading_earlier
        {
            if title_changed {
                cx.notify();
            }
            return;
        }
        self.synced_revision = Some(thread.revision);
        let history =
            composer_state::prompt_history_entries(thread.entries.iter().filter_map(|e| match e {
                TimelineEntry::User {
                    id,
                    text,
                    created_by_agent,
                    ..
                } => Some((id.as_str(), text.as_str(), *created_by_agent)),
                _ => None,
            }));
        self.composer
            .update(cx, |c, _| c.set_prompt_history(history));

        let was_following_tail = self.list_state.is_following_tail();
        let prev_scroll = self.list_state.logical_scroll_top();

        let queued_run_ids: Vec<&str> = thread
            .entries
            .iter()
            .filter_map(|entry| match entry {
                TimelineEntry::QueuedUser { run_id, .. } if !run_id.is_empty() => {
                    Some(run_id.as_str())
                }
                _ => None,
            })
            .collect();
        if self
            .editing_queued_run_id
            .as_deref()
            .is_some_and(|id| !queued_run_ids.contains(&id))
        {
            self.editing_queued_run_id = None;
        }
        self.composer.update(cx, |c, cx| {
            c.clear_edit_queued_if_missing(&queued_run_ids, cx);
        });

        self.has_thread = true;
        self.synchronized = thread.synchronized;
        self.working = thread.working;
        self.has_more_history = thread.has_more_history;
        self.loading_earlier = thread.loading_earlier;
        self.entry_timings = thread.entry_timings.clone();
        self.run_timings = thread.run_timings.clone();
        self.turn_checkpoints = thread.turn_checkpoints.clone();
        self.interrupted_run_id = thread
            .latest_run_id()
            .filter(|run| thread.run_status(run) == Some(RunStatus::Interrupted))
            .map(str::to_owned);
        self.pending_card_ids = thread
            .entries
            .iter()
            .filter_map(|entry| match entry {
                TimelineEntry::UserInputRequest {
                    id, pending: true, ..
                }
                | TimelineEntry::SecretRequest {
                    id, pending: true, ..
                } => Some(id.clone()),
                _ => None,
            })
            .collect();
        self.incoming_approvals = thread.pending_approvals();
        self.incoming_question = thread.entries.iter().find_map(|entry| match entry {
            TimelineEntry::UserInputRequest {
                id,
                request_id,
                pending: true,
                ..
            } => Some((id.clone(), request_id.clone())),
            _ => None,
        });
        let request_ids: Vec<String> = self
            .incoming_approvals
            .iter()
            .map(|approval| approval.request_id.clone())
            .chain(thread.entries.iter().filter_map(|entry| match entry {
                TimelineEntry::UserInputRequest {
                    request_id,
                    pending: true,
                    ..
                } => Some(request_id.clone()),
                _ => None,
            }))
            .collect();
        self.typing_guard
            .requests(&request_ids, std::time::Instant::now());
        self.apply_typing_guard(cx);
        self.schedule_typing_guard_idle(cx);
        self.sync_question_panel(thread);
        self.sync_working_timer(cx);
        let sync_start = std::time::Instant::now();
        let stats = self.cache.sync(
            &thread.entries,
            &self.entry_timings,
            &self.turn_checkpoints,
            self.working,
            self.has_more_history,
            self.loading_earlier,
        );
        if let Some((perf_thread, opened_at)) = &self.perf_open
            && perf_thread == &thread.thread_id
        {
            conn_client::perf_log!(
                "app.chat_synced thread={perf_thread} entries={} items={} synchronized={} row_cache_ms={:.1} +{:.1}ms",
                stats.total,
                stats.new_item_count,
                thread.synchronized,
                conn_client::perf::ms_since(sync_start),
                conn_client::perf::ms_since(*opened_at),
            );
        }

        if switched_thread || stats.old_item_count == 0 {
            self.list_state.reset(stats.new_item_count);
            self.list_state.set_follow_mode(FollowMode::Tail);
            self.list_state.scroll_to_end();
        } else if stats.splice_start < stats.splice_old_end
            || stats.splice_start < stats.splice_new_end
        {
            self.list_state.splice(
                stats.splice_start..stats.splice_old_end,
                stats.splice_new_end - stats.splice_start,
            );
            if !was_following_tail && stats.prepended_delta != 0 && stats.new_item_count > 0 {
                let next_ix = prev_scroll
                    .item_ix
                    .saturating_add_signed(stats.prepended_delta)
                    .min(stats.new_item_count - 1);
                self.list_state.scroll_to(ListOffset {
                    item_ix: next_ix,
                    offset_in_item: prev_scroll.offset_in_item,
                });
            }
        }

        cx.notify();
        let working = self.working;
        let can_resume = !working && self.interrupted_run_id.is_some();
        let plan_follow_up = latest_actionable_plan_markdown(thread, working);
        let context_window = thread
            .context_window()
            .map(|cw| composer::ContextWindowSnapshot {
                used_tokens: cw.used_tokens,
                max_tokens: cw.max_tokens,
                total_processed_tokens: cw.total_processed_tokens,
                cost: cw.cost,
                compacts_automatically: cw.compacts_automatically,
                auto_compact_threshold: cw.auto_compact_threshold,
            });
        self.composer.update(cx, |c, cx| {
            c.set_working(working, cx);
            c.set_can_resume(can_resume, cx);
            c.set_plan_follow_up(plan_follow_up, cx);
            c.set_context_window(context_window, cx);
        });
    }

    /// Starts timing the open of `thread_id` for `CONN_GPUI_PERF_LOG` (logs its first paint).
    pub(crate) fn set_perf_open(&mut self, thread_id: String, opened_at: std::time::Instant) {
        if conn_client::perf::enabled() {
            self.perf_open = Some((thread_id, opened_at));
        }
    }

    /// Logs the first paint of a thread opened with [`Self::set_perf_open`] once it has rows
    /// (or is synchronized and empty).
    fn log_first_paint(&mut self) {
        let Some((perf_thread, opened_at)) = &self.perf_open else {
            return;
        };
        if self.thread_id.as_deref() != Some(perf_thread.as_str()) {
            return;
        }
        let items = self.cache.items().len();
        if items == 0 && !self.synchronized {
            return;
        }
        conn_client::perf_log!(
            "app.first_paint thread={perf_thread} items={items} +{:.1}ms",
            conn_client::perf::ms_since(*opened_at)
        );
        self.perf_open = None;
    }

    /// Sets the model display label shown in the composer footer.
    /// Sets the project root used to shorten tool row paths.
    /// The project whose provider overrides apply to the composer (`projectSettingsOverrides`).
    pub(crate) fn set_project_id(
        &mut self,
        project_id: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        self.composer
            .update(cx, |c, cx| c.set_project_id(project_id, cx));
    }

    pub(crate) fn set_workspace_root(&mut self, root: Option<String>, cx: &mut Context<'_, Self>) {
        if self.workspace_root != root {
            self.composer
                .update(cx, |c, cx| c.set_workspace_root(root.clone(), cx));
            self.workspace_root = root;
            cx.notify();
        }
    }

    /// `Read /private/tmp/x/src/main.rs` → `Read src/main.rs` under root `/tmp/x`.
    fn relative_title(&self, title: &str) -> String {
        let Some(root) = self.workspace_root.as_deref() else {
            return title.to_owned();
        };
        let root = root.trim_end_matches('/');
        let private = format!("/private{root}");
        title
            .replace(&format!("{private}/"), "")
            .replace(&format!("{root}/"), "")
    }

    pub(crate) fn set_model_selection(
        &mut self,
        instance_id: Option<String>,
        model: String,
        options: Option<serde_json::Map<String, serde_json::Value>>,
        cx: &mut Context<'_, Self>,
    ) {
        self.composer.update(cx, |c, cx| {
            c.set_model_selection(instance_id, None, model.clone(), options, cx);
        });
        if self.model_label != model {
            self.model_label = model;
            cx.notify();
        }
    }

    /// Updates the composer's bottom `BranchToolbar` context strip.
    /// Workspace facts for the composer's branch picker and workspace selector.
    pub(crate) fn set_branch_context(
        &mut self,
        context: composer::BranchContext,
        cx: &mut Context<'_, Self>,
    ) {
        self.composer
            .update(cx, |c, cx| c.set_branch_context(context, cx));
    }

    pub(crate) fn set_thread_context(
        &mut self,
        branch: Option<String>,
        worktree_active: bool,
        runtime_mode: String,
        interaction_mode: String,
        cx: &mut Context<'_, Self>,
    ) {
        self.composer.update(cx, |c, cx| {
            c.set_thread_context(branch, worktree_active, runtime_mode, interaction_mode, cx);
        });
    }

    /// Shows the pending approval and question the typing guard does not hold. A held first
    /// question hides the question banner, as in Conn.
    fn apply_typing_guard(&mut self, cx: &mut Context<'_, Self>) {
        let (approval, question) = composer_state::guarded_pending_requests(
            &self.incoming_approvals,
            self.incoming_question.as_ref(),
            self.typing_guard.held(),
        );
        self.pending_approval = approval;
        self.pending_question_id = question;
        cx.notify();
    }

    /// Releases held requests once typing pauses (`useComposerTypingGuard` idle timer).
    fn schedule_typing_guard_idle(&mut self, cx: &mut Context<'_, Self>) {
        let Some(deadline) = self.typing_guard.idle_deadline() else {
            self._typing_guard_idle = None;
            return;
        };
        let wait = deadline.saturating_duration_since(std::time::Instant::now());
        self._typing_guard_idle = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(wait).await;
            let _ = this.update(cx, |view, cx| {
                view._typing_guard_idle = None;
                if view.typing_guard.update(
                    composer_state::TypingGuardInput::Idle,
                    std::time::Instant::now(),
                ) {
                    view.apply_typing_guard(cx);
                }
            });
        }));
    }

    /// Request ids the typing guard holds back, so a send leaves those approvals pending.
    pub(crate) fn held_request_ids(&self) -> &HashSet<String> {
        self.typing_guard.held()
    }

    /// True while the typing guard holds the approval card `entry_id`.
    fn approval_held(&self, entry_id: &str) -> bool {
        self.incoming_approvals.iter().any(|approval| {
            approval.entry_id == entry_id && self.typing_guard.held().contains(&approval.request_id)
        })
    }

    /// Drops per-thread card, copy, and fetched-detail state.
    fn reset_card_state(&mut self) {
        self.interrupted_run_id = None;
        self.copied_message_key = None;
        self._copy_reset = None;
        self.pending_card_ids.clear();
        self.pending_approval = None;
        self.pending_question_id = None;
        self.incoming_approvals.clear();
        self.incoming_question = None;
        self.typing_guard.reset_scope();
        self._typing_guard_idle = None;
        self.user_input_cards.clear();
        self.secret_forms.clear();
        self.changed_files_expanded.clear();
        self.changed_files_dir_overrides.clear();
        self.fetched_details.clear();
    }

    /// Markdown options shared by assistant rows and plan cards (copy/wrap code, file links).
    fn markdown_options(&self, cx: &mut Context<'_, Self>) -> markdown::MarkdownOptions<'_> {
        let entity_copy = cx.entity().downgrade();
        let entity_wrap = cx.entity().downgrade();
        let entity_file = cx.entity().downgrade();
        markdown::MarkdownOptions {
            heading_style: markdown::HeadingStyle::Scale,
            copied_code_key: self.copied_code_key.as_deref(),
            on_copy_code: Some(Rc::new(move |key, _window, cx| {
                let _ = entity_copy.update(cx, |view, cx| view.mark_code_copied(key, cx));
            })),
            wrapped_code_keys: Some(&self.wrapped_code_keys),
            on_toggle_wrap_code: Some(Rc::new(move |key, _window, cx| {
                let _ = entity_wrap.update(cx, |view, cx| view.toggle_code_wrap(key, cx));
            })),
            workspace_root: self.workspace_root.as_deref(),
            on_open_file: Some(Rc::new(move |path, _window, cx| {
                let _ = entity_file.update(cx, |_view, cx| {
                    cx.emit(ChatEvent::OpenFile(path));
                });
            })),
            prose: None,
        }
    }

    fn remeasure_for_id(&self, target_id: &str) {
        if let Some(idx) = self.cache.find_item_index_for_id(target_id) {
            self.list_state.remeasure_items(idx..idx + 1);
        }
    }

    pub(super) fn mark_code_copied(&mut self, key: String, cx: &mut Context<'_, Self>) {
        self.remeasure_for_id(&key);
        self.copied_code_key = Some(key);
        cx.notify();
    }

    pub(super) fn toggle_code_wrap(&mut self, key: String, cx: &mut Context<'_, Self>) {
        if !self.wrapped_code_keys.remove(&key) {
            self.wrapped_code_keys.insert(key.clone());
        }
        self.remeasure_for_id(&key);
        cx.notify();
    }

    fn toggle_expanded(&mut self, id: &str, cx: &mut Context<'_, Self>) {
        if !self.expanded_ids.remove(id) {
            self.expanded_ids.insert(id.to_owned());
        }
        self.remeasure_for_id(id);
        cx.notify();
    }

    fn begin_edit_queued(
        &mut self,
        entry_id: String,
        run_id: String,
        text: String,
        attachments: Vec<ChatAttachment>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.editing_queued_run_id = Some(run_id.clone());
        self.composer.update(cx, |c, cx| {
            c.begin_edit_queued(run_id, text, attachments, window, cx);
        });
        self.remeasure_for_id(&entry_id);
        cx.notify();
    }

    fn cancel_edit_queued(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        self.editing_queued_run_id = None;
        self.composer.update(cx, |c, cx| {
            c.cancel_edit_queued(window, cx);
        });
        cx.notify();
    }

    /// Updates which sampled tick slot is hovered on the left-edge minimap rail.
    pub(super) fn set_toc_hovered_slot(
        &mut self,
        slot: usize,
        hovered: bool,
        cx: &mut Context<'_, Self>,
    ) {
        let next = if hovered {
            Some(slot)
        } else if self.toc_hovered_slot == Some(slot) {
            None
        } else {
            self.toc_hovered_slot
        };
        if self.toc_hovered_slot != next {
            self.toc_hovered_slot = next;
            cx.notify();
        }
    }

    /// Clears minimap hover when the pointer leaves the minimap column.
    pub(super) fn clear_toc_hover(&mut self, cx: &mut Context<'_, Self>) {
        if self.toc_hovered_slot.take().is_some() {
            cx.notify();
        }
    }

    /// Pins or unpins the minimap preview on the active tick (used by automation / inspection).
    #[cfg(feature = "automation")]
    pub(crate) fn set_toc_pinned(&mut self, pinned: bool, cx: &mut Context<'_, Self>) {
        let next = if pinned {
            let active = self.active_toc_index();
            let sampled = toc::sample_tick_indices(self.cache.toc().len(), active);
            active
                .and_then(|idx| sampled.iter().position(|&s| s == idx))
                .or_else(|| (!sampled.is_empty()).then_some(0))
        } else {
            None
        };
        if self.toc_pinned_slot != next {
            self.toc_pinned_slot = next;
            cx.notify();
        }
    }

    /// Jumps directly to virtual list item `item_index` (disabling tail follow).
    pub(super) fn jump_to_toc_item(&mut self, item_index: usize, cx: &mut Context<'_, Self>) {
        if item_index >= self.cache.items().len() {
            return;
        }
        self.list_state.set_follow_mode(FollowMode::Normal);
        self.list_state.scroll_to(ListOffset {
            item_ix: item_index,
            offset_in_item: px(0.0),
        });
        cx.notify();
    }

    /// Jumps to 1-based user turn number (automation & keyboard navigation).
    #[cfg(feature = "automation")]
    pub(crate) fn jump_to_toc_turn(
        &mut self,
        turn_number: usize,
        cx: &mut Context<'_, Self>,
    ) -> Result<usize, String> {
        let Some(entry) = self
            .cache
            .toc()
            .iter()
            .find(|entry| entry.turn_number == turn_number)
        else {
            return Err(format!(
                "turn {turn_number} out of range (1..={})",
                self.cache.toc().len()
            ));
        };
        let item_index = entry.item_index;
        self.jump_to_toc_item(item_index, cx);
        Ok(item_index)
    }

    /// Jumps back to the live tail and re-engages bottom auto-follow.
    pub(crate) fn scroll_to_latest(&mut self, cx: &mut Context<'_, Self>) {
        self.list_state.set_follow_mode(FollowMode::Tail);
        self.list_state.scroll_to_end();
        cx.notify();
    }

    /// Emits [`ChatEvent::LoadEarlierHistory`] once while more history is available and idle.
    fn request_earlier_history(&mut self, cx: &mut Context<'_, Self>) {
        if !self.has_more_history || self.loading_earlier {
            return;
        }
        self.loading_earlier = true;
        cx.emit(ChatEvent::LoadEarlierHistory);
        cx.notify();
    }

    /// Auto-loads earlier history when the user scrolls near the top (`item_ix <= 2`) of a
    /// bounded thread.
    fn maybe_request_earlier_history(&mut self, cx: &mut Context<'_, Self>) {
        if !self.has_thread
            || self.draft.is_some()
            || !self.has_more_history
            || self.loading_earlier
            || self.list_state.is_following_tail()
        {
            return;
        }
        let top = self.list_state.logical_scroll_top();
        if top.item_ix <= 2 {
            self.request_earlier_history(cx);
        }
    }

    /// Whether the virtualized timeline is currently following/resting at the tail.
    fn is_at_bottom(&self) -> bool {
        self.cache.items().is_empty()
            || self.list_state.is_following_tail()
            || self.list_state.is_scrolled_to_end() == Some(true)
    }

    /// Index into `self.cache.toc()` for the turn currently visible in the viewport.
    fn active_toc_index(&self) -> Option<usize> {
        let toc = self.cache.toc();
        if toc.is_empty() {
            return None;
        }
        if self.is_at_bottom() {
            return Some(toc.len() - 1);
        }
        let top = self.list_state.logical_scroll_top();
        self.cache.active_toc_index(top.item_ix)
    }

    /// Returns diagnostic metrics for the virtualized timeline & TOC rail.
    #[cfg(feature = "automation")]
    pub(crate) fn timeline_metrics(&self) -> TimelineMetrics {
        let top = self.list_state.logical_scroll_top();
        let active_toc_turn = self
            .active_toc_index()
            .and_then(|idx| self.cache.toc().get(idx))
            .map(|entry| entry.turn_number);
        TimelineMetrics {
            total_entries: self.cache.rows().len(),
            virtual_items: self.cache.items().len(),
            toc_turns: self.cache.toc().len(),
            parsed_markdown_rows: self.cache.parsed_markdown_count(),
            active_toc_turn,
            scroll_top_item: top.item_ix,
            following_tail: self.list_state.is_following_tail(),
            at_bottom: self.is_at_bottom(),
            toc_open: self.toc_hovered_slot.is_some() || self.toc_pinned_slot.is_some(),
        }
    }

    /// Tracks the active turn's start timestamp and maintains a calm 1 Hz ticker while
    /// `self.working` is true so `"Working for 44s"` updates smoothly without GPU spin.
    fn sync_working_timer(&mut self, cx: &mut Context<'_, Self>) {
        if !self.working {
            self.working_started_at_ms = None;
            self._working_tick = None;
            return;
        }

        // Prefer the newest incomplete run's `started_at_ms`, then the newest entry's start time.
        let active_start = self
            .run_timings
            .values()
            .filter(|r| r.completed_at_ms.is_none())
            .filter_map(|r| r.started_at_ms)
            .max()
            .or_else(|| {
                self.run_timings
                    .values()
                    .filter_map(|r| r.started_at_ms)
                    .max()
            });
        if let Some(start) = active_start {
            self.working_started_at_ms = Some(start);
        } else if self.working_started_at_ms.is_none() {
            self.working_started_at_ms = Some(now_epoch_ms());
        }

        if self._working_tick.is_none() {
            self._working_tick = Some(cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(SHIMMER_STEP_INTERVAL).await;
                    let keep_going = this
                        .update(cx, |view, cx| {
                            if view.working {
                                cx.notify();
                                true
                            } else {
                                view._working_tick = None;
                                false
                            }
                        })
                        .unwrap_or(false);
                    if !keep_going {
                        break;
                    }
                }
            }));
        }
    }

    fn work_group_duration_ms(&self, rows: &[CachedRow]) -> Option<u64> {
        let mut min_start: Option<i64> = None;
        let mut max_end: Option<i64> = None;
        let mut single_run: Option<&str> = None;
        let mut multiple_runs = false;
        for row in rows {
            if let Some(timing) = self.entry_timings.get(row.entry.id()) {
                if let Some(start) = timing.started_at_ms {
                    min_start = Some(min_start.map_or(start, |cur| cur.min(start)));
                }
                if let Some(end) = timing.completed_at_ms {
                    max_end = Some(max_end.map_or(end, |cur| cur.max(end)));
                }
                if let Some(run_id) = timing.run_id.as_deref() {
                    match single_run {
                        None => single_run = Some(run_id),
                        Some(existing) if existing != run_id => multiple_runs = true,
                        Some(_) => {}
                    }
                }
            }
        }
        if let (Some(start), Some(end)) = (min_start, max_end)
            && end > start
        {
            return u64::try_from(end - start).ok();
        }
        if !multiple_runs
            && let Some(run_id) = single_run
            && let Some(run) = self.run_timings.get(run_id)
            && let (Some(start), Some(end)) = (run.started_at_ms, run.completed_at_ms)
            && end > start
        {
            return u64::try_from(end - start).ok();
        }
        None
    }

    fn render_empty_no_thread(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let control_bg = hsla(self.tokens.shell_control);
        let border = hsla(self.tokens.shell_inner_border);
        let hover_bg = hsla(self.tokens.shell_highlight);

        let mut card = div()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(12.0))
            .max_w(px(420.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(44.0))
                    .rounded(px(12.0))
                    .bg(hsla(self.tokens.shell_tile))
                    .border_1()
                    .border_color(hsla(self.tokens.shell_tile_border))
                    .child(icons::icon(icons::CHAT_CIRCLE, 20.0, muted)),
            )
            .child(
                div()
                    .text_size(px(15.0))
                    .line_height(px(22.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(fg)
                    .child(if self.has_projects {
                        "Pick a thread or start a new one"
                    } else if self.connected {
                        "Add a project to start a thread"
                    } else {
                        "Connect to a conn-server"
                    }),
            )
            .child(
                div()
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(if self.has_projects {
                        "Select an existing thread in the sidebar or press ⌘N to compose a new one."
                    } else if self.connected {
                        "Use the Add project button in the sidebar to register a local folder."
                    } else {
                        "Open Settings → Connections to connect to an Orbit Node or local conn-server."
                    }),
            );

        if self.has_projects {
            card = card.child(
                div()
                    .id("chat-empty-new-thread")
                    .a11y_button("chat.empty.new-thread", "New thread")
                    .mt(px(4.0))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .h(px(32.0))
                    .px(px(14.0))
                    .rounded(px(8.0))
                    .bg(hsla(self.tokens.primary))
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(hsla(self.tokens.primary_foreground))
                    .cursor_pointer()
                    .hover(|s| s.opacity(0.90))
                    .on_click(cx.listener(|_, _, _, cx| {
                        cx.emit(ChatEvent::StartNewThread);
                    }))
                    .child(icons::icon(
                        "superhero/edit.svg",
                        14.0,
                        hsla(self.tokens.primary_foreground),
                    ))
                    .child("New thread"),
            );
        } else if !self.connected {
            card = card.child(
                div()
                    .id("chat-empty-open-connections")
                    .a11y_button("chat.empty.connections", "Open Connections")
                    .mt(px(4.0))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .h(px(32.0))
                    .px(px(14.0))
                    .rounded(px(8.0))
                    .bg(control_bg)
                    .border_1()
                    .border_color(border)
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg))
                    .on_click(cx.listener(|_, _, _, cx| {
                        cx.emit(ChatEvent::OpenConnections);
                    }))
                    .child("Open Connections"),
            );
        }

        div()
            .flex()
            .flex_1()
            .size_full()
            .items_center()
            .justify_center()
            .px(px(32.0))
            .py(px(48.0))
            .child(card)
            .into_any_element()
    }

    fn render_error_banner(&self, message: &str, cx: &mut Context<'_, Self>) -> AnyElement {
        let destructive = hsla(self.tokens.destructive);
        let hover_bg = hsla(self.tokens.shell_highlight);
        div()
            .w_full()
            .max_w(px(CHAT_CONTENT_MAX_WIDTH_PX))
            .mx_auto()
            .mb(px(8.0))
            .px(px(12.0))
            .py(px(8.0))
            .rounded(px(10.0))
            .bg(hsla_alpha(self.tokens.destructive, 0.10))
            .border_1()
            .border_color(hsla_alpha(self.tokens.destructive, 0.30))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .text_size(px(UI_FONT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(destructive)
            .child(icons::icon(icons::ERROR_CIRCLE, 15.0, destructive))
            .child(div().flex_1().min_w_0().child(message.to_owned()))
            .child(
                div()
                    .id("chat-error-banner-dismiss")
                    .a11y_button("chat.error.dismiss", "Dismiss error")
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(20.0))
                    .flex_shrink_0()
                    .rounded(px(5.0))
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg))
                    .on_click(cx.listener(|view, _, _, cx| {
                        view.error_banner = None;
                        cx.notify();
                    }))
                    .child(icons::icon("superhero/close.svg", 12.0, destructive)),
            )
            .into_any_element()
    }

    fn render_virtual_item(&self, idx: usize, cx: &mut Context<'_, Self>) -> AnyElement {
        let items = self.cache.items();
        let Some(item) = items.get(idx) else {
            return div().into_any_element();
        };
        let rows = self.cache.rows();

        let body = match item {
            VirtualItem::LoadEarlier { loading } => self.render_load_earlier_row(*loading, cx),
            VirtualItem::User {
                row_idx,
                grouped_with_previous,
                grouped_with_next,
            } => {
                if let TimelineEntry::User {
                    id,
                    text,
                    created_by_agent,
                    created_at,
                    attachments,
                    is_steer,
                    ..
                } = &rows[*row_idx].entry
                {
                    if *created_by_agent {
                        self.render_agent_prompt_row(id, text, cx)
                    } else {
                        self.render_user_bubble(
                            UserBubble {
                                id,
                                text,
                                attachments,
                                is_steer: *is_steer,
                                created_at: created_at.as_deref(),
                                grouped_with_previous: *grouped_with_previous,
                                grouped_with_next: *grouped_with_next,
                            },
                            cx,
                        )
                    }
                } else {
                    div().into_any_element()
                }
            }
            VirtualItem::QueuedUser { row_idx } => {
                if let TimelineEntry::QueuedUser {
                    id,
                    run_id,
                    text,
                    attachments,
                    created_at,
                    ..
                } = &rows[*row_idx].entry
                {
                    self.render_queued_user_row(id, run_id, text, attachments, created_at, cx)
                } else {
                    div().into_any_element()
                }
            }
            VirtualItem::Assistant {
                row_idx,
                followed_by_work,
                show_meta,
            } => {
                let row = &rows[*row_idx];
                if let TimelineEntry::Assistant {
                    id,
                    markdown: text,
                    streaming,
                    created_at,
                    run_id,
                    status,
                } = &row.entry
                {
                    // Lazily parse & cache Markdown only when this row enters the viewport.
                    let blocks = row.markdown_blocks();
                    let options = self.markdown_options(cx);
                    let group = SharedString::from(format!("assistant-row-{id}"));
                    let body: AnyElement = if text.is_empty() && !*streaming {
                        // Conn: `text || (streaming ? "" : "(empty response)")`.
                        div()
                            .text_size(px(BODY_FONT_PX))
                            .line_height(px(BODY_LINE_HEIGHT_PX))
                            .text_color(hsla(self.tokens.muted_foreground))
                            .child("(empty response)")
                            .into_any_element()
                    } else {
                        markdown::render_blocks(id, &blocks, &self.tokens, &options)
                    };
                    let mut inner = div().w_full().min_w_0().px(px(4.0)).py(px(2.0)).child(body);
                    if *show_meta {
                        inner = inner.child(self.render_assistant_meta(
                            id,
                            text,
                            *status,
                            run_id.as_deref(),
                            created_at.as_deref(),
                            &group,
                            cx,
                        ));
                    }
                    // Conn `AssistantTimelineRow`: `px-1 py-0.5`, row spacing `pb-2` before work or `pb-4`.
                    div()
                        .id(SharedString::from(format!("chat-assistant-{id}")))
                        .a11y(
                            gpui_kit::Role::Article,
                            SharedString::from(format!("chat.message.assistant.{id}")),
                            "Assistant message",
                        )
                        .group(group)
                        .w_full()
                        .min_w_0()
                        .pb(px(if *followed_by_work { 8.0 } else { 16.0 }))
                        .child(inner)
                        .into_any_element()
                } else {
                    div().into_any_element()
                }
            }
            VirtualItem::WorkGroup {
                id,
                row_start,
                row_end,
                has_active,
                continues_steer,
            } => self.render_work_group(
                id,
                &rows[*row_start..*row_end],
                *has_active,
                *continues_steer,
                cx,
            ),
            VirtualItem::Card { row_idx } => self.render_card(&rows[*row_idx].entry, cx),
            VirtualItem::Approval { row_idx } => {
                if let TimelineEntry::Approval { id, title, detail } = &rows[*row_idx].entry {
                    self.render_approval_card(id, title, detail.as_deref(), cx)
                } else {
                    div().into_any_element()
                }
            }
            VirtualItem::Notice { row_idx } => {
                if let TimelineEntry::Notice { id, text, is_error } = &rows[*row_idx].entry {
                    self.render_notice_row(id, text, *is_error)
                } else {
                    div().into_any_element()
                }
            }
            VirtualItem::ChangedFiles { summary, .. } => {
                self.render_changed_files_card(summary, cx)
            }
            VirtualItem::Working => self.render_working_row(),
        };

        // Conn `.chat-content-lane`: centered `max-w-(--chat-content-max-width)` (736px) with
        // 48px horizontal padding and 16px top/bottom timeline insets carried on first/last row.
        // Scoping each row with `("chat-vitem", idx)` guarantees distinct GPUI element / a11y
        // node IDs across list items even if two timeline entries share an underlying id.
        let mut outer = div()
            .id(("chat-vitem", idx))
            .w_full()
            .min_w_0()
            .px(px(CHAT_LANE_PADDING_X_PX))
            .child(
                div()
                    .w_full()
                    .max_w(px(CHAT_CONTENT_MAX_WIDTH_PX))
                    .mx_auto()
                    .min_w_0()
                    .child(body),
            );
        if idx == 0 {
            outer = outer.pt(px(16.0));
        }
        if idx + 1 == items.len() {
            outer = outer.pb(px(16.0));
        }
        outer.into_any_element()
    }

    /// Renders Conn's quiet top-of-timeline history pagination control (`TimelineHistoryControl`).
    fn render_load_earlier_row(&self, loading: bool, cx: &mut Context<'_, Self>) -> AnyElement {
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let hairline = hsla_alpha(self.tokens.shell_divider, 0.7);
        let label = if loading {
            "Loading earlier…"
        } else {
            "Load earlier messages"
        };

        let mut center = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .flex_shrink_0();
        if loading {
            center = center.child(TurningArc::new(12.0, muted));
        }
        center = center.child(label);

        let mut button = div()
            .id("chat-load-earlier")
            .a11y_button("chat.load-earlier", label)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(12.0))
            .w_full()
            .py(px(6.0))
            .text_size(px(12.0))
            .line_height(px(16.0))
            .text_color(muted)
            .child(div().flex_1().h(px(1.0)).bg(hairline))
            .child(center)
            .child(div().flex_1().h(px(1.0)).bg(hairline));

        if !loading {
            button = button
                .cursor_pointer()
                .hover(move |s| s.text_color(fg))
                .on_click(cx.listener(|view, _, _, cx| {
                    view.request_earlier_history(cx);
                }));
        }

        div().w_full().pb(px(8.0)).child(button).into_any_element()
    }

    /// Dispatches a [`VirtualItem::Card`] row to its Conn card renderer.
    fn render_card(&self, entry: &TimelineEntry, cx: &mut Context<'_, Self>) -> AnyElement {
        match entry {
            TimelineEntry::UserInputRequest {
                id,
                title,
                questions,
                status,
                pending,
                answers,
                ..
            } => self.render_user_input_card(
                id,
                title.as_deref(),
                questions,
                *pending,
                *status,
                answers,
                cx,
            ),
            TimelineEntry::SecretRequest {
                id,
                label,
                reason,
                url,
                file_delivery,
                status,
                pending,
                ..
            } => self.render_secret_card(
                id,
                label,
                reason,
                url.as_deref(),
                *file_delivery,
                *status,
                *pending,
                cx,
            ),
            TimelineEntry::ProposedPlan {
                id,
                title,
                markdown,
                ..
            } => self.render_plan_card(id, title, markdown, cx),
            TimelineEntry::Subagent {
                id,
                child_thread_id,
                title,
                role,
                status,
                summary,
                remote_label,
                started_at,
                completed_at,
                ..
            } => self.render_subagent_row(
                id,
                child_thread_id.as_deref(),
                title,
                role,
                *status,
                summary.as_deref(),
                remote_label.as_deref(),
                started_at.as_deref(),
                completed_at.as_deref(),
                cx,
            ),
            _ => div().into_any_element(),
        }
    }

    fn render_user_bubble(&self, bubble: UserBubble<'_>, cx: &mut Context<'_, Self>) -> AnyElement {
        let UserBubble {
            id,
            text,
            attachments,
            is_steer,
            created_at,
            grouped_with_previous,
            grouped_with_next,
        } = bubble;
        // Conn `TimelineUserMessageRow`: `max-w-[80%] rounded-bubble border-t border-t-(--message-highlight)!
        // bg-message text-message-foreground px-4 pt-2.5 pb-3 text-sm leading-relaxed`.
        let preview: String = text.chars().take(120).collect();
        let mut bubble = div()
            .id(SharedString::from(format!("chat-user-{id}")))
            .a11y(
                gpui_kit::Role::Article,
                SharedString::from(format!("chat.message.user.{id}")),
                preview,
            )
            .relative()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .max_w(relative(0.8))
            .min_w_0()
            .rounded(px(BUBBLE_RADIUS_PX))
            .bg(hsla(self.tokens.message_surface))
            .border_t_1()
            .border_color(message_highlight(&self.tokens))
            .px(px(16.0))
            .pt(px(10.0))
            .pb(px(12.0))
            .text_size(px(BODY_FONT_PX))
            .line_height(px(BODY_LINE_HEIGHT_PX))
            .text_color(hsla(self.tokens.message_foreground));
        if !attachments.is_empty() {
            bubble = bubble.child(self.render_attachment_chips(&format!("user-{id}"), attachments));
        }
        if !text.is_empty() {
            bubble = bubble.child(div().min_w_0().child(text.to_owned()));
        }

        if grouped_with_previous {
            bubble = bubble.rounded_tr(px(BUBBLE_GROUPED_RADIUS_PX));
        }
        if grouped_with_next {
            bubble = bubble.rounded_br(px(BUBBLE_GROUPED_RADIUS_PX));
        }

        let group = SharedString::from(format!("user-row-{id}"));
        let actions = self.render_user_actions(id, text, created_at, &group, cx);
        let mut row = div()
            .group(group)
            .flex()
            .flex_col()
            .items_end()
            .w_full()
            .pb(px(if grouped_with_next { 4.0 } else { 16.0 }));
        if is_steer {
            row = row.child(self.render_steer_marker(id));
        }
        if grouped_with_next {
            // Conn `floatActions`: grouped bubbles float their actions beside the bubble.
            row = row.child(
                bubble.child(
                    div()
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .right(relative(1.0))
                        .mr(px(8.0))
                        .flex()
                        .items_center()
                        .child(actions),
                ),
            );
        } else {
            row = row.child(bubble).child(
                div()
                    .w_full()
                    .max_w(relative(0.8))
                    .pr(px(4.0))
                    .pt(px(2.0))
                    .child(actions),
            );
        }
        row.into_any_element()
    }

    /// Renders a server-backed queued user message at the bottom of the timeline, matching
    /// Conn's `QueuedRunsControl.tsx`:
    /// - Right-aligned bubble with `1px` dashed border (`rounded-[14px]`), unfilled background,
    ///   optional attachment thumbnails/pills, and wrapped prompt text.
    /// - Quiet right-aligned action row below: timestamp, `↑ Send now`, pencil Edit button,
    ///   and `×` Remove button (or `"Editing in the composer"` + `Cancel` while being edited).
    fn render_queued_user_row(
        &self,
        id: &str,
        run_id: &str,
        text: &str,
        attachments: &[ChatAttachment],
        created_at: &str,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let is_editing =
            !run_id.is_empty() && self.editing_queued_run_id.as_deref() == Some(run_id);
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let hover_bg = hsla(self.tokens.shell_highlight);
        let bubble_border = if is_editing {
            hsla_alpha(self.tokens.primary, 0.60)
        } else {
            hsla_alpha(self.tokens.muted_foreground, 0.40)
        };
        let bubble_fg = if is_editing { fg } else { muted };
        let preview: String = text.chars().take(120).collect();

        let mut bubble = div()
            .id(SharedString::from(format!("chat-queued-{id}")))
            .a11y(
                gpui_kit::Role::Article,
                SharedString::from(format!("chat.message.queued.{id}")),
                format!("Queued message: {preview}"),
            )
            .flex()
            .flex_col()
            .gap(px(6.0))
            .max_w(relative(0.8))
            .min_w_0()
            .rounded(px(BUBBLE_RADIUS_PX))
            .border_1()
            .border_dashed()
            .border_color(bubble_border)
            .px(px(12.0))
            .py(px(8.0))
            .text_size(px(BODY_FONT_PX))
            .line_height(px(BODY_LINE_HEIGHT_PX))
            .text_color(bubble_fg);

        if !attachments.is_empty() {
            bubble =
                bubble.child(self.render_attachment_chips(&format!("queued-{id}"), attachments));
        }

        if !text.is_empty() {
            bubble = bubble.child(div().min_w_0().child(text.to_owned()));
        }

        let mut actions = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_end()
            .gap(px(2.0))
            .pr(px(4.0))
            .text_size(px(12.0))
            .line_height(px(16.0))
            .text_color(muted);

        if let Some(timestamp) = format_queued_timestamp(created_at) {
            actions = actions.child(
                div()
                    .mr(px(4.0))
                    .text_size(px(12.0))
                    .line_height(px(16.0))
                    .text_color(muted)
                    .child(timestamp),
            );
        }

        let has_run_id = !run_id.is_empty();
        if is_editing {
            actions = actions
                .child(
                    div()
                        .px(px(4.0))
                        .text_color(fg)
                        .child("Editing in the composer"),
                )
                .child(
                    div()
                        .id(SharedString::from(format!("queued-cancel-edit-{id}")))
                        .a11y_button(
                            SharedString::from(format!("chat.queued.cancel-edit.{id}")),
                            "Cancel editing queued message",
                        )
                        .flex()
                        .flex_row()
                        .items_center()
                        .h(px(22.0))
                        .px(px(6.0))
                        .rounded(px(6.0))
                        .cursor_pointer()
                        .text_color(muted)
                        .hover(move |s| s.bg(hover_bg).text_color(fg))
                        .on_click(cx.listener(|view, _, window, cx| {
                            view.cancel_edit_queued(window, cx);
                        }))
                        .child("Cancel"),
                );
        } else {
            let send_tooltip = if self.working {
                "Send into the current turn"
            } else {
                "Start a turn with this message"
            };
            let run_id_for_send = run_id.to_owned();
            let send_now_btn = div()
                .id(SharedString::from(format!("queued-send-now-{id}")))
                .a11y_button(
                    SharedString::from(format!("chat.queued.send-now.{id}")),
                    "Send now",
                )
                .flex()
                .flex_row()
                .items_center()
                .gap(px(4.0))
                .h(px(22.0))
                .px(px(6.0))
                .rounded(px(6.0))
                .text_color(muted)
                .when(has_run_id, |el| {
                    el.cursor_pointer()
                        .hover(move |s| s.bg(hover_bg).text_color(fg))
                        .on_click(cx.listener(move |_, _, _, cx| {
                            cx.emit(ChatEvent::PromoteQueuedMessage {
                                run_id: run_id_for_send.clone(),
                            });
                        }))
                })
                .conn_tooltip(send_tooltip, &self.tokens)
                .child(icons::icon(icons::ARROW_UP, 12.0, muted))
                .child("Send now");

            let entry_id_for_edit = id.to_owned();
            let run_id_for_edit = run_id.to_owned();
            let text_for_edit = text.to_owned();
            let attachments_for_edit = attachments.to_vec();
            let edit_btn = div()
                .id(SharedString::from(format!("queued-edit-{id}")))
                .a11y_button(
                    SharedString::from(format!("chat.queued.edit.{id}")),
                    "Edit queued message",
                )
                .flex()
                .items_center()
                .justify_center()
                .size(px(22.0))
                .rounded(px(6.0))
                .when(has_run_id, |el| {
                    el.cursor_pointer()
                        .hover(move |s| s.bg(hover_bg).text_color(fg))
                        .on_click(cx.listener(move |view, _, window, cx| {
                            view.begin_edit_queued(
                                entry_id_for_edit.clone(),
                                run_id_for_edit.clone(),
                                text_for_edit.clone(),
                                attachments_for_edit.clone(),
                                window,
                                cx,
                            );
                        }))
                })
                .conn_tooltip("Edit in the composer", &self.tokens)
                .child(icons::icon(icons::EDIT, 12.0, muted));

            let run_id_for_cancel = run_id.to_owned();
            let cancel_btn = div()
                .id(SharedString::from(format!("queued-remove-{id}")))
                .a11y_button(
                    SharedString::from(format!("chat.queued.remove.{id}")),
                    "Remove queued message",
                )
                .flex()
                .items_center()
                .justify_center()
                .size(px(22.0))
                .rounded(px(6.0))
                .when(has_run_id, |el| {
                    el.cursor_pointer()
                        .hover(move |s| s.bg(hover_bg).text_color(fg))
                        .on_click(cx.listener(move |view, _, window, cx| {
                            if view.editing_queued_run_id.as_deref()
                                == Some(run_id_for_cancel.as_str())
                            {
                                view.cancel_edit_queued(window, cx);
                            }
                            cx.emit(ChatEvent::CancelQueuedMessage {
                                run_id: run_id_for_cancel.clone(),
                            });
                        }))
                })
                .conn_tooltip("Remove from queue", &self.tokens)
                .child(icons::icon(icons::CLOSE, 12.0, muted));

            actions = actions
                .child(send_now_btn)
                .child(edit_btn)
                .child(cancel_btn);
        }

        div()
            .flex()
            .flex_col()
            .items_end()
            .gap(px(4.0))
            .w_full()
            .pb(px(12.0))
            .child(bubble)
            .child(actions)
            .into_any_element()
    }

    /// Renders a thread-opening or delegated prompt sent by an agent/CLI as Conn's collapsed
    /// `"Agent <single-line preview> ▸"` row, expanding on click to show the full text.
    fn render_agent_prompt_row(
        &self,
        id: &str,
        text: &str,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let key = format!("agent-msg-{id}");
        let expanded = self.expanded_ids.contains(&key);
        let toggle_key = key.clone();
        let preview = text
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("Prompt");
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);

        let mut col = div()
            .flex()
            .flex_col()
            .w_full()
            .min_w_0()
            .pb(px(12.0))
            .child(
                div()
                    .id(SharedString::from(key))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .w_full()
                    .min_w_0()
                    .px(px(4.0))
                    .py(px(2.0))
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .hover(move |s| s.text_color(fg))
                    .on_click(cx.listener(move |view, _, _, cx| {
                        view.toggle_expanded(&toggle_key, cx);
                    }))
                    .child(icons::icon("superhero/agent.svg", 14.0, muted))
                    .child(
                        div()
                            .flex_shrink_0()
                            .font_weight(FontWeight::MEDIUM)
                            .child("Agent"),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .child(preview.to_owned()),
                    )
                    .child(icons::icon(
                        if expanded {
                            "superhero/chevron-down.svg"
                        } else {
                            "superhero/chevron-right.svg"
                        },
                        13.0,
                        muted,
                    )),
            );

        if expanded {
            col = col.child(
                div()
                    .mt(px(4.0))
                    .ml(px(20.0))
                    .px(px(12.0))
                    .py(px(8.0))
                    .rounded(px(10.0))
                    .bg(hsla(self.tokens.shell_control))
                    .border_1()
                    .border_color(hsla(self.tokens.shell_inner_border))
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(prose_foreground(&self.tokens))
                    .child(text.to_owned()),
            );
        }

        col.into_any_element()
    }

    /// Renders a turn's grouped thinking/tool work entries.
    ///
    /// - Settled groups collapse under Conn's `"Worked"` toggle header (`TurnFoldTimelineRow`).
    /// - Active groups match Conn's `LiveWorkEntryTimelineRow`: collapsed by default to the
    ///   latest wrapped thought preview + current tool action (no spinner, no chevron), and
    ///   clicking expands to reveal every step in the active turn.
    fn render_work_group(
        &self,
        group_id: &str,
        rows: &[CachedRow],
        has_active: bool,
        continues_steer: bool,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let manually_expanded = self.expanded_ids.contains(group_id);
        let toggle_id = group_id.to_owned();

        if has_active && !manually_expanded {
            return self.render_live_work_group(group_id, rows, cx);
        }

        let mut container = div().flex().flex_col().w_full().min_w_0();

        if !has_active {
            // Conn `TurnFoldTimelineRow`: `border-b border-(--shell-divider)! pb-2 pt-1`,
            // button `flex items-center gap-1 rounded-md px-1 text-sm leading-relaxed
            // text-muted-foreground hover:text-foreground`, `size-3.5` (14px) chevron.
            let duration_ms = self.work_group_duration_ms(rows);
            let interrupted = self.interrupted_run_id.as_deref().is_some_and(|run| {
                rows.iter().any(|r| {
                    self.entry_timings
                        .get(r.entry.id())
                        .and_then(|t| t.run_id.as_deref())
                        == Some(run)
                })
            });
            let worked_label = format_fold_label(duration_ms, interrupted, continues_steer);
            let worked_ax_id = SharedString::from(format!("chat.work-group.{group_id}"));
            let fold_btn = div()
                .id(SharedString::from(format!("fold-{group_id}")))
                .a11y_button(worked_ax_id, worked_label.clone())
                .aria_expanded(manually_expanded)
                .flex()
                .flex_row()
                .items_center()
                .gap(px(4.0))
                .px(px(4.0))
                .rounded(px(6.0))
                .cursor_pointer()
                .text_size(px(BODY_FONT_PX))
                .line_height(px(BODY_LINE_HEIGHT_PX))
                .text_color(hsla(self.tokens.muted_foreground))
                .hover(|s| s.text_color(hsla(self.tokens.foreground)))
                .on_click(cx.listener(move |view, _, _, cx| {
                    view.toggle_expanded(&toggle_id, cx);
                }))
                .child(worked_label)
                .child(icons::icon(
                    if manually_expanded {
                        icons::CARET_DOWN
                    } else {
                        icons::CARET_RIGHT
                    },
                    14.0,
                    hsla(self.tokens.muted_foreground),
                ));

            let header = div()
                .w_full()
                .min_w_0()
                .pt(px(4.0))
                .pb(px(8.0))
                .border_b_1()
                .border_color(hsla(self.tokens.shell_divider))
                .child(div().flex().flex_row().items_center().child(fold_btn));

            container = container.child(header);
        } else {
            // Active group explicitly expanded by clicking the live summary: offer a quiet collapse toggle.
            let collapse_btn = div()
                .id(SharedString::from(format!("fold-live-{group_id}")))
                .a11y_button(
                    SharedString::from(format!("chat.work-group.{group_id}")),
                    "Collapse live steps",
                )
                .aria_expanded(true)
                .flex()
                .flex_row()
                .items_center()
                .gap(px(4.0))
                .px(px(4.0))
                .py(px(2.0))
                .rounded(px(6.0))
                .cursor_pointer()
                .text_size(px(UI_FONT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(hsla(self.tokens.muted_foreground))
                .hover(|s| s.text_color(hsla(self.tokens.foreground)))
                .on_click(cx.listener(move |view, _, _, cx| {
                    view.toggle_expanded(&toggle_id, cx);
                }))
                .child(format!("Hide {} steps", rows.len()))
                .child(icons::icon(
                    icons::CARET_DOWN,
                    12.0,
                    hsla(self.tokens.muted_foreground),
                ));
            container = container.child(div().flex().flex_row().items_center().child(collapse_btn));
        }

        if manually_expanded {
            let mut list = div().flex().flex_col().w_full().min_w_0().pt(px(4.0));
            for row in rows {
                list = list.child(self.render_work_entry(row, cx));
            }
            container = container.pb(px(8.0)).child(list);
        } else {
            // Conn `turn-fold` row spacing: `pb-1.5` (6px).
            container = container.pb(px(6.0));
        }

        container.into_any_element()
    }

    /// Renders Conn's `LiveWorkEntryTimelineRow`: 1:1 port of `MessagesTimeline.logic.ts:1540-1575`
    /// and `TimelineWorkGroupRows.tsx:488-580`:
    /// - Row 1 (if any reasoning entry has text): static brain icon + frozen `liveThoughtLine`
    ///   (bold opening heading or first sentence only — never mutates as later sentences stream).
    /// - Row 2 (`LiveActivityRow`): latest running entry (or latest entry if none currently
    ///   running), shimmering continuously while the turn is active (`latestToolKeepsActivityLive`
    ///   keeps completed tools shimmering between steps, and renders shimmering `"Thinking"`
    ///   when the latest entry is that reasoning item).
    fn render_live_work_group(
        &self,
        group_id: &str,
        rows: &[CachedRow],
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let toggle_id = group_id.to_owned();
        let muted = hsla(self.tokens.muted_foreground);
        let icon_muted = muted_icon(&self.tokens);
        let destructive = hsla(self.tokens.destructive);
        let bright_fg = hsla(self.tokens.foreground);

        // Conn `latestThoughtEntry`: most recent reasoning entry with non-empty text.
        let latest_thought = rows.iter().rev().find_map(|row| match &row.entry {
            TimelineEntry::Thinking { id, text, .. } => {
                let preview = live_thought_preview(text)?;
                Some((id.as_str(), preview))
            }
            _ => None,
        });

        // Conn `latestRunningToolEntry ?? latestVisibleToolEntry`:
        let latest_running = rows
            .iter()
            .rev()
            .map(|r| &r.entry)
            .find(|entry| match entry {
                TimelineEntry::Tool { status, .. } => matches!(status, ItemStatus::Running),
                TimelineEntry::Thinking { streaming, .. } => *streaming,
                _ => false,
            });
        let active_entry = latest_running.or_else(|| rows.last().map(|r| &r.entry));

        let mut col = div()
            .id(SharedString::from(format!("live-work-{group_id}")))
            .a11y_button(
                SharedString::from(format!("chat.work-group.{group_id}")),
                "Expand live work steps",
            )
            .aria_expanded(false)
            .flex()
            .flex_col()
            .gap(px(4.0))
            .w_full()
            .min_w_0()
            .pt(px(4.0))
            .pb(px(8.0))
            .rounded(px(6.0))
            .cursor_pointer()
            .on_click(cx.listener(move |view, _, _, cx| {
                view.toggle_expanded(&toggle_id, cx);
            }));

        if let Some((thought_id, ref thought_text)) = latest_thought {
            // Conn `WorkLogRow wrapLabel`: `items-start gap-1.5 min-h-6 text-sm leading-relaxed`.
            col = col.child(
                div()
                    .id(SharedString::from(format!("live-thought-{thought_id}")))
                    .a11y_group(
                        format!("timeline.work.{thought_id}.live"),
                        format!("Thought: {}", ax_snippet(thought_text)),
                    )
                    .flex()
                    .flex_row()
                    .items_start()
                    .gap(px(6.0))
                    .w_full()
                    .min_w_0()
                    .min_h(px(24.0))
                    .px(px(2.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(24.0))
                            .flex_none()
                            .child(icons::icon(icons::BRAIN, 16.0, icon_muted)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(px(BODY_FONT_PX))
                            .line_height(px(BODY_LINE_HEIGHT_PX))
                            .text_color(muted)
                            .child(thought_text.clone()),
                    ),
            );
        }

        if let Some(entry) = active_entry {
            match entry {
                TimelineEntry::Tool {
                    id,
                    kind,
                    title,
                    status,
                    ..
                } => {
                    let rel_title = self.relative_title(title);
                    let ax_label = tool_ax_label(kind, &rel_title, *status);
                    let failed = matches!(status, ItemStatus::Failed);
                    // Conn `latestToolKeepsActivityLive`: active when running OR succeeded during
                    // an active turn (so shimmer stays alive between consecutive tool calls).
                    let shimmer = self.working && !failed;
                    let icon_path = if failed {
                        icons::ERROR_CIRCLE
                    } else {
                        icons::tool_icon_path(kind, &rel_title)
                    };
                    let (ic_color, text_color) = if failed {
                        (destructive, destructive)
                    } else {
                        (icon_muted, muted)
                    };
                    let label_el: AnyElement = if shimmer {
                        shimmer_text(&rel_title, muted, bright_fg).into_any_element()
                    } else {
                        rel_title.into_any_element()
                    };
                    col = col.child(
                        div()
                            .id(SharedString::from(format!("live-tool-{id}")))
                            .a11y_group(format!("timeline.work.{id}.live"), ax_label)
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.0))
                            .w_full()
                            .min_w_0()
                            .min_h(px(24.0))
                            .px(px(2.0))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .size(px(24.0))
                                    .flex_none()
                                    .child(icons::icon(icon_path, 16.0, ic_color)),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .overflow_hidden()
                                    .text_ellipsis()
                                    .whitespace_nowrap()
                                    .text_size(px(BODY_FONT_PX))
                                    .line_height(px(BODY_LINE_HEIGHT_PX))
                                    .text_color(text_color)
                                    .child(label_el),
                            ),
                    );
                }
                TimelineEntry::Thinking { id, streaming, .. } => {
                    // Conn `thoughtIsStatus`: when `row.entry === row.thought` (or thought has no
                    // preview text yet), row 2 shows shimmering `"Thinking"` while active.
                    let thought_is_status = latest_thought.is_none()
                        || latest_thought
                            .as_ref()
                            .is_some_and(|(tid, _)| *tid == id.as_str());
                    if thought_is_status {
                        let shimmer = self.working || *streaming;
                        let label_el: AnyElement = if shimmer {
                            shimmer_text("Thinking", muted, bright_fg).into_any_element()
                        } else {
                            "Thought".into_any_element()
                        };
                        col = col.child(
                            div()
                                .id(SharedString::from(format!("live-status-{id}")))
                                .a11y_group(
                                    format!("timeline.work.{id}.live"),
                                    if shimmer { "Thinking" } else { "Thought" },
                                )
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(6.0))
                                .w_full()
                                .min_w_0()
                                .min_h(px(24.0))
                                .px(px(2.0))
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .size(px(24.0))
                                        .flex_none()
                                        .child(icons::icon(icons::BRAIN, 16.0, icon_muted)),
                                )
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .text_size(px(BODY_FONT_PX))
                                        .line_height(px(BODY_LINE_HEIGHT_PX))
                                        .text_color(muted)
                                        .child(label_el),
                                ),
                        );
                    }
                }
                _ => {}
            }
        }

        col.into_any_element()
    }

    fn render_work_entry(&self, row: &CachedRow, cx: &mut Context<'_, Self>) -> AnyElement {
        match &row.entry {
            TimelineEntry::Thinking {
                id,
                text,
                streaming,
            } => self.render_thinking_row(id, text, *streaming, cx),
            TimelineEntry::Tool {
                id,
                kind,
                title,
                detail,
                status,
                output_omitted,
            } => {
                let title = self.relative_title(title);
                self.render_tool_row(
                    id,
                    kind,
                    &title,
                    detail.as_deref(),
                    *status,
                    *output_omitted,
                    cx,
                )
            }
            _ => div().into_any_element(),
        }
    }

    fn render_thinking_row(
        &self,
        id: &str,
        text: &str,
        streaming: bool,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let expanded = self.expanded_ids.contains(id);
        let toggle_id = id.to_owned();
        let trimmed = text.trim();
        let has_body = !trimmed.is_empty();
        let preview_line = trimmed
            .lines()
            .find(|line| !line.trim().is_empty())
            .map(str::trim);
        let label = if expanded || preview_line.is_none() {
            if streaming { "Thinking" } else { "Thought" }.to_owned()
        } else {
            preview_line.unwrap_or("Thought").to_owned()
        };

        let leading: AnyElement =
            icons::icon(icons::BRAIN, 16.0, muted_icon(&self.tokens)).into_any_element();
        let muted = hsla(self.tokens.muted_foreground);
        let bright_fg = hsla(self.tokens.foreground);
        let label_el: AnyElement = if streaming {
            shimmer_text(&label, muted, bright_fg).into_any_element()
        } else {
            label.into_any_element()
        };

        let ax_label = format!(
            "{}: {}",
            if streaming { "Thinking" } else { "Thought" },
            ax_snippet(preview_line.unwrap_or_default())
        );
        let ax_id = format!("timeline.work.{id}");
        // Conn `WorkLogRow`: `min-h-6` (24px), `gap-1.5` (6px), `px-0.5`, `24px` icon box, `text-sm leading-relaxed`.
        let mut line = div()
            .id(SharedString::from(format!("thinking-{id}")))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .w_full()
            .min_w_0()
            .min_h(px(24.0))
            .px(px(2.0))
            .rounded(px(6.0))
            .cursor_pointer()
            .text_size(px(BODY_FONT_PX))
            .line_height(px(BODY_LINE_HEIGHT_PX))
            .text_color(muted)
            .hover(|s| s.text_color(hsla(self.tokens.foreground)))
            .on_click(cx.listener(move |view, _, _, cx| {
                view.toggle_expanded(&toggle_id, cx);
            }))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(24.0))
                    .flex_none()
                    .child(leading),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .child(label_el),
            );

        line = if has_body {
            line.a11y_button(ax_id.clone(), ax_label)
                .aria_expanded(expanded)
        } else {
            line.a11y_group(ax_id.clone(), ax_label)
        };
        if has_body {
            line = line.child(
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(16.0))
                    .flex_none()
                    .child(icons::icon(
                        if expanded {
                            icons::CARET_DOWN
                        } else {
                            icons::CARET_RIGHT
                        },
                        12.0,
                        muted_icon(&self.tokens),
                    )),
            );
        }

        let mut container = div().flex().flex_col().w_full().min_w_0().child(line);
        if expanded && has_body {
            // Conn `WorkLogDetails kind="text"`: `ms-7` (28px), `px-0.5 py-1`.
            container = container.child(
                div()
                    .id(SharedString::from(format!("thinking-detail-{id}")))
                    .a11y_group(format!("{ax_id}.detail"), "Thought details")
                    .ml(px(28.0))
                    .px(px(2.0))
                    .py(px(4.0))
                    .text_size(px(BODY_FONT_PX))
                    .line_height(px(BODY_LINE_HEIGHT_PX))
                    .text_color(prose_foreground(&self.tokens))
                    .child(trimmed.to_owned()),
            );
        }
        container.into_any_element()
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "mirrors the Conn component props one to one"
    )]
    fn render_tool_row(
        &self,
        id: &str,
        kind: &str,
        title: &str,
        detail: Option<&str>,
        status: ItemStatus,
        output_omitted: bool,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let expanded = self.expanded_ids.contains(id);
        let toggle_id = id.to_owned();
        // An omitted output fetches lazily on expand (`turnItemNeedsDetailFetch`).
        let fetched = self.fetched_details.get(id);
        let fetched_text: Option<String> = match fetched {
            Some(cards::DetailFetch::Loaded(Some(text))) => Some(text.clone()),
            Some(cards::DetailFetch::Loading) => Some("Loading output…".to_owned()),
            Some(cards::DetailFetch::Failed(err)) => Some(format!("Could not load output: {err}")),
            Some(cards::DetailFetch::Loaded(None)) | None => None,
        };
        let detail_owned: Option<String> = fetched_text.or_else(|| detail.map(str::to_owned));
        let detail = detail_owned.as_deref();
        let has_detail = output_omitted || detail.is_some_and(|d| !d.trim().is_empty());

        let muted = hsla(self.tokens.muted_foreground);
        let bright_fg = hsla(self.tokens.foreground);
        let (icon_color, title_color) = match status {
            ItemStatus::Failed => (hsla(self.tokens.destructive), hsla(self.tokens.destructive)),
            ItemStatus::Running | ItemStatus::Completed => (muted_icon(&self.tokens), muted),
        };
        let title_el: AnyElement = if matches!(status, ItemStatus::Running) {
            shimmer_text(title, muted, bright_fg).into_any_element()
        } else {
            title.to_owned().into_any_element()
        };

        let leading: AnyElement = match status {
            ItemStatus::Failed => {
                icons::icon(icons::ERROR_CIRCLE, 16.0, icon_color).into_any_element()
            }
            ItemStatus::Running | ItemStatus::Completed => {
                icons::icon(icons::tool_icon_path(kind, title), 16.0, icon_color).into_any_element()
            }
        };

        let ax_id = format!("timeline.work.{id}");
        let ax_label = tool_ax_label(kind, title, status);
        // Conn `WorkLogRow`: `min-h-6` (24px), `gap-1.5` (6px), `px-0.5`, `24px` icon box, `text-sm leading-relaxed`.
        let mut line = div()
            .id(SharedString::from(format!("tool-{id}")))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .w_full()
            .min_w_0()
            .min_h(px(24.0))
            .px(px(2.0))
            .rounded(px(6.0))
            .text_size(px(BODY_FONT_PX))
            .line_height(px(BODY_LINE_HEIGHT_PX))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(24.0))
                    .flex_none()
                    .child(leading),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .text_color(title_color)
                    .child(title_el),
            );

        line = if has_detail {
            line.a11y_button(ax_id.clone(), ax_label)
                .aria_expanded(expanded)
        } else {
            line.a11y_group(ax_id.clone(), ax_label)
        };
        if has_detail {
            line = line
                .cursor_pointer()
                .hover(|s| s.text_color(hsla(self.tokens.foreground)))
                .on_click(cx.listener(move |view, _, _, cx| {
                    if output_omitted && !view.expanded_ids.contains(&toggle_id) {
                        view.fetch_omitted_detail(&toggle_id, cx);
                    }
                    view.toggle_expanded(&toggle_id, cx);
                }))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(px(16.0))
                        .flex_none()
                        .child(icons::icon(
                            if expanded {
                                icons::CARET_DOWN
                            } else {
                                icons::CARET_RIGHT
                            },
                            12.0,
                            muted_icon(&self.tokens),
                        )),
                );
        }

        let mut container = div().flex().flex_col().w_full().min_w_0().child(line);
        if expanded && let Some(detail_text) = detail.filter(|d| !d.trim().is_empty()) {
            // Conn `WorkLogDetails kind="panel"` + `toolCallExpandedBodyClassName`:
            // indented under label (`30px`), monospace `11.5px` / `18px`, `muted_foreground`.
            container = container.child(
                div()
                    .id(SharedString::from(format!("tool-detail-{id}")))
                    .a11y_group(
                        format!("{ax_id}.detail"),
                        format!("Details: {}", ax_snippet(title)),
                    )
                    .ml(px(30.0))
                    .mt(px(2.0))
                    .mb(px(6.0))
                    .px(px(10.0))
                    .py(px(8.0))
                    .rounded(px(8.0))
                    .bg(hsla(self.tokens.code_background))
                    .border_1()
                    .border_color(hsla(self.tokens.shell_divider))
                    .font_family(MONO_FONT_FAMILY)
                    .text_size(px(11.5))
                    .line_height(px(18.0))
                    .text_color(hsla(self.tokens.muted_foreground))
                    .child(detail_text.to_owned()),
            );
        }
        container.into_any_element()
    }

    fn render_notice_row(&self, id: &str, text: &str, is_error: bool) -> AnyElement {
        let ax_id = format!("timeline.notice.{id}");
        let element_id = SharedString::from(format!("notice-{id}"));
        if is_error {
            // Conn `WorkEntryLogRow` error: `WorkLogRow` with `CircleAlertIcon` + destructive `text-sm font-medium`.
            return div()
                .id(element_id)
                .a11y(
                    gpui_kit::Role::Alert,
                    ax_id,
                    format!("Error: {}", ax_snippet(text)),
                )
                .w_full()
                .min_w_0()
                .pb(px(8.0))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_start()
                        .gap(px(6.0))
                        .min_h(px(24.0))
                        .px(px(2.0))
                        .py(px(2.0))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .justify_center()
                                .size(px(24.0))
                                .flex_none()
                                .child(icons::icon(
                                    icons::ERROR_CIRCLE,
                                    16.0,
                                    hsla(self.tokens.destructive),
                                )),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .text_size(px(BODY_FONT_PX))
                                .line_height(px(BODY_LINE_HEIGHT_PX))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(hsla(self.tokens.destructive))
                                .child(text.to_owned()),
                        ),
                )
                .into_any_element();
        }

        // Conn `TimelineSystemDivider`: centered pill between 1px `--shell-divider` hairlines.
        div()
            .id(element_id)
            .a11y_group(ax_id, format!("Notice: {}", ax_snippet(text)))
            .w_full()
            .min_w_0()
            .pb(px(8.0))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .py(px(8.0))
                    .text_size(px(12.0))
                    .line_height(px(16.0))
                    .text_color(hsla(self.tokens.muted_foreground))
                    .child(
                        div()
                            .flex_1()
                            .h(px(1.0))
                            .bg(hsla(self.tokens.shell_divider)),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.0))
                            .px(px(8.0))
                            .py(px(4.0))
                            .child(icons::icon(
                                icons::INFO,
                                12.0,
                                hsla(self.tokens.muted_foreground),
                            ))
                            .child(text.to_owned()),
                    )
                    .child(
                        div()
                            .flex_1()
                            .h(px(1.0))
                            .bg(hsla(self.tokens.shell_divider)),
                    ),
            )
            .into_any_element()
    }

    /// Renders Conn's `WorkingTimelineRow`: `border-b border-(--shell-divider)! pb-2 pt-1`,
    /// `h-6 px-1 text-sm leading-relaxed text-muted-foreground tabular-nums` — plain `"Working for 44s"`
    /// text with no spinner, plus Conn's `ThinkingTimelineRow` (brain icon + shimmering `"Thinking"`)
    /// when no active work group has arrived yet.
    fn render_working_row(&self) -> AnyElement {
        let label = self
            .working_started_at_ms
            .map(|start| {
                let elapsed_ms = (now_epoch_ms() - start).max(0) as u64;
                format_working_elapsed(elapsed_ms)
            })
            .unwrap_or_else(|| "Working...".to_owned());
        let has_live_work_group = matches!(
            self.cache
                .items()
                .iter()
                .rev()
                .find(|item| !matches!(item, VirtualItem::QueuedUser { .. })),
            Some(VirtualItem::WorkGroup {
                has_active: true,
                ..
            })
        );
        let muted = hsla(self.tokens.muted_foreground);
        let icon_muted = muted_icon(&self.tokens);
        let bright_fg = hsla(self.tokens.foreground);

        let mut col = div()
            .flex()
            .flex_col()
            .w_full()
            .min_w_0()
            .pb(px(4.0))
            .child(
                div()
                    .w_full()
                    .pt(px(4.0))
                    .pb(px(8.0))
                    .border_b_1()
                    .border_color(hsla(self.tokens.shell_divider))
                    .child(
                        div()
                            .id("timeline-working")
                            .a11y_group("timeline.working", label.clone())
                            .flex()
                            .flex_row()
                            .items_center()
                            .h(px(24.0))
                            .px(px(4.0))
                            .text_size(px(BODY_FONT_PX))
                            .line_height(px(BODY_LINE_HEIGHT_PX))
                            .text_color(muted)
                            .child(label),
                    ),
            );

        if !has_live_work_group {
            col = col.child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .w_full()
                    .min_w_0()
                    .min_h(px(24.0))
                    .pt(px(4.0))
                    .pb(px(4.0))
                    .px(px(2.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(24.0))
                            .flex_none()
                            .child(icons::icon(icons::BRAIN, 16.0, icon_muted)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(px(BODY_FONT_PX))
                            .line_height(px(BODY_LINE_HEIGHT_PX))
                            .text_color(muted)
                            .child(shimmer_text("Thinking", muted, bright_fg)),
                    ),
            );
        }

        col.into_any_element()
    }
}

impl Render for ChatView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        self.log_first_paint();
        if !self.pending_card_ids.is_empty()
            || !self.user_input_cards.is_empty()
            || !self.secret_forms.is_empty()
        {
            self.ensure_card_inputs(window, cx);
        }
        if !self.has_thread && self.draft.is_none() {
            return div()
                .flex()
                .flex_col()
                .size_full()
                .min_h_0()
                .min_w_0()
                .child(self.render_empty_no_thread(cx));
        }

        let draft_key = if let Some(draft) = &self.draft {
            Some(composer_state::new_thread_draft_key(&draft.draft_id))
        } else {
            self.thread_id
                .as_deref()
                .map(composer_state::thread_draft_key)
        };
        // A question's answer lives apart from the thread's draft, as in Conn.
        let draft_key = self
            .pending_question_id
            .as_deref()
            .filter(|_| self.draft.is_none())
            .map(composer_state::question_answer_draft_key)
            .or(draft_key);
        let pending_request = self.composer_pending_request();
        self.composer.update(cx, |c, cx| {
            c.set_pending_request(pending_request, cx);
            c.sync_draft_key(draft_key.as_deref(), window, cx)
        });

        if let Some(draft) = self.draft.clone() {
            return div()
                .flex()
                .flex_col()
                .size_full()
                .min_h_0()
                .min_w_0()
                .child(self.render_draft_hero(&draft, window, cx));
        }

        let timeline: AnyElement = if self.cache.items().is_empty() && !self.synchronized {
            let muted = hsla(self.tokens.muted_foreground);
            div()
                .id("chat-timeline-scroll")
                .a11y(gpui_kit::Role::Log, "chat.timeline", "Loading conversation")
                .flex_1()
                .min_h_0()
                .w_full()
                .px(px(CHAT_LANE_PADDING_X_PX))
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.0))
                        .py(px(64.0))
                        .text_size(px(BODY_FONT_PX))
                        .line_height(px(BODY_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child(TurningArc::new(14.0, muted))
                        .child("Loading thread…"),
                )
                .into_any_element()
        } else if self.cache.items().is_empty() {
            div()
                .id("chat-timeline-scroll")
                .a11y(
                    gpui_kit::Role::Log,
                    "chat.timeline",
                    "Conversation timeline",
                )
                .flex_1()
                .min_h_0()
                .w_full()
                .px(px(CHAT_LANE_PADDING_X_PX))
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .py(px(64.0))
                        .text_size(px(BODY_FONT_PX))
                        .line_height(px(BODY_LINE_HEIGHT_PX))
                        .text_color(hsla(self.tokens.muted_foreground))
                        .child("Send a message to start the conversation."),
                )
                .into_any_element()
        } else {
            let list_state = self.list_state.clone();
            let virtual_list = list(
                list_state.clone(),
                cx.processor(|this, ix: usize, _window, cx| this.render_virtual_item(ix, cx)),
            )
            .size_full()
            .min_h_0();

            let active_toc = self.active_toc_index();
            let hovered_slot = self.toc_hovered_slot.or(self.toc_pinned_slot);
            let show_latest_pill = !self.is_at_bottom();

            let mut container = div()
                .id("chat-timeline-scroll")
                .a11y(
                    gpui_kit::Role::Log,
                    "chat.timeline",
                    "Conversation timeline",
                )
                .relative()
                .flex_1()
                .min_h_0()
                .w_full()
                .min_w_0()
                .overflow_hidden()
                .child(virtual_list)
                .child(
                    div()
                        .absolute()
                        .inset_0()
                        .child(div().size_full().vertical_scrollbar(&list_state)),
                );

            if let Some(toc_overlay) = toc::render_toc_overlay(
                self.cache.toc(),
                active_toc,
                hovered_slot,
                &self.tokens,
                cx,
            ) {
                container = container.child(toc_overlay);
            }
            if show_latest_pill {
                container = container.child(toc::render_scroll_to_bottom_pill(&self.tokens, cx));
            }
            container.into_any_element()
        };

        let provider_banner = self.render_provider_banner(cx);
        let question_banner = self.render_question_banner(window, cx);
        let banner_docked = question_banner.is_some();
        self.composer
            .update(cx, |c, cx| c.set_stash_docked(banner_docked, cx));

        let mut composer_lane = div()
            .flex_none()
            .w_full()
            .px(px(CHAT_LANE_PADDING_X_PX))
            .pt(px(8.0));
        if let Some(error) = self.error_banner.as_deref() {
            composer_lane = composer_lane.child(self.render_error_banner(error, cx));
        }
        composer_lane = composer_lane.child(
            div()
                .w_full()
                .max_w(px(CHAT_CONTENT_MAX_WIDTH_PX))
                .mx_auto()
                .when_some(question_banner, |lane, banner| lane.child(banner))
                .child(self.composer.clone()),
        );

        div()
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .min_w_0()
            .relative()
            .child(timeline)
            .child(composer_lane)
            .when_some(provider_banner, |root, banner| {
                root.child(
                    div()
                        .absolute()
                        .top_0()
                        .left_0()
                        .right_0()
                        .flex()
                        .justify_center()
                        .px(px(CHAT_LANE_PADDING_X_PX))
                        .pt(px(12.0))
                        .child(banner),
                )
            })
    }
}

/// Formats an ISO-8601 queued message timestamp as local `HH:MM` (falling back to UTC `HH:MM`).
#[must_use]
fn format_queued_timestamp(iso: &str) -> Option<String> {
    let epoch_ms = conn_state::parse_iso8601_epoch_ms(iso)?;
    let epoch_secs = epoch_ms.div_euclid(1000);
    #[cfg(unix)]
    {
        let raw_time = epoch_secs as libc::time_t;
        let mut local_tm = std::mem::MaybeUninit::<libc::tm>::zeroed();
        // SAFETY: `raw_time` is a valid `time_t` by value and `local_tm` is valid writable
        // stack storage; `localtime_r` is thread-safe and returns null on failure.
        let ptr = unsafe { libc::localtime_r(&raw_time, local_tm.as_mut_ptr()) };
        if !ptr.is_null() {
            // SAFETY: `localtime_r` succeeded and initialized `local_tm`.
            let tm = unsafe { local_tm.assume_init() };
            return Some(format!("{:02}:{:02}", tm.tm_hour, tm.tm_min));
        }
    }
    let day_secs = epoch_secs.rem_euclid(86_400);
    let hour = day_secs / 3600;
    let minute = (day_secs % 3600) / 60;
    Some(format!("{hour:02}:{minute:02}"))
}

/// Current wall-clock timestamp in Unix epoch milliseconds.
#[must_use]
fn now_epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// First line of `text`, cut at 120 characters, for an AX label.
fn ax_snippet(text: &str) -> String {
    const MAX_CHARS: usize = 120;
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    match line.char_indices().nth(MAX_CHARS) {
        Some((cut, _)) => format!("{}…", &line[..cut]),
        None => line.to_owned(),
    }
}

/// AX label of a work-log tool row: the kind (when the title does not say it) plus the title.
fn tool_ax_label(kind: &str, title: &str, status: ItemStatus) -> String {
    let title = ax_snippet(title);
    let mut label = match kind {
        "command" => format!("Command: {title}"),
        "web_search" => format!("Web search: {title}"),
        "subagent" => format!("Subagent: {title}"),
        "dynamic_tool" | "tool" | "mcp" => format!("Tool: {title}"),
        "file_change" | "file_read" | "read" | "file_search" | "todo_list" | "thread_created"
        | "approval" | "secret_request" | "link_request" => title,
        _ => format!("Tool: {title}"),
    };
    if matches!(status, ItemStatus::Failed) {
        label.push_str(" (failed)");
    }
    label
}

/// Formats Conn's live `WorkingTimelineRow` header (`Working for 44s` / `Working for 1m 12s`).
#[must_use]
fn format_working_elapsed(elapsed_ms: u64) -> String {
    let secs = elapsed_ms / 1000;
    if secs < 60 {
        format!("Working for {secs}s")
    } else {
        let mins = secs / 60;
        let rem = secs % 60;
        if rem == 0 {
            format!("Working for {mins}m")
        } else {
            format!("Working for {mins}m {rem}s")
        }
    }
}

/// 1:1 port of Conn's `liveThoughtLine` (`packages/client-runtime/src/work-log/presentation.ts:765-778`):
/// a bold-only opening line (Codex summary heading) wins; otherwise strips lightweight Markdown
/// and cuts after the FIRST sentence (`.`, `?`, `!` + optional closing quote/paren followed by
/// whitespace), so the preview stays frozen once the opening sentence is complete.
#[must_use]
fn live_thought_preview(markdown: &str) -> Option<String> {
    let trimmed = markdown.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Check bold-only opening line: `^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)`.
    let first_line = trimmed.lines().next().unwrap_or("").trim();
    let heading = first_line
        .strip_prefix("**")
        .and_then(|rest| rest.strip_suffix("**"))
        .filter(|inner| !inner.is_empty() && !inner.contains('*'));

    let source = heading.unwrap_or(trimmed);
    let stripped_links = strip_markdown_links(source);
    let cleaned = stripped_links
        .lines()
        .map(strip_markdown_line_prefix)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .replace("**", "")
        .replace("~~", "")
        .replace('`', "");
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    if heading.is_some() {
        return Some(collapsed);
    }

    // Cut after the first `.`, `?`, or `!` (plus optional closing quote/paren) followed by space.
    let bytes = collapsed.as_bytes();
    let mut chars = collapsed.char_indices().peekable();
    while let Some((idx, ch)) = chars.next() {
        if matches!(ch, '.' | '?' | '!') {
            let mut end = idx + ch.len_utf8();
            if let Some(&(next_idx, next_ch)) = chars.peek()
                && matches!(next_ch, '"' | '\'' | '\u{201D}' | '\u{2019}' | ')')
            {
                end = next_idx + next_ch.len_utf8();
                chars.next();
            }
            if bytes.get(end).is_some_and(u8::is_ascii_whitespace) {
                return Some(collapsed[..end].to_owned());
            }
        }
    }
    Some(collapsed)
}

fn strip_markdown_line_prefix(line: &str) -> &str {
    let s = line.trim();
    if let Some(rest) = s.strip_prefix('#') {
        let rest = rest.trim_start_matches('#');
        if let Some(after) = rest.strip_prefix(' ').or_else(|| rest.strip_prefix('\t')) {
            return after.trim();
        }
    }
    if let Some(rest) = s
        .strip_prefix("- ")
        .or_else(|| s.strip_prefix("* "))
        .or_else(|| s.strip_prefix("+ "))
    {
        return rest.trim();
    }
    let digits = s.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0
        && s.as_bytes().get(digits) == Some(&b'.')
        && s.as_bytes()
            .get(digits + 1)
            .is_some_and(u8::is_ascii_whitespace)
    {
        return s[digits + 2..].trim();
    }
    s
}

fn strip_markdown_links(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(open_bracket) = rest.find('[') {
        let is_image = open_bracket > 0 && rest.as_bytes()[open_bracket - 1] == b'!';
        let prefix_end = if is_image {
            open_bracket - 1
        } else {
            open_bracket
        };
        if let Some(close_bracket_rel) = rest[open_bracket + 1..].find("](") {
            let label_start = open_bracket + 1;
            let label_end = label_start + close_bracket_rel;
            if let Some(close_paren_rel) = rest[label_end + 2..].find(')') {
                out.push_str(&rest[..prefix_end]);
                out.push_str(&rest[label_start..label_end]);
                rest = &rest[label_end + 2 + close_paren_rel + 1..];
                continue;
            }
        }
        out.push_str(&rest[..open_bracket + 1]);
        rest = &rest[open_bracket + 1..];
    }
    out.push_str(rest);
    out
}

/// Conn's turn-fold label (`MessagesTimeline.logic.ts:1176-1213`): `Worked for <d>`,
/// `You stopped after <d>` for the interrupted latest run, `Continued for <d>` after a steer,
/// and the bare `Worked` / `You stopped this response` / `Continued` without a duration.
#[must_use]
fn format_fold_label(duration_ms: Option<u64>, interrupted: bool, continues_steer: bool) -> String {
    let duration = duration_ms.map(conn_state::format_duration);
    match (continues_steer, interrupted, duration) {
        (true, _, Some(d)) => format!("Continued for {d}"),
        (true, _, None) => "Continued".to_owned(),
        (false, true, Some(d)) => format!("You stopped after {d}"),
        (false, true, None) => "You stopped this response".to_owned(),
        (false, false, Some(d)) => format!("Worked for {d}"),
        (false, false, None) => "Worked".to_owned(),
    }
}

/// Returns the markdown of the latest completed `ProposedPlan` when the thread is idle and no
/// later human user message has followed it, matching Conn's plan follow-up composer trigger.
#[must_use]
fn latest_actionable_plan_markdown(thread: &ThreadState, working: bool) -> Option<String> {
    if working {
        return None;
    }
    let latest_run = thread.latest_run_id();
    for entry in thread.entries.iter().rev() {
        match entry {
            TimelineEntry::User { .. }
            | TimelineEntry::QueuedUser { .. }
            | TimelineEntry::Assistant { .. } => return None,
            TimelineEntry::ProposedPlan {
                run_id,
                markdown,
                streaming: false,
                ..
            } => {
                if latest_run.is_none() || run_id.as_deref() == latest_run {
                    let trimmed = markdown.trim();
                    return (!trimmed.is_empty()).then(|| markdown.clone());
                }
                return None;
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod worked_label_tests {
    use conn_state::{ItemStatus, ThreadState, TimelineEntry};

    use super::{
        format_fold_label, format_queued_timestamp, format_working_elapsed,
        latest_actionable_plan_markdown, live_thought_preview,
    };

    #[test]
    fn formats_queued_timestamp_as_hh_mm() {
        let formatted = format_queued_timestamp("2026-11-22T12:34:56.000Z");
        assert!(
            formatted
                .as_deref()
                .is_some_and(|s| s.len() == 5 && s.as_bytes()[2] == b':'),
            "expected HH:MM timestamp, got {formatted:?}"
        );
        assert_eq!(
            format_queued_timestamp("not-a-date"),
            None,
            "invalid ISO timestamp should return None"
        );
    }

    #[test]
    fn formats_worked_duration_labels() {
        assert_eq!(
            format_fold_label(None, false, false),
            "Worked",
            "missing duration"
        );
        assert_eq!(format_fold_label(Some(50), false, false), "Worked for 50ms");
        assert_eq!(
            format_fold_label(Some(7_500), false, false),
            "Worked for 7.5s"
        );
        assert_eq!(
            format_fold_label(Some(2_000), false, false),
            "Worked for 2s"
        );
        assert_eq!(
            format_fold_label(Some(42_400), false, false),
            "Worked for 42s"
        );
        assert_eq!(
            format_fold_label(Some(59_600), false, false),
            "Worked for 1m"
        );
        assert_eq!(
            format_fold_label(Some(134_000), false, false),
            "Worked for 2m 14s"
        );
        assert_eq!(
            format_fold_label(Some(3_725_000), false, false),
            "Worked for 1h 2m 5s"
        );
        assert_eq!(
            format_fold_label(Some(12_000), true, false),
            "You stopped after 12s"
        );
        assert_eq!(
            format_fold_label(None, true, false),
            "You stopped this response"
        );
        assert_eq!(
            format_fold_label(Some(4_000), false, true),
            "Continued for 4s"
        );
        assert_eq!(format_fold_label(None, true, true), "Continued");
    }

    #[test]
    fn work_log_ax_labels_name_the_kind_and_text() {
        use conn_state::ItemStatus::{Completed, Failed};

        use crate::chat::{ax_snippet, tool_ax_label};
        assert_eq!(
            tool_ax_label("command", "curl -s x\nsecond line", Completed),
            "Command: curl -s x"
        );
        assert_eq!(
            tool_ax_label("file_read", "Read /tmp/a.jpg", Completed),
            "Read /tmp/a.jpg"
        );
        assert_eq!(
            tool_ax_label("dynamic_tool", "mcp__t3-code__delegate_task", Failed),
            "Tool: mcp__t3-code__delegate_task (failed)"
        );
        assert_eq!(ax_snippet(&"é".repeat(130)).chars().count(), 121);
    }

    #[test]
    fn formats_working_elapsed_and_live_thought_preview() {
        assert_eq!(format_working_elapsed(0), "Working for 0s");
        assert_eq!(format_working_elapsed(44_200), "Working for 44s");
        assert_eq!(format_working_elapsed(120_000), "Working for 2m");
        assert_eq!(format_working_elapsed(134_000), "Working for 2m 14s");

        assert_eq!(live_thought_preview("   "), None);
        assert_eq!(
            live_thought_preview("**Checking composer layout**\n\nMore details follow here."),
            Some("Checking composer layout".to_owned())
        );
        assert_eq!(
            live_thought_preview(
                "First **sentence** with `code`. Second sentence should never mutate the preview."
            ),
            Some("First sentence with code.".to_owned())
        );
        assert_eq!(
            live_thought_preview("First paragraph.\n\nSecond paragraph should not replace first."),
            Some("First paragraph.".to_owned())
        );
    }

    #[test]
    fn resolves_latest_actionable_plan_markdown() {
        let mut thread = ThreadState::new("t-plan");
        thread.entries.push(TimelineEntry::ProposedPlan {
            id: "plan-1".to_owned(),
            run_id: Some("run-1".to_owned()),
            title: "Plan".to_owned(),
            markdown: "# Plan\n\nDo the work".to_owned(),
            streaming: false,
            status: ItemStatus::Completed,
            created_at: None,
        });
        assert_eq!(
            latest_actionable_plan_markdown(&thread, false).as_deref(),
            Some("# Plan\n\nDo the work"),
            "idle thread with trailing proposed plan should offer follow-up actions"
        );
        assert_eq!(
            latest_actionable_plan_markdown(&thread, true),
            None,
            "working thread must hide plan follow-up actions"
        );
        thread.entries.push(TimelineEntry::User {
            id: "user-2".to_owned(),
            text: "Go ahead".to_owned(),
            created_by_agent: false,
            created_at: None,
            attachments: Vec::new(),
            is_steer: false,
            run_id: Some("run-2".to_owned()),
        });
        assert_eq!(
            latest_actionable_plan_markdown(&thread, false),
            None,
            "subsequent user turn clears prior plan follow-up"
        );
    }
}
