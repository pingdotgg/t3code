import { forkThread } from "@t3tools/client-runtime/operations/threadFork";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const forkThreadCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "fork thread",
  execute: forkThread,
  concurrency: {
    mode: "singleFlight",
    key: ({ environmentId, input }) => `${environmentId}:${input.newThreadId}`,
  },
});
