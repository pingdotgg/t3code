//! Rows beside the conversation: todo lists, API retries, usage limits, compaction, and the
//! failure a turn ends with. Each follows the TS function named on it.

use super::{DRIVER, HashSet, ResultMsg, SystemMsg, Turn, TurnStatus, Value, ids, json};

/// `providerRetries` state for the running turn.
#[derive(Clone, Debug)]
pub(crate) struct RetryState {
    pub retry: Value,
    pub failure: Value,
    pub started_at: String,
    pub ordinal: u32,
}

/// Usage-limit evidence for the running turn.
#[derive(Default, Debug)]
pub(crate) struct LimitState {
    /// Rejected window type → its reset time, if known.
    pub rejected: Vec<(String, Option<String>)>,
    pub announced: HashSet<String>,
    /// The last root assistant response was blocked by a limit: (type, reset).
    pub assistant: Option<(String, Option<String>)>,
}

const CONTEXT_WINDOW_FULL: &str = "Claude stopped: the prompt exceeds the model's context window. Run /compact or start a new thread.";

/// `claudeTodoSteps`.
pub(crate) fn todo_steps(input: &Value) -> Vec<Value> {
    input
        .get("todos")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, todo)| {
            let text = todo.get("content")?.as_str()?.trim();
            if text.is_empty() {
                return None;
            }
            Some(json!({
                "id": format!("todo-{index}"),
                "text": text,
                "status": step_status(todo.get("status").and_then(Value::as_str)).unwrap_or("pending"),
            }))
        })
        .collect()
}

fn step_status(status: Option<&str>) -> Option<&'static str> {
    match status? {
        "completed" => Some("completed"),
        "in_progress" => Some("running"),
        "pending" => Some("pending"),
        _ => None,
    }
}

/// A task list entry: id, text, status.
pub(crate) type TaskEntry = (String, String, String);

/// `applyClaudeTaskTool`: the new list, or `None` when nothing changed.
pub(crate) fn apply_task_tool(
    tasks: &[TaskEntry],
    tool: &str,
    input: &Value,
    result: &Value,
) -> Option<Vec<TaskEntry>> {
    let text = result.as_str().unwrap_or("");
    match tool {
        "TaskList" => {
            let list: Vec<TaskEntry> = result
                .get("tasks")?
                .as_array()?
                .iter()
                .filter_map(|t| {
                    let status = step_status(t.get("status").and_then(Value::as_str))?;
                    Some((
                        json_string(t.get("id")?)?,
                        t.get("subject")?.as_str()?.to_string(),
                        status.to_string(),
                    ))
                })
                .collect();
            (!(list.is_empty() && tasks.is_empty())).then_some(list)
        }
        "TaskCreate" => {
            let from_text = text
                .strip_prefix("Task #")
                .and_then(|rest| rest.split_once(" created successfully: "));
            let id = result
                .get("task")
                .and_then(|t| t.get("id"))
                .and_then(json_string)
                .or(from_text.map(|(id, _)| id.to_string()))?;
            let subject = result
                .get("task")
                .and_then(|t| t.get("subject"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .or(from_text.map(|(_, s)| s.trim().to_string()))
                .or(input
                    .get("subject")
                    .and_then(Value::as_str)
                    .map(str::to_string))?;
            let mut next: Vec<TaskEntry> = tasks.iter().filter(|t| t.0 != id).cloned().collect();
            next.push((id, subject, "pending".into()));
            Some(next)
        }
        "TaskUpdate" => {
            if result.get("success") == Some(&json!(false))
                || (result.is_string() && !text.starts_with("Updated task #"))
            {
                return None;
            }
            let id = input
                .get("taskId")
                .and_then(json_string)
                .or(result.get("taskId").and_then(json_string))?;
            let position = tasks.iter().position(|t| t.0 == id)?;
            let mut next = tasks.to_vec();
            if input.get("status").and_then(Value::as_str) == Some("deleted") {
                next.remove(position);
                return Some(next);
            }
            let entry = &mut next[position];
            if let Some(subject) = input.get("subject").and_then(Value::as_str) {
                entry.1 = subject.to_string();
            }
            if let Some(status) = step_status(input.get("status").and_then(Value::as_str)) {
                entry.2 = status.to_string();
            }
            (next[position] != tasks[position]).then_some(next)
        }
        _ => None,
    }
}

fn json_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// `providerFailureFromApiRetry`.
pub(crate) fn api_retry_failure(msg: &SystemMsg) -> Value {
    let error = msg.error.clone().unwrap_or_else(|| "unknown".into());
    let status = msg.error_status.map(|s| s.trunc() as i64);
    json!({
        "class": match status { Some(429) => "usage_limit", None => "transport_error", _ => "provider_error" },
        "message": format!("Claude API {}.", error.replace('_', " ")),
        "code": status.map_or(error, |s| format!("api_error_{s}")),
        "retryable": true,
    })
}

/// `makeProviderRetryTurnItem`.
pub(crate) fn retry_item(turn: &Turn, state: &RetryState, status: &str, now: &str) -> Value {
    let title = match status {
        "running" => "Provider retry",
        "completed" => "Provider recovered",
        "failed" if state.failure["class"] == "usage_limit" => "Usage limit reached",
        "failed" => "Provider error",
        _ => "Provider retry stopped",
    };
    json!({
        "id": ids::turn_item_from_item(DRIVER, &format!("terminal-failure:{}", turn.provider_turn_id)),
        "threadId": turn.thread_id, "runId": turn.run_id, "nodeId": turn.root_node_id,
        "providerThreadId": turn.provider_thread_id, "providerTurnId": turn.provider_turn_id,
        "nativeItemRef": null, "parentItemId": null, "ordinal": state.ordinal,
        "status": status, "title": title, "startedAt": state.started_at,
        "completedAt": if status == "running" { Value::Null } else { json!(now) },
        "updatedAt": now, "type": "error", "failure": state.failure, "retry": state.retry,
    })
}

/// `claudeUsageLimitResetAt`.
pub(crate) fn reset_at(resets_at: Option<&Value>) -> Option<String> {
    let ms = resets_at?.as_f64()? * 1000.0;
    (ms > 0.0 && ms < 8.64e15).then(|| ids::iso_from_ms(ms as u64))
}

/// `describeClaudeUsageLimit`.
pub(crate) fn usage_limit_notice(limit_type: &str, resets_at: Option<f64>, now_ms: u64) -> String {
    let label = match limit_type {
        "five_hour" => Some("5-hour"),
        "seven_day" => Some("7-day"),
        "seven_day_opus" => Some("7-day Opus"),
        "seven_day_sonnet" => Some("7-day Sonnet"),
        "seven_day_overage_included" => Some("7-day model"),
        "overage" => Some("overage"),
        _ => None,
    };
    let wait = resets_at.and_then(|s| {
        let wait_ms = s * 1000.0 - now_ms as f64;
        (wait_ms > 0.0 && wait_ms <= 30.0 * 86_400_000.0).then(|| {
            let minutes = (wait_ms / 60_000.0).ceil() as u64;
            match (minutes / 60, minutes % 60) {
                (0, m) => format!("{m}m"),
                (h, 0) => format!("{h}h"),
                (h, m) => format!("{h}h {m}m"),
            }
        })
    });
    let label = label.map(|l| format!("{l} ")).unwrap_or_default();
    let wait = wait.map(|w| format!(" in {w}")).unwrap_or_default();
    format!("Claude usage limit reached. This turn is paused until the {label}limit resets{wait}.")
}

/// `terminalResultError`.
fn terminal_result_error(reason: Option<&str>, hint: Option<&str>) -> Option<String> {
    let text = match reason? {
        "api_error" => hint.unwrap_or("Claude gave up after repeated API errors."),
        "malformed_tool_use_exhausted" => "Claude gave up after repeated malformed tool calls.",
        "budget_exhausted" => "Claude stopped: the turn's token budget was exhausted.",
        "structured_output_retry_exhausted" => {
            "Claude could not produce the requested structured output."
        }
        "tool_deferred_unavailable" => {
            "Claude could not resume a deferred tool call: the tool is no longer available."
        }
        "turn_setup_failed" => "Claude could not start the turn.",
        "blocking_limit" => hint.unwrap_or(CONTEXT_WINDOW_FULL),
        "rapid_refill_breaker" => {
            "Claude stopped: the context refilled too quickly after compaction."
        }
        "prompt_too_long" => CONTEXT_WINDOW_FULL,
        "image_error" => "Claude stopped: an image in the conversation could not be processed.",
        "model_error" => "Claude stopped: the model returned an error.",
        _ => return None,
    };
    Some(text.to_string())
}

/// `terminalStatusFromResult`.
pub(crate) fn result_status(msg: &ResultMsg, hint: Option<&str>) -> TurnStatus {
    if matches!(
        msg.terminal_reason.as_deref(),
        Some("aborted_tools" | "aborted_streaming")
    ) {
        return TurnStatus::Interrupted;
    }
    if msg.subtype == "success" {
        let failed = matches!(msg.api_error_status, Some(429 | 529))
            || terminal_result_error(msg.terminal_reason.as_deref(), hint).is_some()
            || (msg.is_error && hint.is_some());
        return if failed {
            TurnStatus::Failed
        } else {
            TurnStatus::Completed
        };
    }
    let errors = msg
        .errors
        .as_ref()
        .map(|e| e.join("\n").to_lowercase())
        .unwrap_or_default();
    if errors.contains("interrupt") {
        TurnStatus::Interrupted
    } else if errors.contains("cancel") {
        TurnStatus::Cancelled
    } else {
        TurnStatus::Failed
    }
}

/// `providerFailureFromResult`, without the gateway-cooldown parse.
pub(crate) fn result_failure(
    msg: &ResultMsg,
    hint: Option<&str>,
    usage_limited: bool,
) -> Option<Value> {
    let success = msg.subtype == "success";
    let class = if (success && msg.api_error_status == Some(429)) || usage_limited {
        "usage_limit"
    } else {
        "provider_error"
    };
    let listed = (!success || msg.is_error)
        .then(|| {
            msg.errors
                .iter()
                .flatten()
                .find(|e| !e.starts_with("[ede_diagnostic]"))
                .cloned()
        })
        .flatten();
    let result_text = msg.result.clone().unwrap_or_default();
    let api_message = (success
        && msg.terminal_reason.as_deref() == Some("api_error")
        && result_text.trim().starts_with("API Error:"))
    .then(|| crate::protocol::truncate(&redact(&result_text), 500));
    let structured = if success && msg.api_error_status == Some(529) {
        Some("Claude API is overloaded (529). Try again shortly.".to_string())
    } else if success && msg.api_error_status == Some(429) {
        Some("Claude API rate limit reached. Try again later.".to_string())
    } else {
        terminal_result_error(
            msg.terminal_reason.as_deref(),
            hint.or(api_message.as_deref()),
        )
    };
    if !success {
        let message = listed.or(structured).unwrap_or_else(|| {
            msg.errors
                .iter()
                .flatten()
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        });
        return Some(failure(class, &message, Some(&msg.subtype), None));
    }
    if !msg.is_error && structured.is_none() {
        return None;
    }
    let message = listed
        .or(structured)
        .or(hint.map(str::to_string))
        .unwrap_or(result_text);
    let code = match msg.api_error_status {
        Some(status) => format!("api_error_{status}"),
        None => msg
            .terminal_reason
            .clone()
            .unwrap_or_else(|| "sdk_result_error".into()),
    };
    let retryable = matches!(msg.api_error_status, Some(429 | 529)).then_some(true);
    Some(failure(class, &message, Some(&code), retryable))
}

/// `makeProviderFailure`.
pub(crate) fn failure(
    class: &str,
    message: &str,
    code: Option<&str>,
    retryable: Option<bool>,
) -> Value {
    let message = redact(message.trim());
    let message = if message.is_empty() {
        "Provider turn failed.".to_string()
    } else {
        crate::protocol::truncate(&message, 4096)
    };
    json!({
        "class": class,
        "message": message,
        "code": code.map(|c| crate::protocol::truncate(c, 128)),
        "retryable": retryable,
    })
}

/// A subset of `makeProviderFailure`'s redaction: bearer and basic credentials, `sk-` keys,
/// and control characters.
fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut words = text.split(' ').peekable();
    let mut first = true;
    while let Some(word) = words.next() {
        if !first {
            out.push(' ');
        }
        first = false;
        if (word == "Bearer" || word == "Basic") && words.peek().is_some() {
            out.push_str(word);
            out.push_str(" [REDACTED]");
            words.next();
            continue;
        }
        if let Some(start) = word.find("sk-")
            && word.len() - start >= 19
        {
            out.push_str(&word[..start]);
            out.push_str("[REDACTED]");
            continue;
        }
        out.push_str(word);
    }
    out.chars()
        .map(|c| if c.is_control() && c != '\n' { ' ' } else { c })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_tools_build_a_list() {
        let created = apply_task_tool(
            &[],
            "TaskCreate",
            &json!({"subject": "alpha"}),
            &json!({"task": {"id": "1", "subject": "alpha"}}),
        )
        .unwrap();
        assert_eq!(
            created,
            vec![("1".into(), "alpha".into(), "pending".into())]
        );
        let updated = apply_task_tool(
            &created,
            "TaskUpdate",
            &json!({"taskId": "1", "status": "completed"}),
            &json!({"success": true}),
        )
        .unwrap();
        assert_eq!(updated[0].2, "completed");
        assert!(
            apply_task_tool(&updated, "TaskUpdate", &json!({"taskId": "9"}), &json!({})).is_none()
        );
    }

    #[test]
    fn usage_limit_notice_names_the_window_and_wait() {
        let text = usage_limit_notice("five_hour", Some(3_900.0), 0);
        assert_eq!(
            text,
            "Claude usage limit reached. This turn is paused until the 5-hour limit resets in 1h 5m."
        );
    }

    #[test]
    fn redaction_hides_credentials() {
        assert_eq!(redact("Bearer abc def"), "Bearer [REDACTED] def");
        assert_eq!(redact("key sk-ant-0123456789abcdefgh"), "key [REDACTED]");
    }
}
