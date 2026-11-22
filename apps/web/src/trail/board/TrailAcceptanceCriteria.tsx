import { CheckIcon } from "lucide-react";
import { T, useGT } from "gt-react";

import { cn } from "~/lib/utils";
import { PullRequestSection } from "~/components/pullRequest/PullRequestSummaryTab";

import { parseAcceptanceCriteria } from "./acceptanceCriteria.logic";

/** Read-only acceptance criteria parsed from the issue body (task list under a heading). */
export function TrailAcceptanceCriteria({ body }: { readonly body: string | null | undefined }) {
  const gt = useGT();
  const section = parseAcceptanceCriteria(body);
  if (section === null || section.items.length === 0) return null;

  return (
    <PullRequestSection title={gt("Acceptance criteria")} keepMounted>
      <ul className="flex flex-col gap-1.5 px-4 pb-3">
        {section.items.map((item) => (
          <li
            key={`${item.checked ? "1" : "0"}:${item.text}`}
            className="flex items-start gap-2 text-sm"
          >
            <span
              aria-hidden
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border",
                item.checked
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-muted-foreground/40",
              )}
            >
              {item.checked ? <CheckIcon className="size-3" /> : null}
            </span>
            <span className={cn(item.checked && "text-muted-foreground line-through")}>
              {item.text}
            </span>
            <span className="sr-only">{item.checked ? <T>Completed</T> : <T>Incomplete</T>}</span>
          </li>
        ))}
      </ul>
    </PullRequestSection>
  );
}
