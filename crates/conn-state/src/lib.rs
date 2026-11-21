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
mod layout;
mod scheduled;
mod shell;
mod thread;

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

pub use crate::layout::{
    LayoutState, PanelSurface, RIGHT_PANEL_DEFAULT_WIDTH, RIGHT_PANEL_MAX_WIDTH,
    RIGHT_PANEL_MIN_WIDTH, RightPanelTab, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH,
    SIDEBAR_MIN_WIDTH,
};
pub use crate::shell::{ShellChange, ShellState, ThreadActivity};
pub use crate::thread::{
    EntryTiming, ItemStatus, RunTiming, ThreadState, TimelineEntry, TurnCheckpointSummary,
    parse_iso8601_epoch_ms,
};
