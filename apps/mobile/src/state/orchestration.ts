import { createOrchestrationEnvironmentAtoms } from "@t3tools/client-runtime/state/orchestration";

import { connectionAtomRuntime } from "../connection/runtime";
import { recordReviewTurnDiffAnswer } from "./reviewTurnDiffs";
import { environmentShell } from "./shell";

export const orchestrationEnvironment = createOrchestrationEnvironmentAtoms(connectionAtomRuntime, {
  shellState: environmentShell.stateValueAtom,
  onCheckpointDiffAnswer: recordReviewTurnDiffAnswer,
});
