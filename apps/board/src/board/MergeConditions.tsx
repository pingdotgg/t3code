import { Check, Circle } from "lucide-react";

import { MERGE_CONDITIONS, type ForYouItem } from "../domain/forYou";
import { ClaimEvidence } from "./ClaimEvidence";

type MergeItem = Extract<ForYouItem, { readonly kind: "merge_approval" }>;

/** The six merge-ready conditions as the orchestrator wrote them, each with whether it holds and the files that show it. */
export function MergeConditions({ conditions }: { conditions: MergeItem["conditions"] }) {
  return (
    <ul aria-label="Merge conditions" className="flex flex-col gap-2">
      {MERGE_CONDITIONS.map(({ key, label }) => {
        const condition = conditions[key];
        return (
          <li
            key={key}
            data-testid="merge-condition"
            data-condition={key}
            data-met={condition.met}
            className="flex gap-1.5"
          >
            {condition.met ? (
              <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-400" aria-label="Met" />
            ) : (
              <Circle className="mt-0.5 size-3.5 shrink-0 text-amber-400" aria-label="Not met" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[12px] leading-4 text-fg">{label}</p>
              <ClaimEvidence condition={condition} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
