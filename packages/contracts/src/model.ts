export const MODEL_OPTIONS = ["gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.2"] as const;

export const DEFAULT_MODEL = "gpt-5.3-codex";

export const MODEL_SLUG_ALIASES: Record<string, string> = {
  "5.3": "gpt-5.3-codex",
  "gpt-5.3": "gpt-5.3-codex",
};

export function normalizeModelSlug(model: string | null | undefined): string | null {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  return MODEL_SLUG_ALIASES[trimmed] ?? trimmed;
}

export function resolveModelSlug(model: string | null | undefined): string {
  const normalized = normalizeModelSlug(model);
  if (!normalized) {
    return DEFAULT_MODEL;
  }

  return MODEL_OPTIONS.includes(normalized as (typeof MODEL_OPTIONS)[number])
    ? normalized
    : DEFAULT_MODEL;
}
