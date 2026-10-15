import Constants from "expo-constants";
import { Observe } from "expo-observe";

/**
 * Importing expo-observe installs its handler for unhandled JavaScript errors,
 * and its native side records crashes. Reports leave the device only when the
 * build points Observe at the relay; without that (forks, local builds with no
 * relay configured) Observe would fall back to Expo's own ingest under this
 * app's EAS project, so dispatching stays off.
 */
const endpointUrl: unknown = Constants.expoConfig?.extra?.eas?.observe?.endpointUrl;
const appVariant: unknown = Constants.expoConfig?.extra?.appVariant;

Observe.configure({
  dispatchingEnabled: typeof endpointUrl === "string",
  ...(typeof appVariant === "string" ? { environment: appVariant } : {}),
});
