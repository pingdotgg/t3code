import type { KompasSnapshot, RuntimeMode } from "@t3tools/contracts";

/**
 * Chat mode hides the coding tools. A server without Kompas keeps them; one that has not said yet
 * counts as Kompas, so a conversation never flashes them.
 */
export const isChatMode = (
  capabilities: { readonly kompas?: boolean } | undefined,
  snapshot: KompasSnapshot | null,
): boolean =>
  capabilities === undefined ||
  (capabilities.kompas === true && snapshot?.settings.developerMode !== true);

/** A conversation has no checkout to work in, so full access would only reach the user's files. */
export const defaultRuntimeModeFor = (
  project: { readonly isScratch?: true } | null | undefined,
  configured: RuntimeMode,
): RuntimeMode =>
  project?.isScratch === true && configured === "full-access" ? "auto-accept-edits" : configured;
