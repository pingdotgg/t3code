import type { ProviderOptionSelection } from "@t3tools/contracts";
import { sha256Hex } from "./workflowVersionHash.ts";

/**
 * Stable, order-independent key identifying an agent's configuration within a
 * lane. Used to anchor a per-`(ticket, lane, agentKey)` workflow `threadId` so
 * a `continueSession` agent step resumes its own provider session across
 * steps/loops.
 *
 * Order-independent over `options` (canonicalized by sorting on `id`), so two
 * agents differing only in the order their options were listed share a key.
 * Differs on any change to `instance`, `model`, or any option `id`/`value`.
 * Missing/empty options canonicalize identically.
 */
export const agentKey = (
  instance: string,
  model: string,
  options?: ReadonlyArray<ProviderOptionSelection>,
): string => {
  const sortedOptions = [...(options ?? [])]
    .map((o) => ({ id: o.id, value: o.value }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const canonical = JSON.stringify({ instance, model, options: sortedOptions });
  return sha256Hex(canonical);
};
