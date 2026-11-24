#![forbid(unsafe_code)]

//! Pure Rust state and reducers for `conn-gpui`.
//!
//! Intentionally free of GPUI and I/O dependencies so state transitions can be tested
//! deterministically and rapidly with `cargo test -p conn-state`.
//!
//! API contract (`conn-app` builds against these names; keep them stable):
//! - [`ShellState`]: projects and threads from `orchestration.subscribeShell`.
//! - [`ThreadState`]: one thread's timeline from `orchestration.subscribeThread`, flattened
//!   into [`TimelineEntry`] view models so views never touch raw contract events.
//! - [`LayoutState`]: sidebar, right panel, and tab layout.

mod annotations;
pub mod conn_tools;
pub mod custom_model_editor;
mod discard_undo;
mod drafts;
pub mod environments;
mod layout;
pub mod model_preferences;
mod order_keys;
pub mod project_groups;
pub mod project_settings;
pub mod provider_auth;
pub mod provider_settings;
pub mod providers;
mod question;
mod scheduled;
mod settled_shelf;
mod shell;
mod sidebar;
pub mod sidebar_drag;
mod sidebar_nav;
pub mod sidebar_rows;
pub mod terminal_settings;
#[cfg(test)]
mod test_threads;
#[cfg(feature = "testkit")]
pub mod testkit;
mod thread;
pub mod thread_models;
pub mod thread_search;
mod timeline;

pub use conn_contract::{
    AnnotationCapture, AnnotationRecord, AnnotationRecordSource, AnnotationStatus,
    OrchestrationProjectShell as ProjectShell, OrchestrationV2ShellStreamItem as ShellStreamItem,
    OrchestrationV2ThreadShell as ThreadShell, OrchestrationV2ThreadStreamItem as ThreadStreamItem,
    ScheduledTask, ScheduledTaskGetWebhookDeliveryInput, ScheduledTaskGetWebhookDeliveryResult,
    ScheduledTaskListResult, ScheduledTaskListWebhookDeliveriesInput,
    ScheduledTaskListWebhookDeliveriesResult, ScheduledTaskRunNowResult, ScheduledTaskRunStatus,
    ScheduledTaskSchedule, ScheduledTaskSetEnabledInput, ScheduledTaskUpsertInput,
    ScheduledTaskWebhookDelivery, ScheduledTaskWebhookDeliverySummary,
    ScheduledTaskWebhookSignatureEncoding,
};

pub use crate::annotations::{
    AnnotationPinPoint, AnnotationQueueCounts, AnnotationQueueState, DetectedDomElement,
    DetectedPoint, DetectedRect, annotation_state, build_annotation_prompt,
    build_browser_annotation_capture, build_device_annotation_capture, count_annotations,
    waiting_ids_to_send,
};
pub use crate::scheduled::{
    DEFAULT_WEBHOOK_SIGNATURE_HEADER, DEFAULT_WEBHOOK_SIGNATURE_PREFIX,
    MAX_WEBHOOK_COALESCE_WINDOW_SECONDS, MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
    MIN_WEBHOOK_COALESCE_WINDOW_SECONDS, ScheduleMode, ScheduledTaskDraft, WorkspaceMode,
    build_upsert_input, extract_model_instance, extract_model_slug, resolve_webhook_url,
    schedule_label, webhook_delivery_label,
};

pub use crate::discard_undo::{
    DISCARD_UNDO_SECS, DiscardNotice, DiscardUndo, SettleUndoStep, SettledThreadFacts,
    UNDO_FAILED_NEW_CONTENT, UNDO_FAILED_SETTLE, UNDO_SHORTCUT_LABEL, UndoAction,
    UndoShortcutScene, discard_short_summary, discard_summary, is_modifier_key, is_undo_key,
    notice_short_summary, notice_summary, notice_undone_summary, plan_settle_undo, plan_unpin_undo,
    undo_button_label, undo_failure_text, undo_label, undo_shortcut_applies, undone_summary,
};
pub use crate::drafts::{
    ProjectDraftSlots, Retarget, keeps_displaced_draft, persists_across_restart, project_draft_key,
    retarget_draft,
};
pub use crate::layout::{
    CHAT_BESIDE_PANEL_MIN_WIDTH, LayoutState, MAIN_CONTENT_MIN_WIDTH, PanelSurface,
    RIGHT_PANEL_DEFAULT_WIDTH, RIGHT_PANEL_MAX_WIDTH, RIGHT_PANEL_MIN_WIDTH, RightPanelTab,
    SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, right_panel_max_width,
    sidebar_max_width,
};
pub use crate::order_keys::{
    OrderAssignment, order_key_between, plan_reorder, sort_active, sort_pinned, spread_order_keys,
    top_of_pinned_run_key,
};
pub use crate::question::{
    clamp_context, markdown_preview_text, seed_user_input_drafts, split_recommended_label,
};
pub use crate::settled_shelf::{
    MoreState, SETTLED_MORE_ROW, SETTLED_TAIL_INITIAL_COUNT, SETTLED_TAIL_PAGE_COUNT, SettledTail,
    ShelfInput, ShelfView, SidebarPrefs, more_label, shelf_view,
};
pub use crate::shell::{
    ChildApprovalThread, OLDER_SETTLED_PAGE_SIZE, OlderPageRequest, OlderSettledCut,
    OlderSettledView, PageStatus, PendingSubagentRequest, SettledCursor, ShellChange, ShellState,
    ThreadActivity, is_listed_lineage, is_older_settled,
};
pub use crate::sidebar::{
    DRAFT_STATUS_LABEL, DraftRowKey, SidebarDraft, SidebarDraftRow, draft_has_content,
    draft_preview, draft_row_key, draft_row_label, freeze_active_draft_row, is_activation_key,
    sidebar_draft_row, sidebar_draft_rows, threads_with_unsent_input,
};
pub use crate::sidebar_nav::{
    BulkAction, BulkEntry, BulkFacts, FocusedRow, KeyMods, MenuKey, MenuNavItem, MenuStep,
    RowClick, RowKey, RowKind, SETTLED_SHELF_ROW, SearchKey, THREAD_JUMP_COUNT,
    THREAD_JUMP_HINT_DELAY_MS, ThreadSelection, ThreadStep, TreeKey, TreeRow, TreeStep,
    adjacent_thread, bulk_menu, draft_tree_key, first_enabled, focused_row, is_menu_key,
    jump_hint_label, jump_hint_number, jump_target, menu_key, menu_step, next_after_settle,
    restore_target, row_click, row_key, row_kind, search_highlight_index, search_key,
    search_key_unless_composing, search_step, shows_jump_hints, thread_jump_key,
    thread_traversal_key, traversal_order, tree_key, tree_step,
};
pub use crate::thread::{
    ApprovalDetails, ChildApproval, EntryTiming, ItemStatus, PendingApproval, PendingRequest,
    RunStatus, RunTiming, SecretRequestStatus, SubagentModel, ThreadContextWindowSnapshot,
    ThreadState, TimelineEntry, TurnCheckpointSummary, TurnItemStatus, child_approvals,
    parse_iso8601_epoch_ms, request_kind_label, turn_item_detail,
};
pub use crate::timeline::{
    LocalDateTime, PLAN_PREVIEW_MAX_LINES, SubagentTone, TurnCheckpointFile, TurnDiffRow,
    TurnDiffTreeNode, UserInputAnswer, UserInputAnswerValue, UserInputDraft, UserInputOption,
    UserInputQuestion, build_turn_diff_tree, build_user_input_answers, collapsed_plan_preview,
    flatten_turn_diff_tree, format_chat_timestamp_tooltip, format_day_aware_timestamp,
    format_duration, format_subagent_display_title, normalize_plan_markdown_for_export,
    plain_subagent_detail, plan_can_collapse, proposed_plan_title, strip_displayed_plan_markdown,
    subagent_detail, subagent_detail_markdown, subagent_settled, subagent_status_visual,
};
