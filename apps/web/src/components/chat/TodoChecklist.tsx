import { msg, useMessages } from "gt-react";

import { cn } from "~/lib/utils";
import type { GrokTodoStep } from "../../grokTodoPlan";

const STATUS: Record<GrokTodoStep["status"], { readonly mark: string; readonly label: string }> = {
  pending: { mark: "○", label: msg("Pending", { $context: "task status" }) },
  running: { mark: "◉", label: msg("In progress", { $context: "task status" }) },
  completed: { mark: "✓", label: msg("Completed", { $context: "task status" }) },
  cancelled: { mark: "–", label: msg("Cancelled", { $context: "task status" }) },
};

export function TodoChecklist(props: {
  readonly steps: ReadonlyArray<GrokTodoStep>;
  readonly className?: string;
}) {
  const m = useMessages();
  return (
    <ul className={cn("space-y-0.5 text-sm", props.className)}>
      {props.steps.map((step) => (
        <li key={step.id} className="flex min-w-0 gap-2">
          <span className="w-3 shrink-0 text-muted-foreground" aria-hidden>
            {STATUS[step.status].mark}
          </span>
          <span
            className={
              step.status === "completed" || step.status === "cancelled"
                ? "min-w-0 text-muted-foreground"
                : "min-w-0 text-foreground"
            }
          >
            <span className="sr-only">{`${m(STATUS[step.status].label)}: `}</span>
            {step.text}
          </span>
        </li>
      ))}
    </ul>
  );
}
