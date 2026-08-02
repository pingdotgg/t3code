import type { OpenCode2Settings } from "@t3tools/contracts";

export const OPENCODE2_BACKGROUND_SUBAGENTS_ENV = "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS";

export function applyOpenCode2ProviderEnvironment(
  settings: Pick<OpenCode2Settings, "backgroundSubagents" | "serverUrl">,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (settings.serverUrl.trim().length > 0) {
    return environment;
  }

  return {
    ...environment,
    [OPENCODE2_BACKGROUND_SUBAGENTS_ENV]: settings.backgroundSubagents ? "true" : "false",
  };
}
