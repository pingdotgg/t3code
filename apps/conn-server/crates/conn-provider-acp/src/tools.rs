//! Tool calls: the state T3 keeps per call (`makeToolCallState`, `mergeToolCallState` in
//! `runtimeModel.ts`), when an update is worth an event (`decideToolCallUpdateEmission`), and
//! the turn item a call becomes (`emitTool` in `adapter.ts`), with the titles of
//! `deriveToolActivityPresentation` (`packages/shared/src/toolActivity.ts`).

use serde_json::{Map, Value, json};

use crate::diff;

/// `AcpToolCallState`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ToolState {
    pub tool_call_id: String,
    pub kind: Option<String>,
    pub title: Option<String>,
    pub status: Option<String>,
    pub command: Option<String>,
    pub detail: Option<String>,
    pub data: Map<String, Value>,
}

const CONTENT_MAX_CHARS: usize = 8_000;
const TRUNCATION_MARKER: &str = "[Earlier output truncated]\n\n";
const RAW_OUTPUT_TEXT_FIELDS: [&str; 4] = ["content", "stdout", "stderr", "output"];

fn trimmed(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn char_len(text: &str) -> usize {
    text.chars().count()
}

/// The last `CONTENT_MAX_CHARS` characters, after the marker.
fn bound_text(text: &str) -> String {
    let len = char_len(text);
    if len <= CONTENT_MAX_CHARS {
        return text.to_owned();
    }
    let tail: String = text.chars().skip(len - CONTENT_MAX_CHARS).collect();
    format!("{TRUNCATION_MARKER}{tail}")
}

fn normalize_status(raw: &Value, fallback: Option<&str>) -> Option<String> {
    match raw.as_str() {
        Some("pending") => Some("pending".into()),
        Some("in_progress" | "inProgress") => Some("inProgress".into()),
        Some("completed") => Some("completed".into()),
        Some("failed" | "cancelled") => Some("failed".into()),
        _ => fallback.map(str::to_owned),
    }
}

fn normalize_command_value(value: &Value) -> Option<String> {
    if let Some(text) = trimmed(value) {
        return Some(text);
    }
    let parts: Vec<String> = value.as_array()?.iter().filter_map(trimmed).collect();
    (!parts.is_empty()).then(|| parts.join(" "))
}

fn command_from_title(title: Option<&str>) -> Option<String> {
    let title = title?;
    let start = title.find('`')? + 1;
    let rest = title.get(start..)?;
    let end = rest.find('`')?;
    let inner = rest.get(..end)?.trim();
    (!inner.is_empty()).then(|| inner.to_owned())
}

fn extract_command(raw_input: &Value, title: Option<&str>, kind: Option<&str>) -> Option<String> {
    if raw_input.is_object() {
        if let Some(command) = normalize_command_value(&raw_input["command"]) {
            return Some(command);
        }
        let executable = raw_input["executable"]
            .as_str()
            .map(str::trim)
            .unwrap_or("");
        let args = normalize_command_value(&raw_input["args"]);
        match (executable.is_empty(), args) {
            (false, Some(args)) => return Some(format!("{executable} {args}")),
            (false, None) => return Some(executable.to_owned()),
            _ => {}
        }
    }
    if kind != Some("execute") {
        return None;
    }
    command_from_title(title)
}

fn content_text(entry: &Value) -> Option<&str> {
    if entry["type"] == "content" && entry["content"]["type"] == "text" {
        entry["content"]["text"].as_str()
    } else {
        None
    }
}

/// `sanitizeAcpToolCallContent` after `extractTextContentFromToolCallContent`'s bounds.
fn sanitize_content(content: &[Value]) -> (Option<String>, Vec<Value>) {
    let texts: Vec<String> = content
        .iter()
        .filter_map(|entry| content_text(entry).map(str::trim))
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect();
    let bounded = content
        .iter()
        .map(|entry| match entry["type"].as_str() {
            Some("content") => {
                let text =
                    crate::mapper::content_display_text(&entry["content"]).unwrap_or_default();
                let text = if char_len(&text) > CONTENT_MAX_CHARS {
                    let t = text.trim();
                    bound_text(if t.is_empty() { &text } else { t })
                } else {
                    text
                };
                json!({"type": "content", "content": {"type": "text", "text": text}})
            }
            Some("diff") => {
                if entry.get("changes").is_some() {
                    let mut diff = json!({"type": "diff", "changes": entry["changes"]});
                    if let Some(patch) = entry.get("patch") {
                        diff["patch"] = patch.clone();
                    }
                    diff
                } else {
                    let mut diff = json!({"type": "diff", "path": entry["path"]});
                    if let Some(old) = entry.get("oldText") {
                        diff["oldText"] = old.clone();
                    }
                    diff["newText"] = entry["newText"].clone();
                    diff
                }
            }
            Some("terminal") => json!({"type": "terminal", "terminalId": entry["terminalId"]}),
            other => json!({
                "type": "_t3_unknown",
                "originalType": other.unwrap_or("unknown").chars().take(128).collect::<String>(),
                "raw": null,
            }),
        })
        .collect();
    let text = (!texts.is_empty()).then(|| bound_text(&texts.join("\n")));
    (text, bounded)
}

fn bound_raw_output(raw: &Value) -> Value {
    let Some(record) = raw.as_object() else {
        return raw.clone();
    };
    let mut bounded = record.clone();
    for field in RAW_OUTPUT_TEXT_FIELDS {
        if let Some(text) = record.get(field).and_then(Value::as_str)
            && char_len(text) > CONTENT_MAX_CHARS
        {
            bounded.insert(field.into(), json!(bound_text(text)));
        }
    }
    Value::Object(bounded)
}

fn locations(update: &Value) -> Option<Vec<Value>> {
    if update.get("locations") == Some(&Value::Null)
        || update["locations"].as_array().is_some_and(Vec::is_empty)
    {
        return Some(Vec::new());
    }
    let mut out: Vec<Value> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut push = |path: Option<String>, location: Option<&Value>| {
        let Some(path) = path else { return };
        if seen.contains(&path) {
            return;
        }
        seen.push(path.clone());
        match location {
            Some(Value::Object(map)) => {
                let mut map = map.clone();
                map.insert("path".into(), json!(path));
                out.push(Value::Object(map));
            }
            _ => out.push(json!({"path": path})),
        }
    };
    for location in update["locations"].as_array().into_iter().flatten() {
        push(trimmed(&location["path"]), Some(location));
    }
    for entry in update["content"].as_array().into_iter().flatten() {
        if entry["type"] == "diff" {
            push(trimmed(&entry["path"]), None);
        }
    }
    for source in [&update["rawInput"], &update["rawOutput"]] {
        if source.is_object() {
            for key in ["path", "filePath", "file_path"] {
                push(trimmed(&source[key]), None);
            }
        }
    }
    (!out.is_empty()).then_some(out)
}

const TOOL_FALLBACK_SUMMARY: &str = "Tool";

/// `makeToolCallState` for a `tool_call` / `tool_call_update` (or a permission's `toolCall`).
pub(crate) fn parse_tool_call(update: &Value, fallback_status: Option<&str>) -> Option<ToolState> {
    let tool_call_id = trimmed(&update["toolCallId"])?;
    let raw_title = update["title"].as_str();
    let title = raw_title
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned);
    let kind = trimmed(&update["kind"]);
    let command = extract_command(&update["rawInput"], title.as_deref(), kind.as_deref());
    let content = update["content"].as_array();
    let (text_content, sanitized) = content.map_or((None, Vec::new()), |c| sanitize_content(c));
    let normalized_title = title.clone().filter(|t| {
        let lower = t.to_lowercase();
        lower != "terminal" && lower != "tool call"
    });
    let mut data = Map::new();
    data.insert("toolCallId".into(), json!(tool_call_id));
    for (key, field) in [
        ("name", "name"),
        ("title", "title"),
        ("kind", "kind"),
        ("status", "status"),
        ("content", "content"),
        ("rawInput", "rawInput"),
        ("meta", "_meta"),
    ] {
        if update.get(field) == Some(&Value::Null) {
            data.insert(key.into(), Value::Null);
        }
    }
    if let Some(name) = update.get("name").filter(|v| !v.is_null()) {
        data.insert("name".into(), name.clone());
    }
    if let Some(kind) = &kind {
        data.insert("kind".into(), json!(kind));
    }
    if let Some(title) = &title {
        data.insert("title".into(), json!(title));
    }
    if let Some(command) = &command {
        data.insert("command".into(), json!(command));
    }
    if let Some(raw_input) = update.get("rawInput") {
        data.insert("rawInput".into(), raw_input.clone());
    }
    if update["_meta"].is_object() {
        data.insert("meta".into(), update["_meta"].clone());
    }
    if let Some(raw_output) = update.get("rawOutput") {
        data.insert("rawOutput".into(), bound_raw_output(raw_output));
    }
    if content.is_some() {
        data.insert("content".into(), Value::Array(sanitized));
    }
    if let Some(locations) = locations(update) {
        data.insert("locations".into(), Value::Array(locations));
    }
    let fallback_detail = command
        .clone()
        .or_else(|| normalized_title.clone())
        .or_else(|| text_content.clone());
    let seeded = title.is_some() || kind.is_some() || command.is_some() || text_content.is_some();
    let presentation = seeded.then(|| {
        presentation(
            item_type_for_kind(kind.as_deref()),
            title.as_deref(),
            fallback_detail.as_deref(),
            &Value::Object(data.clone()),
            title.as_deref().unwrap_or(TOOL_FALLBACK_SUMMARY),
        )
    });
    // A titleless update omits an unchanged title; the generic fallback must not replace it (#38989).
    let presentation_title = presentation
        .as_ref()
        .map(|p| p.0.clone())
        .filter(|summary| title.is_some() || summary != TOOL_FALLBACK_SUMMARY);
    let status = normalize_status(&update["status"], fallback_status);
    Some(ToolState {
        tool_call_id,
        kind,
        title: presentation_title,
        status,
        command,
        detail: presentation.and_then(|p| p.1),
        data,
    })
}

/// The tool state of a `compaction_update` (`parseSessionUpdateEvent`): one "Compact context"
/// tool per compaction id, its summary (or error) as output.
pub(crate) fn compaction_tool(update: &Value) -> Option<ToolState> {
    let id = update["compactionId"].as_str()?;
    let summary = update["summary"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(crate::mapper::content_display_text)
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let status = match update["status"].as_str() {
        Some("completed") => "completed",
        Some("failed" | "cancelled") => "failed",
        _ => "in_progress",
    };
    let output = match update.get("error").filter(|e| !e.is_null()) {
        Some(error) => error.clone(),
        None => json!(summary),
    };
    let mut state = Map::new();
    state.insert("toolCallId".into(), json!(format!("acp-compaction:{id}")));
    state.insert("title".into(), json!("Compact context"));
    state.insert("kind".into(), json!("think"));
    state.insert("status".into(), json!(status));
    // `(error ?? summary) || undefined`.
    if !(output.is_null() || output == json!("") || output == json!(false) || output == json!(0)) {
        state.insert("rawOutput".into(), output);
    }
    if let Some(meta) = update.get("_meta") {
        state.insert("_meta".into(), meta.clone());
    }
    parse_tool_call(&Value::Object(state), None)
}

/// The state a `compaction_summary_chunk` starts from when its compaction is not known yet.
pub(crate) fn compaction_placeholder(tool_call_id: &str) -> ToolState {
    let mut data = Map::new();
    data.insert("toolCallId".into(), json!(tool_call_id));
    ToolState {
        tool_call_id: tool_call_id.to_owned(),
        kind: Some("think".into()),
        title: Some("Compact context".into()),
        status: Some("inProgress".into()),
        command: None,
        detail: None,
        data,
    }
}

/// `toolOutputText`.
pub(crate) fn tool_output_text(tool: &ToolState) -> String {
    match tool.data.get("rawOutput") {
        Some(Value::String(text)) => text.clone(),
        Some(raw) if raw["text"].is_string() => raw["text"].as_str().unwrap_or("").to_owned(),
        Some(raw) => text_from_unknown(raw).unwrap_or_default(),
        None => String::new(),
    }
}

/// `appendToolContentText`: the text extends the last text entry, or becomes a new one.
pub(crate) fn append_content_text(content: Option<&Value>, text: &str) -> Value {
    let mut next: Vec<Value> = content
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let extend = next.last().is_some_and(|last| {
        last["type"] == "content"
            && last["content"]["type"] == "text"
            && last["content"]["text"].is_string()
    });
    if extend && let Some(last) = next.last_mut() {
        let joined = format!("{}{text}", last["content"]["text"].as_str().unwrap_or(""));
        last["content"]["text"] = json!(joined);
    } else {
        next.push(json!({"type": "content", "content": {"type": "text", "text": text}}));
    }
    Value::Array(next)
}

/// `setToolOutputText`: the output becomes `{type: "Text", text}`.
pub(crate) fn set_output_text(mut tool: ToolState, text: &str) -> ToolState {
    tool.data
        .insert("rawOutput".into(), json!({"type": "Text", "text": text}));
    tool
}

/// `appendToolOutputText`: the output becomes `{type: "Text", text}`.
pub(crate) fn append_output_text(mut tool: ToolState, text: &str) -> ToolState {
    if text.is_empty() {
        return tool;
    }
    let joined = format!("{}{text}", tool_output_text(&tool));
    tool.data
        .insert("rawOutput".into(), json!({"type": "Text", "text": joined}));
    tool
}

fn item_type_for_kind(kind: Option<&str>) -> &'static str {
    match kind {
        Some("execute") => "command_execution",
        Some("edit" | "delete" | "move") => "file_change",
        Some("search" | "fetch") => "web_search",
        _ => "dynamic_tool_call",
    }
}

/// `mergeToolActivityData`.
fn merge_data(previous: &Map<String, Value>, next: &Map<String, Value>) -> Map<String, Value> {
    let mut merged = previous.clone();
    for (k, v) in next {
        merged.insert(k.clone(), v.clone());
    }
    merged.retain(|_, v| !v.is_null());
    if next.get("rawInput") == Some(&Value::Null) {
        return merged;
    }
    let has_keys = |v: Option<&Value>| v.and_then(Value::as_object).is_some_and(|m| !m.is_empty());
    let raw_input = if has_keys(next.get("rawInput")) {
        next.get("rawInput").cloned()
    } else {
        previous
            .get("rawInput")
            .filter(|v| v.is_object())
            .cloned()
            .or_else(|| next.get("rawInput").filter(|v| v.is_object()).cloned())
    };
    if has_keys(raw_input.as_ref()) {
        if let Some(raw_input) = raw_input {
            merged.insert("rawInput".into(), raw_input);
        }
    } else {
        merged.remove("rawInput");
    }
    merged
}

/// `mergeToolCallState`.
pub(crate) fn merge(previous: Option<&ToolState>, next: ToolState) -> ToolState {
    let Some(previous) = previous else {
        return next;
    };
    let next_kind = next.kind.clone().or_else(|| {
        next.data
            .get("kind")
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    let kind = if next.data.get("kind") == Some(&Value::Null) {
        next_kind
    } else {
        next_kind.or_else(|| previous.kind.clone())
    };
    let title = if next.data.get("title") == Some(&Value::Null) {
        next.title.clone()
    } else {
        next.title.clone().or_else(|| previous.title.clone())
    };
    let status = if next.data.get("status") == Some(&Value::Null) {
        next.status.clone()
    } else {
        next.status.clone().or_else(|| previous.status.clone())
    };
    ToolState {
        tool_call_id: next.tool_call_id.clone(),
        kind,
        title,
        status,
        command: next.command.clone().or_else(|| previous.command.clone()),
        detail: next.detail.clone().or_else(|| previous.detail.clone()),
        data: merge_data(&previous.data, &next.data),
    }
}

fn content_texts(state: &ToolState) -> String {
    state
        .data
        .get("content")
        .and_then(Value::as_array)
        .map(|c| {
            c.iter()
                .map(|e| content_text(e).unwrap_or(""))
                .collect::<Vec<_>>()
                .join("\u{0}")
        })
        .unwrap_or_default()
}

/// `toolCallVisibleOutputChanged`.
pub(crate) fn visible_output_changed(previous: &ToolState, next: &ToolState) -> bool {
    previous.detail != next.detail
        || content_texts(previous) != content_texts(next)
        || previous.data.get("rawOutput") != next.data.get("rawOutput")
}

/// `toolStatus`.
pub(crate) fn item_status(status: Option<&str>) -> &'static str {
    match status {
        Some("completed") => "completed",
        Some("failed") => "failed",
        Some("pending") => "pending",
        Some("requiresAction") => "waiting",
        _ => "running",
    }
}

pub(crate) fn node_status(status: &str) -> &str {
    if status == "pending" {
        "running"
    } else {
        status
    }
}

pub(crate) fn completed_at(status: &str, now: &str) -> Value {
    if matches!(status, "completed" | "failed" | "interrupted") {
        json!(now)
    } else {
        Value::Null
    }
}

/// `providerRequestKind`.
pub(crate) fn request_kind(kind: Option<&str>) -> &'static str {
    match kind {
        Some("read" | "search" | "fetch") => "file-read",
        Some("edit" | "delete" | "move") => "file-change",
        _ => "command",
    }
}

// ---- presentation (toolActivity.ts) -----------------------------------------------------

const PATH_KEYS: [&str; 8] = [
    "path",
    "filePath",
    "file_path",
    "relativePath",
    "filename",
    "fileName",
    "newPath",
    "oldPath",
];

fn collect_paths(value: &Value, paths: &mut Vec<String>, depth: usize) {
    if depth > 4 || paths.len() >= 8 {
        return;
    }
    if let Some(items) = value.as_array() {
        for item in items {
            collect_paths(item, paths, depth + 1);
            if paths.len() >= 8 {
                return;
            }
        }
        return;
    }
    let Some(record) = value.as_object() else {
        return;
    };
    for key in PATH_KEYS {
        if let Some(candidate) = record.get(key).and_then(trimmed)
            && !paths.contains(&candidate)
        {
            paths.push(candidate);
            if paths.len() >= 8 {
                return;
            }
        }
    }
    for nested in [
        "locations",
        "item",
        "input",
        "result",
        "rawInput",
        "data",
        "changes",
    ] {
        if let Some(inner) = record.get(nested) {
            collect_paths(inner, paths, depth + 1);
            if paths.len() >= 8 {
                return;
            }
        }
    }
}

fn primary_path(data: &Value) -> Option<String> {
    let mut paths = Vec::new();
    collect_paths(data, &mut paths, 0);
    paths.into_iter().next()
}

fn tool_name_token(value: Option<String>) -> Option<String> {
    let value = value?;
    if value.contains("__") || value.contains('.') || value.contains('/') {
        return None;
    }
    Some(
        value
            .chars()
            .filter(|c| !matches!(c, '_' | '-') && !c.is_whitespace())
            .collect::<String>()
            .to_lowercase(),
    )
}

fn classify(item_type: &str, data: &Value) -> &'static str {
    let kind = trimmed(&data["kind"]).map(|k| k.to_lowercase());
    let tool =
        tool_name_token(trimmed(&data["toolName"]).or_else(|| trimmed(&data["item"]["tool"])));
    match item_type {
        "command_execution" => return "command",
        "image_view" => return "read",
        "file_change" => return "file_change",
        "web_search" => return "search",
        _ => {}
    }
    let kind = kind.as_deref();
    let tool = tool.as_deref();
    if kind == Some("execute") {
        "command"
    } else if matches!(kind, Some("edit" | "move" | "delete" | "write")) {
        "file_change"
    } else if kind == Some("search") || matches!(tool, Some("find" | "grep" | "glob" | "rg" | "ls"))
    {
        "search"
    } else if kind == Some("read") {
        "read"
    } else if matches!(tool, Some("terminal" | "bash" | "shell")) {
        "command"
    } else if matches!(tool, Some("read" | "readfile")) {
        "read"
    } else {
        "other"
    }
}

fn first_string(record: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| trimmed(&record[*k]))
}

fn search_label(data: &Value) -> Option<String> {
    let has_keys = |v: &Value| v.as_object().is_some_and(|m| !m.is_empty());
    let input = [&data["rawInput"], &data["input"], &data["item"]["input"]]
        .into_iter()
        .find(|v| has_keys(v))
        .unwrap_or(data);
    let query = first_string(
        input,
        &["pattern", "query", "searchTerm", "regex", "grep", "needle"],
    );
    let glob = first_string(
        input,
        &[
            "glob",
            "globPattern",
            "glob_pattern",
            "include",
            "filePattern",
            "file_pattern",
        ],
    );
    let target = first_string(
        input,
        &[
            "path",
            "target_directory",
            "targetDirectory",
            "directory",
            "cwd",
            "root",
        ],
    )
    .and_then(|t| {
        t.split(['/', '\\'])
            .rfind(|p| !p.is_empty() && *p != ".")
            .map(str::to_owned)
    });
    match (query, glob, target) {
        (Some(q), _, Some(t)) => Some(format!("Searched {q} in {t}")),
        (None, Some(g), Some(t)) => Some(format!("Searched files {g} in {t}")),
        (None, Some(g), None) => Some(format!("Searched files {g}")),
        (Some(q), _, None) => Some(format!("Searched {q}")),
        (None, None, Some(t)) => Some(format!("Searched in {t}")),
        _ => None,
    }
}

fn strip_exit_code(value: Option<&str>) -> Option<String> {
    let t = value?.trim();
    if t.is_empty() {
        return None;
    }
    let lower = t.to_lowercase();
    let out = if lower.ends_with('>') {
        match lower.rfind("<exited with exit code ") {
            Some(at)
                if lower
                    .get(at + 23..lower.len() - 1)
                    .is_some_and(|d| !d.is_empty() && d.chars().all(|c| c.is_ascii_digit())) =>
            {
                t.get(..at).unwrap_or(t).trim()
            }
            _ => t,
        }
    } else {
        t
    };
    (!out.is_empty()).then(|| out.to_owned())
}

fn equivalent_form(value: &str) -> Option<String> {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    let lower = collapsed.to_lowercase();
    for suffix in [" complete", " completed", " started"] {
        if let Some(stripped) = lower.strip_suffix(suffix) {
            return Some(stripped.trim().to_owned());
        }
    }
    Some(lower)
}

fn equivalent(left: Option<&str>, right: Option<&str>) -> bool {
    match (
        left.and_then(equivalent_form),
        right.and_then(equivalent_form),
    ) {
        (Some(l), Some(r)) => l == r,
        _ => false,
    }
}

fn tool_command(data: &Value, title: Option<&str>) -> Option<String> {
    [
        &data["item"]["command"],
        &data["item"]["input"]["command"],
        &data["item"]["result"]["command"],
        &data["command"],
        &data["rawInput"]["command"],
    ]
    .into_iter()
    .find_map(normalize_command_value)
    .or_else(|| {
        let executable = trimmed(&data["rawInput"]["executable"]);
        let args = normalize_command_value(&data["rawInput"]["args"]);
        match (executable, args) {
            (Some(e), Some(a)) => Some(format!("{e} {a}")),
            (Some(e), None) => Some(e),
            _ => command_from_title(title),
        }
    })
}

/// `deriveToolActivityPresentation`: (summary, detail).
fn presentation(
    item_type: &str,
    title: Option<&str>,
    detail: Option<&str>,
    data: &Value,
    fallback: &str,
) -> (String, Option<String>) {
    let title = title.map(str::trim).filter(|t| !t.is_empty());
    let detail = strip_exit_code(detail);
    let fallback = if fallback.trim().is_empty() {
        "Tool"
    } else {
        fallback.trim()
    };
    match classify(item_type, data) {
        "command" => ("Ran command".into(), tool_command(data, title)),
        "read" => (
            primary_path(data).map_or_else(|| "Read file".into(), |p| read_label(&p)),
            None,
        ),
        "file_change" => ("Changed files".into(), primary_path(data)),
        "search" => (
            search_label(data).unwrap_or_else(|| "Searched files".into()),
            None,
        ),
        _ => {
            let summary = title.unwrap_or(fallback).to_owned();
            if detail.is_some()
                && !equivalent(detail.as_deref(), title)
                && !equivalent(detail.as_deref(), Some(fallback))
            {
                (summary, detail)
            } else {
                (summary, None)
            }
        }
    }
}

/// `formatReadToolLabel`.
fn read_label(path: &str) -> String {
    let t = path.trim();
    if t.is_empty() {
        "Read file".into()
    } else {
        format!("Read {t}")
    }
}

// ---- projection (emitTool) --------------------------------------------------------------

/// `textFromUnknown`.
pub(crate) fn text_from_unknown(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => {
            if let Some(text) = bytes_text(value) {
                return Some(text);
            }
            let parts: Vec<String> = items
                .iter()
                .filter_map(text_from_unknown)
                .filter(|t| !t.is_empty())
                .collect();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        Value::Object(record) => {
            for key in [
                "output_for_prompt",
                "stdout",
                "stderr",
                "output",
                "combinedOutput",
                "combined_output",
                "content",
                "text",
                "message",
            ] {
                let Some(direct) = record.get(key) else {
                    continue;
                };
                if let Some(s) = direct.as_str().filter(|s| !s.is_empty()) {
                    return Some(s.to_owned());
                }
                if let Some(text) = bytes_text(direct) {
                    return Some(text);
                }
                if let Some(text) = text_from_unknown(direct).filter(|t| !t.is_empty()) {
                    return Some(text);
                }
            }
            record
                .get("Result")
                .filter(|v| v.is_object())
                .or_else(|| record.get("result").filter(|v| v.is_object()))
                .and_then(text_from_unknown)
        }
        _ => None,
    }
}

fn bytes_text(value: &Value) -> Option<String> {
    let items = value.as_array().filter(|a| !a.is_empty())?;
    let bytes: Option<Vec<u8>> = items
        .iter()
        .map(|v| v.as_u64().and_then(|n| u8::try_from(n).ok()))
        .collect();
    let text = String::from_utf8_lossy(&bytes?).into_owned();
    (!text.is_empty()).then_some(text)
}

fn command_exit_code(value: &Value) -> Option<i64> {
    ["exitCode", "exit_code", "code"]
        .iter()
        .find_map(|k| value.get(*k).and_then(Value::as_i64))
}

/// The turn item for a tool call (`emitTool`'s projection), on `base`.
pub(crate) fn project_turn_item(tool: &ToolState, status: &str, mut base: Value) -> Value {
    let data = Value::Object(tool.data.clone());
    let raw_input = tool.data.get("rawInput").cloned();
    let raw_output = tool
        .data
        .get("rawOutput")
        .or_else(|| tool.data.get("content"))
        .cloned();
    let path = path_from_tool(&data);
    let content = tool.data.get("content").cloned().unwrap_or(Value::Null);
    let diff_text = diff::tool_call_diff_patch(&content)
        .or_else(|| raw_output.as_ref().and_then(text_from_unknown));
    let raw_input_record = raw_input.as_ref().filter(|v| v.is_object());
    let variant = raw_input_record
        .and_then(|r| r["variant"].as_str())
        .map(|v| v.trim().to_lowercase())
        .unwrap_or_default();
    let output_record = raw_output.as_ref().filter(|v| v.is_object());
    let monitor_command = raw_input_record
        .and_then(|r| trimmed(&r["command"]))
        .or_else(|| output_record.and_then(|r| trimmed(&r["command"])));
    let output_is_bash = output_record.is_some_and(|r| {
        r["type"]
            .as_str()
            .is_some_and(|t| t.trim().eq_ignore_ascii_case("bash"))
            && command_exit_code(r).is_some()
    });
    let as_command = variant == "monitor" || output_is_bash;
    let exit_code = || {
        if matches!(status, "completed" | "failed") {
            raw_output.as_ref().and_then(command_exit_code)
        } else {
            None
        }
    };
    let text_output = raw_output.as_ref().and_then(text_from_unknown);
    let fields: Value = match tool.kind.as_deref() {
        Some("read") => {
            if let Some(path) = &path {
                base["title"] = json!(read_label(path));
            } else if base["title"].is_null() {
                base["title"] = json!("Read file");
            }
            let input = match (&path, raw_input_record) {
                (None, Some(r)) => r.clone(),
                (None, None) => json!({}),
                (Some(p), r) => {
                    if ["path", "filePath", "file_path"]
                        .iter()
                        .any(|k| r.is_some_and(|r| r[*k] == json!(p)))
                    {
                        r.cloned().unwrap_or_else(|| json!({}))
                    } else {
                        let mut m = r.and_then(Value::as_object).cloned().unwrap_or_default();
                        m.insert("path".into(), json!(p));
                        Value::Object(m)
                    }
                }
            };
            let mut f = json!({"type": "dynamic_tool", "toolName": "Read", "input": input});
            if let Some(o) = &raw_output {
                f["output"] = o.clone();
            }
            f
        }
        Some("execute") => {
            let mut f = json!({
                "type": "command_execution",
                "input": tool.command.clone().or(monitor_command).or_else(|| tool.title.clone()).unwrap_or_else(|| "Command".into()),
            });
            if let Some(o) = &text_output {
                f["output"] = json!(o);
            }
            if let Some(code) = exit_code() {
                f["exitCode"] = json!(code);
            }
            f
        }
        Some("edit" | "delete" | "move") => {
            let mut f = json!({
                "type": "file_change",
                "fileName": path.or_else(|| tool.title.clone()).unwrap_or_else(|| "File change".into()),
            });
            if let Some((old, new)) = diff::snippet_edit(&content) {
                f["oldStr"] = json!(old);
                f["newStr"] = json!(new);
            } else if !diff::unpreviewable(&content)
                && let Some(d) = &diff_text
            {
                f["diffStr"] = json!(d);
            }
            f
        }
        _ if as_command => {
            let mut f = json!({
                "type": "command_execution",
                "input": tool.command.clone().or(monitor_command).or_else(|| tool.title.clone())
                    .unwrap_or_else(|| if variant == "monitor" { "Monitor".into() } else { "Command".into() }),
            });
            if let Some(o) = &text_output {
                f["output"] = json!(o);
            }
            if let Some(code) = exit_code() {
                f["exitCode"] = json!(code);
            }
            if variant == "monitor" {
                f["monitor"] = json!(true);
            }
            f
        }
        _ => {
            let mut f = json!({
                "type": "dynamic_tool",
                "toolName": tool.title.clone().or_else(|| tool.kind.clone()),
                "input": raw_input.clone().unwrap_or_else(|| json!({})),
            });
            if let Some(o) = &raw_output {
                f["output"] = o.clone();
            }
            f
        }
    };
    if let (Value::Object(base_map), Value::Object(extra)) = (&mut base, fields) {
        for (k, v) in extra {
            base_map.insert(k, v);
        }
    }
    base
}

/// `pathFromToolCall`.
fn path_from_tool(data: &Value) -> Option<String> {
    for location in data["locations"].as_array().into_iter().flatten() {
        if let Some(path) = trimmed(&location["path"]) {
            return Some(path);
        }
    }
    ["path", "filePath", "file_path", "url", "query", "pattern"]
        .iter()
        .find_map(|k| trimmed(&data["rawInput"][*k]))
}
