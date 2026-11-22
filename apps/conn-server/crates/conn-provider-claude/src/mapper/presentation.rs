//! How a tool row looks, as `buildToolCallArtifacts` in `ClaudeAdapterV2.ts` builds it: the
//! title (`formatReadToolLabel`, `formatSearchToolLabel`, `dynamicToolTitle` from
//! `@t3tools/shared/toolActivity`, then the MCP presentation), the MCP tool's source and icon
//! (`mcpToolPresentation` from `@t3tools/provider-core`), and a web search's patterns and
//! results.

use serde_json::{Map, Value, json};

/// `mcpToolPresentation`'s result.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Presentation {
    pub title: Option<String>,
    pub icon: Option<Value>,
    pub source: Option<Value>,
}

/// T3's own `/mcp` server names (`T3_MCP_SERVER_ALIASES`). T3 shows its own tools with
/// labels of their own (`resolveT3McpToolDefinition`), so they get no presentation here.
const T3_SERVERS: &[&str] = &[
    "conn",
    "conn-direct",
    "conn_direct",
    "t3-code",
    "t3_code",
    "t3code",
    "t3-code-direct",
    "t3_code_direct",
];

const WEB_FETCH_SNIPPET_MAX_CHARS: usize = 8_000;

/// `normalizeMcpText`: trimmed, runs of white space as one space, 1 to `max` characters.
fn mcp_text(value: Option<&Value>, max: usize) -> Option<String> {
    let text = value?
        .as_str()?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let count = text.chars().count();
    (count > 0 && count <= max).then_some(text)
}

/// `normalizeMcpHttpUrl`, reduced: an `http`/`https` URL of at most 4096 bytes, unchanged.
/// T3 passes it through `new URL(...)`, which also normalizes it; the CLI sends absolute URLs.
fn mcp_http_url(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    if text.len() > 4096 || text.chars().any(char::is_whitespace) {
        return None;
    }
    let lower = text.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))?;
    (!rest.is_empty()).then(|| text.to_string())
}

/// `/^mcp__(.+?)__(.+)$/i`: the server and the tool of a qualified MCP tool name.
fn qualified(name: &str) -> Option<(&str, &str)> {
    let head = name.get(..5)?;
    if !head.eq_ignore_ascii_case("mcp__") {
        return None;
    }
    let rest = name.get(5..)?;
    // Lazy `.+?`: the first `__` after at least one character.
    let at = rest.get(1..)?.find("__")? + 1;
    let server = rest.get(..at)?;
    let tool = rest.get(at + 2..)?;
    (!tool.is_empty()).then_some((server, tool))
}

/// `mcpToolPresentation({toolName, title, serverDisplayName, iconUrl})`.
pub(crate) fn mcp_presentation(tool_name: &str, meta: Option<&Value>) -> Presentation {
    let field = |key: &str| meta.and_then(|m| m.get(key));
    let parts = qualified(tool_name);
    let server = mcp_text(
        parts
            .map(|(s, _)| Value::String(s.to_string()))
            .as_ref()
            .or_else(|| field("server_display_name")),
        160,
    );
    let tool = mcp_text(
        Some(&Value::String(
            parts.map_or(tool_name, |(_, t)| t).to_string(),
        )),
        160,
    );
    if let (Some(server), Some(_)) = (&server, &tool)
        && T3_SERVERS.contains(&server.to_lowercase().as_str())
    {
        return Presentation::default();
    }
    let title = mcp_text(field("display_name"), 160).or_else(|| match (&server, &tool) {
        (Some(_), Some(tool)) => mcp_text(Some(&Value::String(spaced_runs(tool))), 160),
        _ => None,
    });
    let Some(server) = server else {
        return Presentation {
            title,
            ..Presentation::default()
        };
    };
    let name = mcp_text(field("server_display_name"), 160)
        .or_else(|| mcp_text(Some(&Value::String(spaced_runs(&server))), 160))
        .unwrap_or_else(|| server.clone());
    let icon =
        mcp_http_url(field("icon_url")).map(|logo| json!({"_tag": "themed-logo", "logoUrl": logo}));
    let mut source = json!({
        "key": format!("mcp:{}", server.to_lowercase()),
        "name": name,
        "kind": "integration",
    });
    if let Some(icon) = &icon {
        source["icon"] = icon.clone();
    }
    Presentation {
        title,
        icon,
        source: Some(source),
    }
}

/// `tool.replace(/[_-]+/gu, " ")`: each run of `_` and `-` becomes one space (ends kept).
fn spaced_runs(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if c == '_' || c == '-' {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// The presentation of a `tool_use` block: its `tool_use_meta` entry when the assistant
/// message has one, else what the name gives (`claudeToolPresentationsFromAssistantMessage`).
pub(crate) fn for_tool_use(name: &str, id: &str, tool_use_meta: Option<&Value>) -> Presentation {
    let display_name = name
        .strip_prefix("mcp__claude_ai_")
        .map_or_else(|| name.to_string(), |rest| format!("mcp__{rest}"));
    let entry = tool_use_meta.and_then(Value::as_array).and_then(|list| {
        list.iter()
            .find(|e| mcp_text(e.get("id"), 512).as_deref() == Some(id))
    });
    mcp_presentation(&display_name, entry)
}

fn trimmed(value: Option<&Value>) -> Option<&str> {
    value?.as_str().map(str::trim).filter(|s| !s.is_empty())
}

fn first_input(input: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| trimmed(input.get(*k)))
        .map(str::to_string)
}

/// `formatSearchToolLabel({input})`.
fn search_label(input: &Value) -> Option<String> {
    let query = first_input(
        input,
        &["pattern", "query", "searchTerm", "regex", "grep", "needle"],
    );
    let glob = first_input(
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
    let target = first_input(
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
            .map(str::to_string)
    });
    match (query, glob, target) {
        (Some(q), _, Some(t)) => Some(format!("Searched {q} in {t}")),
        (None, Some(g), Some(t)) => Some(format!("Searched files {g} in {t}")),
        (None, Some(g), None) => Some(format!("Searched files {g}")),
        (Some(q), _, None) => Some(format!("Searched {q}")),
        (None, None, Some(t)) => Some(format!("Searched in {t}")),
        (None, None, None) => None,
    }
}

/// `dynamicToolTitle(toolName, input)` without a retained title.
fn dynamic_title(name: &str, input: &Value) -> Option<String> {
    if matches!(name, "js" | "cua_repl.js" | "node_repl.js") {
        let code = input.get("code").and_then(Value::as_str).unwrap_or("");
        let computer = name == "cua_repl.js"
            || code.contains("@oai/sky")
            || code.match_indices("sky").any(|(at, _)| {
                let before = code.get(..at).and_then(|b| b.chars().next_back());
                let after = code.get(at + 3..).unwrap_or("").trim_start();
                before.is_none_or(|c| !c.is_alphanumeric() && c != '_') && after.starts_with('.')
            });
        return Some(trimmed(input.get("title")).map_or_else(
            || {
                if computer {
                    "Computer use"
                } else {
                    "Run JavaScript"
                }
                .to_string()
            },
            str::to_string,
        ));
    }
    if name == "Skill" {
        return trimmed(input.get("skill")).map(|skill| format!("Skill: {skill}"));
    }
    None
}

/// The row's title, in T3's order: a read's path, a search's label, the dynamic tool title,
/// then the MCP presentation.
pub(crate) fn title(name: &str, input: &Value, presentation: &Presentation) -> Option<String> {
    let normalized: String = name
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '_' && *c != '-')
        .collect();
    if normalized == "read"
        && let Some(path) = first_input(input, &["file_path", "path"])
    {
        return Some(format!("Read {path}"));
    }
    if matches!(normalized.as_str(), "grep" | "glob" | "ls")
        && let Some(label) = search_label(input)
    {
        return Some(label);
    }
    dynamic_title(name, input).or_else(|| presentation.title.clone())
}

/// `isClaudeWebSearchOutput`.
fn web_search_output(output: Option<&Value>) -> Option<&Map<String, Value>> {
    let obj = output?.as_object()?;
    (obj.get("query").is_some_and(Value::is_string)
        && obj.get("results").is_some_and(Value::is_array)
        && obj.get("durationSeconds").is_some_and(Value::is_number))
    .then_some(obj)
}

/// A web search row's `patterns` and `results` (`webSearchPatternsFromClaudeTool`,
/// `webSearchResultsFromClaudeOutput`, and a WebFetch's snippet).
pub(crate) fn web_search_fields(
    name: &str,
    input: &Value,
    output: Option<&Value>,
    item: &mut Map<String, Value>,
) {
    let search = web_search_output(output);
    let pattern = first_input(input, &["query", "url", "pattern"])
        .or_else(|| {
            search
                .and_then(|o| o.get("query"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|p| !p.trim().is_empty());
    if let Some(pattern) = pattern {
        item.insert("patterns".into(), json!([pattern]));
    }
    let results: Vec<Value> = search
        .and_then(|o| o.get("results"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|r| r.get("content").and_then(Value::as_array))
                .flatten()
                .map(|c| json!({"title": c.get("title"), "url": c.get("url")}))
                .collect()
        })
        .unwrap_or_default();
    if !results.is_empty() {
        item.insert("results".into(), json!(results));
        return;
    }
    let normalized: String = name
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '_' && *c != '-')
        .collect();
    if normalized != "webfetch" {
        return;
    }
    let text = match output {
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    };
    if text.trim().is_empty() {
        return;
    }
    // `slice(0, 8000)` counts UTF-16 units; this counts characters.
    let snippet: String = text.chars().take(WEB_FETCH_SNIPPET_MAX_CHARS).collect();
    let mut result = json!({"snippet": snippet});
    if let Some(url) = first_input(input, &["url"]) {
        result["url"] = json!(url);
    }
    item.insert("results".into(), json!([result]));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_presentation_follows_t3() {
        let meta = json!([{
            "id": "toolu_1",
            "display_name": "Firecrawl scrape",
            "server_display_name": "Firecrawl",
            "icon_url": "https://www.google.com/s2/favicons?domain=firecrawl.dev&sz=64",
        }]);
        let scrape = for_tool_use(
            "mcp__claude_ai_Firecrawl__firecrawl_scrape",
            "toolu_1",
            Some(&meta),
        );
        assert_eq!(scrape.title.as_deref(), Some("Firecrawl scrape"));
        let icon = json!({"_tag": "themed-logo", "logoUrl": "https://www.google.com/s2/favicons?domain=firecrawl.dev&sz=64"});
        assert_eq!(scrape.icon.as_ref(), Some(&icon));
        assert_eq!(
            scrape.source,
            Some(
                json!({"key": "mcp:firecrawl", "name": "Firecrawl", "kind": "integration", "icon": icon})
            )
        );
        let map = for_tool_use(
            "mcp__claude_ai_Firecrawl__firecrawl_map",
            "toolu_2",
            Some(&meta),
        );
        assert_eq!(map.title.as_deref(), Some("firecrawl map"));
        assert_eq!(
            map.source,
            Some(json!({"key": "mcp:firecrawl", "name": "Firecrawl", "kind": "integration"}))
        );
        assert_eq!(
            for_tool_use("mcp__conn__conn_thread_list", "x", None),
            Presentation::default()
        );
        assert_eq!(for_tool_use("Bash", "x", None), Presentation::default());
        assert_eq!(
            for_tool_use("mcp__my-server__do__it", "x", None)
                .title
                .as_deref(),
            Some("do it")
        );
    }

    #[test]
    fn titles_follow_t3() {
        let none = Presentation::default();
        assert_eq!(
            title("Read", &json!({"file_path": " /a/b.rs "}), &none).as_deref(),
            Some("Read /a/b.rs")
        );
        assert_eq!(
            title("Grep", &json!({"pattern": "fn", "path": "/x/src/"}), &none).as_deref(),
            Some("Searched fn in src")
        );
        assert_eq!(
            title("Glob", &json!({"pattern": "*.rs"}), &none).as_deref(),
            Some("Searched *.rs")
        );
        assert_eq!(
            title("Skill", &json!({"skill": "review"}), &none).as_deref(),
            Some("Skill: review")
        );
        assert_eq!(title("Bash", &json!({"command": "ls"}), &none), None);
    }

    #[test]
    fn web_search_fields_follow_t3() {
        let mut item = Map::new();
        let output = json!({"query": "q", "durationSeconds": 1.5, "results": [
            "text", {"tool_use_id": "t", "content": [{"title": "FIFA", "url": "https://fifa.com"}]}
        ]});
        web_search_fields(
            "WebSearch",
            &json!({"query": "tickets"}),
            Some(&output),
            &mut item,
        );
        assert_eq!(item["patterns"], json!(["tickets"]));
        assert_eq!(
            item["results"],
            json!([{"title": "FIFA", "url": "https://fifa.com"}])
        );
        let mut fetch = Map::new();
        web_search_fields(
            "WebFetch",
            &json!({"url": "https://a.b"}),
            Some(&json!("page")),
            &mut fetch,
        );
        assert_eq!(
            fetch["results"],
            json!([{"url": "https://a.b", "snippet": "page"}])
        );
    }
}
