import { LaneKey } from "@t3tools/contracts";
import {
  DndContext,
  type DragEndEvent,
  pointerWithin,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PlusIcon, Undo2Icon } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  addLane,
  addStep,
  setLaneOn,
  updateStep,
  type WorkflowEditorModel,
  type WorkflowEditorSelection,
} from "~/workflow/editorModel";

import { LaneForm } from "../LaneForm";
import { TransitionFields } from "../RoutingEditor";
import { StepFields } from "../StepFields";
import { LaneCard } from "./LaneCard";
import {
  LaneRouteClearDropZone,
  readLaneMoveDragData,
  resolveLaneRoutingDrop,
  type LaneRoutingKind,
} from "./RoutingHandles";
import { RoutingEdges, type CanvasAnchors } from "./RoutingEdges";
import {
  computeCanvasLayout,
  LANE_CARD_WIDTH,
  LANE_GAP_X,
  LANE_GAP_Y,
  type LaneHeights,
  type LanePositions,
} from "./canvasLayout";

type WorkflowEditorSelectionMutation = (
  selection: WorkflowEditorSelection | null,
) => WorkflowEditorSelection | null;
type WorkflowEditorMutation = (
  mutate: (model: WorkflowEditorModel) => WorkflowEditorModel,
  mutateSelection?: WorkflowEditorSelectionMutation,
) => void;
type WorkflowLaneEncoded = WorkflowEditorModel["definition"]["lanes"][number];
type WorkflowStepType = NonNullable<WorkflowLaneEncoded["pipeline"]>[number]["type"];

export const canvasRouteCollisionDetection = pointerWithin;

export interface CanvasViewProps {
  readonly model: WorkflowEditorModel;
  readonly selection: WorkflowEditorSelection | null;
  readonly disabled?: boolean;
  readonly onSelect: (selection: WorkflowEditorSelection | null) => void;
  readonly onMutate: WorkflowEditorMutation;
}

export function CanvasView({
  model,
  selection,
  disabled = false,
  onSelect,
  onMutate,
}: CanvasViewProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(
    LANE_CARD_WIDTH * Math.max(1, model.definition.lanes.length) +
      LANE_GAP_X * Math.max(0, model.definition.lanes.length - 1),
  );
  const [laneHeights, setLaneHeights] = useState<LaneHeights>({});
  const [lanePositions, setLanePositions] = useState<LanePositions>({});
  const [anchors, setAnchors] = useState<CanvasAnchors>({});
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );
  const layout = useMemo(
    () => computeCanvasLayout(model.definition, containerWidth, laneHeights, lanePositions),
    [containerWidth, laneHeights, lanePositions, model.definition],
  );
  const hasMovedLanes = Object.keys(lanePositions).length > 0;
  const resetLaneLayout = useCallback(() => setLanePositions({}), []);
  const layoutByLaneKey = useMemo(
    () => new Map(layout.lanes.map((laneLayout) => [laneLayout.laneKey, laneLayout])),
    [layout.lanes],
  );
  const selectedStepKeyByLane =
    selection?.kind === "step" ? { laneKey: selection.laneKey, stepKey: selection.stepKey } : null;

  const handleAddLane = () => {
    onMutate((current) => {
      const next = addLane(current);
      const laneKey = String(next.definition.lanes.at(-1)?.key ?? "");
      if (laneKey) {
        onSelect({ kind: "lane", laneKey });
      }
      return next;
    });
  };

  const handleAddStep = (laneKey: string, type: WorkflowStepType) => {
    onMutate((current) => {
      const next = addStep(current, laneKey, type);
      const lane = next.definition.lanes.find((candidate) => String(candidate.key) === laneKey);
      const stepKey = String(lane?.pipeline?.at(-1)?.key ?? "");
      if (stepKey) {
        onSelect({ kind: "step", laneKey, stepKey });
      }
      return next;
    });
  };

  const handleSetLaneRoute = (
    laneKey: string,
    kind: LaneRoutingKind,
    targetLaneKey: string | undefined,
  ) => {
    const laneKeys = model.definition.lanes.map((lane) => String(lane.key));
    if (targetLaneKey !== undefined && !laneKeys.includes(targetLaneKey)) {
      return;
    }
    onMutate((current) => setLaneOn(current, laneKey, kind, targetLaneKey));
  };

  const handleSetStepRoute = (
    laneKey: string,
    stepKey: string,
    kind: LaneRoutingKind,
    targetLaneKey: string | undefined,
  ) => {
    const laneKeys = model.definition.lanes.map((lane) => String(lane.key));
    if (targetLaneKey !== undefined && !laneKeys.includes(targetLaneKey)) {
      return;
    }
    onMutate((current) => {
      const lane = current.definition.lanes.find((candidate) => String(candidate.key) === laneKey);
      const step = lane?.pipeline?.find((candidate) => String(candidate.key) === stepKey);
      if (!step) {
        return current;
      }
      const nextOn = {
        ...step.on,
        [kind]: targetLaneKey === undefined ? undefined : LaneKey.make(targetLaneKey),
      };
      for (const routeKind of ["success", "failure", "blocked"] as const) {
        if (nextOn[routeKind] === undefined) {
          delete nextOn[routeKind];
        }
      }
      return updateStep(current, laneKey, stepKey, {
        on: Object.keys(nextOn).length === 0 ? undefined : nextOn,
      });
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const move = readLaneMoveDragData(event.active.data.current);
    if (move) {
      const current = layoutByLaneKey.get(move.laneKey);
      if (current && (event.delta.x !== 0 || event.delta.y !== 0)) {
        setLanePositions((positions) => ({
          ...positions,
          [move.laneKey]: {
            x: Math.max(0, Math.round(current.x + event.delta.x)),
            y: Math.max(0, Math.round(current.y + event.delta.y)),
          },
        }));
      }
      return;
    }

    const laneKeys = model.definition.lanes.map((lane) => String(lane.key));
    const drop = resolveLaneRoutingDrop(
      laneKeys,
      event.active.data.current,
      event.over?.data.current ?? null,
    );
    if (!drop) {
      return;
    }
    if (drop.stepKey) {
      handleSetStepRoute(drop.laneKey, drop.stepKey, drop.kind, drop.targetLaneKey);
      return;
    }
    handleSetLaneRoute(drop.laneKey, drop.kind, drop.targetLaneKey);
  };

  const measureCanvasSize = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const viewportRect = viewport.getBoundingClientRect();
    const nextWidth = Math.max(viewport.clientWidth, viewportRect.width, LANE_CARD_WIDTH);
    setContainerWidth((current) => (Math.abs(current - nextWidth) > 0.5 ? nextWidth : current));

    const nextLaneHeights: Record<string, number> = {};
    for (const lane of model.definition.lanes) {
      const laneKey = String(lane.key);
      const element = document.getElementById(`lane-${laneKey}`);
      if (element) {
        nextLaneHeights[laneKey] = Math.ceil(element.getBoundingClientRect().height);
      }
    }
    setLaneHeights((current) =>
      shallowNumberRecordEqual(current, nextLaneHeights) ? current : nextLaneHeights,
    );
  }, [model.definition]);

  const measureAnchors = useCallback(() => {
    const content = contentRef.current;
    if (!content) {
      return;
    }

    const contentRect = content.getBoundingClientRect();
    const nextAnchors: Record<string, { x: number; y: number }> = {};
    for (const element of content.querySelectorAll<HTMLElement>("[data-canvas-anchor][id]")) {
      const rect = element.getBoundingClientRect();
      nextAnchors[element.id] = {
        x: rect.left - contentRect.left + rect.width / 2,
        y: rect.top - contentRect.top + rect.height / 2,
      };
    }
    setAnchors((current) =>
      shallowPointRecordEqual(current, nextAnchors) ? current : nextAnchors,
    );
  }, []);

  useLayoutEffect(() => {
    measureCanvasSize();
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) {
      return undefined;
    }

    const resizeObserver = new ResizeObserver(() => measureCanvasSize());
    resizeObserver.observe(viewport);
    for (const lane of model.definition.lanes) {
      const laneElement = document.getElementById(`lane-${String(lane.key)}`);
      if (laneElement) {
        resizeObserver.observe(laneElement);
      }
    }

    viewport.addEventListener("scroll", measureAnchors);
    window.addEventListener("scroll", measureAnchors, true);
    return () => {
      resizeObserver.disconnect();
      viewport.removeEventListener("scroll", measureAnchors);
      window.removeEventListener("scroll", measureAnchors, true);
    };
  }, [measureAnchors, measureCanvasSize, model.definition.lanes]);

  useLayoutEffect(() => {
    measureAnchors();
  }, [containerWidth, layout, measureAnchors]);

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background"
      aria-label="Workflow canvas"
      role="region"
    >
      <DndContext
        sensors={sensors}
        collisionDetection={canvasRouteCollisionDetection}
        onDragEnd={handleDragEnd}
      >
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(20rem,30rem)] overflow-hidden max-lg:grid-cols-1">
          <div ref={viewportRef} className="min-h-0 overflow-auto p-4">
            <div
              ref={contentRef}
              data-testid="workflow-canvas-surface"
              className="relative"
              style={{
                minHeight: Math.max(layout.height + LANE_CARD_WIDTH / 2, 320),
                minWidth: layout.width,
              }}
              onClick={() => onSelect(null)}
            >
              <RoutingEdges
                definition={model.definition}
                layout={layout}
                anchors={anchors}
                selection={selection}
                onSelect={onSelect}
              />
              <LaneRouteClearDropZone />
              {model.definition.lanes.map((lane) => {
                const laneKey = String(lane.key);
                const laneLayout = layoutByLaneKey.get(laneKey);
                return laneLayout ? (
                  <LaneCard
                    key={laneKey}
                    lane={lane}
                    layout={laneLayout}
                    selected={selection?.kind === "lane" && selection.laneKey === laneKey}
                    selectedStepKey={
                      selectedStepKeyByLane?.laneKey === laneKey
                        ? selectedStepKeyByLane.stepKey
                        : undefined
                    }
                    disabled={disabled}
                    onSelect={() => onSelect({ kind: "lane", laneKey })}
                    onSelectStep={(stepKey) => onSelect({ kind: "step", laneKey, stepKey })}
                    onAddStep={(type) => handleAddStep(laneKey, type)}
                    onClearRoute={(kind) => handleSetLaneRoute(laneKey, kind, undefined)}
                  />
                ) : null;
              })}
              <div
                className="absolute flex items-center justify-center rounded-md border border-dashed border-border/70 bg-muted/16 p-3"
                style={{
                  left: 0,
                  top: Math.max(layout.height + LANE_GAP_Y, 180),
                  width: LANE_CARD_WIDTH,
                }}
                onClick={(event) => event.stopPropagation()}
              >
                <Button size="sm" variant="outline" disabled={disabled} onClick={handleAddLane}>
                  <PlusIcon className="size-4" />
                  Add lane
                </Button>
              </div>
            </div>
          </div>
          <CanvasInspector
            model={model}
            selection={selection}
            disabled={disabled}
            onMutate={onMutate}
            onSelect={onSelect}
          />
        </div>
      </DndContext>
      <RoutingLegend canMoveReset={hasMovedLanes} onResetLayout={resetLaneLayout} />
    </section>
  );
}

function CanvasInspector({
  model,
  selection,
  disabled,
  onMutate,
  onSelect,
}: {
  readonly model: WorkflowEditorModel;
  readonly selection: WorkflowEditorSelection | null;
  readonly disabled: boolean;
  readonly onMutate: WorkflowEditorMutation;
  readonly onSelect: (selection: WorkflowEditorSelection | null) => void;
}) {
  const lane =
    selection === null
      ? null
      : (model.definition.lanes.find((candidate) => String(candidate.key) === selection.laneKey) ??
        null);

  return (
    <aside
      aria-label="Canvas inspector"
      className="flex min-h-0 flex-col border-l border-border bg-muted/12 max-lg:border-l-0 max-lg:border-t"
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">Inspector</h3>
        {model.dirty ? (
          <span className="text-xs font-medium text-warning">Unsaved canvas changes</span>
        ) : null}
      </header>
      {selection === null ? (
        <div className="p-4 text-sm text-muted-foreground">
          Select a lane, step, or route to edit.
        </div>
      ) : null}
      {selection?.kind === "lane" && lane ? (
        <LaneForm
          model={model}
          lane={lane}
          lanes={model.definition.lanes}
          lintErrors={model.lintErrors}
          disabled={disabled}
          onMutate={onMutate}
          onSelectLane={(laneKey) => onSelect({ kind: "lane", laneKey })}
        />
      ) : null}
      {selection?.kind === "step" && lane ? (
        <StepInspector
          lane={lane}
          stepKey={selection.stepKey}
          lanes={model.definition.lanes}
          disabled={disabled}
          onMutate={onMutate}
        />
      ) : null}
      {selection?.kind === "transition" && lane ? (
        <TransitionInspector
          lane={lane}
          transitionIndex={selection.index}
          lanes={model.definition.lanes}
          lintErrors={model.lintErrors}
          disabled={disabled}
          onMutate={onMutate}
        />
      ) : null}
    </aside>
  );
}

function StepInspector({
  lane,
  stepKey,
  lanes,
  disabled,
  onMutate,
}: {
  readonly lane: WorkflowLaneEncoded;
  readonly stepKey: string;
  readonly lanes: ReadonlyArray<WorkflowLaneEncoded>;
  readonly disabled: boolean;
  readonly onMutate: WorkflowEditorMutation;
}) {
  const laneKey = String(lane.key);
  const step = lane.pipeline?.find((candidate) => String(candidate.key) === stepKey);
  if (!step) {
    return <div className="p-4 text-sm text-muted-foreground">Step no longer exists.</div>;
  }

  return (
    <section className="@container min-h-0 overflow-auto p-4">
      <div className="mb-4">
        <h4 className="text-sm font-semibold text-foreground">{stepKey}</h4>
        <p className="mt-1 text-xs text-muted-foreground">
          {lane.name} / {step.type}
        </p>
      </div>
      <StepFields
        laneKey={laneKey}
        lanes={lanes}
        step={step}
        disabled={disabled}
        onMutate={onMutate}
      />
    </section>
  );
}

function TransitionInspector({
  lane,
  transitionIndex,
  lanes,
  lintErrors,
  disabled,
  onMutate,
}: {
  readonly lane: WorkflowLaneEncoded;
  readonly transitionIndex: number;
  readonly lanes: ReadonlyArray<WorkflowLaneEncoded>;
  readonly lintErrors: WorkflowEditorModel["lintErrors"];
  readonly disabled: boolean;
  readonly onMutate: WorkflowEditorMutation;
}) {
  const laneKey = String(lane.key);
  const transition = lane.transitions?.[transitionIndex];
  if (!transition) {
    return <div className="p-4 text-sm text-muted-foreground">Transition no longer exists.</div>;
  }

  return (
    <section className="@container min-h-0 overflow-auto p-4">
      <ol className="space-y-3">
        <TransitionFields
          laneKey={laneKey}
          lanes={lanes}
          transition={transition}
          transitionIndex={transitionIndex}
          lintErrors={lintErrors.filter(
            (lintError) =>
              String(lintError.laneKey ?? "") === laneKey &&
              lintError.transitionIndex === transitionIndex,
          )}
          disabled={disabled}
          onMutate={onMutate}
        />
      </ol>
    </section>
  );
}

function RoutingLegend({
  canMoveReset,
  onResetLayout,
}: {
  readonly canMoveReset: boolean;
  readonly onResetLayout: () => void;
}) {
  return (
    <footer className="border-t border-border bg-muted/16 px-4 py-2">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">Routing precedence</span>
        <span>Step routes &gt; transitions &gt; lane fallback</span>
        <span className="inline-flex items-center gap-1">
          <span className="h-px w-6 bg-success" />
          success
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-px w-6 bg-warning" />
          blocked
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-px w-6 bg-destructive" />
          failure
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-px w-6 bg-muted-foreground" /># transition
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-px w-6 border-t border-dashed border-muted-foreground" />
          lane fallback
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-px w-6 border-t border-dotted border-info" />
          action
        </span>
        {canMoveReset ? (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-6 px-2"
            onClick={onResetLayout}
            data-testid="canvas-reset-layout"
          >
            <Undo2Icon className="size-3.5" />
            Reset layout
          </Button>
        ) : null}
      </div>
    </footer>
  );
}

function shallowNumberRecordEqual(a: LaneHeights, b: LaneHeights): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key) => {
      const heightB = b[key];
      return heightB !== undefined && Math.abs((a[key] ?? 0) - heightB) <= 0.5;
    })
  );
}

function shallowPointRecordEqual(a: CanvasAnchors, b: CanvasAnchors): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key) => {
      const pointA = a[key];
      const pointB = b[key];
      return (
        pointA !== undefined &&
        pointB !== undefined &&
        Math.abs(pointA.x - pointB.x) <= 0.5 &&
        Math.abs(pointA.y - pointB.y) <= 0.5
      );
    })
  );
}
