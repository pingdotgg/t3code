//! The wire half of an embedded document, with no GPUI and no I/O.
//!
//! This ports, from the web client:
//! - `packages/shared/src/mcpApp.ts` (references, sandbox attributes, height limits),
//! - `packages/shared/src/htmlRender.ts` (references, frame height, page messages, theme),
//! - `packages/client-runtime/src/mcpApps/host.ts` (the MCP Apps JSON-RPC host).
//!
//! [`McpHost`] is sans-IO: it turns each message the app posts into [`Effect`]s, and the card
//! performs them (post to the page, call the server, ask the user) and reports back.

use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

use conn_theme::{Appearance, Rgba, Tokens};
use serde_json::{Map, Value, json};

pub(super) const MCP_APP_PROTOCOL_VERSION: &str = "2026-01-26";
/// Frame URL query parameter carrying the host's color scheme before `ui/initialize`.
pub(super) const MCP_APP_COLOR_SCHEME_PARAM: &str = "t3-color-scheme";
pub(super) const MCP_APP_DEFAULT_HEIGHT: f32 = 320.0;
const MCP_APP_MIN_HEIGHT: f32 = 80.0;
pub(super) const MCP_APP_MAX_HEIGHT: f32 = 2000.0;
pub(super) const HTML_RENDER_COLUMN_WIDTH: f32 = 728.0;
const HTML_RENDER_MIN_HEIGHT: f32 = 80.0;
const HTML_RENDER_MAX_HEIGHT: f32 = 2000.0;
const HTML_RENDER_MAX_FIT_HEIGHT: f32 = 20_000.0;
const HTML_RENDER_MAX_TITLE_LENGTH: usize = 200;
const MAX_MEASURED_HEIGHTS: usize = 24;
const MAX_DOMAINS: usize = 32;
const MAX_DOMAIN_LENGTH: usize = 256;
const MAX_NAME_LENGTH: usize = 256;
const MAX_RESOURCE_URI_LENGTH: usize = 4096;
/// The largest message the app may post (and the largest the host page forwards).
pub(super) const MAX_MESSAGE_BYTES: usize = 256 * 1024;
const MAX_PENDING_REQUESTS: usize = 16;
const MAX_DOWNLOAD_NAME: usize = 200;
/// How long the host waits for the app's answer to `ui/resource-teardown`.
pub(super) const TEARDOWN_TIMEOUT: Duration = Duration::from_secs(2);

// -- References ---------------------------------------------------------------------------------

/// What `t3McpApp` output metadata says about an app (`readMcpAppReference`).
#[derive(Clone, Debug, PartialEq)]
pub(super) struct McpAppReference {
    pub(super) attachment_id: String,
    pub(super) server: String,
    pub(super) tool: String,
    pub(super) csp: Option<Value>,
    pub(super) permissions: Option<Value>,
    pub(super) prefers_border: bool,
}

fn bounded_name(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    (!text.trim().is_empty() && text.chars().count() <= MAX_NAME_LENGTH).then(|| text.to_owned())
}

/// `^(?:https?|wss?)://(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$`, case-insensitive.
fn valid_domain(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let Some(rest) = ["https://", "http://", "wss://", "ws://"]
        .iter()
        .find_map(|prefix| lower.strip_prefix(*prefix))
    else {
        return false;
    };
    let rest = rest.strip_prefix("*.").unwrap_or(rest);
    let (host, port) = match rest.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (rest, None),
    };
    if let Some(port) = port
        && (port.is_empty() || port.len() > 5 || !port.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return false;
    }
    !host.is_empty()
        && host.split('.').all(|label| {
            !label.is_empty()
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

fn read_domains(value: Option<&Value>) -> Option<Vec<Value>> {
    let domains: Vec<Value> = value?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .filter(|domain| domain.len() <= MAX_DOMAIN_LENGTH && valid_domain(domain))
        .take(MAX_DOMAINS)
        .map(|domain| Value::String(domain.to_owned()))
        .collect();
    (!domains.is_empty()).then_some(domains)
}

fn read_csp(value: Option<&Value>) -> Option<Value> {
    let object = value?.as_object()?;
    let mut csp = Map::new();
    for key in [
        "connectDomains",
        "resourceDomains",
        "frameDomains",
        "baseUriDomains",
    ] {
        if let Some(domains) = read_domains(object.get(key)) {
            csp.insert(key.to_owned(), Value::Array(domains));
        }
    }
    (!csp.is_empty()).then_some(Value::Object(csp))
}

const PERMISSION_KEYS: [&str; 4] = ["camera", "microphone", "geolocation", "clipboardWrite"];

fn read_permissions(value: Option<&Value>) -> Option<Value> {
    let object = value?.as_object()?;
    let mut permissions = Map::new();
    for key in PERMISSION_KEYS {
        if object.get(key).is_some_and(Value::is_object) {
            permissions.insert(key.to_owned(), json!({}));
        }
    }
    (!permissions.is_empty()).then_some(Value::Object(permissions))
}

impl McpAppReference {
    pub(super) fn read(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let attachment_id = bounded_name(object.get("attachmentId"))?;
        let server = bounded_name(object.get("server"))?;
        let tool = bounded_name(object.get("tool"))?;
        // The app's resource must be a `ui://` URI; the host never needs it again.
        object
            .get("resourceUri")
            .and_then(Value::as_str)
            .filter(|uri| uri.len() <= MAX_RESOURCE_URI_LENGTH && uri.starts_with("ui://"))?;
        Some(Self {
            attachment_id,
            server,
            tool,
            csp: read_csp(object.get("csp")),
            permissions: read_permissions(object.get("permissions")),
            prefers_border: object
                .get("prefersBorder")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }

    /// The frame's `allow` attribute (`mcpAppAllowAttribute`).
    pub(super) fn allow_attribute(&self) -> String {
        let Some(permissions) = self.permissions.as_ref().and_then(Value::as_object) else {
            return String::new();
        };
        let mut features = Vec::new();
        for (key, feature) in [
            ("camera", "camera"),
            ("microphone", "microphone"),
            ("geolocation", "geolocation"),
            ("clipboardWrite", "clipboard-write"),
        ] {
            if permissions.contains_key(key) {
                features.push(feature);
            }
        }
        features.join("; ")
    }
}

/// What `htmlRender` output metadata says about a page (`readHtmlRenderReference`).
#[derive(Clone, Debug, PartialEq)]
pub(super) struct HtmlRenderReference {
    pub(super) attachment_id: String,
    pub(super) title: String,
    pub(super) height: f32,
    /// `(width, height)` pairs the server measured, sorted by width.
    pub(super) heights: Option<Vec<(f32, f32)>>,
}

pub(super) fn clamp_html_render_height(height: f64) -> f32 {
    height.round().clamp(
        f64::from(HTML_RENDER_MIN_HEIGHT),
        f64::from(HTML_RENDER_MAX_HEIGHT),
    ) as f32
}

fn read_measured_heights(value: Option<&Value>) -> Option<Vec<(f32, f32)>> {
    let entries = value?.as_array()?;
    if entries.is_empty() || entries.len() > MAX_MEASURED_HEIGHTS {
        return None;
    }
    let mut heights = Vec::with_capacity(entries.len());
    for entry in entries {
        let pair = entry.as_array().filter(|pair| pair.len() == 2)?;
        let width = pair[0]
            .as_u64()
            .filter(|width| (1..=10_000).contains(width))?;
        let height = pair[1].as_f64().filter(|height| height.is_finite())?;
        heights.push((width as f32, clamp_html_render_height(height)));
    }
    heights.sort_by(|left, right| left.0.total_cmp(&right.0));
    Some(heights)
}

impl HtmlRenderReference {
    pub(super) fn read(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let attachment_id = object
            .get("attachmentId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.chars().count() <= MAX_NAME_LENGTH)?
            .to_owned();
        let title = object.get("title").and_then(Value::as_str)?;
        let height = object
            .get("height")
            .and_then(Value::as_f64)
            .filter(|height| height.is_finite())?;
        let title: String = title
            .trim()
            .chars()
            .take(HTML_RENDER_MAX_TITLE_LENGTH)
            .collect();
        Some(Self {
            attachment_id,
            title: if title.is_empty() {
                "HTML".to_owned()
            } else {
                title
            },
            height: clamp_html_render_height(height),
            heights: read_measured_heights(object.get("heights")),
        })
    }

    /// `htmlRenderFrameHeight`: a measured live page wins; otherwise the server's measurements
    /// for `width`, capped at the agent's height when its column measurement exceeds it.
    pub(super) fn frame_height(&self, width: f32, content_height: Option<f32>) -> f32 {
        if let Some(content) = content_height {
            return content
                .ceil()
                .clamp(HTML_RENDER_MIN_HEIGHT, HTML_RENDER_MAX_FIT_HEIGHT);
        }
        let Some(heights) = self.heights.as_ref().filter(|heights| !heights.is_empty()) else {
            return self.height;
        };
        let cap = if measured_height(heights, HTML_RENDER_COLUMN_WIDTH) > self.height {
            self.height
        } else {
            HTML_RENDER_MAX_HEIGHT
        };
        clamp_html_render_height(f64::from(cap.min(measured_height(heights, width))))
    }
}

/// The taller neighbouring measurement, because breakpoints can select either height.
fn measured_height(heights: &[(f32, f32)], width: f32) -> f32 {
    let last = heights.len().saturating_sub(1);
    let high = heights
        .iter()
        .position(|(measured_width, _)| *measured_width >= width)
        .unwrap_or(last);
    let low = if (heights[high].0 - width).abs() < f32::EPSILON {
        high
    } else {
        high.saturating_sub(1)
    };
    heights[low].1.max(heights[high].1)
}

pub(super) fn clamp_mcp_height(height: f64) -> f32 {
    if !height.is_finite() {
        return MCP_APP_DEFAULT_HEIGHT;
    }
    height
        .clamp(f64::from(MCP_APP_MIN_HEIGHT), f64::from(MCP_APP_MAX_HEIGHT))
        .round() as f32
}

// -- Theme --------------------------------------------------------------------------------------

/// CSS variables the page reads, from the active Conn theme (`htmlRenderTheme`).
#[derive(Clone, Debug, PartialEq)]
pub(super) struct DocumentTheme {
    pub(super) appearance: &'static str,
    pub(super) variables: BTreeMap<String, String>,
}

fn css_color(color: Rgba) -> String {
    let byte = |value: f32| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    if color.a >= 0.999 {
        format!(
            "#{:02x}{:02x}{:02x}",
            byte(color.r),
            byte(color.g),
            byte(color.b)
        )
    } else {
        format!(
            "rgba({}, {}, {}, {:.3})",
            byte(color.r),
            byte(color.g),
            byte(color.b),
            color.a.clamp(0.0, 1.0)
        )
    }
}

const SANS: &str = "-apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, sans-serif";
const MONO: &str =
    "\"SF Mono\", \"SFMono-Regular\", Menlo, Consolas, \"Liberation Mono\", monospace";

impl DocumentTheme {
    pub(super) fn from_tokens(tokens: &Tokens) -> Self {
        let dark = matches!(tokens.appearance, Appearance::Dark);
        // The chat pane's opaque card is the page the document sits on.
        let page = tokens.shell_card.with_alpha(1.0);
        let (success, success_foreground, info, info_foreground, chart) = if dark {
            (
                "#10b981",
                "#34d399",
                "#3b82f6",
                "#60a5fa",
                ["#2dd4bf", "#fbbf24", "#c084fc", "#fb7185", "#a3e635"],
            )
        } else {
            (
                "#10b981",
                "#047857",
                "#3b82f6",
                "#1d4ed8",
                ["#0d9488", "#d97706", "#9333ea", "#e11d48", "#65a30d"],
            )
        };
        let mut variables = BTreeMap::new();
        let mut set = |name: &str, value: String| {
            variables.insert(name.to_owned(), value);
        };
        set("--background", css_color(page));
        set("--foreground", css_color(tokens.foreground));
        set("--muted", css_color(tokens.muted));
        set("--muted-foreground", css_color(tokens.muted_foreground));
        set("--card", css_color(tokens.card));
        set("--card-foreground", css_color(tokens.card_foreground));
        set("--popover", css_color(tokens.popover));
        set("--popover-foreground", css_color(tokens.popover_foreground));
        set("--secondary", css_color(tokens.secondary));
        set(
            "--secondary-foreground",
            css_color(tokens.secondary_foreground),
        );
        set("--border", css_color(tokens.border));
        set("--input", css_color(tokens.input));
        set("--ring", css_color(tokens.ring));
        set("--primary", css_color(tokens.primary));
        set("--primary-foreground", css_color(tokens.primary_foreground));
        set("--accent", css_color(tokens.accent));
        set("--accent-foreground", css_color(tokens.accent_foreground));
        set(
            "--accent-surface",
            css_color(tokens.accent.with_alpha(if dark { 0.16 } else { 0.1 })),
        );
        set("--accent-surface-foreground", css_color(tokens.accent));
        set("--destructive", css_color(tokens.destructive));
        set(
            "--destructive-foreground",
            css_color(tokens.destructive_foreground),
        );
        set(
            "--destructive-surface",
            css_color(tokens.destructive.with_alpha(if dark { 0.16 } else { 0.1 })),
        );
        set("--warning", css_color(tokens.warning));
        set("--warning-foreground", css_color(tokens.warning_foreground));
        set(
            "--warning-surface",
            css_color(tokens.warning.with_alpha(if dark { 0.16 } else { 0.1 })),
        );
        set("--success", success.to_owned());
        set("--success-foreground", success_foreground.to_owned());
        set("--info", info.to_owned());
        set("--info-foreground", info_foreground.to_owned());
        set("--code-background", css_color(tokens.code_background));
        set("--code-foreground", css_color(tokens.code_foreground));
        set("--chart-1", css_color(tokens.accent));
        for (index, color) in chart.iter().enumerate() {
            set(&format!("--chart-{}", index + 2), (*color).to_owned());
        }
        set("--radius", "0.625rem".to_owned());
        set("--font-sans", SANS.to_owned());
        set("--font-mono", MONO.to_owned());
        Self {
            appearance: if dark { "dark" } else { "light" },
            variables,
        }
    }

    pub(super) fn to_json(&self) -> Value {
        json!({ "appearance": self.appearance, "variables": self.variables })
    }

    /// `htmlRenderThemeMessage`: what a plain HTML page reads to restyle itself.
    pub(super) fn host_context_changed(&self) -> Value {
        json!({
            "jsonrpc": "2.0",
            "method": "ui/notifications/host-context-changed",
            "params": { "theme": self.appearance, "styles": { "variables": self.variables } },
        })
    }

    /// `mcpAppStyleVariables`: the spec's variable names, from this theme.
    pub(super) fn mcp_style_variables(&self) -> Value {
        let pairs = [
            ("--color-background-primary", "--background"),
            ("--color-background-secondary", "--card"),
            ("--color-background-tertiary", "--muted"),
            ("--color-background-inverse", "--foreground"),
            ("--color-background-info", "--info"),
            ("--color-background-danger", "--destructive-surface"),
            ("--color-background-warning", "--warning-surface"),
            ("--color-text-primary", "--foreground"),
            ("--color-text-secondary", "--muted-foreground"),
            ("--color-text-tertiary", "--muted-foreground"),
            ("--color-text-inverse", "--background"),
            ("--color-text-info", "--info-foreground"),
            ("--color-text-danger", "--destructive-foreground"),
            ("--color-text-success", "--success-foreground"),
            ("--color-text-warning", "--warning-foreground"),
            ("--color-border-primary", "--border"),
            ("--color-border-secondary", "--input"),
            ("--color-border-danger", "--destructive"),
            ("--color-ring-primary", "--ring"),
            ("--font-sans", "--font-sans"),
            ("--font-mono", "--font-mono"),
            ("--border-radius-md", "--radius"),
        ];
        let mut variables = Map::new();
        for (name, source) in pairs {
            if let Some(value) = self.variables.get(source).filter(|value| !value.is_empty()) {
                variables.insert(name.to_owned(), Value::String(value.clone()));
            }
        }
        Value::Object(variables)
    }
}

/// `encodeURIComponent`.
pub(super) fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The signed URL for a plain HTML page, with the theme and scroll-containment fragment the
/// page's bootstrap reads (`HtmlRenderDocument`). The URL is a secret: never log it.
pub(super) fn html_document_src(url: &url::Url, theme: &DocumentTheme) -> String {
    let mut url = url.clone();
    url.set_fragment(None);
    format!(
        "{url}#t3-theme={}&t3-contain-scroll",
        encode_uri_component(&theme.to_json().to_string())
    )
}

/// The signed URL for an MCP app, with the initial color scheme the app paints before
/// `ui/initialize`. The URL is a secret: never log it.
pub(super) fn mcp_document_src(url: &url::Url, theme: &DocumentTheme) -> String {
    let mut url = url.clone();
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| key != MCP_APP_COLOR_SCHEME_PARAM)
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    url.query_pairs_mut()
        .clear()
        .extend_pairs(kept)
        .append_pair(MCP_APP_COLOR_SCHEME_PARAM, theme.appearance);
    url.to_string()
}

// -- Plain HTML pages ---------------------------------------------------------------------------

/// What a plain HTML page may ask of its host.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum HtmlGuestMessage {
    ContentHeight(f32),
    OpenLink { id: Value, url: String },
}

fn is_http_url(url: &str) -> bool {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

pub(super) fn read_html_guest_message(data: &Value) -> Option<HtmlGuestMessage> {
    let object = data.as_object()?;
    if object.get("jsonrpc")?.as_str()? != "2.0" {
        return None;
    }
    let params = object.get("params").and_then(Value::as_object);
    match object.get("method")?.as_str()? {
        "ui/notifications/size-changed" => {
            let height = params?.get("height")?.as_f64()?;
            (height.is_finite() && height > 0.0)
                .then_some(HtmlGuestMessage::ContentHeight(height as f32))
        }
        "ui/open-link" => {
            let id = object.get("id").filter(|id| is_id(id))?.clone();
            let url = params?.get("url")?.as_str()?;
            is_http_url(url).then(|| HtmlGuestMessage::OpenLink {
                id,
                url: url.to_owned(),
            })
        }
        _ => None,
    }
}

pub(super) fn empty_result(id: &Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": {} })
}

// -- MCP Apps host ------------------------------------------------------------------------------

fn is_id(value: &Value) -> bool {
    value.is_string() || value.as_f64().is_some_and(f64::is_finite)
}

fn id_key(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// A file the app asks the host to save (`ui/download-file`).
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Download {
    Embedded {
        name: String,
        mime_type: String,
        bytes: Vec<u8>,
    },
    Link {
        name: String,
        uri: String,
        mime_type: Option<String>,
    },
}

impl Download {
    pub(super) fn name(&self) -> &str {
        match self {
            Self::Embedded { name, .. } | Self::Link { name, .. } => name,
        }
    }
}

/// A request from the app that the host answers asynchronously.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum GuestCall {
    ToolsCall {
        name: String,
        arguments: Map<String, Value>,
    },
    ResourcesRead {
        uri: String,
    },
    OpenLink {
        url: String,
    },
    Message {
        text: String,
    },
    DisplayMode {
        mode: String,
    },
    UpdateModelContext {
        content: Option<Vec<Value>>,
        structured_content: Option<Map<String, Value>>,
    },
    DownloadFile {
        files: Vec<Download>,
    },
}

/// What the card does next.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Effect {
    /// Post to the app's window.
    Post(Value),
    /// Run `call`, then report with [`McpHost::finish`] using `id`.
    Call {
        id: Value,
        call: GuestCall,
    },
    SizeChanged {
        height: Option<f64>,
    },
    RequestTeardown,
    /// The app answered `ui/resource-teardown`.
    TeardownAnswered,
}

/// The tool call that produced the app: its input, and its result once it ends.
#[derive(Clone, Debug, PartialEq)]
struct ToolCall {
    arguments: Value,
    result: Option<Value>,
}

/// One app session (`makeMcpAppHost`). Replaced whenever the document reloads.
#[derive(Debug)]
pub(super) struct McpHost {
    sandbox: Value,
    host_version: String,
    initialized: bool,
    disposed: bool,
    tool_call: Option<ToolCall>,
    tool_call_sent: bool,
    pending: usize,
    sent_context: Option<Value>,
    app_display_modes: Option<Vec<String>>,
    next_host_request_id: u64,
    host_requests: HashSet<String>,
}

fn is_content_block(block: &Value) -> bool {
    let Some(object) = block.as_object() else {
        return false;
    };
    let Some(kind) = object.get("type").and_then(Value::as_str) else {
        return false;
    };
    let strings = |fields: &[&str]| {
        fields
            .iter()
            .all(|field| object.get(*field).is_some_and(Value::is_string))
    };
    match kind {
        "resource" => object
            .get("resource")
            .and_then(Value::as_object)
            .is_some_and(|resource| {
                resource.get("uri").is_some_and(Value::is_string)
                    && (resource.get("text").is_some_and(Value::is_string)
                        || resource.get("blob").is_some_and(Value::is_string))
            }),
        "text" => strings(&["text"]),
        "image" | "audio" => strings(&["data", "mimeType"]),
        "resource_link" => strings(&["uri", "name"]),
        _ => false,
    }
}

/// `normalizeMcpAppToolResult`: the app's SDK rejects a whole message over one field it does not
/// accept (a null for an absent field, or a content block MCP does not define).
pub(super) fn normalize_tool_result(result: &Value) -> Value {
    let content: Vec<Value> = result
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| is_content_block(block))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let mut normalized = Map::new();
    normalized.insert("content".to_owned(), Value::Array(content));
    if let Some(structured) = result.get("structuredContent").filter(|v| v.is_object()) {
        normalized.insert("structuredContent".to_owned(), structured.clone());
    }
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        normalized.insert("isError".to_owned(), Value::Bool(true));
    }
    if let Some(meta) = result.get("_meta").filter(|v| v.is_object()) {
        normalized.insert("_meta".to_owned(), meta.clone());
    }
    Value::Object(normalized)
}

fn notification(method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "method": method, "params": params })
}

fn failure(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn success(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

impl McpHost {
    pub(super) fn new(app: &McpAppReference, host_version: &str) -> Self {
        let mut sandbox = Map::new();
        if let Some(csp) = &app.csp {
            sandbox.insert("csp".to_owned(), csp.clone());
        }
        if let Some(permissions) = &app.permissions {
            sandbox.insert("permissions".to_owned(), permissions.clone());
        }
        Self {
            sandbox: Value::Object(sandbox),
            host_version: host_version.to_owned(),
            initialized: false,
            disposed: false,
            tool_call: None,
            tool_call_sent: false,
            pending: 0,
            sent_context: None,
            app_display_modes: None,
            next_host_request_id: 0,
            host_requests: HashSet::new(),
        }
    }

    pub(super) fn dispose(&mut self) {
        self.disposed = true;
    }

    fn post(&self, out: &mut Vec<Effect>, message: Value) {
        if !self.disposed {
            out.push(Effect::Post(message));
        }
    }

    fn send_tool_call(&mut self, out: &mut Vec<Effect>) {
        if !self.initialized || self.tool_call_sent {
            return;
        }
        let Some(call) = self.tool_call.clone() else {
            return;
        };
        self.tool_call_sent = true;
        let arguments = if call.arguments.is_object() {
            call.arguments
        } else {
            json!({})
        };
        self.post(
            out,
            notification(
                "ui/notifications/tool-input",
                json!({ "arguments": arguments }),
            ),
        );
        if let Some(result) = &call.result {
            self.post(
                out,
                notification(
                    "ui/notifications/tool-result",
                    normalize_tool_result(result),
                ),
            );
        }
    }

    /// Hands the app the tool call that produced it. A running call has no result yet; only its
    /// completion may replace it, and an app that already has the input gets just the result.
    pub(super) fn set_tool_call(&mut self, arguments: Value, result: Option<Value>) -> Vec<Effect> {
        let mut out = Vec::new();
        let call = ToolCall { arguments, result };
        if self.tool_call.is_none() || !self.tool_call_sent {
            if self
                .tool_call
                .as_ref()
                .is_none_or(|existing| existing.result.is_none())
            {
                self.tool_call = Some(call);
            }
            self.send_tool_call(&mut out);
            return out;
        }
        let Some(existing) = self.tool_call.as_mut() else {
            return out;
        };
        if existing.result.is_some() {
            return out;
        }
        let Some(result) = call.result else {
            return out;
        };
        existing.result = Some(result.clone());
        self.post(
            &mut out,
            notification(
                "ui/notifications/tool-result",
                normalize_tool_result(&result),
            ),
        );
        out
    }

    /// Sends what changed in the host context since the last send. The spec forbids messages
    /// before the app finishes initializing; it reads the then-current context from the
    /// `ui/initialize` response anyway.
    pub(super) fn update_host_context(&mut self, next: &Value) -> Vec<Effect> {
        let mut out = Vec::new();
        let (Some(sent), Some(next_object)) = (
            self.sent_context.as_ref().and_then(Value::as_object),
            next.as_object(),
        ) else {
            return out;
        };
        if !self.initialized {
            return out;
        }
        let mut changes = Map::new();
        for (key, value) in next_object {
            if sent.get(key) != Some(value) {
                changes.insert(key.clone(), value.clone());
            }
        }
        self.sent_context = Some(next.clone());
        if !changes.is_empty() {
            self.post(
                &mut out,
                notification(
                    "ui/notifications/host-context-changed",
                    Value::Object(changes),
                ),
            );
        }
        out
    }

    /// Asks the app to wrap up (`ui/resource-teardown`). Returns the effects, and whether an
    /// answer is awaited: the card then calls [`Self::dispose`] after [`TEARDOWN_TIMEOUT`] if
    /// [`Effect::TeardownAnswered`] has not come. Before initialization the app has nothing to
    /// save and may not be listening, so the host just disposes.
    pub(super) fn teardown(&mut self) -> (Vec<Effect>, bool) {
        let mut out = Vec::new();
        if self.disposed || !self.initialized {
            self.disposed = true;
            return (out, false);
        }
        let id = format!("conn-host-{}", self.next_host_request_id);
        self.next_host_request_id += 1;
        self.host_requests.insert(id.clone());
        self.post(
            &mut out,
            json!({ "jsonrpc": "2.0", "id": id, "method": "ui/resource-teardown", "params": {} }),
        );
        (out, true)
    }

    /// Reports how a [`Effect::Call`] ended.
    pub(super) fn finish(&mut self, id: &Value, outcome: Result<Value, String>) -> Vec<Effect> {
        self.pending = self.pending.saturating_sub(1);
        let mut out = Vec::new();
        match outcome {
            Ok(result) => self.post(&mut out, success(id, result)),
            Err(message) => self.post(&mut out, failure(id, -32000, &message)),
        }
        out
    }

    /// Answers a request the host page dropped for its size (`id` as the page saw it).
    pub(super) fn refuse_oversized(&self, id: &Value) -> Vec<Effect> {
        let mut out = Vec::new();
        if is_id(id) {
            self.post(&mut out, failure(id, -32600, "Message too large."));
        }
        out
    }

    fn answer(&mut self, out: &mut Vec<Effect>, id: &Value, call: GuestCall) {
        if self.pending >= MAX_PENDING_REQUESTS {
            self.post(out, failure(id, -32000, "Too many requests in flight."));
            return;
        }
        self.pending += 1;
        out.push(Effect::Call {
            id: id.clone(),
            call,
        });
    }

    /// Handles one message the app posted. The caller has already checked that it came from the
    /// app's own window. `context` is the current host context.
    pub(super) fn receive(&mut self, data: &Value, context: &Value) -> Vec<Effect> {
        let mut out = Vec::new();
        let Some(object) = data.as_object() else {
            return out;
        };
        if self.disposed || object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return out;
        }
        let id = object.get("id").filter(|id| is_id(id));
        let method = object.get("method").and_then(Value::as_str);
        let request_id = id.filter(|_| method.is_some());
        let too_large =
            serde_json::to_vec(data).map_or(true, |bytes| bytes.len() > MAX_MESSAGE_BYTES);
        if too_large {
            if let Some(id) = request_id {
                self.post(&mut out, failure(id, -32600, "Message too large."));
            }
            return out;
        }
        let Some(method) = method else {
            if let Some(id) = id
                && (object.contains_key("result") || object.contains_key("error"))
                && self.host_requests.remove(&id_key(id))
            {
                self.disposed = true;
                out.push(Effect::TeardownAnswered);
            }
            return out;
        };
        let empty = Map::new();
        let params = object
            .get("params")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        match id {
            Some(id) => self.handle_request(&mut out, id, method, params, context),
            None => self.handle_notification(&mut out, method, params, context),
        }
        out
    }

    fn handle_request(
        &mut self,
        out: &mut Vec<Effect>,
        id: &Value,
        method: &str,
        params: &Map<String, Value>,
        context: &Value,
    ) {
        match method {
            "ui/initialize" => {
                self.app_display_modes = params
                    .get("appCapabilities")
                    .and_then(Value::as_object)
                    .and_then(|capabilities| capabilities.get("availableDisplayModes"))
                    .and_then(Value::as_array)
                    .map(|modes| {
                        modes
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    });
                self.sent_context = Some(context.clone());
                self.post(
                    out,
                    success(
                        id,
                        json!({
                            "protocolVersion": MCP_APP_PROTOCOL_VERSION,
                            "hostInfo": { "name": "conn-gpui", "version": self.host_version },
                            "hostCapabilities": {
                                "openLinks": {},
                                "serverTools": {},
                                "serverResources": {},
                                "logging": {},
                                "message": { "text": {} },
                                "updateModelContext": { "text": {}, "structuredContent": {} },
                                "downloadFile": {},
                                "sandbox": self.sandbox,
                            },
                            "hostContext": context,
                        }),
                    ),
                );
            }
            "ping" => self.post(out, success(id, json!({}))),
            "tools/call" => {
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.trim().is_empty());
                let arguments = match params.get("arguments") {
                    None => Some(Map::new()),
                    Some(Value::Object(arguments)) => Some(arguments.clone()),
                    Some(_) => None,
                };
                match (name, arguments) {
                    (Some(name), Some(arguments)) => self.answer(
                        out,
                        id,
                        GuestCall::ToolsCall {
                            name: name.to_owned(),
                            arguments,
                        },
                    ),
                    _ => self.post(
                        out,
                        failure(
                            id,
                            -32602,
                            "tools/call needs a tool name and object arguments.",
                        ),
                    ),
                }
            }
            "resources/read" => {
                match params
                    .get("uri")
                    .and_then(Value::as_str)
                    .filter(|uri| !uri.trim().is_empty())
                {
                    Some(uri) => self.answer(
                        out,
                        id,
                        GuestCall::ResourcesRead {
                            uri: uri.to_owned(),
                        },
                    ),
                    None => self.post(out, failure(id, -32602, "resources/read needs a uri.")),
                }
            }
            "ui/open-link" => match params
                .get("url")
                .and_then(Value::as_str)
                .filter(|url| is_http_url(url))
            {
                Some(url) => self.answer(
                    out,
                    id,
                    GuestCall::OpenLink {
                        url: url.to_owned(),
                    },
                ),
                None => self.post(
                    out,
                    failure(id, -32602, "Only http(s) links can be opened."),
                ),
            },
            "ui/message" => self.handle_message(out, id, params),
            "ui/request-display-mode" => {
                let current = context
                    .get("displayMode")
                    .and_then(Value::as_str)
                    .unwrap_or("inline")
                    .to_owned();
                let mode = params.get("mode").and_then(Value::as_str);
                // A mode the host lacks, or the app did not declare, leaves the current one.
                let allowed = mode.is_some_and(|mode| {
                    context
                        .get("availableDisplayModes")
                        .and_then(Value::as_array)
                        .is_some_and(|modes| modes.iter().any(|m| m.as_str() == Some(mode)))
                        && self
                            .app_display_modes
                            .as_ref()
                            .is_none_or(|modes| modes.iter().any(|m| m == mode))
                });
                match mode {
                    Some(mode) if allowed && mode != current => self.answer(
                        out,
                        id,
                        GuestCall::DisplayMode {
                            mode: mode.to_owned(),
                        },
                    ),
                    _ => self.post(out, success(id, json!({ "mode": current }))),
                }
            }
            "ui/update-model-context" => {
                let content = params.get("content");
                let structured = params.get("structuredContent");
                let content_ok = content.is_none_or(Value::is_array);
                let structured_ok = structured.is_none_or(Value::is_object);
                if !content_ok || !structured_ok {
                    self.post(
                        out,
                        failure(
                            id,
                            -32602,
                            "Model context needs content blocks or an object of structured content.",
                        ),
                    );
                    return;
                }
                self.answer(
                    out,
                    id,
                    GuestCall::UpdateModelContext {
                        content: content.and_then(Value::as_array).cloned(),
                        structured_content: structured.and_then(Value::as_object).cloned(),
                    },
                );
            }
            "ui/download-file" => match read_downloads(params.get("contents")) {
                Some(files) => self.answer(out, id, GuestCall::DownloadFile { files }),
                None => self.post(
                    out,
                    failure(
                        id,
                        -32602,
                        "ui/download-file needs embedded resources or resource links.",
                    ),
                ),
            },
            other => self.post(
                out,
                failure(id, -32601, &format!("Method not found: {other}")),
            ),
        }
    }

    fn handle_message(&mut self, out: &mut Vec<Effect>, id: &Value, params: &Map<String, Value>) {
        // The SDK sends an array of content blocks; the spec text shows one block.
        let blocks: Vec<&Value> = match params.get("content") {
            Some(Value::Array(blocks)) => blocks.iter().collect(),
            Some(block) => vec![block],
            None => Vec::new(),
        };
        let texts: Vec<Option<&str>> = blocks
            .iter()
            .map(|block| {
                let object = block.as_object()?;
                (object.get("type").and_then(Value::as_str) == Some("text"))
                    .then(|| object.get("text").and_then(Value::as_str))
                    .flatten()
            })
            .collect();
        if params.get("role").and_then(Value::as_str) != Some("user")
            || texts.is_empty()
            || texts.iter().any(Option::is_none)
        {
            self.post(
                out,
                failure(
                    id,
                    -32602,
                    "Only text messages from the user role are supported.",
                ),
            );
            return;
        }
        let text = texts.into_iter().flatten().collect::<Vec<_>>().join("\n");
        let text = text.trim();
        if text.is_empty() {
            self.post(out, failure(id, -32602, "ui/message needs non-empty text."));
            return;
        }
        self.answer(
            out,
            id,
            GuestCall::Message {
                text: text.to_owned(),
            },
        );
    }

    fn handle_notification(
        &mut self,
        out: &mut Vec<Effect>,
        method: &str,
        params: &Map<String, Value>,
        context: &Value,
    ) {
        match method {
            "ui/notifications/initialized" => {
                if self.initialized {
                    return;
                }
                self.initialized = true;
                self.send_tool_call(out);
                out.extend(self.update_host_context(context));
            }
            "ui/notifications/size-changed" => {
                let number = |key: &str| params.get(key).and_then(Value::as_f64);
                let (width, height) = (number("width"), number("height"));
                if width.is_some() || height.is_some() {
                    out.push(Effect::SizeChanged { height });
                }
            }
            "ui/notifications/request-teardown" => out.push(Effect::RequestTeardown),
            _ => {}
        }
    }
}

/// The tool call stored on a turn item (`orchestration.getTurnItem`): its input, and its result
/// once it ended, as `McpAppFrame` reads them from `useTurnItemDetail`.
pub(super) fn read_turn_item_tool_call(response: &Value) -> Option<(Value, Option<Value>)> {
    let item = response.get("item")?;
    if item.get("type")?.as_str()? != "dynamic_tool" {
        return None;
    }
    let input = item.get("input").cloned().unwrap_or_else(|| json!({}));
    let result = item
        .get("output")
        .and_then(|output| output.get("result"))
        .filter(|result| !result.is_null())
        .cloned();
    Some((input, result))
}

/// The user-facing reason inside an `McpAppRequestError`, wherever the server nested it.
pub(super) fn request_error_message(error: &Value) -> Option<&'static str> {
    fn find(value: &Value, depth: usize) -> Option<&str> {
        if depth > 6 {
            return None;
        }
        match value {
            Value::Object(map) => map
                .get("reason")
                .and_then(Value::as_str)
                .or_else(|| map.values().find_map(|inner| find(inner, depth + 1))),
            Value::Array(items) => items.iter().find_map(|inner| find(inner, depth + 1)),
            _ => None,
        }
    }
    match find(error, 0)? {
        "not-an-app" => Some("This tool call has no MCP app."),
        "provider-unsupported" => Some("This thread's provider cannot run MCP app requests."),
        "session-stopped" => Some(
            "The app's thread is not running. Send a message in the thread that created it to use the app again.",
        ),
        "tool-not-callable" => Some("This app cannot call that tool."),
        "unsupported-content" => Some("Only text and structured content are supported."),
        "request-failed" => Some("The app's MCP server request failed."),
        _ => None,
    }
}

// -- Downloads ----------------------------------------------------------------------------------

/// Strict standard-alphabet base64 (`Base64.decode`).
pub(super) fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let value = |byte: u8| -> Option<u32> {
        match byte {
            b'A'..=b'Z' => Some(u32::from(byte - b'A')),
            b'a'..=b'z' => Some(u32::from(byte - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(byte - b'0') + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (index, chunk) in bytes.chunks(4).enumerate() {
        let last = (index + 1) * 4 == bytes.len();
        let padding = chunk.iter().rev().take_while(|byte| **byte == b'=').count();
        if padding > 2 || (padding > 0 && !last) {
            return None;
        }
        let mut acc = 0_u32;
        for byte in &chunk[..4 - padding] {
            acc = (acc << 6) | value(*byte)?;
        }
        acc <<= 6 * padding as u32;
        let triple = acc.to_be_bytes();
        out.extend_from_slice(&triple[1..4 - padding]);
    }
    Some(out)
}

fn resource_bytes(content: &Map<String, Value>) -> Option<Vec<u8>> {
    if let Some(text) = content.get("text").and_then(Value::as_str) {
        return Some(text.as_bytes().to_vec());
    }
    decode_base64(content.get("blob").and_then(Value::as_str)?)
}

/// `mcpResourceBytes` for a `resources/read` content entry.
pub(super) fn mcp_resource_bytes(content: &Value) -> Option<Vec<u8>> {
    resource_bytes(content.as_object()?)
}

fn download_name(uri: Option<&str>, name: Option<&str>) -> String {
    let raw = match (name.filter(|name| !name.trim().is_empty()), uri) {
        (Some(name), _) => name.to_owned(),
        (None, Some(uri)) => uri
            .split(['?', '#'])
            .next()
            .and_then(|path| path.rsplit('/').find(|part| !part.is_empty()))
            .unwrap_or("download")
            .to_owned(),
        (None, None) => "download".to_owned(),
    };
    let mut safe = String::new();
    let mut units = 0;
    for ch in raw.chars() {
        let next = if "\\/:*?\"<>|".contains(ch) || u32::from(ch) < 32 {
            '-'
        } else {
            ch
        };
        units += next.len_utf16();
        if units > MAX_DOWNLOAD_NAME {
            break;
        }
        safe.push(next);
    }
    if safe.is_empty() {
        "download".to_owned()
    } else {
        safe
    }
}

fn read_downloads(contents: Option<&Value>) -> Option<Vec<Download>> {
    let entries = contents?.as_array().filter(|entries| !entries.is_empty())?;
    let mut files = Vec::with_capacity(entries.len());
    for entry in entries {
        let entry = entry.as_object()?;
        match entry.get("type").and_then(Value::as_str)? {
            "resource" => {
                let resource = entry.get("resource")?.as_object()?;
                let bytes = resource_bytes(resource)?;
                files.push(Download::Embedded {
                    name: download_name(
                        resource.get("uri").and_then(Value::as_str),
                        resource.get("name").and_then(Value::as_str),
                    ),
                    mime_type: resource
                        .get("mimeType")
                        .and_then(Value::as_str)
                        .unwrap_or("application/octet-stream")
                        .to_owned(),
                    bytes,
                });
            }
            "resource_link" => {
                let uri = entry.get("uri")?.as_str()?;
                files.push(Download::Link {
                    name: download_name(Some(uri), entry.get("name").and_then(Value::as_str)),
                    uri: uri.to_owned(),
                    mime_type: entry
                        .get("mimeType")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                });
            }
            _ => return None,
        }
    }
    Some(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app() -> McpAppReference {
        McpAppReference {
            attachment_id: "att".into(),
            server: "srv".into(),
            tool: "tool".into(),
            csp: None,
            permissions: None,
            prefers_border: false,
        }
    }

    fn context() -> Value {
        json!({
            "theme": "dark",
            "displayMode": "inline",
            "availableDisplayModes": ["inline"],
        })
    }

    fn request(id: u32, method: &str, params: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    }

    fn initialized(host: &mut McpHost) -> Vec<Effect> {
        let first = host.receive(
            &request(1, "ui/initialize", json!({ "protocolVersion": "x" })),
            &context(),
        );
        assert_eq!(first.len(), 1, "initialize answers once");
        host.receive(
            &json!({ "jsonrpc": "2.0", "method": "ui/notifications/initialized" }),
            &context(),
        )
    }

    #[test]
    fn reads_mcp_reference_and_drops_bad_domains() {
        let reference = McpAppReference::read(&json!({
            "attachmentId": "a",
            "server": "s",
            "tool": "t",
            "resourceUri": "ui://r",
            "csp": { "connectDomains": ["https://ok.example.com", "ftp://no", "https://*.ok.dev:8080"] },
            "permissions": { "camera": {}, "microphone": "yes" },
            "prefersBorder": true,
        }));
        let Some(reference) = reference else {
            panic!("a valid reference should read");
        };
        assert_eq!(
            reference.csp,
            Some(json!({ "connectDomains": ["https://ok.example.com", "https://*.ok.dev:8080"] })),
            "only well-formed origins stay",
        );
        assert_eq!(reference.allow_attribute(), "camera", "only objects grant");
        assert!(reference.prefers_border, "prefersBorder is kept");
        assert!(
            McpAppReference::read(&json!({
                "attachmentId": "a", "server": "s", "tool": "t", "resourceUri": "https://x"
            }))
            .is_none(),
            "a non ui:// resource is refused",
        );
    }

    #[test]
    fn html_reference_height_follows_measurements() {
        let Some(reference) = HtmlRenderReference::read(&json!({
            "attachmentId": "a",
            "title": "  ",
            "height": 500,
            "heights": [[728, 400], [320, 900]],
        })) else {
            panic!("a valid reference should read");
        };
        assert_eq!(reference.title, "HTML", "an empty title falls back");
        assert_eq!(
            reference.heights,
            Some(vec![(320.0, 900.0), (728.0, 400.0)]),
            "heights sort by width",
        );
        assert_eq!(reference.frame_height(728.0, None), 400.0, "column width");
        assert_eq!(
            reference.frame_height(320.0, None),
            900.0,
            "narrow is taller"
        );
        assert_eq!(
            reference.frame_height(728.0, Some(1234.2)),
            1235.0,
            "live page wins"
        );
        let capped = HtmlRenderReference {
            height: 300.0,
            ..reference
        };
        assert_eq!(
            capped.frame_height(320.0, None),
            300.0,
            "the agent's height caps when the column measures taller",
        );
    }

    #[test]
    fn tool_call_is_sent_once_after_initialization() {
        let mut host = McpHost::new(&app(), "1");
        assert!(
            host.set_tool_call(json!({ "a": 1 }), None).is_empty(),
            "nothing goes out before the app initializes",
        );
        let effects = initialized(&mut host);
        assert_eq!(effects.len(), 1, "input only while the call runs");
        let later = host.set_tool_call(
            json!({ "a": 1 }),
            Some(json!({ "content": [{ "type": "text", "text": "hi" }, { "type": "bogus" }], "_meta": null })),
        );
        assert_eq!(
            later,
            vec![Effect::Post(notification(
                "ui/notifications/tool-result",
                json!({ "content": [{ "type": "text", "text": "hi" }] }),
            ))],
            "the result follows alone, normalized",
        );
        assert!(
            host.set_tool_call(json!({}), Some(json!({ "content": [] })))
                .is_empty(),
            "a second result is ignored",
        );
    }

    #[test]
    fn tools_call_runs_and_answers() {
        let mut host = McpHost::new(&app(), "1");
        let effects = host.receive(
            &request(
                7,
                "tools/call",
                json!({ "name": "go", "arguments": { "x": 1 } }),
            ),
            &context(),
        );
        let [Effect::Call { id, call }] = effects.as_slice() else {
            panic!("tools/call should become a call: {effects:?}");
        };
        assert_eq!(id, &json!(7), "the call keeps the request id");
        assert!(
            matches!(call, GuestCall::ToolsCall { name, .. } if name == "go"),
            "tool name"
        );
        let done = host.finish(id, Err("nope".into()));
        assert_eq!(
            done,
            vec![Effect::Post(failure(&json!(7), -32000, "nope"))],
            "a failure answers with -32000",
        );
        let bad = host.receive(
            &request(8, "tools/call", json!({ "arguments": [] })),
            &context(),
        );
        assert_eq!(
            bad,
            vec![Effect::Post(failure(
                &json!(8),
                -32602,
                "tools/call needs a tool name and object arguments."
            ))],
            "a bad call fails at once",
        );
    }

    #[test]
    fn requests_beyond_the_limit_are_refused() {
        let mut host = McpHost::new(&app(), "1");
        for index in 0..MAX_PENDING_REQUESTS {
            let effects = host.receive(
                &request(index as u32, "resources/read", json!({ "uri": "ui://a" })),
                &context(),
            );
            assert!(
                matches!(effects.as_slice(), [Effect::Call { .. }]),
                "within the limit"
            );
        }
        let effects = host.receive(
            &request(99, "resources/read", json!({ "uri": "ui://a" })),
            &context(),
        );
        assert_eq!(
            effects,
            vec![Effect::Post(failure(
                &json!(99),
                -32000,
                "Too many requests in flight."
            ))],
            "the 17th request is refused",
        );
    }

    #[test]
    fn display_mode_outside_the_available_set_keeps_current() {
        let mut host = McpHost::new(&app(), "1");
        let effects = host.receive(
            &request(
                2,
                "ui/request-display-mode",
                json!({ "mode": "fullscreen" }),
            ),
            &context(),
        );
        assert_eq!(
            effects,
            vec![Effect::Post(success(
                &json!(2),
                json!({ "mode": "inline" })
            ))],
            "fullscreen is not offered",
        );
    }

    #[test]
    fn message_needs_user_text() {
        let mut host = McpHost::new(&app(), "1");
        let ok = host.receive(
            &request(
                3,
                "ui/message",
                json!({ "role": "user", "content": [{ "type": "text", "text": " hello " }] }),
            ),
            &context(),
        );
        assert!(
            matches!(ok.as_slice(), [Effect::Call { call: GuestCall::Message { text }, .. }] if text == "hello"),
            "the text is trimmed: {ok:?}",
        );
        let bad = host.receive(
            &request(
                4,
                "ui/message",
                json!({ "role": "assistant", "content": [] }),
            ),
            &context(),
        );
        assert!(
            matches!(bad.as_slice(), [Effect::Post(_)]),
            "the wrong role is refused"
        );
    }

    #[test]
    fn host_context_sends_only_changes() {
        let mut host = McpHost::new(&app(), "1");
        initialized(&mut host);
        let mut next = context();
        next["theme"] = json!("light");
        let effects = host.update_host_context(&next);
        assert_eq!(
            effects,
            vec![Effect::Post(notification(
                "ui/notifications/host-context-changed",
                json!({ "theme": "light" }),
            ))],
            "one key changed",
        );
        assert!(
            host.update_host_context(&next).is_empty(),
            "no change, no message"
        );
    }

    #[test]
    fn teardown_waits_for_the_answer() {
        let mut host = McpHost::new(&app(), "1");
        let (effects, waits) = host.teardown();
        assert!(
            effects.is_empty() && !waits,
            "an uninitialized app is just disposed"
        );

        let mut host = McpHost::new(&app(), "1");
        initialized(&mut host);
        let (effects, waits) = host.teardown();
        assert!(waits, "an initialized app is asked first");
        let [Effect::Post(message)] = effects.as_slice() else {
            panic!("teardown posts one request: {effects:?}");
        };
        let id = message["id"].clone();
        let answered = host.receive(
            &json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
            &context(),
        );
        assert_eq!(
            answered,
            vec![Effect::TeardownAnswered],
            "the answer ends it"
        );
        assert!(
            host.receive(&request(9, "ping", json!({})), &context())
                .is_empty(),
            "the host is silent after the answer",
        );
    }

    #[test]
    fn oversized_request_is_refused() {
        let mut host = McpHost::new(&app(), "1");
        let big = "x".repeat(MAX_MESSAGE_BYTES + 1);
        let effects = host.receive(&request(5, "ping", json!({ "pad": big })), &context());
        assert_eq!(
            effects,
            vec![Effect::Post(failure(
                &json!(5),
                -32600,
                "Message too large."
            ))],
            "a large message fails with -32600",
        );
    }

    #[test]
    fn downloads_read_both_kinds() {
        let files = read_downloads(Some(&json!([
            { "type": "resource", "resource": { "uri": "file:///a/b?c.txt", "text": "hi", "mimeType": "text/plain" } },
            { "type": "resource_link", "uri": "ui://r/x.csv", "name": "a/b.csv" },
        ])));
        let Some(files) = files else {
            panic!("downloads should read");
        };
        assert_eq!(
            files[0].name(),
            "b",
            "the name comes from the path before the query"
        );
        assert!(
            matches!(&files[0], Download::Embedded { bytes, .. } if bytes == b"hi"),
            "embedded text is bytes",
        );
        assert_eq!(files[1].name(), "a-b.csv", "path characters are replaced");
        assert!(
            read_downloads(Some(&json!([]))).is_none(),
            "an empty list is refused"
        );
    }

    #[test]
    fn turn_item_gives_input_and_result() {
        let response = json!({
            "item": {
                "type": "dynamic_tool",
                "input": { "q": 1 },
                "output": { "result": { "content": [] } },
            }
        });
        assert_eq!(
            read_turn_item_tool_call(&response),
            Some((json!({ "q": 1 }), Some(json!({ "content": [] })))),
            "a finished call has both",
        );
        let running = json!({ "item": { "type": "dynamic_tool", "input": {}, "output": null } });
        assert_eq!(
            read_turn_item_tool_call(&running),
            Some((json!({}), None)),
            "a running call has no result",
        );
        assert_eq!(
            read_turn_item_tool_call(&json!({ "item": { "type": "message" } })),
            None,
            "other items are not tool calls",
        );
        assert_eq!(
            read_turn_item_tool_call(&json!({ "item": null })),
            None,
            "a missing item"
        );
    }

    #[test]
    fn request_errors_map_to_the_web_messages() {
        let error = json!({ "_tag": "McpAppRequestError", "reason": "tool-not-callable" });
        assert_eq!(
            request_error_message(&json!({ "error": { "cause": error } })),
            Some("This app cannot call that tool."),
            "the reason is found when nested",
        );
        assert_eq!(
            request_error_message(&json!({ "reason": "other" })),
            None,
            "unknown reason"
        );
    }

    #[test]
    fn oversized_requests_get_an_error_by_id() {
        let host = McpHost::new(&app(), "1");
        assert_eq!(
            host.refuse_oversized(&json!(3)),
            vec![Effect::Post(failure(
                &json!(3),
                -32600,
                "Message too large."
            ))],
            "the page's drop is answered",
        );
        assert!(
            host.refuse_oversized(&Value::Null).is_empty(),
            "a notification needs no answer"
        );
    }

    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(decode_base64("aGVsbG8="), Some(b"hello".to_vec()), "padded");
        assert_eq!(decode_base64("aGk="), Some(b"hi".to_vec()), "one pad");
        assert_eq!(decode_base64("YWJj"), Some(b"abc".to_vec()), "no pad");
        assert_eq!(decode_base64("a"), None, "short input");
        assert_eq!(decode_base64("a$bc"), None, "bad character");
    }

    #[test]
    fn html_guest_messages_are_narrow() {
        assert_eq!(
            read_html_guest_message(&json!({
                "jsonrpc": "2.0", "method": "ui/notifications/size-changed", "params": { "height": 321.5 }
            })),
            Some(HtmlGuestMessage::ContentHeight(321.5)),
            "height",
        );
        assert_eq!(
            read_html_guest_message(&json!({
                "jsonrpc": "2.0", "id": 4, "method": "ui/open-link", "params": { "url": "javascript:alert(1)" }
            })),
            None,
            "only http(s) links",
        );
        assert!(
            matches!(
                read_html_guest_message(&json!({
                    "jsonrpc": "2.0", "id": "a", "method": "ui/open-link", "params": { "url": "HTTPS://x.dev" }
                })),
                Some(HtmlGuestMessage::OpenLink { .. })
            ),
            "scheme case does not matter",
        );
    }

    #[test]
    fn document_urls_carry_theme_without_dropping_the_signature() {
        let theme = DocumentTheme {
            appearance: "dark",
            variables: BTreeMap::from([("--a".to_owned(), "#fff".to_owned())]),
        };
        let Ok(url) = url::Url::parse("http://h/doc?sig=abc&exp=1#old") else {
            panic!("test url parses");
        };
        let mcp = mcp_document_src(&url, &theme);
        assert!(
            mcp.contains("sig=abc")
                && mcp.contains("exp=1")
                && mcp.contains("t3-color-scheme=dark"),
            "the query keeps its parameters: {mcp}",
        );
        let html = html_document_src(&url, &theme);
        assert!(
            html.starts_with("http://h/doc?sig=abc&exp=1#t3-theme=%7B")
                && html.ends_with("&t3-contain-scroll"),
            "the fragment replaces the old one: {html}",
        );
    }
}
