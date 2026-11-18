import {
  computerLiveApprovals,
  nextComputerApprovalDeadline,
} from "@t3tools/client-runtime/state/computer";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useNowAfter } from "../../hooks/useDeadline";
import { useThreadComputer } from "../../state/computer";
import { useEnvironment } from "../../state/environments";
import { ComputerApprovalCard } from "./ComputerApprovalCard";

/**
 * The tap a task in this thread waits for, above its composer, so the person who started it sees
 * it where they are. Only other screens show it in the global strip.
 */
export function ThreadComputerApprovals({
  threadRef,
}: {
  readonly threadRef: ScopedThreadRef | null;
}) {
  const { approvals } = useThreadComputer(threadRef);
  const nowMs = useNowAfter(nextComputerApprovalDeadline(approvals));
  const environment = useEnvironment(threadRef?.environmentId ?? null);
  if (threadRef === null) return null;
  const waiting = computerLiveApprovals(approvals, nowMs);
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
