import * as Effect from "effect/Effect";
import type { BindingHook } from "../PluginContext.ts";

export const local = (binding: string, text: string): BindingHook =>
  Effect.succeed({
    name: binding,
    text,
  });
