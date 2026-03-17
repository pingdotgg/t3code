import { createRequire } from "node:module";

export type T3ToolsNative = typeof import("#t3tools_native");

const require = createRequire(import.meta.url);
const binding = require("#t3tools_native") as T3ToolsNative;

export const { ping } = binding;
