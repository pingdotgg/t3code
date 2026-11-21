import { defineNativeBuiltinPlugin } from "./define";

export const nativeProvidersPlugin = defineNativeBuiltinPlugin("t3.providers", [
  "settings.providers",
]);
