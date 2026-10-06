import type { SourceControlProviderKind } from "@t3tools/contracts";

const FORGEJO_PULL_REQUEST_URL_PATTERN =
  /^https?:\/\/[^/\s]+\/(?:[^/\s]+\/)+[^/\s]+\/pulls\/(\d+)(?:[/?#].*)?$/i;
const FORGEJO_CLI_PR_CHECKOUT_PATTERN = /^tea\s+(?:pr|pulls)\s+checkout\s+(.+)$/i;
const GITHUB_PULL_REQUEST_URL_PATTERN =
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)(?:[/?#].*)?$/i;
const GITLAB_MERGE_REQUEST_URL_PATTERN =
  /^https:\/\/[^/\s]*gitlab[^/\s]*\/.+\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/i;
const AZURE_DEVOPS_PULL_REQUEST_URL_PATTERN =
  /^https:\/\/(?:dev\.azure\.com\/[^/\s]+\/[^/\s]+|[^/\s]+\.visualstudio\.com\/[^/\s]+)\/_git\/[^/\s]+\/pullrequest\/(\d+)(?:[/?#].*)?$/i;
const PULL_REQUEST_NUMBER_PATTERN = /^#?(\d+)$/;
const GITHUB_CLI_PR_CHECKOUT_PATTERN = /^gh\s+pr\s+checkout\s+(.+)$/i;
const GITLAB_CLI_MR_CHECKOUT_PATTERN = /^glab\s+mr\s+checkout\s+(.+)$/i;
const AZURE_DEVOPS_CLI_PR_CHECKOUT_PATTERN = /^az\s+repos\s+pr\s+checkout\s+(.+)$/i;

function parseAzureDevOpsCheckoutReference(args: string): string | null {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    if (part === "--id" || part === "-i") {
      return parts[index + 1] ?? null;
    }
    if (part.startsWith("--id=")) {
      return part.slice("--id=".length) || null;
    }
  }
  return parts.find((part) => !part.startsWith("-")) ?? null;
}

export function parsePullRequestReference(
  input: string,
  provider?: SourceControlProviderKind,
): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const arcCheckout = /^arc\s+patch\s+(D?\d+)$/i.exec(trimmed);
  if (arcCheckout && provider !== "phabricator") return null;

  const ghCliCheckoutMatch = GITHUB_CLI_PR_CHECKOUT_PATTERN.exec(trimmed);
  const glabCliCheckoutMatch = GITLAB_CLI_MR_CHECKOUT_PATTERN.exec(trimmed);
  const azureDevOpsCliCheckoutMatch = AZURE_DEVOPS_CLI_PR_CHECKOUT_PATTERN.exec(trimmed);
  const normalizedInput =
    arcCheckout?.[1]?.trim() ??
    FORGEJO_CLI_PR_CHECKOUT_PATTERN.exec(trimmed)?.[1]?.trim() ??
    ghCliCheckoutMatch?.[1]?.trim() ??
    glabCliCheckoutMatch?.[1]?.trim() ??
    (azureDevOpsCliCheckoutMatch?.[1]
      ? parseAzureDevOpsCheckoutReference(azureDevOpsCliCheckoutMatch[1])
      : null) ??
    trimmed;
  if (normalizedInput.length === 0) {
    return null;
  }

  const urlMatch =
    /^https?:\/\/[^/\s]+\/D([1-9]\d*)(?:[/?#].*)?$/i.exec(normalizedInput) ??
    FORGEJO_PULL_REQUEST_URL_PATTERN.exec(normalizedInput) ??
    GITHUB_PULL_REQUEST_URL_PATTERN.exec(normalizedInput) ??
    GITLAB_MERGE_REQUEST_URL_PATTERN.exec(normalizedInput) ??
    AZURE_DEVOPS_PULL_REQUEST_URL_PATTERN.exec(normalizedInput);
  if (urlMatch?.[1]) {
    return normalizedInput;
  }

  const numberMatch =
    (provider === "phabricator" ? /^D(\d+)$/i.exec(normalizedInput) : null) ??
    PULL_REQUEST_NUMBER_PATTERN.exec(normalizedInput);
  if (numberMatch?.[1]) {
    return numberMatch[1];
  }

  return null;
}
