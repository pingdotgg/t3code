import { createPluginNotificationEnvironmentAtoms } from "@t3tools/client-runtime/state/plugin-notifications";

import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";

export const pluginNotificationEnvironment = createPluginNotificationEnvironmentAtoms(
  connectionAtomRuntime,
  { configValueAtom: serverEnvironment.configValueAtom },
);
