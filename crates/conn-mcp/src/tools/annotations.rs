//! `annotations_list`, `annotations_claim`, `annotations_complete`, `annotations_release`:
//! `apps/server/src/mcp/toolkits/annotations/handlers.ts`. Annotations belong to the calling
//! thread's project. Every failure reaches the agent as its plain message, as Effect's
//! `McpServer` renders this toolkit's declared errors.

use conn_features::annotations::{AnnotationError, Annotations, is_annotation_id};
use serde_json::{Value, json};

use super::{Args, Cx, ToolError, ToolResult, bool_arg, str_arg};

fn store<'a>(cx: &'a Cx<'_>) -> Result<&'a Annotations, ToolError> {
    cx.config()
        .annotations
        .as_ref()
        .ok_or_else(|| ToolError::Message("Annotations are not available here.".into()))
}

fn tagged(error: AnnotationError) -> ToolError {
    ToolError::Message(error.to_string())
}

/// An access refusal, as plain text.
fn plain(error: ToolError) -> ToolError {
    match error {
        ToolError::Failure { message, .. } => ToolError::Message(message),
        other => other,
    }
}

/// `AnnotationId` decodes with its pattern before any access rule.
fn checked_id(args: &Args) -> Result<Option<String>, ToolError> {
    match str_arg(args, "id") {
        Some(id) if !is_annotation_id(id) => Err(ToolError::InvalidParams(
            "Expected a string matching the RegExp ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$\n  at [\"id\"]"
                .to_owned(),
        )),
        other => Ok(other.map(str::to_owned)),
    }
}

/// `callerProject`: the calling thread's project.
async fn caller_project(cx: &Cx<'_>) -> Result<String, ToolError> {
    let thread = cx.require_thread("Annotations").map_err(plain)?;
    match cx.projection(&thread.thread_id).await {
        Ok(projection) => Ok(projection["thread"]["projectId"]
            .as_str()
            .unwrap_or_default()
            .to_owned()),
        Err(_) => Err(ToolError::Message("The calling thread is gone.".into())),
    }
}

/// `actsAsCaller`: a thread caller with a live run.
async fn acting_caller(cx: &Cx<'_>) -> Result<(), ToolError> {
    cx.require_thread("This tool").map_err(plain)?;
    cx.writing_caller().await.map(|_| ()).map_err(plain)
}

/// `annotations_list` (`readsAsCaller`): todo and in progress, or all with `all`.
pub(super) async fn list(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.require_thread("This tool").map_err(plain)?;
    let project = caller_project(cx).await?;
    let mut list = store(cx)?.list(&project).await.map_err(tagged)?;
    if bool_arg(args, "all") != Some(true)
        && let Some(items) = list["annotations"].as_array_mut()
    {
        items.retain(|a| a["status"] != "done");
    }
    Ok(list)
}

/// `annotations_claim`: the oldest waiting one, or one by id, with its screenshot's path.
pub(super) async fn claim(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let id = checked_id(args)?;
    acting_caller(cx).await?;
    let project = caller_project(cx).await?;
    let store = store(cx)?;
    let Some(mut claimed) = store.claim(&project, id).await.map_err(tagged)? else {
        return Ok(json!({ "annotation": null }));
    };
    let claimed_id = claimed["id"].as_str().unwrap_or_default().to_owned();
    if let Some(path) = store
        .screenshot_path(&project, claimed_id)
        .await
        .map_err(tagged)?
    {
        claimed["screenshotPath"] = Value::String(path.to_string_lossy().into_owned());
    }
    Ok(json!({ "annotation": claimed }))
}

pub(super) async fn complete(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let id = checked_id(args)?.unwrap_or_default();
    acting_caller(cx).await?;
    let project = caller_project(cx).await?;
    let summary = str_arg(args, "summary").map(str::to_owned);
    let annotation = store(cx)?
        .complete(&project, id, summary)
        .await
        .map_err(tagged)?;
    Ok(json!({ "annotation": annotation }))
}

pub(super) async fn release(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let id = checked_id(args)?.unwrap_or_default();
    acting_caller(cx).await?;
    let project = caller_project(cx).await?;
    let summary = str_arg(args, "summary").map(str::to_owned);
    let question = bool_arg(args, "question") == Some(true);
    let annotation = store(cx)?
        .release(&project, id, summary, question)
        .await
        .map_err(tagged)?;
    Ok(json!({ "annotation": annotation }))
}
