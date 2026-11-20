import { Check, Circle } from "lucide-react";

import { CheckRows } from "../checks/CheckRows";
import type { MergeCondition } from "../domain/forYou";
import type { CheckRun, ConditionKey, ConditionState } from "../domain/readiness";
import { ClaimEvidence } from "./ClaimEvidence";

/**
 * Each merge-ready condition as the board computes it from the ticket and its checks. A card
 * passes the orchestrator's claims too, and a row says so when the claim and the live result
 * disagree. Given the checks, the CI condition lists them in the Checks tab's rows.
 */
export function ReadinessChecklist({
  conditions,
  claims,
  checks,
}: {
  conditions: ReadonlyArray<ConditionState>;
  claims?: Readonly<Record<ConditionKey, MergeCondition>>;
  checks?: { readonly runs: ReadonlyArray<CheckRun>; readonly now: number };
}) {
  return (
    <ul aria-label="Merge readiness" data-testid="readiness" className="flex flex-col gap-2">
      {conditions.map((condition) => {
        const claim = claims?.[condition.key];
        const disagrees = claim !== undefined && claim.met !== condition.met;
        return (
          <li
            key={condition.key}
            data-testid="readiness-condition"
            data-condition={condition.key}
            data-met={condition.met}
            className="flex gap-1.5"
          >
            {condition.met ? (
              <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-400" aria-label="Met" />
            ) : (
              <Circle className="mt-0.5 size-3.5 shrink-0 text-amber-400" aria-label="Missing" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[12px] leading-4 text-fg">{condition.label}</p>
              <p
                className={`text-[11px] break-words ${condition.met ? "text-emerald-300/80" : "text-amber-300"}`}
              >
                {condition.met ? "Met" : `Missing: ${condition.missing}`}
              </p>
              {disagrees && (
                <p
                  data-testid="readiness-disagrees"
                  className="text-[11px] break-words text-red-300"
                >
                  {claim.met
                    ? "The orchestrator says met, but it is missing now."
                    : "The orchestrator says not met, but it holds now."}
                </p>
              )}
              {claim !== undefined && <ClaimEvidence condition={claim} />}
              {condition.key === "ci_green" && checks !== undefined && checks.runs.length > 0 && (
                <div data-testid="readiness-checks" className="-mx-1 mt-1">
                  <CheckRows checks={checks.runs} now={checks.now} />
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
