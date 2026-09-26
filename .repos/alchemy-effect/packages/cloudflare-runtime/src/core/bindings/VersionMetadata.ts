import * as Effect from "effect/Effect";
import type { BindingHook } from "../PluginContext.ts";

export const local = (binding: string): BindingHook =>
  Effect.succeed({
    name: binding,
    json: JSON.stringify({
      id: crypto.randomUUID(),
      tag: "",
      timestamp: "0",
    }),
  });
