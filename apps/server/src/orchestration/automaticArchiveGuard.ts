// Guards an automatic archiver's archive against the read model as it stands when the command is
// decided, which is later than any read the archiver planned with. Guards run inside command
// admission, so they must stay synchronous and side-effect free.
import type { OrchestrationReadModel, ThreadId } from "@t3tools/contracts";

export interface AutomaticArchiveGuardInput {
  readonly readModel: OrchestrationReadModel;
  readonly threadId: ThreadId;
}

export type AutomaticArchiveGuard = (input: AutomaticArchiveGuardInput) => boolean;

// Fails closed: no guard registered means the archive is decided as nothing.
export function automaticArchiveIsApproved(
  guards: ReadonlyArray<AutomaticArchiveGuard> | undefined,
  input: AutomaticArchiveGuardInput,
): boolean {
  if (guards === undefined || guards.length === 0) return false;
  return guards.every((guard) => guard(input));
}
