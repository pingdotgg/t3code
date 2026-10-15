/**
 * ACP Registry internals the server's replay testkit, ACP adapter tests, and
 * provider registry tests drive directly.
 *
 * @module provider-acp-registry/testing
 */
export {
  ACP_REGISTRY_DEFAULT_INSTANCE_ID,
  ACP_REGISTRY_PROVIDER,
  acpRegistryPromptFailure,
  makeAcpRegistryAdapterV2,
  registerMistralVibeAcpExtensions,
} from "./server/adapter.ts";
export {
  extractDevinSubagentUpdate,
  normalizeDevinSessionUpdate,
  normalizeDevinToolCall,
} from "./server/devinAcp.ts";
export { extractCopilotSubagentUpdate, makeCopilotSubagentRouting } from "./server/copilotAcp.ts";
export { buildCheckedAcpRegistrySnapshot } from "./server/driver.ts";
export {
  acpRegistryProbeFailure,
  acpRegistryProbeResult,
  listAcpRegistrySessions,
  logoutAcpRegistry,
  normalizeAcpRegistryAuthMethods,
  normalizeAcpRegistryCommands,
  probeAcpRegistryConfiguration,
  type AcpRegistryAvailableCommands,
  type AcpRegistryLiveConfiguration,
} from "./server/probe.ts";
