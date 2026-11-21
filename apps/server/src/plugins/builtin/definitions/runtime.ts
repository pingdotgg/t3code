import type { CompiledServerBuiltinDefinition } from "./types.ts";

export const definitions: ReadonlyArray<CompiledServerBuiltinDefinition> = [
  { id: "t3.persistence" },
  { id: "t3.auth" },
  { id: "t3.http" },
  { id: "t3.mcp" },
  { id: "t3.server" },
];
