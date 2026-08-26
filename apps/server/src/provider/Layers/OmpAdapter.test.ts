// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  EventId,
  OmpSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { OmpAdapterShape } from "../Services/OmpAdapter.ts";
import {
  buildOmpElicitationContent,
  ompElicitationQuestions,
  selectOmpPermissionOptionId,
} from "../acp/OmpAcpSupport.ts";
import { makeOmpAdapter } from "./OmpAdapter.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

class OmpAdapter extends Context.Service<OmpAdapter, OmpAdapterShape>()(
  "t3/provider/Layers/OmpAdapter.test/OmpAdapter",
) {}

class FaultingNativeLogOmpAdapter extends Context.Service<
  FaultingNativeLogOmpAdapter,
  OmpAdapterShape
>()("t3/provider/Layers/OmpAdapter.test/FaultingNativeLogOmpAdapter") {}

class FailingStartupStampOmpAdapter extends Context.Service<
  FailingStartupStampOmpAdapter,
  OmpAdapterShape
>()("t3/provider/Layers/OmpAdapter.test/FailingStartupStampOmpAdapter") {}

async function makeMockAgentWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-omp.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec node ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const ompAdapterTestLayer = it.layer(
  Layer.effect(
    OmpAdapter,
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const resolveSettings = serverSettings.getSettings.pipe(
        Effect.map((snapshot) => snapshot.providers.omp),
        Effect.orDie,
      );
      return yield* makeOmpAdapter(decodeOmpSettings({}), { resolveSettings });
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-omp-adapter-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const faultingNativeLogOmpAdapterTestLayer = it.layer(
  Layer.effect(
    FaultingNativeLogOmpAdapter,
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const resolveSettings = serverSettings.getSettings.pipe(
        Effect.map((snapshot) => snapshot.providers.omp),
        Effect.orDie,
      );
      let writes = 0;
      return yield* makeOmpAdapter(decodeOmpSettings({}), {
        resolveSettings,
        nativeEventLogger: {
          filePath: "faulting-native.log",
          write: () => {
            writes += 1;
            return writes === 1 ? Effect.die("simulated native log failure") : Effect.void;
          },
          close: () => Effect.void,
        },
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-omp-adapter-notification-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const failingStartupStampOmpAdapterTestLayer = it.layer(
  Layer.effect(
    FailingStartupStampOmpAdapter,
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const resolveSettings = serverSettings.getSettings.pipe(
        Effect.map((snapshot) => snapshot.providers.omp),
        Effect.orDie,
      );
      return yield* makeOmpAdapter(decodeOmpSettings({}), {
        resolveSettings,
        makeEventStamp: () => Effect.die("simulated startup event stamp failure"),
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-omp-adapter-startup-failure-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

failingStartupStampOmpAdapterTestLayer("OmpAdapter startup cleanup", (it) => {
  it.effect("removes a session when startup event stamping fails", () =>
    Effect.gen(function* () {
      const adapter = yield* FailingStartupStampOmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      const threadId = ThreadId.make("omp-startup-stamp-failure");

      const result = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.exit);

      assert.equal(result._tag, "Failure");
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );
});
describe("OMP elicitation mapping", () => {
  it("maps OMP choice forms and custom answers", () => {
    const request = {
      mode: "form",
      sessionId: "session-1",
      message: "Choose a deployment target",
      requestedSchema: {
        type: "object",
        properties: {
          q0: {
            type: "string",
            title: "Where should this deploy?",
            oneOf: [
              { const: "preview", title: "Preview environment" },
              { const: "production", title: "Production environment" },
            ],
          },
          q0__other: { type: "string", title: "Other" },
          confirmed: { type: "boolean", title: "Continue?" },
        },
        required: ["q0", "confirmed"],
      },
    } as const;

    const questions = ompElicitationQuestions(request);
    assert.deepStrictEqual(
      questions.map((entry) => entry.question.id),
      ["q0", "confirmed"],
    );
    assert.deepStrictEqual(
      questions.map((entry) => entry.required),
      [true, true],
    );
    assert.deepStrictEqual(buildOmpElicitationContent(questions, { q0: "Preview environment" }), {
      q0: "preview",
    });
    assert.deepStrictEqual(
      buildOmpElicitationContent(questions, { q0: "Staging", confirmed: "Yes" }),
      {
        q0__other: "Staging",
        confirmed: true,
      },
    );
  });

  it("omits blank numeric answers instead of fabricating zero", () => {
    const questions = ompElicitationQuestions({
      mode: "form",
      sessionId: "session-1",
      message: "Set numeric values",
      requestedSchema: {
        type: "object",
        properties: {
          attempts: { type: "integer", title: "Attempts" },
          ratio: { type: "number", title: "Ratio" },
        },
        required: ["attempts", "ratio"],
      },
    });

    assert.deepStrictEqual(
      buildOmpElicitationContent(questions, { attempts: null as never, ratio: " " }),
      {},
    );
    assert.deepStrictEqual(buildOmpElicitationContent(questions, { attempts: "2", ratio: "0.5" }), {
      attempts: 2,
      ratio: 0.5,
    });
  });
});
describe("OMP optional elicitation", () => {
  it("omits optional fields that current clients cannot express", () => {
    const questions = ompElicitationQuestions({
      mode: "form",
      sessionId: "session-1",
      message: "Optional context",
      requestedSchema: {
        type: "object",
        properties: {
          context: { type: "string", title: "Context" },
        },
        required: [],
      },
    });

    assert.deepStrictEqual(questions, []);
  });
});

describe("OMP multi-select elicitation", () => {
  it("preserves predefined and custom multi-select answers", () => {
    const questions = ompElicitationQuestions({
      mode: "form",
      sessionId: "session-1",
      message: "Choose scopes",
      requestedSchema: {
        type: "object",
        properties: {
          scopes: {
            type: "array",
            title: "Scopes",
            items: {
              anyOf: [
                { const: "workspace", title: "Workspace" },
                { const: "session", title: "Session" },
              ],
            },
          },
          scopes__other: { type: "string", title: "Other" },
        },
        required: ["scopes"],
      },
    });

    assert.deepStrictEqual(
      buildOmpElicitationContent(questions, {
        scopes: ["Custom scope", "Workspace", "Session"],
      }),
      {
        scopes: ["workspace", "session"],
        scopes__other: "Custom scope",
      },
    );
  });
});

describe("OMP duplicate choice titles", () => {
  it("maps duplicate choice titles to their corresponding constants", () => {
    const questions = ompElicitationQuestions({
      mode: "form",
      sessionId: "session-1",
      message: "Choose a target",
      requestedSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            title: "Target",
            oneOf: [
              { const: "preview", title: "Default" },
              { const: "production", title: "Default" },
            ],
          },
        },
        required: ["target"],
      },
    });

    assert.deepStrictEqual(
      questions[0]?.question.options.map((option) => option.label),
      ["Default (preview)", "Default (production)"],
    );
    assert.deepStrictEqual(
      buildOmpElicitationContent(questions, { target: "Default (production)" }),
      { target: "production" },
    );
  });
});
describe("OMP permission mapping", () => {
  it("returns the option ID that OMP supplied for each decision", () => {
    const request = {
      sessionId: "session-1",
      toolCall: {
        toolCallId: "tool-1",
        title: "Edit file",
      },
      options: [
        { optionId: "omp_allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "omp_allow_always", name: "Always allow", kind: "allow_always" },
        { optionId: "omp_reject_once", name: "Reject", kind: "reject_once" },
      ],
    } as const;

    assert.equal(selectOmpPermissionOptionId(request, "accept"), "omp_allow_once");
    assert.equal(selectOmpPermissionOptionId(request, "acceptForSession"), "omp_allow_always");
    assert.equal(selectOmpPermissionOptionId(request, "decline"), "omp_reject_once");
  });
});

faultingNativeLogOmpAdapterTestLayer("OmpAdapter notification recovery", (it) => {
  it.effect("publishes the current and later notifications after a native log failure", () =>
    Effect.gen(function* () {
      const adapter = yield* FaultingNativeLogOmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      const threadId = ThreadId.make("omp-notification-recovery-thread");
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) => event.type === "turn.plan.updated" || event.type === "content.delta",
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "continue after the failed notification handler",
        attachments: [],
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepStrictEqual(
        runtimeEvents.map((event) => event.type),
        ["turn.plan.updated", "content.delta"],
      );
      yield* adapter.stopSession(threadId);
    }),
  );
});

ompAdapterTestLayer("OmpAdapterLive", (it) => {
  it.effect("starts an OMP ACP session and maps a prompt to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      const threadId = ThreadId.make("omp-mock-thread");
      const eventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "composer-2",
        },
      });
      assert.equal(session.provider, "omp");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello mock",
        attachments: [],
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const eventTypes = events.map((event) => event.type);
      for (const eventType of [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "turn.plan.updated",
        "item.started",
        "content.delta",
        "item.completed",
        "turn.completed",
      ] as const) {
        assert.include(eventTypes, eventType);
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("clears stop intent when a waiting stop is interrupted", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const resolveSettings = serverSettings.getSettings.pipe(
        Effect.map((snapshot) => snapshot.providers.omp),
        Effect.orDie,
      );
      const firstStampRequested = yield* Deferred.make<void>();
      const releaseFirstStamp = yield* Deferred.make<void>();
      let stampIndex = 0;
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({}), {
        resolveSettings,
        makeEventStamp: () =>
          Effect.gen(function* () {
            stampIndex += 1;
            if (stampIndex === 1) {
              yield* Deferred.succeed(firstStampRequested, undefined);
              yield* Deferred.await(releaseFirstStamp);
            }
            return {
              eventId: EventId.make(`omp-interrupted-stop-${stampIndex}`),
              createdAt: "2026-08-26T00:00:00.000Z",
            };
          }),
      });
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      const threadId = ThreadId.make("omp-interrupted-stop-reservation");
      const startFiber = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.exit, Effect.forkChild);

      yield* Deferred.await(firstStampRequested);
      const stopFiber = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(stopFiber);
      yield* Deferred.succeed(releaseFirstStamp, undefined);
      assert.equal((yield* Fiber.join(startFiber))._tag, "Success");

      const turnResult = yield* adapter
        .sendTurn({ threadId, input: "continue after cancelled stop", attachments: [] })
        .pipe(Effect.exit);
      assert.equal(turnResult._tag, "Success");
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("serializes stop with startup lifecycle publication", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const resolveSettings = serverSettings.getSettings.pipe(
        Effect.map((snapshot) => snapshot.providers.omp),
        Effect.orDie,
      );
      const threadId = ThreadId.make("omp-stop-during-startup");
      const stopExit = yield* Deferred.make<Exit.Exit<void, unknown>>();
      let stampIndex = 0;
      let sessionVisibleDuringFirstStamp = false;
      let adapter!: OmpAdapterShape;
      adapter = yield* makeOmpAdapter(decodeOmpSettings({}), {
        resolveSettings,
        makeEventStamp: () =>
          Effect.gen(function* () {
            stampIndex += 1;
            if (stampIndex === 1) {
              yield* adapter.stopSession(threadId).pipe(
                Effect.exit,
                Effect.flatMap((exit) => Deferred.succeed(stopExit, exit)),
                Effect.forkChild,
              );
              yield* Effect.yieldNow;
              sessionVisibleDuringFirstStamp = yield* adapter.hasSession(threadId);
            }
            return {
              eventId: EventId.make(`omp-startup-stop-${stampIndex}`),
              createdAt: "2026-08-26T00:00:00.000Z",
            };
          }),
      });
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(4),
        Stream.runCollect,
        Effect.timeout("5 seconds"),
        Effect.forkChild,
      );

      const startResult = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.exit);
      const stopped = yield* Deferred.await(stopExit);
      const eventTypes = Array.from(yield* Fiber.join(eventsFiber), (event) => event.type);

      assert.equal(startResult._tag, "Success");
      assert.isTrue(sessionVisibleDuringFirstStamp);
      assert.equal(stopped._tag, "Success");
      assert.deepStrictEqual(eventTypes, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "session.exited",
      ]);
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );
  it.effect("clears active turn state when the turn-start stamp fails", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const resolveSettings = serverSettings.getSettings.pipe(
        Effect.map((snapshot) => snapshot.providers.omp),
        Effect.orDie,
      );
      let stampIndex = 0;
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({}), {
        resolveSettings,
        makeEventStamp: () => {
          stampIndex += 1;
          return stampIndex === 4
            ? Effect.die("simulated turn-start stamp failure")
            : Effect.succeed({
                eventId: EventId.make(`omp-turn-stamp-${stampIndex}`),
                createdAt: "2026-08-26T00:00:00.000Z",
              });
        },
      });
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      const threadId = ThreadId.make("omp-turn-start-stamp-failure");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const result = yield* adapter
        .sendTurn({ threadId, input: "fail before prompt", attachments: [] })
        .pipe(Effect.exit);
      const session = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId);

      assert.equal(result._tag, "Failure");
      assert.equal(session?.status, "ready");
      assert.equal(session?.activeTurnId, undefined);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("honors an interrupt requested before the ACP prompt starts", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const resolveSettings = serverSettings.getSettings.pipe(
        Effect.map((snapshot) => snapshot.providers.omp),
        Effect.orDie,
      );
      const threadId = ThreadId.make("omp-interrupt-before-prompt");
      let stampIndex = 0;
      let adapter!: OmpAdapterShape;
      adapter = yield* makeOmpAdapter(decodeOmpSettings({}), {
        resolveSettings,
        makeEventStamp: () =>
          Effect.gen(function* () {
            stampIndex += 1;
            if (stampIndex === 4) {
              yield* adapter.interruptTurn(threadId).pipe(Effect.forkChild);
              yield* Effect.yieldNow;
            }
            return {
              eventId: EventId.make(`omp-pre-prompt-interrupt-${stampIndex}`),
              createdAt: "2026-08-26T00:00:00.000Z",
            };
          }),
      });
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const result = yield* adapter
        .sendTurn({ threadId, input: "do not start", attachments: [] })
        .pipe(Effect.exit);
      const session = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.isTrue(Cause.hasInterruptsOnly(result.cause), Cause.pretty(result.cause));
      }
      assert.equal(session?.status, "ready");
      assert.equal((yield* adapter.readThread(threadId)).turns.length, 0);
      const nextCompletionFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed" && event.threadId === threadId),
        Stream.take(1),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({ threadId, input: "start normally", attachments: [] });
      const nextCompletion = yield* Fiber.join(nextCompletionFiber);
      assert.equal(nextCompletion._tag, "Some");
      if (nextCompletion._tag === "Some" && nextCompletion.value.type === "turn.completed") {
        assert.equal(nextCompletion.value.payload.state, "completed");
      }
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("preempts a stop requested during turn preparation", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const resolveSettings = serverSettings.getSettings.pipe(
        Effect.map((snapshot) => snapshot.providers.omp),
        Effect.orDie,
      );
      const threadId = ThreadId.make("omp-stop-during-turn-preparation");
      let stampIndex = 0;
      let stoppedDuringStamp = false;
      let adapter!: OmpAdapterShape;
      adapter = yield* makeOmpAdapter(decodeOmpSettings({}), {
        resolveSettings,
        makeEventStamp: () =>
          Effect.gen(function* () {
            stampIndex += 1;
            if (stampIndex === 4) {
              yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
              yield* Effect.yieldNow;
              stoppedDuringStamp = !(yield* adapter.hasSession(threadId));
            }
            return {
              eventId: EventId.make(`omp-turn-preparation-stop-${stampIndex}`),
              createdAt: "2026-08-26T00:00:00.000Z",
            };
          }),
      });
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const result = yield* adapter
        .sendTurn({ threadId, input: "stop before prompt", attachments: [] })
        .pipe(Effect.exit);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.isTrue(Cause.hasInterruptsOnly(result.cause), Cause.pretty(result.cause));
      }
      assert.isTrue(stoppedDuringStamp);
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("does not carry a settled-turn interrupt into the next prompt", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const resolveSettings = serverSettings.getSettings.pipe(
        Effect.map((snapshot) => snapshot.providers.omp),
        Effect.orDie,
      );
      const threadId = ThreadId.make("omp-interrupt-after-turn-settlement");
      let stampIndex = 0;
      let interruptInjected = false;
      let adapter!: OmpAdapterShape;
      adapter = yield* makeOmpAdapter(decodeOmpSettings({}), {
        resolveSettings,
        makeEventStamp: () =>
          Effect.gen(function* () {
            stampIndex += 1;
            if (stampIndex > 4 && !interruptInjected) {
              const session = (yield* adapter.listSessions()).find(
                (entry) => entry.threadId === threadId,
              );
              if (session?.status === "ready") {
                interruptInjected = true;
                yield* adapter.interruptTurn(threadId).pipe(Effect.forkChild);
                yield* Effect.yieldNow;
              }
            }
            return {
              eventId: EventId.make(`omp-post-settlement-interrupt-${stampIndex}`),
              createdAt: "2026-08-26T00:00:00.000Z",
            };
          }),
      });
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const completedTurnsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed" && event.threadId === threadId),
        Stream.take(2),
        Stream.runCollect,
        Effect.timeout("5 seconds"),
        Effect.forkChild,
      );

      yield* adapter.sendTurn({ threadId, input: "first", attachments: [] });
      yield* adapter.sendTurn({ threadId, input: "second", attachments: [] });
      const states = Array.from(yield* Fiber.join(completedTurnsFiber), (event) =>
        event.type === "turn.completed" ? event.payload.state : "unknown",
      );

      assert.deepStrictEqual(states, ["completed", "completed"]);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("publishes turn completion before a concurrent session stop", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const resolveSettings = serverSettings.getSettings.pipe(
        Effect.map((snapshot) => snapshot.providers.omp),
        Effect.orDie,
      );
      const threadId = ThreadId.make("omp-stop-during-turn-completion");
      const stopExit = yield* Deferred.make<Exit.Exit<void, unknown>>();
      let stampIndex = 0;
      let stopInjected = false;
      let sessionVisibleDuringTerminalStamp = false;
      let adapter!: OmpAdapterShape;
      adapter = yield* makeOmpAdapter(decodeOmpSettings({}), {
        resolveSettings,
        makeEventStamp: () =>
          Effect.gen(function* () {
            stampIndex += 1;
            if (stampIndex > 4 && !stopInjected) {
              const session = (yield* adapter.listSessions()).find(
                (entry) => entry.threadId === threadId,
              );
              if (session?.status === "ready") {
                stopInjected = true;
                yield* adapter.stopSession(threadId).pipe(
                  Effect.exit,
                  Effect.flatMap((exit) => Deferred.succeed(stopExit, exit)),
                  Effect.forkChild,
                );
                yield* Effect.yieldNow;
                sessionVisibleDuringTerminalStamp = yield* adapter.hasSession(threadId);
              }
            }
            return {
              eventId: EventId.make(`omp-terminal-stop-${stampIndex}`),
              createdAt: "2026-08-26T00:00:00.000Z",
            };
          }),
      });
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const terminalEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "turn.completed" || event.type === "session.exited"),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.timeout("5 seconds"),
        Effect.forkChild,
      );

      const turnResult = yield* adapter
        .sendTurn({ threadId, input: "complete before stopping", attachments: [] })
        .pipe(Effect.exit);
      const stopped = yield* Deferred.await(stopExit);
      const eventTypes = Array.from(yield* Fiber.join(terminalEventsFiber), (event) => event.type);

      assert.equal(turnResult._tag, "Success");
      assert.equal(stopped._tag, "Success");
      assert.isTrue(sessionVisibleDuringTerminalStamp);
      assert.deepStrictEqual(eventTypes, ["turn.completed", "session.exited"]);
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("completes session stop when exit event stamping fails", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const resolveSettings = serverSettings.getSettings.pipe(
        Effect.map((snapshot) => snapshot.providers.omp),
        Effect.orDie,
      );
      let stampIndex = 0;
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({}), {
        resolveSettings,
        makeEventStamp: () => {
          stampIndex += 1;
          return stampIndex === 4
            ? Effect.die("simulated session-exit stamp failure")
            : Effect.succeed({
                eventId: EventId.make(`omp-stop-stamp-${stampIndex}`),
                createdAt: "2026-08-26T00:00:00.000Z",
              });
        },
      });
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      const threadId = ThreadId.make("omp-stop-stamp-failure");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const stopped = yield* adapter.stopSession(threadId).pipe(Effect.exit);

      assert.equal(stopped._tag, "Success");
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("stops a session while its turn awaits approval", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_EMIT_EDIT_PERMISSION: "1",
        }),
      );
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      const threadId = ThreadId.make("omp-stop-pending-approval");
      const requestFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "request.opened"),
        Stream.take(1),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turnFiber = yield* adapter
        .sendTurn({ threadId, input: "request approval", attachments: [] })
        .pipe(Effect.exit, Effect.forkChild);

      const request = yield* Fiber.join(requestFiber);
      assert.equal(request._tag, "Some");
      yield* adapter.stopSession(threadId).pipe(Effect.timeout("2 seconds"));
      const turnResult = yield* Fiber.join(turnFiber);
      assert.equal(turnResult._tag, "Failure");
      if (turnResult._tag === "Failure") {
        assert.isTrue(Cause.hasInterruptsOnly(turnResult.cause), Cause.pretty(turnResult.cause));
      }
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("replaces a session while its turn awaits approval", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_EMIT_EDIT_PERMISSION: "1",
        }),
      );
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      const threadId = ThreadId.make("omp-replace-pending-approval");
      const requestFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "request.opened"),
        Stream.take(1),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turnFiber = yield* adapter
        .sendTurn({ threadId, input: "request approval", attachments: [] })
        .pipe(Effect.exit, Effect.forkChild);

      const request = yield* Fiber.join(requestFiber);
      assert.equal(request._tag, "Some");
      const replacement = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.timeout("2 seconds"));
      assert.equal(replacement.status, "ready");
      const turnResult = yield* Fiber.join(turnFiber);
      assert.equal(turnResult._tag, "Failure");
      if (turnResult._tag === "Failure") {
        assert.isTrue(Cause.hasInterruptsOnly(turnResult.cause), Cause.pretty(turnResult.cause));
      }
      assert.isTrue(yield* adapter.hasSession(threadId));
      yield* adapter.stopSession(threadId);
    }),
  );
  it.effect("restores a configured default model that arrives after session start", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({
          T3_ACP_OMIT_CREATE_CONFIG_OPTIONS: "1",
          T3_ACP_EMIT_CONFIG_OPTIONS_ON_PROMPT: "1",
          T3_ACP_ECHO_CURRENT_MODEL: "1",
        }),
      );
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      const threadId = ThreadId.make("omp-late-default-model-thread");
      const contentEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "content.delta"),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "default",
        },
      });
      yield* adapter.sendTurn({ threadId, input: "default", attachments: [] });
      yield* adapter.sendTurn({
        threadId,
        input: "override",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "composer-2",
        },
      });
      yield* adapter.sendTurn({
        threadId,
        input: "restore",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "default",
        },
      });

      const contentEvents = Array.from(yield* Fiber.join(contentEventsFiber));
      assert.deepStrictEqual(
        contentEvents.map((event) => event.payload.delta),
        ["default", "composer-2", "default"],
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects an OMP session when the provider does not match", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const result = yield* adapter
        .startSession({
          threadId: ThreadId.make("omp-provider-mismatch"),
          provider: ProviderDriverKind.make("codex"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
    }),
  );

  it.effect("loads an OMP ACP session from its resume cursor", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      const threadId = ThreadId.make("omp-resume-thread");
      const started = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      const resumed = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: started.resumeCursor,
      });

      assert.deepStrictEqual(resumed.resumeCursor, started.resumeCursor);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("queues concurrent prompts as distinct turns", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_PROMPT_DELAY_MS: "25" }),
      );
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      const threadId = ThreadId.make("omp-concurrent-prompts");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const [first, second] = yield* Effect.all(
        [
          adapter.sendTurn({ threadId, input: "first", attachments: [] }),
          adapter.sendTurn({ threadId, input: "second", attachments: [] }),
        ],
        { concurrency: 2 },
      );

      assert.notEqual(first.turnId, second.turnId);
      const thread = yield* adapter.readThread(threadId);
      assert.equal(thread.turns.length, 2);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("auto-approves OMP edit gates in auto-accept-edits mode", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_EMIT_EDIT_PERMISSION: "1",
        }),
      );
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      const threadId = ThreadId.make("omp-auto-accept-edit");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "auto-accept-edits",
      });

      const turn = yield* adapter.sendTurn({ threadId, input: "delete it", attachments: [] });

      assert.equal(turn.threadId, threadId);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("clears active turn state after a failed prompt", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_FAIL_PROMPT: "1" }),
      );
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      const threadId = ThreadId.make("omp-failed-prompt");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const failedTurnFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "turn.completed" &&
            event.threadId === threadId &&
            event.payload.state === "failed",
        ),
        Stream.take(1),
        Stream.runHead,
        Effect.forkChild,
      );

      const result = yield* adapter
        .sendTurn({ threadId, input: "fail", attachments: [] })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      const failedTurn = yield* Fiber.join(failedTurnFiber);
      assert.equal(failedTurn._tag, "Some");
      if (failedTurn._tag === "Some" && failedTurn.value.type === "turn.completed") {
        assert.equal(failedTurn.value.payload.errorMessage, "Oh My Pi ACP prompt failed.");
      }
      const session = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId);
      assert.equal(session?.status, "ready");
      assert.equal(session?.activeTurnId, undefined);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("fails the active turn when the OMP ACP child exits", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EXIT_ON_PROMPT: "1" }),
      );
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      const threadId = ThreadId.make("omp-unexpected-exit");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const exitEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "session.exited" && event.threadId === threadId),
        Stream.take(1),
        Stream.runCollect,
        Effect.timeout("5 seconds"),
        Effect.forkChild,
      );
      const failedTurnFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "turn.completed" &&
            event.threadId === threadId &&
            event.payload.state === "failed",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.timeout("5 seconds"),
        Effect.forkChild,
      );

      const result = yield* adapter
        .sendTurn({ threadId, input: "exit", attachments: [] })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      const exitEvents = Array.from(yield* Fiber.join(exitEventFiber));
      const failedTurns = Array.from(yield* Fiber.join(failedTurnFiber));
      assert.equal(exitEvents[0]?.type, "session.exited");
      if (exitEvents[0]?.type === "session.exited") {
        assert.equal(exitEvents[0].payload.exitKind, "error");
      }
      assert.equal(failedTurns.length, 1);
      assert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("rejects rollback because OMP cannot restore provider history", () =>
    Effect.gen(function* () {
      const adapter = yield* OmpAdapter;
      const serverSettings = yield* ServerSettingsService;
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* serverSettings.updateSettings({
        providers: { omp: { binaryPath: wrapperPath, enabled: true } },
      });
      const threadId = ThreadId.make("omp-rollback-unsupported");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const result = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.include(String(result.failure), "do not support provider-side rollback");
      }
      yield* adapter.stopSession(threadId);
    }),
  );
});
