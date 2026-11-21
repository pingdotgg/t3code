import { defineNativeBuiltinPlugin } from "./define";

export const nativeUiPlugin = defineNativeBuiltinPlugin("t3.ui", [
  "native.components.ui.app-text",
  "native.components.ui.app-text.app-text-input",
  "native.components.ui.button",
  "native.components.loading-screen",
  "native.components.ui.error-banner",
]);
