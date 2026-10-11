import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

const PULL_REQUEST_NUMBER_PATTERN = /^#?(\d+)$/;

/**
 * The change request a pasted reference names: a host's change request URL, returned as is, or
 * a bare number. A host's checkout command, such as `gh pr checkout 42`, is read for its
 * argument first. Null for anything else, such as a branch name.
 */
export function parsePullRequestReference(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const normalizedInput =
    sourceControlClients.definitions
      .map((definition) => definition.checkoutCommandArgument(trimmed))
      .find((argument) => argument !== null) ?? trimmed;
  if (normalizedInput.length === 0) {
    return null;
  }

  if (
    sourceControlClients.definitions.some((definition) =>
      definition.isChangeRequestReference(normalizedInput),
    )
  ) {
    return normalizedInput;
  }

  const numberMatch = PULL_REQUEST_NUMBER_PATTERN.exec(normalizedInput);
  if (numberMatch?.[1]) {
    return numberMatch[1];
  }

  return null;
}
