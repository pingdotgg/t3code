import { Check, Circle } from "lucide-react";

import { MERGE_CONDITIONS, type ForYouItem } from "../domain/forYou";

type MergeItem = Extract<ForYouItem, { readonly kind: "merge_approval" }>;

const isLink = (evidence: string) => /^https?:\/\//.test(evidence);

const chip =
  "block max-w-full break-all rounded border border-line px-1.5 font-mono text-[10px] leading-4 text-muted";

/** The six merge-ready conditions, each with whether it holds and the files that show it. */
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
              {condition.note != null && (
                <p className="text-[11px] break-words text-muted">{condition.note}</p>
              )}
              <div className="mt-0.5 flex flex-col items-start gap-0.5">
                {(condition.evidence ?? []).map((evidence) =>
                  isLink(evidence) ? (
                    <a
                      key={evidence}
                      data-testid="evidence"
                      href={evidence}
                      target="_blank"
                      rel="noreferrer"
                      // A press on a link is a click, not the start of a pan.
                      onPointerDown={(event) => event.stopPropagation()}
                      className={`${chip} text-sky-300 hover:underline`}
                    >
                      {evidence}
                    </a>
                  ) : (
                    <span key={evidence} data-testid="evidence" className={chip}>
                      {evidence}
                    </span>
                  ),
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
