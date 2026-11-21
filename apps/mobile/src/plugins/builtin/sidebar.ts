import { defineNativeBuiltinPlugin } from "./define";

export const nativeSidebarPlugin = defineNativeBuiltinPlugin("t3.sidebar", [
  "sidebar",
  "home",
  "native.features.home.home-screen",
  "native.features.layout.workspace.workspace-list-header",
]);
