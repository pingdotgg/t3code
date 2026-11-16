//! Thread MCP App callbacks on the existing environment connection.
use super::{Deps, orchestration::engine_unary};
use crate::table::MethodTable;
use conn_contract::{
    McpAppCallToolInput, McpAppCallToolResult, McpAppReadResourceInput, McpAppReadResourceResult,
    McpAppRequestError, McpAppToolInfo, McpAppToolInfoInput, McpAppUpdateModelContextInput,
};

pub(super) fn register(table: &mut MethodTable, deps: &Deps) {
    if let Some(engine) = &deps.engine {
        engine_unary::<McpAppCallToolInput, McpAppCallToolResult, McpAppRequestError>(
            table,
            engine,
            "mcpApps.callTool",
        );
        engine_unary::<McpAppToolInfoInput, McpAppToolInfo, McpAppRequestError>(
            table,
            engine,
            "mcpApps.toolInfo",
        );
        engine_unary::<McpAppReadResourceInput, McpAppReadResourceResult, McpAppRequestError>(
            table,
            engine,
            "mcpApps.readResource",
        );
        engine_unary::<McpAppUpdateModelContextInput, (), McpAppRequestError>(
            table,
            engine,
            "mcpApps.updateModelContext",
        );
    }
}
