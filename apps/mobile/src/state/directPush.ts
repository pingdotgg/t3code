import { createDirectPushCommands } from "@t3tools/client-runtime/state/directPush";

import { connectionAtomRuntime } from "../connection/runtime";

export const directPush = createDirectPushCommands(connectionAtomRuntime);
