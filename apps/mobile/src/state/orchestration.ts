import { createOrchestrationEnvironmentAtoms } from "@lathe/client-runtime/state/orchestration";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentShell } from "./shell";
import { recordReviewTurnDiffAnswer } from "./reviewTurnDiffs";

export const orchestrationEnvironment = createOrchestrationEnvironmentAtoms(connectionAtomRuntime, {
  shellState: environmentShell.stateValueAtom,
  onCheckpointDiffAnswer: recordReviewTurnDiffAnswer,
});
