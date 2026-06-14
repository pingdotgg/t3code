/**
 * The spatial nodes painted into the planning stage: the SVG edge lines, the
 * per-grouping anchors (owner headers / epic anchors), the story frames, and the
 * All-band epic overview overlay. Extracted from t3work-PlanningSpaceView.tsx.
 */

import { PlanningStoryFrame } from "./t3work-PlanningSpaceStoryFrame";
import { UNASSIGNED_OWNER_KEY } from "./t3work-planningSpaceLayout";
import type { PlanningSpaceController } from "./t3work-usePlanningSpaceController";
import {
  epicColor,
  formatHours,
  initialsOf,
  ownerColor,
} from "./t3work-planningSpaceViewConstants";

export function PlanningSpaceStageNodes({ c }: { c: PlanningSpaceController }) {
  const { vm } = c;
  const nodeRef = c.handlers.nodeRef;
  return (
    <>
      <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
        {vm.data.stories.map((story) => (
          <line
            key={story.id}
            ref={(el) => {
              if (el) c.edgeRefs.current.set(story.id, el);
              else c.edgeRefs.current.delete(story.id);
            }}
            stroke={epicColor(story.epicId, vm.data.epicOrder)}
            strokeWidth={1}
            strokeOpacity={0}
          />
        ))}
      </svg>

      {[...vm.layout.anchors.keys()].map((anchorId) => {
        if (c.grouping === "owner") {
          const isUnassigned = anchorId === UNASSIGNED_OWNER_KEY;
          const name = isUnassigned ? "Unassigned" : (vm.ownerNames.get(anchorId) ?? anchorId);
          const color = isUnassigned ? "#8a8a93" : ownerColor(anchorId);
          return (
            <div key={anchorId} ref={nodeRef(`anchor:${anchorId}`, "owner")} className="t3ps-node">
              <div
                className="t3ps-inner t3ps-anchor flex items-center gap-2 rounded-md px-1.5 py-1"
                data-owner-header={anchorId}
              >
                <span
                  className="flex size-6 items-center justify-center rounded-full text-[9px] font-medium text-background"
                  style={{
                    background: isUnassigned ? "transparent" : color,
                    border: isUnassigned ? `1.5px dashed ${color}` : "none",
                    color: isUnassigned ? color : undefined,
                  }}
                >
                  {isUnassigned ? "?" : initialsOf(name)}
                </span>
                <span className="whitespace-nowrap text-[12px] text-foreground/90">{name}</span>
              </div>
            </div>
          );
        }
        const epic = vm.epicById.get(anchorId);
        if (!epic) return null;
        const color = epicColor(anchorId, vm.data.epicOrder);
        return (
          <div key={anchorId} ref={nodeRef(`anchor:${anchorId}`, "epic")} className="t3ps-node">
            <div className="t3ps-inner">
              <div
                className="t3ps-anchor relative flex size-14 items-center justify-center rounded-full border-[1.5px] text-[11px]"
                data-epic-anchor={anchorId}
                style={{ borderColor: color, color }}
              >
                {formatHours(epic.totalHoursSeconds)}
                <div className="t3ps-elabel pointer-events-none absolute bottom-[60px] left-1/2 -translate-x-1/2 text-center">
                  <div
                    className="t3ps-ename line-clamp-2 text-[12px] font-medium leading-snug"
                    style={{ color }}
                  >
                    {epic.title}
                  </div>
                  <div className="t3ps-estat mt-0.5 text-[9.5px] text-muted-foreground">
                    {epic.storyIds.length} items · {formatHours(epic.totalHoursSeconds)} ·{" "}
                    {epic.readyCount} ready
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })}

      {vm.data.stories.map((story) => (
        <PlanningStoryFrame
          key={story.id}
          story={story}
          color={epicColor(story.epicId, vm.data.epicOrder)}
          frameRef={nodeRef(story.id, "frame")}
          assignTarget={c.assignTarget}
          onSetSubtaskHours={c.handleSetSubtaskHours}
          onContextMenu={c.onTicketContextMenu}
        />
      ))}

      {c.allMode ? (
        <div className="t3ps-allov absolute inset-0 z-20 bg-background/95">
          {vm.allTiles.map((tile) => {
            const epic = vm.epicById.get(tile.epicId);
            if (!epic) return null;
            const color = epicColor(tile.epicId, vm.data.epicOrder);
            return (
              <button
                key={tile.epicId}
                type="button"
                data-epic-tile={tile.epicId}
                className="absolute flex flex-col gap-1 overflow-hidden rounded-lg border bg-background/90 p-3 text-left hover:border-foreground/30"
                style={{
                  left: tile.left,
                  top: tile.top,
                  width: tile.width,
                  height: tile.height,
                  borderColor: `${color}66`,
                }}
              >
                <span className="line-clamp-2 text-[12px] font-medium leading-snug" style={{ color }}>
                  {epic.title}
                </span>
                <span className="mt-auto text-[10.5px] tabular-nums text-muted-foreground">
                  {epic.storyIds.length} items · {formatHours(epic.totalHoursSeconds)} ·{" "}
                  {epic.readyCount} ready
                </span>
                <span className="flex h-1 w-full overflow-hidden rounded-full bg-muted">
                  <span
                    className="h-full"
                    style={{
                      width: `${
                        epic.storyIds.length > 0 ? (epic.readyCount / epic.storyIds.length) * 100 : 0
                      }%`,
                      background: color,
                    }}
                  />
                </span>
              </button>
            );
          })}
          <span className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[10.5px] text-muted-foreground">
            Epic overview — double-click a tile to enter its cluster
          </span>
        </div>
      ) : null}
    </>
  );
}
