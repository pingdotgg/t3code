//! MCP App source identity and the provider requests shared by the engine and adapters.

use conn_contract::ProviderThread;
use serde_json::{Value, json};

#[derive(Clone, Debug)]
pub enum Operation {
    ListTools,
    CallTool { tool: String, arguments: Value },
    ReadResource { uri: String },
}

#[derive(Clone, Debug)]
pub struct Request {
    pub provider_thread: ProviderThread,
    pub server: String,
    pub operation: Operation,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Source {
    pub server: String,
    pub tool: String,
    pub resource_uri: String,
}

pub fn callable(meta: &Value) -> bool {
    meta.pointer("/ui/visibility")
        .and_then(Value::as_array)
        .is_none_or(|v| v.iter().any(|v| v == "app"))
}

pub fn resource_uri(meta: &Value) -> Option<&str> {
    meta.pointer("/ui/resourceUri")
        .or_else(|| meta.get("ui/resourceUri"))
        .and_then(Value::as_str)
        .filter(|uri| uri.starts_with("ui://") && uri.encode_utf16().count() <= 4096)
}

pub fn claude_name_part(name: &str) -> String {
    name.encode_utf16()
        .map(|unit| {
            char::from_u32(u32::from(unit))
                .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
                .unwrap_or('_')
        })
        .collect()
}

pub fn claude_prefix(server: &str) -> String {
    let name = claude_name_part(server);
    let name = if server.starts_with("claude.ai ") {
        name.split('_')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("_")
    } else {
        name
    };
    format!("mcp__{name}__")
}

pub fn claude_name(server: &str, tool: &str) -> String {
    format!("{}{}", claude_prefix(server), claude_name_part(tool))
}

pub fn output_app_reference(output: &Value) -> Option<Value> {
    crate::tool_output::compact_dynamic_tool_output(output)?
        .remove(crate::tool_output::MCP_APP_OUTPUT_KEY)
}

pub fn app_reference(item: &Value) -> Option<Value> {
    if item.get("type")?.as_str()? != "dynamic_tool" {
        return None;
    }
    crate::tool_output::mcp_app_from_tool_item(item)
}

pub fn rules_cover(rules: &Value, behaviors: &[&str]) -> bool {
    rules.as_array().into_iter().flatten().any(|entry| {
        let name = entry
            .get("rule")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .split('(')
            .next()
            .unwrap_or_default();
        entry
            .get("behavior")
            .and_then(Value::as_str)
            .is_some_and(|b| behaviors.contains(&b))
            && entry.get("notInEffect") != Some(&Value::Bool(true))
            && (name.starts_with("mcp__") || name.contains('*'))
    })
}

pub fn claude_tool(tool: &Value, rules: Option<&Value>) -> Value {
    let mut result =
        json!({"name":tool.get("name"),"inputSchema":{"type":"object"},"annotations":{}});
    for key in ["description", "_meta"] {
        if let Some(value) = tool.get(key) {
            result[key] = value.clone();
        }
    }
    for (native, hint) in [
        ("readOnly", "readOnlyHint"),
        ("destructive", "destructiveHint"),
        ("openWorld", "openWorldHint"),
    ] {
        if let Some(value) = tool.get("annotations").and_then(|a| a.get(native)) {
            if native == "readOnly"
                && value == true
                && rules.is_none_or(|r| rules_cover(r, &["ask", "deny"]))
            {
                continue;
            }
            result["annotations"][hint] = value.clone();
        }
    }
    result
}

pub fn call_result(value: &Value) -> Value {
    let content = if value.is_object() {
        value.get("content").unwrap_or(&Value::Null)
    } else {
        value
    };
    let mut result = json!({"content":match content { Value::String(text) => json!([{"type":"text","text":text}]), Value::Array(_) => content.clone(), _ => json!([]) }});
    for key in ["structuredContent", "_meta"] {
        if let Some(v) = value.get(key) {
            result[key] = v.clone();
        }
    }
    if value.get("isError") == Some(&Value::Bool(true)) {
        result["isError"] = json!(true);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn app_sources_must_match_the_producing_tool() {
        let reference = json!({"attachmentId":"file-html", "server":"weather", "tool":"get.weather", "resourceUri":"ui://weather"});
        let mut item = json!({"type":"dynamic_tool", "toolName":"weather.get.weather", "output":{"t3McpApp":reference}});
        assert!(app_reference(&item).is_some());
        item["toolName"] = json!("mcp__weather__get_weather");
        assert!(app_reference(&item).is_some());
        item["toolName"] = json!("other.tool");
        assert!(app_reference(&item).is_none());
        item["toolName"] = json!("weather.get.weather");
        item["output"]["t3McpApp"]["resourceUri"] = json!("https://example.com");
        assert!(app_reference(&item).is_none());
    }

    #[test]
    fn app_references_follow_bounded_mcp_envelopes_even_on_failed_items() {
        let app = json!({"attachmentId":"forged-html","server":"weather","tool":"show","resourceUri":"ui://weather"});
        for output in [
            json!({"structuredContent":{"t3McpApp":app}}),
            json!({"content":[{"type":"text","text":json!({"t3McpApp":app}).to_string()}]}),
            json!({"isError":true,"structuredContent":{"t3McpApp":app}}),
        ] {
            let item = json!({"type":"dynamic_tool","toolName":"mcp__weather__show","status":"failed","output":output});
            assert_eq!(app_reference(&item), Some(app.clone()), "{item}");
        }
        let mut untrusted = app.clone();
        untrusted["private"] = json!("discard");
        untrusted["csp"] =
            json!({"connectDomains":["*", "https://example.com", "https://bad/path"]});
        untrusted["permissions"] = json!({"camera":true, "microphone":{}});
        let mut normalized = app.clone();
        normalized["csp"] = json!({"connectDomains":["https://example.com"]});
        normalized["permissions"] = json!({"microphone":{}});
        for output in [
            json!({"t3McpApp":untrusted}),
            json!({"isError":true,"content":[{"text":json!({"t3McpApp":untrusted}).to_string()}]}),
        ] {
            assert_eq!(output_app_reference(&output), Some(normalized.clone()));
            assert_eq!(
                app_reference(
                    &json!({"type":"dynamic_tool","toolName":"weather.show","output":output})
                ),
                Some(normalized.clone())
            );
        }
        let item = json!({"type":"dynamic_tool","toolName":"mcp__weather__show","output":{"content":[{"text":"x".repeat(16385)},{"text":json!({"t3McpApp":app}).to_string()}]}});
        assert_eq!(
            app_reference(&item),
            None,
            "an exhausted parse budget rejects the entire envelope"
        );
    }

    #[test]
    fn app_visibility_and_claude_rules_fail_closed() {
        assert!(callable(&json!({})));
        assert!(callable(&json!({"ui":{"visibility":["app"]}})));
        assert!(!callable(&json!({"ui":{"visibility":["model"]}})));
        assert!(rules_cover(
            &json!([{"behavior":"deny","rule":"mcp__alias(*)"}]),
            &["deny"]
        ));
        assert!(!rules_cover(
            &json!([{"behavior":"deny","rule":"mcp__alias(*)", "notInEffect":true}]),
            &["deny"]
        ));
        assert!(!rules_cover(
            &json!([{"behavior":"allow","rule":"*"}]),
            &["deny"]
        ));
    }

    #[test]
    fn claude_normalizes_annotations_without_bypassing_ask_rules() {
        let tool = json!({"name":"refresh", "annotations":{"readOnly":true,"destructive":false},"_meta":{"ui":{"visibility":["app"]}}});
        assert_eq!(
            claude_tool(&tool, Some(&json!([])))["annotations"]["readOnlyHint"],
            true
        );
        assert!(
            claude_tool(&tool, None)["annotations"]
                .get("readOnlyHint")
                .is_none()
        );
        let rules = json!([{"behavior":"ask", "rule":"mcp__any__tool"}]);
        assert!(
            claude_tool(&tool, Some(&rules))["annotations"]
                .get("readOnlyHint")
                .is_none()
        );
        assert_eq!(
            claude_tool(&tool, None)["inputSchema"],
            json!({"type":"object"})
        );
    }
}
