//! Finished HTML publication for the caller's thread; no browser capability is needed.
use serde_json::json;

use super::{Args, Cx, ToolResult, fail, str_arg};

pub(super) async fn render(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let caller = cx.require_thread("This tool")?;
    let limits = cx.writing_caller().await?;
    let html = str_arg(args, "html");
    let path = str_arg(args, "path");
    if html.is_some() == path.is_some() {
        return Err(fail("invalid_request", "Pass exactly one of html or path."));
    }
    if path.is_some() && limits.runtime_mode != "full-access" {
        return Err(fail(
            "capability_denied",
            "Pass html instead of path: only full-access threads may pass a path.",
        ));
    }
    let files = cx
        .config()
        .files
        .clone()
        .ok_or_else(|| fail("orchestration_error", "The HTML render could not be saved."))?;
    let html = html.map(str::to_owned);
    let path = path.map(str::to_owned);
    let title = str_arg(args, "title").unwrap_or_default().to_owned();
    let height = args
        .get("height")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or_default() as i64;
    let thread_id = caller.thread_id.clone();
    let reference = tokio::task::spawn_blocking(move || {
        let source = match (html, path) {
            (Some(html), _) => html,
            (_, Some(path)) => conn_files::html::read_source(&files, &path)?,
            _ => String::new(),
        };
        conn_files::html::publish(&files, &thread_id, &source, &title, height)
    })
    .await
    .map_err(|_| fail("orchestration_error", "The HTML render could not be saved."))?
    .map_err(|error| {
        let message = error.to_string();
        let code = if matches!(error, conn_files::html::HtmlError::Store) {
            "orchestration_error"
        } else {
            "invalid_request"
        };
        fail(code, message)
    })?;
    Ok(json!({
        "htmlRender": reference,
        "message": "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.",
    }))
}
