/**
 * Grok internals the server's replay testkit, fixture recorder, and
 * orchestration tests drive directly.
 *
 * @module provider-grok/testing
 */
export {
  GROK_DEFAULT_INSTANCE_ID,
  GROK_PROVIDER,
  GrokProviderCapabilitiesV2,
  grokLaunchRuntimeMode,
  makeGrokAcpAdapterFlavor,
  makeGrokAdapterV2,
  type GrokAdapterV2Options,
} from "./server/adapter.ts";
export {
  GROK_ACP_CANCEL_META,
  GROK_ACP_INITIALIZE_META,
  makeGrokAcpRuntime,
} from "./server/acpSupport.ts";
export {
  buildGrokModelCapabilities,
  buildGrokModelsFromSessionModelState,
  buildInitialGrokProviderSnapshot,
  checkGrokProviderStatus,
  grokSlashCommandsFromInitialize,
  parseGrokModelsCliOutput,
} from "./server/status.ts";
export { makeGrokTextGeneration } from "./server/textGeneration.ts";
export { grokUsageResponseToLimits, readGrokAccount } from "./server/usageLimits.ts";
export {
  extractXAiAcpSubagentEndNotice,
  extractXAiAcpSubagentUpdate,
  makeXAiPromptCompletionRuntime,
  normalizeXAiAcpToolCallState,
  registerXAiBackgroundTaskTracking,
  xAiRateLimitedErrorCode,
} from "./server/xaiAcpExtension.ts";
