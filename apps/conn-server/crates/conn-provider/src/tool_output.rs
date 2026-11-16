//! Shared T3 tool-name resolution and bounded result metadata (`packages/shared/src/toolOutput.ts`).
use serde_json::{Map, Value, json};

include!("tool-output-constants.rs");
// packages/shared/src/toolOutput.ts:25-31 (private constants).
const MAX_PARSED_BYTES: usize = 16_384;
const MAX_METADATA_BYTES: usize = 8_192;
const MAX_ID_LENGTH: usize = 256;
const MAX_THREADS: usize = 100;
const MAX_CONTENT_BLOCKS: usize = 32;
const MAX_ENVELOPE_DEPTH: usize = 4;
const MAX_ENVELOPE_NODES: usize = 128;
// packages/shared/src/mcpApp.ts:16-19 (private constants).
const MAX_DOMAINS: usize = 32;
const MAX_RESOURCE_URI_LENGTH: usize = 4096;

pub fn resolve_t3_mcp_tool_id(name: &str) -> Option<&str> {
    let name = js_trim(name);
    let name = name
        .rsplit_once(js_whitespace)
        .filter(|(_, suffix)| {
            suffix.eq_ignore_ascii_case("complete") || suffix.eq_ignore_ascii_case("completed")
        })
        .map_or(name, |(head, _)| head.trim_end_matches(js_whitespace));
    let known = |name: &str| TOOL_NAMES.contains(&name);
    let lower = name.to_ascii_lowercase();
    if let Some(rest) = name.get(5..).filter(|_| lower.starts_with("mcp__"))
        && let Some((server, tool)) = rest.split_once("__")
    {
        return [
            "t3-code",
            "t3_code",
            "t3code",
            "t3-code-direct",
            "t3_code_direct",
        ]
        .contains(&server.to_ascii_lowercase().as_str())
        .then_some(tool)
        .filter(|tool| known(tool));
    }
    for prefix in [
        "t3-code-direct",
        "t3_code_direct",
        "t3_code-direct",
        "t3-code_direct",
        "t3-code",
        "t3_code",
        "t3code",
    ] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let suffix = name.get(name.len() - rest.len()..).unwrap_or_default();
            let tool = suffix.strip_prefix(['.', ':', '/']).or_else(|| {
                suffix
                    .split_once('·')
                    .filter(|(before, _)| js_trim(before).is_empty())
                    .map(|(_, after)| after.trim_start_matches(js_whitespace))
            });
            if let Some(tool) = tool {
                return known(tool).then_some(tool);
            }
        }
    }
    let rest = lower
        .strip_prefix("mcp")
        .and_then(|s| {
            let count = s
                .bytes()
                .take(2)
                .take_while(|c| matches!(c, b'-' | b'_'))
                .count();
            (count > 0).then(|| s.get(count..)).flatten()
        })
        .unwrap_or(&lower);
    for prefix in ["t3-code", "t3_code", "t3 code", "t3code"] {
        if let Some(suffix) = rest.strip_prefix(prefix) {
            let original = name.get(name.len() - suffix.len()..).unwrap_or_default();
            let tool = original
                .strip_prefix("__")
                .or_else(|| original.strip_prefix(['-', '_', '.', ':', '/', ' ']));
            if let Some(tool) = tool.filter(|tool| known(tool)) {
                return Some(tool);
            }
        }
    }
    if known(name) {
        return Some(name);
    }
    if !lower.starts_with("t3-code-") {
        return None;
    }
    TOOL_NAMES
        .iter()
        .copied()
        .filter(|tool| {
            name.strip_suffix(tool)
                .is_some_and(|prefix| prefix.ends_with('_'))
        })
        .max_by_key(|tool| tool.len())
        .and_then(|tool| name.get(name.len() - tool.len()..))
}

#[derive(Default)]
struct Budget {
    bytes: usize,
    nodes: usize,
    exceeded: bool,
}

struct Envelope {
    data: Option<Map<String, Value>>,
    failed: bool,
}

fn read(value: &Value, budget: &mut Budget, depth: usize) -> Envelope {
    let empty = || Envelope {
        data: None,
        failed: false,
    };
    if depth > MAX_ENVELOPE_DEPTH || budget.nodes >= MAX_ENVELOPE_NODES {
        budget.exceeded = true;
        return empty();
    }
    budget.nodes += 1;
    match value {
        Value::String(text) => {
            budget.bytes = budget.bytes.saturating_add(text.len());
            if budget.bytes > MAX_PARSED_BYTES {
                budget.exceeded = true;
                return empty();
            }
            serde_json::from_str(text)
                .ok()
                .map_or_else(empty, |value| read(&value, budget, depth + 1))
        }
        Value::Array(blocks) => {
            if blocks.len() > MAX_CONTENT_BLOCKS {
                budget.exceeded = true;
                return empty();
            }
            let mut result = empty();
            for block in blocks {
                let text = block.get("text").unwrap_or(&Value::Null);
                let next = read(text.get("text").unwrap_or(text), budget, depth + 1);
                result.data = result.data.or(next.data);
                result.failed |= next.failed;
                if budget.exceeded {
                    break;
                }
            }
            result
        }
        Value::Object(object) => {
            let failed = object.get("isError") == Some(&Value::Bool(true))
                || object.get("is_error") == Some(&Value::Bool(true))
                || object.get("_tag").and_then(Value::as_str) == Some("OrchestratorMcpFailure")
                || object.get("error").is_some_and(|value| !value.is_null());
            let content = object
                .get("structuredContent")
                .filter(|v| !v.is_null())
                .or_else(|| object.get("content"));
            if let Some(content) = content {
                let next = read(content, budget, depth + 1);
                Envelope {
                    data: next.data,
                    failed: failed || next.failed,
                }
            } else {
                Envelope {
                    data: Some(compact_metadata(value)),
                    failed,
                }
            }
        }
        _ => empty(),
    }
}

fn bounded_id(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|s| s.encode_utf16().count() <= MAX_ID_LENGTH && !js_trim(s).is_empty())
}
fn js_whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}
fn js_trim(s: &str) -> &str {
    s.trim_matches(js_whitespace)
}
fn js_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

fn compact_metadata(data: &Value) -> Map<String, Value> {
    let mut output = Map::new();
    for key in ["threadId", "messageId", "taskId", "scheduledTaskId"] {
        if let Some(id) = data.get(key).and_then(bounded_id) {
            output.insert(key.into(), json!(id));
        }
    }
    if data.get("status").and_then(Value::as_str) == Some("rolled_back") {
        output.insert("status".into(), json!("rolled_back"));
    }
    for key in ["linkedCount", "unlinkedCount"] {
        if let Some(n) = data
            .get(key)
            .and_then(Value::as_f64)
            .filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
        {
            output.insert(key.into(), json!(n as i64));
        }
    }
    if let Some(s) = data
        .get("sentMessage")
        .and_then(Value::as_str)
        .filter(|s| !js_trim(s).is_empty() && s.encode_utf16().count() <= SEND_TO_USER_MAX_LENGTH)
    {
        output.insert("sentMessage".into(), json!(s));
    }
    if let Some(reference) = data.get("htmlRender").and_then(read_html_render_reference) {
        output.insert("htmlRender".into(), reference);
    }
    if let Some(app) = data
        .get(MCP_APP_OUTPUT_KEY)
        .and_then(read_mcp_app_reference)
    {
        output.insert(MCP_APP_OUTPUT_KEY.into(), app);
    }
    if let Some(id) = data.pointer("/thread/threadId").and_then(bounded_id) {
        output.insert("thread".into(), json!({"threadId": id}));
    }
    if let Some(threads) = data.get("threads").and_then(Value::as_array) {
        let batch: Option<Vec<_>> = (threads.len() <= MAX_THREADS)
            .then(|| {
                threads
                    .iter()
                    .map(|entry| {
                        entry.as_object()?;
                        let mut thread = Map::new();
                        if let Some(id) = entry.get("threadId").and_then(bounded_id) {
                            thread.insert("threadId".into(), json!(id));
                        }
                        if entry.get("status").and_then(Value::as_str) == Some("rolled_back") {
                            thread.insert("status".into(), json!("rolled_back"));
                        }
                        (!thread.is_empty()).then_some(Value::Object(thread))
                    })
                    .collect()
            })
            .flatten();
        if let Some(batch) = batch {
            output.insert("threads".into(), json!(batch));
        } else {
            output.remove("threadId");
            output.remove("status");
        }
    }
    output
}

pub fn compact_dynamic_tool_output(value: &Value) -> Option<Map<String, Value>> {
    let mut budget = Budget::default();
    let result = read(value, &mut budget, 0);
    let mut output = if budget.exceeded {
        Map::new()
    } else {
        result.data.unwrap_or_default()
    };
    if result.failed {
        output.insert("isError".into(), json!(true));
    }
    let oversized = |output: &Map<String, Value>| {
        serde_json::to_vec(output).map_or(true, |bytes| bytes.len() > MAX_METADATA_BYTES)
    };
    if oversized(&output) {
        for key in ["threads", "threadId", "status"] {
            output.remove(key);
        }
    }
    if oversized(&output)
        && let Some(app) = output
            .get_mut(MCP_APP_OUTPUT_KEY)
            .and_then(Value::as_object_mut)
    {
        app.remove("csp");
    }
    if oversized(&output) {
        output.remove(MCP_APP_OUTPUT_KEY);
    }
    (!output.is_empty()).then_some(output)
}

fn read_html_render_reference(value: &Value) -> Option<Value> {
    let id = value.get("attachmentId")?.as_str()?;
    if id.is_empty() || id.encode_utf16().count() > MAX_ID_LENGTH {
        return None;
    }
    let title = value.get("title")?.as_str()?;
    let title = String::from_utf16_lossy(
        &js_trim(title)
            .encode_utf16()
            .take(HTML_RENDER_MAX_TITLE_LENGTH)
            .collect::<Vec<_>>(),
    );
    let height = value
        .get("height")?
        .as_f64()?
        .clamp(HTML_RENDER_MIN_HEIGHT as f64, HTML_RENDER_MAX_HEIGHT as f64);
    let mut reference = json!({"attachmentId":id,"title":if title.is_empty() {"HTML"} else {&title},"height":js_number(height)});
    if let Some(entries) = value
        .get("heights")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty() && v.len() <= MAX_MEASURED_HEIGHTS)
    {
        let heights: Option<Vec<_>> = entries
            .iter()
            .map(|entry| {
                let pair = entry.as_array().filter(|p| p.len() == 2)?;
                let width = pair
                    .first()?
                    .as_f64()
                    .filter(|w| w.fract() == 0.0 && (1.0..=10_000.0).contains(w))?;
                let height = pair
                    .get(1)?
                    .as_f64()?
                    .clamp(HTML_RENDER_MIN_HEIGHT as f64, HTML_RENDER_MAX_HEIGHT as f64);
                Some((width as i64, js_number(height)))
            })
            .collect();
        if let Some(mut heights) = heights {
            heights.sort_by_key(|(width, _)| *width);
            reference["heights"] = json!(heights);
        }
    }
    Some(reference)
}

fn read_mcp_app_reference(value: &Value) -> Option<Value> {
    let attachment = value.get("attachmentId").and_then(bounded_id)?;
    let server = value.get("server").and_then(bounded_id)?;
    let tool = value.get("tool").and_then(bounded_id)?;
    let uri = value.get("resourceUri")?.as_str().filter(|s| {
        s.encode_utf16().count() <= MAX_RESOURCE_URI_LENGTH && s.starts_with("ui://")
    })?;
    let mut app = json!({"attachmentId":attachment,"server":server,"tool":tool,"resourceUri":uri});
    let mut csp = Map::new();
    for key in [
        "connectDomains",
        "resourceDomains",
        "frameDomains",
        "baseUriDomains",
    ] {
        if let Some(domains) = value
            .get("csp")
            .and_then(|v| v.get(key))
            .and_then(Value::as_array)
        {
            let domains: Vec<_> = domains
                .iter()
                .filter_map(Value::as_str)
                .filter(|s| valid_domain(s))
                .take(MAX_DOMAINS)
                .collect();
            if !domains.is_empty() {
                csp.insert(key.into(), json!(domains));
            }
        }
    }
    if !csp.is_empty() {
        app["csp"] = json!(csp);
    }
    let mut permissions = Map::new();
    for key in ["camera", "microphone", "geolocation", "clipboardWrite"] {
        if value
            .get("permissions")
            .and_then(|v| v.get(key))
            .is_some_and(Value::is_object)
        {
            permissions.insert(key.into(), json!({}));
        }
    }
    if !permissions.is_empty() {
        app["permissions"] = json!(permissions);
    }
    if let Some(border) = value.get("prefersBorder").and_then(Value::as_bool) {
        app["prefersBorder"] = json!(border);
    }
    Some(app)
}
fn valid_domain(domain: &str) -> bool {
    if domain.len() > MAX_ID_LENGTH {
        return false;
    }
    let Some((scheme, host)) = domain.split_once("://") else {
        return false;
    };
    if !["http", "https", "ws", "wss"].contains(&scheme.to_ascii_lowercase().as_str()) {
        return false;
    }
    let host = match host.rsplit_once(':') {
        Some((host, port))
            if !port.is_empty() && port.len() <= 5 && port.bytes().all(|c| c.is_ascii_digit()) =>
        {
            host
        }
        Some(_) => return false,
        None => host,
    };
    host.strip_prefix("*.")
        .unwrap_or(host)
        .split('.')
        .all(|part| {
            !part.is_empty() && part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
}

pub fn html_render_from_tool_item(item: &Value) -> Option<Value> {
    let name = item.get("toolName")?.as_str()?;
    if name != "execute" && resolve_t3_mcp_tool_id(name) != Some("html_render") {
        return None;
    }
    let mut output = compact_dynamic_tool_output(item.get("output")?)?;
    if output.get("isError") == Some(&Value::Bool(true)) {
        return None;
    }
    output.remove("htmlRender")
}

pub fn mcp_app_from_tool_item(item: &Value) -> Option<Value> {
    let mut output = compact_dynamic_tool_output(item.get("output")?)?;
    let app = output.remove(MCP_APP_OUTPUT_KEY)?;
    let server = app.get("server")?.as_str()?;
    let tool = app.get("tool")?.as_str()?;
    let name = item.get("toolName")?.as_str()?;
    (name == format!("{server}.{tool}") || name == crate::mcp_apps::claude_name(server, tool))
        .then_some(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_metadata_and_preserves_failures_across_envelopes() {
        let metadata = json!({"threadId":"thread-1", "messageId":"message-1"});
        for output in [
            metadata.clone(),
            json!({"structuredContent":metadata, "content":"private"}),
            json!([{ "text":metadata.to_string() }]),
        ] {
            assert_eq!(
                compact_dynamic_tool_output(&output),
                metadata.as_object().cloned()
            );
        }
        let failed = json!([{ "text":metadata.to_string() }, { "text":"{\"isError\":true}" }]);
        assert_eq!(
            json!(compact_dynamic_tool_output(&failed)),
            json!({"threadId":"thread-1", "messageId":"message-1", "isError":true})
        );
        assert!(
            compact_dynamic_tool_output(&json!([{ "text":"{}" }, { "text":metadata.to_string() }]))
                .is_none()
        );
    }

    #[test]
    fn html_references_use_the_shared_resolver_and_normalizer() {
        let output = json!({"htmlRender":{"attachmentId":"page", "title":" Page ", "height":1}});
        for name in [
            "mcp__t3-code__html_render",
            "t3-code-thread_1_html_render",
            "execute",
        ] {
            assert_eq!(
                html_render_from_tool_item(&json!({"toolName":name,"output":output})),
                Some(
                    json!({"attachmentId":"page", "title":"Page", "height":HTML_RENDER_MIN_HEIGHT})
                )
            );
        }
        assert!(
            html_render_from_tool_item(&json!({"toolName":"html_preview","output":output}))
                .is_none()
        );
        assert_eq!(
            resolve_t3_mcp_tool_id("t3-code-thread_opencode2-adapter_delegate_task"),
            Some("delegate_task")
        );
        assert_eq!(
            resolve_t3_mcp_tool_id("mcp__another-server__delegate_task"),
            None
        );
    }
}
