//! Conn-styled bottom composer card, floating model picker, and `/` + `@` completion menus.
//!
//! Visual parity with real Conn (`ChatComposer.tsx`, `ComposerSurface.tsx`,
//! `ComposerControlsBar.tsx`, `ComposerPrimaryActions.tsx`, `ComposerSpeechButton.tsx`,
//! `ProviderModelPicker.tsx`, `ComposerCommandMenu.tsx`):
//! - Card: `16px` radius (`rounded-2xl`), `tokens.card` (light) / `tokens.shell_field` (dark)
//!   fill, `1px` `tokens.shell_inner_border` hairline border.
//! - Body: `px-4 pt-4 pb-2` (`16px` / `16px` / `8px`), `14px` text, `2` min lines, `8` max lines.
//! - Footer: `px-2 pb-2` (`8px` / `8px`), right-aligned controls (`gap-2` = `8px`):
//!   provider icon + model name (`28px` height), microphone button (`28px`, button only),
//!   and `32px` round send button (or destructive stop button while working).

mod actions;
mod branch_picker;
mod context_meter;
mod drafts;
mod footer;
mod menus;
mod model_picker;
mod stash;

pub(crate) use self::actions::{FollowUpBehavior, SendDispatch};
pub(crate) use self::branch_picker::{BranchAction, BranchContext};
pub(crate) use self::context_meter::ContextWindowSnapshot;

use std::fmt;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use gpui_kit::TestSupportExt as _;

use conn_client::Connection;
use conn_contract::rpc::projects::search_entries;
use conn_contract::rpc::server::get_config;
use conn_contract::{ChatAttachment, ProjectSearchEntriesInput, ServerProbePayload};
use conn_desktop::operator::{DictationStart, DictationWait, OperatorClient};
use conn_theme::{Appearance, Tokens};
use gpui_kit::component::input::{
    Enter, Escape, InputEvent, InputState, MoveDown, MoveUp, Paste, Textarea, TextareaState,
};
use gpui_kit::component::{Sizable as _, Size};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, AppContext as _, ClipboardEntry, Context, Entity, EventEmitter, ExternalPaths,
    FontWeight, ImageFormat, InteractiveElement as _, IntoElement, ParentElement as _,
    PathPromptOptions, Render, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, Window, deferred, div, px,
};

use self::actions::{PrimaryActionInput, resolve_dispatch_mode, resolve_primary_action};
use self::footer::{
    FOOTER_CONTROL_HEIGHT_PX, compatible_runtime_modes, footer_permissions_visible,
    render_interaction_mode_toggle, render_permissions_chip, render_permissions_section,
    runtime_mode_option,
};
use self::menus::{
    ComposerTrigger, ComposerTriggerKind, FileMentionEntry, SkillEntry, detect_trigger,
    filter_skills, filter_slash_commands, render_command_menu, replace_trigger,
};
use self::model_picker::{ModelCatalog, ModelOption, ModelPickerView, render_model_picker};
use self::stash::{PromptStash, render_stash_badge, render_stash_menu};
use super::color::{hsla, hsla_alpha};
use super::composer_state::{
    ComposerDraft, ComposerDraftStore, ComposerPendingRequest, ComposerSendAction, HeldDraft,
    PromptHistoryEntry, PromptHistoryPosition, TypingGuardInput, composer_placeholder,
    composer_send_action, prompt_length_message, step_prompt_history,
};
use super::icons;
use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome::ConnTooltipExt as _;

pub(super) const COMPOSER_PLACEHOLDER: &str = super::composer_state::DEFAULT_COMPOSER_PLACEHOLDER;
pub(super) const COMPOSER_MIN_LINES: usize = 2;
pub(super) const COMPOSER_MAX_LINES: usize = 8;

/// Composer card corner radius matching Conn's `rounded-2xl` (`16px`).
const COMPOSER_RADIUS_PX: f32 = 16.0;
/// Bottom breathing room below the composer card when the context strip is hidden
/// (`ChatView.tsx:4067` `sm:h-[1.25rem]`).
const COMPOSER_BOTTOM_SPACER_PX: f32 = 20.0;
/// Symmetric vertical margin around the `22px` bottom context strip (`9px` top + `9px` bottom)
/// so the strip sits visually balanced between the composer card and the bottom of the chat card.
const CONTEXT_STRIP_VERTICAL_MARGIN_PX: f32 = 9.0;
/// Maximum width of the model name label in the trigger (`max-w-56` = `224px`).
const MODEL_LABEL_MAX_WIDTH_PX: f32 = 224.0;
/// Maximum file mention results requested from `projects.searchEntries`.
const FILE_SEARCH_LIMIT: i64 = 25;

/// Superheroicons 16/solid path for the microphone button (`Mic` -> `microphone`).
const ICON_MICROPHONE: &str = "superhero/microphone.svg";
/// Superheroicons 16/solid path for the attach-files button (`Paperclip` -> `attach`).
const ICON_ATTACH: &str = "superhero/attach.svg";
/// `PLAN_IMPLEMENTATION_PROMPT_PREFIX` in `proposedPlan.ts`.
const PLAN_IMPLEMENTATION_PROMPT_PREFIX: &str = "PLEASE IMPLEMENT THIS PLAN:\n";
/// `modelPicker.toggle` shortcut label.
const MODEL_PICKER_SHORTCUT_LABEL: &str = "⌘⇧M";

/// State of one staged file/image attachment in the composer strip.
#[derive(Clone, Debug)]
struct PendingAttachment {
    local_id: u64,
    name: String,
    size_bytes: usize,
    status: AttachmentUploadStatus,
}

#[derive(Clone, Debug)]
enum AttachmentUploadStatus {
    Uploading,
    Ready(ChatAttachment),
    Error(String),
}

/// Active Operator voice dictation session state in the composer.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
enum DictationState {
    #[default]
    Idle,
    Starting {
        session_id: String,
    },
    Recording {
        session_id: String,
    },
    Transcribing {
        session_id: String,
    },
}

impl DictationState {
    fn session_id(&self) -> Option<&str> {
        match self {
            Self::Idle => None,
            Self::Starting { session_id }
            | Self::Recording { session_id }
            | Self::Transcribing { session_id } => Some(session_id.as_str()),
        }
    }
}

/// Active queued-message edit session in the composer (`useQueuedRunEdit.ts`).
#[derive(Clone, Debug, PartialEq)]
struct EditingQueuedRun {
    run_id: String,
    /// Draft text captured before entering edit mode, restored on cancel or save.
    saved_draft: String,
    /// Attachments already uploaded on the queued message (removable locally until saved).
    existing_attachments: Vec<ChatAttachment>,
}

/// Events emitted by [`Composer`] to its host view (`ChatView` -> `ConnApp`).
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ComposerEvent {
    Send {
        text: String,
        attachments: Vec<ChatAttachment>,
        /// Steer or queue while a turn runs (`resolveComposerDispatchMode`).
        dispatch: SendDispatch,
        /// Set when the send answers pending approvals: the draft stays in the composer until
        /// the host settles it with [`Composer::settle_held_draft`].
        held_draft: Option<HeldDraft>,
    },
    /// Answer the active pending question with `text`; blank uses its selected option.
    AnswerQuestion {
        text: String,
    },
    /// An editor event for the typing guard (`useComposerTypingGuard`).
    TypingGuard(TypingGuardInput),
    /// `Resume thread`: continue an interrupted thread (`useComposerResume`).
    Resume,
    /// `Implement in a new thread` from the plan follow-up split button.
    ImplementPlanInNewThread {
        text: String,
    },
    /// Save an edit to an existing server-backed queued message (`queued-run.edit`).
    EditQueuedMessage {
        run_id: String,
        text: String,
        attachments: Option<Vec<ChatAttachment>>,
    },
    /// Cancelled editing a queued message (Escape or Cancel button).
    CancelEditQueuedMessage,
    Stop,
    ModelSelected {
        instance_id: String,
        model: String,
        options: Option<serde_json::Map<String, serde_json::Value>>,
    },
    RuntimeModeSelected(String),
    InteractionModeSelected(String),
    /// Workspace or branch change from the context strip.
    Branch(BranchAction),
    SlashCommand(String),
    /// `server.getConfig` loaded; carries its `scratchWorkspaceRoot`.
    ScratchWorkspaceRoot(Option<String>),
}

/// What the pending question's panel reads from the composer.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct QuestionComposerStatus {
    /// The draft text, which becomes the answer on send.
    pub(crate) typed: String,
    /// Dictation is recording, so Send finishes it.
    pub(crate) voice_active: bool,
    /// A file is still uploading.
    pub(crate) uploading: bool,
    /// Sending is blocked outside the answer: offline, uploading or transcribing.
    pub(crate) blocked: bool,
}

/// Stateful GPUI entity for the Conn composer, model picker, `/` command menu, and `@` mentions.
pub(crate) struct Composer {
    tokens: Tokens,
    connection: Option<Connection>,
    workspace_root: Option<String>,
    thread_branch: Option<String>,
    worktree_active: bool,
    is_draft: bool,
    /// Mirrors Conn's `settings.persistComposerContextStrip` (`BranchToolbar.logic.ts:72`).
    persist_context_strip: bool,
    submitting: bool,
    runtime_mode: String,
    /// The user's default permission mode; the footer chip hides while the thread matches it.
    default_runtime_mode: String,
    interaction_mode: String,
    working: bool,
    follow_up: FollowUpBehavior,
    /// True while `⌘`/`Ctrl` is held (morphs the send button between steer and queue).
    alternate_modifier: bool,
    /// Latest proposed plan markdown while the plan follow-up prompt shows.
    plan_follow_up: Option<String>,
    can_resume: bool,
    /// The pending approval or question a send answers instead of starting a turn.
    pending_request: ComposerPendingRequest,
    /// An approval send is declining; the draft stays put and another send waits
    /// (`sendInFlightRef`).
    answering_approval: bool,
    send_disabled_reason: Option<String>,
    environment_unavailable: bool,
    preparing_worktree: bool,
    context_window: Option<ContextWindowSnapshot>,
    context_meter_open: bool,
    footer_permissions_open: bool,
    picker_permissions_open: bool,
    strip_permissions_open: bool,
    permission_preview: Option<&'static str>,
    implement_menu_open: bool,
    stash: PromptStash,
    /// The host draws the stash badge in its own banner dock.
    stash_docked: bool,
    branch: branch_picker::BranchUi,
    textarea: Entity<TextareaState>,
    model_search_input: Entity<InputState>,
    catalog: ModelCatalog,
    catalog_loading: bool,
    catalog_error: Option<String>,
    selected_instance_id: Option<String>,
    selected_driver: Option<String>,
    selected_model: String,
    selected_options: Option<serde_json::Map<String, serde_json::Value>>,
    model_picker_open: bool,
    picker_provider_filter: Option<String>,
    picker_highlighted_index: usize,
    active_trigger: Option<ComposerTrigger>,
    dismissed_trigger_text: Option<String>,
    menu_highlighted_index: usize,
    file_mentions: Vec<FileMentionEntry>,
    file_mentions_loading: bool,
    file_search_generation: u64,
    attachments: Vec<PendingAttachment>,
    /// Unsent prompt + attachments parked per thread / draft (`composerDraftStore`).
    drafts: ComposerDraftStore<PendingAttachment>,
    /// The thread's recallable sent prompts, oldest first (↑/↓ history).
    prompt_history: Vec<PromptHistoryEntry>,
    /// Browsing position, tied to the draft key it was recalled in.
    history_position: Option<(String, PromptHistoryPosition)>,
    /// Placeholder last pushed into the textarea.
    applied_placeholder: &'static str,
    next_attachment_id: u64,
    editing_queued: Option<EditingQueuedRun>,
    dictation: DictationState,
    dictation_error: Option<String>,
    next_dictation_seq: u64,
    /// Send was pressed while dictating: submit once the transcript lands.
    submit_after_dictation: bool,
    _subscriptions: Vec<Subscription>,
}

impl fmt::Debug for Composer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Composer")
            .field("working", &self.working)
            .field("selected_instance_id", &self.selected_instance_id)
            .field("selected_model", &self.selected_model)
            .field("model_picker_open", &self.model_picker_open)
            .field("active_trigger", &self.active_trigger)
            .field("providers", &self.catalog.providers.len())
            .finish_non_exhaustive()
    }
}

impl EventEmitter<ComposerEvent> for Composer {}

#[expect(
    dead_code,
    reason = "public composer API wired into ChatView in chat/mod.rs by orchestrator"
)]
impl Composer {
    /// Creates a new [`Composer`] entity styled with `tokens`.
    ///
    /// When `connection` is present, immediately fetches the provider/model catalog
    /// via `server.getConfig`.
    pub(crate) fn new(
        tokens: Tokens,
        connection: Option<Connection>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let textarea = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(COMPOSER_PLACEHOLDER)
                .auto_grow(COMPOSER_MIN_LINES, COMPOSER_MAX_LINES)
                .submit_on_enter(true)
        });
        let model_search_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("Search models..."));

        let textarea_sub = cx.subscribe_in(
            &textarea,
            window,
            |this, _, event: &InputEvent, window, cx| match event {
                InputEvent::PressEnter {
                    shift: false,
                    secondary,
                } => {
                    if this.stash.menu_open {
                        this.restore_highlighted_stash_entry(window, cx);
                    } else if this.active_trigger.is_some() {
                        this.confirm_active_menu(window, cx);
                    } else {
                        // `⌘Enter` (`composer.sendAlternate`) flips steer and queue.
                        this.submit_with_dispatch(Some(*secondary), window, cx);
                    }
                }
                InputEvent::Change => {
                    // Typing a question's answer is not prompt typing (`onPromptChange`).
                    if this.pending_request.question.is_none() {
                        cx.emit(ComposerEvent::TypingGuard(TypingGuardInput::Typed));
                    }
                    this.on_draft_changed(cx);
                }
                InputEvent::Focus => cx.emit(ComposerEvent::TypingGuard(TypingGuardInput::Focus)),
                InputEvent::Blur => cx.emit(ComposerEvent::TypingGuard(TypingGuardInput::Blur)),
                InputEvent::PressEnter { .. } => {}
            },
        );

        let search_sub =
            cx.subscribe(
                &model_search_input,
                |this, _, event: &InputEvent, cx| match event {
                    InputEvent::Change => {
                        this.picker_highlighted_index = 0;
                        cx.notify();
                    }
                    InputEvent::PressEnter { .. } => {
                        this.confirm_highlighted_model(cx);
                    }
                    _ => {}
                },
            );

        let branch = branch_picker::BranchUi::new(window, cx);
        let mut composer = Self {
            tokens,
            connection,
            workspace_root: None,
            thread_branch: None,
            worktree_active: false,
            is_draft: false,
            persist_context_strip: false,
            submitting: false,
            runtime_mode: "full-access".to_owned(),
            default_runtime_mode: "full-access".to_owned(),
            interaction_mode: "default".to_owned(),
            working: false,
            follow_up: FollowUpBehavior::default(),
            alternate_modifier: false,
            plan_follow_up: None,
            can_resume: false,
            pending_request: ComposerPendingRequest::default(),
            answering_approval: false,
            send_disabled_reason: None,
            environment_unavailable: false,
            preparing_worktree: false,
            context_window: None,
            context_meter_open: false,
            footer_permissions_open: false,
            picker_permissions_open: false,
            strip_permissions_open: false,
            permission_preview: None,
            implement_menu_open: false,
            stash: PromptStash::default(),
            stash_docked: false,
            branch,
            textarea,
            model_search_input,
            catalog: ModelCatalog::default(),
            catalog_loading: false,
            catalog_error: None,
            selected_instance_id: None,
            selected_driver: None,
            selected_model: "Default model".to_owned(),
            selected_options: None,
            model_picker_open: false,
            picker_provider_filter: None,
            picker_highlighted_index: 0,
            active_trigger: None,
            dismissed_trigger_text: None,
            menu_highlighted_index: 0,
            file_mentions: Vec::new(),
            file_mentions_loading: false,
            file_search_generation: 0,
            attachments: Vec::new(),
            drafts: ComposerDraftStore::default(),
            prompt_history: Vec::new(),
            history_position: None,
            applied_placeholder: COMPOSER_PLACEHOLDER,
            next_attachment_id: 1,
            editing_queued: None,
            dictation: DictationState::Idle,
            dictation_error: None,
            next_dictation_seq: 1,
            submit_after_dictation: false,
            _subscriptions: vec![textarea_sub, search_sub],
        };
        if composer.connection.is_some() {
            composer.refresh_providers(cx);
        }
        composer
    }

    /// Replaces active theme tokens.
    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        if self.tokens == tokens {
            return;
        }
        self.tokens = tokens;
        cx.notify();
    }

    /// Updates the server connection and fetches the provider catalog via `server.getConfig`.
    pub(crate) fn set_connection(
        &mut self,
        connection: Option<Connection>,
        cx: &mut Context<'_, Self>,
    ) {
        self.connection = connection;
        if self.connection.is_some() {
            self.refresh_providers(cx);
        }
    }

    /// Sets the workspace root used for `@` file mention searches (`projects.searchEntries`).
    pub(crate) fn set_workspace_root(&mut self, root: Option<String>, cx: &mut Context<'_, Self>) {
        if self.workspace_root == root {
            return;
        }
        self.workspace_root = root;
        self.file_mentions.clear();
        cx.notify();
    }

    /// Updates the branch, worktree flag, runtime mode, and interaction mode displayed in the
    /// bottom `BranchToolbar` context strip.
    pub(crate) fn set_thread_context(
        &mut self,
        branch: Option<String>,
        worktree_active: bool,
        runtime_mode: String,
        interaction_mode: String,
        cx: &mut Context<'_, Self>,
    ) {
        if self.thread_branch == branch
            && self.worktree_active == worktree_active
            && self.runtime_mode == runtime_mode
            && self.interaction_mode == interaction_mode
        {
            return;
        }
        self.thread_branch = branch;
        self.worktree_active = worktree_active;
        self.runtime_mode = runtime_mode;
        self.interaction_mode = interaction_mode;
        cx.notify();
    }

    /// Updates whether the active thread is running (switches send button to stop).
    pub(crate) fn set_working(&mut self, working: bool, cx: &mut Context<'_, Self>) {
        if self.working == working {
            return;
        }
        self.working = working;
        cx.notify();
    }

    /// Sets the user's default permission mode (`settings.defaultRuntimeMode`).
    pub(crate) fn set_default_runtime_mode(&mut self, mode: String, cx: &mut Context<'_, Self>) {
        if self.default_runtime_mode != mode {
            self.default_runtime_mode = mode;
            cx.notify();
        }
    }

    /// Sets the follow-up behavior used while a turn runs (`settings.followUpBehavior`).
    pub(crate) fn set_follow_up_behavior(
        &mut self,
        behavior: FollowUpBehavior,
        cx: &mut Context<'_, Self>,
    ) {
        if self.follow_up != behavior {
            self.follow_up = behavior;
            cx.notify();
        }
    }

    /// Shows the plan follow-up actions (`Refine` / `Implement`) for `plan_markdown`.
    pub(crate) fn set_plan_follow_up(
        &mut self,
        plan_markdown: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.plan_follow_up != plan_markdown {
            self.plan_follow_up = plan_markdown;
            self.implement_menu_open = false;
            cx.notify();
        }
    }

    /// Sets whether an empty draft shows `Resume thread`.
    pub(crate) fn set_can_resume(&mut self, can_resume: bool, cx: &mut Context<'_, Self>) {
        if self.can_resume != can_resume {
            self.can_resume = can_resume;
            cx.notify();
        }
    }

    /// Sets the pending approval or question a send answers.
    pub(crate) fn set_pending_request(
        &mut self,
        pending: ComposerPendingRequest,
        cx: &mut Context<'_, Self>,
    ) {
        if self.pending_request != pending {
            self.pending_request = pending;
            cx.notify();
        }
    }

    /// Conn steers over pending approvals, since a send declines them to redirect the agent.
    fn effective_follow_up(&self) -> FollowUpBehavior {
        if self.pending_request.approval.is_some() {
            FollowUpBehavior::Steer
        } else {
            self.follow_up
        }
    }

    /// Sets the send-blocking status shown on the disabled send button.
    pub(crate) fn set_send_status(
        &mut self,
        environment_unavailable: bool,
        preparing_worktree: bool,
        send_disabled_reason: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.environment_unavailable == environment_unavailable
            && self.preparing_worktree == preparing_worktree
            && self.send_disabled_reason == send_disabled_reason
        {
            return;
        }
        self.environment_unavailable = environment_unavailable;
        self.preparing_worktree = preparing_worktree;
        self.send_disabled_reason = send_disabled_reason;
        cx.notify();
    }

    /// Sets the active thread's context window usage (shows the footer meter when present).
    pub(crate) fn set_context_window(
        &mut self,
        usage: Option<ContextWindowSnapshot>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.context_window != usage {
            if usage.is_none() {
                self.context_meter_open = false;
            }
            self.context_window = usage;
            cx.notify();
        }
    }

    /// Sets whether the branch/worktree context strip stays visible on active (non-draft) threads.
    pub(crate) fn set_persist_context_strip(&mut self, persist: bool, cx: &mut Context<'_, Self>) {
        if self.persist_context_strip != persist {
            self.persist_context_strip = persist;
            cx.notify();
        }
    }

    /// Marks whether the composer is currently composing a new-thread draft and whether launch is
    /// in flight.
    pub(crate) fn set_draft_mode(
        &mut self,
        is_draft: bool,
        submitting: bool,
        cx: &mut Context<'_, Self>,
    ) {
        if self.is_draft == is_draft && self.submitting == submitting {
            return;
        }
        self.is_draft = is_draft;
        self.submitting = submitting;
        cx.notify();
    }

    /// Moves keyboard focus into the composer textarea.
    pub(crate) fn focus_input(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        self.textarea.update(cx, |input, cx| {
            input.focus(window, cx);
        });
    }

    /// Restores or replaces the composer textarea text (e.g. if a thread launch fails).
    pub(crate) fn set_draft_text(
        &mut self,
        text: String,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.textarea.update(cx, |input, cx| {
            input.set_value(text, window, cx);
            input.focus(window, cx);
        });
        self.on_draft_changed(cx);
    }

    /// Shows the draft for `key` (a thread or the new-thread draft), parking the current one.
    pub(crate) fn sync_draft_key(
        &mut self,
        key: Option<&str>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if self.drafts.take_discarded() {
            self.attachments.clear();
            self.textarea
                .update(cx, |input, cx| input.set_value("", window, cx));
            self.on_draft_changed(cx);
        }
        if self.drafts.active_key() == key {
            return;
        }
        let mut text = self.textarea.read(cx).value().to_string();
        let mut attachments = std::mem::take(&mut self.attachments);
        if let Some(editing) = self.editing_queued.take() {
            text = editing.saved_draft;
            attachments.clear();
            cx.emit(ComposerEvent::CancelEditQueuedMessage);
        }
        let Some(next) = self.drafts.switch(key, ComposerDraft { text, attachments }) else {
            return;
        };
        self.close_overlays(cx);
        self.attachments = next.attachments;
        self.textarea.update(cx, |input, cx| {
            input.set_value(next.text, window, cx);
        });
        self.on_draft_changed(cx);
    }

    /// Replaces the thread's recallable sent prompts.
    pub(crate) fn set_prompt_history(&mut self, entries: Vec<PromptHistoryEntry>) {
        self.prompt_history = entries;
    }

    /// ↑/↓ through sent prompts when the prompt is empty or recalled and the caret sits on the
    /// first (↑) or last (↓) line (`navigatePromptHistory`). Returns `true` when it handled the key.
    fn step_history(
        &mut self,
        backward: bool,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> bool {
        if !self.attachments.is_empty() || self.editing_queued.is_some() {
            return false;
        }
        let (text, cursor) = {
            let input = self.textarea.read(cx);
            (input.value().to_string(), input.cursor())
        };
        let on_edge = if backward {
            !text[..cursor.min(text.len())].contains('\n')
        } else {
            !text[cursor.min(text.len())..].contains('\n')
        };
        if !on_edge {
            return false;
        }
        let key = self.drafts.active_key().unwrap_or_default().to_owned();
        let position = self
            .history_position
            .as_ref()
            .filter(|(k, _)| *k == key)
            .map(|(_, p)| p);
        let Some(step) = step_prompt_history(backward, &self.prompt_history, position, &text)
        else {
            return false;
        };
        self.history_position = step.position.map(|p| (key, p));
        // Multi-line `set_value` puts the caret at 0; recall leaves it at the end, as in Conn.
        let last_line = step.prompt.rsplit('\n').next().unwrap_or_default();
        let end = gpui_kit::base::input::Position::new(
            u32::try_from(step.prompt.matches('\n').count()).unwrap_or(u32::MAX),
            u32::try_from(last_line.encode_utf16().count()).unwrap_or(u32::MAX),
        );
        self.textarea.update(cx, |input, cx| {
            input.set_value(step.prompt, window, cx);
            input.set_cursor_position(end, window, cx);
        });
        self.on_draft_changed(cx);
        true
    }

    /// Loads a server-backed queued message into the composer for editing.
    ///
    /// Preserves any existing unsent thread draft so cancelling restores it.
    pub(crate) fn begin_edit_queued(
        &mut self,
        run_id: String,
        text: String,
        attachments: Vec<ChatAttachment>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let saved_draft = match self.editing_queued.take() {
            Some(prev) => prev.saved_draft,
            None => self.textarea.read(cx).value().to_string(),
        };
        self.editing_queued = Some(EditingQueuedRun {
            run_id,
            saved_draft,
            existing_attachments: attachments,
        });
        self.attachments.clear();
        self.close_overlays(cx);
        self.textarea.update(cx, |input, cx| {
            input.set_value(text, window, cx);
            input.focus(window, cx);
        });
        self.on_draft_changed(cx);
    }

    /// Exits queued-message edit mode, restoring the saved thread draft.
    pub(crate) fn cancel_edit_queued(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let Some(editing) = self.editing_queued.take() else {
            return;
        };
        self.attachments.clear();
        self.textarea.update(cx, |input, cx| {
            input.set_value(editing.saved_draft, window, cx);
            input.focus(window, cx);
        });
        self.on_draft_changed(cx);
        cx.emit(ComposerEvent::CancelEditQueuedMessage);
        cx.notify();
    }

    /// Clears queued edit mode without window focus (e.g. when the queued run left the queue or
    /// the user switched threads). Returns `true` when edit mode was active and cleared.
    pub(crate) fn clear_edit_queued_if_missing(
        &mut self,
        active_queued_run_ids: &[&str],
        cx: &mut Context<'_, Self>,
    ) -> bool {
        let should_clear = self
            .editing_queued
            .as_ref()
            .is_some_and(|e| !active_queued_run_ids.contains(&e.run_id.as_str()));
        if should_clear {
            self.editing_queued = None;
            cx.notify();
        }
        should_clear
    }

    fn remove_editing_queued_attachment(
        &mut self,
        attachment_id: &str,
        cx: &mut Context<'_, Self>,
    ) {
        if let Some(editing) = &mut self.editing_queued {
            let before = editing.existing_attachments.len();
            editing
                .existing_attachments
                .retain(|att| chat_attachment_id(att) != attachment_id);
            if editing.existing_attachments.len() != before {
                cx.notify();
            }
        }
    }

    /// Returns the composer's resolved `(instance_id, model_slug, options)` selection,
    /// falling back to the loaded `server.getConfig` catalog default when unset.
    #[must_use]
    pub(crate) fn current_model_selection(
        &self,
    ) -> Option<(
        String,
        String,
        Option<serde_json::Map<String, serde_json::Value>>,
    )> {
        if let Some(opt) = self
            .catalog
            .find_model(self.selected_instance_id.as_deref(), &self.selected_model)
        {
            return Some((
                opt.instance_id.clone(),
                opt.slug.clone(),
                self.selected_options.clone(),
            ));
        }
        if let Some(instance_id) = self.selected_instance_id.as_deref()
            && !instance_id.trim().is_empty()
            && !self.selected_model.trim().is_empty()
            && self.selected_model != "Default model"
        {
            return Some((
                instance_id.to_owned(),
                self.selected_model.clone(),
                self.selected_options.clone(),
            ));
        }
        self.catalog
            .default_model()
            .map(|opt| (opt.instance_id.clone(), opt.slug.clone(), None))
    }

    /// Updates the active provider/model and options displayed in the composer footer.
    pub(crate) fn set_model_selection(
        &mut self,
        instance_id: Option<String>,
        driver: Option<String>,
        model: String,
        options: Option<serde_json::Map<String, serde_json::Value>>,
        cx: &mut Context<'_, Self>,
    ) {
        let changed = self.selected_instance_id != instance_id
            || self.selected_driver != driver
            || self.selected_model != model
            || self.selected_options != options;
        if !changed {
            return;
        }
        self.selected_instance_id = instance_id;
        self.selected_driver = driver;
        self.selected_model = model;
        self.selected_options = options;
        cx.notify();
    }

    /// Sets only the model display label (compatibility with `ChatView::set_model_label`).
    pub(crate) fn set_model_label(&mut self, label: String, cx: &mut Context<'_, Self>) {
        if self.selected_model == label {
            return;
        }
        if self.selected_driver.is_none() {
            self.selected_driver = infer_driver_from_model_label(&label).map(str::to_owned);
        }
        self.selected_model = label;
        cx.notify();
    }

    /// Fetches the provider/model list via `server.getConfig`.
    pub(crate) fn refresh_providers(&mut self, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        self.catalog_loading = true;
        self.catalog_error = None;
        cx.notify();

        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<get_config::Payload, get_config::Success>(
                    "server.getConfig",
                    &ServerProbePayload {},
                )
                .await;
            let _ = this.update(cx, |composer, cx| {
                composer.catalog_loading = false;
                match res {
                    Ok(config) => {
                        cx.emit(ComposerEvent::ScratchWorkspaceRoot(
                            config.scratch_workspace_root.clone(),
                        ));
                        composer.catalog = ModelCatalog::from_server_config(&config);
                        composer.catalog_error = None;
                        if (composer.selected_instance_id.is_none()
                            || composer.selected_model == "Default model")
                            && let Some(default_opt) = composer.catalog.default_model().cloned()
                        {
                            composer.selected_instance_id = Some(default_opt.instance_id);
                            composer.selected_driver = Some(default_opt.driver);
                            composer.selected_model = default_opt.slug;
                        }
                    }
                    Err(err) => {
                        composer.catalog_error = Some(err.to_string());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Toggles the floating model picker popup.
    pub(crate) fn toggle_model_picker(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        self.model_picker_open = !self.model_picker_open;
        self.picker_permissions_open = false;
        self.permission_preview = None;
        if self.model_picker_open {
            self.active_trigger = None;
            self.footer_permissions_open = false;
            self.strip_permissions_open = false;
            self.stash.menu_open = false;
            self.picker_provider_filter = self.selected_instance_id.clone();
            self.picker_highlighted_index = 0;
            self.model_search_input.update(cx, |input, cx| {
                input.set_value("", window, cx);
                input.focus(window, cx);
            });
            if self.catalog.providers.is_empty() && !self.catalog_loading {
                self.refresh_providers(cx);
            }
        }
        cx.notify();
    }

    /// Closes any open popup (model picker, `/` command menu, or `@` file menu).
    pub(crate) fn close_overlays(&mut self, cx: &mut Context<'_, Self>) {
        let mut changed = false;
        if self.model_picker_open {
            self.model_picker_open = false;
            changed = true;
        }
        for open in [
            &mut self.footer_permissions_open,
            &mut self.picker_permissions_open,
            &mut self.strip_permissions_open,
            &mut self.implement_menu_open,
            &mut self.context_meter_open,
            &mut self.stash.menu_open,
            &mut self.branch.picker_open,
            &mut self.branch.workspace_menu_open,
        ] {
            if *open {
                *open = false;
                changed = true;
            }
        }
        self.permission_preview = None;
        if self.active_trigger.take().is_some() {
            let text = self.textarea.read(cx).value().to_string();
            self.dismissed_trigger_text = Some(text);
            changed = true;
        }
        if changed {
            cx.notify();
        }
    }

    /// True while any composer popup, menu, or drawer is open.
    fn any_overlay_open(&self) -> bool {
        self.model_picker_open
            || self.footer_permissions_open
            || self.picker_permissions_open
            || self.strip_permissions_open
            || self.implement_menu_open
            || self.context_meter_open
            || self.stash.menu_open
            || self.branch_popup_open()
            || self.active_trigger.is_some()
    }

    /// Opens the native file picker to attach one or more files or images to the draft.
    pub(crate) fn pick_attachments(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.connection.is_none() {
            return;
        }
        let prompt = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Attach".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = prompt.await else {
                return;
            };
            let _ = this.update_in(cx, |composer, window, cx| {
                composer.attach_paths(paths, window, cx);
            });
        })
        .detach();
    }

    /// Reads local file paths (from file picker, drag-and-drop, or clipboard) and uploads each
    /// into the composer attachment strip.
    pub(crate) fn attach_paths(
        &mut self,
        paths: Vec<PathBuf>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if self.connection.is_none() || paths.is_empty() {
            return;
        }
        for path in paths {
            if !path.is_file() {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("attachment")
                .to_owned();
            let mime_type = infer_mime_type(&path).to_owned();
            match std::fs::read(&path) {
                Ok(bytes) => {
                    self.stage_and_upload_bytes(name, mime_type, bytes, window, cx);
                }
                Err(err) => {
                    let local_id = self.next_attachment_id;
                    self.next_attachment_id = self.next_attachment_id.wrapping_add(1);
                    self.attachments.push(PendingAttachment {
                        local_id,
                        name,
                        size_bytes: 0,
                        status: AttachmentUploadStatus::Error(err.to_string()),
                    });
                    cx.notify();
                }
            }
        }
    }

    /// Stages in-memory bytes (such as a pasted clipboard image) and uploads via
    /// `attachments.createUploadUrl`.
    fn stage_and_upload_bytes(
        &mut self,
        name: String,
        mime_type: String,
        bytes: Vec<u8>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        let local_id = self.next_attachment_id;
        self.next_attachment_id = self.next_attachment_id.wrapping_add(1);
        let size_bytes = bytes.len();
        self.attachments.push(PendingAttachment {
            local_id,
            name: name.clone(),
            size_bytes,
            status: AttachmentUploadStatus::Uploading,
        });
        cx.notify();

        cx.spawn_in(window, async move |this, cx| {
            let upload_res = conn.upload_chat_attachment(name, mime_type, bytes).await;
            let _ = this.update(cx, |composer, cx| {
                // The upload may finish after the user switched threads; its draft is parked then.
                if let Some(slot) = composer
                    .attachments
                    .iter_mut()
                    .chain(composer.drafts.parked_attachments_mut())
                    .find(|a| a.local_id == local_id)
                {
                    slot.status = match upload_res {
                        Ok(att) => AttachmentUploadStatus::Ready(att),
                        Err(err) => AttachmentUploadStatus::Error(err.to_string()),
                    };
                    cx.notify();
                }
            });
        })
        .detach();
    }

    #[cfg(test)]
    #[must_use]
    pub(crate) fn draft_text_for_test(&self, cx: &App) -> String {
        self.textarea.read(cx).value().to_string()
    }

    #[cfg(test)]
    pub(crate) fn parked_text_for_test(&self, key: &str) -> Option<String> {
        self.drafts.parked_draft(key).map(|d| d.text.clone())
    }

    #[cfg(test)]
    pub(crate) fn attachment_states_for_test(&self) -> Vec<(String, String)> {
        self.attachments
            .iter()
            .map(|a| {
                let state = match &a.status {
                    AttachmentUploadStatus::Uploading => "uploading".to_owned(),
                    AttachmentUploadStatus::Ready(att) => {
                        let id = match att {
                            ChatAttachment::Image(img) => img.id.as_str(),
                            ChatAttachment::File(file) => file.id.as_str(),
                            ChatAttachment::Unknown(_) => "unknown",
                        };
                        format!("ready:{id}")
                    }
                    AttachmentUploadStatus::Error(err) => format!("error:{err}"),
                };
                (a.name.clone(), state)
            })
            .collect()
    }

    /// Intercepts `⌘V` when the clipboard holds copied files or a standalone image (screenshots,
    /// image copies without accompanying plain text), uploading them as chat attachments.
    ///
    /// Returns `true` if the paste was consumed as attachments (caller stops propagation so the
    /// textarea does not also paste raw paths or fail silently).
    fn try_paste_attachments(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> bool {
        if self.connection.is_none() {
            return false;
        }
        let Some(item) = cx.read_from_clipboard() else {
            return false;
        };
        let mut paths: Vec<PathBuf> = Vec::new();
        let mut images: Vec<gpui_kit::Image> = Vec::new();
        let mut has_text = false;
        for entry in item.entries() {
            match entry {
                ClipboardEntry::ExternalPaths(p) => {
                    paths.extend(p.paths().iter().cloned());
                }
                ClipboardEntry::Image(img) => {
                    images.push(img.clone());
                }
                ClipboardEntry::String(text) if !text.text().is_empty() => {
                    has_text = true;
                }
                ClipboardEntry::String(_) => {}
            }
        }
        if !paths.is_empty() {
            self.attach_paths(paths, window, cx);
            return true;
        }
        // Rich text copied from browsers sometimes includes an image flavor alongside text;
        // keep plain text pasting as text (matching Threadbear's `take_reply_clipboard`).
        if has_text || images.is_empty() {
            return false;
        }
        let mut attached_any = false;
        for image in images {
            if let Some((ext, mime)) = clipboard_image_spec(image.format) {
                let name = format!("pasted-{:x}.{ext}", image.id);
                self.stage_and_upload_bytes(name, mime.to_owned(), image.bytes, window, cx);
                attached_any = true;
            }
        }
        attached_any
    }

    /// Toggles Operator voice dictation: starts a session when idle, stops & transcribes when
    /// recording.
    pub(crate) fn toggle_dictation(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        self.dictation_error = None;
        match self.dictation.clone() {
            DictationState::Idle => self.start_dictation(window, cx),
            DictationState::Recording { session_id } => {
                self.stop_dictation(session_id, window, cx);
            }
            DictationState::Starting { session_id } => {
                self.cancel_dictation(session_id, cx);
            }
            DictationState::Transcribing { .. } => {}
        }
    }

    fn start_dictation(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let seq = self.next_dictation_seq;
        self.next_dictation_seq = self.next_dictation_seq.wrapping_add(1);
        let session_id = next_dictation_session_id(seq);
        self.dictation = DictationState::Starting {
            session_id: session_id.clone(),
        };
        cx.notify();

        let sid_for_start = session_id.clone();
        cx.spawn_in(window, async move |this, cx| {
            let start_res = crate::live::RT
                .spawn(async move {
                    let client = OperatorClient::from_config()?;
                    match client.start(&sid_for_start).await? {
                        DictationStart::Started => Ok(DictationStart::Started),
                        DictationStart::Unsupported => {
                            // Older Operator without session API: trigger legacy toggle.
                            client.legacy_toggle().await?;
                            Ok(DictationStart::Unsupported)
                        }
                    }
                })
                .await;

            match start_res {
                Ok(Ok(DictationStart::Started)) => {
                    let still_same = this
                        .update_in(cx, |composer, window, cx| {
                            if composer.dictation.session_id() == Some(session_id.as_str()) {
                                composer.dictation = DictationState::Recording {
                                    session_id: session_id.clone(),
                                };
                                composer.spawn_dictation_wait(session_id.clone(), window, cx);
                                cx.notify();
                                true
                            } else {
                                false
                            }
                        })
                        .unwrap_or(false);
                    if !still_same {
                        let sid = session_id.clone();
                        crate::live::RT.spawn(async move {
                            if let Ok(client) = OperatorClient::from_config() {
                                let _ = client.cancel(&sid).await;
                            }
                        });
                    }
                }
                Ok(Ok(DictationStart::Unsupported)) => {
                    let _ = this.update(cx, |composer, cx| {
                        composer.dictation = DictationState::Idle;
                        cx.notify();
                    });
                }
                Ok(Err(err)) => {
                    let _ = this.update(cx, |composer, cx| {
                        composer.dictation = DictationState::Idle;
                        composer.dictation_error = Some(friendly_operator_error(&err));
                        cx.notify();
                    });
                }
                Err(err) => {
                    let _ = this.update(cx, |composer, cx| {
                        composer.dictation = DictationState::Idle;
                        composer.dictation_error = Some(err.to_string());
                        cx.notify();
                    });
                }
            }
        })
        .detach();
    }

    fn spawn_dictation_wait(
        &mut self,
        session_id: String,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        cx.spawn_in(window, async move |this, cx| {
            loop {
                let sid = session_id.clone();
                let wait_res = crate::live::RT
                    .spawn(async move {
                        let client = OperatorClient::from_config()?;
                        client.wait(&sid).await
                    })
                    .await;

                match wait_res {
                    Ok(Ok(DictationWait::StillWaiting)) => {
                        let keep_going = this
                            .read_with(cx, |composer, _| {
                                matches!(
                                    &composer.dictation,
                                    DictationState::Recording { session_id: active }
                                        if active == &session_id
                                )
                            })
                            .unwrap_or(false);
                        if !keep_going {
                            break;
                        }
                    }
                    Ok(Ok(DictationWait::Transcript(text))) => {
                        let _ = this.update_in(cx, |composer, window, cx| {
                            if matches!(
                                &composer.dictation,
                                DictationState::Recording { session_id: active }
                                    if active == &session_id
                            ) {
                                composer.dictation = DictationState::Idle;
                                composer.apply_dictation_transcript(&text, window, cx);
                                cx.notify();
                            }
                        });
                        break;
                    }
                    // Older Operator without /dictate/wait, or wait cancelled when user clicked stop.
                    Ok(Ok(DictationWait::Unsupported)) | Ok(Err(_)) | Err(_) => {
                        break;
                    }
                }
            }
        })
        .detach();
    }

    fn stop_dictation(
        &mut self,
        session_id: String,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.dictation = DictationState::Transcribing {
            session_id: session_id.clone(),
        };
        cx.notify();

        let sid = session_id.clone();
        cx.spawn_in(window, async move |this, cx| {
            let stop_res = crate::live::RT
                .spawn(async move {
                    let client = OperatorClient::from_config()?;
                    client.stop(&sid).await
                })
                .await;

            let _ = this.update_in(cx, |composer, window, cx| {
                if composer.dictation.session_id() != Some(session_id.as_str()) {
                    return;
                }
                composer.dictation = DictationState::Idle;
                let submit = std::mem::take(&mut composer.submit_after_dictation);
                match stop_res {
                    Ok(Ok(text)) => {
                        composer.apply_dictation_transcript(&text, window, cx);
                        if submit {
                            composer.submit(window, cx);
                        }
                    }
                    Ok(Err(err)) => {
                        composer.dictation_error = Some(friendly_operator_error(&err));
                    }
                    Err(err) => {
                        composer.dictation_error = Some(err.to_string());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn cancel_dictation(&mut self, session_id: String, cx: &mut Context<'_, Self>) {
        self.dictation = DictationState::Idle;
        self.dictation_error = None;
        cx.notify();
        crate::live::RT.spawn(async move {
            if let Ok(client) = OperatorClient::from_config() {
                let _ = client.cancel(&session_id).await;
            }
        });
    }

    fn apply_dictation_transcript(
        &mut self,
        transcript: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let existing = self.textarea.read(cx).value().to_string();
        let Some(merged) = append_transcript(&existing, transcript) else {
            return;
        };
        self.textarea.update(cx, |input, cx| {
            input.set_value(merged, window, cx);
            input.focus(window, cx);
        });
        self.on_draft_changed(cx);
    }

    fn remove_attachment(&mut self, local_id: u64, cx: &mut Context<'_, Self>) {
        let before = self.attachments.len();
        self.attachments.retain(|a| a.local_id != local_id);
        if self.attachments.len() != before {
            cx.notify();
        }
    }

    /// Submits the current draft with the default dispatch (Enter or the send button).
    pub(crate) fn submit(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        self.submit_with_dispatch(None, window, cx);
    }

    /// Submits the current non-empty draft (and any uploaded attachments) via [`ComposerEvent::Send`],
    /// or saves an edited queued message via [`ComposerEvent::EditQueuedMessage`].
    ///
    /// `alternate` is the `⌘`/`Ctrl` state of the click or `⌘Enter`; `None` uses the held modifier.
    /// With the plan follow-up prompt showing, an empty draft implements the plan (switching back
    /// to build mode) and text refines it (`resolvePlanFollowUpSubmission`).
    pub(crate) fn submit_with_dispatch(
        &mut self,
        alternate: Option<bool>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if self.submitting || self.answering_approval {
            return;
        }
        let raw = self.textarea.read(cx).value().to_string();
        if prompt_length_message(&raw).is_some() {
            return;
        }
        let trimmed = raw.trim().to_owned();
        let action = if self.editing_queued.is_some() {
            ComposerSendAction::Message
        } else {
            composer_send_action(&self.pending_request, trimmed.is_empty())
        };
        match action {
            ComposerSendAction::Blocked => return,
            ComposerSendAction::AnswerQuestion => {
                self.textarea
                    .update(cx, |input, cx| input.set_value("", window, cx));
                self.active_trigger = None;
                self.dismissed_trigger_text = None;
                cx.emit(ComposerEvent::AnswerQuestion { text: raw });
                cx.emit(ComposerEvent::TypingGuard(TypingGuardInput::Send));
                cx.notify();
                return;
            }
            ComposerSendAction::Message
            | ComposerSendAction::RedirectApprovals
            | ComposerSendAction::DeclineWithFeedback => {}
        }
        let holds_draft = matches!(
            action,
            ComposerSendAction::RedirectApprovals | ComposerSendAction::DeclineWithFeedback
        );
        let still_uploading = self
            .attachments
            .iter()
            .any(|a| matches!(a.status, AttachmentUploadStatus::Uploading));
        if still_uploading {
            return;
        }
        let ready_attachments: Vec<ChatAttachment> = self
            .attachments
            .iter()
            .filter_map(|a| match &a.status {
                AttachmentUploadStatus::Ready(att) => Some(att.clone()),
                _ => None,
            })
            .collect();

        if self.editing_queued.is_some() {
            // `conn-server`'s `queued-run.edit` requires non-empty text.
            if trimmed.is_empty() {
                return;
            }
            let Some(mut editing) = self.editing_queued.take() else {
                return;
            };
            editing.existing_attachments.extend(ready_attachments);
            let combined = editing.existing_attachments;
            let attachments = Some(combined);
            self.textarea.update(cx, |input, cx| {
                input.set_value(editing.saved_draft, window, cx);
                input.focus(window, cx);
            });
            self.attachments.clear();
            self.active_trigger = None;
            self.dismissed_trigger_text = None;
            self.model_picker_open = false;
            cx.emit(ComposerEvent::EditQueuedMessage {
                run_id: editing.run_id,
                text: trimmed,
                attachments,
            });
            cx.notify();
            return;
        }

        let text = match self.plan_follow_up.as_deref() {
            Some(plan) if trimmed.is_empty() && ready_attachments.is_empty() => {
                if self.interaction_mode != "default" {
                    self.interaction_mode = "default".to_owned();
                    cx.emit(ComposerEvent::InteractionModeSelected("default".to_owned()));
                }
                format!("{PLAN_IMPLEMENTATION_PROMPT_PREFIX}{}", plan.trim())
            }
            _ => trimmed,
        };
        if text.is_empty() && ready_attachments.is_empty() {
            return;
        }
        let dispatch = resolve_dispatch_mode(
            self.working,
            self.effective_follow_up(),
            true,
            alternate.unwrap_or(self.alternate_modifier),
        );
        self.active_trigger = None;
        self.dismissed_trigger_text = None;
        self.model_picker_open = false;
        self.implement_menu_open = false;
        // Approvals are declined before the message goes, so the draft stays until then: an
        // edit meanwhile, or a refused decline, keeps it (`useComposerSend`).
        let held_draft = if holds_draft {
            self.answering_approval = true;
            Some(self.held_draft(cx))
        } else {
            self.textarea.update(cx, |input, cx| {
                input.set_value("", window, cx);
            });
            self.attachments.clear();
            None
        };
        cx.emit(ComposerEvent::Send {
            text,
            attachments: ready_attachments,
            dispatch,
            held_draft,
        });
        cx.emit(ComposerEvent::TypingGuard(TypingGuardInput::Send));
        cx.notify();
    }

    /// What the pending question's panel needs from the composer (`pendingPanelActions`).
    pub(crate) fn question_panel_status(&self, cx: &App) -> QuestionComposerStatus {
        let uploading = self
            .attachments
            .iter()
            .any(|a| matches!(a.status, AttachmentUploadStatus::Uploading));
        QuestionComposerStatus {
            typed: self.textarea.read(cx).value().to_string(),
            voice_active: matches!(self.dictation, DictationState::Recording { .. }),
            uploading,
            blocked: self.environment_unavailable
                || self.connection.is_none()
                || self.send_disabled_reason.is_some()
                || uploading
                || matches!(self.dictation, DictationState::Transcribing { .. }),
        }
    }

    /// Takes the text typed for the question's answer and empties the editor, as Conn does when
    /// an option replaces the typed answer (`promptRef.current = ""`).
    pub(crate) fn take_answer_text(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> String {
        let text = self.textarea.read(cx).value().to_string();
        if !text.is_empty() {
            self.textarea
                .update(cx, |input, cx| input.set_value("", window, cx));
            self.on_draft_changed(cx);
        }
        text
    }

    /// Edits the unsent text of another draft, such as the thread's while a question's answer
    /// is shown (see [`ComposerDraftStore::edit_parked_text`]).
    pub(crate) fn edit_parked_text(
        &mut self,
        key: &str,
        edit: impl FnOnce(&str) -> Option<String>,
    ) -> bool {
        self.drafts.edit_parked_text(key, edit)
    }

    /// Send on the question panel while dictating: ends the dictation, then submits its text.
    pub(crate) fn finish_dictation_and_submit(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if let DictationState::Recording { session_id } = self.dictation.clone() {
            self.submit_after_dictation = true;
            self.stop_dictation(session_id, window, cx);
        } else {
            self.submit(window, cx);
        }
    }

    /// Hands the stash badge to the host's banner dock (`ComposerBanner.Dock`), or takes it back.
    pub(crate) fn set_stash_docked(&mut self, docked: bool, cx: &mut Context<'_, Self>) {
        if self.stash_docked != docked {
            self.stash_docked = docked;
            cx.notify();
        }
    }

    /// The stash badge's tab for a host dock; none while the drawer is open.
    pub(crate) fn dock_stash_badge(&self, cx: &mut Context<'_, Self>) -> Option<AnyElement> {
        if self.stash.menu_open {
            return None;
        }
        stash::render_stash_badge_tab(&self.stash, &self.tokens, cx)
    }

    /// The live draft, to compare with the one an approval send held.
    pub(crate) fn held_draft(&self, cx: &App) -> HeldDraft {
        HeldDraft {
            text: self.textarea.read(cx).value().to_string(),
            attachment_ids: self.attachments.iter().map(|a| a.local_id).collect(),
        }
    }

    /// Ends an approval send. With `clear`, empties the composer when its draft still equals
    /// `clear` and returns whether it did.
    pub(crate) fn settle_held_draft(
        &mut self,
        clear: Option<&HeldDraft>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> bool {
        self.answering_approval = false;
        let cleared = clear.is_some_and(|held| *held == self.held_draft(cx));
        if cleared {
            self.textarea
                .update(cx, |input, cx| input.set_value("", window, cx));
            self.attachments.clear();
        }
        cx.notify();
        cleared
    }

    /// `Resume thread`: asks the host to continue the interrupted thread.
    pub(super) fn resume_thread(&mut self, cx: &mut Context<'_, Self>) {
        cx.emit(ComposerEvent::Resume);
    }

    /// `Implement in a new thread` (plan follow-up split menu).
    pub(super) fn implement_in_new_thread(&mut self, cx: &mut Context<'_, Self>) {
        self.implement_menu_open = false;
        let Some(plan) = self.plan_follow_up.as_deref() else {
            cx.notify();
            return;
        };
        cx.emit(ComposerEvent::ImplementPlanInNewThread {
            text: format!("{PLAN_IMPLEMENTATION_PROMPT_PREFIX}{}", plan.trim()),
        });
        cx.notify();
    }

    /// Plan / Build toggle (and `Shift+Tab`).
    pub(crate) fn toggle_interaction_mode(&mut self, cx: &mut Context<'_, Self>) {
        let next = if self.interaction_mode == "plan" {
            "default"
        } else {
            "plan"
        };
        self.interaction_mode = next.to_owned();
        cx.emit(ComposerEvent::InteractionModeSelected(next.to_owned()));
        cx.notify();
    }

    pub(super) fn toggle_footer_permissions_menu(&mut self, cx: &mut Context<'_, Self>) {
        self.footer_permissions_open = !self.footer_permissions_open;
        self.permission_preview = None;
        if self.footer_permissions_open {
            self.model_picker_open = false;
            self.strip_permissions_open = false;
        }
        cx.notify();
    }

    pub(super) fn toggle_picker_permissions_menu(&mut self, cx: &mut Context<'_, Self>) {
        self.picker_permissions_open = !self.picker_permissions_open;
        self.permission_preview = None;
        cx.notify();
    }

    fn toggle_strip_permissions_menu(&mut self, cx: &mut Context<'_, Self>) {
        self.strip_permissions_open = !self.strip_permissions_open;
        self.permission_preview = None;
        if self.strip_permissions_open {
            self.model_picker_open = false;
            self.footer_permissions_open = false;
        }
        cx.notify();
    }

    /// Hover preview inside `ComposerPermissionsSection`.
    pub(super) fn preview_permission(
        &mut self,
        mode: &'static str,
        hovered: bool,
        cx: &mut Context<'_, Self>,
    ) {
        let next = if hovered {
            Some(mode)
        } else if self.permission_preview == Some(mode) {
            None
        } else {
            self.permission_preview
        };
        if next != self.permission_preview {
            self.permission_preview = next;
            cx.notify();
        }
    }

    /// Picks a permission mode; the radio item closes its menu (`closeOnClick`).
    pub(super) fn pick_runtime_mode(&mut self, mode: &'static str, cx: &mut Context<'_, Self>) {
        self.footer_permissions_open = false;
        self.picker_permissions_open = false;
        self.strip_permissions_open = false;
        self.permission_preview = None;
        if self.runtime_mode != mode {
            self.runtime_mode = mode.to_owned();
            cx.emit(ComposerEvent::RuntimeModeSelected(mode.to_owned()));
        }
        cx.notify();
    }

    pub(super) fn set_context_meter_open(&mut self, open: bool, cx: &mut Context<'_, Self>) {
        if self.context_meter_open != open {
            self.context_meter_open = open;
            cx.notify();
        }
    }

    /// The selected model from the catalog, when known.
    fn selected_model_option(&self) -> Option<&ModelOption> {
        self.catalog
            .find_model(self.selected_instance_id.as_deref(), &self.selected_model)
    }

    /// The selected provider's catalog group.
    fn selected_provider_group(&self) -> Option<&model_picker::ProviderGroup> {
        let instance = self
            .selected_model_option()
            .map(|m| m.instance_id.as_str())
            .or(self.selected_instance_id.as_deref())?;
        self.catalog
            .providers
            .iter()
            .find(|p| p.instance_id == instance)
    }

    /// Skills of the selected provider for the `$` menu.
    fn selected_provider_skills(&self) -> &[SkillEntry] {
        self.selected_provider_group()
            .map_or(&[], |group| group.skills.as_slice())
    }

    /// Sets one model option (effort level, speed, or another trait) on the selected model.
    pub(super) fn set_model_option(
        &mut self,
        option_id: String,
        value: serde_json::Value,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(opt) = self.selected_model_option() else {
            return;
        };
        let instance_id = opt.instance_id.clone();
        let model = opt.slug.clone();
        let mut opts = self.selected_options.clone().unwrap_or_default();
        opts.insert(option_id, value);
        self.selected_options = Some(opts.clone());
        cx.emit(ComposerEvent::ModelSelected {
            instance_id,
            model,
            options: Some(opts),
        });
        cx.notify();
    }

    /// `⌘S`: stashes a non-empty draft, or toggles the stash drawer when the draft is empty.
    pub(super) fn stash_or_toggle(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.editing_queued.is_some() {
            return;
        }
        let text = self.textarea.read(cx).value().to_string();
        let ready: Vec<ChatAttachment> = self
            .attachments
            .iter()
            .filter_map(|a| match &a.status {
                AttachmentUploadStatus::Ready(att) => Some(att.clone()),
                _ => None,
            })
            .collect();
        if text.trim().is_empty() && ready.is_empty() {
            self.toggle_stash_menu(cx);
            return;
        }
        self.stash.push(text, ready, stash::now_ms());
        self.attachments.clear();
        self.active_trigger = None;
        self.dismissed_trigger_text = None;
        self.textarea.update(cx, |input, cx| {
            input.set_value("", window, cx);
            input.focus(window, cx);
        });
        cx.notify();
    }

    pub(super) fn toggle_stash_menu(&mut self, cx: &mut Context<'_, Self>) {
        self.stash.menu_open = !self.stash.menu_open;
        if self.stash.menu_open {
            self.stash.highlighted = 0;
            self.model_picker_open = false;
            self.active_trigger = None;
        }
        cx.notify();
    }

    pub(super) fn close_stash_menu(&mut self, cx: &mut Context<'_, Self>) {
        if self.stash.menu_open {
            self.stash.menu_open = false;
            cx.notify();
        }
    }

    pub(super) fn delete_stash_entry(&mut self, id: u64, cx: &mut Context<'_, Self>) {
        self.stash.delete(id);
        if self.stash.entries().is_empty() {
            self.stash.menu_open = false;
        }
        cx.notify();
    }

    pub(super) fn highlight_stash_entry(&mut self, index: usize, cx: &mut Context<'_, Self>) {
        if self.stash.highlighted != index {
            self.stash.highlighted = index;
            cx.notify();
        }
    }

    /// Restores a stashed draft; a non-empty current draft swaps into the stash.
    pub(super) fn restore_stash_entry(
        &mut self,
        id: u64,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(entry) = self.stash.take(id) else {
            return;
        };
        let current = self.textarea.read(cx).value().to_string();
        let current_ready: Vec<ChatAttachment> = self
            .attachments
            .iter()
            .filter_map(|a| match &a.status {
                AttachmentUploadStatus::Ready(att) => Some(att.clone()),
                _ => None,
            })
            .collect();
        if !current.trim().is_empty() || !current_ready.is_empty() {
            self.stash.push(current, current_ready, stash::now_ms());
        }
        self.attachments = entry
            .attachments
            .into_iter()
            .map(|att| {
                let local_id = self.next_attachment_id;
                self.next_attachment_id = self.next_attachment_id.wrapping_add(1);
                PendingAttachment {
                    local_id,
                    name: chat_attachment_name(&att).to_owned(),
                    size_bytes: chat_attachment_size(&att),
                    status: AttachmentUploadStatus::Ready(att),
                }
            })
            .collect();
        self.stash.menu_open = false;
        self.textarea.update(cx, |input, cx| {
            input.set_value(entry.prompt, window, cx);
            input.focus(window, cx);
        });
        self.on_draft_changed(cx);
    }

    fn restore_highlighted_stash_entry(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if let Some(id) = self.stash.highlighted_id() {
            self.restore_stash_entry(id, window, cx);
        }
    }

    pub(super) fn select_picker_provider(
        &mut self,
        instance_id: String,
        cx: &mut Context<'_, Self>,
    ) {
        self.picker_provider_filter = Some(instance_id);
        self.picker_highlighted_index = 0;
        cx.notify();
    }

    pub(super) fn pick_model(
        &mut self,
        instance_id: String,
        model: String,
        cx: &mut Context<'_, Self>,
    ) {
        if let Some(opt) = self.catalog.find_model(Some(&instance_id), &model) {
            self.selected_driver = Some(opt.driver.clone());
        }
        let same_model = self.selected_instance_id.as_deref() == Some(instance_id.as_str())
            && self.selected_model == model;
        self.selected_instance_id = Some(instance_id.clone());
        self.selected_model = model.clone();
        if !same_model {
            self.selected_options = None;
        }
        // Docked: the popup stays open so the effort column can take the next pick.
        cx.emit(ComposerEvent::ModelSelected {
            instance_id,
            model,
            options: self.selected_options.clone(),
        });
        cx.notify();
    }

    /// Replaces the active trigger range with `replacement` and moves the caret after it.
    fn replace_active_trigger(
        &mut self,
        replacement: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if let Some(trigger) = self.active_trigger.take() {
            let current = self.textarea.read(cx).value().to_string();
            let (next, caret) = replace_trigger(&current, &trigger, replacement);
            self.textarea.update(cx, |input, cx| {
                input.set_value(next, window, cx);
                input.set_selected_range(caret..caret, cx);
                input.focus(window, cx);
            });
        }
        self.dismissed_trigger_text = None;
    }

    pub(super) fn apply_slash_command(
        &mut self,
        command: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        // `/model` and `/plan` clear their token; other commands stay in the draft.
        let replacement = match command {
            "model" | "plan" => String::new(),
            other => format!("/{other} "),
        };
        self.replace_active_trigger(&replacement, window, cx);
        if command == "model" {
            self.toggle_model_picker(window, cx);
            return;
        }
        cx.emit(ComposerEvent::SlashCommand(command.to_owned()));
        cx.notify();
    }

    pub(super) fn apply_file_mention(
        &mut self,
        path: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.replace_active_trigger(&format!("@{path} "), window, cx);
        cx.notify();
    }

    /// Inserts `$<skill.name> ` for the picked `$` menu entry.
    pub(super) fn apply_skill(
        &mut self,
        name: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.replace_active_trigger(&format!("${name} "), window, cx);
        cx.notify();
    }

    fn on_draft_changed(&mut self, cx: &mut Context<'_, Self>) {
        let (text, cursor) = {
            let input = self.textarea.read(cx);
            (input.value().to_string(), input.cursor())
        };
        if self.dismissed_trigger_text.as_deref() == Some(text.as_str()) {
            cx.notify();
            return;
        }
        self.dismissed_trigger_text = None;

        let next_trigger = detect_trigger(&text, cursor);
        let query_changed = next_trigger != self.active_trigger;
        self.active_trigger = next_trigger.clone();

        if query_changed {
            self.menu_highlighted_index = 0;
            if let Some(trigger) = next_trigger {
                self.model_picker_open = false;
                if trigger.kind == ComposerTriggerKind::FileMention {
                    self.search_files(trigger.query, cx);
                }
            }
        }
        cx.notify();
    }

    fn search_files(&mut self, query: String, cx: &mut Context<'_, Self>) {
        let (Some(conn), Some(cwd)) = (self.connection.clone(), self.workspace_root.clone()) else {
            self.file_mentions.clear();
            self.file_mentions_loading = false;
            return;
        };
        self.file_search_generation = self.file_search_generation.wrapping_add(1);
        let generation = self.file_search_generation;
        self.file_mentions_loading = true;
        cx.notify();

        cx.spawn(async move |this, cx| {
            let payload = ProjectSearchEntriesInput {
                cwd,
                query,
                limit: FILE_SEARCH_LIMIT,
                kind: None,
                image_only: None,
            };
            let res = conn
                .call::<search_entries::Payload, search_entries::Success>(
                    "projects.searchEntries",
                    &payload,
                )
                .await;
            let _ = this.update(cx, |composer, cx| {
                if composer.file_search_generation != generation {
                    return;
                }
                composer.file_mentions_loading = false;
                match res {
                    Ok(result) => {
                        composer.file_mentions = result
                            .entries
                            .into_iter()
                            .map(FileMentionEntry::from_contract)
                            .collect();
                    }
                    Err(_) => {
                        composer.file_mentions.clear();
                    }
                }
                composer.menu_highlighted_index = 0;
                cx.notify();
            });
        })
        .detach();
    }

    fn move_overlay_selection(&mut self, delta: isize, cx: &mut Context<'_, Self>) {
        if self.model_picker_open {
            let query = self.model_search_input.read(cx).value().to_string();
            let effective = self
                .picker_provider_filter
                .as_deref()
                .or(self.selected_instance_id.as_deref())
                .or_else(|| {
                    self.catalog
                        .picker_providers()
                        .next()
                        .map(|p| p.instance_id.as_str())
                });
            let count = self.catalog.filtered_models(effective, &query).len();
            if count > 0 {
                self.picker_highlighted_index =
                    step_index(self.picker_highlighted_index, delta, count);
                cx.notify();
            }
            return;
        }

        if let Some(trigger) = &self.active_trigger {
            let count = match trigger.kind {
                ComposerTriggerKind::Command => filter_slash_commands(&trigger.query).len(),
                ComposerTriggerKind::FileMention => self.file_mentions.len(),
                ComposerTriggerKind::Skill => {
                    filter_skills(self.selected_provider_skills(), &trigger.query).len()
                }
            };
            if count > 0 {
                self.menu_highlighted_index = step_index(self.menu_highlighted_index, delta, count);
                cx.notify();
            }
        }
    }

    fn confirm_highlighted_model(&mut self, cx: &mut Context<'_, Self>) {
        if !self.model_picker_open {
            return;
        }
        let query = self.model_search_input.read(cx).value().to_string();
        let effective = self
            .picker_provider_filter
            .as_deref()
            .or(self.selected_instance_id.as_deref())
            .or_else(|| {
                self.catalog
                    .picker_providers()
                    .next()
                    .map(|p| p.instance_id.as_str())
            });
        let picked = self
            .catalog
            .filtered_models(effective, &query)
            .get(self.picker_highlighted_index)
            .map(|m| (m.instance_id.clone(), m.slug.clone()));
        if let Some((instance_id, slug)) = picked {
            self.pick_model(instance_id, slug, cx);
        }
    }

    fn confirm_active_menu(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let Some(trigger) = self.active_trigger.clone() else {
            return;
        };
        match trigger.kind {
            ComposerTriggerKind::Command => {
                let commands = filter_slash_commands(&trigger.query);
                if let Some(cmd) = commands.get(self.menu_highlighted_index) {
                    self.apply_slash_command(cmd.name, window, cx);
                }
            }
            ComposerTriggerKind::FileMention => {
                if let Some(entry) = self.file_mentions.get(self.menu_highlighted_index) {
                    let path = entry.path.clone();
                    self.apply_file_mention(&path, window, cx);
                }
            }
            ComposerTriggerKind::Skill => {
                let name = filter_skills(self.selected_provider_skills(), &trigger.query)
                    .get(self.menu_highlighted_index)
                    .map(|skill| skill.name.clone());
                if let Some(name) = name {
                    self.apply_skill(&name, window, cx);
                }
            }
        }
    }

    fn display_model_and_driver(&self) -> (String, Option<&str>) {
        if let Some(opt) = self.selected_model_option() {
            return (opt.trigger_label(), Some(opt.driver.as_str()));
        }
        (self.selected_model.clone(), self.selected_driver.as_deref())
    }

    /// Renders Conn's `BranchToolbar` / `ComposerSurface.ContextStrip` under the composer card:
    /// worktree/local indicator + branch name on the left; on new-thread drafts, the trailing
    /// permissions control (`ComposerContextPermissions`).
    fn render_context_strip(&self, tokens: &Tokens, cx: &mut Context<'_, Self>) -> AnyElement {
        let fg = hsla(tokens.foreground);
        let muted = hsla(tokens.muted_foreground);
        let hover_bg = hsla(tokens.shell_highlight);

        let mut left = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .min_w_0()
            .flex_1()
            .overflow_hidden();

        left = left.child(self.render_workspace_control(tokens, cx));
        let branch_control = self.render_branch_control(tokens, cx);

        // New-thread drafts name the permissions at the strip's trailing end
        // (`ComposerContextPermissions`); started threads keep them in the footer and picker.
        let trailing: Option<AnyElement> = self.is_draft.then(|| {
            let option = runtime_mode_option(&self.runtime_mode);
            let open = self.strip_permissions_open;
            let mut slot = div().relative().child(
                div()
                    .id("composer-context-permissions")
                    .a11y_button(
                        "composer.context-permissions",
                        format!("Permissions: {}", option.label),
                    )
                    .aria_expanded(open)
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.0))
                    .h(px(22.0))
                    .px(px(6.0))
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .text_color(if open { fg } else { muted })
                    .when(open, |el| el.bg(hover_bg))
                    .hover(move |s| s.bg(hover_bg).text_color(fg))
                    .on_click(cx.listener(|composer, _, _, cx| {
                        composer.toggle_strip_permissions_menu(cx);
                    }))
                    .conn_tooltip("Permissions · ⌘⇧A", tokens)
                    .child(icons::icon(
                        option.icon,
                        12.0,
                        if open { fg } else { muted },
                    ))
                    .child(option.label),
            );
            if open {
                let options = self.runtime_mode_options();
                let section = render_permissions_section(
                    &self.runtime_mode,
                    &options,
                    self.permission_preview,
                    "strip",
                    tokens,
                    cx,
                );
                slot = slot.child(
                    deferred(
                        div().absolute().bottom_full().right_0().mb(px(4.0)).child(
                            footer::popover_surface("composer-strip-permissions-popup", tokens)
                                .child(section),
                        ),
                    )
                    .with_priority(3),
                );
            }
            slot.into_any_element()
        });

        div()
            .id("composer-context-strip")
            .test_support()
            .a11y(
                gpui_kit::Role::Toolbar,
                "composer.context-strip",
                "Thread context",
            )
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .w_full()
            .h(px(22.0))
            .my(px(CONTEXT_STRIP_VERTICAL_MARGIN_PX))
            .px(px(8.0))
            .text_size(px(12.0))
            .line_height(px(16.0))
            .text_color(muted)
            .child(left)
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.0))
                    .min_w_0()
                    .child(branch_control)
                    .when_some(trailing, |el, trailing| {
                        el.child(div().flex_none().child(trailing))
                    }),
            )
            .into_any_element()
    }

    /// Permission modes the selected provider supports.
    fn runtime_mode_options(&self) -> Vec<footer::RuntimeModeOption> {
        compatible_runtime_modes(
            self.selected_provider_group()
                .map_or(&[], |group| group.supported_runtime_modes.as_slice()),
        )
    }
}

impl Render for Composer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let provider_unavailable = self.connection.is_some()
            && !self.catalog_loading
            && self.catalog_error.is_none()
            && self.catalog.providers.is_empty();
        let placeholder = composer_placeholder(&self.pending_request, provider_unavailable);
        if self.applied_placeholder != placeholder {
            self.applied_placeholder = placeholder;
            self.textarea.update(cx, |input, cx| {
                input.set_placeholder(placeholder, window, cx)
            });
        }
        let length_alert = prompt_length_message(&self.textarea.read(cx).value());
        let is_editing_queued = self.editing_queued.is_some();
        let has_ready_attachments = self
            .attachments
            .iter()
            .any(|a| matches!(a.status, AttachmentUploadStatus::Ready(_)));
        let is_uploading = self
            .attachments
            .iter()
            .any(|a| matches!(a.status, AttachmentUploadStatus::Uploading));
        let has_non_empty_text = !self.textarea.read(cx).value().trim().is_empty();
        let send_action = composer_send_action(&self.pending_request, !has_non_empty_text);
        let choice_only = self
            .pending_request
            .question
            .is_some_and(|q| !q.allow_custom_answer);
        let has_sendable = if is_editing_queued {
            has_non_empty_text && !is_uploading
        } else if self.pending_request.question.is_some() {
            send_action == ComposerSendAction::AnswerQuestion
        } else {
            (has_non_empty_text || has_ready_attachments) && !is_uploading
        };
        let uploading_count = self
            .attachments
            .iter()
            .filter(|a| matches!(a.status, AttachmentUploadStatus::Uploading))
            .count();
        let attachment_block_reason = match uploading_count {
            0 => None,
            1 => Some("Attachment still uploading".to_owned()),
            _ => Some("Attachments still uploading".to_owned()),
        };
        let (model_label, driver) = self.display_model_and_driver();
        let tokens = self.tokens.clone();

        let (card_bg, card_border) = composer_surface_colors(&tokens);
        let highlight_bg = hsla(tokens.shell_highlight);
        let fg = hsla(tokens.foreground);
        let muted = hsla(tokens.muted_foreground);

        // Unified Model + Effort trigger (`ProviderModelPicker` trigger + `describeComposerEffort`).
        let selected_model = self.selected_model_option().cloned();
        let effort = selected_model
            .as_ref()
            .map(|m| m.effort_summary(self.selected_options.as_ref()))
            .unwrap_or_default();
        let full_label = selected_model
            .as_ref()
            .map_or_else(|| model_label.clone(), ModelOption::display_label);
        let trigger_aria = [Some(full_label.clone()), effort.detail.clone()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(", ");
        let trigger_tooltip = [Some(full_label), effort.detail.clone()]
            .into_iter()
            .flatten()
            .chain(std::iter::once(MODEL_PICKER_SHORTCUT_LABEL.to_owned()))
            .collect::<Vec<_>>()
            .join(" · ");
        let picker_open = self.model_picker_open;
        let suffix_color = if picker_open { fg } else { muted };
        let mut suffix = div()
            .flex()
            .flex_none()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .ml(px(-2.0))
            .text_color(suffix_color);
        let has_suffix =
            effort.word.is_some() || effort.speed.is_some() || effort.context_window.is_some();
        if let Some(word) = effort.word.clone() {
            suffix = suffix.child(div().max_w(px(96.0)).truncate().child(word));
        }
        if effort.speed.is_some() {
            suffix = suffix.child(icons::icon("superhero/fast.svg", 12.0, suffix_color));
        }
        if let Some(window_label) = effort.context_window {
            suffix = suffix.child(
                div()
                    .max_w(px(96.0))
                    .truncate()
                    .text_size(px(12.0))
                    .child(window_label),
            );
        }
        let model_trigger = div()
            .id("chat-composer-model-picker")
            .test_support()
            .a11y_button("composer.model-picker", trigger_aria)
            .aria_expanded(picker_open)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .h(px(FOOTER_CONTROL_HEIGHT_PX))
            .pl(px(8.0))
            .pr(px(6.0))
            .rounded(px(8.0))
            .cursor_pointer()
            .text_size(px(13.0))
            .line_height(px(20.0))
            .font_weight(FontWeight::MEDIUM)
            .text_color(if picker_open {
                fg
            } else {
                hsla_alpha(tokens.foreground, 0.80)
            })
            .when(picker_open, |s| s.bg(highlight_bg))
            .hover(move |s| s.bg(highlight_bg).text_color(fg))
            .on_click(cx.listener(|composer, _, window, cx| {
                composer.toggle_model_picker(window, cx);
            }))
            .conn_tooltip(trigger_tooltip, &tokens)
            .child(crate::icons::provider_mark(
                driver
                    .filter(|d| !d.is_empty())
                    .unwrap_or(model_label.as_str()),
                16.0,
                if picker_open { fg } else { muted },
            ))
            .child(
                div()
                    .min_w_0()
                    .max_w(px(MODEL_LABEL_MAX_WIDTH_PX))
                    .truncate()
                    .child(model_label),
            )
            .when(has_suffix, |el| el.child(suffix));

        // Footer mode block: conditional permissions chip + Plan / Build toggle.
        let runtime_options = self.runtime_mode_options();
        let show_footer_permissions = footer_permissions_visible(
            &self.runtime_mode,
            &self.default_runtime_mode,
            self.is_draft,
        );
        let permissions_chip = show_footer_permissions.then(|| {
            render_permissions_chip(
                &self.runtime_mode,
                self.footer_permissions_open,
                &runtime_options,
                self.permission_preview,
                &tokens,
                cx,
            )
        });
        let mode_toggle = (self.interaction_mode == "plan")
            .then(|| render_interaction_mode_toggle(true, &tokens, cx));

        // Context window meter (only when the thread reports usage).
        let supports_compact = self
            .selected_provider_group()
            .is_some_and(|group| group.supports_compact);
        let meter_model_name = selected_model.as_ref().map(ModelOption::display_label);
        let context_meter = self.context_window.clone().map(|usage| {
            context_meter::render_context_meter(
                &usage,
                meter_model_name.as_deref(),
                supports_compact && !self.is_draft,
                self.context_meter_open,
                &tokens,
                cx,
            )
        });

        // Primary action state machine (`ComposerPrimaryActions`).
        let primary = resolve_primary_action(&PrimaryActionInput {
            can_operate_thread: true,
            is_running: self.working && !self.is_draft,
            can_interrupt: self.working && !self.is_draft,
            follow_up: self.effective_follow_up(),
            can_steer: true,
            alternate_modifier: self.alternate_modifier,
            show_plan_follow_up: self.plan_follow_up.is_some() && !is_editing_queued,
            prompt_has_text: has_non_empty_text,
            is_send_busy: self.submitting || self.answering_approval,
            send_disabled_reason: self
                .send_disabled_reason
                .clone()
                .or(attachment_block_reason),
            environment_unavailable: self.environment_unavailable || self.connection.is_none(),
            preparing_worktree: self.preparing_worktree,
            has_sendable_content: has_sendable,
            can_resume: self.can_resume && !self.working,
            editing_queued: is_editing_queued,
        });
        let action_btn =
            actions::render_primary_action(&primary, self.implement_menu_open, &tokens, cx);

        let attach_btn = div()
            .id("chat-composer-attach")
            .a11y_button("composer.attach", "Attach files")
            .flex()
            .items_center()
            .justify_center()
            .size(px(FOOTER_CONTROL_HEIGHT_PX))
            .rounded_full()
            .cursor_pointer()
            .hover(move |s| s.bg(highlight_bg).text_color(fg))
            .on_click(cx.listener(|composer, _, window, cx| {
                composer.pick_attachments(window, cx);
            }))
            .conn_tooltip("Attach files", &tokens)
            .child(icons::icon(ICON_ATTACH, 16.0, muted));

        let mic_btn = render_microphone_button(
            &self.dictation,
            &tokens,
            cx.listener(|composer, _, window, cx| {
                composer.toggle_dictation(window, cx);
            }),
        );

        let dictation_badge: Option<AnyElement> = match &self.dictation {
            DictationState::Starting { .. } => Some(
                div()
                    .text_size(px(11.0))
                    .text_color(muted)
                    .child("Starting…")
                    .into_any_element(),
            ),
            DictationState::Recording { .. } => Some(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(5.0))
                    .text_size(px(11.0))
                    .text_color(hsla(tokens.destructive))
                    .child(
                        div()
                            .size(px(6.0))
                            .rounded_full()
                            .bg(hsla(tokens.destructive)),
                    )
                    .child("Listening…")
                    .into_any_element(),
            ),
            DictationState::Transcribing { .. } => Some(
                div()
                    .text_size(px(11.0))
                    .text_color(muted)
                    .child("Transcribing…")
                    .into_any_element(),
            ),
            DictationState::Idle => self.dictation_error.as_ref().map(|err| {
                div()
                    .id("chat-composer-dictation-err")
                    .max_w(px(180.0))
                    .truncate()
                    .cursor_pointer()
                    .text_size(px(11.0))
                    .text_color(hsla(tokens.destructive))
                    .on_click(cx.listener(|composer, _, _, cx| {
                        composer.dictation_error = None;
                        cx.notify();
                    }))
                    .conn_tooltip(err.clone(), &tokens)
                    .child(err.clone())
                    .into_any_element()
            }),
        };

        let mut card = div()
            .id("chat-composer-card")
            .test_support()
            .a11y_group("composer.card", "Message input card")
            .w_full()
            .rounded(px(COMPOSER_RADIUS_PX))
            .bg(card_bg)
            .border_1()
            .border_color(if is_editing_queued {
                hsla_alpha(tokens.primary, 0.45)
            } else {
                card_border
            })
            .overflow_hidden();

        if is_editing_queued {
            card = card.child(
                div()
                    .id("chat-composer-editing-queued-bar")
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .px(px(14.0))
                    .py(px(6.0))
                    .border_b_1()
                    .border_color(hsla(tokens.shell_divider))
                    .text_size(px(12.0))
                    .line_height(px(16.0))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.0))
                            .text_color(muted)
                            .child(icons::icon(icons::EDIT, 12.0, muted))
                            .child(
                                div()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(fg)
                                    .child("Editing queued message"),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.0))
                            .child(div().text_color(muted).child("Esc to cancel"))
                            .child(
                                div()
                                    .id("chat-composer-cancel-edit-queued")
                                    .a11y_button(
                                        "composer.cancel-edit-queued",
                                        "Cancel editing queued message",
                                    )
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .size(px(18.0))
                                    .rounded(px(4.0))
                                    .cursor_pointer()
                                    .hover(move |s| s.bg(highlight_bg))
                                    .on_click(cx.listener(|composer, _, window, cx| {
                                        composer.cancel_edit_queued(window, cx);
                                    }))
                                    .conn_tooltip("Cancel editing (Esc)", &tokens)
                                    .child(icons::icon(icons::CLOSE, 11.0, muted)),
                            ),
                    ),
            );
        }

        let existing_queued_attachments: &[ChatAttachment] = self
            .editing_queued
            .as_ref()
            .map_or(&[], |e| e.existing_attachments.as_slice());

        if !existing_queued_attachments.is_empty() || !self.attachments.is_empty() {
            let mut strip = div()
                .flex()
                .flex_row()
                .flex_wrap()
                .items_center()
                .gap(px(6.0))
                .px(px(14.0))
                .pt(px(12.0));
            for (idx, att) in existing_queued_attachments.iter().enumerate() {
                let att_id = chat_attachment_id(att).to_owned();
                let att_name = chat_attachment_name(att);
                let is_image = matches!(att, ChatAttachment::Image(_));
                let leading_icon = if is_image {
                    icons::icon(icons::IMAGE, 14.0, muted)
                } else {
                    let file_icon = crate::file_icons::file_icon(att_name);
                    let icon_color = file_icon
                        .color
                        .map(|c| hsla(c.for_appearance(tokens.appearance)))
                        .unwrap_or(muted);
                    icons::icon(file_icon.asset, 14.0, icon_color)
                };
                strip = strip.child(
                    div()
                        .id(("composer-queued-att", idx))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.0))
                        .h(px(28.0))
                        .max_w(px(220.0))
                        .px(px(8.0))
                        .rounded(px(8.0))
                        .bg(hsla(tokens.shell_control))
                        .border_1()
                        .border_color(hsla(tokens.shell_inner_border))
                        .child(leading_icon)
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(12.0))
                                .line_height(px(16.0))
                                .text_color(fg)
                                .child(att_name.to_owned()),
                        )
                        .child(
                            div()
                                .id(("composer-queued-att-rm", idx))
                                .flex()
                                .items_center()
                                .justify_center()
                                .size(px(16.0))
                                .flex_shrink_0()
                                .rounded(px(4.0))
                                .cursor_pointer()
                                .hover(move |s| s.bg(highlight_bg))
                                .on_click(cx.listener(move |composer, _, _, cx| {
                                    composer.remove_editing_queued_attachment(&att_id, cx);
                                }))
                                .child(icons::icon(icons::CLOSE, 11.0, muted)),
                        ),
                );
            }
            for att in &self.attachments {
                let local_id = att.local_id;
                let file_icon = crate::file_icons::file_icon(&att.name);
                let icon_color = file_icon
                    .color
                    .map(|c| hsla(c.for_appearance(tokens.appearance)))
                    .unwrap_or(muted);
                let status_label = match &att.status {
                    AttachmentUploadStatus::Uploading => "Uploading…".to_owned(),
                    AttachmentUploadStatus::Ready(_) => format_byte_size(att.size_bytes),
                    AttachmentUploadStatus::Error(err) => err.clone(),
                };
                let is_err = matches!(att.status, AttachmentUploadStatus::Error(_));
                strip = strip.child(
                    div()
                        .id(SharedString::from(format!("composer-att-{local_id}")))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.0))
                        .h(px(28.0))
                        .max_w(px(220.0))
                        .px(px(8.0))
                        .rounded(px(8.0))
                        .bg(hsla(tokens.shell_control))
                        .border_1()
                        .border_color(if is_err {
                            hsla(tokens.destructive)
                        } else {
                            hsla(tokens.shell_inner_border)
                        })
                        .child(icons::icon(file_icon.asset, 14.0, icon_color))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(12.0))
                                .line_height(px(16.0))
                                .text_color(fg)
                                .child(att.name.clone()),
                        )
                        .child(
                            div()
                                .flex_shrink_0()
                                .text_size(px(11.0))
                                .line_height(px(16.0))
                                .text_color(if is_err {
                                    hsla(tokens.destructive)
                                } else {
                                    muted
                                })
                                .child(status_label),
                        )
                        .child(
                            div()
                                .id(SharedString::from(format!("composer-att-rm-{local_id}")))
                                .a11y_button(
                                    SharedString::from(format!("composer.att.rm.{local_id}")),
                                    "Remove attachment",
                                )
                                .flex()
                                .items_center()
                                .justify_center()
                                .size(px(16.0))
                                .flex_shrink_0()
                                .rounded(px(4.0))
                                .cursor_pointer()
                                .hover(move |s| s.bg(highlight_bg))
                                .on_click(cx.listener(move |composer, _, _, cx| {
                                    composer.remove_attachment(local_id, cx);
                                }))
                                .child(icons::icon("superhero/close.svg", 11.0, muted)),
                        ),
                );
            }
            card = card.child(strip);
        }

        // `Textarea` with `Size::XSmall` applies 4px horizontal / 0px vertical internal
        // editor padding (versus 10px / 8px at the default `Size::Medium`), so wrapping
        // with `px(12) pt(14) pb(6)` yields Conn's exact `px-4 pt-3.5` (16px / 14px)
        // text inset aligned with the footer attach button below.
        card = card
            .child(
                div().px(px(12.0)).pt(px(14.0)).pb(px(6.0)).child(
                    Textarea::new(&self.textarea)
                        .disabled(choice_only)
                        .with_size(Size::XSmall)
                        .appearance(false)
                        .bordered(false)
                        .text_size(px(14.0))
                        .line_height(px(22.0))
                        .text_color(fg),
                ),
            )
            // `ComposerPromptLengthValidation`: `role="alert"`, `px-4 pb-2 text-xs`.
            .when_some(length_alert, |el, message| {
                el.child(
                    div()
                        .id("composer-prompt-length-alert")
                        .a11y(gpui_kit::Role::Alert, "composer.prompt-length", message.clone())
                        .px(px(16.0))
                        .pb(px(8.0))
                        .text_size(px(12.0))
                        .line_height(px(16.0))
                        .text_color(hsla(tokens.destructive))
                        .child(message),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .px(px(8.0))
                    .pb(px(8.0))
                    .child(attach_btn)
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .justify_end()
                            .gap(px(4.0))
                            .min_w_0()
                            .child(model_trigger)
                            .when_some(permissions_chip, |el, chip| el.child(chip))
                            .when_some(mode_toggle, |el, toggle| el.child(toggle))
                            .when_some(context_meter, |el, meter| el.child(meter))
                            .when_some(dictation_badge, |el, badge| el.child(badge))
                            .child(mic_btn)
                            .child(div().ml(px(4.0)).child(action_btn)),
                    ),
            );

        let mut root = div()
            .id("chat-composer-root")
            .a11y(gpui_kit::Role::Form, "composer.root", "Message composer")
            .relative()
            .w_full()
            .on_drop(
                cx.listener(|composer, dropped: &ExternalPaths, window, cx| {
                    composer.attach_paths(dropped.paths().to_vec(), window, cx);
                }),
            )
            .capture_action(cx.listener(|composer, _: &Paste, window, cx| {
                if composer.try_paste_attachments(window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|composer, _: &Escape, window, cx| {
                if let Some(session_id) = composer.dictation.session_id().map(str::to_owned) {
                    composer.cancel_dictation(session_id, cx);
                    cx.stop_propagation();
                    return;
                }
                if composer.any_overlay_open() {
                    composer.close_overlays(cx);
                    composer.focus_input(window, cx);
                    cx.stop_propagation();
                    return;
                }
                if composer.editing_queued.is_some() {
                    composer.cancel_edit_queued(window, cx);
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|composer, _: &MoveUp, window, cx| {
                if composer.stash.menu_open {
                    composer.stash.move_highlight(-1);
                    cx.notify();
                    cx.stop_propagation();
                } else if composer.model_picker_open || composer.active_trigger.is_some() {
                    composer.move_overlay_selection(-1, cx);
                    cx.stop_propagation();
                } else if !composer.any_overlay_open() && composer.step_history(true, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|composer, _: &MoveDown, window, cx| {
                if composer.stash.menu_open {
                    composer.stash.move_highlight(1);
                    cx.notify();
                    cx.stop_propagation();
                } else if composer.model_picker_open || composer.active_trigger.is_some() {
                    composer.move_overlay_selection(1, cx);
                    cx.stop_propagation();
                } else if !composer.any_overlay_open() && composer.step_history(false, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|composer, _: &Enter, window, cx| {
                if composer.stash.menu_open {
                    composer.restore_highlighted_stash_entry(window, cx);
                    cx.stop_propagation();
                } else if composer.model_picker_open {
                    composer.confirm_highlighted_model(cx);
                    cx.stop_propagation();
                } else if composer.active_trigger.is_some() {
                    composer.confirm_active_menu(window, cx);
                    cx.stop_propagation();
                }
            }))
            .on_modifiers_changed(cx.listener(
                |composer, event: &gpui_kit::ModifiersChangedEvent, _, cx| {
                    let held = event.modifiers.platform || event.modifiers.control;
                    if composer.alternate_modifier != held {
                        composer.alternate_modifier = held;
                        cx.notify();
                    }
                },
            ))
            .capture_key_down(cx.listener(
                |composer, event: &gpui_kit::KeyDownEvent, window, cx| {
                    let keystroke = &event.keystroke;
                    let m = keystroke.modifiers;
                    // `⌘S` (`composer.stash`).
                    if keystroke.key == "s" && m.platform && !m.shift && !m.alt && !m.control {
                        composer.stash_or_toggle(window, cx);
                        cx.stop_propagation();
                        return;
                    }
                    // `⌘Backspace` deletes the highlighted stash entry while the drawer is open.
                    if composer.stash.menu_open && keystroke.key == "backspace" && m.platform {
                        if let Some(id) = composer.stash.highlighted_id() {
                            composer.delete_stash_entry(id, cx);
                        }
                        cx.stop_propagation();
                        return;
                    }
                    // `Shift+Tab` toggles Plan / Build when no menu needs the key.
                    if keystroke.key == "tab"
                        && m.shift
                        && !m.platform
                        && !m.control
                        && !m.alt
                        && !composer.any_overlay_open()
                    {
                        composer.toggle_interaction_mode(cx);
                        cx.stop_propagation();
                        return;
                    }
                    // `⌘⇧M` toggles the model picker (`modelPicker.toggle`).
                    if keystroke.key == "m" && m.platform && m.shift && !m.alt && !m.control {
                        composer.toggle_model_picker(window, cx);
                        cx.stop_propagation();
                    }
                    // `⌘⇧G` branch picker, `⌘⇧X` workspace menu, `⌘⇧L` previous worktree.
                    if m.platform && m.shift && !m.alt && !m.control {
                        match keystroke.key.as_str() {
                            "g" => composer.toggle_branch_picker(window, cx),
                            "x" => composer.toggle_workspace_menu(cx),
                            "l" => composer.use_previous_worktree(window, cx),
                            _ => return,
                        }
                        cx.stop_propagation();
                    }
                },
            ))
            .when_some(
                if self.stash.menu_open {
                    Some(render_stash_menu(&self.stash, &tokens, cx))
                } else if self.stash_docked {
                    None
                } else {
                    render_stash_badge(&self.stash, &tokens, cx)
                },
                |el, surface| el.child(surface),
            )
            .child(card);
        let show_context_strip = self.is_draft || self.persist_context_strip;
        // Conn `BranchToolbar.logic.ts:shouldShowComposerContextStrip`: shown on drafts and when
        // `persistComposerContextStrip` is enabled (with symmetric 9px vertical margins); when
        // hidden on active threads, keep Conn's 20px (`h-[1.25rem]`) bottom spacer below the card.
        root = if show_context_strip {
            root.child(self.render_context_strip(&tokens, cx))
        } else {
            root.pb(px(COMPOSER_BOTTOM_SPACER_PX))
        };

        if let Some(trigger) = self.active_trigger.clone() {
            let menu = render_command_menu(
                &trigger,
                &self.file_mentions,
                self.file_mentions_loading,
                self.selected_provider_skills(),
                self.menu_highlighted_index,
                &tokens,
                cx,
            );
            root = root.child(
                deferred(
                    div()
                        .absolute()
                        .bottom_full()
                        .left_0()
                        .right_0()
                        .mb(px(6.0))
                        .child(menu),
                )
                .with_priority(2),
            );
        } else if self.model_picker_open {
            let query = self.model_search_input.read(cx).value().to_string();
            let popup = render_model_picker(
                &ModelPickerView {
                    catalog: &self.catalog,
                    loading: self.catalog_loading,
                    error: self.catalog_error.as_deref(),
                    active_instance_id: self.selected_instance_id.as_deref(),
                    active_model: &self.selected_model,
                    selected_provider: self.picker_provider_filter.as_deref(),
                    search_input: &self.model_search_input,
                    query: &query,
                    highlighted_index: self.picker_highlighted_index,
                    tokens: &tokens,
                    selected: selected_model.as_ref(),
                    selected_options: self.selected_options.as_ref(),
                    runtime_mode: &self.runtime_mode,
                    runtime_options: &runtime_options,
                    permissions_open: self.picker_permissions_open,
                    permission_preview: self.permission_preview,
                    follow_up: self.effective_follow_up(),
                },
                cx,
            );
            root = root.child(
                deferred(
                    div()
                        .absolute()
                        .bottom_full()
                        .right_0()
                        .mb(px(6.0))
                        .child(popup),
                )
                .with_priority(2),
            );
        }

        root
    }
}

/// Composer card surface fill and border from `conn_theme::Tokens`.
///
/// Mirrors Conn's `--shell-composer` (`var(--card)` in light, lifted surface in dark)
/// and `--chat-composer-outline` (`8%` black/white hairline via `shell_inner_border`).
fn composer_surface_colors(tokens: &Tokens) -> (gpui_kit::Hsla, gpui_kit::Hsla) {
    let bg = match tokens.appearance {
        Appearance::Light => hsla(tokens.card),
        Appearance::Dark => hsla(tokens.shell_field),
    };
    (bg, hsla(tokens.shell_inner_border))
}

/// Microphone button styled like Conn's `ComposerSpeechButton` wired to local Operator dictation.
fn render_microphone_button<FClick>(
    state: &DictationState,
    tokens: &Tokens,
    on_click: FClick,
) -> AnyElement
where
    FClick: Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static,
{
    let highlight_bg = hsla(tokens.shell_highlight);
    let fg = hsla(tokens.foreground);
    let muted = hsla(tokens.muted_foreground);
    let destructive = hsla(tokens.destructive);

    let (tooltip, icon_color, active_bg) = match state {
        DictationState::Idle => ("Dictate with Operator", muted, None),
        DictationState::Starting { .. } => (
            "Starting Operator dictation… (Esc to cancel)",
            destructive,
            Some(hsla_alpha(tokens.destructive, 0.14)),
        ),
        DictationState::Recording { .. } => (
            "Stop dictation (click or Esc to cancel)",
            destructive,
            Some(hsla_alpha(tokens.destructive, 0.18)),
        ),
        DictationState::Transcribing { .. } => {
            ("Transcribing…", fg, Some(hsla_alpha(tokens.accent, 0.16)))
        }
    };

    let mut btn = div()
        .id("chat-composer-mic")
        .a11y_button("composer.mic", tooltip)
        .flex()
        .items_center()
        .justify_center()
        .size(px(FOOTER_CONTROL_HEIGHT_PX))
        .rounded_full()
        .cursor_pointer()
        .on_click(on_click)
        .conn_tooltip(tooltip, tokens)
        .child(icons::icon(ICON_MICROPHONE, 16.0, icon_color));

    if let Some(bg) = active_bg {
        btn = btn.bg(bg);
    } else {
        btn = btn.hover(move |s| s.bg(highlight_bg).text_color(fg));
    }

    btn.into_any_element()
}

fn chat_attachment_id(att: &ChatAttachment) -> &str {
    match att {
        ChatAttachment::Image(a) => &a.id,
        ChatAttachment::File(a) => &a.id,
        ChatAttachment::Unknown(a) => &a.id,
    }
}

fn chat_attachment_size(att: &ChatAttachment) -> usize {
    let bytes = match att {
        ChatAttachment::Image(a) => a.size_bytes,
        ChatAttachment::File(a) => a.size_bytes,
        ChatAttachment::Unknown(a) => a.size_bytes,
    };
    usize::try_from(bytes).unwrap_or(0)
}

fn chat_attachment_name(att: &ChatAttachment) -> &str {
    match att {
        ChatAttachment::Image(a) => &a.name,
        ChatAttachment::File(a) => &a.name,
        ChatAttachment::Unknown(a) => &a.name,
    }
}

fn infer_driver_from_model_label(label: &str) -> Option<&'static str> {
    let lower = label.to_ascii_lowercase();
    if lower.contains("claude")
        || lower.contains("haiku")
        || lower.contains("sonnet")
        || lower.contains("opus")
    {
        Some("claudeAgent")
    } else if lower.contains("antigravity") || lower.contains("gemini") {
        Some("antigravity")
    } else if lower.contains("gpt") || lower.contains("codex") || lower.contains("o3") {
        Some("codex")
    } else {
        None
    }
}

fn step_index(current: usize, delta: isize, len: usize) -> usize {
    if len == 0 {
        return 0;
    }
    let len_isize = isize::try_from(len).unwrap_or(isize::MAX);
    let current_isize = isize::try_from(current).unwrap_or(0);
    let next = (current_isize + delta).rem_euclid(len_isize);
    usize::try_from(next).unwrap_or(0)
}

fn infer_mime_type(path: &std::path::Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("json") => "application/json",
        Some("md" | "markdown") => "text/markdown",
        Some(
            "txt" | "log" | "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "toml" | "yaml"
            | "yml" | "css" | "html",
        ) => "text/plain",
        _ => "application/octet-stream",
    }
}

fn format_byte_size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

/// Maps a GPUI clipboard [`ImageFormat`] to `(extension, mime_type)`.
fn clipboard_image_spec(format: ImageFormat) -> Option<(&'static str, &'static str)> {
    match format {
        ImageFormat::Png => Some(("png", "image/png")),
        ImageFormat::Jpeg => Some(("jpg", "image/jpeg")),
        ImageFormat::Webp => Some(("webp", "image/webp")),
        ImageFormat::Gif => Some(("gif", "image/gif")),
        ImageFormat::Bmp => Some(("bmp", "image/bmp")),
        ImageFormat::Tiff => Some(("tiff", "image/tiff")),
        ImageFormat::Svg => Some(("svg", "image/svg+xml")),
        ImageFormat::Ico => Some(("ico", "image/x-icon")),
        ImageFormat::Pnm => None,
    }
}

fn next_dictation_session_id(seq: u64) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    format!("conn-composer-{millis}-{seq}")
}

fn friendly_operator_error(err: &conn_desktop::operator::OperatorError) -> String {
    match err {
        conn_desktop::operator::OperatorError::Unreachable { .. } => {
            "Operator isn't running".to_owned()
        }
        conn_desktop::operator::OperatorError::Unauthorized(_) => {
            "Enable Local API in Operator → Settings".to_owned()
        }
        other => other.to_string(),
    }
}

/// Appends dictated `transcript` to `existing` draft text with a single space separator when
/// needed. Returns `None` when `transcript` is empty/whitespace.
fn append_transcript(existing: &str, transcript: &str) -> Option<String> {
    let trimmed = transcript.trim();
    if trimmed.is_empty() {
        return None;
    }
    if existing.is_empty() {
        return Some(trimmed.to_owned());
    }
    let needs_space = !existing.ends_with(char::is_whitespace);
    let mut out = String::with_capacity(existing.len() + trimmed.len() + usize::from(needs_space));
    out.push_str(existing);
    if needs_space {
        out.push(' ');
    }
    out.push_str(trimmed);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infer_mime_and_byte_size_formatting() {
        assert_eq!(
            infer_mime_type(std::path::Path::new("shot.PNG")),
            "image/png"
        );
        assert_eq!(
            infer_mime_type(std::path::Path::new("photo.jpg")),
            "image/jpeg"
        );
        assert_eq!(
            infer_mime_type(std::path::Path::new("main.rs")),
            "text/plain"
        );
        assert_eq!(
            infer_mime_type(std::path::Path::new("archive.bin")),
            "application/octet-stream"
        );
        assert_eq!(format_byte_size(512), "512 B");
        assert_eq!(format_byte_size(2048), "2.0 KB");
        assert_eq!(format_byte_size(2 * 1024 * 1024), "2.0 MB");
    }

    #[test]
    fn step_index_wraps_in_both_directions() {
        assert_eq!(step_index(0, 1, 3), 1, "steps forward");
        assert_eq!(step_index(2, 1, 3), 0, "wraps past end");
        assert_eq!(step_index(0, -1, 3), 2, "wraps before start");
        assert_eq!(step_index(0, 1, 0), 0, "empty list stays at 0");
    }

    #[test]
    fn infer_driver_recognizes_common_model_names() {
        assert_eq!(
            infer_driver_from_model_label("haiku"),
            Some("claudeAgent"),
            "haiku maps to claudeAgent"
        );
        assert_eq!(
            infer_driver_from_model_label("GPT-5.4"),
            Some("codex"),
            "GPT-5.4 maps to codex"
        );
        assert_eq!(
            infer_driver_from_model_label("custom-model"),
            None,
            "unknown model returns None"
        );
    }

    #[test]
    fn append_transcript_joins_cleanly_and_ignores_blank() {
        assert_eq!(append_transcript("", "   "), None);
        assert_eq!(
            append_transcript("", "  fix the build  "),
            Some("fix the build".to_owned())
        );
        assert_eq!(
            append_transcript("Please", "check tests"),
            Some("Please check tests".to_owned())
        );
        assert_eq!(
            append_transcript("Line 1\n", "Line 2"),
            Some("Line 1\nLine 2".to_owned())
        );
    }

    #[test]
    fn clipboard_image_spec_maps_formats_and_session_ids_validate() {
        assert_eq!(
            clipboard_image_spec(ImageFormat::Png),
            Some(("png", "image/png"))
        );
        assert_eq!(
            clipboard_image_spec(ImageFormat::Jpeg),
            Some(("jpg", "image/jpeg"))
        );
        let sid = next_dictation_session_id(7);
        assert!(conn_desktop::operator::is_valid_session_id(&sid));
    }
}
