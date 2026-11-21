import { defineNativeBuiltinPlugin } from "./define";

export const nativeTerminalPlugin = defineNativeBuiltinPlugin("t3.terminal", [
  "terminal",
  "native.features.terminal.native-terminal-surface.terminal-surface",
  "native.features.terminal.terminal-context-sheet",
]);
