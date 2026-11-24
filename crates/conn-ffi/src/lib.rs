//! UniFFI Swift/iOS bridge over the GPUI-free `conn-client`, `conn-orbit`, `conn-state`, and
//! `conn-theme` core.
//!
//! Hand-written code in this crate stays free of `unsafe`; only the UniFFI proc-macro
//! scaffolding generates FFI boundary code.

mod approvals;
mod coalesce;
mod core;
mod orbit;
mod phone_tasks;
mod questions;
mod theme;
mod types;

uniffi::setup_scaffolding!();

pub use crate::approvals::{FfiApprovalOption, FfiButtonTone, FfiPendingApproval};
pub use crate::core::{ConnCore, CoreListener};
pub use crate::orbit::{
    FfiAgentRole, FfiAgentState, FfiAttentionKind, FfiChangeTone, FfiConversationRef,
    FfiDeliverable, FfiImplementerMode, FfiInsightCard, FfiInsightId, FfiInsightTrendPoint,
    FfiInsightsPeriod, FfiOrbitAppearance, FfiOrbitAppearanceMode, FfiOrbitBoundProfile,
    FfiOrbitBranch, FfiOrbitBranchInstance, FfiOrbitBranchPullRequest, FfiOrbitBranchSelection,
    FfiOrbitBranches, FfiOrbitCustomTheme, FfiOrbitEnvironment, FfiOrbitInstanceNameCheck,
    FfiOrbitInstanceNameReason, FfiOrbitMe, FfiOrbitPowerState, FfiOrbitProfile,
    FfiOrbitProfileSettings, FfiOrbitProject, FfiOrbitProjectCheck, FfiOrbitProjectCheckStatus,
    FfiOrbitProjectTarget, FfiOrbitReservation, FfiOrbitReservationState, FfiOrbitTargetStatus,
    FfiOrbitThemeSlot, FfiOrbitThemeSlotSource, FfiOrbitWorkspace, FfiPullRequestState,
    FfiStartedOrbitThread, FfiStatusTone, FfiSubtask, FfiSubtaskCounts, FfiSubtaskStatus,
    FfiTaskAgent, FfiTaskAttention, FfiTaskBoardLane, FfiTaskDetail, FfiTaskEnvironmentState,
    FfiTaskInsightsStrip, FfiTaskLabelTone, FfiTaskLane, FfiTaskMetrics, FfiTaskProject,
    FfiTaskPullRequest, FfiTaskStatus, FfiTaskSummary, FfiTaskWorkspace, FfiTasksBoard,
    FfiTasksBoardQuery, FfiTasksLiveStatus, OrbitCore, OrbitListener, orbit_derive_instance_name,
    orbit_workspace_matches_project,
};
pub use crate::phone_tasks::{
    FfiPhoneNotice, FfiPhoneTaskLane, FfiPhoneTaskRow, FfiPhoneTasks, FfiPhoneTasksView,
    FfiTaskDot, phone_tasks_error_text, phone_tasks_view,
};
pub use crate::questions::{
    FfiPendingQuestion, FfiQuestionDraft, FfiQuestionPanel, FfiQuestionPanelOption, FfiTextFits,
    question_answers, question_context_clamp, question_panel, question_set_custom_answer,
    question_toggle_option,
};
pub use crate::theme::{
    FfiAppearance, FfiColor, FfiShellGeometry, FfiThemeSummary, FfiThemeTokens, builtin_themes,
    custom_theme_tokens, theme_tokens,
};
pub use crate::types::{
    FfiApprovalDecision, FfiAttachment, FfiConnectionStatus, FfiCredential, FfiError,
    FfiItemStatus, FfiOrbitErrorReason, FfiProject, FfiSecretRequestStatus, FfiSendMode,
    FfiShellSnapshot, FfiThreadActivity, FfiThreadSnapshot, FfiThreadSummary, FfiTimelineEntry,
    FfiTurnCheckpointFile, FfiTurnItemStatus, FfiUserInputAnswer, FfiUserInputAnswerValue,
    FfiUserInputOption, FfiUserInputQuestion, FfiUserInputSubmission, FfiWorkGroupTiming,
};

const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<ConnCore>();
    assert_send_sync::<OrbitCore>();
    assert_send_sync::<FfiAppearance>();
    assert_send_sync::<FfiColor>();
    assert_send_sync::<FfiShellGeometry>();
    assert_send_sync::<FfiThemeSummary>();
    assert_send_sync::<FfiThemeTokens>();
    assert_send_sync::<FfiCredential>();
    assert_send_sync::<FfiConnectionStatus>();
    assert_send_sync::<FfiSendMode>();
    assert_send_sync::<FfiApprovalDecision>();
    assert_send_sync::<FfiThreadActivity>();
    assert_send_sync::<FfiProject>();
    assert_send_sync::<FfiThreadSummary>();
    assert_send_sync::<FfiShellSnapshot>();
    assert_send_sync::<FfiItemStatus>();
    assert_send_sync::<FfiTurnItemStatus>();
    assert_send_sync::<FfiSecretRequestStatus>();
    assert_send_sync::<FfiAttachment>();
    assert_send_sync::<FfiUserInputOption>();
    assert_send_sync::<FfiUserInputQuestion>();
    assert_send_sync::<FfiUserInputAnswer>();
    assert_send_sync::<FfiUserInputAnswerValue>();
    assert_send_sync::<FfiUserInputSubmission>();
    assert_send_sync::<FfiTurnCheckpointFile>();
    assert_send_sync::<FfiWorkGroupTiming>();
    assert_send_sync::<FfiTimelineEntry>();
    assert_send_sync::<FfiThreadSnapshot>();
    assert_send_sync::<FfiOrbitErrorReason>();
    assert_send_sync::<FfiError>();
    assert_send_sync::<FfiOrbitMe>();
    assert_send_sync::<FfiOrbitEnvironment>();
    assert_send_sync::<FfiOrbitBoundProfile>();
    assert_send_sync::<FfiOrbitProject>();
    assert_send_sync::<FfiOrbitReservation>();
    assert_send_sync::<FfiOrbitProjectTarget>();
    assert_send_sync::<FfiStartedOrbitThread>();
    assert_send_sync::<FfiTasksBoard>();
    assert_send_sync::<FfiTaskDetail>();
};
