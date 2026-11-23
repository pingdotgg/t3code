import type { RuntimeMode } from "@t3tools/contracts";

/** A conversation has no checkout to work in, so full access would only reach the user's files. */
export const defaultRuntimeModeFor = (
  project: { readonly isScratch?: true } | null | undefined,
  configured: RuntimeMode,
): RuntimeMode =>
  project?.isScratch === true && configured === "full-access" ? "auto-accept-edits" : configured;
