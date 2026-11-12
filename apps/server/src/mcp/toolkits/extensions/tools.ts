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
      "Patch settings; omitted keys stay. Get keys, types and values from extensions_list first.",
    parameters: Schema.Struct({
      ...ExtensionSettingsInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: Schema.Array(ExtensionInfo),
  }),
  Tool.make("extensions_development", {
    ...shared,
    description:
      "For developing, debugging, packaging or testing T3 extensions: load the skill and its guide paths.",
    parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
    success: Schema.Struct({
      path: Schema.String,
      content: Schema.String,
      referencePath: Schema.String,
    }),
  }).annotate(Tool.Readonly, true),
  Tool.make("extensions_list", {
    ...shared,
    description: "List extensions and command/tool schemas; invoke only running entries.",
    parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
    success: Schema.Array(ExtensionInfo),
  }).annotate(Tool.Readonly, true),
  Tool.make("extensions_invoke", {
    ...shared,
    description:
      "Run a command/tool on its server; use id, kind, name and input from extensions_list.",
    parameters: Schema.Struct({
      ...ExtensionInvokeInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: Schema.Unknown,
  }),
  Tool.make("extensions_install", {
    ...shared,
    description:
      "Install a user-requested trusted server folder (absolute path) or npm package, with full host access.",
    parameters: Schema.Struct({
      ...ExtensionInstallInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: Schema.Array(ExtensionInfo),
  }),
  Tool.make("extensions_manage", {
    ...shared,
    description:
      "Enable, disable, reload, update or uninstall. Uninstall keeps local source and stored data.",
    parameters: Schema.Struct({
      ...ExtensionManageInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: Schema.Array(ExtensionInfo),
  }),
);
