//! Agent browser calls share the server's tab state; desktop-only endpoints stay unavailable.
use super::{Args, Cx, ToolError, ToolResult, fail, str_arg};
use serde_json::{Value, json};

pub(super) async fn call(cx: &Cx<'_>, name: &str, args: &Args) -> ToolResult {
    let caller = cx.require_thread("This tool")?;
    let read = matches!(
        name,
        "preview_status" | "t3_preview_list" | "preview_snapshot" | "preview_wait_for"
    );
    if !read {
        cx.writing_caller().await?;
    }
    cx.require_preview()?;
    let preview = cx.config().preview.as_ref().ok_or_else(|| {
        ToolError::Message("Preview automation is unavailable for this thread.".into())
    })?;
    if name == "t3_preview_close"
        && !preview
            .list(&caller.thread_id)
            .get("sessions")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items
                    .iter()
                    .any(|item| item.get("tabId").and_then(Value::as_str) == str_arg(args, "tabId"))
            })
    {
        return Ok(json!({}));
    }
    if name == "t3_preview_list" {
        let mut result = preview.list(&caller.thread_id);
        let cursor = args.get("cursor").and_then(Value::as_u64).unwrap_or(0) as usize;
        let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(20) as usize;
        let sessions = result
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        result["sessions"] = json!(sessions.iter().skip(cursor).take(limit).collect::<Vec<_>>());
        result["nextCursor"] = if cursor.saturating_add(limit) < sessions.len() {
            json!(cursor + limit)
        } else {
            Value::Null
        };
        return Ok(result);
    }
    let operation = match name {
        "preview_open" => "open",
        "preview_snapshot" => "snapshot",
        "preview_act" => str_arg(args, "action").unwrap_or_default(),
        "preview_wait_for" => "waitFor",
        "preview_recording_start" => "recordingStart",
        "preview_recording_stop" => "recordingStop",
        "preview_status" => "status",
        "preview_navigate" => "navigate",
        "preview_resize" => "resize",
        "preview_set_appearance" => "setColorScheme",
        "preview_evaluate" => "evaluate",
        "preview_dialog" => "dialog",
        "preview_cdp_endpoint" => "cdpEndpoint",
        "t3_preview_close" => "close",
        _ => {
            return Err(fail(
                "capability_denied",
                "The browser operation is not served.",
            ));
        }
    };
    let mut input = Value::Object(args.clone());
    if name == "preview_open" && input.get("target").is_some() {
        input.as_object_mut().map(|input| input.remove("url"));
    }
    let value = preview
        .invoke(
            &caller.thread_id,
            &caller.provider_session_id,
            operation,
            input,
        )
        .await
        .map_err(|error| preview_failure(error, operation, args))?;

    let mut value = if operation == "evaluate" {
        json!({"value":value})
    } else {
        value
    };
    if operation == "status" && value.get("tabs").is_none() {
        value["tabs"] = json!([]);
    }
    if operation == "snapshot" && args.get("save").and_then(Value::as_bool) == Some(true) {
        let data = value
            .pointer("/fullScreenshot/data")
            .or_else(|| value.pointer("/screenshot/data"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let url = value
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let path = preview
            .save_screenshot(&url, data)
            .await
            .map_err(|error| ToolError::Message(error.to_string()))?;
        value.as_object_mut().map(|o| o.remove("fullScreenshot"));
        value["screenshotPath"] = json!(path);
        if args.get("includeImage").and_then(Value::as_bool) != Some(true) {
            return Ok(json!({"url":url,"screenshotPath":path}));
        }
    }
    if !matches!(
        operation,
        "open" | "status" | "navigate" | "snapshot" | "dialog"
    ) {
        let status = preview.status(
            &caller.thread_id,
            &caller.provider_session_id,
            str_arg(args, "tabId"),
        );
        if let Some(url) = status.get("url").and_then(Value::as_str).filter(|url| {
            url.len() <= 4096 && (url.starts_with("http://") || url.starts_with("https://"))
        }) {
            value["toolIcon"] = json!({"_tag":"website","pageUrl":url});
        }
    }
    Ok(value)
}

fn preview_failure(error: conn_preview::Error, operation: &str, args: &Args) -> ToolError {
    let raw = error.to_string();
    let first = raw.lines().next().unwrap_or_default();
    let text = if first.contains("strict mode violation") {
        let api = if matches!(operation, "type" | "select") {
            "locator.evaluate"
        } else {
            "locator.scrollIntoViewIfNeeded"
        };
        format!("{api}: {first}")
    } else {
        first.to_owned()
    };
    let missing = matches!(
        text.as_str(),
        "No server preview tab is open for this thread. Call preview_open first."
            | "The requested server preview tab does not exist."
    );
    let interrupted = text.starts_with("Multiple browser tabs")
        || text.starts_with("Too many server browser tabs")
        || text.starts_with("A browser dialog is pending")
        || text.starts_with("A human controls")
        || text.starts_with("This tab belongs")
        || text.starts_with("This tab has no agent owner");
    let tag = if missing {
        "PreviewAutomationTabNotFoundError"
    } else if interrupted {
        "PreviewAutomationControlInterruptedError"
    } else if text.contains("timed out after") {
        "PreviewAutomationTimeoutError"
    } else if text.contains("__conn_stale_ref")
        || text.contains("while parsing selector")
        || text.contains("Unknown engine")
    {
        "PreviewAutomationInvalidSelectorError"
    } else if text.contains("__conn_not_editable") || text.contains("Element is not an <input>") {
        "PreviewAutomationTargetNotEditableError"
    } else {
        "PreviewAutomationExecutionError"
    };
    let target = if args.contains_key("locator") {
        "locator"
    } else if args.contains_key("selector") {
        "selector"
    } else {
        "focused-element"
    };
    let count = str_arg(args, target)
        .unwrap_or_default()
        .encode_utf16()
        .count();
    let message = if missing {
        str_arg(args, "tabId").map_or_else(
            || format!("No active preview tab was found for {operation}. Call preview_open first."),
            |id| format!("Preview tab {id} was not found for {operation}. Omit tabId to use the current tab, or call preview_open."),
        )
    } else if tag == "PreviewAutomationInvalidSelectorError" {
        let kind = if text.contains("__conn_stale_ref") {
            "stale"
        } else if target == "locator" {
            "invalid.locator"
        } else {
            "invalid.selector"
        };
        conn_preview::tool_error(kind, operation, count)
    } else if tag == "PreviewAutomationTargetNotEditableError" {
        conn_preview::tool_error(&format!("editable.{target}"), operation, count)
    } else if text.starts_with("This tab belongs") {
        "This browser tab belongs to another agent session or a human. Open your own tab.".into()
    } else if interrupted || text.starts_with("Preview automation ") {
        text
    } else {
        format!("Preview automation {operation} failed: {text}")
    };
    ToolError::Preview { tag, message }
}
