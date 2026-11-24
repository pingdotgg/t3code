//! What the Laravel Toolbar bar and panels show, mapped from the payload (`ToolbarData`), as
//! `apps/web/src/laravelToolbar/model.ts` does. Pure functions over JSON: every field of the
//! payload is optional, since older package versions and disabled collectors leave parts out.

use serde_json::{Map, Value};

pub use crate::api_request::toolbar::{
    ToolbarData, ToolbarHistoryRow, format_bytes, format_count, format_ms, row_from_data,
};

/// The value at a path of keys, through nested objects.
#[must_use]
pub fn at<'a>(data: &'a ToolbarData, keys: &[&str]) -> Option<&'a Value> {
    let (first, rest) = keys.split_first()?;
    rest.iter()
        .try_fold(data.get(*first)?, |value, key| value.get(key))
}

/// A non-null string at a path.
#[must_use]
pub fn str_at<'a>(data: &'a ToolbarData, keys: &[&str]) -> Option<&'a str> {
    at(data, keys).and_then(Value::as_str)
}

/// A number at a path.
#[must_use]
pub fn num_at(data: &ToolbarData, keys: &[&str]) -> Option<f64> {
    at(data, keys).and_then(Value::as_f64)
}

/// A boolean at a path.
#[must_use]
pub fn bool_at(data: &ToolbarData, keys: &[&str]) -> Option<bool> {
    at(data, keys).and_then(Value::as_bool)
}

/// A string or number at a path, written as text (`max_execution_time` is either).
#[must_use]
pub fn text_at(data: &ToolbarData, keys: &[&str]) -> Option<String> {
    match at(data, keys)? {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// A page load, an Inertia visit or a plain XHR (`RequestKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestKind {
    Page,
    Inertia,
    Xhr,
}

/// A request as a history row shows it (`RequestSummary`).
#[derive(Debug, Clone, PartialEq)]
pub struct RequestSummary {
    pub id: String,
    pub status: Option<u16>,
    pub method: String,
    pub uri: String,
    pub route_name: Option<String>,
    /// The route's name, or its URI pattern (such as `/`) when it has none.
    pub route: String,
    pub action: Option<String>,
    pub component: Option<String>,
    pub kind: RequestKind,
    pub duration: Option<String>,
    pub duration_ms: Option<f64>,
    pub size: Option<String>,
}

/// One stage of the request, laid end to end (`Stage`).
#[derive(Debug, Clone, PartialEq)]
pub struct Stage {
    pub label: String,
    pub color: String,
    pub duration_ms: f64,
    pub start_ms: f64,
    pub memory_bytes: f64,
}

/// One database query (`Query`).
#[derive(Debug, Clone, PartialEq)]
pub struct Query {
    pub sql: String,
    pub duration_ms: f64,
    pub is_duplicate: bool,
    pub is_slow: bool,
    /// Start and length as shares (0–1) of cumulative recorded query time.
    pub offset: f64,
    pub share: f64,
    pub file: Option<String>,
    pub line: Option<u32>,
    pub bindings: Vec<Value>,
}

const FALLBACK_STAGE_COLOR: &str = "#8D76FF";

/// The app's framework (`Framework`).
#[derive(Debug, Clone, PartialEq)]
pub struct Framework {
    pub name: String,
    pub is_laravel: bool,
    pub version: Option<String>,
    pub environment: Option<String>,
    pub debug: Option<String>,
    pub host: Option<String>,
    pub timezone: Option<String>,
    pub locale: Option<String>,
}

/// The app's framework: the bridge's `framework` section, else the package's `laravel` one.
#[must_use]
pub fn framework(data: Option<&ToolbarData>) -> Framework {
    let empty = Map::new();
    let data = data.unwrap_or(&empty);
    let other = |key: &str| text_at(data, &["framework", key]);
    let laravel = |key: &str| text_at(data, &["laravel", key]);
    if let Some(name) =
        str_at(data, &["framework", "name"]).filter(|n| !n.is_empty() && *n != "Laravel")
    {
        return Framework {
            name: name.to_owned(),
            is_laravel: false,
            version: other("version"),
            environment: other("environment"),
            debug: other("debug"),
            host: other("host"),
            timezone: None,
            locale: None,
        };
    }
    Framework {
        name: "Laravel".to_owned(),
        is_laravel: true,
        version: laravel("version").or_else(|| other("version")),
        environment: laravel("environment").or_else(|| other("environment")),
        debug: laravel("debug").or_else(|| other("debug")),
        host: laravel("host").or_else(|| other("host")),
        timezone: laravel("timezone"),
        locale: laravel("locale"),
    }
}

/// `requestKind`.
#[must_use]
pub fn request_kind(row: &ToolbarHistoryRow) -> RequestKind {
    if row.is_xhr != Some(true) {
        return RequestKind::Page;
    }
    if row.response_type.as_deref() == Some("Inertia") {
        RequestKind::Inertia
    } else {
        RequestKind::Xhr
    }
}

/// The route's URI pattern with a leading slash; Laravel leaves it off except for `/`.
#[must_use]
pub fn route_uri(data: Option<&ToolbarData>) -> Option<String> {
    let data = data?;
    let uri = str_at(data, &["request", "route_uri"])
        .filter(|u| !u.is_empty())
        .or_else(|| str_at(data, &["request", "uri"]).filter(|u| !u.is_empty()))?;
    Some(if uri.starts_with('/') {
        uri.to_owned()
    } else {
        format!("/{uri}")
    })
}

/// The package writes `-` for routes without a name.
fn named(value: Option<&str>) -> Option<String> {
    value
        .filter(|v| !v.is_empty() && *v != "-")
        .map(str::to_owned)
}

/// A request as a history row shows it, completed by its full payload when loaded.
#[must_use]
pub fn summarize(row: &ToolbarHistoryRow, data: Option<&ToolbarData>) -> RequestSummary {
    let route_name_source = data
        .and_then(|d| str_at(d, &["request", "route_name"]))
        .or(row.name.as_deref());
    let route_name = named(route_name_source);
    let (duration, duration_ms) = request_duration(row, data);
    RequestSummary {
        id: row.id.clone(),
        status: data
            .and_then(|d| num_at(d, &["response", "status_code"]))
            .and_then(|code| u16::try_from(code as u64).ok())
            .or(row.status_code),
        method: data
            .and_then(|d| str_at(d, &["request", "method"]))
            .map_or_else(|| row.method.clone(), str::to_owned),
        uri: data
            .and_then(|d| str_at(d, &["request", "uri"]))
            .map_or_else(|| row.uri.clone(), str::to_owned),
        route: route_name
            .clone()
            .or_else(|| route_uri(data))
            .unwrap_or_else(|| row.uri.clone()),
        route_name,
        action: data
            .and_then(|d| str_at(d, &["request", "controller_action"]))
            .map(str::to_owned)
            .or_else(|| row.action.clone()),
        component: data
            .and_then(|d| str_at(d, &["request", "view_name"]))
            .map(str::to_owned),
        kind: request_kind(row),
        duration,
        duration_ms,
        size: data.and_then(response_size).or_else(|| row.size.clone()),
    }
}

/// Milliseconds in a formatted duration such as `30168ms`, `1,234 ms` or `2 min 5 s`.
#[must_use]
pub fn parse_duration(duration: Option<&str>) -> Option<f64> {
    let text = duration?;
    if text.trim().is_empty() {
        return None;
    }
    const UNITS: [(&str, f64); 9] = [
        ("ns", 0.000_001),
        ("μs", 0.001),
        ("µs", 0.001),
        ("us", 0.001),
        ("ms", 1.0),
        ("sec", 1000.0),
        ("min", 60_000.0),
        ("s", 1000.0),
        ("m", 60_000.0),
    ];
    let chars: Vec<char> = text.chars().collect();
    let mut at = 0;
    let mut total = 0.0;
    while at < chars.len() {
        while at < chars.len() && chars[at].is_whitespace() {
            at += 1;
        }
        let start = at;
        while at < chars.len()
            && (chars[at].is_ascii_digit() || chars[at] == '.' || chars[at] == ',')
        {
            at += 1;
        }
        if at == start {
            return None;
        }
        let number: String = chars[start..at].iter().filter(|c| **c != ',').collect();
        let value: f64 = number.parse().ok()?;
        while at < chars.len() && chars[at].is_whitespace() {
            at += 1;
        }
        let rest: String = chars[at..].iter().collect::<String>().to_lowercase();
        let mut factor = 1.0;
        for (name, scale) in UNITS {
            if rest.starts_with(name) {
                factor = scale;
                at += name.chars().count();
                break;
            }
        }
        total += value * factor;
        while at < chars.len() && chars[at].is_whitespace() {
            at += 1;
        }
    }
    Some(total)
}

/// The bridge formats durations itself (`30168ms`); the toolbar shows its own format.
fn request_duration(
    row: &ToolbarHistoryRow,
    data: Option<&ToolbarData>,
) -> (Option<String>, Option<f64>) {
    let formatted = data
        .and_then(|d| str_at(d, &["profiler", "total_wall_time", "formattedValue"]))
        .map(str::to_owned)
        .or_else(|| row.duration.clone());
    let value = data.and_then(|d| num_at(d, &["profiler", "total_wall_time", "value"]));
    let ms = value.or_else(|| parse_duration(formatted.as_deref()));
    match ms {
        Some(ms) => (Some(format_ms(ms)), Some(ms)),
        None => (formatted, None),
    }
}

/// Newer package versions send the response size as a measurement, older ones as text.
fn response_size(data: &ToolbarData) -> Option<String> {
    match at(data, &["response", "size"])? {
        Value::String(text) => Some(text.clone()),
        Value::Object(measurement) => measurement
            .get("formattedValue")
            .and_then(Value::as_str)
            .map(str::to_owned),
        _ => None,
    }
}

/// Request stages laid end to end, so each starts where the previous one ended.
#[must_use]
pub fn stages(data: &ToolbarData) -> Vec<Stage> {
    let mut cursor = 0.0;
    at(data, &["profiler", "stages"])
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|stage| {
                    let duration_ms = stage
                        .pointer("/wall_time/measurement/value")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0);
                    let out = Stage {
                        label: stage
                            .get("label")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        color: stage
                            .get("color")
                            .and_then(Value::as_str)
                            .unwrap_or(FALLBACK_STAGE_COLOR)
                            .to_owned(),
                        duration_ms,
                        start_ms: cursor,
                        memory_bytes: stage
                            .pointer("/memory_real_delta/measurement/value")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                    };
                    cursor += duration_ms;
                    out
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The request's wall time, else the sum of its stages.
#[must_use]
pub fn wall_time_ms(data: &ToolbarData) -> f64 {
    num_at(data, &["profiler", "total_wall_time", "value"])
        .unwrap_or_else(|| stages(data).iter().map(|s| s.duration_ms).sum())
}

/// The queries of the request.
#[must_use]
pub fn queries(data: &ToolbarData) -> Vec<Query> {
    at(data, &["queries", "queries"])
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|query| Query {
                    sql: query
                        .get("sql")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    duration_ms: query.get("duration").and_then(Value::as_f64).unwrap_or(0.0),
                    is_duplicate: query
                        .get("is_duplicate")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    is_slow: query
                        .get("is_slow")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    offset: query.get("offset").and_then(Value::as_f64).unwrap_or(0.0),
                    share: query
                        .get("percentage")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0),
                    file: query.get("file").and_then(Value::as_str).map(str::to_owned),
                    line: query
                        .get("line")
                        .and_then(Value::as_u64)
                        .and_then(|line| u32::try_from(line).ok()),
                    bindings: query
                        .get("bindings")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Whether any query is a duplicate or slow.
#[must_use]
pub fn has_query_issues(data: &ToolbarData) -> bool {
    queries(data).iter().any(|q| q.is_duplicate || q.is_slow)
}

fn sql_literal(value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_owned(),
        Value::Bool(flag) => if *flag { "1" } else { "0" }.to_owned(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => format!("'{}'", text.replace('\'', "''")),
        other => format!("'{}'", other.to_string().replace('\'', "''")),
    }
}

/// The query with its bindings written in, so it can run on its own. Placeholders inside quoted
/// strings and identifiers stay; extra placeholders stay `?`.
#[must_use]
pub fn inline_bindings(sql: &str, bindings: &[Value]) -> String {
    let mut next = 0;
    let mut quote: Option<char> = None;
    let mut out = String::with_capacity(sql.len());
    for ch in sql.chars() {
        if let Some(open) = quote {
            if ch == open {
                quote = None;
            }
            out.push(ch);
        } else if ch == '\'' || ch == '"' || ch == '`' {
            quote = Some(ch);
            out.push(ch);
        } else if ch == '?' && next < bindings.len() {
            out.push_str(&sql_literal(&bindings[next]));
            next += 1;
        } else {
            out.push(ch);
        }
    }
    out
}

/// One row per model class (`ToolbarModel`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelRow {
    pub model: String,
    pub retrieved: Option<i64>,
    pub created: Option<i64>,
    pub updated: Option<i64>,
    pub deleted: Option<i64>,
}

/// One row per model class, from either payload shape (the bridge's rows or the package's
/// per-class entries).
#[must_use]
pub fn toolbar_models(data: &ToolbarData) -> Vec<ModelRow> {
    let int = |value: Option<&Value>| value.and_then(Value::as_i64);
    match data.get("models") {
        Some(Value::Array(rows)) => rows
            .iter()
            .map(|row| ModelRow {
                model: row
                    .get("model")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                retrieved: int(row.get("retrieved")),
                created: int(row.get("created")),
                updated: int(row.get("updated")),
                deleted: int(row.get("deleted")),
            })
            .collect(),
        Some(Value::Object(entries)) => {
            let mut rows: Vec<ModelRow> = Vec::new();
            for (key, entry) in entries {
                let name = entry
                    .get("model")
                    .and_then(Value::as_str)
                    .unwrap_or(key)
                    .to_owned();
                let count = int(entry.get("count")).unwrap_or(0);
                let index = rows
                    .iter()
                    .position(|r| r.model == name)
                    .unwrap_or_else(|| {
                        rows.push(ModelRow {
                            model: name.clone(),
                            ..ModelRow::default()
                        });
                        rows.len() - 1
                    });
                let row = &mut rows[index];
                let slot = match entry.get("action").and_then(Value::as_str) {
                    Some("retrieved") => Some(&mut row.retrieved),
                    Some("created") => Some(&mut row.created),
                    Some("updated") => Some(&mut row.updated),
                    Some("deleted") => Some(&mut row.deleted),
                    _ => None,
                };
                if let Some(slot) = slot {
                    *slot = Some(slot.unwrap_or(0) + count);
                }
            }
            rows
        }
        _ => Vec::new(),
    }
}

/// The models retrieved in total.
#[must_use]
pub fn model_count(data: &ToolbarData) -> i64 {
    toolbar_models(data)
        .iter()
        .map(|m| m.retrieved.unwrap_or(0))
        .sum()
}

/// The file name and line of a source path, for a compact link label.
#[must_use]
pub fn short_location(file: Option<&str>, line: Option<u32>) -> Option<String> {
    let file = file.filter(|f| !f.is_empty())?;
    let name = file.rsplit('/').next().unwrap_or(file);
    Some(match line {
        Some(line) if line > 0 => format!("{name}:{line}"),
        _ => name.to_owned(),
    })
}

/// Header maps arrive as arrays per name; show them joined.
#[must_use]
pub fn header_rows(headers: Option<&Value>) -> Vec<(String, String)> {
    headers
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .map(|(name, values)| {
                    let joined = match values {
                        Value::Array(items) => items
                            .iter()
                            .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned))
                            .collect::<Vec<_>>()
                            .join(", "),
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    };
                    (name.clone(), joined)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// What Inertia knows about a prop (`PropBadge`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PropBadge {
    Shared,
    Always,
    Deferred,
    Optional,
    Merge,
    Scroll,
    Once,
}

impl PropBadge {
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Shared => "Shared",
            Self::Always => "Always",
            Self::Deferred => "Deferred",
            Self::Optional => "Optional",
            Self::Merge => "Merge",
            Self::Scroll => "Scroll",
            Self::Once => "Once",
        }
    }
}

/// A source location (`SourceLocation`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceLocation {
    pub file: String,
    pub line: u32,
}

/// A top-level page prop (`PropRow`).
#[derive(Debug, Clone, PartialEq)]
pub struct PropRow {
    pub name: String,
    pub value: Option<Value>,
    /// False for a deferred prop this response left out.
    pub loaded: bool,
    pub badges: Vec<PropBadge>,
    pub source: Option<SourceLocation>,
}

/// The source location in a JSON `{file, line}`.
#[must_use]
pub fn source_location(value: Option<&Value>) -> Option<SourceLocation> {
    let value = value?;
    Some(SourceLocation {
        file: value.get("file")?.as_str()?.to_owned(),
        line: u32::try_from(value.get("line")?.as_u64()?).ok()?,
    })
}

/// The page's top-level props with what Inertia knows about them; deferred props come last.
#[must_use]
pub fn prop_rows(data: Option<&ToolbarData>) -> Vec<PropRow> {
    let Some(data) = data else {
        return Vec::new();
    };
    // php-data-bridge sends the string "[redacted]" unless view data collection is enabled.
    let values = at(data, &["request", "view_data"])
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let meta = at(data, &["inertia", "props"])
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let row = |name: &str, loaded: bool| {
        let info = meta.get(name);
        let mut badges = Vec::new();
        if info
            .and_then(|i| i.get("shared"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            badges.push(PropBadge::Shared);
        }
        let type_badge = match info.and_then(|i| i.get("type")).and_then(Value::as_str) {
            Some("always") => Some(PropBadge::Always),
            Some("defer") => Some(PropBadge::Deferred),
            Some("optional") => Some(PropBadge::Optional),
            Some("merge") => Some(PropBadge::Merge),
            Some("scroll") => Some(PropBadge::Scroll),
            Some("once") => Some(PropBadge::Once),
            _ => None,
        };
        badges.extend(type_badge);
        PropRow {
            name: name.to_owned(),
            value: values.get(name).cloned(),
            loaded,
            badges,
            source: source_location(info.and_then(|i| i.get("source"))),
        }
    };
    let mut rows: Vec<PropRow> = values.keys().map(|name| row(name, true)).collect();
    rows.extend(
        meta.iter()
            .filter(|(name, info)| {
                !values.contains_key(*name)
                    && info.get("loaded").and_then(Value::as_bool) == Some(false)
            })
            .map(|(name, _)| row(name, false)),
    );
    rows
}

/// An ini switch as On or Off; empty, "0" and "off" are off.
#[must_use]
pub fn ini_switch(value: Option<&str>) -> &'static str {
    match value {
        None => "–",
        Some(text) if ["", "0", "off", "false", "no"].contains(&text.to_lowercase().as_str()) => {
            "Off"
        }
        Some(_) => "On",
    }
}

const ERROR_LEVELS: [(&str, i64); 7] = [
    ("E_DEPRECATED", 8192),
    ("E_USER_DEPRECATED", 16384),
    ("E_STRICT", 2048),
    ("E_NOTICE", 8),
    ("E_USER_NOTICE", 1024),
    ("E_WARNING", 2),
    ("E_USER_WARNING", 512),
];

/// `error_reporting` as constants, such as `E_ALL & ~E_DEPRECATED` for 22527 on PHP 8.4+. PHP 8.4
/// dropped E_STRICT, so E_ALL is 30719 there and 32767 before.
#[must_use]
pub fn error_reporting_label(value: Option<&str>, php_version: Option<&str>) -> String {
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return "–".to_owned();
    };
    let Ok(level) = value.parse::<i64>() else {
        return value.to_owned();
    };
    if level == 0 {
        return "None".to_owned();
    }
    if level == -1 {
        return "E_ALL".to_owned();
    }
    let mut parts = php_version
        .unwrap_or("")
        .split('.')
        .map(|p| p.parse::<i64>().unwrap_or(0));
    let (major, minor) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
    let modern = major > 8 || (major == 8 && minor >= 4);
    let all: i64 = if modern { 30719 } else { 32767 };
    let levels: Vec<(&str, i64)> = ERROR_LEVELS
        .iter()
        .copied()
        .filter(|(name, _)| !(modern && *name == "E_STRICT"))
        .collect();
    if level & all != level {
        return level.to_string();
    }
    let missing: Vec<&(&str, i64)> = levels.iter().filter(|(_, bit)| level & bit == 0).collect();
    if missing.iter().map(|(_, bit)| *bit).sum::<i64>() != all - level {
        return level.to_string();
    }
    let mut parts = vec!["E_ALL".to_owned()];
    parts.extend(missing.iter().map(|(name, _)| format!("~{name}")));
    parts.join(" & ")
}

/// A PHP limit, where -1 (memory) or 0 (time) means no limit.
#[must_use]
pub fn php_limit(value: Option<&str>, unit: &str) -> String {
    match value {
        None | Some("") => "–".to_owned(),
        Some("-1") => "Unlimited".to_owned(),
        Some("0") if unit == "s" => "Unlimited".to_owned(),
        Some(text) => format!("{text}{unit}"),
    }
}

/// A duration in seconds as `3d 4h`, `16h 4m` or `5m`.
#[must_use]
pub fn format_uptime(seconds: Option<f64>) -> String {
    let Some(seconds) = seconds else {
        return "–".to_owned();
    };
    let days = (seconds / 86400.0).floor();
    let hours = ((seconds % 86400.0) / 3600.0).floor();
    let minutes = ((seconds % 3600.0) / 60.0).floor();
    if days > 0.0 {
        format!("{days}d {hours}h")
    } else if hours > 0.0 {
        format!("{hours}h {minutes}m")
    } else {
        format!("{minutes}m")
    }
}

/// A request's arrival time as the Requests panel shows it (`toLocaleTimeString`, 24-hour).
#[must_use]
pub fn clock_time(received_at_ms: u64) -> String {
    use chrono::TimeZone as _;
    i64::try_from(received_at_ms)
        .ok()
        .and_then(|ms| chrono::Local.timestamp_millis_opt(ms).single())
        .map_or_else(
            || "–".to_owned(),
            |time| time.format("%H:%M:%S").to_string(),
        )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn data(value: Value) -> ToolbarData {
        match value {
            Value::Object(map) => map,
            _ => Map::new(),
        }
    }

    fn page() -> ToolbarData {
        data(json!({
            "request_id": "r1",
            "profiler": {
                "total_wall_time": { "formattedValue": "41ms", "value": 41.27 },
                "stages": [
                    { "label": "Bootstrapping", "color": "#FC3D46", "wall_time": { "measurement": { "value": 8.28 } } },
                    { "label": "Controller", "color": "#64BAFF",
                      "wall_time": { "measurement": { "value": 1 } },
                      "memory_real_delta": { "measurement": { "value": 26368 } } }
                ]
            },
            "request": { "method": "GET", "uri": "/", "route_name": "home", "is_inertia": true, "view_name": "Home" },
            "response": { "status_code": 200, "size": "9.97 KB" }
        }))
    }

    fn row(value: Value) -> ToolbarHistoryRow {
        ToolbarHistoryRow::from_json(&value).expect("a row")
    }

    #[test]
    fn names_error_reporting_levels_and_ini_switches() {
        assert_eq!(
            error_reporting_label(Some("22527"), Some("8.5.9")),
            "E_ALL & ~E_DEPRECATED"
        );
        assert_eq!(
            error_reporting_label(Some("22527"), Some("8.3.1")),
            "E_ALL & ~E_DEPRECATED & ~E_STRICT"
        );
        assert_eq!(error_reporting_label(Some("30719"), Some("8.5.0")), "E_ALL");
        assert_eq!(error_reporting_label(Some("32767"), Some("8.2.0")), "E_ALL");
        assert_eq!(error_reporting_label(Some("0"), Some("8.5.0")), "None");
        assert_eq!(error_reporting_label(Some("-1"), Some("8.5.0")), "E_ALL");
        assert_eq!(ini_switch(Some("")), "Off");
        assert_eq!(ini_switch(Some("1")), "On");
        assert_eq!(format_uptime(Some(57898.0)), "16h 4m");
        assert_eq!(php_limit(Some("-1"), ""), "Unlimited");
        assert_eq!(php_limit(Some("0"), "s"), "Unlimited");
        assert_eq!(php_limit(Some("30"), "s"), "30s");
    }

    #[test]
    fn falls_back_to_the_routes_uri_when_it_has_no_name() {
        let unnamed = row(json!({ "id": "r1", "method": "GET", "uri": "/", "name": "-" }));
        assert_eq!(summarize(&unnamed, None).route, "/");
        let named = row(json!({ "id": "r1", "method": "GET", "uri": "/", "name": "home" }));
        assert_eq!(summarize(&named, None).route, "home");
        let with_route =
            data(json!({ "request": { "route_uri": "posts/{post}", "uri": "/posts/1" } }));
        assert_eq!(
            summarize(&unnamed, Some(&with_route)).route,
            "/posts/{post}"
        );
    }

    #[test]
    fn adds_inertias_prop_metadata_and_lists_deferred_props_that_are_not_loaded() {
        let rows = prop_rows(Some(&data(json!({
            "request": { "view_data": { "auth": { "user": null }, "releases": [] } },
            "inertia": { "props": {
                "auth": { "shared": true, "type": "always", "source": { "file": "/app/Share.php", "line": 21 } },
                "releases": { "shared": false, "type": null },
                "downloads": { "type": "defer", "defer_group": "stats", "loaded": false }
            } }
        }))));
        let summary: Vec<(&str, bool, Vec<PropBadge>)> = rows
            .iter()
            .map(|r| (r.name.as_str(), r.loaded, r.badges.clone()))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("auth", true, vec![PropBadge::Shared, PropBadge::Always]),
                ("releases", true, vec![]),
                ("downloads", false, vec![PropBadge::Deferred]),
            ]
        );
        assert_eq!(
            rows[0].source,
            Some(SourceLocation {
                file: "/app/Share.php".to_owned(),
                line: 21
            })
        );
    }

    #[test]
    fn lists_no_prop_values_when_the_bridge_redacts_view_data() {
        let rows = prop_rows(Some(&data(json!({
            "request": { "view_data": "[redacted]" },
            "inertia": { "props": { "stats": { "type": "defer", "loaded": false } } }
        }))));
        assert_eq!(
            rows.iter()
                .map(|r| (r.name.as_str(), r.loaded))
                .collect::<Vec<_>>(),
            [("stats", false)]
        );
    }

    #[test]
    fn reads_the_response_size_as_text_or_as_a_measurement() {
        let measured = data(json!({ "request_id": "r1",
            "response": { "size": { "formattedValue": "9.97 KB", "value": 10209 } } }));
        let measured_row = row_from_data(&measured).expect("a row");
        assert_eq!(
            summarize(&measured_row, Some(&measured)).size.as_deref(),
            Some("9.97 KB")
        );
        let text = page();
        let text_row = row_from_data(&text).expect("a row");
        assert_eq!(
            summarize(&text_row, Some(&text)).size.as_deref(),
            Some("9.97 KB")
        );
    }

    #[test]
    fn lays_stages_end_to_end() {
        let laid: Vec<(String, f64)> = stages(&page())
            .into_iter()
            .map(|s| (s.label, s.start_ms))
            .collect();
        assert_eq!(
            laid,
            [
                ("Bootstrapping".to_owned(), 0.0),
                ("Controller".to_owned(), 8.28)
            ]
        );
        assert_eq!(stages(&page())[1].memory_bytes, 26368.0);
        assert!((wall_time_ms(&page()) - 41.27).abs() < 1e-9);
    }

    #[test]
    fn builds_a_history_row_for_a_page_load_that_sent_none() {
        let built = row_from_data(&page()).expect("a row");
        assert_eq!(built.id, "r1");
        assert_eq!(built.is_xhr, Some(false));
        assert_eq!(built.status_code, Some(200));
    }

    #[test]
    fn tells_page_loads_inertia_visits_and_plain_xhr_apart() {
        assert_eq!(
            request_kind(&row(json!({ "id": "a", "is_xhr": false }))),
            RequestKind::Page
        );
        assert_eq!(
            request_kind(&row(
                json!({ "id": "a", "is_xhr": true, "response_type": "Inertia" })
            )),
            RequestKind::Inertia
        );
        assert_eq!(
            request_kind(&row(
                json!({ "id": "a", "is_xhr": true, "response_type": null })
            )),
            RequestKind::Xhr
        );
    }

    #[test]
    fn completes_a_history_row_with_its_loaded_payload() {
        let summary = summarize(
            &row(json!({ "id": "r1", "method": "GET", "uri": "/", "duration": "40ms" })),
            Some(&page()),
        );
        assert_eq!(summary.component.as_deref(), Some("Home"));
        assert_eq!(summary.duration.as_deref(), Some("41.3 ms"));
        assert_eq!(summary.status, Some(200));
    }

    #[test]
    fn reformats_a_history_rows_bridge_duration_before_its_payload_loads() {
        let slow = row(json!({ "id": "r2", "method": "GET", "uri": "/", "duration": "30168ms" }));
        let summary = summarize(&slow, None);
        assert_eq!(summary.duration.as_deref(), Some("30.2 s"));
        assert_eq!(summary.duration_ms, Some(30168.0));
        let odd = row(json!({ "id": "r2", "method": "GET", "uri": "/", "duration": "slow" }));
        let summary = summarize(&odd, None);
        assert_eq!(summary.duration.as_deref(), Some("slow"));
        assert_eq!(summary.duration_ms, None);
    }

    #[test]
    fn parses_durations_in_every_unit() {
        assert_eq!(parse_duration(Some("1,234 ms")), Some(1234.0));
        assert_eq!(parse_duration(Some("2 min 5 s")), Some(125_000.0));
        assert_eq!(parse_duration(Some("500µs")), Some(0.5));
        assert_eq!(parse_duration(Some("3")), Some(3.0));
        assert_eq!(parse_duration(Some("slow")), None);
        assert_eq!(parse_duration(Some("  ")), None);
        assert_eq!(parse_duration(None), None);
    }

    #[test]
    fn formats_durations_with_a_readable_unit_a_space_and_grouped_digits() {
        assert_eq!(format_ms(4.271), "4.27 ms");
        assert_eq!(format_ms(41.27), "41.3 ms");
        assert_eq!(format_ms(245.4), "245 ms");
        assert_eq!(format_ms(1234.0), "1.23 s");
        assert_eq!(format_ms(30168.0), "30.2 s");
        assert_eq!(format_ms(125_000.0), "2 min 5 s");
        assert_eq!(format_ms(7_260_000.0), "121 min");
        assert_eq!(format_count(12345.0), "12,345");
        assert_eq!(format_bytes(-14162), "-13.83 KB");
    }

    #[test]
    fn reads_models_as_the_bridges_rows_or_the_packages_per_class_entries() {
        let rows = data(
            json!({ "models": [{ "model": "App\\Models\\Page", "retrieved": 2, "created": 1 }] }),
        );
        assert_eq!(
            toolbar_models(&rows),
            vec![ModelRow {
                model: "App\\Models\\Page".to_owned(),
                retrieved: Some(2),
                created: Some(1),
                ..ModelRow::default()
            }]
        );
        let entries = data(json!({ "models": {
            "App\\Models\\Page": { "model": "App\\Models\\Page", "action": "retrieved", "count": 1 },
            "App\\Models\\Article": { "model": "App\\Models\\Article", "action": "retrieved", "count": 4 }
        } }));
        let names: Vec<(String, Option<i64>)> = toolbar_models(&entries)
            .into_iter()
            .map(|m| (m.model, m.retrieved))
            .collect();
        assert_eq!(names.len(), 2);
        assert!(names.contains(&("App\\Models\\Page".to_owned(), Some(1))));
        assert!(names.contains(&("App\\Models\\Article".to_owned(), Some(4))));
        assert_eq!(model_count(&entries), 5);
    }

    #[test]
    fn names_the_framework_from_the_bridges_section_else_from_the_packages() {
        let laravel = framework(Some(&data(
            json!({ "laravel": { "version": "13.4.0", "timezone": "UTC" } }),
        )));
        assert_eq!(
            (
                laravel.name.as_str(),
                laravel.is_laravel,
                laravel.version.as_deref(),
                laravel.timezone.as_deref()
            ),
            ("Laravel", true, Some("13.4.0"), Some("UTC"))
        );
        let symfony = framework(Some(&data(
            json!({ "framework": { "name": "Symfony", "version": "8.1.2", "debug": true } }),
        )));
        assert_eq!(
            (
                symfony.name.as_str(),
                symfony.is_laravel,
                symfony.version.as_deref(),
                symfony.timezone.as_deref()
            ),
            ("Symfony", false, Some("8.1.2"), None)
        );
        assert_eq!(symfony.debug.as_deref(), Some("true"));
        let none = framework(Some(&page()));
        assert_eq!((none.name.as_str(), none.version), ("Laravel", None));
    }

    #[test]
    fn writes_bindings_into_placeholders_outside_quotes() {
        assert_eq!(
            inline_bindings(
                "select * from `t?` where a = ? and b = ? and c = '?' and d = ?",
                &[json!("it's"), json!(3), Value::Null]
            ),
            "select * from `t?` where a = 'it''s' and b = 3 and c = '?' and d = NULL"
        );
        assert_eq!(
            inline_bindings("select ? , ?", &[json!(true)]),
            "select 1 , ?"
        );
    }

    #[test]
    fn reads_queries_and_flags_issues() {
        let payload = data(json!({ "queries": { "queries": [
            { "sql": "select 1", "duration": 1.5, "is_slow": true, "percentage": 0.25, "offset": 0.0, "file": "/app/A.php", "line": 12, "bindings": [1] }
        ] } }));
        let all = queries(&payload);
        assert_eq!(all.len(), 1);
        assert!(all[0].is_slow && !all[0].is_duplicate);
        assert_eq!(all[0].line, Some(12));
        assert!(has_query_issues(&payload));
        assert!(!has_query_issues(&page()));
        assert_eq!(
            short_location(Some("/app/Http/A.php"), Some(12)).as_deref(),
            Some("A.php:12")
        );
        assert_eq!(short_location(None, None), None);
    }
}
