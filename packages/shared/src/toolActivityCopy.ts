import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { describeDynamicToolTitle, searchToolLabelParts } from "./toolActivity.ts";

/** @public */
export function dynamicToolTitle(
  toolName: string | null | undefined,
  input: unknown,
  retainedTitle?: string | null,
  resolve: MFunctionType = mFallback,
): string | undefined {
  const title = describeDynamicToolTitle(toolName, input, retainedTitle);
  switch (title?.kind) {
    case undefined:
      return undefined;
    case "title":
      return title.title;
    case "computer-use":
      return resolve(msg("Computer use"));
    case "run-javascript":
      return resolve(msg("Run JavaScript"));
    case "skill":
      return resolve(msg("Skill: {name}", { name: title.name }));
  }
}

/** @public */
export function formatSearchToolLabel(
  data: Record<string, unknown> | undefined,
  resolve: MFunctionType = mFallback,
): string | undefined {
  const { query, glob, target } = searchToolLabelParts(data);
  if (query && target) return resolve(msg("Searched {query} in {target}", { query, target }));
  if (glob && target) return resolve(msg("Searched files {glob} in {target}", { glob, target }));
  if (glob) return resolve(msg("Searched files {glob}", { glob }));
  if (query) return resolve(msg("Searched {query}", { query }));
  if (target) return resolve(msg("Searched in {target}", { target }));
  return undefined;
}

/** @public */
export function formatReadToolLabel(
  path: string,
  extraCount = 0,
  resolve: MFunctionType = mFallback,
): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return extraCount > 0
      ? resolve(msg("Read file +{count} more", { count: extraCount }))
      : resolve(msg("Read file"));
  }
  return extraCount > 0
    ? resolve(msg("Read {path} +{count} more", { path: trimmed, count: extraCount }))
    : resolve(msg("Read {path}", { path: trimmed }));
}
