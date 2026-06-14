/**
 * Aggregates the planning-space interaction handlers (DOM/navigation + intents)
 * into one object the controller exposes, and pins the two ref-held handlers
 * (`frameGroup`, `applyLayoutTargets`) the effects invoke. Extracted from
 * t3work-PlanningSpaceView.tsx.
 */

import type { MutableRefObject } from "react";

import {
  type PlanningSpaceDomHandlers,
  createPlanningSpaceDomHandlers,
} from "./t3work-planningSpaceHandlersDom";
import {
  type PlanningSpaceIntentHandlers,
  createPlanningSpaceIntentHandlers,
} from "./t3work-planningSpaceHandlersIntent";
import type { PlanningSpaceCtx } from "./t3work-planningSpaceControllerTypes";

export type PlanningSpaceHandlers = PlanningSpaceDomHandlers & PlanningSpaceIntentHandlers;

export function createPlanningSpaceHandlers(
  ctxRef: MutableRefObject<PlanningSpaceCtx>,
): PlanningSpaceHandlers {
  const dom = createPlanningSpaceDomHandlers(ctxRef);
  const intent = createPlanningSpaceIntentHandlers(ctxRef);
  ctxRef.current.frameGroupRef.current = intent.frameGroup;
  ctxRef.current.applyLayoutTargetsRef.current = dom.applyLayoutTargets;
  return { ...dom, ...intent };
}
