import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type { WorkflowDefinitionEncoded } from "@t3tools/contracts";
import { GitBranchIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import {
  routeDndId,
  ROUTE_KIND_HANDLE_CLASS,
  type LaneRoutingKind,
  type RouteDragData,
} from "./RoutingHandles";

type WorkflowLaneEncoded = WorkflowDefinitionEncoded["lanes"][number];
type WorkflowStepEncoded = NonNullable<WorkflowLaneEncoded["pipeline"]>[number];

const routeKinds = ["success", "failure", "blocked"] as const satisfies readonly LaneRoutingKind[];

const stepTypeClasses = {
  agent: "border-info/45 bg-info/8 text-info-foreground",
  script: "border-warning/45 bg-warning/8 text-warning-foreground",
  approval: "border-success/45 bg-success/8 text-success-foreground",
  merge: "border-primary/45 bg-primary/8 text-foreground",
  pullRequest: "border-foreground/45 bg-foreground/8 text-foreground",
} satisfies Record<WorkflowStepEncoded["type"], string>;

export function StepBlock({
  laneKey,
  laneName,
  step,
  selected = false,
  disabled = false,
  onSelect,
}: {
  readonly laneKey: string;
  readonly laneName: string;
  readonly step: WorkflowStepEncoded;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}) {
  const stepKey = String(step.key);
  const summary = summarizeStep(step);

  return (
    <div
      id={`step-${laneKey}-${stepKey}`}
      role="group"
      aria-label={`Step ${stepKey}`}
      data-step-type={step.type}
      tabIndex={0}
      className={cn(
        "relative cursor-pointer rounded-md border px-2.5 py-2 text-left outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
        stepTypeClasses[step.type],
        selected && "ring-2 ring-ring ring-offset-1 ring-offset-background",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          onSelect();
        }
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-foreground">{stepKey}</p>
          <p className="mt-0.5 text-[10px] font-medium uppercase tracking-normal">{step.type}</p>
        </div>
        <span className="rounded-sm border border-border/60 bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {step.type}
        </span>
      </div>
      {summary ? (
        <p className="mt-1 line-clamp-1 text-[11px] text-muted-foreground">{summary}</p>
      ) : null}
      {routeKinds.map((kind, index) => (
        <StepRouteHandle
          key={kind}
          laneKey={laneKey}
          laneName={laneName}
          stepKey={stepKey}
          kind={kind}
          top={22 + index * 11}
          hasRoute={step.on?.[kind] !== undefined}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

const stepRouteDragId = (laneKey: string, stepKey: string, kind: LaneRoutingKind): string =>
  routeDndId(["step-route", laneKey, stepKey, kind]);

function StepRouteHandle({
  laneKey,
  laneName,
  stepKey,
  kind,
  top,
  hasRoute,
  disabled,
}: {
  readonly laneKey: string;
  readonly laneName: string;
  readonly stepKey: string;
  readonly kind: LaneRoutingKind;
  readonly top: number;
  readonly hasRoute: boolean;
  readonly disabled: boolean;
}) {
  const { attributes, isDragging, listeners, setNodeRef, transform } = useDraggable({
    id: stepRouteDragId(laneKey, stepKey, kind),
    data: { laneKey, stepKey, kind } satisfies RouteDragData,
    disabled,
  });

  return (
    <button
      ref={setNodeRef}
      id={`step-${laneKey}-${stepKey}-on-${kind}`}
      type="button"
      data-canvas-anchor
      aria-label={`Drag ${kind} route from step ${stepKey} in ${laneName}`}
      disabled={disabled}
      className={cn(
        "absolute -right-1.5 size-3 rounded-full border border-border bg-background text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        hasRoute && ROUTE_KIND_HANDLE_CLASS[kind],
        isDragging && "opacity-80",
      )}
      style={{ top, transform: CSS.Translate.toString(transform) }}
      onClick={(event) => event.stopPropagation()}
      {...attributes}
      {...listeners}
    >
      <GitBranchIcon className="mx-auto size-2" />
    </button>
  );
}

function summarizeStep(step: WorkflowStepEncoded): string {
  if (step.type === "agent") {
    return typeof step.instruction === "string" ? step.instruction : step.instruction.file;
  }
  if (step.type === "script") {
    return step.run;
  }
  if (step.type === "merge") {
    return step.target !== undefined
      ? `Merge into ${step.target}`
      : "Merge into checked-out branch";
  }
  if (step.type === "pullRequest") {
    return step.action === "land" ? "Land pull request" : "Open pull request";
  }
  return step.prompt ?? "Approval required";
}
