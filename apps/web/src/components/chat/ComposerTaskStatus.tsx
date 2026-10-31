import type { OrchestrationV2PlanStep } from "@t3tools/contracts";
import { CheckCircle2Icon, CircleIcon, ListTodoIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerRequestCard } from "./ComposerRequestCard";

export function ComposerTaskStatus({ steps }: { steps: ReadonlyArray<OrchestrationV2PlanStep> }) {
  const [expanded, setExpanded] = useState(false);
  if (!steps.length) return null;
  const completed = steps.filter((step) => step.status === "completed").length;
  const current = steps.find((step) => step.status === "running");
  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      render={<ComposerRequestCard.Root data-chat-composer-tasks="true" />}
    >
      <ComposerRequestCard.Header
        render={<CollapsibleTrigger render={<button type="button" />} />}
        icon={<ListTodoIcon />}
        title="Tasks"
        sub={expanded ? null : current?.text}
        trailing={
          <>
            {!expanded ? (
              <span
                className="flex min-w-0 max-w-24 items-center gap-0.5 overflow-hidden"
                aria-hidden
              >
                {steps.map((step) => (
                  <span
                    key={step.id}
                    className={cn(
                      "h-1 w-3 rounded-full",
                      step.status === "completed"
                        ? "bg-foreground"
                        : step.status === "running"
                          ? "bg-muted-foreground"
                          : "bg-muted-foreground/25",
                    )}
                  />
                ))}
              </span>
            ) : null}
            <span className="text-dim-foreground tabular-nums">
              {completed}/{steps.length}
            </span>
            <ComposerBanner.ToggleIcon expanded={expanded} />
          </>
        }
      />
      <CollapsiblePanel>
        <ol className="grid gap-2 px-2.5 pb-2 text-meta">
          {steps.map((step) => (
            <li
              key={step.id}
              className={cn(
                "flex min-w-0 items-center gap-2",
                step.status === "pending" ? "text-dim-foreground" : "text-muted-foreground",
              )}
            >
              {step.status === "completed" ? (
                <CheckCircle2Icon aria-hidden className="size-3 shrink-0 text-success-foreground" />
              ) : (
                <CircleIcon aria-hidden className="size-3 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">{step.text}</span>
              <span className="text-dim-foreground tabular-nums">
                {step.status === "running"
                  ? "now"
                  : step.durationMs !== undefined
                    ? `${Math.round(step.durationMs / 1000)}s`
                    : null}
              </span>
            </li>
          ))}
        </ol>
      </CollapsiblePanel>
    </Collapsible>
  );
}
