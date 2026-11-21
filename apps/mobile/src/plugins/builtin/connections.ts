import { defineNativeBuiltinPlugin } from "./define";

export const nativeConnectionsPlugin = defineNativeBuiltinPlugin("t3.connections", [
  "settings.connections",
  "settings.environments",
  "settings.environment",
  "native.features.connection.pull-request-routing-settings",
]);
