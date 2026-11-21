import {
  OrchestratorMcpFailure,
  PluginInvokeInput,
  PluginInvokeResult,
  PluginListInput,
  PluginReloadInput,
  PluginSetEnabledInput,
  PluginSnapshot,
  PluginAuthoringGuideInput,
  PluginAuthoringGuide,
  PluginRegistryListInput,
  PluginRegistrySnapshot,
  PluginRegistryInstallInput,
  PluginRegistryInstallResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Plugins from "../../../plugins/PluginService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";

const WRITE_ACCESS = "Live full-access or default caller thread, or full-access client, only.";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Plugins.PluginService,
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};

export const PluginsToolkit = Toolkit.make(
  Tool.make("plugins_authoring_guide", {
    ...shared,
    description:
      "Read before creating a plugin or changing T3 Code itself. Returns this environment's plugin directory, UI and service APIs, composition rules and live service keys. Pass `topic` and your plugin `id` for starter files.",
    parameters: PluginAuthoringGuideInput,
    success: PluginAuthoringGuide,
  }).annotate(Tool.Readonly, true),
  Tool.make("plugins_registry_list", {
    ...shared,
    description:
      "Search this host's reviewed plugin catalog. `plugins_list` shows installed plugins.",
    parameters: PluginRegistryListInput,
    success: PluginRegistrySnapshot,
  }).annotate(Tool.Readonly, true),
  Tool.make("plugins_registry_install", {
    ...shared,
    description: `Install a reviewed catalog plugin if its source tree matches the pinned fingerprint. It stays disabled until enabled. ${WRITE_ACCESS}`,
    parameters: PluginRegistryInstallInput,
    success: PluginRegistryInstallResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("plugins_list", {
    ...shared,
    description: "List installed builtin and local plugins with reload errors and entry paths.",
    parameters: PluginListInput,
    success: PluginSnapshot,
  }).annotate(Tool.Readonly, true),
  Tool.make("plugins_set_enabled", {
    ...shared,
    description: `Enable or disable a local plugin. Enabling runs its code with this server's privileges. ${WRITE_ACCESS}`,
    parameters: PluginSetEnabledInput,
    success: PluginSnapshot,
  }).annotate(Tool.Destructive, true),
  Tool.make("plugins_reload", {
    ...shared,
    description: `Reload one or all plugins from disk. A broken edit keeps the last working generation. ${WRITE_ACCESS}`,
    parameters: PluginReloadInput,
    success: PluginSnapshot,
  }).annotate(Tool.Destructive, true),
  Tool.make("plugins_invoke", {
    ...shared,
    description: `Run a command an enabled server plugin registered. The plugin validates its arguments. ${WRITE_ACCESS}`,
    parameters: PluginInvokeInput,
    success: PluginInvokeResult,
  }).annotate(Tool.Destructive, true),
);
