import { assert, it } from "@effect/vitest";
import { StepRunId, type TerminalCloseInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { TerminalManager } from "../../terminal/Manager.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { ScriptCancelRegistryLive } from "./ScriptCancelRegistry.ts";

const layer = it.layer(
  ScriptCancelRegistryLive.pipe(
    Layer.provide(
      Layer.succeed(TerminalManager, {
        close: (input: TerminalCloseInput) =>
          Effect.sync(() => {
            closed.push(`${input.threadId}:${input.terminalId ?? "*"}`);
          }),
      } as never),
    ),
  ),
);

const closed: string[] = [];

layer("ScriptCancelRegistryLive", (it) => {
  it.effect("closes the registered script terminal and forgets it after unregister", () =>
    Effect.gen(function* () {
      closed.length = 0;
      const registry = yield* ScriptCancelRegistry;
      const stepRunId = StepRunId.make("step-run-cancel");

      yield* registry.register(stepRunId, {
        scriptThreadId: "workflow-script:script-run-cancel" as never,
        terminalId: "script-script-run-cancel",
      });
      yield* registry.cancel(stepRunId);
      yield* registry.unregister(stepRunId);
      yield* registry.cancel(stepRunId);

      assert.deepEqual(closed, ["workflow-script:script-run-cancel:script-script-run-cancel"]);
    }),
  );
});
