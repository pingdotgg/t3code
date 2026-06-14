/**
 * Floating panels/overlays for the planning space: the story detail panel (with
 * its leader line), the epic detail panel, the epic context menu, and the toast.
 * Extracted from t3work-PlanningSpaceView.tsx.
 */

import type { PlanningItemRef } from "./t3work-planningSpaceInteractions";
import { PlanningSpaceEpicPanel, PlanningSpacePanel } from "./t3work-PlanningSpacePanel";
import type { PlanningSpaceController } from "./t3work-usePlanningSpaceController";

export function PlanningSpacePanels({ c }: { c: PlanningSpaceController }) {
  const { vm } = c;
  const detailStory = c.detailStory;
  return (
    <>
      {detailStory ? (
        <>
          <svg className="pointer-events-none absolute inset-0 z-20 h-full w-full" aria-hidden="true">
            <line
              ref={c.leaderRef}
              stroke="#7c89ff"
              strokeWidth={1}
              strokeDasharray="4 4"
              strokeOpacity={0}
            />
          </svg>
          <PlanningSpacePanel
            story={detailStory}
            subtask={c.detailSubtask}
            epic={vm.epicById.get(detailStory.epicId) ?? null}
            assignActiveFor={
              c.assignTarget
                ? c.assignTarget.kind === "subtask"
                  ? c.assignTarget.subtaskId
                  : c.assignTarget.storyId
                : null
            }
            actions={{
              onClose: () => {
                c.machineState.current = { ...c.machineState.current, detail: null };
                c.setDetailItem(null);
              },
              onOpenSubtask: (subtaskId) => {
                const item: PlanningItemRef = { kind: "subtask", storyId: detailStory.id, subtaskId };
                c.machineState.current = { ...c.machineState.current, detail: item };
                c.setDetailItem(item);
              },
              onOpenStory: () => {
                const item: PlanningItemRef = { kind: "story", storyId: detailStory.id };
                c.machineState.current = { ...c.machineState.current, detail: item };
                c.setDetailItem(item);
              },
              onSetSubtaskHours: (subtaskId, seconds) => {
                c.mutations?.onSetSubtaskHours?.(subtaskId, seconds);
              },
              onCreateSubtask: (title) => {
                c.mutations?.onCreateSubtask?.(detailStory.id, title);
                c.handlers.showToast(`Subtask added to ${detailStory.key}`);
              },
              onSetSprintMembership: (inSprint) => {
                c.mutations?.onSetSprintMembership?.(detailStory.id, inSprint);
                c.handlers.showToast(
                  `${detailStory.key} ${inSprint ? "committed to sprint" : "moved out of sprint"}`,
                );
              },
              onFrameEpic: () => c.handlers.frameGroup({ kind: "epic", epicId: detailStory.epicId }),
              onRevealInSpace: () => {
                const frame = vm.layout.frames.get(detailStory.id);
                const engine = c.engineRef.current;
                if (frame && engine) {
                  c.userNavigated.current = true;
                  engine.flyTo(frame.centerX, frame.centerY);
                }
              },
            }}
          />
        </>
      ) : null}

      {c.epicDetailId && vm.epicById.get(c.epicDetailId) ? (
        <PlanningSpaceEpicPanel
          epic={vm.epicById.get(c.epicDetailId)!}
          stories={vm.data.stories.filter((s) => s.epicId === c.epicDetailId)}
          onClose={() => c.setEpicDetailId(null)}
          onFrame={() => c.handlers.frameGroup({ kind: "epic", epicId: c.epicDetailId! })}
          onOpenStory={(storyId) => {
            c.setEpicDetailId(null);
            const item: PlanningItemRef = { kind: "story", storyId };
            c.machineState.current = { ...c.machineState.current, detail: item };
            c.setDetailItem(item);
            const frame = vm.layout.frames.get(storyId);
            const engine = c.engineRef.current;
            if (frame && engine) {
              c.userNavigated.current = true;
              engine.flyTo(frame.centerX, frame.centerY);
            }
          }}
        />
      ) : null}

      {c.contextMenu ? (
        <div
          data-ps-chrome="true"
          className="absolute z-40 flex min-w-36 flex-col rounded-md border border-border bg-background/95 p-1"
          style={{ left: c.contextMenu.x, top: c.contextMenu.y }}
        >
          <button
            type="button"
            className="rounded px-2 py-1 text-left text-[11px] text-foreground hover:bg-accent"
            onClick={() => {
              c.setEpicDetailId(c.contextMenu!.epicId);
              c.setContextMenu(null);
            }}
          >
            Open details
          </button>
          <button
            type="button"
            className="rounded px-2 py-1 text-left text-[11px] text-foreground hover:bg-accent"
            onClick={() => {
              c.handlers.frameGroup({ kind: "epic", epicId: c.contextMenu!.epicId });
              c.setContextMenu(null);
            }}
          >
            Frame cluster
          </button>
          <button
            type="button"
            className="rounded px-2 py-1 text-left text-[11px] text-foreground hover:bg-accent"
            onClick={() => {
              const epicId = c.contextMenu!.epicId;
              const active = c.spotlight?.kind === "epic" && c.spotlight.epicId === epicId;
              const next = active ? null : ({ kind: "epic", epicId } as const);
              c.machineState.current = { ...c.machineState.current, spotlight: next };
              c.setSpotlight(next);
              c.setContextMenu(null);
            }}
          >
            {c.spotlight?.kind === "epic" && c.spotlight.epicId === c.contextMenu.epicId
              ? "Clear spotlight"
              : "Spotlight epic"}
          </button>
        </div>
      ) : null}

      {c.toast ? (
        <div className="absolute left-1/2 top-3 z-40 -translate-x-1/2 rounded-md border border-border bg-background/95 px-3 py-1.5 text-[11px] text-foreground">
          {c.toast}
        </div>
      ) : null}
    </>
  );
}
