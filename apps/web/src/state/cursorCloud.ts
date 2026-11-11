import { createCursorCloudAtoms } from "@t3tools/client-runtime/state/cursorCloud";
import { connectionAtomRuntime } from "../connection/runtime";
export const cursorCloud = createCursorCloudAtoms(connectionAtomRuntime);
