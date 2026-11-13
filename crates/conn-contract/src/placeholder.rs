//! Opaque stand-ins for contract schemas. Track (b) replaces each with a generated type of the
//! same name. Do not read their insides; go through `to_json` / `from_json`.
//!
//! Names drop the `OrchestrationV2` prefix: `Command` is `OrchestrationV2Command`.

macro_rules! opaque {
    ($($(#[$doc:meta])* $name:ident),* $(,)?) => {$(
        $(#[$doc])*
        #[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub serde_json::Value);
    )*};
}

opaque!(
    // Engine API: orchestration.dispatchCommand, subscribeShell, subscribeThread.
    /// `OrchestrationV2Command`, the `dispatchCommand` payload.
    Command,
    /// `OrchestrationV2DispatchCommandResult`: `{ sequence }`.
    DispatchCommandResult,
    /// `OrchestrationV2DispatchCommandError`, the `dispatchCommand` typed error.
    DispatchCommandError,
    /// `OrchestrationV2GetShellSnapshotError`, the `subscribeShell` typed error.
    GetShellSnapshotError,
    /// `OrchestrationV2GetThreadProjectionError`, the `subscribeThread` typed error.
    GetThreadProjectionError,
    /// `OrchestrationV2ThreadLaunchInput`, the `launchThread` payload: a new thread and its first
    /// message in one call. Clients use it for every new thread they start from the composer.
    ThreadLaunchInput,
    /// `OrchestrationV2ThreadLaunchResult`: `{ threadId, projection, resumed, sequence? }`.
    ThreadLaunchResult,
    /// `OrchestrationV2ThreadLaunchError`, the `launchThread` typed error.
    ThreadLaunchError,
    /// `OrchestrationV2SubscribeShellInput`.
    SubscribeShellInput,
    /// `OrchestrationV2ShellStreamItem`: `synchronized`, `snapshot`, `project.updated`, ...
    ShellStreamItem,
    /// `OrchestrationV2SubscribeThreadInput`.
    SubscribeThreadInput,
    /// `OrchestrationV2ThreadStreamItem`: `synchronized`, `snapshot`, `event`, ...
    ThreadStreamItem,
    /// `OrchestrationV2DomainEvent`, the persisted event.
    DomainEvent,
    // Provider API: `packages/provider-core/src/server/ProviderAdapter.ts`.
    /// `ModelSelection`.
    ModelSelection,
    /// `RuntimeMode`.
    RuntimeMode,
    /// `ProviderInteractionMode`.
    InteractionMode,
    /// `OrchestrationV2ProviderCapabilities`.
    ProviderCapabilities,
    /// `OrchestrationV2AppThread`.
    AppThread,
    /// `OrchestrationV2ProviderSession`.
    ProviderSession,
    /// `OrchestrationV2ProviderThread`.
    ProviderThread,
    /// `OrchestrationV2ProviderTurn`.
    ProviderTurn,
    /// `OrchestrationV2ExecutionNode`.
    ExecutionNode,
    /// `OrchestrationV2Subagent`.
    Subagent,
    /// `OrchestrationV2ConversationMessage`.
    ConversationMessage,
    /// `OrchestrationV2TurnItem`.
    TurnItem,
    /// `OrchestrationV2RuntimeRequest` (approvals and user-input questions).
    RuntimeRequest,
    /// `OrchestrationV2PlanArtifact`.
    PlanArtifact,
    /// `OrchestrationV2ProviderFailure`.
    ProviderFailure,
    /// `OrchestrationV2ProviderRetry`.
    ProviderRetry,
    /// `ChatAttachment`.
    ChatAttachment,
    /// `ProviderApprovalDecision`.
    ApprovalDecision,
    /// `ProviderUserInputAnswers`.
    UserInputAnswers,
);
