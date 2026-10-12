import { useAtomValue } from "@effect/atom-react";
import { createPluginNotificationEnvironmentAtoms } from "@t3tools/client-runtime/state/plugin-notifications";
import type { EnvironmentId, PluginNotificationFrame } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";

const pluginNotificationEnvironment = createPluginNotificationEnvironmentAtoms(
  connectionAtomRuntime,
  { configValueAtom: serverEnvironment.configValueAtom },
);

/** The notifications an environment's server retains now; null when it lacks the capability. */
export function usePluginNotificationFrame(
  environmentId: EnvironmentId,
): PluginNotificationFrame | null {
  return useAtomValue(pluginNotificationEnvironment.frame(environmentId));
}
