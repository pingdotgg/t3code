export const DEFAULT_CODEX_MODEL = "gpt-5.4";

export function resolveCodexModel(model?: string | null): string {
  const trimmed = model?.trim();
  if (!trimmed) {
    return DEFAULT_CODEX_MODEL;
  }

  return trimmed;
}
