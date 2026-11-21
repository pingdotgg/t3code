//! The MCP panel's state, without the UI (Conn's `apps/web/src/mcp/mcpStore.ts`): saved
//! servers per project, and per session its status, lists, log, calls, and forms. The panel
//! owns one [`McpServerStore`] (persisted) and one [`McpSession`] per session key; it calls the
//! reducers here as [`McpSessions`](super::McpSessions) answers and its events arrive.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::servers::{
    AgentMcpCallResult, McpServerDraft, agent_tool_call_result, fields_from_schema,
    form_from_arguments, mcp_server_label,
};
use super::types::{
    McpCapabilities, McpConnectResponse, McpEvent, McpEventKind, McpMethod, McpResponse,
    McpServerInfo,
};

/// The persisted store's name in Conn's `localStorage`.
pub const SERVER_STORE_NAME: &str = "t3code:mcp-servers:v1";
/// The most log rows a session keeps.
pub const MAX_LOG_ENTRIES: usize = 1_000;

// ─── What servers list ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolAnnotations {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_only_hint: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destructive_hint: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotent_hint: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_world_hint: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub input_schema: Value,
    #[serde(default)]
    pub output_schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<McpToolAnnotations>,
    /// `_meta`, where MCP Apps put `ui.resourceUri`.
    #[serde(default, rename = "_meta", skip_serializing_if = "Value::is_null")]
    pub meta: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResource {
    pub uri: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceTemplate {
    pub uri_template: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpPromptArgument {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpPrompt {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Vec<McpPromptArgument>>,
}

/// The items of `response.result[name]` that parse; others are skipped.
pub fn list_of<T: serde::de::DeserializeOwned>(response: &McpResponse, name: &str) -> Vec<T> {
    response
        .result
        .get(name)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| serde_json::from_value(item.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

// ─── Saved servers ──────────────────────────────────────────────────────────

/// One project's saved servers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpProjectServers {
    pub servers: Vec<McpServerDraft>,
    pub selected_id: Option<String>,
}

impl McpProjectServers {
    /// Adds the server (replacing one with its id) and selects it.
    pub fn add(&mut self, server: McpServerDraft) {
        self.servers.retain(|candidate| candidate.id != server.id);
        self.selected_id = Some(server.id.clone());
        self.servers.push(server);
    }

    /// Edits the server with `id`; its id stays.
    pub fn change(&mut self, id: &str, patch: impl FnOnce(&mut McpServerDraft)) {
        if let Some(server) = self.servers.iter_mut().find(|server| server.id == id) {
            patch(server);
            server.id = id.to_owned();
        }
    }

    pub fn select(&mut self, id: &str) {
        self.selected_id = Some(id.to_owned());
    }

    /// Removes the server; when it was selected, its neighbour is.
    pub fn remove(&mut self, id: &str) {
        let index = self.servers.iter().position(|server| server.id == id);
        self.servers.retain(|server| server.id != id);
        if self.selected_id.as_deref() == Some(id) {
            let neighbour = index.and_then(|index| {
                self.servers
                    .get(index.min(self.servers.len().saturating_sub(1)))
            });
            self.selected_id = neighbour.map(|server| server.id.clone());
        }
    }

    /// The selected server, if any.
    pub fn selected(&self) -> Option<&McpServerDraft> {
        let id = self.selected_id.as_deref()?;
        self.servers.iter().find(|server| server.id == id)
    }
}

/// Saved servers by project key; persist it as JSON under [`SERVER_STORE_NAME`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStore {
    pub by_project_key: HashMap<String, McpProjectServers>,
}

impl McpServerStore {
    pub fn project(&self, project_key: &str) -> Option<&McpProjectServers> {
        self.by_project_key.get(project_key)
    }

    pub fn project_mut(&mut self, project_key: &str) -> &mut McpProjectServers {
        self.by_project_key
            .entry(project_key.to_owned())
            .or_default()
    }
}

// ─── Sessions ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpStatus {
    #[default]
    Disconnected,
    Connecting,
    Connected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpListKind {
    Tools,
    Resources,
    Prompts,
}

impl McpListKind {
    pub const ALL: [Self; 3] = [Self::Tools, Self::Resources, Self::Prompts];

    /// The `list_changed` notification that marks this list stale.
    fn from_notification(method: &str) -> Option<Self> {
        match method {
            "notifications/tools/list_changed" => Some(Self::Tools),
            "notifications/resources/list_changed" => Some(Self::Resources),
            "notifications/prompts/list_changed" => Some(Self::Prompts),
            _ => None,
        }
    }

    fn offered(self, capabilities: &McpCapabilities) -> bool {
        match self {
            Self::Tools => capabilities.tools,
            Self::Resources => capabilities.resources,
            Self::Prompts => capabilities.prompts,
        }
    }

    /// The requests that load this list (resources also loads templates).
    pub fn methods(self) -> &'static [McpMethod] {
        match self {
            Self::Tools => &[McpMethod::ToolsList],
            Self::Resources => &[McpMethod::ResourcesList, McpMethod::ResourceTemplatesList],
            Self::Prompts => &[McpMethod::PromptsList],
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpDetailTab {
    #[default]
    Overview,
    Playground,
}

/// A JSON-RPC id.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcId {
    Number(i64),
    String(String),
}

impl RpcId {
    fn from_value(value: Option<&Value>) -> Option<Self> {
        match value? {
            Value::String(id) => Some(Self::String(id.clone())),
            Value::Number(id) => id.as_i64().map(Self::Number),
            _ => None,
        }
    }
}

/// One row of the Log tab.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpLogEntry {
    pub id: u64,
    pub at: u64,
    /// `send`, `receive`, `stderr`, or `closed`.
    pub kind: String,
    /// The request's method, also on its response.
    pub method: Option<String>,
    pub rpc_id: Option<RpcId>,
    pub is_error: bool,
    pub message: Value,
    pub text: Option<String>,
}

/// One call's last result.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct McpCall {
    pub response: Option<McpResponse>,
    pub running: bool,
}

/// One session's panel state.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct McpSession {
    pub status: McpStatus,
    pub error: Option<String>,
    pub info: Option<McpServerInfo>,
    pub tools: Option<Vec<McpTool>>,
    pub resources: Option<Vec<McpResource>>,
    pub templates: Option<Vec<McpResourceTemplate>>,
    pub prompts: Option<Vec<McpPrompt>>,
    pub list_errors: HashMap<McpListKind, String>,
    pub log: Vec<McpLogEntry>,
    /// The last result per tool call, resource read, or prompt get, by the panel's call key
    /// (for example `tool:search`).
    pub calls: HashMap<String, McpCall>,
    /// Form text per call key, so arguments survive switching tools and tabs.
    pub forms: HashMap<String, HashMap<String, String>>,
    /// The tool the Tools tab shows; `None` for the first.
    pub selected_tool: Option<String>,
    /// The selected item's tab, kept across items.
    pub detail_tab: McpDetailTab,
    /// Request ids to methods, so a response's log row names its method.
    pending_methods: HashMap<RpcId, String>,
    next_log_id: u64,
}

/// One session per saved server of a project.
pub fn mcp_session_key(project_key: &str, server_id: &str) -> String {
    format!("{project_key}\u{0}{server_id}")
}

impl McpSession {
    /// Starts a connect: typed arguments, the picked tool, and the tab survive; the rest
    /// starts over.
    pub fn begin_connect(&mut self) {
        *self = Self {
            status: McpStatus::Connecting,
            forms: std::mem::take(&mut self.forms),
            selected_tool: self.selected_tool.take(),
            detail_tab: self.detail_tab,
            next_log_id: self.next_log_id,
            ..Self::default()
        };
    }

    /// Applies `connect`'s answer; true when connected, and the lists should load. An answer
    /// for a connect the user already left (disconnected) is ignored.
    pub fn finish_connect(&mut self, response: McpConnectResponse) -> bool {
        if self.status != McpStatus::Connecting {
            return false;
        }
        match (response.error, response.info) {
            (None, Some(info)) => {
                self.status = McpStatus::Connected;
                self.error = None;
                self.info = Some(info);
                true
            }
            (error, _) => {
                self.status = McpStatus::Disconnected;
                self.error = error;
                false
            }
        }
    }

    pub fn disconnect(&mut self) {
        self.status = McpStatus::Disconnected;
        self.error = None;
        self.pending_methods.clear();
    }

    /// The lists to load among `kinds`: those the server offers.
    pub fn lists_to_load(&self, kinds: &[McpListKind]) -> Vec<McpListKind> {
        let Some(info) = &self.info else {
            return Vec::new();
        };
        kinds
            .iter()
            .copied()
            .filter(|kind| kind.offered(&info.capabilities))
            .collect()
    }

    /// Applies a tools or prompts list answer.
    pub fn apply_list(&mut self, kind: McpListKind, response: &McpResponse) {
        match kind {
            McpListKind::Tools => self.tools = Some(list_of(response, "tools")),
            McpListKind::Prompts => self.prompts = Some(list_of(response, "prompts")),
            McpListKind::Resources => {
                self.resources = Some(list_of(response, "resources"));
            }
        }
        self.set_list_error(kind, response.error.clone());
    }

    /// Applies the resources and templates answers. Templates are optional; a server without
    /// them may answer with an error.
    pub fn apply_resources(&mut self, resources: &McpResponse, templates: &McpResponse) {
        self.resources = Some(list_of(resources, "resources"));
        self.templates = Some(if templates.error.is_some() {
            Vec::new()
        } else {
            list_of(templates, "resourceTemplates")
        });
        self.set_list_error(McpListKind::Resources, resources.error.clone());
    }

    fn set_list_error(&mut self, kind: McpListKind, error: Option<String>) {
        match error {
            Some(error) => self.list_errors.insert(kind, error),
            None => self.list_errors.remove(&kind),
        };
    }

    /// Adds the event to the log. Returns a list the server says changed, to reload.
    pub fn receive_event(&mut self, event: &McpEvent) -> Option<McpListKind> {
        let message = event.kind.message();
        let field = |name: &str| message.and_then(|message| message.get(name));
        let rpc_id = RpcId::from_value(field("id"));
        let mut method = field("method").and_then(Value::as_str).map(str::to_owned);
        if let (Some(method), Some(id), McpEventKind::Send { .. }) = (&method, &rpc_id, &event.kind)
        {
            self.pending_methods.insert(id.clone(), method.clone());
        }
        if method.is_none()
            && let Some(id) = &rpc_id
        {
            method = self.pending_methods.remove(id);
        }
        self.next_log_id += 1;
        let entry = McpLogEntry {
            id: self.next_log_id,
            at: event.at,
            kind: event.kind.as_str().to_owned(),
            method: method.clone(),
            rpc_id,
            is_error: field("error").is_some(),
            message: message.cloned().unwrap_or(Value::Null),
            text: event.kind.text().map(str::to_owned),
        };
        if self.log.len() >= MAX_LOG_ENTRIES {
            let excess = self.log.len() + 1 - MAX_LOG_ENTRIES;
            self.log.drain(..excess);
        }
        self.log.push(entry);
        if event.kind == McpEventKind::Closed {
            self.status = McpStatus::Disconnected;
            self.error = Some("The server closed the connection.".into());
            self.pending_methods.clear();
        }
        match (&event.kind, method) {
            (McpEventKind::Receive { .. }, Some(method)) => McpListKind::from_notification(&method),
            _ => None,
        }
    }

    /// Marks a call running, keeping its last result on screen.
    pub fn start_call(&mut self, call_key: &str) {
        let call = self.calls.entry(call_key.to_owned()).or_default();
        call.running = true;
    }

    pub fn finish_call(&mut self, call_key: &str, response: McpResponse) {
        self.calls.insert(
            call_key.to_owned(),
            McpCall {
                response: Some(response),
                running: false,
            },
        );
    }

    /// Shows a validation problem in the result area, as a failed call would.
    pub fn fail_call(&mut self, call_key: &str, error: impl Into<String>) {
        self.finish_call(call_key, McpResponse::failed(error, 0.0));
    }

    pub fn set_form(&mut self, call_key: &str, values: HashMap<String, String>) {
        self.forms.insert(call_key.to_owned(), values);
    }

    pub fn clear_log(&mut self) {
        self.log.clear();
    }

    /// The tool the Tools tab shows: the selected one, else the first.
    pub fn shown_tool(&self) -> Option<&McpTool> {
        let tools = self.tools.as_deref()?;
        self.selected_tool
            .as_deref()
            .and_then(|name| tools.iter().find(|tool| tool.name == name))
            .or_else(|| tools.first())
    }
}

// ─── Agent requests ─────────────────────────────────────────────────────────

const AGENT_DESCRIPTION_CHARS: usize = 200;

/// A tool as an agent sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentMcpTool {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// What an agent gets after connecting a server (Conn's `AgentPanelMcpResult`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMcpResult {
    pub server: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_info: Option<String>,
    pub tools: Vec<AgentMcpTool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_count: Option<usize>,
}

/// The connected session's summary for the agent that asked for it.
pub fn agent_connect_result(draft: &McpServerDraft, session: &McpSession) -> AgentMcpResult {
    AgentMcpResult {
        server: mcp_server_label(draft),
        server_info: session.info.as_ref().map(|info| {
            format!(
                "{} {}",
                info.title.as_deref().unwrap_or(&info.name),
                info.version
            )
        }),
        tools: session
            .tools
            .iter()
            .flatten()
            .map(|tool| AgentMcpTool {
                name: tool.name.clone(),
                description: tool
                    .description
                    .as_deref()
                    .filter(|description| !description.is_empty())
                    .map(|description| description.chars().take(AGENT_DESCRIPTION_CHARS).collect()),
            })
            .collect(),
        resource_count: session.resources.as_ref().map(Vec::len),
        prompt_count: session.prompts.as_ref().map(Vec::len),
    }
}

/// The saved server an agent's call names (by name or URL), else the selected or first one.
pub fn agent_call_server<'a>(
    project: Option<&'a McpProjectServers>,
    wanted: Option<&str>,
) -> Result<&'a McpServerDraft, String> {
    let servers = project.map_or(&[][..], |project| project.servers.as_slice());
    let wanted_lower = wanted
        .map(|name| name.trim().to_lowercase())
        .filter(|name| !name.is_empty());
    let draft = match &wanted_lower {
        Some(wanted) => servers.iter().find(|server| {
            server.name.trim().to_lowercase() == *wanted
                || server.url.trim().to_lowercase() == *wanted
        }),
        None => project
            .and_then(McpProjectServers::selected)
            .or_else(|| servers.first()),
    };
    draft.ok_or_else(|| {
        let names = servers.iter().map(mcp_server_label).collect::<Vec<_>>();
        let names = if names.is_empty() {
            "none".to_owned()
        } else {
            names.join(", ")
        };
        let named = wanted
            .filter(|name| !name.is_empty())
            .map(|name| format!(" named \"{name}\""))
            .unwrap_or_default();
        format!("No saved MCP server{named}. Servers: {names}. Add one with mcp_connect.")
    })
}

/// Prepares an agent's tool call the way a user makes one: selects the tool, fills its form,
/// and opens the playground. Returns the call key and `tools/call` params to run.
pub fn prepare_agent_tool_call(
    draft: &McpServerDraft,
    session: &mut McpSession,
    tool_name: &str,
    arguments: &Map<String, Value>,
) -> Result<(String, Value), String> {
    let tools = session.tools.as_deref().unwrap_or_default();
    let Some(tool) = tools.iter().find(|tool| tool.name == tool_name) else {
        let names = tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>();
        let names = if names.is_empty() {
            "none".to_owned()
        } else {
            names.join(", ")
        };
        return Err(format!(
            "{} has no tool \"{tool_name}\". Tools: {names}.",
            mcp_server_label(draft)
        ));
    };
    let call_key = format!("tool:{}", tool.name);
    let form = form_from_arguments(&fields_from_schema(&tool.input_schema), arguments);
    let name = tool.name.clone();
    session.set_form(&call_key, form);
    session.selected_tool = Some(name.clone());
    session.detail_tab = McpDetailTab::Playground;
    let params = serde_json::json!({ "name": name, "arguments": arguments });
    Ok((call_key, params))
}

/// The agent's answer once the call's response is in.
pub fn agent_tool_call_outcome(
    draft: &McpServerDraft,
    tool_name: &str,
    response: &McpResponse,
) -> Result<AgentMcpCallResult, String> {
    if let Some(error) = &response.error {
        return Err(error.clone());
    }
    Ok(agent_tool_call_result(
        &mcp_server_label(draft),
        tool_name,
        response,
    ))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn event(kind: McpEventKind) -> McpEvent {
        McpEvent {
            session_id: "s".into(),
            at: 7,
            kind,
        }
    }

    fn draft(id: &str, name: &str) -> McpServerDraft {
        McpServerDraft {
            id: id.into(),
            name: name.into(),
            ..McpServerDraft::default()
        }
    }

    #[test]
    fn saved_servers_add_select_and_remove() {
        let mut project = McpProjectServers::default();
        project.add(draft("a", "A"));
        project.add(draft("b", "B"));
        project.add(draft("c", "C"));
        assert_eq!(project.selected_id.as_deref(), Some("c"), "added selects");
        project.change("b", |server| {
            server.name = "Bee".into();
            server.id = "evil".into();
        });
        assert_eq!(project.servers[1].id, "b", "id kept");
        assert_eq!(project.servers[1].name, "Bee", "patched");
        project.select("b");
        project.remove("b");
        assert_eq!(project.selected_id.as_deref(), Some("c"), "neighbour");
        project.remove("c");
        assert_eq!(project.selected_id.as_deref(), Some("a"), "last neighbour");
        project.remove("a");
        assert_eq!(project.selected_id, None, "empty");
        let mut store = McpServerStore::default();
        store.project_mut("p").add(draft("x", "X"));
        let json = serde_json::to_value(&store).expect("json");
        assert_eq!(
            json["byProjectKey"]["p"]["selectedId"],
            json!("x"),
            "Conn's persisted shape"
        );
    }

    #[test]
    fn log_names_responses_by_their_request() {
        let mut session = McpSession::default();
        session.begin_connect();
        session.receive_event(&event(McpEventKind::Send {
            message: json!({"jsonrpc":"2.0","id":3,"method":"tools/list"}),
        }));
        session.receive_event(&event(McpEventKind::Receive {
            message: json!({"jsonrpc":"2.0","id":3,"error":{"code":-1,"message":"x"}}),
        }));
        assert_eq!(
            session.log[1].method.as_deref(),
            Some("tools/list"),
            "method"
        );
        assert!(session.log[1].is_error, "error");
        assert_eq!(session.log[1].rpc_id, Some(RpcId::Number(3)), "id");
        let changed = session.receive_event(&event(McpEventKind::Receive {
            message: json!({"jsonrpc":"2.0","method":"notifications/tools/list_changed"}),
        }));
        assert_eq!(changed, Some(McpListKind::Tools), "reload tools");
        session.receive_event(&event(McpEventKind::Stderr {
            text: "warn".into(),
        }));
        assert_eq!(session.log[3].text.as_deref(), Some("warn"), "stderr");
        session.receive_event(&event(McpEventKind::Closed));
        assert_eq!(session.status, McpStatus::Disconnected, "closed");
        assert_eq!(
            session.error.as_deref(),
            Some("The server closed the connection."),
            "closed error"
        );
        for _ in 0..MAX_LOG_ENTRIES + 5 {
            session.receive_event(&event(McpEventKind::Stderr { text: "x".into() }));
        }
        assert_eq!(session.log.len(), MAX_LOG_ENTRIES, "capped");
    }

    #[test]
    fn connect_keeps_forms_and_loads_offered_lists() {
        let mut session = McpSession::default();
        session.set_form("tool:a", HashMap::from([("q".into(), "1".into())]));
        session.selected_tool = Some("a".into());
        session.error = Some("old".into());
        session.begin_connect();
        assert_eq!(session.status, McpStatus::Connecting, "connecting");
        assert!(session.forms.contains_key("tool:a"), "forms kept");
        assert_eq!(session.error, None, "error reset");
        let info = McpServerInfo {
            name: "s".into(),
            title: None,
            version: "1".into(),
            protocol_version: None,
            instructions: None,
            capabilities: McpCapabilities {
                tools: true,
                prompts: true,
                ..McpCapabilities::default()
            },
        };
        assert!(
            session.finish_connect(McpConnectResponse {
                error: None,
                info: Some(info),
                duration_ms: 1.0
            }),
            "connected"
        );
        assert_eq!(
            session.lists_to_load(&McpListKind::ALL),
            vec![McpListKind::Tools, McpListKind::Prompts],
            "offered"
        );
        session.apply_list(
            McpListKind::Tools,
            &McpResponse {
                error: None,
                result: json!({"tools":[{"name":"a","inputSchema":{"type":"object"}},{"bad":1}]}),
                duration_ms: 1.0,
            },
        );
        assert_eq!(
            session.tools.as_ref().map(Vec::len),
            Some(1),
            "parsed tools"
        );
        session.apply_resources(
            &McpResponse::failed("nope", 0.0),
            &McpResponse::failed("no templates", 0.0),
        );
        assert_eq!(
            session
                .list_errors
                .get(&McpListKind::Resources)
                .map(String::as_str),
            Some("nope"),
            "list error"
        );
        assert_eq!(session.templates, Some(Vec::new()), "templates optional");
    }

    #[test]
    fn agent_calls_pick_server_and_fill_form() {
        let mut project = McpProjectServers::default();
        project.add(draft("a", "App"));
        assert_eq!(
            agent_call_server(Some(&project), Some("other")).err(),
            Some(
                "No saved MCP server named \"other\". Servers: App. Add one with mcp_connect."
                    .into()
            ),
            "unknown server"
        );
        let server = agent_call_server(Some(&project), Some("app")).expect("server");
        let mut session = McpSession {
            tools: Some(vec![McpTool {
                name: "echo".into(),
                input_schema: json!({"properties":{"message":{"type":"string"}}}),
                ..McpTool::default()
            }]),
            ..McpSession::default()
        };
        let args = json!({"message": "hi"}).as_object().cloned().expect("args");
        assert_eq!(
            prepare_agent_tool_call(server, &mut session, "nope", &args).err(),
            Some("App has no tool \"nope\". Tools: echo.".into()),
            "unknown tool"
        );
        let (key, params) =
            prepare_agent_tool_call(server, &mut session, "echo", &args).expect("call");
        assert_eq!(key, "tool:echo", "key");
        assert_eq!(
            params,
            json!({"name":"echo","arguments":{"message":"hi"}}),
            "params"
        );
        assert_eq!(session.forms[&key]["message"], "hi", "form");
        assert_eq!(session.detail_tab, McpDetailTab::Playground, "playground");
        let summary = agent_connect_result(server, &session);
        assert_eq!(summary.tools[0].name, "echo", "summary");
        assert_eq!(summary.server, "App", "label");
    }
}
