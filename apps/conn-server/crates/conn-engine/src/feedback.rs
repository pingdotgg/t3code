//! `provider.uploadFeedback` (T3's handler in `ws.ts`): the thread's active provider thread,
//! else its newest, must have a session that still runs here; the provider then uploads the
//! thread and its logs through its official binary. Only Codex can (`feedback/upload`).
use crate::{EngineError, engine::Inner};
use conn_contract::{ProviderThread, from_json};
use conn_provider::{ProviderError, UploadFeedbackInput};
use serde_json::{Value, json};
use std::sync::Arc;

fn refuse(thread: &str, cause: Value) -> EngineError<Value> {
    EngineError::Rejected(
        json!({"_tag": "ProviderUploadFeedbackError", "threadId": thread, "cause": cause}),
    )
}

impl Inner {
    pub(crate) async fn upload_feedback(
        self: &Arc<Self>,
        input: Value,
    ) -> Result<Value, EngineError<Value>> {
        let thread = input["threadId"].as_str().unwrap_or_default().to_owned();
        let reason = input["reason"].as_str().map(str::to_owned);
        let tid = thread.clone();
        let rows = self
            .db(move |s| {
                let tx = s.tx()?;
                let found = tx.thread(&tid)?.filter(|t| t["deletedAt"].is_null());
                let rows = match found {
                    Some(row) => Some((row, tx.entities(&tid, "providerThreads")?)),
                    None => None,
                };
                tx.rollback();
                Ok(rows)
            })
            .await
            .map_err(|e: String| refuse(&thread, json!({"name": "Error", "message": e})))?;
        let Some((row, provider_threads)) = rows else {
            return Err(refuse(
                &thread,
                json!({"name": "Error", "message": format!("Thread '{thread}' was not found.")}),
            ));
        };
        // T3's `getThreadRecords` order: `COALESCE(first_run_ordinal, 0)`, then the id.
        // Its set also holds provider threads owned through nodes and subagents; this one
        // holds the thread's own (a difference only when no active provider thread is set).
        let mut provider_threads = provider_threads;
        provider_threads.sort_by(|l, r| {
            let ordinal = |p: &Value| p["firstRunOrdinal"].as_i64().unwrap_or(0);
            let id = |p: &Value| p["id"].as_str().unwrap_or_default().to_owned();
            ordinal(l).cmp(&ordinal(r)).then_with(|| id(l).cmp(&id(r)))
        });
        let active = row["activeProviderThreadId"].as_str();
        let chosen = provider_threads
            .iter()
            .find(|p| active.is_some() && p["id"].as_str() == active)
            .or_else(|| provider_threads.last());
        let provider_thread = chosen
            .filter(|p| p["providerSessionId"].is_string())
            .and_then(|p| from_json::<ProviderThread>(p.clone()).ok());
        let Some(provider_thread) = provider_thread else {
            return Err(refuse(
                &thread,
                json!("No provider session has run in this thread yet."),
            ));
        };
        let session_id = provider_thread
            .provider_session_id
            .clone()
            .unwrap_or_default();
        let live = crate::lock(&self.live)
            .values()
            .find(|live| live.session().provider_session_id().as_str() == session_id)
            .cloned();
        let Some(live) = live else {
            return Err(refuse(
                &thread,
                json!("The provider session is no longer running. Send a message first."),
            ));
        };
        let driver = provider_thread.driver.clone();
        match live
            .session()
            .upload_feedback(UploadFeedbackInput {
                provider_thread,
                reason,
            })
            .await
        {
            Ok(feedback_id) => Ok(json!({ "feedbackId": feedback_id })),
            Err(ProviderError::Unsupported { .. }) => Err(refuse(
                &thread,
                json!(format!(
                    "Provider '{driver}' does not support feedback uploads."
                )),
            )),
            // T3 maps every adapter failure to this protocol error; the user sees only the
            // ProviderUploadFeedbackError text, never the provider's own words.
            Err(_) => Err(refuse(
                &thread,
                json!({
                    "name": "ProviderAdapterProtocolError",
                    "message": format!(
                        "{driver} provider protocol error: Failed to upload Codex thread feedback.."
                    ),
                }),
            )),
        }
    }
}
