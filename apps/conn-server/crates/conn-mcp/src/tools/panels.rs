//! Thread-scoped panel display on connected desktops; browser tab automation needs preview.

use super::{Args, Cx, ToolError, ToolResult, bool_arg, fail, str_arg};
use conn_contract::from_json;
use serde_json::{Value, json};
use std::time::Duration;

pub(super) async fn open(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let mut decoded = args.clone();
    super::trim_non_blank(&mut decoded, &["url", "tabId", "profileId"])?;
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
            .any(|key| str_arg(args, key).is_some())
    {
        return Err(invalid(
            "url, tabId and profileId apply to the browser panel only.",
        ));
    }
    if panel != "database" && args.contains_key("sql") {
        return Err(invalid("sql applies to the database panel only."));
    }
    if str_arg(args, "url").is_some() && str_arg(args, "tabId").is_some() {
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
    let mut request = json!({"requestId":"pending", "threadId":caller.thread_id, "panel":panel, "focusWindow":bool_arg(args,"focusWindow").unwrap_or(true)});
    if let Some(sql) = args.get("sql")
        && let Some(fields) = request.as_object_mut()
    {
        fields.insert("sql".into(), sql.clone());
    }
    let shown = broker
        .show(
            from_json(request).map_err(super::internal)?,
            Duration::from_secs(15),
        )
        .await
        .map_err(|e| ToolError::Message(e.message))?;
    Ok(json!({"panel":panel,"shownOn":shown.device_name.unwrap_or_else(|| "Conn desktop".into())}))
}

const PANEL_ACTION_TIMEOUT: Duration = Duration::from_secs(90);

pub(super) async fn invoke(cx: &Cx<'_>, name: &str, args: &Args) -> ToolResult {
    let caller = cx.require_thread(name)?;
    cx.writing_caller().await?;
    let mut request = json!({"requestId":"pending","threadId":caller.thread_id,"panel":"mcp","focusWindow":args.get("focusWindow").cloned().unwrap_or(Value::Bool(true))});
    let result_key = if name == "mcp_connect" {
        if args.contains_key("url") == args.contains_key("command") {
            return Err(ToolError::Message("Pass url or command, not both.".into()));
        }
        if args.contains_key("command")
            && (args.contains_key("headers") || args.contains_key("transport"))
        {
            return Err(ToolError::Message(
                "headers and transport apply to url servers only.".into(),
            ));
        }
        if args.contains_key("url") && args.contains_key("env") {
            return Err(ToolError::Message(
                "env applies to command servers only.".into(),
            ));
        }
        let mut server = args.clone();
        server.remove("focusWindow");
        request["mcpServer"] = json!(server);
        "mcp"
    } else {
        let mut call = json!({"tool":args.get("tool"),"arguments":args.get("arguments").cloned().unwrap_or_else(||json!({}))});
        if let Some(server) = args.get("server") {
            call["server"] = server.clone();
        }
        request["mcpCall"] = call;
        "mcpCall"
    };
    let broker = cx
        .config()
        .panels
        .as_ref()
        .ok_or_else(|| fail("capability_denied", "Panel requests are not supported."))?;
    let response = broker
        .show(
            from_json(request).map_err(super::internal)?,
            PANEL_ACTION_TIMEOUT,
        )
        .await
        .map_err(|e| ToolError::Message(e.message))?;
    let response = conn_contract::to_json(&response);
    let mut result = response.get(result_key).filter(|v|v.is_object()).cloned().ok_or_else(|| ToolError::Message("The Conn desktop showed the MCP panel but sent no result. It may run an older Conn.".into()))?;
    result["shownOn"] = response
        .get("deviceName")
        .cloned()
        .unwrap_or_else(|| json!("Conn desktop"));
    Ok(result)
}
