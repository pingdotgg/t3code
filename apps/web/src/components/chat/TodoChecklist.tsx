import type { GrokTodoStep } from "../../grokTodoPlan";

function mark(status: GrokTodoStep["status"]): string {
  switch (status) {
    case "completed":
      return "✓";
    case "running":
      return "◉";
    case "cancelled":
      return "–";
    default:
      return "○";
  }
}

export function TodoChecklist(props: {
  readonly steps: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    readonly status: "pending" | "running" | "completed" | "cancelled";
  }>;
  readonly className?: string;
}) {
  return (
    <ul
      className={`${props.className ? `${props.className} ` : ""}space-y-0.5 text-sm`}
      data-todo-checklist=""
    >
      {props.steps.map((step) => (
        <li key={step.id} className="flex min-w-0 gap-2">
          <span className="w-3 shrink-0 text-muted-foreground" aria-hidden>
            {mark(step.status)}
          </span>
          <span
            className={
              step.status === "completed" || step.status === "cancelled"
                ? "min-w-0 text-muted-foreground"
                : "min-w-0 text-foreground"
            }
          >
            {step.text}
          </span>
        </li>
      ))}
    </ul>
  );
}
