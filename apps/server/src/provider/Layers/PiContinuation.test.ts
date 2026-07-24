import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { PiSettings, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import {
  ProviderUnsupportedError,
  ProviderValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import { makePiAdapter } from "./PiAdapter.ts";
import type {
  PiPromptInput,
  PiSessionRuntimeOptions,
  PiSessionRuntimeShape,
} from "../Drivers/PiSessionRuntime.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const PI = ProviderDriverKind.make("pi");
const PERSONAL = ProviderInstanceId.make("pi_personal");
const WORK = ProviderInstanceId.make("pi_work");
const THREAD_ID = ThreadId.make("thread-pi-continuation");

function makePiRuntimeFactory() {
  return Effect.gen(function* () {
    const options: PiSessionRuntimeOptions[] = [];
    const prompts: PiPromptInput[] = [];
    const events = yield* PubSub.unbounded<unknown>();

    return {
      options,
      prompts,
      emit: (event: unknown) => PubSub.publish(events, event).pipe(Effect.asVoid),
      factory: (runtimeOptions: PiSessionRuntimeOptions) => {
        options.push(runtimeOptions);
        const runtime: PiSessionRuntimeShape = {
          start: () =>
            Effect.succeed({
              sessionId: runtimeOptions.sessionId ?? "model-probe",
              sessionFile: `/tmp/${runtimeOptions.sessionId ?? "model-probe"}.jsonl`,
              model: { provider: "pi-provider", id: "model", name: "Pi Model" },
            }),
          getState: () =>
            Effect.succeed({
              sessionId: runtimeOptions.sessionId ?? "model-probe",
              model: { provider: "pi-provider", id: "model", name: "Pi Model" },
            }),
          getAvailableModels: () => Effect.succeed([]),
          setModel: () => Effect.void,
          getAvailableThinkingLevels: () => Effect.succeed(["off", "high"]),
          setThinkingLevel: () => Effect.void,
          prompt: (input) =>
            Effect.sync(() => {
              prompts.push(input);
            }),
          abort: () => Effect.void,
          respondToExtensionUI: () => Effect.void,
          events: Stream.fromPubSub(events),
          close: Effect.void,
        };
        return Effect.succeed(runtime);
      },
    };
  });
}

function makeInstanceRegistry(input: {
  readonly personal: ProviderAdapterShape<ProviderAdapterError>;
  readonly work: ProviderAdapterShape<ProviderAdapterError>;
}): ProviderAdapterRegistryShape {
  const adapters = new Map([
    [PERSONAL, input.personal],
    [WORK, input.work],
  ]);
  const unsupported = (instanceId: ProviderInstanceId) =>
    new ProviderUnsupportedError({ provider: String(instanceId) });

  return {
    getByInstance: (instanceId) => {
      const adapter = adapters.get(instanceId);
      return adapter ? Effect.succeed(adapter) : Effect.fail(unsupported(instanceId));
    },
    getInstanceInfo: (instanceId) =>
      adapters.has(instanceId)
        ? Effect.succeed({
            instanceId,
            driverKind: PI,
            displayName: undefined,
            enabled: true,
            continuationIdentity: {
              driverKind: PI,
              continuationKey: `pi:instance:${instanceId}`,
            },
          })
        : Effect.fail(unsupported(instanceId)),
    listInstances: () => Effect.succeed([PERSONAL, WORK]),
    listProviders: () => Effect.succeed([PI]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
  };
}

/**
 * ProviderService owns persisted continuation routing. This contract test uses
 * two real Pi adapters and proves that a lost Pi transport does not replay an
 * accepted prompt, then recovers only after an explicit later continuation on
 * the originating runtime instance.
 */
describe("Pi native continuation", () => {
  it.effect("does not replay after loss and resumes the original session", () =>
    Effect.gen(function* () {
      const personalRuntime = yield* makePiRuntimeFactory();
      const workRuntime = yield* makePiRuntimeFactory();
      const personal = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: PERSONAL,
        sessionDirectory: "/tmp/t3/pi-sessions/pi_personal",
        makeRuntime: personalRuntime.factory,
      });
      const work = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: WORK,
        sessionDirectory: "/tmp/t3/pi-sessions/pi_work",
        makeRuntime: workRuntime.factory,
      });
      const registry = makeInstanceRegistry({ personal, work });
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
        Layer.provide(directoryLayer),
        Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const initial = yield* provider.startSession(THREAD_ID, {
          threadId: THREAD_ID,
          provider: PI,
          providerInstanceId: PERSONAL,
          cwd: "/workspace/pi-project",
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: PERSONAL,
            model: "pi-provider/model",
          },
        });
        yield* Effect.yieldNow;
        yield* provider.sendTurn({
          threadId: THREAD_ID,
          input: "Persist this accepted Pi prompt exactly once.",
          attachments: [],
        });
        yield* personalRuntime.emit({
          type: "pi_rpc_transport_failure",
          operation: "process-exit",
          detail: "Pi RPC process exited with code 23.",
        });
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        // A transport loss closes the live adapter but cannot trigger a new
        // process or re-send the accepted prompt by itself.
        expect(personalRuntime.options).toHaveLength(1);
        expect(personalRuntime.prompts).toEqual([
          { message: "Persist this accepted Pi prompt exactly once." },
        ]);
        expect(yield* provider.listSessions()).toEqual([]);

        const incompatibleInstanceError = yield* provider
          .startSession(THREAD_ID, {
            threadId: THREAD_ID,
            provider: PI,
            providerInstanceId: WORK,
            cwd: "/workspace/pi-project",
            runtimeMode: "full-access",
            modelSelection: {
              instanceId: WORK,
              model: "pi-provider/model",
            },
          })
          .pipe(Effect.flip);
        expect(incompatibleInstanceError).toBeInstanceOf(ProviderValidationError);
        expect(incompatibleInstanceError.message).toContain(
          "provider resume state is incompatible",
        );
        expect(workRuntime.options).toEqual([]);

        // A later user action explicitly recovers the persisted native session
        // through its original runtime binding, delivering only that new prompt.
        yield* provider.sendTurn({
          threadId: THREAD_ID,
          input: "Continue this native session after checking the interruption.",
          attachments: [],
        });

        expect(initial.resumeCursor).toEqual({ schemaVersion: 1, sessionId: THREAD_ID });
        expect(personalRuntime.options).toHaveLength(2);
        expect(personalRuntime.options.map((options) => options.sessionId)).toEqual([
          THREAD_ID,
          THREAD_ID,
        ]);
        expect(personalRuntime.options.map((options) => options.sessionDirectory)).toEqual([
          "/tmp/t3/pi-sessions/pi_personal",
          "/tmp/t3/pi-sessions/pi_personal",
        ]);
        expect(personalRuntime.prompts).toEqual([
          { message: "Persist this accepted Pi prompt exactly once." },
          { message: "Continue this native session after checking the interruption." },
        ]);
        expect(workRuntime.options).toEqual([]);
      }).pipe(Effect.provide(providerLayer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
