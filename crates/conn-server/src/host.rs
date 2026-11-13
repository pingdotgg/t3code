//! The server's services as the engine sees them ([`conn_engine::EngineHost`] and
//! [`conn_engine::TurnObserver`]): `/mcp` credentials per provider session, attachment claims,
//! worktrees, terminals that close with their thread, and VCS status after a turn.

use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
};

use conn_contract::{ChatAttachment, TerminalCloseInput, from_json, to_json};
use conn_engine::{
    AgentSession, AgentTools, BoxFuture, EngineHost, ProvisionedWorktree, ThreadClose,
    TurnObserver, TurnPoint, WorktreeRequest,
};
use conn_mcp::{McpService, ThreadCredentialRequest};
use conn_provider::McpServer;
use conn_terminal::TerminalManager;
use conn_vcs::setup::{ProvisionRequest, provision};
use serde_json::Value;

use crate::{environment::Environment, methods::vcs::VcsShared};

pub struct Host {
    /// Set once the service exists; it needs the engine, which needs this host.
    pub mcp: OnceLock<Arc<McpService>>,
    pub files: Option<Arc<conn_files::Files>>,
    pub vcs: VcsShared,
    pub terminals: TerminalManager,
    pub environment: Arc<Environment>,
}

impl Host {
    /// `worktreesDirectory` from the settings, else `<state-dir>/worktrees`.
    fn worktrees_dir(&self) -> PathBuf {
        let setting = self.environment.settings.raw();
        match setting.get("worktreesDirectory").and_then(Value::as_str) {
            Some(dir) if !dir.trim().is_empty() => PathBuf::from(dir.trim()),
            _ => self.environment.state_dir.join("worktrees"),
        }
    }
}

impl EngineHost for Host {
    fn agent_tools(&self, session: AgentSession) -> Option<AgentTools> {
        let entry = self
            .mcp
            .get()?
            .issue_thread_credential(ThreadCredentialRequest {
                thread_id: session.thread_id,
                provider_instance_id: session.provider_instance_id,
                subagent: session.subagent,
            });
        Some(AgentTools {
            servers: vec![McpServer {
                name: conn_mcp::SERVER_NAME.to_owned(),
                url: entry.url,
                headers: vec![("Authorization".to_owned(), entry.authorization)],
            }],
            key: entry.provider_session_id,
        })
    }

    fn session_closed(&self, key: &str) {
        if let Some(mcp) = self.mcp.get() {
            mcp.revoke_provider_session(key);
        }
    }

    fn claim_attachments(
        &self,
        thread_id: String,
        attachments: Value,
    ) -> BoxFuture<'_, Result<Value, String>> {
        let files = self.files.clone();
        Box::pin(async move {
            let Some(files) = files else {
                return Ok(attachments);
            };
            let list: Vec<ChatAttachment> = from_json(attachments).map_err(|e| e.to_string())?;
            tokio::task::spawn_blocking(move || {
                let mut claimed = Vec::with_capacity(list.len());
                for attachment in &list {
                    match files.attachments.claim(&thread_id, attachment) {
                        Ok(kept) => claimed.push(kept),
                        Err(reason) => {
                            files.attachments.release(&claimed);
                            return Err(reason);
                        }
                    }
                }
                Ok(to_json(&claimed))
            })
            .await
            .map_err(|e| e.to_string())?
        })
    }

    fn release_attachments(&self, attachments: Value) -> BoxFuture<'_, ()> {
        let files = self.files.clone();
        Box::pin(async move {
            let (Some(files), Ok(list)) = (files, from_json::<Vec<ChatAttachment>>(attachments))
            else {
                return;
            };
            let _ = tokio::task::spawn_blocking(move || files.attachments.release(&list)).await;
        })
    }

    fn provision_worktree(
        &self,
        request: WorktreeRequest,
    ) -> BoxFuture<'_, Result<ProvisionedWorktree, String>> {
        Box::pin(async move {
            let made = provision(
                &self.vcs.setups,
                ProvisionRequest {
                    thread_id: request.thread_id,
                    project_root: PathBuf::from(request.project_root),
                    base_ref: request.base_ref,
                    branch: request.branch,
                    start_from_origin: request.start_from_origin,
                    setup_script: None,
                    worktrees_dir: self.worktrees_dir(),
                },
            )
            .await
            .map_err(|e| e.to_string())?;
            Ok(ProvisionedWorktree {
                path: made.path.to_string_lossy().into_owned(),
                branch: made.branch,
            })
        })
    }

    fn thread_closed(&self, thread_id: &str, reason: ThreadClose) {
        match reason {
            ThreadClose::Settled => self.terminals.close_on_settle(thread_id),
            ThreadClose::Archived | ThreadClose::Deleted => {
                self.terminals.close(TerminalCloseInput {
                    thread_id: thread_id.to_owned(),
                    terminal_id: None,
                    delete_history: Some(reason == ThreadClose::Deleted),
                });
            }
        }
    }
}

impl TurnObserver for Host {
    fn turn_started(&self, point: TurnPoint) -> BoxFuture<'_, ()> {
        if let Some(mcp) = self.mcp.get() {
            mcp.touch_thread(&point.thread_id);
        }
        Box::pin(std::future::ready(()))
    }

    /// The turn may have changed files: refresh the status the VCS streams show.
    fn turn_ended(&self, point: TurnPoint, _status: String) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if let Some(cwd) = point.cwd {
                let _ = self.vcs.hub.refresh_local(&cwd).await;
            }
        })
    }
}
