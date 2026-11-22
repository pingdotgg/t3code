//! How the panel reads a call's result (the pure parts of Conn's `McpCatalogViews.tsx`).

use serde_json::Value;

/// The text pretty-printed when it is a JSON object or array, else `None`.
pub fn pretty_json(text: &str) -> Option<String> {
    if !text.trim_start().starts_with(['{', '[']) {
        return None;
    }
    let value: Value = serde_json::from_str(text).ok()?;
    serde_json::to_string_pretty(&value).ok()
}

/// The blocks a result lists: content, a resource's contents, or prompt messages' content.
pub fn result_blocks(result: &Value) -> Vec<Value> {
    if let Some(Value::Array(content)) = result.get("content") {
        return content.clone();
    }
    if let Some(Value::Array(contents)) = result.get("contents") {
        return contents.clone();
    }
    if let Some(Value::Array(messages)) = result.get("messages") {
        return messages
            .iter()
            .map(|message| message.get("content").cloned().unwrap_or(Value::Null))
            .collect();
    }
    Vec::new()
}

/// A block's text, or its embedded resource's text.
pub fn block_text(block: &Value) -> Option<&str> {
    block
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| block.get("resource")?.get("text")?.as_str())
}

/// The result's text as the server sent it, for copying.
pub fn raw_result_text(result: &Value) -> String {
    let blocks = result_blocks(result);
    let texts: Vec<&str> = blocks.iter().filter_map(block_text).collect();
    if texts.is_empty() {
        serde_json::to_string_pretty(result).unwrap_or_default()
    } else {
        texts.join("\n\n")
    }
}

/// True when a text block would render as Markdown, so raw and formatted views differ.
pub fn has_markdown(result: &Value) -> bool {
    result_blocks(result)
        .iter()
        .filter_map(block_text)
        .any(|text| pretty_json(text).is_none())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn reads_results() {
        let result = json!({ "content": [
            { "type": "text", "text": "{\"a\":1}" },
            { "type": "resource", "resource": { "uri": "x", "text": "# Hi" } },
            { "type": "image", "data": "AA", "mimeType": "image/png" }
        ]});
        assert_eq!(raw_result_text(&result), "{\"a\":1}\n\n# Hi", "raw text");
        assert!(has_markdown(&result), "markdown");
        assert_eq!(
            pretty_json("{\"a\":1}").as_deref(),
            Some("{\n  \"a\": 1\n}"),
            "pretty"
        );
        assert_eq!(pretty_json("12"), None, "not an object");
        let prompt = json!({ "messages": [{ "role": "user", "content": { "type": "text", "text": "hi" } }] });
        assert_eq!(raw_result_text(&prompt), "hi", "prompt");
        assert_eq!(raw_result_text(&json!({})), "{}", "fallback");
    }
}
