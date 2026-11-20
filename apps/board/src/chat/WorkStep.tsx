import type { EnvironmentId } from "@t3tools/contracts";
import {
  Bot,
  ChevronRight,
  CircleAlert,
  Eye,
  Loader,
  type LucideIcon,
  Search,
  SquarePen,
  Terminal,
  Wrench,
} from "lucide-react";
import { useState } from "react";

import { StepBody } from "./StepBody";
import type { StepKind, ToolStep } from "./timeline";

const ICON = {
  command: Terminal,
  read: Eye,
  edit: SquarePen,
  search: Search,
  agent: Bot,
  tool: Wrench,
} as const satisfies Record<StepKind, LucideIcon>;

export function WorkStep({
  step,
  environmentId,
}: {
  step: ToolStep;
  environmentId: EnvironmentId;
}) {
  const [open, setOpen] = useState(false);
  const Icon = step.failed ? CircleAlert : ICON[step.family];
  return (
    <li data-testid="work-step" data-family={step.family} data-failed={step.failed}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-6 w-full min-w-0 items-center gap-1.5 rounded-md px-0.5 text-left hover:bg-hover"
      >
        {step.running ? (
          <Loader className="size-4 shrink-0 animate-spin" aria-hidden />
        ) : (
          <Icon
            className={`size-4 shrink-0 ${step.failed ? "text-red-400" : "text-muted"}`}
            aria-hidden
          />
        )}
        <span
          className={`min-w-0 flex-1 truncate ${step.family === "command" ? "font-mono text-[11px]" : ""} ${step.failed ? "text-red-300" : ""}`}
        >
          {step.label}
        </span>
        <ChevronRight
          className={`size-3 shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        />
      </button>
      {open && <StepBody step={step} environmentId={environmentId} />}
    </li>
  );
}
