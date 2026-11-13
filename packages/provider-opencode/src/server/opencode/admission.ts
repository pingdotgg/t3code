/**
 * Prompt admission state machine for OpenCode sessions without native turn ids.
 */
import * as Effect from "effect/Effect";
import type {
  ActiveOpenCodeTurn,
  OpenCodeRequestOwner,
  OpenCodeSubagentContext,
  OpenCodeThreadState,
} from "./types.ts";

export type OpenCodeAdmissionSignal =
  | "accepted"
  | "assistant-completed"
  | "busy"
  | "idle"
  | "user-message";

export type OpenCodeAdmissionAction = "hold" | "reconcile-idle" | "release";

export function advanceOpenCodePromptAdmission(
  admission: Pick<
    ActiveOpenCodeTurn,
    "admissionAccepted" | "admissionMessageObserved" | "admissionPending" | "idleDuringAdmission"
  >,
  signal: OpenCodeAdmissionSignal,
): OpenCodeAdmissionAction {
  if (!admission.admissionPending) return "release";
  if (signal === "assistant-completed") {
    admission.admissionAccepted = true;
    admission.admissionMessageObserved = true;
    admission.admissionPending = false;
    return "release";
  }
  if (signal === "idle") {
    admission.idleDuringAdmission = true;
    return "hold";
  }
  if (signal === "accepted") admission.admissionAccepted = true;
  if (signal === "busy" || signal === "user-message") admission.admissionMessageObserved = true;
  if (!admission.admissionAccepted || !admission.admissionMessageObserved) return "hold";
  if (admission.idleDuringAdmission) return "reconcile-idle";
  admission.admissionPending = false;
  return "release";
}

export function cancelOpenCodePromptAdmission(
  admission: Pick<ActiveOpenCodeTurn, "admissionGeneration" | "admissionPending">,
  nextGeneration: number,
): void {
  admission.admissionGeneration = nextGeneration;
  admission.admissionPending = false;
}

export const reconcileOpenCodePromptAdmissionStatus = Effect.fn(
  "reconcileOpenCodePromptAdmissionStatus",
)(function* (
  admission: Pick<ActiveOpenCodeTurn, "admissionGeneration" | "admissionPending">,
  generation: number,
  readStatus: Effect.Effect<"busy" | "idle" | "unknown">,
) {
  if (admission.admissionGeneration !== generation || !admission.admissionPending) {
    return "stale" as const;
  }
  const status = yield* readStatus;
  if (admission.admissionGeneration !== generation || !admission.admissionPending) {
    return "stale" as const;
  }
  if (status !== "unknown") admission.admissionPending = false;
  return status;
});

export function topLevelRequestOwner(state: OpenCodeThreadState): OpenCodeRequestOwner | undefined {
  let owner = state;
  let subagent: OpenCodeSubagentContext | null = null;
  while (owner.parentSubagent !== null) {
    subagent = owner.parentSubagent;
    owner = subagent.parentState;
  }
  return owner.activeTurn === null ? undefined : { state: owner, turn: owner.activeTurn, subagent };
}
