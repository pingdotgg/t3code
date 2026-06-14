/**
 * Intent handlers for the planning space: the interaction-machine dispatch, the
 * intent applier (assign / sprint / reparent / detail / spotlight / framing),
 * group framing, and the toast helper. Each reads live state from the
 * controller's `ctxRef`. Extracted verbatim from t3work-PlanningSpaceView.tsx.
 */

import type { MutableRefObject } from "react";

import {
  type InteractionState,
  type PlanningIntent,
  reducePlanningEvent,
} from "./t3work-planningSpaceInteractions";
import { UNASSIGNED_OWNER_KEY } from "./t3work-planningSpaceLayout";
import type { PlanningSpaceCtx } from "./t3work-planningSpaceControllerTypes";

export interface PlanningSpaceIntentHandlers {
  showToast: (message: string) => void;
  ownerNameOf: (ownerId: string | null) => string;
  frameGroup: (group: { kind: string; ownerId?: string | null; epicId?: string }) => void;
  applyIntents: (intents: ReadonlyArray<PlanningIntent>) => void;
  dispatch: (event: Parameters<typeof reducePlanningEvent>[1]) => void;
}

export function createPlanningSpaceIntentHandlers(
  ctxRef: MutableRefObject<PlanningSpaceCtx>,
): PlanningSpaceIntentHandlers {
  const showToast = (message: string) => {
    const c = ctxRef.current;
    c.setToast(message);
    if (c.toastTimer.current) clearTimeout(c.toastTimer.current);
    c.toastTimer.current = setTimeout(() => c.setToast(null), 2400);
  };

  const ownerNameOf = (ownerId: string | null): string =>
    ownerId === null ? "Unassigned" : (ctxRef.current.vm.ownerNames.get(ownerId) ?? ownerId);

  const frameGroup = (group: { kind: string; ownerId?: string | null; epicId?: string }) => {
    const c = ctxRef.current;
    const { data, layout } = c.vm;
    const engine = c.engineRef.current;
    if (!engine) return;
    if (group.kind === "owner" && c.grouping !== "owner") {
      // Dock double-click from another grouping: switch to by-owner first,
      // then frame the member once the new layout exists (§6.1).
      c.setGrouping("owner");
      c.setPendingFrameOwner(group.ownerId ?? UNASSIGNED_OWNER_KEY);
      return;
    }
    const anchorId =
      group.kind === "epic" ? (group.epicId ?? "") : (group.ownerId ?? UNASSIGNED_OWNER_KEY);
    const members = data.stories.filter((story) =>
      group.kind === "epic"
        ? story.epicId === anchorId
        : (story.ownerId ?? UNASSIGNED_OWNER_KEY) === anchorId,
    );
    const frames = members
      .map((story) => layout.frames.get(story.id))
      .filter((frame): frame is NonNullable<typeof frame> => frame !== undefined);
    if (frames.length === 0) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const frame of frames) {
      minX = Math.min(minX, frame.centerX - 240);
      maxX = Math.max(maxX, frame.centerX + 240);
      minY = Math.min(minY, frame.centerY - frame.height / 2 - 140);
      maxY = Math.max(maxY, frame.centerY + frame.height / 2);
    }
    c.userNavigated.current = true;
    c.setAllMode(false);
    engine.requestFit({ minX, maxX, minY, maxY });
  };

  const applyIntents = (intents: ReadonlyArray<PlanningIntent>) => {
    const c = ctxRef.current;
    const { epicById, layout } = c.vm;
    for (const intent of intents) {
      switch (intent.type) {
        case "panBy":
          break; // handled incrementally in the move handler
        case "personDragStart": {
          c.setDragActive(true);
          const ghost = c.ghostRef.current;
          if (ghost) ghost.style.display = "block";
          break;
        }
        case "personDragEnd": {
          c.setDragActive(false);
          const ghost = c.ghostRef.current;
          if (ghost) ghost.style.display = "none";
          break;
        }
        case "assign": {
          if (c.mutations?.onAssign) {
            c.mutations.onAssign(intent.item, intent.ownerId);
            showToast(
              `${intent.item.kind === "story" ? intent.item.storyId : "Subtask"} → ${ownerNameOf(intent.ownerId)}`,
            );
          } else {
            showToast("Assigning isn't available here");
          }
          break;
        }
        case "setSprintMembership": {
          if (c.mutations?.onSetSprintMembership) {
            c.mutations.onSetSprintMembership(intent.storyId, intent.inSprint);
            showToast(
              `${intent.storyId} ${intent.inSprint ? "committed to sprint" : "moved out of sprint"}`,
            );
          } else {
            showToast("Sprint moves aren't wired to Jira yet");
          }
          break;
        }
        case "reparent": {
          if (c.mutations?.onReparent) {
            c.mutations.onReparent(intent.storyId, intent.epicId);
            showToast(
              `${intent.storyId} moved to ${epicById.get(intent.epicId)?.title.slice(0, 32) ?? intent.epicId}`,
            );
          } else {
            showToast("Moving between epics isn't wired to Jira yet");
          }
          break;
        }
        case "openDetail":
          c.setDetailItem(intent.item);
          break;
        case "closeDetail":
          c.setDetailItem(null);
          break;
        case "assignModeStart":
          c.setAssignTarget(intent.item);
          break;
        case "assignModeEnd":
          c.setAssignTarget(null);
          break;
        case "spotlightToggle":
          c.setSpotlight((current: InteractionState["spotlight"]) =>
            current && JSON.stringify(current) === JSON.stringify(intent.group)
              ? null
              : (intent.group as InteractionState["spotlight"]),
          );
          break;
        case "spotlightClear":
          c.setSpotlight(null);
          break;
        case "frameGroup":
          frameGroup(intent.group);
          break;
        case "frameItem": {
          // Double-click quick zoom: dive onto the card; a second double-click
          // on the same card restores the previous camera.
          const engine = c.engineRef.current;
          const frame = layout.frames.get(intent.item.storyId);
          if (!engine || !frame) break;
          c.userNavigated.current = true;
          const previous = c.zoomToggleRef.current;
          if (previous && previous.id === intent.item.storyId) {
            c.zoomToggleRef.current = null;
            engine.setCameraTarget(previous.camera);
            break;
          }
          c.zoomToggleRef.current = {
            id: intent.item.storyId,
            camera: engine.cameraTargetSnapshot,
          };
          engine.requestFit({
            minX: frame.centerX - 300,
            maxX: frame.centerX + 300,
            minY: frame.centerY - frame.height / 2 - 80,
            maxY: frame.centerY + frame.height / 2 + 80,
          });
          break;
        }
      }
    }
  };

  const dispatch = (event: Parameters<typeof reducePlanningEvent>[1]) => {
    const c = ctxRef.current;
    const result = reducePlanningEvent(c.machineState.current, event);
    c.machineState.current = result.state;
    if (import.meta.env.DEV) {
      const win = window as unknown as Record<string, unknown>;
      const log = (win["__t3psLog"] as unknown[]) ?? [];
      log.push({
        event: event.type,
        hit: "hit" in event ? event.hit : null,
        intents: result.intents.map((intent) => intent.type),
      });
      win["__t3psLog"] = log.slice(-20);
    }
    applyIntents(result.intents);
  };

  return { showToast, ownerNameOf, frameGroup, applyIntents, dispatch };
}
