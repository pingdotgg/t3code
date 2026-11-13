//! Thread titles from a [`TitleGenerator`] (`ThreadTitleRegenerationService.ts`): the effect
//! reads what to title, asks the generator, and answers with
//! `thread.title.regeneration.complete`, which applies only while the request is current.

use std::sync::Arc;

use serde_json::json;

use crate::engine::Inner;
use crate::{TitleKind, TitleRequest};

/// `buildThreadTitlePrompt` caps the text it sends at 8,000 characters.
const TITLE_INPUT_CHARS: usize = 8_000;
/// Failure messages are cut to one line of 300 characters, as `TextGenerationError.detail` is.
const FAILURE_CHARS: usize = 300;

fn cut(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn failure_message(error: &str) -> String {
    let line = error
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("Title generation failed.")
        .trim();
    if line.chars().count() > FAILURE_CHARS {
        format!("{}...", cut(line, FAILURE_CHARS - 3))
    } else {
        line.to_owned()
    }
}

impl Inner {
    /// Reads the request's input; `None` when the thread is gone or has no message.
    async fn title_request(&self, thread_id: &str, regenerate: bool) -> Option<TitleRequest> {
        let id = thread_id.to_owned();
        let read = self
            .db(move |store| -> Result<Option<TitleRequest>, String> {
                let tx = store.tx()?;
                let request = (|| -> Result<Option<TitleRequest>, String> {
                    let Some(thread) = tx.thread(&id)? else {
                        return Ok(None);
                    };
                    let project = tx.project(thread["projectId"].as_str().unwrap_or_default())?;
                    let messages = tx.entities(&id, "messages")?;
                    let kind = if regenerate {
                        // The newest texts that fit, oldest first.
                        let mut budget = TITLE_INPUT_CHARS;
                        let mut transcript = Vec::new();
                        for m in messages.iter().rev() {
                            let text = m["text"].as_str().unwrap_or_default();
                            if text.is_empty() || budget == 0 {
                                continue;
                            }
                            let taken = cut(text, budget);
                            budget = budget.saturating_sub(taken.chars().count());
                            let role = m["role"].as_str().unwrap_or("user").to_owned();
                            transcript.push((role, taken));
                        }
                        transcript.reverse();
                        TitleKind::Regenerate {
                            previous_title: thread["title"].as_str().unwrap_or_default().to_owned(),
                            transcript,
                        }
                    } else {
                        let Some(first) = messages.iter().find(|m| m["role"] == "user") else {
                            return Ok(None);
                        };
                        TitleKind::Initial {
                            message: cut(
                                first["text"].as_str().unwrap_or_default(),
                                TITLE_INPUT_CHARS,
                            ),
                        }
                    };
                    let cwd = thread["worktreePath"]
                        .as_str()
                        .or_else(|| project.as_ref().and_then(|p| p["workspaceRoot"].as_str()))
                        .map(str::to_owned);
                    Ok(Some(TitleRequest {
                        thread_id: id.clone(),
                        cwd,
                        project_title: project.and_then(|p| p["title"].as_str().map(str::to_owned)),
                        kind,
                    }))
                })();
                tx.rollback();
                request
            })
            .await;
        read.ok().flatten()
    }

    pub(crate) async fn generate_title(
        self: Arc<Self>,
        thread_id: String,
        request_id: String,
        regenerate: bool,
    ) {
        let Some(generator) = self.titles.clone() else {
            return;
        };
        let request = self.title_request(&thread_id, regenerate).await;
        let previous = match &request {
            Some(TitleRequest {
                kind: TitleKind::Regenerate { previous_title, .. },
                ..
            }) => Some(previous_title.clone()),
            _ => None,
        };
        let generated = match request {
            Some(request) => generator.generate(request).await,
            None => Err("This thread has no messages to title yet.".to_owned()),
        };
        let mut command = json!({
            "type": "thread.title.regeneration.complete",
            "commandId": format!("{request_id}:title-complete"),
            "threadId": thread_id,
            "requestId": request_id,
        });
        match generated.map(|t| t.trim().trim_matches('"').trim().to_owned()) {
            Ok(title)
                if !title.is_empty()
                    && title != "New thread"
                    && Some(&title) != previous.as_ref() =>
            {
                command["title"] = json!(title);
                if regenerate {
                    command["outcome"] = json!({"status": "renamed"});
                }
            }
            Ok(_) => {
                if regenerate {
                    command["outcome"] = json!({"status": "unchanged"});
                }
            }
            Err(error) => {
                eprintln!("conn-engine: title for {thread_id} failed: {error}");
                // An initial title keeps its seed; only a regenerate reports the failure.
                if regenerate {
                    command["outcome"] =
                        json!({"status": "failed", "message": failure_message(&error)});
                }
            }
        }
        if let Err(
            crate::engine::DispatchError::Rejected(e) | crate::engine::DispatchError::Internal(e),
        ) = self.dispatch_value(command).await
        {
            eprintln!("conn-engine: could not apply the title for {thread_id}: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::failure_message;

    #[test]
    fn failures_read_as_one_short_line() {
        assert_eq!(
            failure_message("boom\n  rate limited  \n\n"),
            "rate limited"
        );
        assert_eq!(failure_message(""), "Title generation failed.");
        assert_eq!(failure_message(&"x".repeat(400)).chars().count(), 300);
    }
}
