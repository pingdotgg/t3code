//! The MCP panel's backend and pure logic.
//!
//! - [`McpSessions`]: Conn's `apps/desktop/src/ipc/methods/mcp.ts`. Connects stdio, Streamable
//!   HTTP, and legacy SSE servers, runs the panel's allowed requests, and streams every
//!   JSON-RPC message, stderr chunk, and close as an [`McpEvent`] for the Log tab.
//! - [`servers`]: Conn's `mcpServers.ts` (drafts, command lines, `.mcp.json`, tool forms,
//!   agent results, URI templates).
//! - [`store`]: Conn's `mcpStore.ts` reducers (saved servers, session state, log).
//! - [`results`]: how a result's blocks and text are read for display.
//!
//! The JSON-RPC client is hand-rolled, so every message in and out can be logged as sent.

mod events;
mod manager;
pub mod results;
mod rpc;
pub mod servers;
mod shell_env;
mod sse;
pub mod store;
mod transport;
mod types;

pub use manager::{
    CALL_TIMEOUT, CONNECT_TIMEOUT, LATEST_PROTOCOL_VERSION, MAX_LIST_PAGES, McpOptions,
    McpSessions, REQUEST_TIMEOUT, SUPPORTED_PROTOCOL_VERSIONS,
};
pub use shell_env::login_shell_environment;
pub use types::{
    MAX_COMMAND_CHARS, MAX_URL_CHARS, McpCapabilities, McpConnectRequest, McpConnectResponse,
    McpEvent, McpEventKind, McpHeader, McpMethod, McpRequest, McpResponse, McpServer,
    McpServerInfo,
};
