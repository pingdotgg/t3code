//! Grok's own rules on top of the shared ACP runtime (`packages/provider-grok`):
//! `normalizeXAiAcpToolCallState` and the session model choice (`applyGrokSessionModelSelection`).

use serde_json::{Value, json};

use crate::tools::ToolState;

fn non_empty(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn is_generic_title(title: Option<&str>) -> bool {
    let key = title.unwrap_or("").trim().to_lowercase();
    key.is_empty() || key == "tool" || key == "tool call" || key == "terminal"
}

/// `resolveXAiAcpToolTitle`.
fn resolve_title(tool: &ToolState) -> Option<String> {
    if !is_generic_title(tool.title.as_deref()) {
        return tool
            .title
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_owned);
    }
    let raw_input = tool.data.get("rawInput").cloned().unwrap_or(Value::Null);
    let description = non_empty(&raw_input["description"]);
    let variant = non_empty(&raw_input["variant"]).map(|v| v.to_lowercase());
    if let Some(description) = description {
        if variant.as_deref() == Some("monitor")
            && !description.to_lowercase().starts_with("monitor")
        {
            return Some(format!("Monitor: {description}"));
        }
        return Some(description);
    }
    match variant.as_deref() {
        Some("monitor") => return Some("Monitor".into()),
        Some("task" | "cursortask" | "spawn_subagent") => return Some("Task".into()),
        Some("taskoutput" | "task_output") => return Some("Task output".into()),
        Some(other) => return Some(other.to_owned()),
        None => {}
    }
    let raw_output = tool.data.get("rawOutput").cloned().unwrap_or(Value::Null);
    if let Some(command) =
        non_empty(&raw_input["command"]).or_else(|| non_empty(&raw_output["command"]))
    {
        // JS counts UTF-16 units; a cut never splits a surrogate pair.
        let units: Vec<u16> = command.encode_utf16().collect();
        if units.len() <= 80 {
            return Some(command);
        }
        let splits = units.get(76).is_some_and(|u| (0xD800..0xDC00).contains(u))
            && units.get(77).is_some_and(|u| (0xDC00..0xE000).contains(u));
        let cut = if splits { 76 } else { 77 };
        let head = String::from_utf16_lossy(units.get(..cut).unwrap_or(&units));
        return Some(format!("{head}..."));
    }
    tool.title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
}

/// `normalizeXAiMcpToolCall`.
fn normalize_mcp(mut tool: ToolState) -> ToolState {
    let meta = tool.data.get("meta").cloned().unwrap_or(Value::Null);
    let raw_input = tool.data.get("rawInput").cloned().unwrap_or(Value::Null);
    let tool_name = non_empty(&raw_input["tool_name"]).unwrap_or_default();
    let separator = tool_name.find("__");
    let is_use_tool = meta["x.ai/tool"]["name"] == "use_tool"
        && separator.is_some_and(|at| at > 0 && at + 2 < tool_name.len());
    let raw_output = tool.data.get("rawOutput").cloned().unwrap_or(Value::Null);
    let result = if raw_output["type"] == "MCP" {
        raw_output["output"].clone()
    } else {
        Value::Null
    };
    let (text, is_error) = match (&result["Error"], &result["OkayOutput"]) {
        (Value::String(e), _) => (Some(e.clone()), true),
        (_, Value::String(o)) => (Some(o.clone()), false),
        _ => (None, false),
    };
    if !is_use_tool && text.is_none() {
        return tool;
    }
    if is_use_tool && let Some(at) = separator {
        let mut meta = meta.as_object().cloned().unwrap_or_default();
        meta.insert("is_mcp_tool_call".into(), json!(true));
        tool.data.insert("meta".into(), Value::Object(meta));
        tool.data.insert(
            "rawInput".into(),
            json!({
                "server": tool_name.get(..at).unwrap_or(""),
                "tool": tool_name.get(at + 2..).unwrap_or(""),
                "arguments": if raw_input["tool_input"].is_object() { raw_input["tool_input"].clone() } else { json!({}) },
            }),
        );
    }
    if let Some(text) = text {
        let mut output = serde_json::Map::new();
        if is_error {
            output.insert("isError".into(), json!(true));
        }
        output.insert("content".into(), json!([{"type": "text", "text": text}]));
        tool.data.insert("rawOutput".into(), Value::Object(output));
    }
    tool
}

/// `xAiToolOutputText`.
fn output_text(tool: &ToolState) -> Option<String> {
    let raw_output = tool.data.get("rawOutput").cloned().unwrap_or(Value::Null);
    if raw_output.is_object() {
        let direct = non_empty(&raw_output["text"])
            .or_else(|| non_empty(&raw_output["output_for_prompt"]))
            .or_else(|| bytes(&raw_output["output"]));
        if direct.is_some() {
            return direct;
        }
        let result = if raw_output["Result"].is_object() {
            &raw_output["Result"]
        } else {
            &raw_output["result"]
        };
        if result.is_object() {
            let nested = non_empty(&result["output"])
                .or_else(|| non_empty(&result["text"]))
                .or_else(|| bytes(&result["output"]));
            if nested.is_some() {
                return nested;
            }
        }
    }
    if let Value::String(_) = raw_output {
        return non_empty(&raw_output);
    }
    let content = tool.data.get("content")?.as_array()?;
    let text = content
        .iter()
        .filter_map(|entry| {
            non_empty(&entry["content"]["text"]).or_else(|| non_empty(&entry["text"]))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn bytes(value: &Value) -> Option<String> {
    let items = value.as_array().filter(|a| !a.is_empty())?;
    let bytes: Option<Vec<u8>> = items
        .iter()
        .map(|v| v.as_u64().and_then(|n| u8::try_from(n).ok()))
        .collect();
    let text = String::from_utf8_lossy(&bytes?).into_owned();
    (!text.is_empty()).then_some(text)
}

fn monitor_start_ack(output: Option<&str>) -> bool {
    let Some(output) = output else { return false };
    let lower = output.to_lowercase();
    lower.find("monitor started").is_some_and(|at| {
        let rest = lower
            .get(at + "monitor started".len()..)
            .unwrap_or("")
            .trim_start();
        rest.strip_prefix('(').is_some_and(|r| {
            r.trim_start().starts_with("task")
                && r.trim_start()
                    .get(4..)
                    .is_some_and(|t| t.starts_with(char::is_whitespace))
        })
    })
}

fn is_monitor(tool: &ToolState) -> bool {
    let title = tool.title.as_deref().unwrap_or("").trim().to_lowercase();
    if title == "monitor" || title.starts_with("monitor ") {
        return true;
    }
    let raw_input = tool.data.get("rawInput").cloned().unwrap_or(Value::Null);
    if non_empty(&raw_input["variant"]).is_some_and(|v| v.eq_ignore_ascii_case("monitor")) {
        return true;
    }
    let raw_output = tool.data.get("rawOutput").cloned().unwrap_or(Value::Null);
    if non_empty(&raw_output["type"]).is_some_and(|t| t.eq_ignore_ascii_case("monitor")) {
        return true;
    }
    monitor_start_ack(output_text(tool).as_deref())
}

/// `normalizeXAiAcpToolCallState`.
pub(crate) fn normalize_tool(incoming: ToolState) -> ToolState {
    let mut tool = normalize_mcp(incoming);
    if let Some(title) = resolve_title(&tool)
        && tool.title.as_deref() != Some(title.as_str())
    {
        tool.title = Some(title);
    }
    let raw_output = tool.data.get("rawOutput").cloned().unwrap_or(Value::Null);
    let output_type = non_empty(&raw_output["type"]).map(|t| t.to_lowercase());
    let running = matches!(tool.status.as_deref(), Some("inProgress" | "pending"));
    if output_type.as_deref() == Some("bash") && !running {
        let exit = ["exit_code", "exitCode", "code"]
            .iter()
            .find_map(|k| raw_output[*k].as_i64());
        if let Some(code) = exit {
            if code == 0 && output_text(&tool).is_none_or(|t| t.trim().is_empty()) {
                tool.status = Some("inProgress".into());
            } else {
                tool.status = Some(if code == 0 { "completed" } else { "failed" }.into());
            }
            return tool;
        }
    }
    if non_empty(&raw_output["type"]).as_deref() == Some("BackgroundTaskStarted")
        && non_empty(&raw_output["task_id"]).is_some()
    {
        tool.status = Some("inProgress".into());
        return tool;
    }
    if !is_monitor(&tool) {
        return tool;
    }
    if output_type.as_deref() == Some("monitor") {
        tool.status = Some("inProgress".into());
        return tool;
    }
    if tool.status.as_deref() == Some("completed")
        && monitor_start_ack(output_text(&tool).as_deref())
    {
        tool.status = Some("inProgress".into());
    }
    tool
}

/// `GROK_DEFAULT_MODEL_SLUG`.
pub(crate) const DEFAULT_MODEL: &str = "grok-build";

/// `applyGrokSessionModelSelection` for ACP protocol 1: the model to switch to with
/// `session/set_model`, or `None` when the session already runs it.
pub(crate) fn model_switch(setup: &Value, requested: &str) -> Option<String> {
    let requested = requested.trim();
    let requested = if requested.is_empty() {
        DEFAULT_MODEL
    } else {
        requested
    };
    let current = setup["models"]["currentModelId"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if requested == DEFAULT_MODEL {
        return None;
    }
    (current != Some(requested)).then(|| requested.to_owned())
}

// ---- ask_user_question --------------------------------------------------------------------

/// `unwrapAskUserQuestionParams`.
fn question_params(params: &Value) -> &Value {
    if params.get("params").is_some_and(Value::is_object) {
        &params["params"]
    } else {
        params
    }
}

/// The request id, the item id and the questions of an `ask_user_question` request
/// (`extractXAiAskUserQuestionIdentity`, `extractXAiAskUserQuestions`).
pub(crate) fn question_request(params: &Value) -> Option<(String, String, Value)> {
    let inner = question_params(params);
    let session_id = inner["sessionId"].as_str()?;
    let tool_call_id = inner["toolCallId"].as_str()?;
    let questions: Vec<Value> = inner["questions"]
        .as_array()?
        .iter()
        .map(|q| {
            let options: Vec<Value> = q["options"]
                .as_array()
                .map(|options| {
                    options
                        .iter()
                        .map(|o| json!({"label": o["label"], "description": if o["description"].is_string() { o["description"].clone() } else { o["label"].clone() }}))
                        .collect()
                })
                .unwrap_or_default();
            json!({
                "id": if q["id"].is_string() { q["id"].clone() } else { q["question"].clone() },
                "header": "Question",
                "question": q["question"],
                "multiSelect": q["multiSelect"] == true,
                "options": if options.is_empty() { json!([{"label": "OK", "description": "Continue"}]) } else { Value::Array(options) },
            })
        })
        .collect();
    Some((
        tool_call_id.to_owned(),
        format!("{session_id}:xai-question:{tool_call_id}"),
        Value::Array(questions),
    ))
}

fn answer_values(answer: &Value) -> Vec<String> {
    let trimmed = |v: &Value| {
        v.as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    match answer {
        Value::Array(items) => items.iter().filter_map(trimmed).collect(),
        other => trimmed(other).into_iter().collect(),
    }
}

/// `makeXAiAskUserQuestionResponse`.
pub(crate) fn question_response(params: &Value, answers: &Value) -> crate::ordered::J {
    use crate::ordered::{J, obj};
    let mut answered = Vec::new();
    let mut annotations = Vec::new();
    for question in question_params(params)["questions"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let text = question["question"].as_str().unwrap_or("").to_owned();
        let key = question["id"].as_str().unwrap_or(&text).to_owned();
        let answer = answers
            .get(&key)
            .filter(|v| !v.is_null())
            .or_else(|| answers.get(&text));
        let values = answer.map(answer_values).unwrap_or_default();
        if values.is_empty() {
            continue;
        }
        let options: Vec<&Value> = question["options"]
            .as_array()
            .map(|o| o.iter().collect())
            .unwrap_or_default();
        let find = |value: &str| options.iter().find(|o| o["label"] == value).copied();
        let labels: Vec<J> = values
            .iter()
            .filter(|v| find(v).is_some())
            .map(|v| J::str(v.clone()))
            .collect();
        let notes: Vec<String> = values
            .iter()
            .filter(|v| find(v).is_none())
            .cloned()
            .collect();
        let preview = if question["multiSelect"] == true {
            None
        } else {
            values
                .iter()
                .filter_map(|v| {
                    find(v)
                        .and_then(|o| o["preview"].as_str())
                        .map(str::trim)
                        .filter(|p| !p.is_empty())
                })
                .map(str::to_owned)
                .next()
        };
        if preview.is_some() || !notes.is_empty() {
            let annotation = obj()
                .with_opt("preview", preview)
                .with_opt("notes", (!notes.is_empty()).then(|| notes.join("\n")));
            annotations.push((text.clone(), annotation));
        }
        let labels = if labels.is_empty() {
            vec![J::str("Other")]
        } else {
            labels
        };
        answered.push((text, J::Arr(labels)));
    }
    let response = obj()
        .with("outcome", "accepted")
        .with("answers", J::Obj(answered));
    if annotations.is_empty() {
        response
    } else {
        response.with("annotations", J::Obj(annotations))
    }
}
