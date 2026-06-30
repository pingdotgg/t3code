import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type { WorkflowDefinitionEncoded } from "@t3tools/contracts";
import {
  BotIcon,
  CheckSquareIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  GripVerticalIcon,
  TerminalIcon,
} from "lucide-react";
import { useCallback, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import {
  laneMoveDragId,
  LaneRouteHandle,
  type LaneMoveDragData,
  type LaneRoutingKind,
  useLaneDropTarget,
} from "./RoutingHandles";
import { StepBlock } from "./StepBlock";
import type { CanvasLaneLayout } from "./canvasLayout";

type WorkflowLaneEncoded = WorkflowDefinitionEncoded["lanes"][number];
type WorkflowStepType = NonNullable<WorkflowLaneEncoded["pipeline"]>[number]["type"];

const routeKinds = ["success", "failure", "blocked"] as const satisfies readonly LaneRoutingKind[];

export function LaneCard({
  lane,
  layout,
  selected = false,
  selectedStepKey,
  disabled = false,
  onSelect,
  onSelectStep,
  onAddStep,
  onClearRoute,
}: {
  readonly lane: WorkflowLaneEncoded;
  readonly layout: CanvasLaneLayout;
  readonly selected?: boolean;
  readonly selectedStepKey?: string | undefined;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
  readonly onSelectStep: (stepKey: string) => void;
  readonly onAddStep: (type: WorkflowStepType) => void;
  readonly onClearRoute: (kind: LaneRoutingKind) => void;
}) {
  const laneKey = String(lane.key);
  const pipeline = lane.pipeline ?? [];
  const { isOver, setNodeRef: setDropRef } = useLaneDropTarget(laneKey);
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    setActivatorNodeRef,
    transform,
    isDragging,
  } = useDraggable({
    id: laneMoveDragId(laneKey),
    data: { type: "lane-move", laneKey } satisfies LaneMoveDragData,
  });
  const setCardRef = useCallback(
    (node: HTMLElement | null) => {
      setDropRef(node);
      setDragRef(node);
    },
    [setDropRef, setDragRef],
  );

  return (
    <section
      ref={setCardRef}
      id={`lane-${laneKey}`}
      data-testid={`lane-drop-${laneKey}`}
      role="group"
      aria-label={`Lane ${lane.name}`}
      tabIndex={0}
      className={cn(
        "absolute flex cursor-pointer flex-col gap-3 rounded-md border border-border/70 bg-card p-3 shadow-xs outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
        selected && "ring-2 ring-ring ring-offset-1 ring-offset-background",
        isOver && "border-info/70 ring-2 ring-info/45",
        isDragging && "z-30 cursor-grabbing shadow-lg",
      )}
      style={{
        left: layout.x,
        top: layout.y,
        width: layout.width,
        transform: CSS.Translate.toString(transform),
        zIndex: isDragging ? 30 : undefined,
      }}
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
      <span
        id={`lane-${laneKey}-target`}
        data-canvas-anchor
        aria-hidden="true"
        className="absolute -left-1.5 top-1/2 size-3 -translate-y-1/2 rounded-full border border-border bg-background"
      />
      {routeKinds.map((kind, index) => (
        <LaneRouteHandle
          key={kind}
          laneKey={laneKey}
          laneName={lane.name}
          kind={kind}
          top={32 + index * 22}
          hasRoute={lane.on?.[kind] !== undefined}
          disabled={disabled}
          onClear={() => onClearRoute(kind)}
        />
      ))}
      <header className="space-y-2">
        <div className="flex min-w-0 items-start gap-1.5">
          <button
            ref={setActivatorNodeRef}
            type="button"
            data-testid={`lane-move-${laneKey}`}
            aria-label={`Move lane ${lane.name}`}
            className="-ml-1 mt-0.5 shrink-0 cursor-grab touch-none rounded-sm p-0.5 text-muted-foreground/60 outline-none transition-colors hover:bg-muted hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
            onClick={(event) => event.stopPropagation()}
            {...attributes}
            {...listeners}
          >
            <GripVerticalIcon className="size-3.5" />
          </button>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold text-foreground">{lane.name}</h3>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{laneKey}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <LaneBadge>entry {lane.entry}</LaneBadge>
          {lane.wipLimit === undefined ? null : <LaneBadge>WIP {lane.wipLimit}</LaneBadge>}
          {lane.terminal ? <LaneBadge>terminal</LaneBadge> : null}
        </div>
      </header>
      <div className="flex flex-col gap-2">
        {pipeline.length === 0 ? (
          <p className="rounded-md border border-dashed border-border/70 bg-muted/20 p-2 text-xs text-muted-foreground">
            No steps
          </p>
        ) : (
          pipeline.map((step) => {
            const stepKey = String(step.key);
            return (
              <StepBlock
                key={stepKey}
                laneKey={laneKey}
                laneName={lane.name}
                step={step}
                selected={selectedStepKey === stepKey}
                disabled={disabled}
                onSelect={() => onSelectStep(stepKey)}
              />
            );
          })
        )}
      </div>
      <div
        className={cn(
          "grid gap-1.5 rounded-md border border-dashed border-border/70 p-2 text-xs text-muted-foreground",
          "bg-muted/12",
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <p className="text-center font-medium">Add step</p>
        <div className="grid grid-cols-5 gap-1">
          <Button
            size="icon-xs"
            variant="outline"
            aria-label={`Add agent step to ${lane.name}`}
            disabled={disabled}
            onClick={() => onAddStep("agent")}
          >
            <BotIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="outline"
            aria-label={`Add script step to ${lane.name}`}
            disabled={disabled}
            onClick={() => onAddStep("script")}
          >
            <TerminalIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="outline"
            aria-label={`Add approval step to ${lane.name}`}
            disabled={disabled}
            onClick={() => onAddStep("approval")}
          >
            <CheckSquareIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="outline"
            aria-label={`Add merge step to ${lane.name}`}
            disabled={disabled}
            onClick={() => onAddStep("merge")}
          >
            <GitMergeIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="outline"
            aria-label={`Add pull request step to ${lane.name}`}
            disabled={disabled}
            onClick={() => onAddStep("pullRequest")}
          >
            <GitPullRequestIcon className="size-3.5" />
          </Button>
        </div>
      </div>
    </section>
  );
}

function LaneBadge({ children }: { readonly children: ReactNode }) {
  return (
    <span className="rounded-sm border border-border/60 bg-background/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      {children}
    </span>
  );
}
