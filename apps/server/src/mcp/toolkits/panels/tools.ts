import {
  AgentPanelUnavailableError,
  DatabaseQueryToolInput,
  DatabaseQueryToolResult,
  McpCallToolInput,
  McpCallToolResult,
  McpConnectToolInput,
  McpConnectToolResult,
  OrchestratorMcpFailure,
  PanelOpenToolInput,
  PanelOpenToolResult,
  PreviewAutomationError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Manager from "../../../preview/Manager.ts";
import * as AgentPanelBroker from "../../../panels/AgentPanelBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const PanelOpenTool = Tool.make("panel_open", {
  description: [
    "Show a panel to the user in the Conn desktop app on their Mac, for this thread, from any server: browser, database, mcp, diff or files. Use it to show the user your work running.",
    "browser with url opens a desktop tab there; then every preview_* tool without a tabId drives that tab, including request_credentials and fill_credential to sign in.",
    "Fails when no Conn desktop is connected to this server. Never falls back to a hidden browser.",
  ].join(" "),
  parameters: PanelOpenToolInput,
  success: PanelOpenToolResult,
  failure: Schema.Union([
    AgentPanelUnavailableError,
    OrchestratorMcpFailure,
    PreviewAutomationError,
  ]),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerConfig.ServerConfig,
    AgentPanelBroker.AgentPanelBroker,
    Manager.PreviewManager,
    PreviewAutomationBroker.PreviewAutomationBroker,
  ],
})
  .annotate(Tool.Title, "Open panel")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const actionDependencies = () => [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  AgentPanelBroker.AgentPanelBroker,
];

const DatabaseQueryTool = Tool.make("database_query", {
  description: [
    "Run a read-only SQL query in the Conn desktop's Database panel on the user's Mac, for this thread, and show the user the rows there.",
    "Returns the columns, the row count and the first 20 rows. Use it when the user asks to see data.",
  ].join(" "),
  parameters: DatabaseQueryToolInput,
  success: DatabaseQueryToolResult,
  failure: Schema.Union([AgentPanelUnavailableError, OrchestratorMcpFailure]),
  dependencies: actionDependencies(),
})
  .annotate(Tool.Title, "Query database in panel")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const McpConnectTool = Tool.make("mcp_connect", {
  description: [
    "Set up an MCP server in the Conn desktop's MCP panel on the user's Mac, for this thread, and connect to it, so the user sees its tools.",
    "Pass url (HTTP or SSE) or command (stdio), plus headers for auth. A server with the same name, or else the same url or command, is updated. Returns the server's tools.",
  ].join(" "),
  parameters: McpConnectToolInput,
  success: McpConnectToolResult,
  failure: Schema.Union([AgentPanelUnavailableError, OrchestratorMcpFailure]),
  dependencies: actionDependencies(),
})
  .annotate(Tool.Title, "Connect MCP server in panel")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const McpCallTool = Tool.make("mcp_call", {
  description: [
    "Call a tool of an MCP server in the Conn desktop's MCP panel on the user's Mac, for this thread: the panel selects the tool, fills its form with the arguments and shows the result.",
    "Use it to show the user an MCP tool working, for example while you build one. Reconnect with mcp_connect after you change the server, so the panel lists your changes.",
  ].join(" "),
  parameters: McpCallToolInput,
  success: McpCallToolResult,
  failure: Schema.Union([AgentPanelUnavailableError, OrchestratorMcpFailure]),
  dependencies: actionDependencies(),
})
  .annotate(Tool.Title, "Call MCP tool in panel")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const PanelsToolkit = Toolkit.make(
  PanelOpenTool,
  DatabaseQueryTool,
  McpConnectTool,
  McpCallTool,
);
