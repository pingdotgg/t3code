import {
  AuthOrchestrationOperateScope,
  OPEN_PROOF_JUDGE_STATUSES,
  type ProofJudge,
  type ProofJudgeId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ScaleIcon } from "lucide-react";
import { useState } from "react";

import { useQuietThreadProjection } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { Button } from "../ui/button";

function statusLabel(status: ProofJudge["status"]): string {
  switch (status) {
    case "requested":
      return "Requested";
    case "accepted":
      return "Accepted";
    case "rejected":
      return "Rejected";
  }
}

export function ProofJudgesPanel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const judges = useQuietThreadProjection(threadRef)?.projection.thread.proofJudges ?? [];
  const openJudges = judges.filter((judge) => OPEN_PROOF_JUDGE_STATUSES.has(judge.status));
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const decideProofJudge = useOrchestrationCommand(threadEnvironment.decideProofJudge, {
    label: "decide proof judge",
  });
  const [busyIds, setBusyIds] = useState<ReadonlySet<ProofJudgeId>>(new Set());

  if (openJudges.length === 0) return null;

  const decide = async (judgeId: ProofJudgeId, decision: "accept" | "reject" | "reopen") => {
    setBusyIds((ids) => new Set(ids).add(judgeId));
    await decideProofJudge({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, judgeId, decision },
    });
    setBusyIds((ids) => {
      const next = new Set(ids);
      next.delete(judgeId);
      return next;
    });
  };

  return (
    <div className="chat-content-lane">
      <div className="border-border/60 bg-muted/30 flex flex-col gap-2 rounded-md border px-3 py-2">
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
          <ScaleIcon className="size-3.5" />
          Proof judges
        </div>
        <ul className="flex flex-col gap-1.5">
          {openJudges.map((judge) => {
            const busy = busyIds.has(judge.id);
            return (
              <li key={judge.id} className="flex flex-col gap-1 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-medium">{judge.name}</span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {statusLabel(judge.status)}
                  </span>
                </div>
                {judge.criteria ? (
                  <p className="text-muted-foreground line-clamp-2 text-xs">{judge.criteria}</p>
                ) : null}
                {judge.note ? (
                  <p className="text-muted-foreground line-clamp-2 text-xs">{judge.note}</p>
                ) : null}
                {canOperate ? (
                  <div className="flex items-center gap-1">
                    {judge.status === "requested" ? (
                      <>
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          disabled={busy}
                          onClick={() => void decide(judge.id, "reject")}
                        >
                          Reject
                        </Button>
                        <Button
                          size="xs"
                          disabled={busy}
                          onClick={() => void decide(judge.id, "accept")}
                        >
                          Accept
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        disabled={busy}
                        onClick={() => void decide(judge.id, "reopen")}
                      >
                        Reopen
                      </Button>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
