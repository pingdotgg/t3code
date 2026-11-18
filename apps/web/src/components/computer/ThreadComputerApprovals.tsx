import { computerPendingApprovals } from "@t3tools/client-runtime/state/computer";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useNowAfter } from "../../hooks/useDeadline";
import { nextComputerDeadline, useComputerSnapshot } from "../../state/computer";
import { useEnvironment } from "../../state/environments";
import { ComputerApprovalCard } from "./ComputerApprovalCard";

/**
 * The tap a task in this thread waits for, above its composer, so the person who started it sees
 * it where they are. The same approval is also in the global strip, for every other screen.
 */
export function ThreadComputerApprovals({
  threadRef,
}: {
  readonly threadRef: ScopedThreadRef | null;
}) {
  const { snapshot } = useComputerSnapshot(threadRef?.environmentId ?? null);
  const nowMs = useNowAfter(nextComputerDeadline(snapshot));
  const environment = useEnvironment(threadRef?.environmentId ?? null);
  if (threadRef === null) return null;
  const waiting = computerPendingApprovals(snapshot, nowMs).filter(
    (approval) =>
      snapshot.tasks.find((task) => task.taskId === approval.binding.taskId)?.threadId ===
      threadRef.threadId,
  );
  if (waiting.length === 0) return null;
  return (
    <div className="mb-2 flex flex-col gap-2">
      {waiting.map((approval, index) => (
        <ComputerApprovalCard
          key={approval.id}
          environmentId={threadRef.environmentId}
          environmentLabel={environment?.label ?? "This computer"}
          approval={approval}
          announce={index === 0}
        />
      ))}
    </div>
  );
}
