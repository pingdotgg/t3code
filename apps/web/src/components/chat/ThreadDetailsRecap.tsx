import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useGT } from "gt-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

export function ThreadDetailsRecap({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(true);
  const { data } = useEnvironmentQuery(
    orchestrationEnvironment.v2.threadRecap({
      environmentId,
      input: { threadId },
    }),
  );

  const text = data?.text ?? null;
  const pending = data?.status === "pending";
  if (text === null && !pending) {
    return null;
  }

  return (
    <ThreadDetailsSection
      headingId="thread-details-recap-heading"
      title={gt("Recap", { $context: "thread details section: short live summary of the thread" })}
      actions={
        <Button
          variant="ghost-muted"
          size="micro"
          aria-expanded={expanded}
          aria-label={expanded ? gt("Collapse recap") : gt("Expand recap")}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3 shrink-0 transition-transform", !expanded && "-rotate-90")}
          />
        </Button>
      }
    >
      {expanded ? (
        text !== null ? (
          <p className="px-2.5 pb-0.5 text-xs leading-relaxed text-muted-foreground wrap-anywhere">
            {text}
          </p>
        ) : (
          <div role="status" className="flex flex-col gap-1.5 px-2.5 py-1">
            <span className="sr-only">{gt("Generating recap")}</span>
            <span aria-hidden className="block h-2.5 w-full rounded bg-muted-foreground/15" />
            <span aria-hidden className="block h-2.5 w-4/5 rounded bg-muted-foreground/10" />
          </div>
        )
      ) : (
        <span className="hidden" />
      )}
    </ThreadDetailsSection>
  );
}
