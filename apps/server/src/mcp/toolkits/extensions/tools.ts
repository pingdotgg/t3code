import {
  ExtensionInfo,
  ExtensionInstallInput,
  ExtensionInvokeInput,
  ExtensionManageInput,
  ExtensionSettingsInput,
  OrchestratorMcpFailure,
  OrchestratorMcpEnvironmentTarget,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ExtensionService from "../../../extensions/ExtensionService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    ExtensionService.ExtensionService,
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};
export const ExtensionsToolkit = Toolkit.make(
  Tool.make("extensions_settings", {
    ...shared,
    description:
      "Patch named extension settings. Unspecified fields stay unchanged. Read names, types, and current values with extensions_list first.",
    parameters: Schema.Struct({
      ...ExtensionSettingsInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: Schema.Array(ExtensionInfo),
  }),
  Tool.make("extensions_development", {
    ...shared,
    description:
      "Use when creating, modifying, debugging, packaging, or testing a T3 Code extension, its custom UI, tools, commands, hooks, or settings. Loads the bundled t3-extension-development SKILL.md and its server-local path.",
    parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
    success: Schema.Struct({
      path: Schema.String,
      content: Schema.String,
      referencePath: Schema.String,
    }),
  }).annotate(Tool.Readonly, true),
  Tool.make("extensions_list", {
    ...shared,
    description:
      "List host extensions and their command/tool input schemas. Use before invoking an extension tool; only running extensions can be invoked.",
    parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
    success: Schema.Array(ExtensionInfo),
  }).annotate(Tool.Readonly, true),
  Tool.make("extensions_invoke", {
    ...shared,
    description:
      "Run a trusted host extension command or agent tool using its id, kind, name, and input from extensions_list. Runs on the owning server, including for mobile and remote clients.",
    parameters: Schema.Struct({
      ...ExtensionInvokeInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: Schema.Unknown,
  }),
  Tool.make("extensions_install", {
    ...shared,
    description:
      "Install a trusted extension from an absolute local folder on the server or an npm package. This executes code with full host access. Use only when the user asked to install it.",
    parameters: Schema.Struct({
      ...ExtensionInstallInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: Schema.Array(ExtensionInfo),
  }),
  Tool.make("extensions_manage", {
    ...shared,
    description:
      "Enable, disable, reload, update, or uninstall a host extension. Uninstall preserves local source and extension data.",
    parameters: Schema.Struct({
      ...ExtensionManageInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: Schema.Array(ExtensionInfo),
  }),
);
