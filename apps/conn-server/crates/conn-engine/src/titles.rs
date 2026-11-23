//! Thread titles from a [`TitleGenerator`] (`ThreadTitleRegenerationService.ts`): the effect
//! reads what to title, asks the generator, and answers with
//! `thread.title.regeneration.complete`, which applies only while the request is current.

use std::sync::Arc;

use serde_json::json;

use crate::engine::Inner;
use crate::{TitleKind, TitleRequest};

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
        // `${detail.slice(0, MAX_FAILURE_MESSAGE_LENGTH - 1)}…`
        format!("{}\u{2026}", cut(line, FAILURE_CHARS - 1))
    } else {
        line.to_owned()
    }
}

fn title_message(m: &serde_json::Value) -> crate::TitleMessage {
    crate::TitleMessage {
        role: m["role"].as_str().unwrap_or("user").to_owned(),
        text: m["text"].as_str().unwrap_or_default().to_owned(),
        attachments: m["attachments"].as_array().cloned().unwrap_or_default(),
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
                    let project_id = thread["projectId"].as_str().map(str::to_owned);
                    let project = tx.project(project_id.as_deref().unwrap_or_default())?;
                    let messages = tx.entities(&id, "messages")?;
                    let kind = if regenerate {
                        // T3 reads the finished user and assistant messages.
                        TitleKind::Regenerate {
                            previous_title: thread["title"].as_str().unwrap_or_default().to_owned(),
                            messages: messages
                                .iter()
                                .filter(|m| {
                                    m["streaming"] != true
                                        && (m["role"] == "user" || m["role"] == "assistant")
                                })
                                .map(title_message)
                                .collect(),
                        }
                    } else {
                        let Some(first) = messages.iter().find(|m| m["role"] == "user") else {
                            return Ok(None);
                        };
                        TitleKind::Initial {
                            message: title_message(first),
                        }
                    };
                    let cwd = thread["worktreePath"]
                        .as_str()
                        .or_else(|| project.as_ref().and_then(|p| p["workspaceRoot"].as_str()))
                        .map(str::to_owned);
                    Ok(Some(TitleRequest {
                        thread_id: id.clone(),
                        project_id,
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
                    && Some(title.as_str()) != previous.as_deref().map(str::trim) =>
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
        if let Err(e) = self.dispatch_value(command).await {
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
