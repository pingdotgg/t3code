import { Loader, Wrench } from "lucide-react";

import type { ToolStep } from "./timeline";

/** A stretch of tool calls folded into one line, which opens to list them. */
export function WorkRow({ steps }: { steps: ReadonlyArray<ToolStep> }) {
  const running = steps.find((step) => step.running);
  return (
    <details className="group text-muted">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md py-0.5 hover:text-fg">
        {running === undefined ? (
          <Wrench className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <Loader className="size-3.5 shrink-0 animate-spin" aria-hidden />
        )}
        <span className="min-w-0 truncate">
          {running?.label ?? `${steps.length} ${steps.length === 1 ? "tool call" : "tool calls"}`}
        </span>
      </summary>
      <ul className="mt-1 ml-5 flex flex-col gap-0.5 font-mono text-[11px]">
        {steps.map((step) => (
          <li key={step.id} className={`truncate ${step.failed ? "text-red-400" : ""}`}>
            {step.label}
          </li>
        ))}
      </ul>
    </details>
  );
}
