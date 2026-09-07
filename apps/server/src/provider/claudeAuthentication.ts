/** CLI login cannot replace credentials supplied by the environment or another API backend. */
export function supportsClaudeSubscriptionLogin(
  environment: NodeJS.ProcessEnv = {},
  authType?: string,
): boolean {
  const externalCredentials = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
  ];
  if (externalCredentials.some((key) => (environment[key]?.trim().length ?? 0) > 0)) return false;
  const externalBackends = [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_VERTEX_AI",
    "CLAUDE_CODE_USE_FOUNDRY",
  ];
  if (
    externalBackends.some((key) => {
      const value = environment[key]?.trim().toLowerCase();
      return value !== undefined && value !== "" && value !== "0" && value !== "false";
    })
  ) {
    return false;
  }
  const normalizedAuthType = authType?.toLowerCase().replace(/[\s_-]+/g, "");
  return ![
    "apikey",
    "anthropicapikey",
    "anthropicauthtoken",
    "bedrock",
    "amazonbedrock",
    "vertex",
    "vertexai",
    "googlevertexai",
    "foundry",
    "azurefoundry",
  ].includes(normalizedAuthType ?? "");
}
