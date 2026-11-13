//! JSON text with the key order the T3 server writes.
//!
//! `serde_json` sorts object keys. The SDK writes our prompts, permission answers, MCP server
//! configs and `--settings` to the CLI in the order it receives them, so the helper must get
//! them in T3's insertion order to give the CLI the same bytes. Each known object shape has its
//! order here; other keys follow in sorted order.

use serde_json::Value;

/// T3's key order for an object with these keys.
fn preferred(keys: &[&String]) -> &'static [&'static str] {
    let has = |k: &str| keys.iter().any(|key| key.as_str() == k);
    if has("parent_tool_use_id") {
        // SDKUserMessage (`claudeUserMessage`)
        &["type", "message", "parent_tool_use_id", "priority", "uuid"]
    } else if has("behavior") {
        // PermissionResult; the SDK appends toolUseID.
        &[
            "behavior",
            "updatedInput",
            "updatedPermissions",
            "message",
            "interrupt",
            "decisionClassification",
            "result",
            "toolUseID",
        ]
    } else if has("role") {
        &["role", "content"]
    } else if has("media_type") {
        &["type", "media_type", "data"]
    } else if has("url") {
        // McpHttpServerConfig (`claudeMcpQueryOverrides`)
        &["type", "url", "headers", "timeout"]
    } else if has("showThinkingSummaries") || has("alwaysThinkingEnabled") || has("fastMode") {
        // makeClaudeQueryOptions' settings
        &[
            "alwaysThinkingEnabled",
            "fastMode",
            "ultracode",
            "autoCompactWindow",
            "env",
            "showThinkingSummaries",
        ]
    } else if has("action") {
        &["action", "content"]
    } else {
        &[
            "t", "s", "id", "type", "method", "name", "text", "source", "options",
        ]
    }
}

/// Serializes `value` with T3's key order.
pub fn to_string(value: &Value) -> String {
    let mut out = String::new();
    write(value, &mut out);
    out
}

fn write(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let keys: Vec<&String> = map.keys().collect();
            let order = preferred(&keys);
            let mut sorted: Vec<&String> = keys.clone();
            sorted.sort_by_key(|k| {
                (
                    order
                        .iter()
                        .position(|o| *o == k.as_str())
                        .unwrap_or(order.len()),
                    k.as_str(),
                )
            });
            out.push('{');
            for (i, key) in sorted.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String((*key).clone()).to_string());
                out.push(':');
                if let Some(v) = map.get(key.as_str()) {
                    write(v, out);
                }
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn user_messages_keep_t3_order() {
        let message = json!({
            "uuid": "u",
            "type": "user",
            "priority": "now",
            "parent_tool_use_id": null,
            "message": {"content": "hi", "role": "user"},
        });
        assert_eq!(
            to_string(&message),
            r#"{"type":"user","message":{"role":"user","content":"hi"},"parent_tool_use_id":null,"priority":"now","uuid":"u"}"#
        );
        let deny = json!({"toolUseID": "t", "message": "no", "behavior": "deny"});
        assert_eq!(
            to_string(&deny),
            r#"{"behavior":"deny","message":"no","toolUseID":"t"}"#
        );
    }
}
