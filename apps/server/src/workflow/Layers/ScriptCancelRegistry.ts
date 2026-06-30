import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { TerminalManager } from "../../terminal/Manager.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  ScriptCancelRegistry,
  type ScriptCancelHandle,
  type ScriptCancelRegistryShape,
} from "../Services/ScriptCancelRegistry.ts";

const toCancelError = (cause: unknown) =>
  new WorkflowEventStoreError({ message: "script cancel failed", cause });

const make = Effect.gen(function* () {
  const terminals = yield* TerminalManager;
  const handles = yield* Ref.make(new Map<string, ScriptCancelHandle>());

  const register: ScriptCancelRegistryShape["register"] = (stepRunId, handle) =>
    Ref.update(handles, (current) => new Map(current).set(stepRunId as string, handle));

  const unregister: ScriptCancelRegistryShape["unregister"] = (stepRunId) =>
    Ref.update(handles, (current) => {
      const next = new Map(current);
      next.delete(stepRunId as string);
      return next;
    });

  const cancel: ScriptCancelRegistryShape["cancel"] = (stepRunId) =>
    Effect.gen(function* () {
      const handle = (yield* Ref.get(handles)).get(stepRunId as string);
      if (!handle) {
        return;
      }
      yield* terminals
        .close({ threadId: handle.scriptThreadId, terminalId: handle.terminalId })
        .pipe(Effect.mapError(toCancelError));
    });

  return { register, unregister, cancel } satisfies ScriptCancelRegistryShape;
});

export const ScriptCancelRegistryLive = Layer.effect(ScriptCancelRegistry, make);
