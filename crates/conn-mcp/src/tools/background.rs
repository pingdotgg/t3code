//! `t3_background_wait` (`toolkits/orchestrator`): the calling thread's agent marks the
//! background tasks it waits on, so its thread stays Working while they run; `waiting: false`
//! clears the mark. The engine asks the thread's live provider session
//! (`ThreadManagementService.awaitBackgroundTasks`); only Claude keeps such a roster.

use conn_contract::ThreadId;
use conn_engine::BackgroundWaitError;
use serde_json::{Value, json};

use super::{Args, Cx, ToolError, ToolResult, bool_arg, fail};

/// `actsAsCaller`: a live thread caller only. `taskIds` holds 1 to 20 strings (the catalog
/// check); each is trimmed and may not be blank (`TrimmedNonEmptyString`).
pub(super) async fn wait(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let task_ids = task_ids(args)?;
    let caller = cx.require_thread("This tool")?;
    cx.writing_caller().await?;
    let awaited = bool_arg(args, "waiting").unwrap_or(true);
    let thread_id = ThreadId::from(caller.thread_id.as_str());
    match cx
        .engine()
        .await_background_tasks(thread_id, task_ids, awaited)
        .await
    {
        Ok(wait) => Ok(json!({"matched": wait.matched, "unmatched": wait.unmatched})),
        Err(error) => Err(fail(
            match error {
                BackgroundWaitError::Unsupported | BackgroundWaitError::Unmatched => {
                    "invalid_request"
                }
                BackgroundWaitError::Unavailable | BackgroundWaitError::Failed => {
                    "orchestration_error"
                }
            },
            error.to_string(),
        )),
    }
}

/// The trimmed ids, in order. A blank one fails as Effect's `isNonBlank` filter does.
fn task_ids(args: &Args) -> Result<Vec<String>, ToolError> {
    let Some(items) = args.get("taskIds").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let text = item.as_str().unwrap_or_default();
            // JavaScript's `trim`: Unicode white space and U+FEFF, but not U+0085.
            let trimmed = text
                .trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
            if trimmed.is_empty() {
                // Effect names the filter's `expected` text only; parity checks it.
                return Err(ToolError::InvalidParams(format!(
                    "Expected a non-blank string\n  at [\"taskIds\"][{index}]"
                )));
            }
            Ok(trimmed.to_owned())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_trimmed_and_blank_ones_refused() {
        let args = |ids: Value| json!({ "taskIds": ids }).as_object().cloned().unwrap();
        assert_eq!(
            task_ids(&args(json!([" a ", "\u{feff}b\n", "\u{85}c"]))).unwrap(),
            ["a", "b", "\u{85}c"]
        );
        let Err(ToolError::InvalidParams(problem)) = task_ids(&args(json!(["a", "  "]))) else {
            panic!("a blank id passed");
        };
        assert_eq!(
            problem,
            "Expected a non-blank string\n  at [\"taskIds\"][1]"
        );
    }
}
