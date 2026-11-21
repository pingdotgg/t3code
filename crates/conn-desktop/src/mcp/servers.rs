//! The MCP panel's server drafts and the pure helpers around them: command lines, `.mcp.json`,
//! tool input schemas turned into form fields, agent results, and URI templates
//! (Conn's `apps/web/src/mcp/mcpServers.ts`).

use std::collections::hash_map::RandomState;
use std::collections::{BTreeMap, HashMap};
use std::hash::{BuildHasher, Hasher};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value, json};

use super::types::{McpHeader, McpResponse, McpServer};

/// How the panel reaches a server.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    #[default]
    Stdio,
    Http,
    Sse,
}

impl McpTransport {
    pub const ALL: [Self; 3] = [Self::Stdio, Self::Http, Self::Sse];

    /// The transport menu's label.
    pub fn label(self) -> &'static str {
        match self {
            Self::Stdio => "STDIO",
            Self::Http => "HTTP",
            Self::Sse => "SSE",
        }
    }
}

/// One header or environment row of the server form (Conn's `ApiHeaderRow`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpRow {
    pub id: String,
    pub name: String,
    pub value: String,
    pub enabled: bool,
}

impl McpRow {
    /// An enabled row with a fresh id.
    pub fn new(name: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            id: new_row_id(),
            name: name.into(),
            value: value.into(),
            enabled: true,
        }
    }
}

/// A random 8-character base-36 id (Conn's `newRowId`).
pub fn new_row_id() -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(std::time::UNIX_EPOCH.elapsed().map_or(0, |d| d.as_nanos()));
    let mut seed = hasher.finish();
    (0..8)
        .map(|_| {
            let digit = DIGITS[usize::try_from(seed % 36).unwrap_or(0)];
            seed /= 36;
            char::from(digit)
        })
        .collect()
}

/// A saved server as the panel edits it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerDraft {
    pub id: String,
    pub name: String,
    pub transport: McpTransport,
    /// stdio: the command and its arguments, as typed in a shell.
    pub command_line: String,
    /// http and sse: the server URL.
    pub url: String,
    pub headers: Vec<McpRow>,
    pub env: Vec<McpRow>,
    /// stdio: the folder the command runs in; empty for the project folder.
    pub cwd: String,
}

/// A new HTTP server at the project's app URL (Laravel MCP serves `/mcp`), or a blank one.
pub fn new_mcp_server(base_url: Option<&str>) -> McpServerDraft {
    let base_url = base_url.filter(|url| !url.is_empty());
    McpServerDraft {
        id: new_row_id(),
        transport: if base_url.is_some() {
            McpTransport::Http
        } else {
            McpTransport::Stdio
        },
        url: base_url.map_or_else(String::new, |url| {
            format!("{}/mcp", url.trim_end_matches('/'))
        }),
        ..McpServerDraft::default()
    }
}

/// The server's name, or what it runs or reaches.
pub fn mcp_server_label(server: &McpServerDraft) -> String {
    let name = server.name.trim();
    if !name.is_empty() {
        return name.to_owned();
    }
    let target = match server.transport {
        McpTransport::Stdio => server.command_line.trim(),
        McpTransport::Http | McpTransport::Sse => server.url.trim(),
    };
    if target.is_empty() {
        "New server".into()
    } else {
        target.to_owned()
    }
}

/// Name-value pairs in their JSON order (a JSON object of strings; other values are dropped).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct McpPairs(pub Vec<(String, String)>);

impl<'de> Deserialize<'de> for McpPairs {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let map = Map::<String, Value>::deserialize(deserializer)?;
        Ok(Self(
            map.into_iter()
                .filter_map(|(name, value)| match value {
                    Value::String(value) => Some((name, value)),
                    _ => None,
                })
                .collect(),
        ))
    }
}

fn rows_from_pairs(pairs: &McpPairs) -> Vec<McpRow> {
    pairs
        .0
        .iter()
        .map(|(name, value)| McpRow::new(name.clone(), value.clone()))
        .collect()
}

/// An agent's server to add or update (Conn's `AgentPanelMcpServer`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentMcpServer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// For `url`: http (default) or sse.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<McpTransport>,
    /// A stdio server's command line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<McpPairs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<McpPairs>,
}

/// The saved server an agent's request updates (same name, else same URL or command), or a
/// new one, and whether it is new. Headers and env replace the saved rows when given.
pub fn agent_server_draft(
    servers: &[McpServerDraft],
    request: &AgentMcpServer,
) -> (McpServerDraft, bool) {
    let name = request
        .name
        .as_deref()
        .map(|name| name.trim().to_lowercase());
    let url = request.url.as_deref().map(str::trim);
    let command_line = request.command.as_deref().map(str::trim);
    let existing = name
        .as_deref()
        .filter(|name| !name.is_empty())
        .and_then(|name| {
            servers
                .iter()
                .find(|server| server.name.trim().to_lowercase() == name)
        })
        .or_else(|| {
            servers.iter().find(|server| match url {
                Some(url) => server.transport != McpTransport::Stdio && server.url.trim() == url,
                None => {
                    server.transport == McpTransport::Stdio
                        && Some(server.command_line.trim()) == command_line
                }
            })
        });
    let is_new = existing.is_none();
    let mut draft = existing.cloned().unwrap_or_else(|| new_mcp_server(None));
    if let Some(name) = &request.name {
        draft.name = name.trim().to_owned();
    }
    match url {
        Some(url) => {
            draft.transport = request.transport.unwrap_or(McpTransport::Http);
            draft.url = url.to_owned();
        }
        None => {
            draft.transport = McpTransport::Stdio;
            if let Some(command_line) = command_line {
                draft.command_line = command_line.to_owned();
            }
        }
    }
    if let Some(headers) = &request.headers {
        draft.headers = rows_from_pairs(headers);
    }
    if let Some(env) = &request.env {
        draft.env = rows_from_pairs(env);
    }
    (draft, is_new)
}

/// Splits a command line like a POSIX shell does for words and quotes (no expansion).
pub fn split_command_line(line: &str) -> Vec<String> {
    let chars: Vec<char> = line.chars().collect();
    let mut words = Vec::new();
    let mut word = String::new();
    let mut started = false;
    let mut quote: Option<char> = None;
    let mut index = 0;
    while index < chars.len() {
        let char = chars[index];
        let next = chars.get(index + 1).copied();
        if let Some(open) = quote {
            if char == open {
                quote = None;
            } else if char == '\\'
                && open == '"'
                && next.is_some_and(|next| matches!(next, '"' | '\\' | '$' | '`'))
            {
                index += 1;
                word.push(chars[index]);
            } else {
                word.push(char);
            }
        } else if char == '"' || char == '\'' {
            quote = Some(char);
            started = true;
        } else if char == '\\' && next.is_some() {
            index += 1;
            word.push(chars[index]);
            started = true;
        } else if char.is_whitespace() {
            if started {
                words.push(std::mem::take(&mut word));
            }
            word.clear();
            started = false;
        } else {
            word.push(char);
            started = true;
        }
        index += 1;
    }
    if started {
        words.push(word);
    }
    words
}

/// Quotes a word only when a shell would split or expand it.
pub fn quote_word(word: &str) -> String {
    let safe = !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./~-".contains(c));
    if safe {
        word.to_owned()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

fn enabled_rows(rows: &[McpRow]) -> impl Iterator<Item = &McpRow> {
    rows.iter()
        .filter(|row| row.enabled && !row.name.trim().is_empty())
}

/// The draft as the desktop connects to it; `project_cwd` stands in for an empty folder.
pub fn to_desktop_mcp_server(
    server: &McpServerDraft,
    project_cwd: Option<&str>,
) -> Result<McpServer, String> {
    if server.transport == McpTransport::Stdio {
        let mut words = split_command_line(&server.command_line).into_iter();
        let command = words
            .next()
            .filter(|command| !command.is_empty())
            .ok_or("Enter the command that starts the server.")?;
        let cwd = server.cwd.trim();
        return Ok(McpServer::Stdio {
            command,
            args: words.collect(),
            env: enabled_rows(&server.env)
                .map(|row| (row.name.trim().to_owned(), row.value.clone()))
                .collect::<BTreeMap<_, _>>(),
            cwd: if cwd.is_empty() {
                project_cwd.map(str::to_owned)
            } else {
                Some(cwd.to_owned())
            },
        });
    }
    let url = server.url.trim();
    if url.is_empty() {
        return Err("Enter the server URL.".into());
    }
    let headers = enabled_rows(&server.headers)
        .map(|row| McpHeader {
            name: row.name.trim().to_owned(),
            value: row.value.clone(),
        })
        .collect();
    Ok(if server.transport == McpTransport::Sse {
        McpServer::Sse {
            url: url.to_owned(),
            headers,
        }
    } else {
        McpServer::Http {
            url: url.to_owned(),
            headers,
        }
    })
}

fn rows_from(record: Option<&Value>) -> Vec<McpRow> {
    let Some(Value::Object(record)) = record else {
        return Vec::new();
    };
    record
        .iter()
        .filter_map(|(name, value)| value.as_str().map(|value| McpRow::new(name.clone(), value)))
        .collect()
}

/// The servers in a project's `.mcp.json` (Claude Code's `mcpServers` or VS Code's `servers`).
/// Ids are stable per name, so the panel can tell an imported server from a new one.
pub fn servers_from_mcp_json(contents: &str) -> Vec<McpServerDraft> {
    let Ok(Value::Object(root)) = serde_json::from_str::<Value>(contents) else {
        return Vec::new();
    };
    let servers = root
        .get("mcpServers")
        .filter(|value| !value.is_null())
        .or_else(|| root.get("servers"));
    let Some(Value::Object(servers)) = servers else {
        return Vec::new();
    };
    servers
        .iter()
        .filter_map(|(name, value)| {
            let entry = value.as_object()?;
            let base = McpServerDraft {
                id: format!("mcp.json:{name}"),
                name: name.clone(),
                ..McpServerDraft::default()
            };
            if let Some(url) = entry.get("url").and_then(Value::as_str) {
                return Some(McpServerDraft {
                    transport: if entry.get("type").and_then(Value::as_str) == Some("sse") {
                        McpTransport::Sse
                    } else {
                        McpTransport::Http
                    },
                    url: url.to_owned(),
                    headers: rows_from(entry.get("headers")),
                    ..base
                });
            }
            let command = entry.get("command").and_then(Value::as_str)?;
            let args = entry
                .get("args")
                .and_then(Value::as_array)
                .map(|args| args.iter().filter_map(Value::as_str).collect::<Vec<_>>())
                .unwrap_or_default();
            Some(McpServerDraft {
                transport: McpTransport::Stdio,
                command_line: std::iter::once(command)
                    .chain(args)
                    .map(quote_word)
                    .collect::<Vec<_>>()
                    .join(" "),
                env: rows_from(entry.get("env")),
                cwd: entry
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                ..base
            })
        })
        .collect()
}

// ─── Tool input schemas ─────────────────────────────────────────────────────

/// How a form field is edited.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpFieldType {
    String,
    Number,
    Integer,
    Boolean,
    Enum,
    Json,
}

/// One top-level property of a tool's input schema.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpField {
    pub name: String,
    pub field_type: McpFieldType,
    pub required: bool,
    pub description: Option<String>,
    pub options: Vec<String>,
    /// The schema's default, as the form's text.
    pub default_text: String,
}

fn field_type(schema: &Map<String, Value>) -> McpFieldType {
    if let Some(Value::Array(values)) = schema.get("enum")
        && values.iter().all(Value::is_string)
    {
        return McpFieldType::Enum;
    }
    let kind = match schema.get("type") {
        Some(Value::Array(types)) => types
            .iter()
            .find(|candidate| candidate.as_str() != Some("null")),
        other => other,
    };
    match kind.and_then(Value::as_str) {
        Some("string") => McpFieldType::String,
        Some("number") => McpFieldType::Number,
        Some("integer") => McpFieldType::Integer,
        Some("boolean") => McpFieldType::Boolean,
        _ => McpFieldType::Json,
    }
}

/// JavaScript's `String(value)` for JSON values.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        other => other.to_string(),
    }
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

/// One form field per top-level property; objects and arrays are edited as JSON.
pub fn fields_from_schema(schema: &Value) -> Vec<McpField> {
    let Some(Value::Object(properties)) = schema.get("properties") else {
        return Vec::new();
    };
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|names| names.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let empty = Map::new();
    properties
        .iter()
        .map(|(name, value)| {
            let spec = value.as_object().unwrap_or(&empty);
            let field_type = field_type(spec);
            McpField {
                name: name.clone(),
                field_type,
                required: required.contains(&name.as_str()),
                description: spec
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                options: if field_type == McpFieldType::Enum {
                    spec.get("enum")
                        .and_then(Value::as_array)
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_owned)
                                .collect()
                        })
                        .unwrap_or_default()
                } else {
                    Vec::new()
                },
                default_text: match spec.get("default") {
                    None => String::new(),
                    Some(value) if field_type == McpFieldType::Json => pretty(value),
                    Some(value) => js_string(value),
                },
            }
        })
        .collect()
}

/// A JSON number, whole when it is one (JavaScript has one number type).
fn json_number(number: f64) -> Value {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    if number.fract() == 0.0 && number.abs() <= MAX_SAFE {
        #[expect(clippy::cast_possible_truncation, reason = "whole and within 2^53")]
        let whole = number as i64;
        Value::from(whole)
    } else {
        json!(number)
    }
}

/// The call's arguments from the form's text values; empty optional fields are left out.
pub fn arguments_from_fields(
    fields: &[McpField],
    values: &HashMap<String, String>,
) -> Result<Map<String, Value>, String> {
    let mut args = Map::new();
    for field in fields {
        let text = values.get(&field.name).unwrap_or(&field.default_text);
        if text.trim().is_empty() && field.field_type != McpFieldType::String {
            if field.required {
                return Err(format!("{} is required.", field.name));
            }
            continue;
        }
        if text.is_empty() && !field.required {
            continue;
        }
        let value = match field.field_type {
            McpFieldType::String | McpFieldType::Enum => Value::String(text.clone()),
            McpFieldType::Boolean => Value::Bool(text == "true"),
            McpFieldType::Number | McpFieldType::Integer => {
                let integer = field.field_type == McpFieldType::Integer;
                let number = text
                    .trim()
                    .parse::<f64>()
                    .ok()
                    .filter(|number| number.is_finite() && (!integer || number.fract() == 0.0));
                let Some(number) = number else {
                    return Err(format!(
                        "{} must be {} number.",
                        field.name,
                        if integer { "a whole" } else { "a" }
                    ));
                };
                json_number(number)
            }
            McpFieldType::Json => serde_json::from_str(text)
                .map_err(|_| format!("{} must be valid JSON.", field.name))?,
        };
        args.insert(field.name.clone(), value);
    }
    Ok(args)
}

/// The form's text for a call's arguments, as a user would type them.
pub fn form_from_arguments(
    fields: &[McpField],
    args: &Map<String, Value>,
) -> HashMap<String, String> {
    fields
        .iter()
        .filter_map(|field| {
            let value = args.get(&field.name)?;
            let text = if field.field_type == McpFieldType::Json
                || value.is_object()
                || value.is_array()
                || value.is_null()
            {
                pretty(value)
            } else {
                js_string(value)
            };
            Some((field.name.clone(), text))
        })
        .collect()
}

// ─── Agent results ──────────────────────────────────────────────────────────

const AGENT_TEXT_CHARS: usize = 8_000;
const AGENT_RESULT_CHARS: usize = 40_000;

/// What an agent gets back from a tool it called in the panel (Conn's
/// `AgentPanelMcpCallResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMcpCallResult {
    pub server: String,
    pub tool: String,
    /// The tool reported an error; its content says what.
    pub is_error: bool,
    pub content: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Value>,
    /// Long text was cut and images left out; the panel shows all of it.
    pub truncated: bool,
    pub duration_ms: f64,
}

fn json_len(value: &Value) -> usize {
    serde_json::to_string(value).map_or(0, |text| text.encode_utf16().count())
}

/// The result with text cut and media left out, so it fits an agent's context.
pub fn agent_tool_call_result(
    server: &str,
    tool: &str,
    response: &McpResponse,
) -> AgentMcpCallResult {
    let result = response.result.as_object();
    let field = |name: &str| result.and_then(|result| result.get(name));
    let mut truncated = false;
    let mut budget = AGENT_RESULT_CHARS;
    let mut blocks = Vec::new();
    for block in field("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let kind = block.get("type").and_then(Value::as_str);
        let mut kept = block.clone();
        if matches!(kind, Some("image" | "audio")) {
            let mut omitted = Map::new();
            omitted.insert("type".into(), json!(kind));
            if let Some(mime) = block.get("mimeType") {
                omitted.insert("mimeType".into(), mime.clone());
            }
            omitted.insert("omitted".into(), json!("Shown in the panel."));
            kept = Value::Object(omitted);
            truncated = true;
        } else if kind == Some("text") {
            let text = block.get("text").map(js_string).unwrap_or_default();
            if text.chars().count() > AGENT_TEXT_CHARS {
                let cut: String = text.chars().take(AGENT_TEXT_CHARS).collect();
                if let Value::Object(object) = &mut kept {
                    object.insert("text".into(), json!(format!("{cut}…")));
                }
                truncated = true;
            }
        }
        let size = json_len(&kept);
        if size > budget {
            truncated = true;
            break;
        }
        budget -= size;
        blocks.push(kept);
    }
    let structured = field("structuredContent").cloned();
    let keep_structured = structured
        .as_ref()
        .is_some_and(|value| json_len(value) <= budget);
    if structured.is_some() && !keep_structured {
        truncated = true;
    }
    AgentMcpCallResult {
        server: server.to_owned(),
        tool: tool.to_owned(),
        is_error: field("isError") == Some(&Value::Bool(true)),
        content: blocks,
        structured_content: if keep_structured { structured } else { None },
        truncated,
        duration_ms: response.duration_ms,
    }
}

// ─── Resource templates ─────────────────────────────────────────────────────

/// The `{...}` expressions of a template: (operator, comma-separated names).
fn template_expressions(template: &str) -> Vec<(std::ops::Range<usize>, &str, &str)> {
    let mut expressions = Vec::new();
    let mut from = 0;
    while let Some(open) = template[from..].find('{').map(|index| from + index) {
        let Some(close) = template[open + 1..].find('}').map(|index| open + 1 + index) else {
            break;
        };
        let body = &template[open + 1..close];
        if body.is_empty() {
            from = close + 1;
            continue;
        }
        let (operator, list) = match body.chars().next() {
            Some(first) if "+#./;?&".contains(first) && body.len() > 1 => body.split_at(1),
            _ => ("", body),
        };
        expressions.push((open..close + 1, operator, list));
        from = close + 1;
    }
    expressions
}

fn variable_names(list: &str) -> impl Iterator<Item = &str> {
    list.split(',').map(|part| {
        part.find(['*', ':'])
            .map_or(part, |cut| &part[..cut])
            .trim()
    })
}

/// `{name}` placeholders of an RFC 6570 URI template (operators like `{+path}` keep the name).
pub fn template_variables(template: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for (_, _, list) in template_expressions(template) {
        for name in variable_names(list) {
            if !name.is_empty() && !names.iter().any(|known| known == name) {
                names.push(name.to_owned());
            }
        }
    }
    names
}

fn percent_encode(value: &str, keep: &str) -> String {
    let mut out = String::new();
    for char in value.chars() {
        if char.is_ascii_alphanumeric() || "-_.!~*'()".contains(char) || keep.contains(char) {
            out.push(char);
        } else {
            let mut bytes = [0_u8; 4];
            for byte in char.encode_utf8(&mut bytes).bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    out
}

/// Fills a URI template's placeholders (RFC 6570 level 3, without explode or prefix
/// modifiers).
pub fn expand_template(template: &str, values: &HashMap<String, String>) -> String {
    let mut out = String::new();
    let mut last = 0;
    for (range, operator, list) in template_expressions(template) {
        out.push_str(&template[last..range.start]);
        last = range.end;
        let keep = if operator == "+" || operator == "#" {
            ";,/?:@&=+$#"
        } else {
            ""
        };
        let value = |name: &str| percent_encode(values.get(name).map_or("", String::as_str), keep);
        let names: Vec<&str> = variable_names(list).collect();
        let expanded = match operator {
            "?" | "&" => format!(
                "{operator}{}",
                names
                    .iter()
                    .map(|name| format!("{name}={}", value(name)))
                    .collect::<Vec<_>>()
                    .join("&")
            ),
            ";" => names
                .iter()
                .map(|name| format!(";{name}={}", value(name)))
                .collect(),
            "/" | "." => names
                .iter()
                .map(|name| format!("{operator}{}", value(name)))
                .collect(),
            "#" => format!(
                "#{}",
                names.iter().map(|n| value(n)).collect::<Vec<_>>().join(",")
            ),
            _ => names.iter().map(|n| value(n)).collect::<Vec<_>>().join(","),
        };
        out.push_str(&expanded);
    }
    out.push_str(&template[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect()
    }

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("object")
    }

    #[test]
    fn form_round_trips_agent_arguments() {
        let fields = fields_from_schema(&json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" },
                "limit": { "type": "integer" },
                "exact": { "type": "boolean" },
                "filters": { "type": "object" }
            },
            "required": ["query"]
        }));
        let args = object(
            json!({ "query": "orders", "limit": 5, "exact": true, "filters": { "status": ["paid"] } }),
        );
        assert_eq!(
            arguments_from_fields(&fields, &form_from_arguments(&fields, &args)),
            Ok(args),
            "round trip"
        );
    }

    #[test]
    fn agent_result_cuts_text_and_leaves_out_images() {
        let result = agent_tool_call_result(
            "app",
            "search",
            &McpResponse {
                error: None,
                duration_ms: 12.0,
                result: json!({
                    "isError": false,
                    "content": [
                        { "type": "text", "text": "x".repeat(9_000) },
                        { "type": "image", "mimeType": "image/png", "data": "AAAA" }
                    ],
                    "structuredContent": { "count": 2 }
                }),
            },
        );
        assert!(result.truncated, "truncated");
        assert_eq!(
            result.content[0]["text"]
                .as_str()
                .map(|t| t.chars().count()),
            Some(8_001),
            "cut text"
        );
        assert_eq!(
            result.content[1],
            json!({ "type": "image", "mimeType": "image/png", "omitted": "Shown in the panel." }),
            "image omitted"
        );
        assert_eq!(
            result.structured_content,
            Some(json!({ "count": 2 })),
            "kept"
        );
    }

    fn saved() -> Vec<McpServerDraft> {
        servers_from_mcp_json(
            &json!({
                "mcpServers": {
                    "app": { "url": "https://app.test/mcp", "headers": { "Authorization": "old" } },
                    "boost": { "command": "php", "args": ["artisan", "boost:mcp"] }
                }
            })
            .to_string(),
        )
    }

    #[test]
    fn agent_draft_updates_by_name_url_or_command() {
        let saved = saved();
        let (draft, is_new) = agent_server_draft(
            &saved,
            &AgentMcpServer {
                name: Some("APP".into()),
                url: Some("https://other.test/mcp".into()),
                ..AgentMcpServer::default()
            },
        );
        assert!(!is_new, "existing");
        assert_eq!(draft.id, saved[0].id, "same id");
        assert_eq!(draft.url, "https://other.test/mcp", "url");
        let (draft, _) = agent_server_draft(
            &saved,
            &AgentMcpServer {
                command: Some("php artisan boost:mcp".into()),
                ..AgentMcpServer::default()
            },
        );
        assert_eq!(draft.id, saved[1].id, "by command");
        assert_eq!(draft.transport, McpTransport::Stdio, "stdio");
    }

    #[test]
    fn agent_draft_adds_and_replaces_headers() {
        let request: AgentMcpServer = serde_json::from_value(json!({
            "url": "https://new.test/mcp",
            "transport": "sse",
            "headers": { "Authorization": "Bearer t" }
        }))
        .expect("request");
        let (draft, is_new) = agent_server_draft(&saved(), &request);
        assert!(is_new, "new");
        assert_eq!(
            to_desktop_mcp_server(&draft, None),
            Ok(McpServer::Sse {
                url: "https://new.test/mcp".into(),
                headers: vec![McpHeader {
                    name: "Authorization".into(),
                    value: "Bearer t".into()
                }],
            }),
            "sse server"
        );
    }

    #[test]
    fn splits_command_lines() {
        assert_eq!(
            split_command_line(r#"php artisan mcp:start "my server" 'a b' c\ d """#),
            vec!["php", "artisan", "mcp:start", "my server", "a b", "c d", ""],
            "words"
        );
        assert_eq!(
            split_command_line("npx -y @modelcontextprotocol/server-everything"),
            vec!["npx", "-y", "@modelcontextprotocol/server-everything"],
            "npx"
        );
        assert_eq!(
            split_command_line(r#"echo "a \"b\" \n""#),
            vec!["echo", r#"a "b" \n"#],
            "escapes in double quotes"
        );
        let words = ["npx", "-y", "it's here", "--flag=a b", ""];
        let line = words.map(quote_word).join(" ");
        assert_eq!(split_command_line(&line), words, "round trip");
    }

    #[test]
    fn reads_mcp_json() {
        let servers = servers_from_mcp_json(
            &json!({
                "mcpServers": {
                    "laravel": { "command": "php", "args": ["artisan", "boost:mcp"], "env": { "APP_ENV": "local" } },
                    "remote": { "type": "sse", "url": "https://app.test/sse", "headers": { "Authorization": "x" } },
                    "broken": { "args": [] }
                }
            })
            .to_string(),
        );
        assert_eq!(
            servers
                .iter()
                .map(|s| (s.id.as_str(), s.transport))
                .collect::<Vec<_>>(),
            vec![
                ("mcp.json:laravel", McpTransport::Stdio),
                ("mcp.json:remote", McpTransport::Sse)
            ],
            "servers"
        );
        assert_eq!(servers[0].command_line, "php artisan boost:mcp", "command");
        assert_eq!(
            servers[0]
                .env
                .iter()
                .map(|r| (r.name.as_str(), r.value.as_str()))
                .collect::<Vec<_>>(),
            vec![("APP_ENV", "local")],
            "env"
        );
        assert_eq!(
            servers_from_mcp_json(r#"{"servers":{"a":{"url":"http://x"}}}"#)
                .first()
                .map(|s| s.transport),
            Some(McpTransport::Http),
            "VS Code servers"
        );
        assert!(servers_from_mcp_json("not json").is_empty(), "bad json");
    }

    #[test]
    fn stdio_runs_in_the_project_folder() {
        let server = servers_from_mcp_json(
            r#"{"mcpServers":{"a":{"command":"node","args":["server.js"]}}}"#,
        )
        .remove(0);
        assert_eq!(
            to_desktop_mcp_server(&server, Some("/repo")),
            Ok(McpServer::Stdio {
                command: "node".into(),
                args: vec!["server.js".into()],
                env: BTreeMap::new(),
                cwd: Some("/repo".into()),
            }),
            "project folder"
        );
        let blank = McpServerDraft {
            command_line: " ".into(),
            ..server
        };
        assert_eq!(
            to_desktop_mcp_server(&blank, Some("/repo")),
            Err("Enter the command that starts the server.".into()),
            "blank command"
        );
    }

    #[test]
    fn labels_and_new_servers() {
        let server = new_mcp_server(Some("https://app.test/"));
        assert_eq!(server.transport, McpTransport::Http, "http");
        assert_eq!(server.url, "https://app.test/mcp", "mcp url");
        assert_eq!(mcp_server_label(&server), "https://app.test/mcp", "label");
        assert_eq!(
            mcp_server_label(&new_mcp_server(None)),
            "New server",
            "blank"
        );
        assert_eq!(new_row_id().len(), 8, "id length");
    }

    #[test]
    fn maps_schema_fields_and_arguments() {
        let fields = fields_from_schema(&json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" },
                "limit": { "type": "integer", "default": 10 },
                "exact": { "type": "boolean" },
                "mode": { "enum": ["fast", "full"] },
                "filters": { "type": "object" },
                "note": { "type": ["string", "null"] }
            },
            "required": ["query"]
        }));
        assert_eq!(
            fields
                .iter()
                .map(|f| (f.name.as_str(), f.field_type, f.required))
                .collect::<Vec<_>>(),
            vec![
                ("query", McpFieldType::String, true),
                ("limit", McpFieldType::Integer, false),
                ("exact", McpFieldType::Boolean, false),
                ("mode", McpFieldType::Enum, false),
                ("filters", McpFieldType::Json, false),
                ("note", McpFieldType::String, false),
            ],
            "types"
        );
        assert_eq!(
            arguments_from_fields(
                &fields,
                &values(&[
                    ("query", ""),
                    ("exact", "true"),
                    ("filters", r#"{"a":1}"#),
                    ("mode", "")
                ])
            ),
            Ok(object(
                json!({ "query": "", "limit": 10, "exact": true, "filters": { "a": 1 } })
            )),
            "arguments"
        );
        assert_eq!(
            arguments_from_fields(&fields, &values(&[("limit", "2.5")])),
            Err("limit must be a whole number.".into()),
            "integer"
        );
        assert_eq!(
            arguments_from_fields(&fields, &values(&[("filters", "{")])),
            Err("filters must be valid JSON.".into()),
            "json"
        );
    }

    #[test]
    fn fills_resource_templates() {
        let template = "file:///{+path}{?rev,raw}";
        assert_eq!(
            template_variables(template),
            vec!["path", "rev", "raw"],
            "names"
        );
        assert_eq!(
            expand_template(
                template,
                &values(&[("path", "a b/c.txt"), ("rev", "1&2"), ("raw", "")])
            ),
            "file:///a%20b/c.txt?rev=1%262&raw=",
            "expanded"
        );
        assert_eq!(
            expand_template("users://{id}/posts", &values(&[("id", "a/b")])),
            "users://a%2Fb/posts",
            "simple"
        );
    }
}
