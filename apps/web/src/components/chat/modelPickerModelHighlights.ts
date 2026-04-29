import type { ProviderDriverKind } from "@t3tools/contracts";

/**
 * Model slugs that show a gold "NEW" chip in the model picker list.
 * Add entries as `provider:slug` when you want to highlight freshly shipped models.
 */
const NEW_MODEL_KEYS = new Set<string>([
  // Example: "claudeAgent:claude-opus-4-7",
]);

export function isModelPickerNewModel(provider: ProviderDriverKind, slug: string): boolean {
  return NEW_MODEL_KEYS.has(`${provider}:${slug}`);
}
