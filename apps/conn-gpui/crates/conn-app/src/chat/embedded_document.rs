//! Native mounted documents in the chat: agent-rendered HTML pages and MCP apps.
//!
//! The card owns an [`IsolatedSurface`] (CEF, no privileged bridges) whose host page holds one
//! sandboxed `<iframe>` with the same policy as the web client (`sandbox="allow-scripts
//! allow-forms"`, an opaque origin, `window.parent` for the app). The signed document URL is set
//! by script after the host page loads, so it never appears in a trace or log.
//!
//! The MCP side is a port of `apps/web/src/components/chat/McpAppFrame.tsx`: the host protocol
//! lives in [`protocol`], and every app request goes to the server through the thread's own
//! `mcpApps.*` RPCs, which restrict the app to the server that produced it.

#[cfg(target_os = "macos")]
mod av_player;
mod input;
mod local_page;
#[cfg(target_os = "macos")]
mod native_video;
mod protocol;
mod video;
mod view;

use std::collections::VecDeque;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use conn_client::{ClientError, Connection};
use conn_theme::Tokens;
use gpui_kit::prelude::*;
use gpui_kit::{
    AsyncApp, Context, Entity, FontWeight, IntoElement, ParentElement, Render, Styled,
    Subscription, Task, WeakEntity, Window, canvas, div, px,
};
use serde_json::{Value, json};

use self::protocol::{
    DocumentTheme, Download, Effect, GuestCall, HTML_RENDER_COLUMN_WIDTH, HtmlGuestMessage,
    HtmlRenderReference, MAX_MESSAGE_BYTES, MCP_APP_DEFAULT_HEIGHT, MCP_APP_MAX_HEIGHT,
    McpAppReference, McpHost, TEARDOWN_TIMEOUT, clamp_mcp_height, empty_result, html_document_src,
    mcp_document_src, mcp_resource_bytes, normalize_tool_result, read_html_guest_message,
    read_turn_item_tool_call, request_error_message,
};
use self::view::{IsolatedSurface, SecretUrl, SurfaceEvent};
use super::card_face::{
    CARD_BODY_RADIUS_PX, CARD_ICON_PX, CardFace, card_colors, card_header, card_shell,
};
use super::icons;
use crate::a11y::ConnA11yExt as _;
use crate::chat::color::hsla;

pub(crate) use self::video::{EmbeddedVideoCard, EmbeddedVideoFacts};

const UI_TEXT_PX: f32 = 13.0;
const UI_LINE_HEIGHT_PX: f32 = 20.0;
const HOST_VERSION: &str = env!("CARGO_PKG_VERSION");
/// The sandbox the web client gives agent HTML and MCP apps. Never `allow-same-origin`.
const FRAME_SANDBOX: &str = "allow-scripts allow-forms";
/// A link opens only within this long of the reader's last click or key in the document.
const LINK_ACTIVATION: Duration = Duration::from_secs(5);
const MAX_DOWNLOAD_BYTES: usize = 25 * 1024 * 1024;
const MAX_CONFIRMATION_DETAIL_CHARS: usize = 600;
const NO_ANSWER: &str = "Conn could not ask for approval here.";

/// What the owner knows about the document's tool item.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct EmbeddedDocumentFacts {
    pub(crate) thread_id: String,
    pub(crate) item_id: String,
    pub(crate) title: String,
    /// Compact validated `htmlRender` or `t3McpApp` metadata, with its `attachmentId`.
    pub(crate) document: Value,
    pub(crate) is_mcp: bool,
    pub(crate) tool_input: Option<Value>,
    pub(crate) tool_result: Option<Value>,
}

enum Document {
    Html(HtmlRenderReference),
    Mcp(McpAppReference),
}

impl Document {
    fn read(facts: &EmbeddedDocumentFacts) -> Option<Self> {
        if facts.is_mcp {
            McpAppReference::read(&facts.document).map(Self::Mcp)
        } else {
            HtmlRenderReference::read(&facts.document).map(Self::Html)
        }
    }

    fn attachment_id(&self) -> &str {
        match self {
            Self::Html(reference) => &reference.attachment_id,
            Self::Mcp(reference) => &reference.attachment_id,
        }
    }

    fn mcp(&self) -> Option<&McpAppReference> {
        match self {
            Self::Mcp(reference) => Some(reference),
            Self::Html(_) => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum DocState {
    /// Waiting for a connection or for the server to sign a URL.
    Minting,
    /// The host page has the URL and the document is loading.
    Loading,
    Ready,
    Failed(String),
    /// The app left its page; it was stopped.
    Stopped(String),
    /// The app asked to close, or the reader did.
    Closed,
}

/// The stored tool call, fetched when the projection omitted it.
#[derive(Debug)]
enum Hydration {
    Idle,
    InFlight,
    Done {
        input: Option<Value>,
        result: Option<Value>,
    },
    Failed,
}

/// An approval the app is waiting on.
struct Confirmation {
    title: String,
    detail: String,
    reply: futures::channel::oneshot::Sender<bool>,
}

pub(crate) struct EmbeddedDocumentCard {
    facts: EmbeddedDocumentFacts,
    document: Option<Document>,
    /// The thread the reader is in: it gets the app's messages and model context. Tools and
    /// resources always stay scoped to the item's own thread.
    conversation_thread_id: Option<String>,
    tokens: Tokens,
    theme: DocumentTheme,
    connection: Option<Connection>,
    surface: Entity<IsolatedSurface>,
    _surface_events: Subscription,
    page_loaded: bool,
    src: Option<SecretUrl>,
    applied: bool,
    state: DocState,
    width: f32,
    /// A plain page's measured height, once it has reported one.
    content_height: Option<f32>,
    /// An MCP app's reported height.
    mcp_height: f32,
    host: Option<McpHost>,
    /// Bumped whenever the host is replaced, so a late answer is dropped.
    epoch: u64,
    mint_generation: u64,
    mint_task: Option<Task<()>>,
    tool_definition: Option<Value>,
    tool_info_requested: bool,
    hydration: Hydration,
    hydration_generation: u64,
    confirmations: VecDeque<Confirmation>,
    last_input: Option<Instant>,
}

impl fmt::Debug for EmbeddedDocumentCard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EmbeddedDocumentCard")
            .field("item_id", &self.facts.item_id)
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

/// The host page: one sandboxed frame, and the only code that talks to the app's window.
fn document_page(prefix: &str) -> String {
    let prefix = Value::String(prefix.to_owned()).to_string();
    format!(
        r#"<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src http: https: about:">
<style>html,body{{margin:0;height:100%;overflow:hidden;background:transparent}}iframe{{display:block;border:0;width:100%;height:100%;background:transparent}}</style>
<iframe id="f" title="document" referrerpolicy="no-referrer"></iframe>
<script>
(() => {{
  const prefix = {prefix};
  const frame = document.getElementById("f");
  const send = (line) => console.log(prefix + line);
  let loads = 0;
  frame.addEventListener("load", () => {{
    const src = frame.getAttribute("src");
    if (!src || src === "about:blank") return;
    loads += 1;
    send(JSON.stringify({{ t: "load", n: loads }}));
  }});
  window.addEventListener("message", (event) => {{
    if (event.source !== frame.contentWindow) return;
    let json;
    try {{ json = JSON.stringify(event.data); }} catch {{ return; }}
    if (typeof json !== "string") return;
    if (json.length > {max}) {{
      const id = event.data && typeof event.data === "object" ? event.data.id : undefined;
      send(JSON.stringify({{ t: "big", id: id === undefined ? null : id }}));
      return;
    }}
    send('{{"t":"msg","d":' + json + '}}');
  }});
  Object.defineProperty(window, "__connDoc", {{ value: Object.freeze({{
    load(config) {{
      loads = 0;
      frame.setAttribute("sandbox", config.sandbox);
      if (config.allow) frame.setAttribute("allow", config.allow); else frame.removeAttribute("allow");
      frame.src = config.src;
    }},
    clear() {{ loads = 0; frame.src = "about:blank"; }},
    post(message) {{ const target = frame.contentWindow; if (target) target.postMessage(message, "*"); }},
  }}) }});
}})();
</script>"#,
        max = MAX_MESSAGE_BYTES
    )
}

fn environment() -> &'static (String, Option<String>) {
    static ENV: OnceLock<(String, Option<String>)> = OnceLock::new();
    ENV.get_or_init(|| {
        let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
            .iter()
            .filter_map(|key| std::env::var(key).ok())
            .find(|value| !value.is_empty() && value != "C" && value != "POSIX")
            .and_then(|value| {
                value
                    .split(['.', '@'])
                    .next()
                    .map(|name| name.replace('_', "-"))
            })
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "en-US".to_owned());
        let time_zone = std::fs::read_link("/etc/localtime")
            .ok()
            .and_then(|target| {
                target
                    .to_str()
                    .and_then(|path| path.split_once("zoneinfo/"))
                    .map(|(_, zone)| zone.to_owned())
            });
        (locale, time_zone)
    })
}

fn client_error_message(error: &ClientError) -> String {
    match error {
        ClientError::Rpc(value) => request_error_message(value)
            .unwrap_or("Request failed.")
            .to_owned(),
        _ => "Request failed.".to_owned(),
    }
}

/// Everything an app request needs, copied out so the request can run without the card.
struct CallScope {
    connection: Option<Connection>,
    thread_id: String,
    item_id: String,
    conversation_thread_id: String,
    server: String,
}

impl CallScope {
    fn payload(&self, extra: Value) -> Value {
        let mut payload = json!({ "threadId": self.thread_id, "itemId": self.item_id });
        if let (Some(target), Some(extra)) = (payload.as_object_mut(), extra.as_object()) {
            for (key, value) in extra {
                target.insert(key.clone(), value.clone());
            }
        }
        payload
    }

    async fn rpc(&self, tag: &str, extra: Value) -> Result<Value, String> {
        let Some(connection) = &self.connection else {
            return Err("Conn is not connected.".to_owned());
        };
        connection
            .call_json(tag, self.payload(extra))
            .await
            .map_err(|error| client_error_message(&error))
    }
}

/// Asks the reader, and waits for the answer.
async fn ask(
    this: &WeakEntity<EmbeddedDocumentCard>,
    cx: &mut AsyncApp,
    title: String,
    detail: String,
) -> Result<bool, String> {
    let (reply, answer) = futures::channel::oneshot::channel();
    let queued = this
        .update(cx, |card, cx| {
            card.confirmations.push_back(Confirmation {
                title,
                detail,
                reply,
            });
            cx.notify();
        })
        .is_ok();
    if !queued {
        return Err(NO_ANSWER.to_owned());
    }
    Ok(answer.await.unwrap_or(false))
}

fn pretty(value: &Value) -> String {
    let text = serde_json::to_string_pretty(value).unwrap_or_default();
    if text.chars().count() > MAX_CONFIRMATION_DETAIL_CHARS {
        let mut cut: String = text.chars().take(MAX_CONFIRMATION_DETAIL_CHARS).collect();
        cut.push('…');
        cut
    } else {
        text
    }
}

/// Runs one app request. `Err` answers the app with a JSON-RPC error; a refusal the spec treats
/// as a result (`ui/download-file`) is an `Ok`.
async fn perform_call(
    this: &WeakEntity<EmbeddedDocumentCard>,
    cx: &mut AsyncApp,
    scope: CallScope,
    call: GuestCall,
) -> Result<Value, String> {
    match call {
        GuestCall::ToolsCall { name, arguments } => {
            let info = scope
                .rpc("mcpApps.toolInfo", json!({ "name": name }))
                .await?;
            if info.get("callable").and_then(Value::as_bool) != Some(true) {
                return Err("This app cannot call that tool.".to_owned());
            }
            // Only a tool the server marks read-only runs without asking.
            if info.get("readOnly").and_then(Value::as_bool) != Some(true) {
                let title = info
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or(&name)
                    .to_owned();
                let approved = ask(
                    this,
                    cx,
                    format!("Allow {} to run {title}?", scope.server),
                    pretty(&Value::Object(arguments.clone())),
                )
                .await?;
                if !approved {
                    return Err("Declined by the user.".to_owned());
                }
            }
            let result = scope
                .rpc(
                    "mcpApps.callTool",
                    json!({ "name": name, "arguments": arguments }),
                )
                .await?;
            Ok(normalize_tool_result(&result))
        }
        GuestCall::ResourcesRead { uri } => {
            scope
                .rpc("mcpApps.readResource", json!({ "uri": uri }))
                .await
        }
        GuestCall::OpenLink { url } => {
            let opened = this
                .update(cx, |card, cx| {
                    let allowed = card.recent_input();
                    if allowed {
                        cx.open_url(&url);
                    }
                    allowed
                })
                .unwrap_or(false);
            if opened {
                Ok(json!({}))
            } else {
                Err("Links open only from a click in the app.".to_owned())
            }
        }
        GuestCall::Message { text } => {
            let Some(connection) = &scope.connection else {
                return Err("Messages are not available here.".to_owned());
            };
            let approved = ask(
                this,
                cx,
                format!("Send this message from {}?", scope.server),
                text.clone(),
            )
            .await?;
            if !approved {
                return Err("Declined by the user.".to_owned());
            }
            // The message goes to the conversation the reader is in, queued when it is busy.
            let command = crate::commands::send_message(
                &scope.conversation_thread_id,
                &text,
                &[],
                true,
                None,
            )
            .map_err(|_| "Could not send the message.".to_owned())?;
            connection
                .dispatch_command(command)
                .await
                .map_err(|_| "Could not send the message.".to_owned())?;
            Ok(json!({}))
        }
        // Only inline is offered, so the host never reaches this; the answer stays honest.
        GuestCall::DisplayMode { .. } => Ok(json!({ "mode": "inline" })),
        GuestCall::UpdateModelContext {
            content,
            structured_content,
        } => {
            let mut extra = json!({ "conversationThreadId": scope.conversation_thread_id });
            if let Some(object) = extra.as_object_mut() {
                if let Some(content) = content {
                    object.insert("content".to_owned(), Value::Array(content));
                }
                if let Some(structured) = structured_content {
                    object.insert("structuredContent".to_owned(), Value::Object(structured));
                }
            }
            scope.rpc("mcpApps.updateModelContext", extra).await?;
            Ok(json!({}))
        }
        GuestCall::DownloadFile { files } => {
            let names = files
                .iter()
                .map(|file| file.name().to_owned())
                .collect::<Vec<_>>()
                .join(", ");
            let approved = ask(
                this,
                cx,
                format!("Save {names} from {}?", scope.server),
                String::new(),
            )
            .await?;
            if !approved {
                return Ok(json!({ "isError": true }));
            }
            for file in files {
                let (name, bytes) = match file {
                    Download::Embedded { name, bytes, .. } => (name, bytes),
                    Download::Link { name, uri, .. } => {
                        let read = scope
                            .rpc("mcpApps.readResource", json!({ "uri": uri }))
                            .await?;
                        let bytes = read
                            .get("contents")
                            .and_then(Value::as_array)
                            .and_then(|contents| contents.first())
                            .and_then(mcp_resource_bytes)
                            .ok_or_else(|| format!("{name} has no contents."))?;
                        (name, bytes)
                    }
                };
                if bytes.len() > MAX_DOWNLOAD_BYTES {
                    return Err(format!("{name} is too large to save."));
                }
                cx.background_executor()
                    .spawn(async move { save_download(&name, &bytes) })
                    .await?;
            }
            Ok(json!({}))
        }
    }
}

/// Writes `bytes` to the Downloads folder under a name no file has yet, and returns its path.
fn save_download(name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "No Downloads folder.".to_owned())?;
    save_download_in(&PathBuf::from(home).join("Downloads"), name, bytes)
}

fn save_download_in(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    use std::io::Write as _;

    let name = if name.trim_matches('.').trim().is_empty() {
        "download"
    } else {
        name
    };
    std::fs::create_dir_all(dir).map_err(|_| "Could not open the Downloads folder.".to_owned())?;
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (name, String::new()),
    };
    for attempt in 0..1000_u32 {
        let candidate = if attempt == 0 {
            dir.join(name)
        } else {
            dir.join(format!("{stem} ({attempt}){extension}"))
        };
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut file) => {
                file.write_all(bytes)
                    .map_err(|_| "Could not save the file.".to_owned())?;
                return Ok(candidate);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err("Could not save the file.".to_owned()),
        }
    }
    Err("Could not find a free file name.".to_owned())
}

impl EmbeddedDocumentCard {
    pub(crate) fn new(
        facts: EmbeddedDocumentFacts,
        tokens: Tokens,
        connection: Option<Connection>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let document = Document::read(&facts);
        let theme = DocumentTheme::from_tokens(&tokens);
        let surface_tokens = tokens.clone();
        let ax_id = format!("chat.embedded-document.{}.page", facts.item_id);
        let surface = cx.new(|cx| {
            IsolatedSurface::new(
                document_page,
                ax_id,
                "Embedded document",
                surface_tokens,
                window,
                cx,
            )
        });
        let subscription = cx.subscribe(&surface, |this, _surface, event: &SurfaceEvent, cx| {
            this.on_surface_event(event, cx);
        });
        let host = document
            .as_ref()
            .and_then(Document::mcp)
            .map(|app| McpHost::new(app, HOST_VERSION));
        let mut card = Self {
            facts,
            document,
            conversation_thread_id: None,
            tokens,
            theme,
            connection,
            surface,
            _surface_events: subscription,
            page_loaded: false,
            src: None,
            applied: false,
            state: DocState::Minting,
            width: 0.0,
            content_height: None,
            mcp_height: MCP_APP_DEFAULT_HEIGHT,
            host,
            epoch: 0,
            mint_generation: 0,
            mint_task: None,
            tool_definition: None,
            tool_info_requested: false,
            hydration: Hydration::Idle,
            hydration_generation: 0,
            confirmations: VecDeque::new(),
            last_input: None,
        };
        if card.document.is_none() {
            card.state = DocState::Failed(format!("Unable to load {}", card.facts.title));
        } else {
            card.start_mint(cx);
            card.fetch_tool_info(cx);
            card.maybe_hydrate(cx);
        }
        card
    }

    pub(crate) fn set_facts(&mut self, facts: EmbeddedDocumentFacts, cx: &mut Context<'_, Self>) {
        if self.facts == facts {
            return;
        }
        let document = Document::read(&facts);
        let same_document = facts.is_mcp == self.facts.is_mcp
            && facts.item_id == self.facts.item_id
            && document.as_ref().map(Document::attachment_id)
                == self.document.as_ref().map(Document::attachment_id);
        self.facts = facts;
        if same_document {
            // A call that was still running, or whose fetch failed, may now be fetchable.
            if matches!(
                self.hydration,
                Hydration::Failed | Hydration::Done { result: None, .. }
            ) {
                self.hydration = Hydration::Idle;
            }
            self.document = document;
            self.push_tool_call(cx);
            self.maybe_hydrate(cx);
            cx.notify();
            return;
        }
        self.document = document;
        self.hydration = Hydration::Idle;
        self.hydration_generation += 1;
        self.tool_info_requested = false;
        self.tool_definition = None;
        self.content_height = None;
        self.mcp_height = MCP_APP_DEFAULT_HEIGHT;
        self.src = None;
        self.applied = false;
        self.reset_host();
        self.deny_confirmations();
        if self.document.is_none() {
            self.mint_task = None;
            self.state = DocState::Failed(format!("Unable to load {}", self.facts.title));
        } else {
            self.start_mint(cx);
            self.fetch_tool_info(cx);
            self.maybe_hydrate(cx);
        }
        cx.notify();
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        let theme = DocumentTheme::from_tokens(&tokens);
        let changed = theme != self.theme;
        self.theme = theme;
        let surface_tokens = tokens.clone();
        self.surface
            .update(cx, |surface, cx| surface.set_tokens(surface_tokens, cx));
        self.tokens = tokens;
        if changed && self.applied {
            if self.host.is_some() {
                self.sync_host_context(cx);
            } else {
                let message = self.theme.host_context_changed();
                self.post_to_guest(&message, cx);
            }
        }
        cx.notify();
    }

    pub(crate) fn set_visible(&mut self, visible: bool, cx: &mut Context<'_, Self>) {
        self.surface
            .update(cx, |surface, cx| surface.set_visible(visible, cx));
    }

    /// The thread the reader is in, which gets the app's messages and model context. It differs
    /// from the item's thread when the item comes from a subagent. Defaults to the item's thread.
    pub(crate) fn set_conversation_thread_id(
        &mut self,
        thread_id: Option<String>,
        _cx: &mut Context<'_, Self>,
    ) {
        self.conversation_thread_id = thread_id;
    }

    // -- Document loading ------------------------------------------------------------------

    fn start_mint(&mut self, cx: &mut Context<'_, Self>) {
        self.state = DocState::Minting;
        self.mint_task = None;
        let (Some(connection), Some(document)) = (self.connection.clone(), &self.document) else {
            return;
        };
        self.mint_generation += 1;
        let generation = self.mint_generation;
        let attachment_id = document.attachment_id().to_owned();
        let is_mcp = self.facts.is_mcp;
        self.mint_task = Some(cx.spawn(async move |this, cx| {
            let minted = connection
                .attachment_document_url(&attachment_id, is_mcp)
                .await;
            let _ = this.update(cx, |card, cx| card.finish_mint(generation, minted, cx));
        }));
    }

    fn finish_mint(
        &mut self,
        generation: u64,
        minted: Result<url::Url, ClientError>,
        cx: &mut Context<'_, Self>,
    ) {
        if generation != self.mint_generation {
            return;
        }
        self.mint_task = None;
        match minted {
            Ok(url) => {
                let src = if self.facts.is_mcp {
                    mcp_document_src(&url, &self.theme)
                } else {
                    html_document_src(&url, &self.theme)
                };
                self.src = Some(SecretUrl(src));
                self.applied = false;
                self.state = DocState::Loading;
                self.apply_src(cx);
            }
            Err(_) => {
                self.state = DocState::Failed(self.unable_message());
            }
        }
        cx.notify();
    }

    fn unable_message(&self) -> String {
        match &self.document {
            Some(Document::Mcp(app)) => format!("Unable to load the {} app", app.server),
            _ => format!("Unable to load {}", self.facts.title),
        }
    }

    fn server_name(&self) -> String {
        match &self.document {
            Some(Document::Mcp(app)) => app.server.clone(),
            _ => self.facts.title.clone(),
        }
    }

    /// Gives the host page the URL once both exist, and starts a fresh app session for it.
    fn apply_src(&mut self, cx: &mut Context<'_, Self>) {
        if !self.page_loaded || self.applied {
            return;
        }
        let (Some(src), Some(document)) = (&self.src, &self.document) else {
            return;
        };
        let allow = document.mcp().map(McpAppReference::allow_attribute);
        let config = json!({
            "src": src.0,
            "sandbox": FRAME_SANDBOX,
            "allow": allow.unwrap_or_default(),
        });
        let code = format!("__connDoc.load({config})");
        self.surface.update(cx, |surface, _| surface.run_js(&code));
        self.applied = true;
        self.reset_host();
        self.push_tool_call(cx);
    }

    fn reset_host(&mut self) {
        self.epoch += 1;
        self.host = self
            .document
            .as_ref()
            .and_then(Document::mcp)
            .map(|app| McpHost::new(app, HOST_VERSION));
    }

    fn retry(&mut self, cx: &mut Context<'_, Self>) {
        self.src = None;
        self.applied = false;
        self.content_height = None;
        self.reset_host();
        self.start_mint(cx);
        cx.notify();
    }

    // -- Page events -----------------------------------------------------------------------

    fn recent_input(&self) -> bool {
        self.last_input
            .is_some_and(|at| at.elapsed() <= LINK_ACTIVATION)
    }

    fn on_surface_event(&mut self, event: &SurfaceEvent, cx: &mut Context<'_, Self>) {
        match event {
            SurfaceEvent::PageLoaded => {
                // A fresh host page holds nothing, so it needs the URL again.
                self.page_loaded = true;
                self.applied = false;
                self.apply_src(cx);
            }
            SurfaceEvent::UserInput => self.last_input = Some(Instant::now()),
            SurfaceEvent::Message(message) => self.on_page_message(message, cx),
        }
    }

    fn on_page_message(&mut self, message: &Value, cx: &mut Context<'_, Self>) {
        match message.get("t").and_then(Value::as_str) {
            Some("load") => {
                let loads = message.get("n").and_then(Value::as_u64).unwrap_or(0);
                self.on_document_load(loads, cx);
            }
            Some("msg") => {
                if let Some(data) = message.get("d") {
                    self.on_guest_data(data, cx);
                }
            }
            Some("big") => {
                let id = message.get("id").cloned().unwrap_or(Value::Null);
                let effects = match &self.host {
                    Some(host) => host.refuse_oversized(&id),
                    None => return,
                };
                self.run_effects(effects, cx);
            }
            _ => {}
        }
    }

    /// Navigation retains the frame window, so a second load in an app's frame would let a
    /// different page impersonate the app: stop it.
    fn on_document_load(&mut self, loads: u64, cx: &mut Context<'_, Self>) {
        if loads > 1 && self.host.is_some() {
            if let Some(host) = self.host.as_mut() {
                host.dispose();
            }
            self.state = DocState::Stopped(format!(
                "The {} app left its page and was stopped",
                self.server_name()
            ));
            self.surface
                .update(cx, |surface, _| surface.run_js("__connDoc.clear()"));
            cx.notify();
            return;
        }
        if loads >= 1 && self.state == DocState::Loading {
            self.state = DocState::Ready;
            cx.notify();
        }
    }

    fn on_guest_data(&mut self, data: &Value, cx: &mut Context<'_, Self>) {
        if self.host.is_some() {
            let context = self.host_context();
            let effects = match self.host.as_mut() {
                Some(host) => host.receive(data, &context),
                None => return,
            };
            self.run_effects(effects, cx);
            return;
        }
        match read_html_guest_message(data) {
            Some(HtmlGuestMessage::ContentHeight(height)) => {
                self.content_height = Some(height);
                cx.notify();
            }
            // A page can ask at any time; only a reader's recent click or key opens a link.
            Some(HtmlGuestMessage::OpenLink { id, url }) if self.recent_input() => {
                cx.open_url(&url);
                self.post_to_guest(&empty_result(&id), cx);
            }
            Some(HtmlGuestMessage::OpenLink { .. }) | None => {}
        }
    }

    fn post_to_guest(&self, message: &Value, cx: &mut Context<'_, Self>) {
        let code = format!("__connDoc.post({message})");
        self.surface.update(cx, |surface, _| surface.run_js(&code));
    }

    // -- MCP host --------------------------------------------------------------------------

    fn host_context(&self) -> Value {
        let (locale, time_zone) = environment();
        let mut context = json!({
            "theme": self.theme.appearance,
            "styles": { "variables": self.theme.mcp_style_variables() },
            "displayMode": "inline",
            "availableDisplayModes": ["inline"],
            "containerDimensions": {
                "width": self.width.round(),
                "maxHeight": MCP_APP_MAX_HEIGHT,
            },
            "platform": "desktop",
            "locale": locale,
            "userAgent": format!("conn-gpui/{HOST_VERSION}"),
            "deviceCapabilities": { "touch": false, "hover": true },
            "safeAreaInsets": { "top": 0, "right": 0, "bottom": 0, "left": 0 },
        });
        if let Some(object) = context.as_object_mut() {
            if let Some(zone) = time_zone {
                object.insert("timeZone".to_owned(), Value::String(zone.clone()));
            }
            if let Some(tool) = &self.tool_definition {
                object.insert("toolInfo".to_owned(), json!({ "tool": tool }));
            }
        }
        context
    }

    fn sync_host_context(&mut self, cx: &mut Context<'_, Self>) {
        let context = self.host_context();
        let effects = match self.host.as_mut() {
            Some(host) => host.update_host_context(&context),
            None => return,
        };
        self.run_effects(effects, cx);
    }

    fn run_effects(&mut self, effects: Vec<Effect>, cx: &mut Context<'_, Self>) {
        for effect in effects {
            match effect {
                Effect::Post(message) => self.post_to_guest(&message, cx),
                Effect::Call { id, call } => self.spawn_call(id, call, cx),
                Effect::SizeChanged { height } => {
                    if let Some(height) = height {
                        let height = clamp_mcp_height(height);
                        if (height - self.mcp_height).abs() >= 0.5 {
                            self.mcp_height = height;
                            cx.notify();
                        }
                    }
                }
                Effect::RequestTeardown => self.begin_close(cx),
                Effect::TeardownAnswered => self.finish_close(cx),
            }
        }
    }

    fn spawn_call(&mut self, id: Value, call: GuestCall, cx: &mut Context<'_, Self>) {
        let epoch = self.epoch;
        let scope = CallScope {
            connection: self.connection.clone(),
            thread_id: self.facts.thread_id.clone(),
            item_id: self.facts.item_id.clone(),
            conversation_thread_id: self
                .conversation_thread_id
                .clone()
                .unwrap_or_else(|| self.facts.thread_id.clone()),
            server: self.server_name(),
        };
        cx.spawn(async move |this, cx| {
            let outcome = perform_call(&this, cx, scope, call).await;
            let _ = this.update(cx, |card, cx| card.finish_call(epoch, &id, outcome, cx));
        })
        .detach();
    }

    fn finish_call(
        &mut self,
        epoch: u64,
        id: &Value,
        outcome: Result<Value, String>,
        cx: &mut Context<'_, Self>,
    ) {
        if epoch != self.epoch {
            return;
        }
        let effects = match self.host.as_mut() {
            Some(host) => host.finish(id, outcome),
            None => return,
        };
        self.run_effects(effects, cx);
    }

    fn begin_close(&mut self, cx: &mut Context<'_, Self>) {
        let (effects, waits) = match self.host.as_mut() {
            Some(host) => host.teardown(),
            None => return,
        };
        self.run_effects(effects, cx);
        if !waits {
            self.finish_close(cx);
            return;
        }
        let epoch = self.epoch;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(TEARDOWN_TIMEOUT).await;
            let _ = this.update(cx, |card, cx| {
                if card.epoch == epoch && card.state != DocState::Closed {
                    card.finish_close(cx);
                }
            });
        })
        .detach();
    }

    fn finish_close(&mut self, cx: &mut Context<'_, Self>) {
        if self.state == DocState::Closed {
            return;
        }
        if let Some(host) = self.host.as_mut() {
            host.dispose();
        }
        self.epoch += 1;
        self.deny_confirmations();
        self.src = None;
        self.applied = false;
        self.state = DocState::Closed;
        self.surface
            .update(cx, |surface, _| surface.run_js("__connDoc.clear()"));
        cx.notify();
    }

    fn reopen(&mut self, cx: &mut Context<'_, Self>) {
        self.reset_host();
        self.content_height = None;
        self.mcp_height = MCP_APP_DEFAULT_HEIGHT;
        self.start_mint(cx);
        cx.notify();
    }

    // -- Tool call and tool definition -------------------------------------------------------

    /// The input and result the app should see: the owner's facts first, then the fetched call.
    fn effective_tool_call(&self) -> Option<(Value, Option<Value>)> {
        let (fetched_input, fetched_result) = match &self.hydration {
            Hydration::Done { input, result } => (input.as_ref(), result.as_ref()),
            _ => (None, None),
        };
        let input = self.facts.tool_input.as_ref().or(fetched_input);
        let result = self.facts.tool_result.as_ref().or(fetched_result);
        if input.is_none() && result.is_none() {
            return None;
        }
        Some((input.cloned().unwrap_or_else(|| json!({})), result.cloned()))
    }

    fn push_tool_call(&mut self, cx: &mut Context<'_, Self>) {
        let Some((input, result)) = self.effective_tool_call() else {
            return;
        };
        let effects = match self.host.as_mut() {
            Some(host) => host.set_tool_call(input, result),
            None => return,
        };
        self.run_effects(effects, cx);
    }

    /// The projection can omit a tool's output; the app still needs its input and result, which
    /// the web client reads with `getTurnItem` (`useTurnItemDetail`).
    fn maybe_hydrate(&mut self, cx: &mut Context<'_, Self>) {
        if self.host.is_none()
            || (self.facts.tool_input.is_some() && self.facts.tool_result.is_some())
            || !matches!(self.hydration, Hydration::Idle)
        {
            return;
        }
        let Some(connection) = self.connection.clone() else {
            return;
        };
        self.hydration = Hydration::InFlight;
        self.hydration_generation += 1;
        let generation = self.hydration_generation;
        let payload = json!({
            "threadId": self.facts.thread_id,
            "itemId": self.facts.item_id,
        });
        cx.spawn(async move |this, cx| {
            let fetched = connection
                .call_json("orchestration.getTurnItem", payload)
                .await;
            let _ = this.update(cx, |card, cx| {
                card.finish_hydration(generation, fetched, cx)
            });
        })
        .detach();
    }

    fn finish_hydration(
        &mut self,
        generation: u64,
        fetched: Result<Value, ClientError>,
        cx: &mut Context<'_, Self>,
    ) {
        if generation != self.hydration_generation {
            return;
        }
        self.hydration = match fetched {
            Ok(response) => match read_turn_item_tool_call(&response) {
                Some((input, result)) => Hydration::Done {
                    input: Some(input),
                    result,
                },
                None => Hydration::Done {
                    input: None,
                    result: None,
                },
            },
            Err(_) => Hydration::Failed,
        };
        self.push_tool_call(cx);
    }

    /// The tool definition an app reads from its host context.
    fn fetch_tool_info(&mut self, cx: &mut Context<'_, Self>) {
        let (Some(connection), Some(app)) = (
            self.connection.clone(),
            self.document.as_ref().and_then(Document::mcp),
        ) else {
            return;
        };
        if self.tool_info_requested {
            return;
        }
        self.tool_info_requested = true;
        let item_id = self.facts.item_id.clone();
        let payload = json!({
            "threadId": self.facts.thread_id,
            "itemId": item_id,
            "name": app.tool,
        });
        cx.spawn(async move |this, cx| {
            let info = connection.call_json("mcpApps.toolInfo", payload).await;
            let _ = this.update(cx, |card, cx| {
                if card.facts.item_id != item_id {
                    return;
                }
                match info {
                    Ok(info) => {
                        card.tool_definition = info.get("tool").filter(|t| !t.is_null()).cloned();
                        card.sync_host_context(cx);
                    }
                    Err(_) => card.tool_info_requested = false,
                }
            });
        })
        .detach();
    }

    // -- Confirmations ---------------------------------------------------------------------

    fn answer_confirmation(&mut self, approved: bool, cx: &mut Context<'_, Self>) {
        if let Some(confirmation) = self.confirmations.pop_front() {
            let _ = confirmation.reply.send(approved);
        }
        cx.notify();
    }

    fn deny_confirmations(&mut self) {
        for confirmation in self.confirmations.drain(..) {
            let _ = confirmation.reply.send(false);
        }
    }

    // -- Layout ----------------------------------------------------------------------------

    fn set_width(&mut self, width: f32, cx: &mut Context<'_, Self>) {
        if (self.width - width).abs() < 0.5 {
            return;
        }
        self.width = width;
        if self.host.is_some() {
            self.sync_host_context(cx);
        }
        cx.notify();
    }

    fn frame_height(&self) -> f32 {
        let width = if self.width >= 1.0 {
            self.width
        } else {
            HTML_RENDER_COLUMN_WIDTH
        };
        match &self.document {
            Some(Document::Html(reference)) => reference.frame_height(width, self.content_height),
            Some(Document::Mcp(_)) => self.mcp_height,
            None => 40.0,
        }
    }
}

fn pill_button(
    id: String,
    label: &'static str,
    background: gpui_kit::Hsla,
    border: gpui_kit::Hsla,
    foreground: gpui_kit::Hsla,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id.clone())
        .a11y_button(id, label)
        .h(px(28.0))
        .px(px(12.0))
        .flex()
        .items_center()
        .rounded(px(9999.0))
        .bg(background)
        .border_1()
        .border_color(border)
        .text_size(px(UI_TEXT_PX))
        .text_color(foreground)
        .cursor_pointer()
        .child(label)
}

impl Render for EmbeddedDocumentCard {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let tokens = self.tokens.clone();
        let foreground = hsla(tokens.foreground);
        let muted = hsla(tokens.muted_foreground);
        let colors = card_colors(&tokens, CardFace::Plain);
        let page_bg = colors.body();
        let (kind, glyph) = if self.facts.is_mcp {
            ("MCP app", "brand/mcp.svg")
        } else {
            ("HTML preview", "superhero/laptop.svg")
        };
        let title = match &self.document {
            Some(Document::Html(reference)) => reference.title.as_str(),
            Some(Document::Mcp(app)) => app.server.as_str(),
            None => self.facts.title.as_str(),
        };
        let ax = format!("chat.embedded-document.{}", self.facts.item_id);
        let height = self.frame_height();
        let known_width = self.width;
        let entity = cx.entity().downgrade();
        let has_view = self.surface.read(cx).has_view();
        let prefers_border = self
            .document
            .as_ref()
            .and_then(Document::mcp)
            .is_some_and(|app| app.prefers_border);

        // Measures the card's width, which sizes an HTML page's frame and an app's context.
        let measure = canvas(
            move |bounds, _window, cx| {
                let width = f32::from(bounds.size.width);
                if (width - known_width).abs() >= 0.5
                    && let Some(card) = entity.upgrade()
                {
                    cx.defer(move |cx| {
                        card.update(cx, |card, cx| card.set_width(width, cx));
                    });
                }
                bounds
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full();

        let centered = |text: String| {
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .px(px(12.0))
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(text)
        };
        let tile_bg = hsla(tokens.shell_tile);
        let tile_border = hsla(tokens.shell_tile_border);

        let overlay = match &self.state {
            DocState::Ready => None,
            DocState::Minting | DocState::Loading => {
                has_view.then(|| centered("Loading…".to_owned()).into_any_element())
            }
            DocState::Stopped(message) => Some(centered(message.clone()).into_any_element()),
            DocState::Failed(message) => Some(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .flex_col()
                    .gap(px(10.0))
                    .items_center()
                    .justify_center()
                    .bg(page_bg)
                    .child(
                        div()
                            .text_size(px(UI_TEXT_PX))
                            .line_height(px(UI_LINE_HEIGHT_PX))
                            .text_color(muted)
                            .child(message.clone()),
                    )
                    .when(self.document.is_some(), |el| {
                        el.child(
                            pill_button(
                                format!("{ax}.retry"),
                                "Retry",
                                tile_bg,
                                tile_border,
                                foreground,
                            )
                            .on_click(cx.listener(|this, _, _, cx| this.retry(cx))),
                        )
                    })
                    .into_any_element(),
            ),
            DocState::Closed => Some(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_between()
                    .px(px(12.0))
                    .bg(page_bg)
                    .child(
                        div()
                            .text_size(px(UI_TEXT_PX))
                            .line_height(px(UI_LINE_HEIGHT_PX))
                            .text_color(muted)
                            .child(format!("The {} app was closed", self.server_name())),
                    )
                    .child(
                        pill_button(
                            format!("{ax}.reopen"),
                            "Show app",
                            tile_bg,
                            tile_border,
                            foreground,
                        )
                        .on_click(cx.listener(|this, _, _, cx| this.reopen(cx))),
                    )
                    .into_any_element(),
            ),
        };

        let confirmation = self.confirmations.front().map(|pending| {
            let mut panel = div()
                .id(format!("{ax}.confirm"))
                .a11y_group(format!("{ax}.confirm"), pending.title.clone())
                .occlude()
                .absolute()
                .left_0()
                .right_0()
                .bottom_0()
                .flex()
                .flex_col()
                .gap(px(8.0))
                .p(px(12.0))
                .bg(hsla(tokens.popover.with_alpha(1.0)))
                .border_t_1()
                .border_color(hsla(tokens.border))
                .child(
                    div()
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(foreground)
                        .child(pending.title.clone()),
                );
            if !pending.detail.is_empty() {
                panel = panel.child(
                    div()
                        .max_h(px(120.0))
                        .overflow_hidden()
                        .text_size(px(12.0))
                        .line_height(px(16.0))
                        .text_color(muted)
                        .child(pending.detail.clone()),
                );
            }
            panel.child(
                div()
                    .flex()
                    .gap(px(8.0))
                    .child(
                        pill_button(
                            format!("{ax}.confirm.decline"),
                            "Decline",
                            tile_bg,
                            tile_border,
                            foreground,
                        )
                        .on_click(
                            cx.listener(|this, _, _, cx| this.answer_confirmation(false, cx)),
                        ),
                    )
                    .child(
                        pill_button(
                            format!("{ax}.confirm.allow"),
                            "Allow",
                            hsla(tokens.primary),
                            hsla(tokens.primary),
                            hsla(tokens.primary_foreground),
                        )
                        .on_click(cx.listener(|this, _, _, cx| this.answer_confirmation(true, cx))),
                    ),
            )
        });

        let body = div()
            .relative()
            .w_full()
            .h(px(height))
            .overflow_hidden()
            .rounded(px(CARD_BODY_RADIUS_PX))
            .bg(page_bg)
            .when(prefers_border, |el| {
                el.border_1().border_color(hsla(tokens.shell_divider))
            })
            .child(measure)
            .child(div().absolute().inset_0().child(self.surface.clone()))
            .children(overlay)
            .children(confirmation);
        card_shell(colors)
            .id(ax.clone())
            .a11y_group(ax, format!("{kind}: {title}"))
            .child(
                card_header(false)
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(icons::icon(glyph, CARD_ICON_PX, muted))
                    .child(kind),
            )
            .child(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        std::env::temp_dir().join(format!("conn-embedded-document-{tag}-{nanos}"))
    }

    #[test]
    fn downloads_never_overwrite_and_keep_extensions() {
        let dir = temp_dir("downloads");
        let first = save_download_in(&dir, "report.csv", b"a");
        let second = save_download_in(&dir, "report.csv", b"b");
        let dotted = save_download_in(&dir, "..", b"c");
        assert_eq!(
            first
                .as_deref()
                .ok()
                .and_then(Path::file_name)
                .and_then(|n| n.to_str()),
            Some("report.csv"),
            "first keeps its name"
        );
        assert_eq!(
            second
                .as_deref()
                .ok()
                .and_then(Path::file_name)
                .and_then(|n| n.to_str()),
            Some("report (1).csv"),
            "second gets a number before the extension"
        );
        assert_eq!(
            dotted
                .as_deref()
                .ok()
                .and_then(Path::file_name)
                .and_then(|n| n.to_str()),
            Some("download"),
            "a dot-only name is replaced"
        );
        assert_eq!(
            std::fs::read(dir.join("report.csv")).ok(),
            Some(b"a".to_vec()),
            "the first file is untouched",
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn host_page_holds_one_sandboxable_frame_and_the_prefix() {
        let page = document_page("__CONN_DOC_abc__:");
        assert!(
            page.contains("\"__CONN_DOC_abc__:\""),
            "the prefix is a JSON string"
        );
        assert!(page.matches("<iframe").count() == 1, "one frame");
        assert!(
            !page.contains("http://") && !page.contains("https://"),
            "the page holds no URL",
        );
        assert!(
            page.contains(&format!("json.length > {MAX_MESSAGE_BYTES}")),
            "the size cap"
        );
    }

    #[test]
    fn document_reads_by_kind() {
        let facts = |is_mcp: bool, document: Value| EmbeddedDocumentFacts {
            thread_id: "t".into(),
            item_id: "i".into(),
            title: "T".into(),
            document,
            is_mcp,
            tool_input: None,
            tool_result: None,
        };
        let html = Document::read(&facts(
            false,
            json!({ "attachmentId": "a", "title": "Page", "height": 300 }),
        ));
        assert!(
            matches!(html, Some(Document::Html(_))),
            "html metadata reads as html"
        );
        let mcp = Document::read(&facts(
            true,
            json!({ "attachmentId": "a", "server": "s", "tool": "t", "resourceUri": "ui://x" }),
        ));
        assert!(
            matches!(mcp, Some(Document::Mcp(_))),
            "mcp metadata reads as an app"
        );
        assert!(
            Document::read(&facts(
                true,
                json!({ "attachmentId": "a", "title": "Page", "height": 300 })
            ))
            .is_none(),
            "html metadata is not an app",
        );
    }

    #[test]
    fn confirmation_detail_is_cut() {
        let long = json!({ "text": "x".repeat(2000) });
        assert!(
            pretty(&long).chars().count() <= MAX_CONFIRMATION_DETAIL_CHARS + 1,
            "cut"
        );
        assert_eq!(pretty(&json!({})), "{}", "short values stay whole");
    }
}
