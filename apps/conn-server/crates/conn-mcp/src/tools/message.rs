//! `send_to_user`: text the agent shows the user mid-turn (`toolkits/message`).
//!
//! The server stores nothing. The tool's result carries the text as `sentMessage`; the
//! provider records the call as a `dynamic_tool` turn item, and clients render that item's
//! `sentMessage` as the agent's own words (`sentMessageFromToolItem` in `@t3tools/shared`).

use serde_json::json;

use super::{Args, Cx, ToolResult, str_arg};

/// `actsAsCaller`: a thread caller only, and a live one.
pub(super) async fn send_to_user(cx: &Cx<'_>, args: &Args) -> ToolResult {
    // The catalog's argument check holds the schema's limits: 1 to 4,000 UTF-16 units
    // (`SEND_TO_USER_MAX_LENGTH`).
    let message = str_arg(args, "message").unwrap_or_default();
    cx.require_thread("This tool")?;
    cx.writing_caller().await?;
    Ok(json!({
        "sentMessage": message,
        "message": "Shown to the user. Don't repeat it.",
    }))
}
