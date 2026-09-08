import * as Effect from "effect/Effect";
import type { BindingHook } from "../PluginContext.ts";
import * as WorkerdConfig from "../workerd/Config.ts";

export const local = (binding: string): BindingHook =>
  Effect.succeed({
    name: binding,
    unsafeEval: WorkerdConfig.kVoid,
  });
