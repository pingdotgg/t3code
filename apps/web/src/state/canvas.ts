import { createCanvasEnvironmentAtoms } from "@t3tools/client-runtime/state/canvas";

import { connectionAtomRuntime } from "../connection/runtime";

export const canvasEnvironment = createCanvasEnvironmentAtoms(connectionAtomRuntime);
