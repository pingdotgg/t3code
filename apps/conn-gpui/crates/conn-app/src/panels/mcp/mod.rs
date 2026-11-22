//! The MCP surface (Conn `apps/web/src/mcp/McpPanel.tsx`, `McpCatalogViews.tsx`):
//! connect to stdio, Streamable HTTP, or legacy SSE MCP servers natively via
//! `conn_desktop::mcp::McpSessions`, browse and call tools, read resources/templates,
//! get prompts, inspect JSON-RPC traffic, and edit per-project saved servers.

mod catalog;
mod helpers;
mod log;
mod server;
mod widgets;

use crate::a11y::ConnA11yExt as _;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use conn_desktop::mcp::servers::{
    McpServerDraft, McpTransport, mcp_server_label, new_mcp_server, to_desktop_mcp_server,
};
use conn_desktop::mcp::store::{
    McpListKind, McpServerStore, McpSession, McpStatus, mcp_session_key,
};
use conn_desktop::mcp::{
    McpConnectRequest, McpConnectResponse, McpEvent, McpMethod, McpRequest, McpResponse,
    McpSessions,
};
use conn_theme::Tokens;
use futures::{SinkExt as _, StreamExt as _};
use gpui_kit::component::input::{Input, InputEvent, InputState, TextareaState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, Context, Entity, IntoElement, KeyDownEvent, MouseButton, ParentElement, Render,
    RenderImage, ScrollHandle, SharedString, Styled, Subscription, Task, Window, div, px,
};
use serde_json::{Value, json};

use self::catalog::filter_placeholder;
use self::helpers::{
    PanelTab, duplicate_server, load_project_mcp_json, resolve_active_tab, transport_description,
    visible_tabs,
};
use self::widgets::{McpMenuEntry, McpMenuRow, dropdown_menu};
use super::chrome::{
    self, CONTROL_HEIGHT_PX, ConnTooltipExt as _, ICON_BUTTON_GLYPH_PX, ROW_PAD_START_PX,
    SectionTab, UI_LINE_HEIGHT_PX, UI_TEXT_PX, XS_LINE_HEIGHT_PX, XS_TEXT_PX,
};
use super::color::to_hsla;
use super::header::superhero_icon;
use crate::theme::MONO_FONT;

const COMMAND_PLACEHOLDER: &str = "npx -y @modelcontextprotocol/server-everything";
const URL_PLACEHOLDER: &str = "https://app.test/mcp";

/// Which popup menu is currently open inside the MCP panel.
#[derive(Clone, Debug, PartialEq, Eq)]
enum OpenMenu {
    Servers,
    Transport,
    EnumField {
        call_key: String,
        field_name: String,
    },
}

/// Active tab inside a `ResultView` (`Result` vs `JSON`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum ResultTab {
    #[default]
    Content,
    Json,
}

/// Per-call result view UI state.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct ResultViewState {
    pub(super) tab: ResultTab,
    pub(super) raw: bool,
}

/// Key for a cached Playground form field input entity.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct FieldInputKey {
    pub(super) session_key: String,
    pub(super) call_key: String,
    pub(super) field_name: String,
}

/// The MCP panel entity.
pub(crate) struct McpPanel {
    tokens: Tokens,
    project_key: Option<String>,
    workspace_root: Option<String>,
    store: McpServerStore,
    /// Servers parsed from the project's `.mcp.json`.
    project_mcp_json: Vec<McpServerDraft>,
    /// Live native MCP session manager; all sessions disconnect on drop.
    mcp: McpSessions,
    /// Per-session panel state, keyed by [`mcp_session_key`].
    sessions: HashMap<String, McpSession>,
    tab: PanelTab,
    menu: Option<OpenMenu>,

    // Toolbar & Server tab inputs.
    command_input: Entity<InputState>,
    url_input: Entity<InputState>,
    name_input: Entity<InputState>,
    cwd_input: Entity<InputState>,
    /// The server id whose values the toolbar/Server inputs currently hold.
    synced_server: Option<String>,
    /// Suppresses recursive `InputEvent::Change` callbacks while programmatically setting values.
    syncing_inputs: bool,

    // Server tab env/header key-value row inputs, keyed by `McpRow::id`.
    row_inputs: HashMap<String, (Entity<InputState>, Entity<InputState>)>,
    row_subscriptions: HashMap<String, Vec<Subscription>>,

    // Catalog filter inputs (one per catalog tab so filter text survives tab switches).
    tools_filter_input: Entity<InputState>,
    resources_filter_input: Entity<InputState>,
    prompts_filter_input: Entity<InputState>,

    // Per-session selection for Resources and Prompts (Tools uses `McpSession::selected_tool`).
    selected_resource: HashMap<String, String>,
    selected_prompt: HashMap<String, String>,

    // Playground form inputs & result pane state.
    field_text_inputs: HashMap<FieldInputKey, Entity<InputState>>,
    field_json_inputs: HashMap<FieldInputKey, Entity<TextareaState>>,
    field_subscriptions: HashMap<FieldInputKey, Subscription>,
    result_views: HashMap<(String, String), ResultViewState>,
    /// `(call_key, nonce)` while showing the brief "Copied" checkmark.
    copied_result: Option<(String, u64)>,
    copied_nonce: u64,
    /// Decoded base64 result images cached by content hash.
    image_cache: HashMap<u64, Option<Arc<RenderImage>>>,

    // Log tab state.
    expanded_log_ids: HashSet<u64>,
    log_scroll: ScrollHandle,

    _subscriptions: Vec<Subscription>,
    _event_task: Task<()>,
}

impl std::fmt::Debug for McpPanel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpPanel")
            .field("project_key", &self.project_key)
            .field("workspace_root", &self.workspace_root)
            .field("tab", &self.tab)
            .field("synced_server", &self.synced_server)
            .finish_non_exhaustive()
    }
}

impl Drop for McpPanel {
    fn drop(&mut self) {
        let mcp = self.mcp.clone();
        crate::live::RT.spawn(async move {
            mcp.disconnect_all().await;
        });
    }
}

fn store_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Application Support/conn-gpui/mcp.json"))
}

fn load_store() -> McpServerStore {
    store_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str::<McpServerStore>(&json).ok())
        .unwrap_or_default()
}

impl McpPanel {
    pub(crate) fn new(tokens: Tokens, window: &mut Window, cx: &mut Context<'_, Self>) -> Self {
        let (mcp, mut tokio_rx) = McpSessions::new();
        let (mut bridge_tx, mut bridge_rx) = futures::channel::mpsc::channel::<McpEvent>(256);

        // Drain the bounded Tokio event channel on the Tokio runtime and forward into GPUI.
        crate::live::RT.spawn(async move {
            while let Some(event) = tokio_rx.recv().await {
                if bridge_tx.send(event).await.is_err() {
                    break;
                }
            }
        });

        let event_task = cx.spawn(async move |this, cx| {
            while let Some(event) = bridge_rx.next().await {
                let updated = this.update(cx, |panel, cx| {
                    panel.handle_event(&event, cx);
                });
                if updated.is_err() {
                    break;
                }
            }
        });

        let command_input =
            cx.new(|cx| InputState::new(window, cx).placeholder(COMMAND_PLACEHOLDER));
        let url_input = cx.new(|cx| InputState::new(window, cx).placeholder(URL_PLACEHOLDER));
        let name_input = cx.new(|cx| InputState::new(window, cx).placeholder("New server"));
        let cwd_input = cx.new(|cx| InputState::new(window, cx));
        let tools_filter_input =
            cx.new(|cx| InputState::new(window, cx).placeholder(filter_placeholder("tools")));
        let resources_filter_input =
            cx.new(|cx| InputState::new(window, cx).placeholder(filter_placeholder("resources")));
        let prompts_filter_input =
            cx.new(|cx| InputState::new(window, cx).placeholder(filter_placeholder("prompts")));

        let cmd_sub = cx.subscribe(
            &command_input,
            |this, input, event: &InputEvent, cx| match event {
                InputEvent::Change if !this.syncing_inputs => {
                    let cmd = input.read(cx).value().to_string();
                    this.edit_selected_server(cx, |s| s.command_line = cmd);
                }
                InputEvent::PressEnter { .. } => this.toggle_connection(cx),
                _ => {}
            },
        );
        let url_sub = cx.subscribe(
            &url_input,
            |this, input, event: &InputEvent, cx| match event {
                InputEvent::Change if !this.syncing_inputs => {
                    let url = input.read(cx).value().to_string();
                    this.edit_selected_server(cx, |s| s.url = url);
                }
                InputEvent::PressEnter { .. } => this.toggle_connection(cx),
                _ => {}
            },
        );
        let name_sub = cx.subscribe(&name_input, |this, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) && !this.syncing_inputs {
                let name = input.read(cx).value().to_string();
                this.edit_selected_server(cx, |s| s.name = name);
            }
        });
        let cwd_sub = cx.subscribe(&cwd_input, |this, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) && !this.syncing_inputs {
                let cwd = input.read(cx).value().to_string();
                this.edit_selected_server(cx, |s| s.cwd = cwd);
            }
        });
        let tf_sub = cx.subscribe(&tools_filter_input, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        });
        let rf_sub = cx.subscribe(&resources_filter_input, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        });
        let pf_sub = cx.subscribe(&prompts_filter_input, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        });

        Self {
            tokens,
            project_key: None,
            workspace_root: None,
            store: load_store(),
            project_mcp_json: Vec::new(),
            mcp,
            sessions: HashMap::new(),
            tab: PanelTab::Tools,
            menu: None,
            command_input,
            url_input,
            name_input,
            cwd_input,
            synced_server: None,
            syncing_inputs: false,
            row_inputs: HashMap::new(),
            row_subscriptions: HashMap::new(),
            tools_filter_input,
            resources_filter_input,
            prompts_filter_input,
            selected_resource: HashMap::new(),
            selected_prompt: HashMap::new(),
            field_text_inputs: HashMap::new(),
            field_json_inputs: HashMap::new(),
            field_subscriptions: HashMap::new(),
            result_views: HashMap::new(),
            copied_result: None,
            copied_nonce: 0,
            image_cache: HashMap::new(),
            expanded_log_ids: HashSet::new(),
            log_scroll: ScrollHandle::new(),
            _subscriptions: vec![cmd_sub, url_sub, name_sub, cwd_sub, tf_sub, rf_sub, pf_sub],
            _event_task: event_task,
        }
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    /// The selected thread's project (Conn keys panel state by project) and its folder.
    pub(crate) fn set_project(
        &mut self,
        project_key: Option<String>,
        workspace_root: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.project_key == project_key && self.workspace_root == workspace_root {
            return;
        }
        self.project_key = project_key;
        self.workspace_root = workspace_root;
        self.project_mcp_json = load_project_mcp_json(self.workspace_root.as_deref());
        if let Some(key) = self.project_key.clone() {
            self.ensure_project_server(&key);
        }
        self.synced_server = None;
        self.menu = None;
        cx.notify();
    }

    fn ensure_project_server(&mut self, project_key: &str) {
        let project = self.store.project_mut(project_key);
        if project.servers.is_empty() {
            project.add(new_mcp_server(None));
            self.persist();
        } else if project.selected().is_none()
            && let Some(first_id) = project.servers.first().map(|s| s.id.clone())
        {
            project.select(&first_id);
        }
    }

    fn persist(&self) {
        let (Some(path), Ok(json)) = (store_path(), serde_json::to_string_pretty(&self.store))
        else {
            return;
        };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Err(error) = std::fs::write(&path, json) {
            eprintln!("mcp panel: could not save servers: {error}");
        }
    }

    fn selected_server(&self) -> Option<&McpServerDraft> {
        let key = self.project_key.as_deref()?;
        let project = self.store.project(key)?;
        project.selected().or_else(|| project.servers.first())
    }

    fn current_session_key(&self) -> Option<String> {
        let project_key = self.project_key.as_deref()?;
        let server = self.selected_server()?;
        Some(mcp_session_key(project_key, &server.id))
    }

    pub(super) fn edit_selected_server(
        &mut self,
        cx: &mut Context<'_, Self>,
        edit: impl FnOnce(&mut McpServerDraft),
    ) {
        let (Some(project_key), Some(server_id)) = (
            self.project_key.clone(),
            self.selected_server().map(|s| s.id.clone()),
        ) else {
            return;
        };
        self.store
            .project_mut(&project_key)
            .change(&server_id, edit);
        self.persist();
        cx.notify();
    }

    pub(super) fn set_form_value(
        &mut self,
        session_key: &str,
        call_key: &str,
        field_name: String,
        value: String,
        cx: &mut Context<'_, Self>,
    ) {
        let session = self.sessions.entry(session_key.to_owned()).or_default();
        let mut values = session.forms.get(call_key).cloned().unwrap_or_default();
        values.insert(field_name, value);
        session.set_form(call_key, values);
        cx.notify();
    }

    pub(super) fn flash_copied(&mut self, call_key: String, cx: &mut Context<'_, Self>) {
        self.copied_nonce = self.copied_nonce.wrapping_add(1);
        let nonce = self.copied_nonce;
        self.copied_result = Some((call_key, nonce));
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(1_200))
                .await;
            let _ = this.update(cx, |panel, cx| {
                if panel
                    .copied_result
                    .as_ref()
                    .is_some_and(|(_, n)| *n == nonce)
                {
                    panel.copied_result = None;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn sync_inputs(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let Some(server) = self.selected_server().cloned() else {
            return;
        };
        let placeholder_name = mcp_server_label(&McpServerDraft {
            name: String::new(),
            ..server.clone()
        });
        let cwd_placeholder = self.workspace_root.clone().unwrap_or_default();

        if self.synced_server.as_deref() == Some(server.id.as_str()) {
            self.name_input
                .update(cx, |s, cx| s.set_placeholder(placeholder_name, window, cx));
            self.cwd_input
                .update(cx, |s, cx| s.set_placeholder(cwd_placeholder, window, cx));
            return;
        }

        self.synced_server = Some(server.id.clone());
        self.syncing_inputs = true;
        self.command_input.update(cx, |s, cx| {
            s.set_value(server.command_line.clone(), window, cx)
        });
        self.url_input
            .update(cx, |s, cx| s.set_value(server.url.clone(), window, cx));
        self.name_input.update(cx, |s, cx| {
            s.set_placeholder(placeholder_name, window, cx);
            s.set_value(server.name.clone(), window, cx);
        });
        self.cwd_input.update(cx, |s, cx| {
            s.set_placeholder(cwd_placeholder, window, cx);
            s.set_value(server.cwd.clone(), window, cx);
        });
        self.row_inputs.clear();
        self.row_subscriptions.clear();
        self.syncing_inputs = false;
    }

    fn handle_event(&mut self, event: &McpEvent, cx: &mut Context<'_, Self>) {
        let Some(session) = self.sessions.get_mut(&event.session_id) else {
            return;
        };
        let max_y = f32::from(self.log_scroll.max_offset().y);
        let current_y = -f32::from(self.log_scroll.offset().y);
        let at_bottom = max_y <= 0.0 || (max_y - current_y) < 24.0;
        let changed = session.receive_event(event);
        if at_bottom {
            self.log_scroll.scroll_to_bottom();
        }
        if let Some(kind) = changed {
            self.load_lists(event.session_id.clone(), vec![kind], cx);
        }
        cx.notify();
    }

    fn toggle_connection(&mut self, cx: &mut Context<'_, Self>) {
        let (Some(server), Some(session_key)) =
            (self.selected_server().cloned(), self.current_session_key())
        else {
            return;
        };
        let status = self
            .sessions
            .get(&session_key)
            .map(|s| s.status)
            .unwrap_or_default();
        if status == McpStatus::Connected || status == McpStatus::Connecting {
            self.disconnect_session(session_key, cx);
            return;
        }
        let desktop_server = match to_desktop_mcp_server(&server, self.workspace_root.as_deref()) {
            Ok(server) => server,
            Err(error) => {
                self.sessions.entry(session_key).or_default().error = Some(error);
                cx.notify();
                return;
            }
        };
        let session = self.sessions.entry(session_key.clone()).or_default();
        session.begin_connect();
        cx.notify();

        let mcp = self.mcp.clone();
        let sk_req = session_key.clone();
        let task = crate::live::RT.spawn(async move {
            mcp.connect(McpConnectRequest {
                session_id: sk_req,
                server: desktop_server,
            })
            .await
        });
        cx.spawn(async move |this, cx| {
            let response = match task.await {
                Ok(res) => res,
                Err(error) => McpConnectResponse {
                    error: Some(error.to_string()),
                    info: None,
                    duration_ms: 0.0,
                },
            };
            let _ = this.update(cx, |panel, cx| {
                let connected = panel
                    .sessions
                    .entry(session_key.clone())
                    .or_default()
                    .finish_connect(response);
                if connected {
                    panel.load_lists(session_key, McpListKind::ALL.to_vec(), cx);
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn disconnect_session(&mut self, session_key: String, cx: &mut Context<'_, Self>) {
        if let Some(session) = self.sessions.get_mut(&session_key) {
            session.disconnect();
        }
        cx.notify();
        let mcp = self.mcp.clone();
        crate::live::RT.spawn(async move {
            mcp.disconnect(&session_key).await;
        });
    }

    fn load_lists(
        &mut self,
        session_key: String,
        kinds: Vec<McpListKind>,
        cx: &mut Context<'_, Self>,
    ) {
        let to_load = self
            .sessions
            .get(&session_key)
            .map(|s| s.lists_to_load(&kinds))
            .unwrap_or_default();
        for kind in to_load {
            let mcp = self.mcp.clone();
            let sk = session_key.clone();
            if kind == McpListKind::Resources {
                let task = crate::live::RT.spawn(async move {
                    let (resources, templates) = tokio::join!(
                        mcp.request(McpRequest {
                            session_id: sk.clone(),
                            method: McpMethod::ResourcesList,
                            params: json!({}),
                        }),
                        mcp.request(McpRequest {
                            session_id: sk,
                            method: McpMethod::ResourceTemplatesList,
                            params: json!({}),
                        }),
                    );
                    (resources, templates)
                });
                let sk_done = session_key.clone();
                cx.spawn(async move |this, cx| {
                    let (resources, templates) = match task.await {
                        Ok(pair) => pair,
                        Err(error) => (
                            McpResponse::failed(error.to_string(), 0.0),
                            McpResponse::failed(error.to_string(), 0.0),
                        ),
                    };
                    let _ = this.update(cx, |panel, cx| {
                        panel
                            .sessions
                            .entry(sk_done)
                            .or_default()
                            .apply_resources(&resources, &templates);
                        cx.notify();
                    });
                })
                .detach();
            } else {
                let method = if kind == McpListKind::Tools {
                    McpMethod::ToolsList
                } else {
                    McpMethod::PromptsList
                };
                let task = crate::live::RT.spawn(async move {
                    mcp.request(McpRequest {
                        session_id: sk,
                        method,
                        params: json!({}),
                    })
                    .await
                });
                let sk_done = session_key.clone();
                cx.spawn(async move |this, cx| {
                    let response = match task.await {
                        Ok(res) => res,
                        Err(error) => McpResponse::failed(error.to_string(), 0.0),
                    };
                    let _ = this.update(cx, |panel, cx| {
                        panel
                            .sessions
                            .entry(sk_done)
                            .or_default()
                            .apply_list(kind, &response);
                        cx.notify();
                    });
                })
                .detach();
            }
        }
    }

    /// Adds/updates an MCP server requested by an agent, connects to it in the MCP panel, loads
    /// its tools/resources/prompts, and returns [`conn_contract::AgentPanelMcpResult`].
    pub(crate) fn run_agent_connect(
        &mut self,
        spec: conn_contract::AgentPanelMcpServer,
        cx: &mut Context<'_, Self>,
    ) -> tokio::sync::oneshot::Receiver<Result<conn_contract::AgentPanelMcpResult, String>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let project_key = self
            .project_key
            .clone()
            .unwrap_or_else(|| "default".to_owned());
        let agent_spec = conn_desktop::mcp::servers::AgentMcpServer {
            name: spec.name,
            url: spec.url,
            transport: spec.transport.map(|t| match t {
                conn_contract::AgentPanelMcpServerTransport::Http => {
                    conn_desktop::mcp::servers::McpTransport::Http
                }
                conn_contract::AgentPanelMcpServerTransport::Sse => {
                    conn_desktop::mcp::servers::McpTransport::Sse
                }
            }),
            command: spec.command,
            headers: spec
                .headers
                .map(|m| conn_desktop::mcp::servers::McpPairs(m.into_iter().collect())),
            env: spec
                .env
                .map(|m| conn_desktop::mcp::servers::McpPairs(m.into_iter().collect())),
        };

        let existing = self
            .store
            .project(&project_key)
            .map(|p| p.servers.as_slice())
            .unwrap_or(&[]);
        let (draft, _is_new) =
            conn_desktop::mcp::servers::agent_server_draft(existing, &agent_spec);
        let project = self.store.project_mut(&project_key);
        project.add(draft.clone());
        project.select(&draft.id);
        self.persist();
        self.synced_server = None;
        self.tab = PanelTab::Tools;

        let session_key = mcp_session_key(&project_key, &draft.id);
        let desktop_server = match to_desktop_mcp_server(&draft, self.workspace_root.as_deref()) {
            Ok(server) => server,
            Err(error) => {
                self.sessions.entry(session_key).or_default().error = Some(error.clone());
                cx.notify();
                let _ = tx.send(Err(error));
                return rx;
            }
        };

        self.sessions
            .entry(session_key.clone())
            .or_default()
            .begin_connect();
        cx.notify();

        let mcp = self.mcp.clone();
        let sk_req = session_key.clone();
        let task = crate::live::RT.spawn(async move {
            let connect_res = mcp
                .connect(McpConnectRequest {
                    session_id: sk_req.clone(),
                    server: desktop_server,
                })
                .await;
            if connect_res.error.is_some() {
                return (connect_res, None, None, None, None);
            }
            let (tools, resources, templates, prompts) = tokio::join!(
                mcp.request(McpRequest {
                    session_id: sk_req.clone(),
                    method: McpMethod::ToolsList,
                    params: json!({}),
                }),
                mcp.request(McpRequest {
                    session_id: sk_req.clone(),
                    method: McpMethod::ResourcesList,
                    params: json!({}),
                }),
                mcp.request(McpRequest {
                    session_id: sk_req.clone(),
                    method: McpMethod::ResourceTemplatesList,
                    params: json!({}),
                }),
                mcp.request(McpRequest {
                    session_id: sk_req,
                    method: McpMethod::PromptsList,
                    params: json!({}),
                }),
            );
            (
                connect_res,
                Some(tools),
                Some(resources),
                Some(templates),
                Some(prompts),
            )
        });

        cx.spawn(async move |this, cx| {
            let outcome = task.await;
            let reply = match outcome {
                Err(join_err) => Err(join_err.to_string()),
                Ok((connect_res, tools, resources, templates, prompts)) => {
                    let connect_err = connect_res.error.clone();
                    let mut result = Err("MCP panel closed.".to_owned());
                    let _ = this.update(cx, |panel, cx| {
                        let session = panel.sessions.entry(session_key.clone()).or_default();
                        let ok = session.finish_connect(connect_res);
                        if ok {
                            if let Some(t) = tools {
                                session.apply_list(McpListKind::Tools, &t);
                            }
                            if let Some(r) = resources {
                                let tmpl = templates
                                    .unwrap_or_else(|| McpResponse::failed(String::new(), 0.0));
                                session.apply_resources(&r, &tmpl);
                            }
                            if let Some(p) = prompts {
                                session.apply_list(McpListKind::Prompts, &p);
                            }
                            let summary =
                                conn_desktop::mcp::store::agent_connect_result(&draft, session);
                            result = Ok(conn_contract::AgentPanelMcpResult {
                                server: summary.server,
                                server_info: summary.server_info,
                                tools: summary
                                    .tools
                                    .into_iter()
                                    .map(|t| conn_contract::AgentPanelMcpResultToolsItem {
                                        name: t.name,
                                        description: t.description,
                                    })
                                    .collect(),
                                resource_count: summary
                                    .resource_count
                                    .map(|n| conn_contract::support::JsNumber(n as f64)),
                                prompt_count: summary
                                    .prompt_count
                                    .map(|n| conn_contract::support::JsNumber(n as f64)),
                            });
                        } else {
                            result = Err(connect_err
                                .unwrap_or_else(|| "Could not connect to MCP server.".to_owned()));
                        }
                        cx.notify();
                    });
                    result
                }
            };
            let _ = tx.send(reply);
        })
        .detach();
        rx
    }

    /// Calls a tool on a saved MCP server for an agent, populating the Playground form and live
    /// result view in the MCP panel, and returns [`conn_contract::AgentPanelMcpCallResult`].
    pub(crate) fn run_agent_call(
        &mut self,
        call: conn_contract::AgentPanelMcpCall,
        cx: &mut Context<'_, Self>,
    ) -> tokio::sync::oneshot::Receiver<Result<conn_contract::AgentPanelMcpCallResult, String>>
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let project_key = self
            .project_key
            .clone()
            .unwrap_or_else(|| "default".to_owned());
        let draft = match conn_desktop::mcp::store::agent_call_server(
            self.store.project(&project_key),
            call.server.as_deref(),
        ) {
            Ok(server) => server.clone(),
            Err(error) => {
                let _ = tx.send(Err(error));
                return rx;
            }
        };

        self.store.project_mut(&project_key).select(&draft.id);
        self.persist();
        self.synced_server = None;
        self.tab = PanelTab::Tools;

        let session_key = mcp_session_key(&project_key, &draft.id);
        let needs_connect = self
            .sessions
            .get(&session_key)
            .is_none_or(|s| s.status != McpStatus::Connected || s.tools.is_none());

        let desktop_server = if needs_connect {
            match to_desktop_mcp_server(&draft, self.workspace_root.as_deref()) {
                Ok(server) => Some(server),
                Err(error) => {
                    let _ = tx.send(Err(error));
                    return rx;
                }
            }
        } else {
            None
        };

        let mcp = self.mcp.clone();
        let sk = session_key;
        let tool_name = call.tool;
        let arguments = call.arguments;
        cx.notify();

        cx.spawn(async move |this, cx| {
            // Connect & list tools first if disconnected.
            if let Some(server) = desktop_server {
                let _ = this.update(cx, |panel, cx| {
                    panel
                        .sessions
                        .entry(sk.clone())
                        .or_default()
                        .begin_connect();
                    cx.notify();
                });
                let mcp_c = mcp.clone();
                let sk_c = sk.clone();
                let conn_out = crate::live::RT
                    .spawn(async move {
                        let res = mcp_c
                            .connect(McpConnectRequest {
                                session_id: sk_c.clone(),
                                server,
                            })
                            .await;
                        if res.error.is_some() {
                            return (res, None);
                        }
                        let tools = mcp_c
                            .request(McpRequest {
                                session_id: sk_c,
                                method: McpMethod::ToolsList,
                                params: json!({}),
                            })
                            .await;
                        (res, Some(tools))
                    })
                    .await;
                let connected = match conn_out {
                    Ok((res, tools)) => {
                        let err = res.error.clone();
                        let mut ok_flag = false;
                        let _ = this.update(cx, |panel, cx| {
                            let session = panel.sessions.entry(sk.clone()).or_default();
                            ok_flag = session.finish_connect(res);
                            if ok_flag && let Some(t) = tools {
                                session.apply_list(McpListKind::Tools, &t);
                            }
                            cx.notify();
                        });
                        if ok_flag {
                            Ok(())
                        } else {
                            Err(err.unwrap_or_else(|| "MCP connect failed.".to_owned()))
                        }
                    }
                    Err(join_err) => Err(join_err.to_string()),
                };
                if let Err(err) = connected {
                    let _ = tx.send(Err(err));
                    return;
                }
            }

            // Prepare the Playground form + validate tool name.
            let args_map: serde_json::Map<String, Value> = arguments.into_iter().collect();
            let prepared = this.update(cx, |panel, cx| {
                let session = panel.sessions.entry(sk.clone()).or_default();
                let prep = conn_desktop::mcp::store::prepare_agent_tool_call(
                    &draft, session, &tool_name, &args_map,
                );
                if let Ok((ref call_key, _)) = prep {
                    session.start_call(call_key);
                }
                cx.notify();
                prep
            });
            let (call_key, params) = match prepared {
                Ok(Ok(pair)) => pair,
                Ok(Err(err)) => {
                    let _ = tx.send(Err(err));
                    return;
                }
                Err(_) => {
                    let _ = tx.send(Err("MCP panel closed.".to_owned()));
                    return;
                }
            };

            let sk_call = sk.clone();
            let call_task = crate::live::RT.spawn(async move {
                mcp.request(McpRequest {
                    session_id: sk_call,
                    method: McpMethod::ToolsCall,
                    params,
                })
                .await
            });
            let response = match call_task.await {
                Ok(res) => res,
                Err(join_err) => McpResponse::failed(join_err.to_string(), 0.0),
            };
            let duration_ms = response.duration_ms;
            let outcome =
                conn_desktop::mcp::store::agent_tool_call_outcome(&draft, &tool_name, &response)
                    .map(|res| conn_contract::AgentPanelMcpCallResult {
                        server: res.server,
                        tool: res.tool,
                        is_error: res.is_error,
                        content: res.content,
                        structured_content: res.structured_content.map(Some),
                        truncated: res.truncated,
                        duration_ms: conn_contract::support::JsNumber(duration_ms),
                    });
            let _ = this.update(cx, |panel, cx| {
                panel
                    .sessions
                    .entry(sk)
                    .or_default()
                    .finish_call(&call_key, response);
                cx.notify();
            });
            let _ = tx.send(outcome);
        })
        .detach();
        rx
    }

    pub(super) fn run_call(
        &mut self,
        session_key: String,
        call_key: String,
        method: McpMethod,
        params: Value,
        cx: &mut Context<'_, Self>,
    ) {
        self.sessions
            .entry(session_key.clone())
            .or_default()
            .start_call(&call_key);
        cx.notify();

        let mcp = self.mcp.clone();
        let sk_req = session_key.clone();
        let task = crate::live::RT.spawn(async move {
            mcp.request(McpRequest {
                session_id: sk_req,
                method,
                params,
            })
            .await
        });
        cx.spawn(async move |this, cx| {
            let response = match task.await {
                Ok(res) => res,
                Err(error) => McpResponse::failed(error.to_string(), 0.0),
            };
            let _ = this.update(cx, |panel, cx| {
                panel
                    .sessions
                    .entry(session_key)
                    .or_default()
                    .finish_call(&call_key, response);
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn fail_call(
        &mut self,
        session_key: &str,
        call_key: &str,
        error: String,
        cx: &mut Context<'_, Self>,
    ) {
        self.sessions
            .entry(session_key.to_owned())
            .or_default()
            .fail_call(call_key, error);
        cx.notify();
    }

    fn toggle_menu(&mut self, menu: OpenMenu, cx: &mut Context<'_, Self>) {
        if self.menu.as_ref() == Some(&menu) {
            self.menu = None;
        } else {
            if menu == OpenMenu::Servers {
                self.project_mcp_json = load_project_mcp_json(self.workspace_root.as_deref());
            }
            self.menu = Some(menu);
        }
        cx.notify();
    }

    fn render_toolbar(
        &self,
        server: &McpServerDraft,
        session: &McpSession,
        session_key: &str,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = &self.tokens;
        let mono: SharedString = MONO_FONT.into();
        let entity = cx.entity();
        let connected = session.status == McpStatus::Connected;
        let connecting = session.status == McpStatus::Connecting;

        // Saved servers menu button.
        let mut servers_anchor = div().relative().child(
            chrome::toolbar_group(tokens).child(
                chrome::icon_button("mcp-servers-btn", "superhero/list.svg", tokens, false, {
                    let entity = entity.clone();
                    move |_, _, cx| {
                        cx.stop_propagation();
                        entity.update(cx, |p, cx| p.toggle_menu(OpenMenu::Servers, cx));
                    }
                })
                .conn_tooltip("Servers", tokens),
            ),
        );
        if self.menu == Some(OpenMenu::Servers) {
            servers_anchor = servers_anchor.child(self.render_servers_menu(server, cx));
        }

        // Transport menu trigger inside the soft command/URL field.
        let transport_trigger = h_flex()
            .id("mcp-transport-btn")
            .a11y_button("panel.mcp-transport-btn", "Transport")
            .h(px(24.0))
            .px(px(7.0))
            .gap(px(4.0))
            .items_center()
            .rounded(px(9999.0))
            .cursor_pointer()
            .text_size(px(XS_TEXT_PX))
            .line_height(px(XS_LINE_HEIGHT_PX))
            .text_color(to_hsla(tokens.foreground))
            .hover({
                let hover = to_hsla(tokens.shell_highlight);
                move |s| s.bg(hover)
            })
            .on_click({
                let entity = entity.clone();
                move |_, _, cx| {
                    cx.stop_propagation();
                    entity.update(cx, |p, cx| p.toggle_menu(OpenMenu::Transport, cx));
                }
            })
            .child(div().font_family(mono).child(server.transport.label()))
            .child(superhero_icon(
                "superhero/chevron-down.svg",
                ICON_BUTTON_GLYPH_PX,
                to_hsla(tokens.muted_foreground),
            ));

        let mut transport_anchor = div().relative().pl(px(9.0)).child(transport_trigger);
        if self.menu == Some(OpenMenu::Transport) {
            transport_anchor = transport_anchor.child(self.render_transport_menu(server, cx));
        }

        let active_input = if server.transport == McpTransport::Stdio {
            &self.command_input
        } else {
            &self.url_input
        };
        let target_field = chrome::soft_input_group(tokens)
            .child(transport_anchor)
            .child(
                div().flex_1().min_w_0().pl(px(11.0)).pr(px(14.0)).child(
                    Input::new(active_input)
                        .appearance(false)
                        .text_size(px(UI_TEXT_PX)),
                ),
            );

        // Connection controls: optional reload lists button + connect/disconnect button.
        let mut conn_group = chrome::toolbar_group(tokens);
        if connected {
            let sk = session_key.to_owned();
            let entity_reload = entity.clone();
            conn_group = conn_group.child(
                chrome::icon_button(
                    "mcp-reload-btn",
                    "superhero/refresh.svg",
                    tokens,
                    false,
                    move |_, _, cx| {
                        let sk = sk.clone();
                        entity_reload.update(cx, |p, cx| {
                            p.load_lists(sk, McpListKind::ALL.to_vec(), cx);
                        });
                    },
                )
                .conn_tooltip("Reload tools, resources and prompts", tokens),
            );
        }
        let connect_icon = if connecting {
            "superhero/spinner.svg"
        } else if connected {
            "superhero/unplug.svg"
        } else {
            "superhero/plug.svg"
        };
        let connect_tooltip = if connected {
            "Disconnect"
        } else if connecting {
            "Cancel"
        } else {
            "Connect (⌘↵)"
        };
        conn_group = conn_group.child(
            chrome::icon_button(
                "mcp-connect-btn",
                connect_icon,
                tokens,
                false,
                move |_, _, cx| entity.update(cx, |p, cx| p.toggle_connection(cx)),
            )
            .conn_tooltip(connect_tooltip, tokens),
        );

        chrome::toolbar_row(tokens)
            .child(servers_anchor)
            .child(target_field)
            .child(conn_group)
            .into_any_element()
    }

    fn render_servers_menu(
        &self,
        selected: &McpServerDraft,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let Some(project_key) = self.project_key.as_deref() else {
            return div().into_any_element();
        };
        let Some(project) = self.store.project(project_key) else {
            return div().into_any_element();
        };
        let entity = cx.entity();
        let saved_ids: HashSet<&str> = project.servers.iter().map(|s| s.id.as_str()).collect();

        let mut entries: Vec<McpMenuEntry> = project
            .servers
            .iter()
            .map(|server| {
                let id = server.id.clone();
                let entity = entity.clone();
                McpMenuEntry::Row(McpMenuRow {
                    id: SharedString::from(format!("mcp-server-item-{id}")),
                    label: mcp_server_label(server).into(),
                    mono_label: false,
                    detail: Some(server.transport.label().into()),
                    mono_detail: true,
                    checked: server.id == selected.id,
                    on_select: Box::new(move |_, cx| {
                        let id = id.clone();
                        entity.update(cx, |panel, cx| {
                            if let Some(key) = panel.project_key.clone() {
                                panel.store.project_mut(&key).select(&id);
                                panel.persist();
                            }
                            panel.synced_server = None;
                            panel.menu = None;
                            cx.notify();
                        });
                    }),
                })
            })
            .collect();

        let unsaved: Vec<&McpServerDraft> = self
            .project_mcp_json
            .iter()
            .filter(|s| !saved_ids.contains(s.id.as_str()))
            .collect();
        if !unsaved.is_empty() {
            entries.push(McpMenuEntry::Separator);
            entries.push(McpMenuEntry::GroupLabel("From .mcp.json".into()));
            for server in unsaved {
                let draft = server.clone();
                let entity = entity.clone();
                entries.push(McpMenuEntry::Row(McpMenuRow {
                    id: SharedString::from(format!("mcp-json-server-{}", server.id)),
                    label: server.name.clone().into(),
                    mono_label: false,
                    detail: Some(server.transport.label().into()),
                    mono_detail: true,
                    checked: false,
                    on_select: Box::new(move |_, cx| {
                        let draft = draft.clone();
                        entity.update(cx, |panel, cx| {
                            if let Some(key) = panel.project_key.clone() {
                                panel.store.project_mut(&key).add(draft);
                                panel.persist();
                            }
                            panel.synced_server = None;
                            panel.menu = None;
                            cx.notify();
                        });
                    }),
                }));
            }
        }

        entries.push(McpMenuEntry::Separator);

        // New server
        entries.push(McpMenuEntry::Row(McpMenuRow {
            id: "mcp-server-action-new".into(),
            label: "New server".into(),
            mono_label: false,
            detail: None,
            mono_detail: false,
            checked: false,
            on_select: Box::new({
                let entity = entity.clone();
                move |_, cx| {
                    entity.update(cx, |panel, cx| {
                        if let Some(key) = panel.project_key.clone() {
                            panel.store.project_mut(&key).add(new_mcp_server(None));
                            panel.persist();
                        }
                        panel.synced_server = None;
                        panel.menu = None;
                        cx.notify();
                    });
                }
            }),
        }));

        // Duplicate
        entries.push(McpMenuEntry::Row(McpMenuRow {
            id: "mcp-server-action-duplicate".into(),
            label: "Duplicate".into(),
            mono_label: false,
            detail: None,
            mono_detail: false,
            checked: false,
            on_select: Box::new({
                let entity = entity.clone();
                move |_, cx| {
                    entity.update(cx, |panel, cx| {
                        if let (Some(key), Some(copy)) = (
                            panel.project_key.clone(),
                            panel.selected_server().map(duplicate_server),
                        ) {
                            panel.store.project_mut(&key).add(copy);
                            panel.persist();
                        }
                        panel.synced_server = None;
                        panel.menu = None;
                        cx.notify();
                    });
                }
            }),
        }));

        // Delete
        entries.push(McpMenuEntry::Row(McpMenuRow {
            id: "mcp-server-action-delete".into(),
            label: "Delete".into(),
            mono_label: false,
            detail: None,
            mono_detail: false,
            checked: false,
            on_select: Box::new(move |_, cx| {
                entity.update(cx, |panel, cx| {
                    if let (Some(key), Some(id)) = (
                        panel.project_key.clone(),
                        panel.selected_server().map(|s| s.id.clone()),
                    ) {
                        let sk = mcp_session_key(&key, &id);
                        panel.disconnect_session(sk, cx);
                        panel.store.project_mut(&key).remove(&id);
                        panel.ensure_project_server(&key);
                        panel.persist();
                    }
                    panel.synced_server = None;
                    panel.menu = None;
                    cx.notify();
                });
            }),
        }));

        dropdown_menu("mcp-servers-menu", &self.tokens, entries, CONTROL_HEIGHT_PX)
    }

    fn render_transport_menu(
        &self,
        selected: &McpServerDraft,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let entity = cx.entity();
        let entries: Vec<McpMenuEntry> = McpTransport::ALL
            .into_iter()
            .map(|candidate| {
                let entity = entity.clone();
                McpMenuEntry::Row(McpMenuRow {
                    id: SharedString::from(format!("mcp-transport-{}", candidate.label())),
                    label: candidate.label().into(),
                    mono_label: true,
                    detail: Some(transport_description(candidate).into()),
                    mono_detail: false,
                    checked: candidate == selected.transport,
                    on_select: Box::new(move |_, cx| {
                        entity.update(cx, |panel, cx| {
                            panel.menu = None;
                            panel.row_inputs.clear();
                            panel.row_subscriptions.clear();
                            panel.edit_selected_server(cx, |s| s.transport = candidate);
                        });
                    }),
                })
            })
            .collect();
        dropdown_menu("mcp-transport-menu", &self.tokens, entries, 24.0)
    }
}

impl Render for McpPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        self.sync_inputs(window, cx);
        let Some(server) = self.selected_server().cloned() else {
            return chrome::empty_state(
                &self.tokens,
                "MCP servers are only available from a project thread.",
            )
            .into_any_element();
        };
        let Some(session_key) = self.current_session_key() else {
            return chrome::empty_state(
                &self.tokens,
                "MCP servers are only available from a project thread.",
            )
            .into_any_element();
        };
        let session = self.sessions.get(&session_key).cloned().unwrap_or_default();

        let connected = session.status == McpStatus::Connected;
        let connecting = session.status == McpStatus::Connecting;
        let tab_infos = visible_tabs(&session);
        let active_tab = resolve_active_tab(self.tab, &tab_infos);

        let toolbar = self.render_toolbar(&server, &session, &session_key, cx);
        let section_tabs: Vec<SectionTab> = tab_infos
            .iter()
            .map(|info| SectionTab {
                id: info.tab.id(),
                label: info.tab.label(),
                count: info.count,
            })
            .collect();

        let entity = cx.entity();
        let trailing: Option<AnyElement> = if active_tab == PanelTab::Log && !session.log.is_empty()
        {
            let sk = session_key.clone();
            let entity_clear = entity.clone();
            Some(
                chrome::toolbar_group(&self.tokens)
                    .child(
                        chrome::icon_button(
                            "mcp-clear-log-btn",
                            "superhero/delete.svg",
                            &self.tokens,
                            false,
                            move |_, _, cx| {
                                let sk = sk.clone();
                                entity_clear.update(cx, |panel, cx| {
                                    if let Some(s) = panel.sessions.get_mut(&sk) {
                                        s.clear_log();
                                    }
                                    panel.expanded_log_ids.clear();
                                    cx.notify();
                                });
                            },
                        )
                        .conn_tooltip("Clear log", &self.tokens),
                    )
                    .into_any_element(),
            )
        } else {
            session.info.as_ref().map(|info| {
                h_flex()
                    .min_w_0()
                    .items_center()
                    .gap(px(6.0))
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(to_hsla(self.tokens.muted_foreground))
                    .child(
                        div()
                            .size(px(6.0))
                            .flex_shrink_0()
                            .rounded(px(9999.0))
                            .bg(to_hsla(self.tokens.success)),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .child(info.title.as_deref().unwrap_or(&info.name).to_owned()),
                    )
                    .into_any_element()
            })
        };

        let tabs_bar = chrome::section_tabs(
            "mcp-panel-tabs",
            &self.tokens,
            &section_tabs,
            active_tab.id(),
            trailing,
            move |tab_id, _, cx| {
                if let Some(next) = PanelTab::from_id(tab_id) {
                    entity.update(cx, |panel, cx| {
                        panel.tab = next;
                        panel.menu = None;
                        cx.notify();
                    });
                }
            },
        );

        let body: AnyElement = if active_tab.is_catalog() && !connected {
            if connecting {
                let muted = to_hsla(self.tokens.muted_foreground);
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .items_center()
                    .justify_center()
                    .gap(px(8.0))
                    .px(px(ROW_PAD_START_PX))
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(superhero_icon("superhero/spinner.svg", 16.0, muted))
                    .child("Connecting…")
                    .into_any_element()
            } else {
                chrome::empty_state(
                    &self.tokens,
                    format!("Connect to the server to see its {}.", active_tab.noun()),
                )
                .into_any_element()
            }
        } else {
            match active_tab {
                PanelTab::Tools => self.render_tools_tab(&session_key, &session, window, cx),
                PanelTab::Resources => {
                    self.render_resources_tab(&session_key, &session, window, cx)
                }
                PanelTab::Prompts => self.render_prompts_tab(&session_key, &session, window, cx),
                PanelTab::Log => self.render_log_tab(&session.log, cx),
                PanelTab::Server => self.render_server_tab(&server, &session, window, cx),
            }
        };

        let sk_key = session_key;
        let mut root = v_flex()
            .id("mcp-panel")
            .size_full()
            .on_key_down(cx.listener(move |panel, event: &KeyDownEvent, _, cx| {
                let k = &event.keystroke;
                if k.key == "escape" && panel.menu.take().is_some() {
                    cx.notify();
                    cx.stop_propagation();
                    return;
                }
                if k.key == "enter" && (k.modifiers.platform || k.modifiers.control) {
                    if connected && panel.run_active_playground(&sk_key, active_tab, cx) {
                        cx.stop_propagation();
                    } else if !connected {
                        panel.toggle_connection(cx);
                        cx.stop_propagation();
                    }
                }
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|panel, _, _, cx| {
                    if panel.menu.take().is_some() {
                        cx.notify();
                    }
                }),
            )
            .child(toolbar);

        if let Some(error) = &session.error {
            root = root.child(chrome::warning_notice(&self.tokens, error.clone()));
        }

        root.child(tabs_bar).child(body).into_any_element()
    }
}
