import { createExtensionEnvironmentAtoms } from "@t3tools/client-runtime/state/extensions";
import { connectionAtomRuntime } from "../connection/runtime";
export const extensionEnvironment = createExtensionEnvironmentAtoms(connectionAtomRuntime);
