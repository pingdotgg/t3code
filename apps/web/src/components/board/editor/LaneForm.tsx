import type { WorkflowLintError } from "@t3tools/contracts";
import { Trash2Icon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  addLaneAction,
  lintErrorKey,
  removeLane,
  removeLaneAction,
  renameLane,
  setLaneColor,
  setLaneEntry,
  setLaneTerminal,
  setLaneWipLimit,
  updateLaneAction,
  type WorkflowEditorModel,
} from "~/workflow/editorModel";

import { PipelineEditor } from "./PipelineEditor";
import { RoutingEditor } from "./RoutingEditor";
import {
  lintErrorMatchesLane,
  type WorkflowEditorMutation,
  type WorkflowLaneEncoded,
} from "./WorkflowEditor";

export function LaneForm({
  model,
  lane,
  lanes,
  lintErrors,
  disabled = false,
  onMutate,
  onSelectLane,
}: {
  readonly model: WorkflowEditorModel;
  readonly lane: WorkflowLaneEncoded;
  readonly lanes: ReadonlyArray<WorkflowLaneEncoded>;
  readonly lintErrors: ReadonlyArray<WorkflowLintError>;
  readonly disabled?: boolean;
  readonly onMutate: WorkflowEditorMutation;
  readonly onSelectLane: (laneKey: string) => void;
}) {
  const laneKey = String(lane.key);
  const laneLintErrors = lintErrors.filter(
    (lintError) =>
      lintErrorMatchesLane(lintError, laneKey) &&
      lintError.stepKey === undefined &&
      lintError.transitionIndex === undefined,
  );

  return (
    <section className="@container flex min-h-0 flex-col overflow-auto">
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-foreground">{lane.name}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{laneKey}</p>
          </div>
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={disabled || model.definition.lanes.length <= 1}
            onClick={() => {
              onMutate((current) => removeLane(current, laneKey));
              const fallback = model.definition.lanes.find(
                (candidate) => candidate.key !== lane.key,
              );
              onSelectLane(String(fallback?.key ?? ""));
            }}
          >
            <Trash2Icon className="size-4" />
            Remove lane
          </Button>
        </div>
        {laneLintErrors.length > 0 ? (
          <ul className="rounded-md border border-warning/45 bg-warning/8 p-2 text-sm text-warning-foreground">
            {laneLintErrors.map((lintError) => (
              <li key={lintErrorKey(lintError)}>{lintError.message}</li>
            ))}
          </ul>
        ) : null}
        <div className="grid gap-3 @2xl:grid-cols-2">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Lane name</span>
            <Input
              aria-label="Lane name"
              value={lane.name}
              disabled={disabled}
              onChange={(event) => {
                const value = event.currentTarget.value;
                onMutate((current) => renameLane(current, laneKey, value));
              }}
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Lane entry</span>
            <select
              aria-label="Lane entry"
              className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
              value={lane.entry}
              disabled={disabled}
              onChange={(event) => {
                const value = event.currentTarget.value as WorkflowLaneEncoded["entry"];
                onMutate((current) => setLaneEntry(current, laneKey, value));
              }}
            >
              <option value="manual">manual</option>
              <option value="auto">auto</option>
            </select>
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">WIP limit</span>
            <Input
              aria-label="WIP limit"
              nativeInput
              type="number"
              min={1}
              value={lane.wipLimit ?? ""}
              disabled={disabled}
              onChange={(event) => {
                const raw = event.currentTarget.value;
                onMutate((current) =>
                  setLaneWipLimit(current, laneKey, raw === "" ? undefined : Number(raw)),
                );
              }}
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Lane color</span>
            <Input
              aria-label="Lane color"
              value={lane.color ?? ""}
              placeholder="#3b82f6"
              disabled={disabled}
              onChange={(event) => {
                const color = event.currentTarget.value.trim();
                onMutate((current) => setLaneColor(current, laneKey, color || undefined));
              }}
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={lane.terminal ?? false}
              disabled={disabled}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                onMutate((current) => setLaneTerminal(current, laneKey, checked || undefined));
              }}
            />
            Terminal lane
          </label>
        </div>
        <LaneActionsEditor lane={lane} lanes={lanes} disabled={disabled} onMutate={onMutate} />
        <PipelineEditor
          lane={lane}
          lanes={lanes}
          lintErrors={lintErrors}
          disabled={disabled}
          onMutate={onMutate}
        />
        <RoutingEditor
          lane={lane}
          lanes={lanes}
          lintErrors={lintErrors}
          disabled={disabled}
          onMutate={onMutate}
        />
      </div>
    </section>
  );
}

function LaneActionsEditor({
  lane,
  lanes,
  disabled,
  onMutate,
}: {
  readonly lane: WorkflowLaneEncoded;
  readonly lanes: ReadonlyArray<WorkflowLaneEncoded>;
  readonly disabled: boolean;
  readonly onMutate: WorkflowEditorMutation;
}) {
  const laneKey = String(lane.key);
  const actions = lane.actions ?? [];
  return (
    <section className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Actions</h4>
          <p className="text-xs text-muted-foreground">
            Buttons shown on tickets in this lane; clicking one moves the ticket.
          </p>
        </div>
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => onMutate((current) => addLaneAction(current, laneKey))}
        >
          Add action
        </Button>
      </div>
      {actions.length === 0 ? (
        <p className="rounded-md border border-border/70 bg-muted/20 p-3 text-sm text-muted-foreground">
          No actions. Tickets here move via drag or the move menu.
        </p>
      ) : (
        <ol className="space-y-3">
          {actions.map((action, index) => (
            <li
              key={index}
              className="space-y-2 rounded-md border border-border/70 bg-muted/10 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Action {index + 1}
                </span>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove action ${index + 1} from lane ${laneKey}`}
                  disabled={disabled}
                  onClick={() => onMutate((current) => removeLaneAction(current, laneKey, index))}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
              <label className="grid gap-1">
                <span className="text-xs font-medium text-foreground">Label</span>
                <Input
                  aria-label={`Action ${index + 1} label in lane ${laneKey}`}
                  value={action.label}
                  disabled={disabled}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    onMutate((current) =>
                      updateLaneAction(current, laneKey, index, { label: value as never }),
                    );
                  }}
                />
              </label>
              <label className="grid gap-1">
                <span className="text-xs font-medium text-foreground">Moves to</span>
                <select
                  aria-label={`Action ${index + 1} target lane in lane ${laneKey}`}
                  className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  value={String(action.to)}
                  disabled={disabled}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    onMutate((current) =>
                      updateLaneAction(current, laneKey, index, { to: value as never }),
                    );
                  }}
                >
                  {lanes.map((target) => (
                    <option key={String(target.key)} value={String(target.key)}>
                      {target.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1">
                <span className="text-xs font-medium text-foreground">Hint</span>
                <Input
                  aria-label={`Action ${index + 1} hint in lane ${laneKey}`}
                  value={action.hint ?? ""}
                  placeholder="Shown as the button tooltip"
                  disabled={disabled}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    onMutate((current) =>
                      updateLaneAction(current, laneKey, index, { hint: value }),
                    );
                  }}
                />
              </label>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
