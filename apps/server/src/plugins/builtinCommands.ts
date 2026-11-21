import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import type { PluginServiceShape } from "./PluginService.ts";
import { isExternalPluginEffect } from "./pluginBoundary.ts";

/** Auth, lifecycle and plugin administration always stay owned by the host. */
const hostOwned = new Set<string>([
  WS_METHODS.serverUpdateServer,
  WS_METHODS.serverUpdateServerWithProgress,
  WS_METHODS.serverCommitDesktopUpdate,
  WS_METHODS.subscribeAuthAccess,
  WS_METHODS.subscribeServerLifecycle,
]);
const builtinRpcPlugins = new Map<string, string>(
  Object.entries(WS_METHODS).flatMap(([key, method]) => {
    if (key.startsWith("plugins") || hostOwned.has(method)) return [];
    if (key.startsWith("canvas")) return [[method, "t3.canvas"]];
    if (key.startsWith("pullRequests")) return [[method, "t3.pull-requests"]];
    if (
      key.startsWith("preview") ||
      key === "subscribePreviewEvents" ||
      key === "subscribeDiscoveredLocalServers"
    )
      return [[method, "t3.preview"]];
    if (
      key.startsWith("provider") ||
      key.startsWith("chatGpt") ||
      key.startsWith("codexAuth") ||
      key.includes("AcpRegistry") ||
      key === "serverRefreshProviders" ||
      key === "serverUpdateProvider"
    )
      return [[method, "t3.providers"]];
    if (key === "serverGetUsageSummary" || key === "serverRefreshUsageRates")
      return [[method, "t3.usage"]];
    if (
      key === "serverGetSettings" ||
      key === "serverUpdateSettings" ||
      key === "serverUpsertKeybinding" ||
      key === "serverRemoveKeybinding" ||
      key.startsWith("scheduledTasks")
    )
      return [[method, "t3.settings"]];
    if (key === "projectsReadFile" || key === "projectsWriteFile" || key === "assetsCreateUrl")
      return [[method, "t3.file-preview"]];
    if (
      key.startsWith("projects") ||
      key.startsWith("projectClone") ||
      key === "filesystemBrowse" ||
      key === "subscribeProjectClones" ||
      key === "worktreeSetupCancel"
    )
      return [[method, "t3.sidebar"]];
    if (
      key.startsWith("vcs") ||
      key.startsWith("git") ||
      key.startsWith("review") ||
      key === "subscribeVcsStatus" ||
      key === "subscribeWorktreeSetup"
    )
      return [[method, "t3.diff"]];
    if (
      key.startsWith("agentSessions") ||
      key.includes("Attachment") ||
      key.startsWith("attachments")
    )
      return [[method, "t3.chat"]];
    if (
      key.startsWith("cloud") ||
      key.startsWith("sourceControl") ||
      key === "serverProbe" ||
      key === "serverGetConfig" ||
      key === "subscribeServerConfig" ||
      key === "serverDiscoverSourceControl"
    )
      return [[method, "t3.connections"]];
    return [[method, "t3.ui"]];
  }),
);
for (const method of Object.values(ORCHESTRATION_V2_WS_METHODS))
  builtinRpcPlugins.set(method, "t3.thread");
builtinRpcPlugins.set(ORCHESTRATION_V2_WS_METHODS.getTurnDiff, "t3.diff");
builtinRpcPlugins.set(ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff, "t3.diff");
builtinRpcPlugins.set(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, "t3.chat");
builtinRpcPlugins.set(ORCHESTRATION_V2_WS_METHODS.launchThread, "t3.chat");

const builtinPluginForRpc = (method: string): string | undefined => builtinRpcPlugins.get(method);

/** Keep existing transport types; extensions wrap the same deferred service calls. */
export function wrapBuiltinHandlers<T extends object>(handlers: T, plugins: PluginServiceShape): T {
  const wrapped = Object.fromEntries(
    Object.entries(handlers).map(([method, handler]) => {
      const pluginId = builtinPluginForRpc(method);
      if (!pluginId || typeof handler !== "function") return [method, handler];
      return [
        method,
        (...args: unknown[]) => {
          const operation: unknown = handler(...args);
          // Streams retain their existing replay, buffering and authorization contracts.
          return isExternalPluginEffect(operation)
            ? // @effect-diagnostics-next-line anyUnknownInErrorContext:off - Only this dynamic boundary erases individual RPC error types.
              plugins.interceptBuiltin(pluginId, method, args[0], operation)
            : operation;
        },
      ];
    }),
  );
  return wrapped as T;
}
