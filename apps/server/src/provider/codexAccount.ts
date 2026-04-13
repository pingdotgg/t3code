import type { ServerProviderModel } from "@t3tools/contracts";

export type CodexPlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "team"
  | "business"
  | "enterprise"
  | "edu"
  | "unknown";

export interface CodexAccountSnapshot {
  readonly type: "apiKey" | "chatgpt" | "unknown";
  readonly planType: CodexPlanType | null;
  readonly sparkEnabled: boolean;
}

export const CODEX_DEFAULT_MODEL = "gpt-5.3-codex";
export const CODEX_SPARK_MODEL = "gpt-5.3-codex-spark";
const CODEX_SPARK_ENABLED_PLAN_TYPES = new Set<CodexPlanType>(["pro", "prolite"]);

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function readCodexAccountSnapshot(response: unknown): CodexAccountSnapshot {
  const record = asObject(response);
  const account = asObject(record?.account) ?? record;
  const accountType = asString(account?.type);

  if (accountType === "apiKey") {
    return {
      type: "apiKey",
      planType: null,
      sparkEnabled: false,
    };
  }

  if (accountType === "chatgpt") {
    const planType = (account?.planType as CodexPlanType | null) ?? "unknown";
    return {
      type: "chatgpt",
      planType,
      sparkEnabled: CODEX_SPARK_ENABLED_PLAN_TYPES.has(planType),
    };
  }

  return {
    type: "unknown",
    planType: null,
    sparkEnabled: false,
  };
}

export function codexAuthSubType(account: CodexAccountSnapshot | undefined): string | undefined {
  if (account?.type === "apiKey") {
    return "apiKey";
  }

  if (account?.type !== "chatgpt") {
    return undefined;
  }

  return account.planType && account.planType !== "unknown" ? account.planType : "chatgpt";
}

export function codexAuthSubLabel(account: CodexAccountSnapshot | undefined): string | undefined {
  switch (codexAuthSubType(account)) {
    case "apiKey":
      return "OpenAI API Key";
    case "chatgpt":
      return "ChatGPT Subscription";
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro Subscription";
    case "prolite":
      return "ChatGPT Pro Lite Subscription";
    case "team":
      return "ChatGPT Team Subscription";
    case "business":
      return "ChatGPT Business Subscription";
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
      return "ChatGPT Edu Subscription";
    default:
      return undefined;
  }
}

export function adjustCodexModelsForAccount(
  baseModels: ReadonlyArray<ServerProviderModel>,
  account: CodexAccountSnapshot | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (account?.sparkEnabled !== false) {
    return baseModels;
  }

  return baseModels.filter((model) => model.isCustom || model.slug !== CODEX_SPARK_MODEL);
}

export function resolveCodexModelForAccount(
  model: string | undefined,
  account: CodexAccountSnapshot,
  availableModels?: ReadonlySet<string>,
): string | undefined {
  if (!model) {
    return model;
  }

  if (availableModels?.has(model)) {
    return model;
  }

  if (model !== CODEX_SPARK_MODEL || account.sparkEnabled) {
    return model;
  }

  return availableModels?.has(CODEX_DEFAULT_MODEL) === false ? model : CODEX_DEFAULT_MODEL;
}
