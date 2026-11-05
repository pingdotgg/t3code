import { createExternalHistoryAtoms } from "@t3tools/client-runtime/externalHistory";
import { connectionAtomRuntime } from "../connection/runtime";

export const externalHistory = createExternalHistoryAtoms(connectionAtomRuntime);
