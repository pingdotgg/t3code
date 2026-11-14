//! Grok's background work signals (`packages/provider-grok/src/server/xaiAcpExtension.ts`):
//! which tool starts a background shell task or a monitor, which tool or text ends one, and
//! the `x.ai/task_*` lifecycle notifications. Pure functions on tool state and text.
//!
//! T3 matches with regular expressions; this crate has no regex dependency, so each pattern
//! is a small hand-written matcher. The patterns are named next to each matcher. `\s` is
//! taken as ASCII white space.

use serde_json::Value;

use crate::tools::ToolState;

/// A background task's state as a mutation reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TaskStatus {
    Running,
    Completed,
    Failed,
}

impl TaskStatus {
    pub(crate) fn tool_status(self) -> &'static str {
        match self {
            Self::Running => "inProgress",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

/// `{ taskId, status, appendOutput }` (`extractBackgroundTaskCompletion`,
/// `extractBackgroundToolMutation`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TaskMutation {
    pub task_id: String,
    pub status: TaskStatus,
    pub append_output: String,
}

/// What a lifecycle notification describes (`xAiBackgroundTaskReport` kind).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReportKind {
    Command,
    Monitor,
}

/// `XAiBackgroundTaskLifecycleMutation`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Lifecycle {
    pub session_id: String,
    pub task_id: String,
    pub status: TaskStatus,
    pub output: Option<String>,
    pub report: Option<ReportKind>,
}

// ---- small matchers ----------------------------------------------------------------------

fn non_empty(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn record(value: Option<&Value>) -> Option<&serde_json::Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn is_ws(b: u8) -> bool {
    b.is_ascii_whitespace()
}

fn skip_ws(bytes: &[u8], mut at: usize) -> usize {
    while bytes.get(at).copied().is_some_and(is_ws) {
        at += 1;
    }
    at
}

/// Matches `[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}` (case-insensitive) at `at`; returns
/// the end.
fn uuid_at(bytes: &[u8], at: usize) -> Option<usize> {
    let mut i = at;
    for (n, group) in [8usize, 4, 4, 4, 12].iter().enumerate() {
        if n > 0 {
            if bytes.get(i) != Some(&b'-') {
                return None;
            }
            i += 1;
        }
        for _ in 0..*group {
            if !bytes.get(i).is_some_and(u8::is_ascii_hexdigit) {
                return None;
            }
            i += 1;
        }
    }
    Some(i)
}

/// `^UUID$` (case-insensitive).
pub(crate) fn is_uuid(text: &str) -> bool {
    uuid_at(text.as_bytes(), 0) == Some(text.len())
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// The byte offsets of each case-insensitive occurrence of `needle` (ASCII) in `text`.
fn find_all_ci<'a>(text: &'a str, needle: &'a str) -> impl Iterator<Item = usize> + 'a {
    let hay = text.as_bytes();
    let needle = needle.as_bytes();
    (0..hay.len()).filter(move |&at| {
        hay.get(at..at + needle.len())
            .is_some_and(|w| w.eq_ignore_ascii_case(needle))
    })
}

fn starts_ci(bytes: &[u8], at: usize, needle: &str) -> bool {
    bytes
        .get(at..at + needle.len())
        .is_some_and(|w| w.eq_ignore_ascii_case(needle.as_bytes()))
}

fn slice(text: &str, from: usize, to: usize) -> &str {
    text.get(from..to).unwrap_or("")
}

/// `monitor started\s*\(\s*task\s+(UUID)\b`.
fn monitor_ack_task_id(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    for at in find_all_ci(text, "monitor started") {
        let mut i = skip_ws(bytes, at + "monitor started".len());
        if bytes.get(i) != Some(&b'(') {
            continue;
        }
        i = skip_ws(bytes, i + 1);
        if !starts_ci(bytes, i, "task") {
            continue;
        }
        i += 4;
        let after = skip_ws(bytes, i);
        if after == i {
            continue;
        }
        if let Some(end) = uuid_at(bytes, after)
            && !bytes.get(end).copied().is_some_and(is_word)
        {
            return Some(slice(text, after, end).to_owned());
        }
    }
    None
}

/// `===\s*Task\s+(UUID)\s*===`.
fn task_header_id(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    for at in find_all_ci(text, "===") {
        let mut i = skip_ws(bytes, at + 3);
        if !starts_ci(bytes, i, "task") {
            continue;
        }
        i += 4;
        let after = skip_ws(bytes, i);
        if after == i {
            continue;
        }
        let Some(end) = uuid_at(bytes, after) else {
            continue;
        };
        let close = skip_ws(bytes, end);
        if starts_ci(bytes, close, "===") {
            return Some(slice(text, after, end).to_owned());
        }
    }
    None
}

/// `/<label>:\s*<word>/i`.
fn has_label_word(text: &str, label: &str, word: &str) -> bool {
    let bytes = text.as_bytes();
    find_all_ci(text, label).any(|at| {
        let i = skip_ws(bytes, at + label.len());
        starts_ci(bytes, i, word)
    })
}

/// `/Exit Code:\s*-?(?!0\b)\d+/i`.
fn has_nonzero_exit_code(text: &str) -> bool {
    let bytes = text.as_bytes();
    find_all_ci(text, "exit code:").any(|at| {
        let mut i = skip_ws(bytes, at + "exit code:".len());
        if bytes.get(i) == Some(&b'-') {
            i += 1;
        }
        let digits = bytes
            .get(i..)
            .unwrap_or(&[])
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
        if digits == 0 {
            return false;
        }
        // `(?!0\b)` fails only when the number starts with a lone 0 followed by a word end.
        let lone_zero =
            bytes.get(i) == Some(&b'0') && !bytes.get(i + 1).copied().is_some_and(is_word);
        !lone_zero || digits > 1
    })
}

/// Removes every `<tag>…</tag>` (case-insensitive, shortest match).
fn strip_tag_blocks(text: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = String::new();
    let mut rest = text;
    loop {
        let Some(start) = find_all_ci(rest, &open).next() else {
            out.push_str(rest);
            return out;
        };
        let after_open = start + open.len();
        let Some(end) = find_all_ci(slice(rest, after_open, rest.len()), &close).next() else {
            out.push_str(rest);
            return out;
        };
        out.push_str(slice(rest, 0, start));
        rest = rest.get(after_open + end + close.len()..).unwrap_or("");
    }
}

/// `Monitor\s+["']?[0-9a-f-]{8,}`; returns the end of the id.
fn monitor_id_mention(bytes: &[u8], at: usize) -> Option<usize> {
    if !starts_ci(bytes, at, "monitor") {
        return None;
    }
    let mut i = at + "monitor".len();
    let after = skip_ws(bytes, i);
    if after == i {
        return None;
    }
    i = after;
    if matches!(bytes.get(i), Some(b'"' | b'\'')) {
        i += 1;
    }
    let len = bytes
        .get(i..)
        .unwrap_or(&[])
        .iter()
        .take_while(|b| b.is_ascii_hexdigit() || **b == b'-')
        .count();
    (len >= 8).then_some(i + len)
}

/// `/Monitor\s+["']?[0-9a-f-]{8,}["']?\s+ended/i` and `/<monitor-event\b/i`: monitor chatter
/// that is no wake evidence.
pub(crate) fn is_monitor_chatter(text: &str) -> bool {
    let bytes = text.as_bytes();
    let event = find_all_ci(text, "<monitor-event").any(|at| {
        !bytes
            .get(at + "<monitor-event".len())
            .copied()
            .is_some_and(is_word)
    });
    if event {
        return true;
    }
    // Giving back id characters cannot help: the next character would be one of the class.
    find_all_ci(text, "monitor").any(|at| {
        let Some(mut i) = monitor_id_mention(bytes, at) else {
            return false;
        };
        if matches!(bytes.get(i), Some(b'"' | b'\'')) {
            i += 1;
        }
        let after = skip_ws(bytes, i);
        after > i && starts_ci(bytes, after, "ended")
    })
}

/// `isMonitorEndNoticeText`: `/Monitor\s+["']?[0-9a-f-]{8,}/i` and `/ended/i`.
pub(crate) fn is_monitor_end_notice(text: &str) -> bool {
    let bytes = text.as_bytes();
    find_all_ci(text, "monitor").any(|at| monitor_id_mention(bytes, at).is_some())
        && find_all_ci(text, "ended").next().is_some()
}

// ---- tool state ----------------------------------------------------------------------------

/// `xAiToolOutputText` (shared with `grok::normalize_tool`).
pub(crate) fn output_text(tool: &ToolState) -> Option<String> {
    crate::grok::output_text(tool)
}

fn title_key(tool: &ToolState) -> String {
    tool.title.as_deref().unwrap_or("").trim().to_lowercase()
}

fn raw_input(tool: &ToolState) -> Option<&serde_json::Map<String, Value>> {
    record(tool.data.get("rawInput"))
}

fn raw_output(tool: &ToolState) -> Option<&serde_json::Map<String, Value>> {
    record(tool.data.get("rawOutput"))
}

fn field(map: Option<&serde_json::Map<String, Value>>, key: &str) -> Option<String> {
    map.and_then(|m| m.get(key)).and_then(non_empty)
}

/// `isXAiMonitorTool`.
pub(crate) fn is_monitor_tool(tool: &ToolState) -> bool {
    crate::grok::is_monitor(tool)
}

/// `xAiBackgroundShellTaskId`: `BackgroundTaskStarted` completes the call while the shell
/// still runs.
pub(crate) fn background_shell_task_id(tool: &ToolState) -> Option<String> {
    let output = raw_output(tool);
    (field(output, "type").as_deref() == Some("BackgroundTaskStarted"))
        .then(|| field(output, "task_id"))
        .flatten()
}

/// `extractXAiMonitorTaskId` (`extractBackgroundTaskId`).
pub(crate) fn background_task_id(tool: &ToolState) -> Option<String> {
    if let Some(id) = background_shell_task_id(tool) {
        return Some(id);
    }
    if !is_monitor_tool(tool) {
        return None;
    }
    let output = raw_output(tool);
    if field(output, "type").is_some_and(|t| t.eq_ignore_ascii_case("monitor"))
        && let Some(id) = field(output, "taskId").or_else(|| field(output, "task_id"))
    {
        return Some(id);
    }
    if let Some(id) = output_text(tool).as_deref().and_then(monitor_ack_task_id) {
        return Some(id);
    }
    let input = raw_input(tool);
    field(input, "task_id")
        .or_else(|| field(input, "taskId"))
        .or_else(|| {
            input
                .and_then(|m| m.get("task_ids"))
                .and_then(Value::as_array)
                .and_then(|ids| ids.first())
                .and_then(non_empty)
        })
}

/// `isXAiPersistentMonitor`: persistent monitors do not hold the root turn's finalize.
pub(crate) fn is_persistent_monitor(tool: &ToolState) -> bool {
    if !is_monitor_tool(tool) {
        return false;
    }
    let output = raw_output(tool);
    if field(output, "type").is_some_and(|t| t.eq_ignore_ascii_case("monitor")) {
        return output.and_then(|m| m.get("persistent")) == Some(&Value::Bool(true));
    }
    raw_input(tool).and_then(|m| m.get("persistent")) == Some(&Value::Bool(true))
}

/// `isXAiGetSubagentOutputTool`.
fn is_get_output_tool(tool: &ToolState) -> bool {
    let title = title_key(tool);
    if title == "get_command_or_subagent_output"
        || title.contains("get_command_or_subagent_output")
        || title == "wait_commands_or_subagents"
    {
        return true;
    }
    let input = raw_input(tool);
    if field(input, "variant")
        .map(|v| v.to_lowercase())
        .is_some_and(|v| v == "taskoutput" || v == "task_output")
    {
        return true;
    }
    if field(raw_output(tool), "type")
        .map(|t| t.to_lowercase())
        .is_some_and(|t| t == "taskoutput" || t == "task_output")
    {
        return true;
    }
    title.starts_with("[subagent:")
        && input
            .and_then(|m| m.get("task_ids"))
            .is_some_and(Value::is_array)
}

fn result_record(tool: &ToolState) -> Option<&serde_json::Map<String, Value>> {
    let output = raw_output(tool)?;
    record(output.get("Result")).or_else(|| record(output.get("result")))
}

/// `structuredTaskIdFromGetOutputTool`.
fn structured_task_id(tool: &ToolState) -> Option<String> {
    let result = result_record(tool);
    let output = raw_output(tool);
    field(result, "task_id")
        .or_else(|| field(result, "taskId"))
        .or_else(|| field(output, "task_id"))
        .or_else(|| field(output, "taskId"))
}

/// `resultTaskIdFromGetOutputTool`.
fn result_task_id(tool: &ToolState, output: Option<&str>) -> Option<String> {
    if let Some(id) = structured_task_id(tool).filter(|id| is_uuid(id)) {
        return Some(id);
    }
    output.and_then(task_header_id)
}

/// `decodeByteText`.
fn byte_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(_) => value.and_then(non_empty),
        Value::Array(items) if !items.is_empty() => {
            let bytes: Option<Vec<u8>> = items
                .iter()
                .map(|v| v.as_u64().and_then(|n| u8::try_from(n).ok()))
                .collect();
            let text = String::from_utf8(bytes?).ok()?;
            let text = text.trim();
            (!text.is_empty()).then(|| text.to_owned())
        }
        _ => None,
    }
}

/// `resultFromGetOutputTool`.
fn result_text(tool: &ToolState, output: Option<&str>) -> Option<String> {
    let result = result_record(tool);
    let structured = field(result, "output")
        .or_else(|| field(result, "text"))
        .or_else(|| byte_text(result.and_then(|m| m.get("output"))));
    if let Some(structured) = structured {
        let cleaned = strip_tag_blocks(
            &strip_tag_blocks(&structured, "subagent_meta"),
            "subagent_result",
        );
        let cleaned = cleaned.trim();
        return (!cleaned.is_empty()).then(|| cleaned.to_owned());
    }
    let output = output?;
    // `/=== Output ===\s*([\s\S]*)$/i`.
    let body = find_all_ci(output, "=== output ===")
        .next()
        .map_or(output, |at| {
            output.get(at + "=== output ===".len()..).unwrap_or("")
        });
    let body = body.trim();
    (!body.is_empty()).then(|| body.to_owned())
}

/// `statusFromGetOutputTool`.
fn result_status(tool: &ToolState, output: Option<&str>) -> TaskStatus {
    if tool.status.as_deref() == Some("failed") {
        return TaskStatus::Failed;
    }
    let result = result_record(tool);
    match field(result, "status").map(|s| s.to_lowercase()).as_deref() {
        Some("completed" | "success") => return TaskStatus::Completed,
        Some("failed" | "error") => return TaskStatus::Failed,
        Some("running" | "pending") => return TaskStatus::Running,
        _ => {}
    }
    if let Some(code) = result
        .and_then(|m| m.get("exit_code"))
        .and_then(Value::as_f64)
    {
        return if code == 0.0 {
            TaskStatus::Completed
        } else {
            TaskStatus::Failed
        };
    }
    if let Some(text) = output {
        if has_label_word(text, "status:", "failed") || has_nonzero_exit_code(text) {
            return TaskStatus::Failed;
        }
        if has_label_word(text, "status:", "completed")
            || has_label_word(text, "status:", "success")
        {
            return TaskStatus::Completed;
        }
        if has_label_word(text, "status:", "running") || has_label_word(text, "status:", "pending")
        {
            return TaskStatus::Running;
        }
    }
    // A completed poll does not end its task without a task-level status or exit code.
    TaskStatus::Running
}

fn push_unique(ids: &mut Vec<String>, id: String) {
    if !ids.contains(&id) {
        ids.push(id);
    }
}

/// `extractXAiBackgroundTaskCompletion`.
fn task_completions(tool: &ToolState) -> Vec<TaskMutation> {
    if !is_get_output_tool(tool) {
        return Vec::new();
    }
    let text = output_text(tool);
    let status = result_status(tool, text.as_deref());
    let append_output = result_text(tool, text.as_deref()).unwrap_or_default();
    if let Some(task_id) = result_task_id(tool, text.as_deref()) {
        return vec![TaskMutation {
            task_id,
            status,
            append_output,
        }];
    }
    let input = raw_input(tool);
    let mut ids = Vec::new();
    for value in input
        .and_then(|m| m.get("task_ids"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .chain(input.and_then(|m| m.get("task_id")))
        .chain(input.and_then(|m| m.get("taskId")))
    {
        if let Some(id) = non_empty(value).filter(|id| is_uuid(id)) {
            push_unique(&mut ids, id);
        }
    }
    ids.into_iter()
        .map(|task_id| TaskMutation {
            task_id,
            status,
            append_output: append_output.clone(),
        })
        .collect()
}

/// `extractXAiKilledBackgroundTasks`: a finished kill ends every task it names.
fn killed_tasks(tool: &ToolState) -> Vec<TaskMutation> {
    let title = title_key(tool);
    let input = raw_input(tool);
    let output = raw_output(tool);
    let variant = field(input, "variant").map(|v| v.to_lowercase());
    let legacy = title.contains("kill_command_or_subagent") || variant.as_deref() == Some("kill");
    let typed = output.and_then(|m| m.get("type")).and_then(Value::as_str) == Some("KillTask");
    if !legacy && variant.as_deref() != Some("killtask") && !typed {
        return Vec::new();
    }
    if tool.status.as_deref() != Some("completed") {
        return Vec::new();
    }
    let outcome = output
        .and_then(|m| m.get("outcome"))
        .or_else(|| result_record(tool).and_then(|m| m.get("outcome")));
    if !legacy
        && let Some(outcome) = outcome
        && outcome != "killed"
        && outcome != "already_exited"
    {
        return Vec::new();
    }
    let mut ids = Vec::new();
    for value in input
        .and_then(|m| m.get("task_ids"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .chain(input.and_then(|m| m.get("task_id")))
        .chain(input.and_then(|m| m.get("taskId")))
    {
        if let Some(id) = non_empty(value) {
            push_unique(&mut ids, id);
        }
    }
    ids.into_iter()
        .map(|task_id| TaskMutation {
            task_id,
            status: TaskStatus::Completed,
            append_output: String::new(),
        })
        .collect()
}

/// Grok's `extractBackgroundTaskCompletion`: get-output results, then kills.
pub(crate) fn background_task_completions(tool: &ToolState) -> Vec<TaskMutation> {
    let mut all = task_completions(tool);
    all.extend(killed_tasks(tool));
    all
}

/// `extractXAiAcpBackgroundToolMutation`: monitor events and ends in agent text.
pub(crate) fn background_tool_mutations(text: &str) -> Vec<TaskMutation> {
    let bytes = text.as_bytes();
    let mut mutations = Vec::new();
    // `<monitor-event\s+task_id=["']?(UUID)["']?\s*>\s*([\s\S]*?)\s*</monitor-event>`.
    for at in find_all_ci(text, "<monitor-event") {
        let mut i = at + "<monitor-event".len();
        let after = skip_ws(bytes, i);
        if after == i || !starts_ci(bytes, after, "task_id=") {
            continue;
        }
        i = after + "task_id=".len();
        if matches!(bytes.get(i), Some(b'"' | b'\'')) {
            i += 1;
        }
        let Some(end) = uuid_at(bytes, i) else {
            continue;
        };
        let id = slice(text, i, end).to_owned();
        let mut j = end;
        if matches!(bytes.get(j), Some(b'"' | b'\'')) {
            j += 1;
        }
        j = skip_ws(bytes, j);
        if bytes.get(j) != Some(&b'>') {
            continue;
        }
        let body_start = j + 1;
        let Some(close) =
            find_all_ci(slice(text, body_start, text.len()), "</monitor-event>").next()
        else {
            continue;
        };
        let line = slice(text, body_start, body_start + close).trim();
        mutations.push(TaskMutation {
            task_id: id,
            status: TaskStatus::Running,
            append_output: if line.is_empty() {
                String::new()
            } else {
                format!("{line}\n")
            },
        });
    }
    // `<monitor\s[^>]*task_id=["']?(UUID)["']?[^>]*>\s*([\s\S]*?)\s*</monitor>`.
    for at in find_all_ci(text, "<monitor") {
        let i = at + "<monitor".len();
        if !bytes.get(i).copied().is_some_and(is_ws) {
            continue;
        }
        let Some(tag_end) = bytes
            .get(i..)
            .and_then(|rest| rest.iter().position(|b| *b == b'>'))
        else {
            continue;
        };
        let tag_end = i + tag_end;
        let attrs = slice(text, i, tag_end);
        let Some(id) = find_all_ci(attrs, "task_id=").find_map(|p| {
            let ab = attrs.as_bytes();
            let mut k = p + "task_id=".len();
            if matches!(ab.get(k), Some(b'"' | b'\'')) {
                k += 1;
            }
            uuid_at(ab, k).map(|end| slice(attrs, k, end).to_owned())
        }) else {
            continue;
        };
        let body_start = tag_end + 1;
        let Some(close) = find_all_ci(slice(text, body_start, text.len()), "</monitor>").next()
        else {
            continue;
        };
        let lines = slice(text, body_start, body_start + close).trim();
        mutations.push(TaskMutation {
            task_id: id,
            status: TaskStatus::Running,
            append_output: if lines.is_empty() {
                String::new()
            } else {
                format!("{lines}\n")
            },
        });
    }
    // `Monitor\s+["']?(UUID)["']?\s+ended`.
    for at in find_all_ci(text, "monitor") {
        let mut i = at + "monitor".len();
        let after = skip_ws(bytes, i);
        if after == i {
            continue;
        }
        i = after;
        if matches!(bytes.get(i), Some(b'"' | b'\'')) {
            i += 1;
        }
        let Some(end) = uuid_at(bytes, i) else {
            continue;
        };
        let id = slice(text, i, end).to_owned();
        let mut j = end;
        if matches!(bytes.get(j), Some(b'"' | b'\'')) {
            j += 1;
        }
        let k = skip_ws(bytes, j);
        if k == j || !starts_ci(bytes, k, "ended") {
            continue;
        }
        let header_end = k + "ended".len();
        // Only the header describes the outcome; output may hold error words.
        let tail = slice(text, header_end, text.len());
        let tail = tail.split('\n').next().unwrap_or("");
        let outcome = format!("{}{tail}", slice(text, at, header_end).trim());
        let lower = outcome.to_lowercase();
        let clean = exited_code_zero(&lower) || lower.contains("ended cleanly");
        let bad = ["exited", "failed", "error", "signal"]
            .iter()
            .any(|w| lower.contains(w));
        let status = if clean || !bad {
            TaskStatus::Completed
        } else {
            TaskStatus::Failed
        };
        let summary = strip_reminder_tags(text);
        let summary = summary.trim();
        mutations.push(TaskMutation {
            task_id: id,
            status,
            append_output: if summary.is_empty() {
                "Monitor ended.\n".to_owned()
            } else {
                format!("{summary}\n")
            },
        });
    }
    mutations
}

/// `/exited\s*\(\s*code\s*0\s*\)/i` on lower-case text.
fn exited_code_zero(lower: &str) -> bool {
    let bytes = lower.as_bytes();
    find_all_ci(lower, "exited").any(|at| {
        let mut i = skip_ws(bytes, at + "exited".len());
        if bytes.get(i) != Some(&b'(') {
            return false;
        }
        i = skip_ws(bytes, i + 1);
        if !starts_ci(bytes, i, "code") {
            return false;
        }
        i = skip_ws(bytes, i + 4);
        if bytes.get(i) != Some(&b'0') {
            return false;
        }
        i = skip_ws(bytes, i + 1);
        bytes.get(i) == Some(&b')')
    })
}

/// `text.replace(/<\/?system-reminder>/gi, "")`.
fn strip_reminder_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        let open = find_all_ci(rest, "<system-reminder>").next();
        let close = find_all_ci(rest, "</system-reminder>").next();
        let next = match (open, close) {
            (Some(o), Some(c)) if c < o => Some((c, "</system-reminder>".len())),
            (Some(o), _) => Some((o, "<system-reminder>".len())),
            (None, Some(c)) => Some((c, "</system-reminder>".len())),
            (None, None) => None,
        };
        let Some((at, len)) = next else {
            out.push_str(rest);
            return out;
        };
        out.push_str(slice(rest, 0, at));
        rest = rest.get(at + len..).unwrap_or("");
    }
}

// ---- notifications -------------------------------------------------------------------------

/// `isXAiTaskCompletedWakeNotification`: a frame of Grok's own `task-completed-*` turn.
pub(crate) fn is_task_completed_wake(params: &Value) -> bool {
    params["_meta"]["promptId"]
        .as_str()
        .is_some_and(|id| id.starts_with("task-completed-"))
}

/// `xAiBackgroundTaskReport`'s kind.
fn report_kind(update: &Value) -> Option<ReportKind> {
    let snapshot = &update["task_snapshot"];
    let monitor_description = non_empty(&update["monitor_description"]);
    let display = non_empty(&snapshot["display_command"]);
    let is_monitor = snapshot["kind"] == "monitor"
        || monitor_description.is_some()
        || display
            .as_deref()
            .is_some_and(|d| d.starts_with("[monitor]"));
    let is_command = snapshot["kind"] == "bash"
        || snapshot["command"].is_string()
        || update["command"].is_string();
    if is_monitor {
        Some(ReportKind::Monitor)
    } else if is_command {
        Some(ReportKind::Command)
    } else {
        None
    }
}

/// `xAiBackgroundTaskLifecycleMutation` of an `x.ai/task_backgrounded` (`running`) or
/// `x.ai/task_completed` (`completed`) notification.
pub(crate) fn lifecycle(params: &Value, completed: bool) -> Option<Lifecycle> {
    let session_id = params["sessionId"].as_str()?.to_owned();
    let update = &params["update"];
    update["sessionUpdate"].as_str()?;
    let snapshot = &update["task_snapshot"];
    let task_id = non_empty(&snapshot["task_id"])
        .or_else(|| non_empty(&update["task_id"]))
        .or_else(|| non_empty(&update["tool_call_id"]))?;
    let exit_code = snapshot["exit_code"].as_f64();
    let status = if !completed {
        TaskStatus::Running
    } else if exit_code.is_some_and(|code| code != 0.0) {
        TaskStatus::Failed
    } else {
        TaskStatus::Completed
    };
    Some(Lifecycle {
        session_id,
        task_id,
        status,
        output: snapshot["output"].as_str().map(str::to_owned),
        report: report_kind(update),
    })
}

// ---- subagents -----------------------------------------------------------------------------

/// `AcpAdapterV2SubagentUpdate`. `status` is one of `pending`, `running`, `idle`,
/// `completed`, `failed`, `interrupted`, `cancelled`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SubagentUpdate {
    pub native_task_id: String,
    pub prompt: String,
    pub title: Option<String>,
    pub model: Option<String>,
    pub status: String,
    pub child_session_id: Option<String>,
    pub result: Option<String>,
    pub suppress_normal_tool: bool,
}

/// `acpSubagentStatusIsTerminal`.
pub(crate) fn subagent_status_is_terminal(status: &str) -> bool {
    matches!(
        status,
        "completed" | "failed" | "interrupted" | "cancelled" | "idle"
    )
}

/// `acpSubagentStatusBlocksTurnSettlement`.
pub(crate) fn subagent_status_blocks_settlement(status: &str) -> bool {
    status == "running" || status == "pending"
}

/// `(?:^|\n)\s*<label>\s*(UUID)\b`: the first id after a line-leading label.
fn line_label_uuid(text: &str, label: &str) -> Option<String> {
    let bytes = text.as_bytes();
    find_all_ci(text, label).find_map(|at| {
        // Only white space between the line start and the label.
        let before = text.get(..at).unwrap_or("");
        let line_start = before.rfind('\n').map_or(0, |n| n + 1);
        if !before.get(line_start..).unwrap_or("").bytes().all(is_ws) {
            return None;
        }
        let i = skip_ws(bytes, at + label.len());
        let end = uuid_at(bytes, i)?;
        (!bytes.get(end).copied().is_some_and(is_word)).then(|| slice(text, i, end).to_owned())
    })
}

/// `extractXAiChildSessionId`.
fn child_session_id(output: Option<&str>) -> Option<String> {
    let output = output?;
    line_label_uuid(output, "agent id:")
        .or_else(|| line_label_uuid(output, "subagent_id:"))
        .or_else(|| task_header_id(output))
}

/// `isXAiAsyncSpawnAck`.
fn is_async_spawn_ack(output: Option<&str>) -> bool {
    let Some(output) = output else { return false };
    if find_all_ci(output, "subagent started in background")
        .next()
        .is_some()
    {
        return true;
    }
    let bytes = output.as_bytes();
    let has_id = find_all_ci(output, "subagent_id:")
        .any(|at| uuid_at(bytes, skip_ws(bytes, at + "subagent_id:".len())).is_some());
    has_id
        && find_all_ci(output, "get_command_or_subagent_output")
            .next()
            .is_some()
}

/// `isXAiSpawnOrTaskTool`.
fn is_spawn_or_task_tool(tool: &ToolState) -> bool {
    let title = title_key(tool);
    if title == "task" || title == "spawn_subagent" || title.contains("spawn subagent") {
        return true;
    }
    let input = raw_input(tool);
    if field(input, "variant")
        .map(|v| v.to_lowercase())
        .is_some_and(|v| v == "cursortask" || v == "task" || v == "spawn_subagent")
    {
        return true;
    }
    field(input, "subagent_type").is_some() || field(input, "subagentType").is_some()
}

/// Drops each line `(?:^|\n)\s*<label>\s*UUID[^\n]*(?:\n|$)` (the match becomes one line
/// break, so the line goes). The result is trimmed by the caller.
fn drop_label_lines(text: &str, label: &str) -> String {
    text.split('\n')
        .filter(|line| {
            let bytes = line.trim_start().as_bytes();
            !(starts_ci(bytes, 0, label) && uuid_at(bytes, skip_ws(bytes, label.len())).is_some())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `taskIdsFromGetOutputTool`.
fn get_output_task_ids(tool: &ToolState) -> Vec<String> {
    let input = raw_input(tool);
    let mut ids = Vec::new();
    for value in input
        .and_then(|m| m.get("task_ids"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .chain(input.and_then(|m| m.get("task_id")))
        .chain(input.and_then(|m| m.get("taskId")))
    {
        if let Some(id) = non_empty(value).filter(|id| is_uuid(id)) {
            push_unique(&mut ids, id);
        }
    }
    if let Some(id) = result_task_id(tool, output_text(tool).as_deref()) {
        push_unique(&mut ids, id);
    }
    ids
}

fn status_label(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Running => "running",
        TaskStatus::Completed => "completed",
        TaskStatus::Failed => "failed",
    }
}

/// `extractXAiAcpSubagentUpdate`: a spawn ACK keeps its subagent running until a child or
/// hydration terminal.
pub(crate) fn subagent_update(tool: &ToolState) -> Option<SubagentUpdate> {
    let output = output_text(tool);
    if is_get_output_tool(tool) {
        if structured_task_id(tool).is_some_and(|id| !is_uuid(&id)) {
            return None;
        }
        let child = result_task_id(tool, output.as_deref())
            .or_else(|| get_output_task_ids(tool).into_iter().next())
            .or_else(|| child_session_id(output.as_deref()))?;
        return Some(SubagentUpdate {
            native_task_id: tool.tool_call_id.clone(),
            prompt: String::new(),
            title: None,
            model: None,
            status: status_label(result_status(tool, output.as_deref())).to_owned(),
            child_session_id: Some(child),
            result: result_text(tool, output.as_deref()),
            suppress_normal_tool: true,
        });
    }
    if !is_spawn_or_task_tool(tool) {
        return None;
    }
    let child = child_session_id(output.as_deref());
    let async_ack = is_async_spawn_ack(output.as_deref());
    let legacy = output.as_deref().map(|text| {
        drop_label_lines(&drop_label_lines(text, "agent id:"), "subagent_id:")
            .trim()
            .to_owned()
    });
    let status = if tool.status.as_deref() == Some("failed") {
        "failed"
    } else if async_ack {
        "running"
    } else if tool.status.as_deref() == Some("completed") {
        "completed"
    } else {
        "running"
    };
    let input = raw_input(tool);
    Some(SubagentUpdate {
        native_task_id: tool.tool_call_id.clone(),
        prompt: field(input, "prompt").unwrap_or_default(),
        title: field(input, "description"),
        model: field(input, "model"),
        status: status.to_owned(),
        child_session_id: child,
        result: if async_ack {
            None
        } else {
            legacy.filter(|l| !l.is_empty())
        },
        suppress_normal_tool: true,
    })
}

/// `extractXAiAcpSubagentEndNotice`: `Background subagent <id> …` with its outcome.
pub(crate) fn subagent_end_notice(text: &str) -> Option<(String, &'static str)> {
    let bytes = text.as_bytes();
    let (id, end) = find_all_ci(text, "background subagent").find_map(|at| {
        let mut i = at + "background subagent".len();
        let after = skip_ws(bytes, i);
        if after == i {
            return None;
        }
        i = after;
        if matches!(bytes.get(i), Some(b'"' | b'\'')) {
            i += 1;
        }
        let end = uuid_at(bytes, i)?;
        let mut stop = end;
        if matches!(bytes.get(stop), Some(b'"' | b'\'')) {
            stop += 1;
        }
        Some((slice(text, i, end).to_owned(), stop))
    })?;
    let tail = strip_leading_paren_group(slice(text, end, text.len())).to_lowercase();
    if tail.contains("completed successfully") {
        return Some((id, "completed"));
    }
    let words = [
        "failed",
        "errored",
        "error",
        "crashed",
        "cancelled",
        "canceled",
        "interrupted",
    ];
    if words.iter().any(|w| has_word(&tail, w)) || tail.contains("timed out") {
        return Some((id, "failed"));
    }
    if ["completed", "finished", "ended"]
        .iter()
        .any(|w| has_word(&tail, w))
    {
        return Some((id, "completed"));
    }
    None
}

/// `\bword\b` on lower-case text.
fn has_word(text: &str, word: &str) -> bool {
    let bytes = text.as_bytes();
    find_all_ci(text, word).any(|at| {
        let before = at.checked_sub(1).and_then(|b| bytes.get(b)).copied();
        let after = bytes.get(at + word.len()).copied();
        !before.is_some_and(is_word) && !after.is_some_and(is_word)
    })
}

/// `stripLeadingBalancedParenGroup`.
fn strip_leading_paren_group(text: &str) -> &str {
    let trimmed = text.trim_start();
    if !trimmed.starts_with('(') {
        return trimmed;
    }
    let mut depth = 0i32;
    for (at, ch) in trimmed.char_indices() {
        if ch == '(' {
            depth += 1;
        } else if ch == ')' {
            depth -= 1;
            if depth == 0 {
                return trimmed.get(at + 1..).unwrap_or("").trim_start();
            }
        }
    }
    trimmed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool(data: Value, title: Option<&str>, status: Option<&str>) -> ToolState {
        ToolState {
            tool_call_id: "t".into(),
            kind: None,
            title: title.map(str::to_owned),
            status: status.map(str::to_owned),
            command: None,
            detail: None,
            data: data.as_object().cloned().unwrap_or_default(),
        }
    }

    const ID: &str = "00000000-0000-4000-8000-000000000002";

    #[test]
    fn matches_uuids_and_headers() {
        assert!(is_uuid(ID));
        assert!(is_uuid("ABCDEF00-0000-4000-8000-000000000002"));
        assert!(!is_uuid("call-00000000-0000-4000-8000-000000000002"));
        assert_eq!(
            task_header_id(&format!("x\n=== Task {ID} ===\n")),
            Some(ID.into())
        );
        assert_eq!(
            monitor_ack_task_id(&format!("Monitor started (task {ID})")),
            Some(ID.into())
        );
    }

    #[test]
    fn reads_background_starts_and_monitors() {
        let started = tool(
            json!({"rawOutput": {"type": "BackgroundTaskStarted", "task_id": ID}}),
            None,
            Some("completed"),
        );
        assert_eq!(background_task_id(&started), Some(ID.into()));
        assert_eq!(background_shell_task_id(&started), Some(ID.into()));
        let monitor = tool(
            json!({"rawOutput": {"type": "Monitor", "taskId": ID, "persistent": true}}),
            Some("monitor"),
            Some("completed"),
        );
        assert_eq!(background_task_id(&monitor), Some(ID.into()));
        assert!(is_persistent_monitor(&monitor));
        assert_eq!(background_shell_task_id(&monitor), None);
    }

    #[test]
    fn reads_get_output_and_kill_results() {
        let output = tool(
            json!({"rawInput": {"task_ids": [ID]}, "rawOutput": {"type": "TaskOutput", "Result": {"task_id": ID, "status": "completed", "output": "tock 3\n"}}}),
            Some("get_command_or_subagent_output"),
            Some("completed"),
        );
        assert_eq!(
            background_task_completions(&output),
            vec![TaskMutation {
                task_id: ID.into(),
                status: TaskStatus::Completed,
                append_output: "tock 3".into()
            }]
        );
        let polling = tool(
            json!({"rawInput": {"task_ids": [ID]}, "rawOutput": "Status: running"}),
            Some("get_command_or_subagent_output"),
            Some("completed"),
        );
        assert_eq!(
            background_task_completions(&polling)[0].status,
            TaskStatus::Running
        );
        let failed = tool(
            json!({"rawInput": {"task_ids": [ID]}, "rawOutput": "Exit Code: 2"}),
            Some("get_command_or_subagent_output"),
            Some("completed"),
        );
        assert_eq!(
            background_task_completions(&failed)[0].status,
            TaskStatus::Failed
        );
        assert!(!has_nonzero_exit_code("Exit Code: 0"));
        assert!(has_nonzero_exit_code("Exit Code: 01"));
        let kill = tool(
            json!({"rawInput": {"variant": "KillTask", "task_ids": ["a", "a"]}, "rawOutput": {"type": "KillTask", "Result": {"outcome": "killed"}}}),
            None,
            Some("completed"),
        );
        assert_eq!(background_task_completions(&kill).len(), 1);
    }

    #[test]
    fn reads_monitor_text() {
        let text = format!(
            "<monitor-event task_id=\"{ID}\">tick 1</monitor-event>\n<system-reminder>Monitor {ID} ended (exited (code 0))</system-reminder>"
        );
        let mutations = background_tool_mutations(&text);
        assert_eq!(mutations.len(), 2);
        assert_eq!(mutations[0].append_output, "tick 1\n");
        assert_eq!(mutations[1].status, TaskStatus::Completed);
        assert!(is_monitor_chatter(&text));
        assert!(is_monitor_chatter(&format!("Monitor '{ID}' ended")));
        assert!(!is_monitor_chatter("Monitor abc ended"));
        assert!(is_monitor_end_notice(&format!("Monitor {ID} has ended")));
        assert_eq!(
            background_tool_mutations(&format!("Monitor {ID} ended with signal 9"))[0].status,
            TaskStatus::Failed
        );
        assert_eq!(
            strip_tag_blocks("a<subagent_meta>x</subagent_meta>b", "subagent_meta"),
            "ab"
        );
    }

    #[test]
    fn reads_lifecycle_notifications() {
        let done = json!({"sessionId": "s", "update": {"sessionUpdate": "task_completed", "task_snapshot": {"task_id": ID, "output": "o", "exit_code": 1, "kind": "bash"}}});
        let life = lifecycle(&done, true).unwrap();
        assert_eq!(life.status, TaskStatus::Failed);
        assert_eq!(life.report, Some(ReportKind::Command));
        let started = json!({"sessionId": "s", "update": {"sessionUpdate": "task_backgrounded", "tool_call_id": "c", "task_id": ID, "command": "x"}});
        assert_eq!(
            lifecycle(&started, false).unwrap().status,
            TaskStatus::Running
        );
        assert!(is_task_completed_wake(
            &json!({"_meta": {"promptId": "task-completed-1"}})
        ));
    }

    #[test]
    fn reads_subagent_updates() {
        let spawn = tool(
            json!({"rawInput": {"variant": "Task", "prompt": "p", "description": "d"}, "rawOutput": format!("Subagent started in background\nsubagent_id: {ID}")}),
            Some("spawn_subagent"),
            Some("completed"),
        );
        let update = subagent_update(&spawn).unwrap();
        assert_eq!(update.status, "running");
        assert_eq!(update.child_session_id.as_deref(), Some(ID));
        assert_eq!(update.result, None);
        let hydration = tool(
            json!({"rawInput": {"task_ids": [ID]}, "rawOutput": {"type": "TaskOutput", "Result": {"task_id": ID, "status": "completed", "output": "<subagent_meta>m</subagent_meta>DONE"}}}),
            Some("get_command_or_subagent_output"),
            Some("completed"),
        );
        let update = subagent_update(&hydration).unwrap();
        assert_eq!(update.prompt, "");
        assert_eq!(update.result.as_deref(), Some("DONE"));
        assert_eq!(
            subagent_end_notice(&format!(
                "Background subagent {ID} (x (y) failed) completed successfully"
            )),
            Some((ID.to_owned(), "completed"))
        );
        assert_eq!(
            subagent_end_notice(&format!("Background subagent '{ID}' crashed")),
            Some((ID.to_owned(), "failed"))
        );
        assert_eq!(
            drop_label_lines(&format!("a\n  Agent ID: {ID} x\nb"), "agent id:"),
            "a\nb"
        );
    }
}
