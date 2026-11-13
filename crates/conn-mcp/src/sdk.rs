//! The same tools over the official Rust SDK's Streamable HTTP transport (`rmcp`), for the
//! comparison in README.md. The route puts the authenticated [`Caller`] into the request
//! extensions; rmcp hands the request parts to each call.

use std::sync::Arc;

use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
    },
    service::RequestContext,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};
use serde_json::{Map, Value, json};

use crate::{Caller, McpService, catalog, tools};

#[derive(Clone)]
pub struct Handler {
    service: Arc<McpService>,
}

impl ServerHandler for Handler {
    fn get_info(&self) -> ServerConfig {
        let mut info = ServerConfig::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.server_info.name = "T3 Code".into();
        info.server_info.version = self.service.config.server_version.clone();
        info
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let tools: Vec<Tool> = catalog::lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let caller = context
            .extensions
            .get::<http::request::Parts>()
            .and_then(|parts| parts.extensions.get::<Caller>())
            .cloned()
            .ok_or_else(|| ErrorData::invalid_request("no caller", None))?;
        let name = request.name.as_ref();
        let (tool, order) = catalog::tool(name)
            .ok_or_else(|| ErrorData::invalid_params(format!("Tool '{name}' not found"), None))?;
        let mut arguments: Map<String, Value> = request.arguments.unwrap_or_default();
        catalog::check_arguments(&tool["inputSchema"], &order, &mut arguments).map_err(|p| {
            ErrorData::invalid_params(format!("Invalid parameters for tool '{name}': {p}"), None)
        })?;
        let result = match tools::call(&self.service, &caller, name, arguments).await {
            Ok(value) => CallToolResult::structured(value),
            Err(tools::ToolError::Failure { code, message }) => {
                let failure =
                    json!({"_tag": "OrchestratorMcpFailure", "code": code, "message": message});
                CallToolResult::error(vec![ContentBlock::text(failure.to_string())])
            }
            Err(tools::ToolError::InvalidParams(p)) => {
                return Err(ErrorData::invalid_params(
                    format!("Invalid parameters for tool '{name}': {p}"),
                    None,
                ));
            }
        };
        Ok(CallToolResponse::Complete(result))
    }
}

pub type SdkService = StreamableHttpService<Handler, LocalSessionManager>;

/// A tower service for `/mcp`. JSON replies, sessions, any host (Swamp calls over WireGuard).
pub fn service(service: Arc<McpService>) -> SdkService {
    let config = StreamableHttpServerConfig::default()
        .disable_allowed_hosts()
        .with_json_response(true);
    StreamableHttpService::new(
        move || {
            Ok(Handler {
                service: service.clone(),
            })
        },
        Arc::new(LocalSessionManager::default()),
        config,
    )
}
