import {
  threadRuntimeCanArchive,
  type ThreadRuntimeSummary,
} from "@t3tools/client-runtime/state/models";

export function threadCanArchive(runtime: ThreadRuntimeSummary | null | undefined): boolean {
  return threadRuntimeCanArchive(runtime);
}
