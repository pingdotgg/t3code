import { describe, expect, it } from "@effect/vitest";
import { PiSettings, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ProviderAdapterValidationError, type ProviderAdapterError } from "../Errors.ts";
import type {
  PiSessionRuntimeOptions,
  PiSessionRuntimeShape,
} from "../Drivers/PiSessionRuntime.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const PI = ProviderDriverKind.make("pi");
const INSTANCE_A = ProviderInstanceId.make("pi_personal");
const INSTANCE_B = ProviderInstanceId.make("pi_work");
const THREAD_ID = ThreadId.make("thread-native");

function makeRuntimeFactory(input?: { readonly thinkingLevels?: ReadonlyArray<string> }) {
  const options: PiSessionRuntimeOptions[] = [];
  const modelCalls: Array<{ provider: string; modelId: string }> = [];
  const thinkingCalls: string[] = [];
  let closeCount = 0;

  const factory = (runtimeOptions: PiSessionRuntimeOptions) => {
    options.push(runtimeOptions);
    const runtime: PiSessionRuntimeShape = {
      start: () =>
        Effect.succeed({
          sessionId: runtimeOptions.sessionId ?? "probe",
          sessionFile: "/tmp/pi-session.jsonl",
          model: { provider: "custom", id: "starter", name: "Starter" },
          thinkingLevel: "high",
        }),
      getState: () =>
        Effect.succeed({
          sessionId: runtimeOptions.sessionId ?? "probe",
          model: { provider: "custom", id: "team/coder", name: "Team Coder" },
          thinkingLevel: thinkingCalls.at(-1) ?? "high",
        }),
      getAvailableModels: () => Effect.succeed([]),
      setModel: (model) =>
        Effect.sync(() => {
          modelCalls.push(model);
        }),
      getAvailableThinkingLevels: () =>
        Effect.succeed(input?.thinkingLevels ?? ["off", "high", "max"]),
      setThinkingLevel: (level) =>
        Effect.sync(() => {
          thinkingCalls.push(level);
        }),
      events: Stream.empty,
      close: Effect.sync(() => {
        closeCount += 1;
      }),
    };
    return Effect.succeed(runtime);
  };

  return { factory, options, modelCalls, thinkingCalls, getCloseCount: () => closeCount };
}

const sessionStart = (
  instanceId: ProviderInstanceId,
  options?: ReadonlyArray<{ id: string; value: string }>,
) => ({
  threadId: THREAD_ID,
  provider: PI,
  providerInstanceId: instanceId,
  cwd: "/workspace/project",
  runtimeMode: "full-access" as const,
  modelSelection: {
    instanceId,
    model: "custom/team%2Fcoder",
    ...(options ? { options } : {}),
  },
});

describe("PiAdapter", () => {
  it.effect("starts Pi persistent mode with a stable T3 ID and applies model capabilities", () =>
    Effect.gen(function* () {
      const runtime = makeRuntimeFactory();
      const adapter = yield* makePiAdapter(
        decodePiSettings({ binaryPath: "pi-custom", configDirectory: "/tmp/pi-config" }),
        {
          instanceId: INSTANCE_A,
          sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
          environment: { EXAMPLE: "value" },
          makeRuntime: runtime.factory,
        },
      );

      const session = yield* adapter.startSession(
        sessionStart(INSTANCE_A, [{ id: "reasoningEffort", value: "max" }]),
      );

      expect(runtime.options).toEqual([
        {
          binaryPath: "pi-custom",
          configDirectory: "/tmp/pi-config",
          launchArgs: "",
          cwd: "/workspace/project",
          environment: { EXAMPLE: "value" },
          sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
          sessionId: "thread-native",
        },
      ]);
      expect(runtime.modelCalls).toEqual([{ provider: "custom", modelId: "team/coder" }]);
      expect(runtime.thinkingCalls).toEqual(["max"]);
      expect(session).toMatchObject({
        provider: "pi",
        providerInstanceId: INSTANCE_A,
        threadId: THREAD_ID,
        model: "custom/team%2Fcoder",
        resumeCursor: { schemaVersion: 1, sessionId: "thread-native" },
      });

      yield* adapter.stopSession(THREAD_ID);
      expect(runtime.getCloseCount()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a session start routed to another Pi runtime instance", () =>
    Effect.gen(function* () {
      const runtime = makeRuntimeFactory();
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_A,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
        makeRuntime: runtime.factory,
      });

      const error = yield* adapter.startSession(sessionStart(INSTANCE_B)).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProviderAdapterValidationError);
      expect((error as ProviderAdapterError).message).toContain("Expected Pi runtime instance");
      expect(runtime.options).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a thinking level Pi did not report for the selected model", () =>
    Effect.gen(function* () {
      const runtime = makeRuntimeFactory({ thinkingLevels: ["off", "high"] });
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_A,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
        makeRuntime: runtime.factory,
      });

      const error = yield* adapter
        .startSession(sessionStart(INSTANCE_A, [{ id: "reasoningEffort", value: "max" }]))
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProviderAdapterValidationError);
      expect((error as ProviderAdapterError).message).toContain(
        "does not support thinking level 'max'",
      );
      expect(runtime.thinkingCalls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("switches the live Pi session through native model and thinking RPC commands", () =>
    Effect.gen(function* () {
      const runtime = makeRuntimeFactory();
      const adapter = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_A,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
        makeRuntime: runtime.factory,
      });
      yield* adapter.startSession(sessionStart(INSTANCE_A));

      yield* adapter
        .sendTurn({
          threadId: THREAD_ID,
          input: "switch model before prompt delivery",
          attachments: [],
          modelSelection: {
            instanceId: INSTANCE_A,
            model: "custom/team%2Fcoder",
            options: [{ id: "reasoningEffort", value: "max" }],
          },
        })
        .pipe(Effect.flip);

      expect(runtime.modelCalls).toEqual([
        { provider: "custom", modelId: "team/coder" },
        { provider: "custom", modelId: "team/coder" },
      ]);
      expect(runtime.thinkingCalls).toEqual(["max"]);
      expect((yield* adapter.listSessions())[0]?.model).toBe("custom/team%2Fcoder");
      expect(adapter.capabilities.sessionModelSwitch).toBe("in-session");
    }).pipe(Effect.scoped),
  );

  it.effect("restarts the same native session only inside its originating runtime instance", () =>
    Effect.gen(function* () {
      const firstRuntime = makeRuntimeFactory();
      const secondRuntime = makeRuntimeFactory();
      const first = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_A,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_personal",
        makeRuntime: firstRuntime.factory,
      });
      const second = yield* makePiAdapter(decodePiSettings({}), {
        instanceId: INSTANCE_B,
        sessionDirectory: "/tmp/t3-pi-sessions/pi_work",
        makeRuntime: secondRuntime.factory,
      });

      yield* first.startSession(sessionStart(INSTANCE_A));
      yield* first.stopSession(THREAD_ID);
      yield* first.startSession(sessionStart(INSTANCE_A));

      expect(firstRuntime.options.map((entry) => entry.sessionId)).toEqual([
        "thread-native",
        "thread-native",
      ]);
      expect(firstRuntime.options.map((entry) => entry.sessionDirectory)).toEqual([
        "/tmp/t3-pi-sessions/pi_personal",
        "/tmp/t3-pi-sessions/pi_personal",
      ]);
      expect(secondRuntime.options).toEqual([]);
      expect(yield* second.hasSession(THREAD_ID)).toBe(false);
    }).pipe(Effect.scoped),
  );
});
