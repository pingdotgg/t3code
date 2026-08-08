/**
 * Vendored Aether canonical item types and their classification into t3's
 * closed 7-value `ToolLifecycleItemType` union.
 *
 * Ported from the Aether monorepo's `packages/domain-types/src/canonical-item-type.ts`
 * (wire twin: `packages/workspace-protocol/src/messages.ts` `CanonicalItemTypeSchema`)
 * — see the README in this directory for the sync recipe.
 *
 * Classification rules:
 *   - types t3 also has keep their name (`command_execution`, `file_change`,
 *     `mcp_tool_call`, `dynamic_tool_call`, `collab_agent_tool_call`,
 *     `web_search`, `image_view`)
 *   - `subagent_invocation` → `collab_agent_tool_call`
 *   - everything else → `dynamic_tool_call` — NEVER a new string. This
 *     includes `file_read`, which t3's `ToolLifecycleItemType` union does not
 *     contain.
 *
 * @module provider/Layers/aether/vendored/canonicalItemType
 */
import type { ToolLifecycleItemType } from "@t3tools/contracts";

/** The full Aether `CanonicalItemType` enum, verbatim from the wire schema. */
export const AETHER_CANONICAL_ITEM_TYPES = [
  "user_message",
  "assistant_message",
  "reasoning",
  "plan",
  "command_execution",
  "file_change",
  "file_read",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_agent_tool_call",
  "web_search",
  "web_fetch",
  "image_view",
  "task_tracking",
  "subagent_invocation",
  "review_entered",
  "review_exited",
  "context_compaction",
  "error",
  "unknown",
] as const;
export type AetherCanonicalItemType = (typeof AETHER_CANONICAL_ITEM_TYPES)[number];

/**
 * Total static map: every Aether canonical item type resolves to exactly one
 * t3 tool-lifecycle type. The `Record` is deliberately exhaustive so adding a
 * value to `AETHER_CANONICAL_ITEM_TYPES` without classifying it is a compile
 * error.
 */
const TOOL_LIFECYCLE_BY_AETHER_ITEM_TYPE: Record<AetherCanonicalItemType, ToolLifecycleItemType> = {
  user_message: "dynamic_tool_call",
  assistant_message: "dynamic_tool_call",
  reasoning: "dynamic_tool_call",
  plan: "dynamic_tool_call",
  command_execution: "command_execution",
  file_change: "file_change",
  file_read: "dynamic_tool_call",
  mcp_tool_call: "mcp_tool_call",
  dynamic_tool_call: "dynamic_tool_call",
  collab_agent_tool_call: "collab_agent_tool_call",
  web_search: "web_search",
  web_fetch: "dynamic_tool_call",
  image_view: "image_view",
  task_tracking: "dynamic_tool_call",
  subagent_invocation: "collab_agent_tool_call",
  review_entered: "dynamic_tool_call",
  review_exited: "dynamic_tool_call",
  context_compaction: "dynamic_tool_call",
  error: "dynamic_tool_call",
  unknown: "dynamic_tool_call",
};

const isAetherCanonicalItemType = (value: string): value is AetherCanonicalItemType =>
  (AETHER_CANONICAL_ITEM_TYPES as ReadonlyArray<string>).includes(value);

/**
 * Classify an Aether tool-card item type into t3's tool-lifecycle union.
 * Accepts any string (the value crosses the wire untrusted); anything outside
 * the vendored enum classifies as `dynamic_tool_call`.
 */
export function toolLifecycleItemTypeFromAether(itemType: string): ToolLifecycleItemType {
  return isAetherCanonicalItemType(itemType)
    ? TOOL_LIFECYCLE_BY_AETHER_ITEM_TYPE[itemType]
    : "dynamic_tool_call";
}
