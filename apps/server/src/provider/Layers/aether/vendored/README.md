# Vendored Aether knowledge

Aether ships no runtime catalog/tool-display endpoint, so the AetherDriver
vendors the small, slow-moving pieces it needs from the Aether monorepo.
These files are hand-ported TypeScript with **no runtime dependency on the
Aether repo** — they go stale until someone re-syncs them.

| File                   | Source of truth (Aether monorepo)                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog.ts`           | `packages/domain-types/src/generated/platform-catalog.ts` (generated from `catalog.yaml` by `tools/catalog-gen`) — codex + claude-code agent families only      |
| `canonicalItemType.ts` | `packages/domain-types/src/canonical-item-type.ts` + `packages/workspace-protocol/src/messages.ts` (`CanonicalItemTypeSchema`)                                  |
| `toolDisplay.ts`       | `packages/tool-display/src/parse.ts` (`parseFileChanges`, `fileChangeDiff` + helpers) and `packages/tool-display/src/diff.ts` (`diffLines`, `parseUnifiedDiff`) |

## Sync recipe

1. Check out the Aether monorepo at the ref you want to sync against.
2. `catalog.ts`: diff `packages/domain-types/src/generated/platform-catalog.ts`
   against `AETHER_PLATFORM_CATALOG` here. Copy over the `codex` and
   `claude-code` agent entries (models + `defaultModel`) and their
   `reasoningEffort` groups verbatim. Other agent families (opencode, cursor,
   hardware presets) are deliberately not vendored.
3. `canonicalItemType.ts`: diff the `CanonicalItemTypeSchema` enum in
   `packages/workspace-protocol/src/messages.ts`. Add any new value to
   `AETHER_CANONICAL_ITEM_TYPES` and give it an explicit entry in
   `TOOL_LIFECYCLE_BY_AETHER_ITEM_TYPE` (unmapped values classify as
   `dynamic_tool_call`, never a new string).
4. `toolDisplay.ts`: diff `packages/tool-display/src/parse.ts` (the
   file-change section) and `packages/tool-display/src/diff.ts` (`diffLines`,
   `parseUnifiedDiff`). Port changes, keeping the field-alias handling in
   `normalizeChange` and the multi-file `splitUnifiedDiff` behavior intact.
   Aether-only imports (`@aether/domain-types` `DiffLine`) stay inlined here.
5. Run the colocated `*.test.ts` suites in this directory.
