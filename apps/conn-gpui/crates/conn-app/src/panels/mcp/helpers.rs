//! Pure view-state helpers for the MCP panel, plus unit tests.

use std::collections::HashMap;
use std::path::Path;

use conn_desktop::mcp::McpCapabilities;
use conn_desktop::mcp::servers::{
    McpField, McpFieldType, McpRow, McpServerDraft, McpTransport, new_row_id, servers_from_mcp_json,
};
use conn_desktop::mcp::store::{
    McpLogEntry, McpPrompt, McpResource, McpResourceTemplate, McpSession, McpStatus, RpcId,
};

/// Top-level section tabs in the MCP panel (`McpPanel.tsx`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum PanelTab {
    #[default]
    Tools,
    Resources,
    Prompts,
    Log,
    Server,
}

impl PanelTab {
    pub(super) fn id(self) -> &'static str {
        match self {
            Self::Tools => "tools",
            Self::Resources => "resources",
            Self::Prompts => "prompts",
            Self::Log => "log",
            Self::Server => "server",
        }
    }

    pub(super) fn from_id(id: &str) -> Option<Self> {
        match id {
            "tools" => Some(Self::Tools),
            "resources" => Some(Self::Resources),
            "prompts" => Some(Self::Prompts),
            "log" => Some(Self::Log),
            "server" => Some(Self::Server),
            _ => None,
        }
    }

    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Tools => "Tools",
            Self::Resources => "Resources",
            Self::Prompts => "Prompts",
            Self::Log => "Log",
            Self::Server => "Server",
        }
    }

    pub(super) fn is_catalog(self) -> bool {
        matches!(self, Self::Tools | Self::Resources | Self::Prompts)
    }

    /// Noun used in `"Connect to the server to see its {noun}."`.
    pub(super) fn noun(self) -> &'static str {
        match self {
            Self::Tools => "tools",
            Self::Resources => "resources",
            Self::Prompts => "prompts",
            Self::Log => "log",
            Self::Server => "server",
        }
    }
}

/// Tab descriptor matching Conn's `McpPanel.tsx` tab list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct PanelTabInfo {
    pub(super) tab: PanelTab,
    pub(super) count: Option<usize>,
}

/// Which top-level tabs are visible for the current session state, and their counts.
pub(super) fn visible_tabs(session: &McpSession) -> Vec<PanelTabInfo> {
    let connected = session.status == McpStatus::Connected;
    let capabilities: Option<McpCapabilities> = session.info.as_ref().map(|info| info.capabilities);
    let mut tabs = Vec::with_capacity(5);

    if !connected || capabilities.is_some_and(|c| c.tools) {
        tabs.push(PanelTabInfo {
            tab: PanelTab::Tools,
            count: session.tools.as_ref().map(Vec::len),
        });
    }
    if !connected || capabilities.is_some_and(|c| c.resources) {
        let count = if session.resources.is_some() || session.templates.is_some() {
            Some(
                session.resources.as_ref().map_or(0, Vec::len)
                    + session.templates.as_ref().map_or(0, Vec::len),
            )
        } else {
            None
        };
        tabs.push(PanelTabInfo {
            tab: PanelTab::Resources,
            count,
        });
    }
    if !connected || capabilities.is_some_and(|c| c.prompts) {
        tabs.push(PanelTabInfo {
            tab: PanelTab::Prompts,
            count: session.prompts.as_ref().map(Vec::len),
        });
    }
    tabs.push(PanelTabInfo {
        tab: PanelTab::Log,
        count: Some(session.log.len()),
    });
    tabs.push(PanelTabInfo {
        tab: PanelTab::Server,
        count: None,
    });
    tabs
}

/// Keeps `current` if it is among `visible`, else falls back to [`PanelTab::Log`].
pub(super) fn resolve_active_tab(current: PanelTab, visible: &[PanelTabInfo]) -> PanelTab {
    if visible.iter().any(|info| info.tab == current) {
        current
    } else {
        PanelTab::Log
    }
}

/// Description shown beside each transport option in the Transport menu.
pub(super) fn transport_description(transport: McpTransport) -> &'static str {
    match transport {
        McpTransport::Stdio => "Local command",
        McpTransport::Http => "Streamable HTTP",
        McpTransport::Sse => "Legacy SSE",
    }
}

/// Human-readable type label for a schema field.
pub(super) fn field_type_label(field_type: McpFieldType) -> &'static str {
    match field_type {
        McpFieldType::String => "string",
        McpFieldType::Number => "number",
        McpFieldType::Integer => "integer",
        McpFieldType::Boolean => "boolean",
        McpFieldType::Enum => "enum",
        McpFieldType::Json => "json",
    }
}

/// Copies a server draft with fresh ids and `" copy"` appended to non-empty names.
pub(super) fn duplicate_server(server: &McpServerDraft) -> McpServerDraft {
    let dup_rows = |rows: &[McpRow]| -> Vec<McpRow> {
        rows.iter()
            .map(|row| McpRow {
                id: new_row_id(),
                name: row.name.clone(),
                value: row.value.clone(),
                enabled: row.enabled,
            })
            .collect()
    };
    McpServerDraft {
        id: new_row_id(),
        name: if server.name.is_empty() {
            String::new()
        } else {
            format!("{} copy", server.name)
        },
        transport: server.transport,
        command_line: server.command_line.clone(),
        url: server.url.clone(),
        headers: dup_rows(&server.headers),
        env: dup_rows(&server.env),
        cwd: server.cwd.clone(),
    }
}

/// Reads `<workspace_root>/.mcp.json` when present and parses its server drafts.
pub(super) fn load_project_mcp_json(workspace_root: Option<&str>) -> Vec<McpServerDraft> {
    let Some(root) = workspace_root.filter(|r| !r.is_empty()) else {
        return Vec::new();
    };
    let path = Path::new(root).join(".mcp.json");
    std::fs::read_to_string(path)
        .map(|contents| servers_from_mcp_json(&contents))
        .unwrap_or_default()
}

/// One row of the catalog item list (`McpCatalogViews.tsx` `ListItem`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct CatalogListItem {
    pub(super) id: String,
    pub(super) label: String,
    pub(super) detail: Option<String>,
}

/// Filters list items case-insensitively across `label` and `detail`.
pub(super) fn filter_catalog_items<'a>(
    items: &'a [CatalogListItem],
    query: &str,
) -> Vec<&'a CatalogListItem> {
    let needle = query.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return items.iter().collect();
    }
    items
        .iter()
        .filter(|item| {
            let haystack = match &item.detail {
                Some(detail) => format!("{} {detail}", item.label),
                None => item.label.clone(),
            };
            haystack.to_ascii_lowercase().contains(&needle)
        })
        .collect()
}

/// One entry in the Resources tab: a concrete resource or a URI template.
#[derive(Clone, Debug)]
pub(super) enum ResourceEntry {
    Resource {
        id: String,
        resource: McpResource,
    },
    Template {
        id: String,
        template: McpResourceTemplate,
    },
}

impl ResourceEntry {
    pub(super) fn id(&self) -> &str {
        match self {
            Self::Resource { id, .. } | Self::Template { id, .. } => id,
        }
    }

    pub(super) fn title(&self) -> &str {
        match self {
            Self::Resource { resource, .. } => resource.title.as_deref().unwrap_or(&resource.name),
            Self::Template { template, .. } => template.title.as_deref().unwrap_or(&template.name),
        }
    }

    pub(super) fn description(&self) -> Option<&str> {
        match self {
            Self::Resource { resource, .. } => resource.description.as_deref(),
            Self::Template { template, .. } => template.description.as_deref(),
        }
    }

    pub(super) fn mime_type(&self) -> Option<&str> {
        match self {
            Self::Resource { resource, .. } => resource.mime_type.as_deref(),
            Self::Template { template, .. } => template.mime_type.as_deref(),
        }
    }

    pub(super) fn uri_display(&self) -> &str {
        match self {
            Self::Resource { resource, .. } => &resource.uri,
            Self::Template { template, .. } => &template.uri_template,
        }
    }
}

/// Builds the combined list of resources followed by templates, plus the id of the first template.
pub(super) fn build_resource_entries(session: &McpSession) -> (Vec<ResourceEntry>, Option<String>) {
    let mut entries = Vec::new();
    if let Some(resources) = &session.resources {
        for resource in resources {
            entries.push(ResourceEntry::Resource {
                id: format!("resource:{}", resource.uri),
                resource: resource.clone(),
            });
        }
    }
    let mut first_template_id = None;
    if let Some(templates) = &session.templates {
        for template in templates {
            let id = format!("template:{}", template.uri_template);
            if first_template_id.is_none() {
                first_template_id = Some(id.clone());
            }
            entries.push(ResourceEntry::Template {
                id,
                template: template.clone(),
            });
        }
    }
    (entries, first_template_id)
}

/// Builds required string fields for a URI template's placeholder variables.
pub(super) fn template_fields(variables: &[String]) -> Vec<McpField> {
    variables
        .iter()
        .map(|name| McpField {
            name: name.clone(),
            field_type: McpFieldType::String,
            required: true,
            description: None,
            options: Vec::new(),
            default_text: String::new(),
        })
        .collect()
}

/// Builds string fields for a prompt's declared arguments.
pub(super) fn prompt_fields(prompt: &McpPrompt) -> Vec<McpField> {
    prompt
        .arguments
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|arg| McpField {
            name: arg.name.clone(),
            field_type: McpFieldType::String,
            required: arg.required == Some(true),
            description: arg.description.clone(),
            options: Vec::new(),
            default_text: String::new(),
        })
        .collect()
}

/// Validates required template variables, returning the first error message if any is blank.
pub(super) fn validate_template_variables(
    variables: &[String],
    values: &HashMap<String, String>,
) -> Result<(), String> {
    for name in variables {
        if values.get(name).is_none_or(|v| v.trim().is_empty()) {
            return Err(format!("{name} is required."));
        }
    }
    Ok(())
}

/// Validates required prompt arguments and builds the string map (omitting empty optional values).
pub(super) fn build_prompt_arguments(
    fields: &[McpField],
    values: &HashMap<String, String>,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    for field in fields {
        if field.required && values.get(&field.name).is_none_or(|v| v.trim().is_empty()) {
            return Err(format!("{} is required.", field.name));
        }
    }
    let mut args = serde_json::Map::new();
    for (key, value) in values {
        if !value.is_empty() {
            args.insert(key.clone(), serde_json::Value::String(value.clone()));
        }
    }
    Ok(args)
}

/// Formats an epoch millisecond timestamp as `HH:MM:SS.mmm` (UTC).
pub(super) fn format_log_time(at_ms: u64) -> String {
    let total_secs = at_ms / 1_000;
    let ms = at_ms % 1_000;
    let secs_of_day = total_secs % 86_400;
    let hours = secs_of_day / 3_600;
    let minutes = (secs_of_day % 3_600) / 60;
    let seconds = secs_of_day % 60;
    format!("{hours:02}:{minutes:02}:{seconds:02}.{ms:03}")
}

/// Formats an [`RpcId`] as `#<id>` for the Log tab.
pub(super) fn format_rpc_id(id: &RpcId) -> String {
    match id {
        RpcId::Number(n) => format!("#{n}"),
        RpcId::String(s) => format!("#{s}"),
    }
}

/// The main text label of a log row and whether to append muted `" result"`.
pub(super) fn log_row_label(entry: &McpLogEntry) -> (String, bool) {
    let label = match entry.kind.as_str() {
        "stderr" => entry
            .text
            .as_deref()
            .unwrap_or_default()
            .trim_end()
            .to_owned(),
        "closed" => "Connection closed".to_owned(),
        _ => entry
            .method
            .clone()
            .unwrap_or_else(|| "response".to_owned()),
    };
    let is_response = entry.kind == "receive" && entry.method.is_some() && entry.rpc_id.is_some();
    (label, is_response)
}

/// Estimated decoded byte count of a base64 payload (matches Conn's `Math.floor((len * 3) / 4)`).
pub(super) fn base64_byte_len(encoded: &str) -> i64 {
    let raw = (encoded.len().saturating_mul(3)) / 4;
    i64::try_from(raw).unwrap_or(i64::MAX)
}

/// Standard base64 decoder (ignores ASCII whitespace and optional padding) for inline result images.
pub(super) fn decode_base64(input: &str) -> Option<Vec<u8>> {
    fn val(b: u8) -> Option<u8> {
        match b {
            b'A'..=b'Z' => Some(b - b'A'),
            b'a'..=b'z' => Some(b - b'a' + 26),
            b'0'..=b'9' => Some(b - b'0' + 52),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    }

    let mut out = Vec::with_capacity((input.len() * 3) / 4);
    let mut buf: u32 = 0;
    let mut bits: u8 = 0;
    for byte in input.bytes() {
        if byte.is_ascii_whitespace() || byte == b'=' {
            continue;
        }
        let v = val(byte)?;
        buf = (buf << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}

/// Capitalizes the first ASCII character of a noun (`"tools"` → `"Tools"`).
pub(super) fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use conn_desktop::mcp::servers::{
        arguments_from_fields, expand_template, fields_from_schema, new_mcp_server,
        template_variables, to_desktop_mcp_server,
    };
    use conn_desktop::mcp::store::McpListKind;
    use conn_desktop::mcp::{
        McpConnectRequest, McpMethod, McpOptions, McpRequest, McpServerInfo, McpSessions,
    };
    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn visible_tabs_respect_connection_and_capabilities() {
        let mut session = McpSession::default();
        let disconnected = visible_tabs(&session);
        assert_eq!(
            disconnected.iter().map(|t| t.tab).collect::<Vec<_>>(),
            vec![
                PanelTab::Tools,
                PanelTab::Resources,
                PanelTab::Prompts,
                PanelTab::Log,
                PanelTab::Server,
            ],
            "disconnected shows all 5 tabs"
        );
        assert_eq!(
            resolve_active_tab(PanelTab::Tools, &disconnected),
            PanelTab::Tools,
            "tools remains active when disconnected"
        );

        session.status = McpStatus::Connected;
        session.info = Some(McpServerInfo {
            name: "demo".into(),
            title: None,
            version: "1.0".into(),
            protocol_version: Some("2025-06-18".into()),
            instructions: None,
            capabilities: McpCapabilities {
                tools: false,
                resources: true,
                prompts: false,
                logging: true,
            },
        });
        session.resources = Some(vec![McpResource {
            uri: "file:///a".into(),
            name: "a".into(),
            ..McpResource::default()
        }]);
        session.templates = Some(vec![McpResourceTemplate {
            uri_template: "file:///{id}".into(),
            name: "t".into(),
            ..McpResourceTemplate::default()
        }]);

        let connected = visible_tabs(&session);
        assert_eq!(
            connected,
            vec![
                PanelTabInfo {
                    tab: PanelTab::Resources,
                    count: Some(2),
                },
                PanelTabInfo {
                    tab: PanelTab::Log,
                    count: Some(0),
                },
                PanelTabInfo {
                    tab: PanelTab::Server,
                    count: None,
                },
            ],
            "only offered capabilities plus Log and Server appear"
        );
        assert_eq!(
            resolve_active_tab(PanelTab::Tools, &connected),
            PanelTab::Log,
            "unoffered active tab falls back to Log"
        );
    }

    #[test]
    fn duplicate_server_assigns_fresh_ids_and_copy_suffix() {
        let mut original = new_mcp_server(None);
        original.name = "Local".into();
        original.command_line = "python3 server.py".into();
        original.env = vec![McpRow::new("TOKEN", "abc")];
        original.headers = vec![McpRow::new("X-Test", "1")];

        let copy = duplicate_server(&original);
        assert_ne!(copy.id, original.id, "server gets fresh id");
        assert_eq!(copy.name, "Local copy", "name gets copy suffix");
        assert_eq!(copy.command_line, original.command_line, "command kept");
        assert_ne!(copy.env[0].id, original.env[0].id, "env row gets fresh id");
        assert_ne!(
            copy.headers[0].id, original.headers[0].id,
            "header row gets fresh id"
        );

        original.name.clear();
        let unnamed_copy = duplicate_server(&original);
        assert_eq!(unnamed_copy.name, "", "unnamed server stays unnamed");
    }

    #[test]
    fn filter_and_validation_helpers_work() {
        let items = vec![
            CatalogListItem {
                id: "echo".into(),
                label: "Echo".into(),
                detail: Some("Repeat a message".into()),
            },
            CatalogListItem {
                id: "sum".into(),
                label: "Sum".into(),
                detail: Some("Add numbers".into()),
            },
        ];
        assert_eq!(
            filter_catalog_items(&items, "repeat")
                .into_iter()
                .map(|i| i.id.as_str())
                .collect::<Vec<_>>(),
            vec!["echo"],
            "matches detail case-insensitively"
        );
        assert_eq!(
            filter_catalog_items(&items, "  ").len(),
            2,
            "blank filter returns all items"
        );

        let vars = template_variables("mem://{org}/{id}");
        let mut vals = HashMap::new();
        vals.insert("org".into(), "acme".into());
        assert_eq!(
            validate_template_variables(&vars, &vals).err().as_deref(),
            Some("id is required."),
            "missing template variable reported"
        );
        vals.insert("id".into(), "42".into());
        assert!(
            validate_template_variables(&vars, &vals).is_ok(),
            "filled template variables pass"
        );
        assert_eq!(
            expand_template("mem://{org}/{id}", &vals),
            "mem://acme/42",
            "template expands"
        );

        let prompt = McpPrompt {
            name: "greet".into(),
            title: None,
            description: None,
            arguments: Some(vec![
                conn_desktop::mcp::store::McpPromptArgument {
                    name: "who".into(),
                    description: None,
                    required: Some(true),
                },
                conn_desktop::mcp::store::McpPromptArgument {
                    name: "tone".into(),
                    description: None,
                    required: Some(false),
                },
            ]),
        };
        let fields = prompt_fields(&prompt);
        let mut pvals = HashMap::new();
        pvals.insert("who".into(), "world".into());
        pvals.insert("tone".into(), String::new());
        let built = build_prompt_arguments(&fields, &pvals).expect("valid prompt args");
        assert_eq!(
            Value::Object(built),
            json!({ "who": "world" }),
            "empty optional prompt args omitted"
        );
    }

    #[test]
    fn log_time_label_and_base64_helpers() {
        // 13:05:09.042 UTC
        let ms = ((13 * 3600) + (5 * 60) + 9) * 1000 + 42;
        assert_eq!(format_log_time(ms), "13:05:09.042", "formats HH:MM:SS.mmm");

        let recv_entry = McpLogEntry {
            id: 1,
            at: ms,
            kind: "receive".into(),
            method: Some("tools/list".into()),
            rpc_id: Some(RpcId::Number(2)),
            is_error: false,
            message: json!({ "jsonrpc": "2.0", "id": 2, "result": {} }),
            text: None,
        };
        assert_eq!(
            log_row_label(&recv_entry),
            ("tools/list".into(), true),
            "receive with method + rpcId appends result"
        );
        assert_eq!(
            format_rpc_id(&RpcId::Number(2)),
            "#2",
            "numeric rpc id format"
        );

        assert_eq!(
            decode_base64("SGVsbG8sIHdvcmxkIQ=="),
            Some(b"Hello, world!".to_vec()),
            "decodes standard base64"
        );
        assert_eq!(
            base64_byte_len("SGVsbG8="),
            6,
            "byte estimate matches Conn formula"
        );
    }

    #[test]
    fn fake_mcp_server_end_to_end_session_flow() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../conn-desktop/tests/fixtures/fake_mcp_server.py");
        if !fixture.exists() {
            return;
        }
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test tokio runtime");

        rt.block_on(async {
            let (sessions, mut events) = McpSessions::with_options(McpOptions {
                environment: Some(std::env::vars().collect()),
                ..McpOptions::default()
            });
            let mut draft = new_mcp_server(None);
            draft.command_line = format!("python3 {}", fixture.display());
            let server = to_desktop_mcp_server(&draft, None).expect("valid stdio server");
            let session_id = "test-session".to_owned();

            let mut state = McpSession::default();
            state.begin_connect();
            let connect_res = sessions
                .connect(McpConnectRequest {
                    session_id: session_id.clone(),
                    server,
                })
                .await;
            assert!(
                state.finish_connect(connect_res),
                "fake server connects cleanly"
            );
            assert_eq!(
                state.info.as_ref().and_then(|i| i.title.as_deref()),
                Some("Fake Server"),
                "server title captured"
            );

            let kinds = state.lists_to_load(&McpListKind::ALL);
            assert_eq!(kinds, McpListKind::ALL.to_vec(), "offers all three lists");

            let tools_res = sessions
                .request(McpRequest {
                    session_id: session_id.clone(),
                    method: McpMethod::ToolsList,
                    params: json!({}),
                })
                .await;
            state.apply_list(McpListKind::Tools, &tools_res);
            let tool = state.shown_tool().expect("first tool selected").clone();
            assert_eq!(tool.name, "echo", "first tool is echo");

            let fields = fields_from_schema(&tool.input_schema);
            let mut form = HashMap::new();
            form.insert("message".into(), "hello mcp".into());
            let args = arguments_from_fields(&fields, &form).expect("args parse");
            let call_res = sessions
                .request(McpRequest {
                    session_id: session_id.clone(),
                    method: McpMethod::ToolsCall,
                    params: json!({ "name": tool.name, "arguments": args }),
                })
                .await;
            assert!(call_res.error.is_none(), "echo call succeeds");
            assert_eq!(
                conn_desktop::mcp::results::raw_result_text(&call_res.result),
                "hello mcp",
                "echo returns message"
            );

            while let Ok(ev) = events.try_recv() {
                let _ = state.receive_event(&ev);
            }
            assert!(!state.log.is_empty(), "log captured session traffic");

            sessions.disconnect_all().await;
        });
    }
}
