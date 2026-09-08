import * as Effect from "effect/Effect";
import type { BindingHook } from "../PluginContext.ts";

export const local = (binding: string, wasmModule: Uint8Array): BindingHook =>
  Effect.succeed({
    name: binding,
    wasmModule,
  });
