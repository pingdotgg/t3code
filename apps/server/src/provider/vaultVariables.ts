import type { VaultVariable } from "@t3tools/contracts";

function normalizePromptValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function buildVaultVariablesPrompt(variables: readonly VaultVariable[]): string | undefined {
  if (variables.length === 0) {
    return undefined;
  }

  const lines = [
    "Vault variables are reusable, model-visible aliases defined by the user.",
    "When the user refers to one of these keys, use its corresponding value.",
    "",
    ...variables.map((variable) => `- ${variable.key}: ${variable.value}`),
  ];

  return lines.join("\n");
}

export function injectVaultVariablesIntoPrompt(input: {
  readonly prompt: string | undefined;
  readonly variables: readonly VaultVariable[];
}): string | undefined {
  const prompt = normalizePromptValue(input.prompt);
  const variablesBlock = buildVaultVariablesPrompt(input.variables);

  if (!variablesBlock) {
    return prompt;
  }
  if (!prompt) {
    return variablesBlock;
  }

  return `${variablesBlock}\n\nUser request:\n${prompt}`;
}
