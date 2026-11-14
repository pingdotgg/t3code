//! The provider interface: what the engine needs from an agent runtime (Claude, Codex, ...).
//!
//! Shaped from `ProviderAdapterV2` in `packages/provider-core/src/server/ProviderAdapter.ts`,
//! which Claude and Codex both implement. A [`Provider`] opens a [`Session`] (one native
//! process or connection). A session owns provider threads, runs turns on them, and reports
//! everything that happens as [`ProviderEvent`]s on one channel.
//!
//! Kept from the TS interface: open session, ensure/resume thread, start/steer/interrupt
//! turn, apply model selection, respond to runtime requests (permission prompts and user
//! questions), the event stream. Added: [`Session::apply_runtime_policy`], so a permission
//! mode change reaches a running process (Claude `setPermissionMode`); TS passes the policy
//! per turn only. Left out until needed: compact, rollback, fork, thread snapshots, history
//! injection, background tasks, subagent stop, MCP apps, feedback upload.
//!
//! To add a provider: make a crate that depends on this one and implements both traits.

use std::{future::Future, pin::Pin};

use conn_contract::{
    AppThread, ApprovalDecision, ChatAttachment, ConversationMessage, ExecutionNode,
    InteractionMode, MessageId, ModelSelection, NodeId, PlanArtifact, ProviderCapabilities,
    ProviderFailure, ProviderInstanceId, ProviderRetry, ProviderSession, ProviderSessionId,
    ProviderThread, ProviderThreadId, ProviderTurn, ProviderTurnId, RunAttemptId, RunId,
    RuntimeMode, RuntimeRequest, RuntimeRequestId, Subagent, ThreadId, TurnItem, TurnItemId,
    UserInputAnswers,
};

pub use conn_contract::AppThread as ProviderAppThread;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type ProviderResult<T> = Result<T, ProviderError>;

/// A configured provider instance, such as the user's Claude install.
pub trait Provider: Send + Sync {
    fn instance_id(&self) -> &ProviderInstanceId;

    /// The contract's `ProviderDriverKind`, such as `claudeAgent` or `codex`.
    fn driver(&self) -> &str;

    fn capabilities(&self) -> BoxFuture<'_, ProviderResult<ProviderCapabilities>>;

    /// Starts or resumes a native session. Events flow on the returned channel until the
    /// session closes; the engine is its only reader.
    fn open_session(&self, input: OpenSessionInput)
    -> BoxFuture<'_, ProviderResult<OpenedSession>>;

    /// The `ServerProvider` entry (`packages/contracts/src/server.ts`) for
    /// `ServerConfig.providers`, or `None` when the server builds it another way.
    /// `checked_at` is ISO-8601.
    fn server_provider_entry(&self, _checked_at: &str) -> Option<serde_json::Value> {
        None
    }
}

pub struct OpenedSession {
    pub session: Box<dyn Session>,
    pub events: mpsc::Receiver<ProviderEvent>,
}

impl std::fmt::Debug for OpenedSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenedSession").finish_non_exhaustive()
    }
}

/// One live native session. Methods return once the provider accepted the request; results
/// arrive as events.
pub trait Session: Send + Sync {
    fn provider_session_id(&self) -> &ProviderSessionId;

    /// Creates the native thread for an app thread, or returns `existing` when it is usable.
    fn ensure_thread(
        &self,
        input: EnsureThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ProviderThread>>;

    /// Loads an existing native thread, for example after a server restart.
    fn resume_thread(
        &self,
        input: ResumeThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ProviderThread>>;

    /// Sends one user message and starts a turn. Ends with [`ProviderEvent::TurnTerminal`].
    fn start_turn(&self, input: TurnInput) -> BoxFuture<'_, ProviderResult<()>>;

    /// Adds a message to the running turn.
    fn steer_turn(&self, _input: SteerInput) -> BoxFuture<'_, ProviderResult<()>> {
        unsupported("steer_turn")
    }

    /// Stops the running turn. Its `TurnTerminal` reports `interrupted`.
    fn interrupt_turn(&self, input: InterruptInput) -> BoxFuture<'_, ProviderResult<()>>;

    /// Applies a new model to the running process. `Unsupported` means it applies next turn.
    fn apply_model_selection(
        &self,
        _thread: ProviderThread,
        _selection: ModelSelection,
    ) -> BoxFuture<'_, ProviderResult<()>> {
        unsupported("apply_model_selection")
    }

    /// Applies a new permission mode to the running process. `Unsupported` means next turn.
    fn apply_runtime_policy(
        &self,
        _thread: ProviderThread,
        _policy: RuntimePolicy,
    ) -> BoxFuture<'_, ProviderResult<()>> {
        unsupported("apply_runtime_policy")
    }

    /// Answers a permission prompt or user question the provider raised as a
    /// [`ProviderEvent::RuntimeRequestUpdated`].
    fn respond_to_runtime_request(
        &self,
        input: RuntimeRequestResponse,
    ) -> BoxFuture<'_, ProviderResult<()>>;

    /// Ends the native process. The event channel closes after it.
    fn close(&self) -> BoxFuture<'_, ()>;

    /// Starts a turn the provider asked for with [`ProviderEvent::ContinuationRequested`]
    /// (`createdBy: agent`, `creationSource: provider` in TS). No user message is sent; the
    /// turn shows the output the provider already holds for it.
    fn start_continuation_turn(&self, _input: TurnInput) -> BoxFuture<'_, ProviderResult<()>> {
        unsupported("start_continuation_turn")
    }

    /// Sets the MCP servers every later turn of this session can use, replacing the previous
    /// list. A running process picks them up when the provider supports a live change.
    fn set_mcp_servers(&self, _servers: Vec<McpServer>) -> BoxFuture<'_, ProviderResult<()>> {
        unsupported("set_mcp_servers")
    }

    /// `ProviderAdapterV2SessionRuntime.rollbackThread`: the next turn continues from `target`.
    fn rollback_thread(
        &self,
        _input: RollbackThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ThreadSnapshot>> {
        unsupported("rollback_thread")
    }

    /// `forkThread`: a new native thread with the source's history, up to a turn if given.
    fn fork_thread(
        &self,
        _input: ForkThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
        unsupported("fork_thread")
    }

    /// `readThreadSnapshot`: the native thread's history as app rows.
    fn read_thread_snapshot(
        &self,
        _provider_thread: ProviderThread,
    ) -> BoxFuture<'_, ProviderResult<ThreadSnapshot>> {
        unsupported("read_thread_snapshot")
    }

    /// `hasPendingBackgroundWork`: work still runs after the turn ended (a background
    /// subagent), so an idle session should not be released yet.
    fn has_pending_background_work(&self) -> bool {
        false
    }

    /// `injectHistory`: gives the native thread earlier conversation as context. `Ok(false)`
    /// means the native protocol cannot take it.
    fn inject_history(&self, _input: InjectHistoryInput) -> BoxFuture<'_, ProviderResult<bool>> {
        unsupported("inject_history")
    }
}

/// One MCP server a session passes to its agent (`McpServerConfig`, HTTP transport).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
}

impl std::fmt::Debug for McpServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Header values carry the agent's bearer token.
        let headers: Vec<(&str, &str)> = self
            .headers
            .iter()
            .map(|(name, _)| (name.as_str(), "<redacted>"))
            .collect();
        f.debug_struct("McpServer")
            .field("name", &self.name)
            .field("url", &self.url)
            .field("headers", &headers)
            .finish()
    }
}

/// `ProviderAdapterV2RollbackTarget`.
#[expect(clippy::large_enum_variant, reason = "built once per rollback")]
#[derive(Clone, Debug)]
pub enum RollbackTarget {
    ThreadStart {
        checkpoint_id: String,
    },
    ProviderTurn {
        checkpoint_id: String,
        app_run_ordinal: u32,
        provider_turn: ProviderTurn,
    },
}

/// `ProviderAdapterV2RollbackThreadInput`.
#[derive(Clone, Debug)]
pub struct RollbackThreadInput {
    pub provider_thread: ProviderThread,
    pub target: RollbackTarget,
    pub provider_thread_turns: Vec<ProviderTurn>,
}

/// `ProviderAdapterV2ForkThreadInput`.
#[derive(Clone, Debug)]
pub struct ForkThreadInput {
    pub source_provider_thread: ProviderThread,
    pub source_provider_turns: Vec<ProviderTurn>,
    pub provider_turn_id: Option<ProviderTurnId>,
    pub target_thread_id: ThreadId,
    pub owner_node_id: Option<NodeId>,
    /// The fork's run selection (T3 passes `run.modelSelection`). Codex sends its model.
    pub model_selection: Option<ModelSelection>,
    /// The fork's resolved runtime policy. Codex sends its `cwd`.
    pub runtime_policy: Option<RuntimePolicy>,
}

/// `ProviderAdapterV2ThreadSnapshot`.
#[derive(Clone, Debug)]
pub struct ThreadSnapshot {
    pub provider_thread: ProviderThread,
    pub provider_turns: Vec<ProviderTurn>,
    pub messages: Vec<ConversationMessage>,
    pub runtime_requests: Vec<RuntimeRequest>,
}

/// `ProviderAdapterV2HistoricalContext` plus the thread.
#[derive(Clone, Debug)]
pub struct InjectHistoryInput {
    pub provider_thread: ProviderThread,
    pub messages: Vec<ConversationMessage>,
    pub context: String,
}

/// What [`ProviderEvent::ContinuationRequested`] carries (`ProviderContinuationRequest`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationRequest {
    pub thread_id: ThreadId,
    pub provider_thread_id: ProviderThreadId,
    pub detail: Option<String>,
}

/// `ProviderAdapterV2Event` `steer.updated` status.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SteerStatus {
    Pending,
    Completed,
    Cancelled,
}

fn unsupported<T: Send + 'static>(
    operation: &'static str,
) -> BoxFuture<'static, ProviderResult<T>> {
    Box::pin(async move { Err(ProviderError::Unsupported { operation }) })
}

/// `ProviderAdapterV2RuntimePolicy`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePolicy {
    pub runtime_mode: RuntimeMode,
    pub interaction_mode: InteractionMode,
    pub cwd: Option<String>,
    /// A native approval policy that replaces the runtime mode's default (a managed policy's
    /// override). Passed to the provider as is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<serde_json::Value>,
    /// A native sandbox policy that replaces the runtime mode's default. Passed as is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_policy: Option<serde_json::Value>,
}

/// `ProviderAdapterV2OpenSessionInput`.
#[derive(Clone, Debug)]
pub struct OpenSessionInput {
    pub thread_id: ThreadId,
    pub provider_session_id: ProviderSessionId,
    pub model_selection: ModelSelection,
    pub runtime_policy: RuntimePolicy,
    pub resume_from_session: Option<ProviderSession>,
}

/// `ProviderAdapterV2EnsureThreadInput`.
#[derive(Clone, Debug)]
pub struct EnsureThreadInput {
    pub thread_id: ThreadId,
    pub title: Option<String>,
    pub model_selection: ModelSelection,
    pub runtime_policy: RuntimePolicy,
    pub existing_provider_thread: Option<ProviderThread>,
}

#[derive(Clone, Debug)]
pub struct ResumeThreadInput {
    pub provider_thread: ProviderThread,
    pub thread_id: Option<ThreadId>,
    pub model_selection: Option<ModelSelection>,
    pub runtime_policy: Option<RuntimePolicy>,
}

/// `ProviderAdapterV2TurnMessage`.
#[derive(Clone, Debug)]
pub struct TurnMessage {
    pub message_id: MessageId,
    pub text: String,
    pub attachments: Vec<ChatAttachment>,
}

/// `ProviderAdapterV2TurnInput`.
#[derive(Clone, Debug)]
pub struct TurnInput {
    pub app_thread: AppThread,
    pub thread_id: ThreadId,
    pub run_id: RunId,
    pub run_ordinal: u32,
    pub provider_turn_ordinal: u32,
    pub attempt_id: RunAttemptId,
    pub root_node_id: NodeId,
    pub provider_thread: ProviderThread,
    pub message: TurnMessage,
    pub model_selection: ModelSelection,
    pub runtime_policy: RuntimePolicy,
}

/// `ProviderAdapterV2SteerInput`.
#[derive(Clone, Debug)]
pub struct SteerInput {
    pub thread_id: ThreadId,
    pub run_id: RunId,
    pub provider_thread: ProviderThread,
    pub provider_turn_id: ProviderTurnId,
    pub message: TurnMessage,
    pub model_selection: Option<ModelSelection>,
}

/// `ProviderAdapterV2InterruptInput`.
#[derive(Clone, Debug)]
pub struct InterruptInput {
    pub provider_thread: ProviderThread,
    pub provider_turn_id: ProviderTurnId,
}

/// `ProviderAdapterV2RuntimeRequestResponseInput`.
#[derive(Clone, Debug)]
pub struct RuntimeRequestResponse {
    pub request_id: RuntimeRequestId,
    pub decision: Option<ApprovalDecision>,
    pub feedback: Option<String>,
    pub answers: Option<UserInputAnswers>,
}

/// `ProviderAdapterV2Event` without the `driver` field (the session knows its driver).
/// Serializes like the TS event (`type` tag, camelCase fields) for recorded-session tests.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
#[expect(
    clippy::large_enum_variant,
    reason = "each event moves once into the channel"
)]
pub enum ProviderEvent {
    #[serde(rename = "provider_session.updated")]
    ProviderSessionUpdated { provider_session: ProviderSession },
    #[serde(rename = "provider_thread.updated")]
    ProviderThreadUpdated { provider_thread: ProviderThread },
    #[serde(rename = "provider_turn.updated")]
    ProviderTurnUpdated {
        thread_id: Option<ThreadId>,
        provider_turn: ProviderTurn,
    },
    #[serde(rename = "node.updated")]
    NodeUpdated { node: ExecutionNode },
    #[serde(rename = "subagent.updated")]
    SubagentUpdated { subagent: Subagent },
    #[serde(rename = "message.updated")]
    MessageUpdated { message: ConversationMessage },
    #[serde(rename = "turn_item.updated")]
    TurnItemUpdated { turn_item: TurnItem },
    /// Not persisted; goes only to clients that show the row.
    #[serde(rename = "command_output.delta")]
    CommandOutputDelta {
        thread_id: ThreadId,
        item_id: TurnItemId,
        chunk: String,
    },
    /// A permission prompt or user question, or its resolution.
    #[serde(rename = "runtime_request.updated")]
    RuntimeRequestUpdated {
        thread_id: Option<ThreadId>,
        runtime_request: RuntimeRequest,
    },
    #[serde(rename = "plan.updated")]
    PlanUpdated { plan: PlanArtifact },
    #[serde(rename = "turn.terminal")]
    TurnTerminal(TurnTerminal),
    /// A provider-made thread, such as a subagent's child thread. `create_only`: create it
    /// if missing, never overwrite.
    #[serde(rename = "app_thread.created")]
    AppThreadCreated {
        app_thread: AppThread,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        create_only: Option<bool>,
    },
    /// A message sent into a running turn was taken (`completed`) or dropped (`cancelled`).
    #[serde(rename = "steer.updated")]
    SteerUpdated {
        thread_id: ThreadId,
        run_id: RunId,
        message_id: MessageId,
        status: SteerStatus,
    },
    /// Not in `ProviderAdapterV2Event` (TS uses a separate service): the provider produced
    /// output with no turn running and asks the engine to start a turn for it with
    /// [`Session::start_continuation_turn`].
    #[serde(rename = "continuation.requested")]
    ContinuationRequested(ContinuationRequest),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnTerminal {
    pub provider_thread_id: ProviderThreadId,
    pub provider_turn_id: ProviderTurnId,
    pub run_ordinal: u32,
    pub status: TurnStatus,
    /// Set when `status` is `failed`.
    pub failure: Option<ProviderFailure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<ProviderRetry>,
    pub thread_disposition: ThreadDisposition,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnStatus {
    Completed,
    Interrupted,
    Cancelled,
    Failed,
}

/// Whether the native thread can take another turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThreadDisposition {
    Reusable,
    Broken,
}

/// A provider failure, condensed from the `ProviderAdapterV2Error` union.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderError {
    /// This provider does not implement the operation.
    Unsupported { operation: &'static str },
    /// No running session owns the thread.
    SessionStopped,
    /// The provider needs the user to sign in.
    SignInRequired,
    /// The native protocol sent something unexpected.
    Protocol { detail: String },
    /// `ProviderAdapterInterruptTimeoutError`: the provider did not confirm a stop in time and
    /// its turn stays open, so the agent may still run. The engine marks the Stop unresponsive
    /// and leaves the run to the provider's own terminal or to Force stop.
    InterruptTimeout { timeout_ms: u64 },
    /// An operation failed; `detail` is safe to show the user.
    Failed {
        operation: &'static str,
        detail: String,
    },
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported { operation } => write!(f, "provider does not support {operation}"),
            Self::SessionStopped => f.write_str("no running provider session owns this thread"),
            Self::SignInRequired => f.write_str("provider requires sign-in"),
            Self::Protocol { detail } => write!(f, "provider protocol error: {detail}"),
            Self::InterruptTimeout { timeout_ms } => write!(
                f,
                "the provider did not confirm stopping the turn within {timeout_ms} ms"
            ),
            Self::Failed { operation, detail } => {
                write!(f, "provider {operation} failed: {detail}")
            }
        }
    }
}

impl std::error::Error for ProviderError {}

#[cfg(test)]
mod tests {
    use super::*;
    use conn_contract::{from_json, to_json};
    use serde_json::json;

    const NOW: &str = "2026-11-13T00:00:00.000Z";

    /// A provider that answers every turn with one assistant message and a terminal.
    struct EchoProvider {
        id: ProviderInstanceId,
    }

    struct EchoSession {
        id: ProviderSessionId,
        events: mpsc::Sender<ProviderEvent>,
    }

    impl Provider for EchoProvider {
        fn instance_id(&self) -> &ProviderInstanceId {
            &self.id
        }
        fn driver(&self) -> &str {
            "echo"
        }
        fn capabilities(&self) -> BoxFuture<'_, ProviderResult<ProviderCapabilities>> {
            Box::pin(async { Ok(from_json(json!({})).unwrap()) })
        }
        fn open_session(
            &self,
            input: OpenSessionInput,
        ) -> BoxFuture<'_, ProviderResult<OpenedSession>> {
            Box::pin(async move {
                let (tx, rx) = mpsc::channel(16);
                Ok(OpenedSession {
                    session: Box::new(EchoSession {
                        id: input.provider_session_id,
                        events: tx,
                    }),
                    events: rx,
                })
            })
        }
    }

    impl Session for EchoSession {
        fn provider_session_id(&self) -> &ProviderSessionId {
            &self.id
        }
        fn ensure_thread(
            &self,
            input: EnsureThreadInput,
        ) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
            Box::pin(async move {
                Ok(from_json(json!({
                    "id": format!("native-{}", input.thread_id), "driver": "echo",
                    "providerInstanceId": "claude", "providerSessionId": self.id,
                    "appThreadId": input.thread_id, "ownerNodeId": null,
                    "nativeThreadRef": null, "nativeConversationHeadRef": null,
                    "status": "active", "firstRunOrdinal": null, "lastRunOrdinal": null,
                    "handoffIds": [], "forkedFrom": null, "createdAt": NOW, "updatedAt": NOW,
                }))
                .unwrap())
            })
        }
        fn resume_thread(
            &self,
            input: ResumeThreadInput,
        ) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
            Box::pin(async move { Ok(input.provider_thread) })
        }
        fn start_turn(&self, input: TurnInput) -> BoxFuture<'_, ProviderResult<()>> {
            Box::pin(async move {
                let message = json!({
                    "createdBy": "agent", "creationSource": "provider", "id": "m1",
                    "threadId": input.thread_id, "runId": input.run_id, "nodeId": null,
                    "role": "assistant", "text": input.message.text, "attachments": [],
                    "streaming": false, "createdAt": NOW, "updatedAt": NOW,
                });
                let send = |event| self.events.send(event);
                send(ProviderEvent::MessageUpdated {
                    message: from_json(message).unwrap(),
                })
                .await
                .map_err(|_| ProviderError::SessionStopped)?;
                send(ProviderEvent::TurnTerminal(TurnTerminal {
                    provider_thread_id: "native-t1".into(),
                    provider_turn_id: "turn-1".into(),
                    run_ordinal: input.run_ordinal,
                    status: TurnStatus::Completed,
                    failure: None,
                    retry: None,
                    thread_disposition: ThreadDisposition::Reusable,
                }))
                .await
                .map_err(|_| ProviderError::SessionStopped)
            })
        }
        fn interrupt_turn(&self, _input: InterruptInput) -> BoxFuture<'_, ProviderResult<()>> {
            Box::pin(async { Ok(()) })
        }
        fn respond_to_runtime_request(
            &self,
            _input: RuntimeRequestResponse,
        ) -> BoxFuture<'_, ProviderResult<()>> {
            Box::pin(async { Ok(()) })
        }
        fn close(&self) -> BoxFuture<'_, ()> {
            Box::pin(async {})
        }
    }

    fn policy() -> RuntimePolicy {
        from_json(json!({"runtimeMode": "full-access", "interactionMode": "default", "cwd": null}))
            .unwrap()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_turn_streams_events_through_dyn_provider() {
        let provider: Box<dyn Provider> = Box::new(EchoProvider {
            id: "claude".into(),
        });
        let model: ModelSelection = from_json(json!({"provider": "claude", "model": "x"})).unwrap();
        let OpenedSession {
            session,
            mut events,
        } = provider
            .open_session(OpenSessionInput {
                thread_id: "t1".into(),
                provider_session_id: "s1".into(),
                model_selection: model.clone(),
                runtime_policy: policy(),
                resume_from_session: None,
            })
            .await
            .unwrap();
        let thread = session
            .ensure_thread(EnsureThreadInput {
                thread_id: "t1".into(),
                title: None,
                model_selection: model.clone(),
                runtime_policy: policy(),
                existing_provider_thread: None,
            })
            .await
            .unwrap();
        session
            .start_turn(TurnInput {
                app_thread: from_json(json!({
                    "createdBy": "user", "creationSource": "web", "id": "t1", "projectId": "p1",
                    "title": "T", "providerInstanceId": "claude",
                    "modelSelection": to_json(&model), "runtimeMode": "full-access",
                    "interactionMode": "default", "branch": null, "worktreePath": null,
                    "activeProviderThreadId": null,
                    "lineage": {"parentThreadId": null, "relationshipToParent": null, "rootThreadId": "t1"},
                    "forkedFrom": null, "createdAt": NOW, "updatedAt": NOW, "archivedAt": null,
                }))
                .unwrap(),
                thread_id: "t1".into(),
                run_id: "r1".into(),
                run_ordinal: 1,
                provider_turn_ordinal: 1,
                attempt_id: "a1".into(),
                root_node_id: "n1".into(),
                provider_thread: thread.clone(),
                message: TurnMessage {
                    message_id: "u1".into(),
                    text: "hi".into(),
                    attachments: vec![],
                },
                model_selection: model.clone(),
                runtime_policy: policy(),
            })
            .await
            .unwrap();

        let ProviderEvent::MessageUpdated { message } = events.recv().await.unwrap() else {
            panic!("expected a message")
        };
        assert_eq!(to_json(&message)["text"], "hi");
        let terminal = events.recv().await.unwrap();
        assert_eq!(
            serde_json::to_value(&terminal).unwrap()["type"],
            "turn.terminal"
        );

        assert_eq!(
            session.apply_model_selection(thread, model).await,
            Err(ProviderError::Unsupported {
                operation: "apply_model_selection"
            })
        );
    }

    #[test]
    fn events_use_the_ts_wire_names() {
        let event: ProviderEvent = serde_json::from_value(json!({
            "type": "command_output.delta", "threadId": "t1", "itemId": "i1", "chunk": "ok"
        }))
        .unwrap();
        assert_eq!(
            event,
            ProviderEvent::CommandOutputDelta {
                thread_id: "t1".into(),
                item_id: "i1".into(),
                chunk: "ok".into()
            }
        );
    }
}
