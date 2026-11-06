import { assert, it } from "@effect/vitest";
import { GracefulShutdownId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerSettings from "../serverSettings.ts";
import * as GracefulShutdown from "./GracefulShutdown.ts";
import * as GracefulShutdownGate from "./GracefulShutdownGate.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

it.effect("complete clears the drain and resumes queued runs without queue.resume", () =>
  Effect.gen(function* () {
    const resumeCalls = yield* Ref.make(0);
    const dispatches = yield* Ref.make<ReadonlyArray<string>>([]);

    const gateLayer = GracefulShutdownGate.layer;
    const threadsLayer = Layer.succeed(ThreadManagementService.ThreadManagementService, {
      getShellSnapshot: () =>
        Effect.succeed({
          threads: [],
          sequence: 0,
        }),
      listProjectThreads: () => Effect.succeed([]),
      getThreadRecords: () => Effect.succeed({ runs: [] }),
      dispatch: (command: { readonly type: string }) =>
        Ref.update(dispatches, (existing) => [...existing, command.type]).pipe(
          Effect.as({ sequence: 0, storedEvents: [], replayed: false }),
        ),
    } as unknown as ThreadManagementService.ThreadManagementService["Service"]);
    const orchestratorLayer = Layer.succeed(Orchestrator.OrchestratorV2, {
      resumeQueuedRuns: Ref.update(resumeCalls, (count) => count + 1).pipe(Effect.as(1)),
    } as unknown as Orchestrator.OrchestratorV2["Service"]);
    const settingsLayer = Layer.succeed(ServerSettings.ServerSettingsService, {
      getSettings: Effect.succeed({
        promptSaveWorkOnGracefulShutdown: false,
      }),
    } as unknown as ServerSettings.ServerSettingsService["Service"]);

    yield* Effect.gen(function* () {
      const gate = yield* GracefulShutdownGate.GracefulShutdownGate;
      const graceful = yield* GracefulShutdown.GracefulShutdown;
      const providerA = ProviderInstanceId.make("provider-a");
      yield* gate.setState({
        phase: "quiesced",
        shutdownId: GracefulShutdownId.make("shutdown-a"),
        scope: { type: "provider", providerInstanceId: providerA },
        reason: "test",
        startedAt: "2026-01-01T00:00:00.000Z",
        deadlineAt: "2026-01-01T00:02:00.000Z",
        saveWorkPrompted: false,
        saveWorkMessageIds: new Set(),
        saveWorkThreadIds: new Set([ThreadId.make("thread-b")]),
      });

      yield* graceful.complete(GracefulShutdownId.make("shutdown-a"));

      assert.isFalse(GracefulShutdownGate.isDrainActive(yield* gate.getState));
      assert.strictEqual(yield* Ref.get(resumeCalls), 1);
      assert.deepStrictEqual(yield* Ref.get(dispatches), []);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          GracefulShutdown.layer.pipe(
            Layer.provide(
              Layer.mergeAll(gateLayer, threadsLayer, orchestratorLayer, settingsLayer),
            ),
          ),
          gateLayer,
        ),
      ),
    );
  }),
);
