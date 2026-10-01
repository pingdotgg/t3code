/**
 * Admission rules for archives requested by an automatic archiver rather than by a person.
 *
 * A `thread.archive` carrying `automatic: true` is decided against the read model as it stands
 * when the command reaches the queue, which is later than any read the archiver did while
 * planning. These guards close that window: the archiver registers its rules here, and a command
 * it sent is decided only while they still hold.
 *
 * A guard is deliberately synchronous and side-effect free — it runs inside command admission,
 * where anything slow or failing would stall the queue.
 *
 * @module automaticArchiveGuard
 */
import type { OrchestrationReadModel, ThreadId } from "@t3tools/contracts";

export interface AutomaticArchiveGuardInput {
  readonly readModel: OrchestrationReadModel;
  readonly threadId: ThreadId;
}

export type AutomaticArchiveGuard = (input: AutomaticArchiveGuardInput) => boolean;

/**
 * An automatic archive is only decided while every registered guard approves, and an
 * unregistered automatic archive is decided as nothing. Failing closed means a mis-wired
 * archiver leaves threads alone rather than archiving them unchecked.
 */
export function automaticArchiveIsApproved(
  guards: ReadonlyArray<AutomaticArchiveGuard> | undefined,
  input: AutomaticArchiveGuardInput,
): boolean {
  if (guards === undefined || guards.length === 0) return false;
  return guards.every((guard) => guard(input));
}
