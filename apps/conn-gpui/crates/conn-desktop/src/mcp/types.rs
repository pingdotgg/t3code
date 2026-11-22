//! The MCP panel's IPC shapes, field for field as Conn's `apps/desktop/src/ipc/methods/mcp.ts`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The longest stdio command Conn accepts.
pub const MAX_COMMAND_CHARS: usize = 4_096;
/// The longest server URL Conn accepts.
pub const MAX_URL_CHARS: usize = 16_384;

/// One HTTP header sent to an `http` or `sse` server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpHeader {
    pub name: String,
    pub value: String,
}

/// How the desktop reaches a server (Conn's `DesktopMcpServer`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "transport", rename_all = "lowercase")]
pub enum McpServer {
    /// A local process that speaks JSON-RPC over stdin and stdout.
    Stdio {
        command: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
        /// The folder the command runs in; `None` or blank for the home folder.
        cwd: Option<String>,
    },
    /// Streamable HTTP.
    Http {
        url: String,
        headers: Vec<McpHeader>,
    },
    /// The legacy HTTP+SSE transport.
    Sse {
        url: String,
        headers: Vec<McpHeader>,
    },
}

/// What a server offers, as booleans.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpCapabilities {
    pub tools: bool,
    pub resources: bool,
    pub prompts: bool,
    pub logging: bool,
}

/// The server's answer to `initialize` (Conn's `DesktopMcpServerInfo`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub name: String,
    pub title: Option<String>,
    pub version: String,
    pub protocol_version: Option<String>,
    pub instructions: Option<String>,
    pub capabilities: McpCapabilities,
}

/// `connect` input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectRequest {
    pub session_id: String,
    pub server: McpServer,
}

/// `connect` output: `error` or `info`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectResponse {
    pub error: Option<String>,
    pub info: Option<McpServerInfo>,
    pub duration_ms: f64,
}

/// The methods the panel may call (Conn's `DesktopMcpMethod`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum McpMethod {
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "tools/list")]
    ToolsList,
    #[serde(rename = "tools/call")]
    ToolsCall,
    #[serde(rename = "resources/list")]
    ResourcesList,
    #[serde(rename = "resources/templates/list")]
    ResourceTemplatesList,
    #[serde(rename = "resources/read")]
    ResourcesRead,
    #[serde(rename = "prompts/list")]
    PromptsList,
    #[serde(rename = "prompts/get")]
    PromptsGet,
}

impl McpMethod {
    /// Every allowed method.
    pub const ALL: [Self; 8] = [
        Self::Ping,
        Self::ToolsList,
        Self::ToolsCall,
        Self::ResourcesList,
        Self::ResourceTemplatesList,
        Self::ResourcesRead,
        Self::PromptsList,
        Self::PromptsGet,
    ];

    /// The JSON-RPC method name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ping => "ping",
            Self::ToolsList => "tools/list",
            Self::ToolsCall => "tools/call",
            Self::ResourcesList => "resources/list",
            Self::ResourceTemplatesList => "resources/templates/list",
            Self::ResourcesRead => "resources/read",
            Self::PromptsList => "prompts/list",
            Self::PromptsGet => "prompts/get",
        }
    }

    /// The method for a JSON-RPC name, if the panel may call it.
    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|method| method.as_str() == name)
    }

    /// The result key a list method pages through.
    pub(crate) fn list_key(self) -> Option<&'static str> {
        match self {
            Self::ToolsList => Some("tools"),
            Self::ResourcesList => Some("resources"),
            Self::ResourceTemplatesList => Some("resourceTemplates"),
            Self::PromptsList => Some("prompts"),
            _ => None,
        }
    }
}

/// `request` input.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRequest {
    pub session_id: String,
    pub method: McpMethod,
    pub params: Value,
}

/// `request` output: `error` or `result` (Conn's `DesktopMcpResponse`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResponse {
    pub error: Option<String>,
    pub result: Value,
    pub duration_ms: f64,
}

impl McpResponse {
    /// A failed response.
    pub fn failed(error: impl Into<String>, duration_ms: f64) -> Self {
        Self {
            error: Some(error.into()),
            result: Value::Null,
            duration_ms,
        }
    }
}

/// What happened on a session, for the panel's Log tab (Conn's `DesktopMcpEvent`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEvent {
    pub session_id: String,
    /// Milliseconds since the Unix epoch.
    pub at: u64,
    #[serde(flatten)]
    pub kind: McpEventKind,
}

/// The event's kind and payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum McpEventKind {
    /// A JSON-RPC message the desktop sent (out).
    Send { message: Value },
    /// A JSON-RPC message the server sent (in).
    Receive { message: Value },
    /// Output on the server's stderr (stdio only), as read.
    Stderr { text: String },
    /// The server ended the session.
    Closed,
}

impl McpEventKind {
    /// Conn's kind string: `send`, `receive`, `stderr`, or `closed`.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Send { .. } => "send",
            Self::Receive { .. } => "receive",
            Self::Stderr { .. } => "stderr",
            Self::Closed => "closed",
        }
    }

    /// The JSON-RPC message, for `send` and `receive`.
    pub fn message(&self) -> Option<&Value> {
        match self {
            Self::Send { message } | Self::Receive { message } => Some(message),
            _ => None,
        }
    }

    /// The stderr text.
    pub fn text(&self) -> Option<&str> {
        match self {
            Self::Stderr { text } => Some(text),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn serializes_like_conn() {
        let server: McpServer = serde_json::from_value(json!({
            "transport": "stdio", "command": "npx", "args": ["-y", "x"], "env": {}, "cwd": null
        }))
        .unwrap_or_else(|error| panic!("decode: {error}"));
        assert!(matches!(server, McpServer::Stdio { .. }), "stdio decodes");
        let event = McpEvent {
            session_id: "s".into(),
            at: 1,
            kind: McpEventKind::Stderr { text: "hi".into() },
        };
        assert_eq!(
            serde_json::to_value(&event).ok(),
            Some(json!({"sessionId": "s", "at": 1, "kind": "stderr", "text": "hi"})),
            "event shape"
        );
        assert_eq!(
            serde_json::to_value(McpMethod::ResourceTemplatesList).ok(),
            Some(json!("resources/templates/list")),
            "method name"
        );
        assert_eq!(
            McpMethod::parse("tools/call"),
            Some(McpMethod::ToolsCall),
            "parse"
        );
        assert_eq!(
            McpMethod::parse("sampling/createMessage"),
            None,
            "not allowed"
        );
    }
}
