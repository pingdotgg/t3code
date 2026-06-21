import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";
import { waitForProjectActionTerminalInputReady } from "../projectScriptTerminals";

export const projectActionTerminalEnvironment = {
  waitForInputReady: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:project-action-terminal:wait-for-input-ready",
    execute: waitForProjectActionTerminalInputReady,
  }),
};
