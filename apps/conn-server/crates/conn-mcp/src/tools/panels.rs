//! Thread-scoped panel display on connected desktops; browser tab automation needs preview.

use super::{Args, Cx, ToolError, ToolResult, bool_arg, fail, str_arg};
use conn_contract::{AgentPanelKind, AgentPanelRequest};
use serde_json::json;
use std::time::Duration;

pub(super) async fn open(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let mut decoded = args.clone();
    for key in ["url", "tabId", "profileId"] {
        if let Some(serde_json::Value::String(value)) = decoded.get_mut(key) {
            *value = value.trim().to_owned();
            if value.is_empty() {
                return Err(ToolError::InvalidParams(format!(
                    "Expected a non-blank string\n  at [\"{key}\"]"
                )));
            }
        }
    }
    let args = &decoded;
    let caller = cx.require_thread("This tool")?;
    cx.writing_caller().await?;
    let broker = cx
        .config()
        .panels
        .as_ref()
        .ok_or_else(|| fail("capability_denied", "Panel requests are not supported."))?;
    let panel = str_arg(args, "panel").unwrap_or_default();
    let browser = panel == "browser";
    let invalid = |message: &str| ToolError::Message(message.to_owned());
    if !browser
        && ["url", "tabId", "profileId"]
            .iter()
            .any(|key| str_arg(args, key).is_some_and(|v| !v.is_empty()))
    {
        return Err(invalid(
            "url, tabId and profileId apply to the browser panel only.",
        ));
    }
    if panel != "database" && args.contains_key("sql") {
        return Err(invalid("sql applies to the database panel only."));
    }
    if str_arg(args, "url").is_some_and(|v| !v.is_empty())
        && str_arg(args, "tabId").is_some_and(|v| !v.is_empty())
    {
        return Err(invalid("Pass url or tabId, not both."));
    }
    if browser && !broker.has_desktop() {
        return Err(invalid(
            "No Conn desktop app is connected to this server, so nothing can show the browser. Ask the user to open Conn on their Mac.",
        ));
    }
    if browser && (args.contains_key("url") || args.contains_key("tabId")) {
        return Err(fail(
            "capability_denied",
            "This server does not support desktop browser tabs yet. Open the browser panel without url or tabId; browser automation needs the desktop preview relay.",
        ));
    }
    let panel_kind = match panel {
        "browser" => AgentPanelKind::Browser,
        "database" => AgentPanelKind::Database,
        "mcp" => AgentPanelKind::Mcp,
        "diff" => AgentPanelKind::Diff,
        "files" => AgentPanelKind::Files,
        _ => return Err(super::internal("Unknown panel kind")),
    };
    let request = AgentPanelRequest {
        request_id: "pending".into(),
        thread_id: caller.thread_id.clone(),
        panel: panel_kind,
        tab_id: None,
        sql: str_arg(args, "sql").map(str::to_owned),
        connection: None,
        run: None,
        mcp_server: None,
        mcp_call: None,
        focus_window: bool_arg(args, "focusWindow").unwrap_or(true),
    };
    let shown = broker
        .show(request, Duration::from_secs(15))
        .await
        .map_err(|e| ToolError::Message(e.message))?;
    Ok(json!({"panel":panel,"shownOn":shown.device_name.unwrap_or_else(|| "Conn desktop".into())}))
}

pub(super) async fn database_query(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let caller = cx.require_thread("This tool")?;
    cx.writing_caller().await?;
    let broker = cx
        .config()
        .panels
        .as_ref()
        .ok_or_else(|| fail("capability_denied", "Panel requests are not supported."))?;
    let request = AgentPanelRequest {
        request_id: "pending".into(),
        thread_id: caller.thread_id.clone(),
        panel: AgentPanelKind::Database,
        tab_id: None,
        sql: str_arg(args, "sql").map(str::to_owned),
        connection: str_arg(args, "connection").map(str::to_owned),
        run: Some(true),
        mcp_server: None,
        mcp_call: None,
        focus_window: bool_arg(args, "focusWindow").unwrap_or(true),
    };
    let shown = broker
        .show(request, Duration::from_secs(90))
        .await
        .map_err(|e| ToolError::Message(e.message))?;
    let database = shown.database.ok_or_else(||ToolError::Message("The Conn desktop showed the database panel but sent no result. It may run an older Conn.".into()))?;
    let mut result = conn_contract::to_json(&database);
    if let Some(fields) = result.as_object_mut() {
        fields.insert(
            "shownOn".into(),
            json!(shown.device_name.unwrap_or_else(|| "Conn desktop".into())),
        );
    }
    Ok(result)
}
