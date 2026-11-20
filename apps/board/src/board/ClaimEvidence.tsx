import { openInPanel } from "../browser/panel";
import type { MergeCondition } from "../domain/forYou";

const isLink = (evidence: string) => /^https?:\/\//.test(evidence);

const chip =
  "block max-w-full break-all rounded border border-line px-1.5 font-mono text-[10px] leading-4 text-muted";

/** The orchestrator's note on a condition and the files or links it names as evidence. */
export function ClaimEvidence({ condition }: { condition: MergeCondition }) {
  return (
    <>
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
              onClick={(event) => {
                event.preventDefault();
                openInPanel(evidence);
              }}
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
    </>
  );
}
