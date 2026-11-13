import { createExtensionEnvironmentAtoms } from "@t3tools/client-runtime/state/extensions";
import { connectionAtomRuntime } from "../connection/runtime";
export const extensionEnvironment = createExtensionEnvironmentAtoms(connectionAtomRuntime);

import { isElectron } from "../env";
export const extensionClientSurface = isElectron ? "desktop" : "web";
