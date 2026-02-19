export const MODEL_OPTIONS = [
  { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
  { slug: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark" },
  { slug: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
  { slug: "gpt-5.2", name: "GPT-5.2" },
] as const;

export type ModelSlug = (typeof MODEL_OPTIONS)[number]["slug"];

export const DEFAULT_MODEL = "gpt-5.3-codex";

export const MODEL_SLUG_ALIASES: Record<string, ModelSlug> = {
  "5.3": "gpt-5.3-codex",
  "gpt-5.3": "gpt-5.3-codex",
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

  return MODEL_SLUG_ALIASES[trimmed] ?? (trimmed as ModelSlug);
}

export function resolveModelSlug(model: string | null | undefined): ModelSlug {
  const normalized = normalizeModelSlug(model);
  if (!normalized) {
    return DEFAULT_MODEL;
  }

  return MODEL_OPTIONS.some((option) => option.slug === normalized) ? normalized : DEFAULT_MODEL;
}

export const CLAUDE_MODEL_OPTIONS = [
  { slug: "sonnet", name: "Claude Sonnet (latest)" },
  { slug: "opus", name: "Claude Opus (latest)" },
  { slug: "haiku", name: "Claude Haiku (latest)" },
] as const;

export type ClaudeModelSlug = string;

export const DEFAULT_CLAUDE_MODEL = "sonnet";

const CLAUDE_MODEL_SLUG_ALIASES: Record<string, ClaudeModelSlug> = {
  sonnet: "sonnet",
  "sonnet-4-6": "sonnet",
  "claude-sonnet-4-6": "sonnet",
  "sonnet-4-5": "sonnet",
  "claude-sonnet-4-5": "sonnet",
  opus: "opus",
  "opus-4-6": "opus",
  "claude-opus-4-6": "opus",
  "opus-4-5": "opus",
  "claude-opus-4-5": "opus",
  "opus-4-1": "opus",
  "claude-opus-4-1": "opus",
  haiku: "haiku",
  "haiku-4-5": "haiku",
  "claude-haiku-4-5": "haiku",
};

export function normalizeClaudeModelSlug(model: string | null | undefined): ClaudeModelSlug | null {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  return CLAUDE_MODEL_SLUG_ALIASES[trimmed] ?? (trimmed as ClaudeModelSlug);
}

export function resolveClaudeModelSlug(model: string | null | undefined): ClaudeModelSlug {
  const normalized = normalizeClaudeModelSlug(model);
  if (!normalized) {
    return DEFAULT_CLAUDE_MODEL;
  }

  return normalized;
}
