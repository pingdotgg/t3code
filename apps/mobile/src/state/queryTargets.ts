export {
  buildCheckpointDiffTargets,
  type CheckpointDiffTarget,
} from "@t3tools/client-runtime/state/threads";

export function normalizeComposerPathSearchQuery(query: string | null): string {
  return query?.trim() ?? "";
}
