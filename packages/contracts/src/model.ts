export const MODEL_OPTIONS = [
  { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
  { slug: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark" },
  { slug: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
  { slug: "gpt-5.2", name: "GPT-5.2" },
] as const;

export type BuiltInModelSlug = (typeof MODEL_OPTIONS)[number]["slug"];
export type ModelSlug = string;

export const DEFAULT_MODEL = "gpt-5.3-codex";

export const MODEL_SLUG_ALIASES: Record<string, BuiltInModelSlug> = {
  "gpt-5": "gpt-5.3-codex",
  "gpt-5-codex": "gpt-5.3-codex",
  "5.3": "gpt-5.3-codex",
  "gpt-5.3": "gpt-5.3-codex",
  "gpt-5-codex-spark": "gpt-5.3-codex-spark",
  "5.3-spark": "gpt-5.3-codex-spark",
  "gpt-5.3-spark": "gpt-5.3-codex-spark",
};

export function normalizeModelSlug(model: string | null | undefined): ModelSlug | null {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  return MODEL_SLUG_ALIASES[trimmed] ?? trimmed;
}

export function resolveModelSlug(model: string | null | undefined): ModelSlug {
  const normalized = normalizeModelSlug(model);
  return normalized ?? DEFAULT_MODEL;
}

export const REASONING_OPTIONS = ["xhigh", "high", "medium", "low"] as const;
export type ReasoningEffort = (typeof REASONING_OPTIONS)[number];
export const DEFAULT_REASONING: ReasoningEffort = "high";
