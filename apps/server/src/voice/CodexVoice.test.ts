import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Path from "effect/Path";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";
import { layerTest } from "../serverSettings.ts";
import { makeCodexVoiceSessions } from "./CodexVoice.ts";

const fixture = vi.hoisted(() => ({
  accountType: "chatgpt",
  closed: 0,
  prepared: null as null | (() => void),
  failStart: false,
  failClient: false,
  failPrepare: false,
  waitForPrepare: null as null | (() => Promise<void>),
  waitForEdit: null as null | (() => Promise<void>),
  formatted: '{"text":"Can you check the microphone, please?"}',
  calls: [] as Array<{ method: string; params: unknown }>,
  launches: [] as unknown[],
  toolConfig: {} as Record<string, unknown>,
  toolInventory: { data: [], nextCursor: null } as unknown,
}));

vi.mock("../provider/Layers/CodexProvider.ts", () => ({
  withCodexAppServerClient: (options: unknown) =>
    Effect.gen(function* () {
      fixture.launches.push(options);
      if (fixture.failClient) {
        return yield* Effect.fail({ _tag: "ProbeError" as const, message: "CLI not found" });
      }
      const handlers = new Map<
        string,
        (event: {
          threadId: string;
          sdp: string;
          item?: { type: string; text: string };
          turn?: { status: string };
        }) => Effect.Effect<void>
      >();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          fixture.closed++;
        }),
      );
      return {
        client: {
          request: (method: string, params: unknown) =>
            Effect.gen(function* () {
              if (method === "turn/start") {
                fixture.calls.push({ method, params });
                if (fixture.waitForEdit) yield* Effect.promise(fixture.waitForEdit);
                yield* (
                  handlers.get("item/completed")?.({
                    threadId: "dictation-thread",
                    sdp: "",
                    item: { type: "agentMessage", text: fixture.formatted },
                  }) ?? Effect.void
                );
                yield* (
                  handlers.get("turn/completed")?.({
                    threadId: "dictation-thread",
                    sdp: "",
                    turn: { status: "completed" },
                  }) ?? Effect.void
                );
                return {};
              }
              return { account: { type: fixture.accountType } };
            }),
          handleServerNotification: (
            method: string,
            handler: (event: {
              threadId: string;
              sdp: string;
              item?: { type: string; text: string };
              turn?: { status: string };
            }) => Effect.Effect<void>,
          ) =>
            Effect.sync(() => {
              handlers.set(method, handler);
            }),
          raw: {
            request: (method: string, params: unknown) =>
              Effect.gen(function* () {
                fixture.calls.push({ method, params });
                if (method === "config/read")
                  return { config: { mcp_servers: fixture.toolConfig } };
                if (method === "mcpServerStatus/list") return fixture.toolInventory;
                if (method === "thread/start") {
                  fixture.prepared?.();
                  if (fixture.waitForPrepare) yield* Effect.promise(fixture.waitForPrepare);
                  if (fixture.failPrepare) {
                    return yield* Effect.fail({
                      _tag: "ProbeError" as const,
                      message: "secret initialization error",
                    });
                  }
                  return { thread: { id: "dictation-thread" } };
                }
                if (method === "thread/realtime/start") {
                  if (fixture.failStart)
                    return yield* Effect.fail({
                      _tag: "ProbeError" as const,
                      message: "secret upstream error",
                    });
                  yield* (
                    handlers.get("thread/realtime/sdp")?.({
                      threadId: "dictation-thread",
                      sdp: "answer",
                    }) ?? Effect.void
                  );
                }
                return {};
              }),
          },
        },
      };
    }),
}));

const dependencies = Layer.mergeAll(NodeServices.layer, layerTest());
const instance = ProviderInstanceId.make("codex");

it.effect("uses the selected enabled account and refuses disabled or missing instances", () =>
  Effect.gen(function* () {
    fixture.accountType = "chatgpt";
    fixture.failStart = false;
    fixture.launches = [];
    const path = yield* Path.Path;
    const sessions = yield* makeCodexVoiceSessions();
    for (const id of ["codex", "missing"]) {
      const rejected = ProviderInstanceId.make(id);
      expect(yield* sessions.available("owner", rejected)).toBe(false);
      const result = yield* Effect.result(sessions.start("owner", rejected, "offer"));
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "EnvironmentHttpBadRequestError" },
      });
    }
    expect(fixture.launches).toEqual([]);
    const selected = ProviderInstanceId.make("codex_work");
    expect(yield* sessions.available("owner", selected)).toBe(true);
    const result = yield* sessions.start("owner", selected, "offer");
    expect(fixture.launches).toEqual([
      expect.objectContaining({
        binaryPath: "work-codex",
        homePath: path.resolve("test-work-codex-home"),
        launchArgs: "--verbose --disable apps --disable plugins",
        environment: expect.objectContaining({ T3_VOICE_ACCOUNT_TEST: "work" }),
      }),
    ]);
    yield* sessions.stop("owner", result.sessionId);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        layerTest({
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: false,
              config: {},
            },
            [ProviderInstanceId.make("codex_work")]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: {
                binaryPath: "work-codex",
                homePath: "test-work-codex-home",
                launchArgs: "--verbose",
              },
              environment: [{ name: "T3_VOICE_ACCOUNT_TEST", value: "work" }],
            },
          },
        }),
      ),
    ),
  ),
);
beforeEach(() => {
  fixture.toolConfig = {};
  fixture.toolInventory = { data: [], nextCursor: null };
  fixture.failClient = false;
  fixture.failPrepare = false;
  fixture.waitForPrepare = null;
});

it.effect("disables inherited MCP servers and verifies the runtime before polishing", () =>
  Effect.gen(function* () {
    fixture.accountType = "chatgpt";
    fixture.calls = [];
    fixture.toolConfig = { "work.tools": { enabled: true, command: "tool-server" } };
    fixture.toolInventory = { data: [{ runtimeStatus: "disabled", tools: {} }], nextCursor: null };
    const sessions = yield* makeCodexVoiceSessions();
    yield* sessions.polish(instance, "Please check this", "cleanup");
    expect(fixture.calls.find((call) => call.method === "thread/start")).toMatchObject({
      params: {
        dynamicTools: [],
        selectedCapabilityRoots: [],
        config: {
          "features.shell_tool": false,
          "features.unified_exec": false,
          "features.apply_patch_freeform": false,
          "features.multi_agent": false,
          "features.apps": false,
          "features.plugins": false,
          mcp_servers: { "work.tools": { enabled: false, enabled_tools: [] } },
        },
      },
    });
    expect(fixture.calls.findIndex((call) => call.method === "mcpServerStatus/list")).toBeLessThan(
      fixture.calls.findIndex((call) => call.method === "turn/start"),
    );
  }).pipe(Effect.provide(dependencies)),
);

it.effect("refuses transcripts when tool isolation is missing or ineffective", () =>
  Effect.gen(function* () {
    fixture.accountType = "chatgpt";
    const sessions = yield* makeCodexVoiceSessions();
    for (const inventory of [
      { data: [{ runtimeStatus: "connected", tools: {} }], nextCursor: null },
      { data: [{ runtimeStatus: "disabled", tools: { write: {} } }], nextCursor: null },
      { data: [{ tools: {} }], nextCursor: null },
      {},
    ]) {
      fixture.calls = [];
      fixture.toolInventory = inventory;
      expect(yield* sessions.available("owner", instance)).toBe(false);
      expect((yield* Effect.result(sessions.polish(instance, "input", "cleanup")))._tag).toBe(
        "Failure",
      );
      expect(
        fixture.calls.some(
          (call) => call.method === "turn/start" || call.method === "thread/realtime/start",
        ),
      ).toBe(false);
    }
  }).pipe(Effect.provide(dependencies)),
);

it.effect("negotiates a separate ephemeral thread and only its owner can stop it", () =>
  Effect.gen(function* () {
    fixture.accountType = "chatgpt";
    fixture.failStart = false;
    fixture.calls = [];
    fixture.closed = 0;
    const sessions = yield* makeCodexVoiceSessions();
    const result = yield* sessions.start("owner", instance, "offer");
    expect(result.sdp).toBe("answer");
    expect(fixture.closed).toBe(0);
    expect(fixture.calls.find((call) => call.method === "thread/start")).toMatchObject({
      method: "thread/start",
      params: {
        ephemeral: true,
        sandbox: "read-only",
        approvalPolicy: "never",
        environments: [],
      },
    });
    expect(fixture.calls.some((call) => call.method === "turn/start")).toBe(false);
    expect((yield* Effect.result(sessions.start("owner", instance, "offer")))._tag).toBe("Failure");
    expect((yield* Effect.result(sessions.stop("other", result.sessionId)))._tag).toBe("Failure");
    expect(fixture.closed).toBe(0);
    yield* sessions.stop("owner", result.sessionId);
    yield* sessions.stop("owner", result.sessionId);
    expect(fixture.closed).toBe(1);
    expect(fixture.calls.at(-1)?.method).toBe("thread/realtime/stop");
  }).pipe(Effect.provide(dependencies)),
);

it.effect("rejects API-key accounts and releases failed sessions for retry", () =>
  Effect.gen(function* () {
    fixture.accountType = "apiKey";
    fixture.closed = 0;
    const sessions = yield* makeCodexVoiceSessions();
    expect((yield* Effect.result(sessions.start("owner", instance, "offer")))._tag).toBe("Failure");
    expect(fixture.closed).toBe(1);
    fixture.accountType = "chatgpt";
    fixture.failStart = true;
    expect((yield* Effect.result(sessions.start("owner", instance, "offer")))._tag).toBe("Failure");
    expect(fixture.closed).toBe(2);
    fixture.failStart = false;
    const result = yield* sessions.start("owner", instance, "offer");
    yield* sessions.stop("owner", result.sessionId);
    expect(fixture.closed).toBe(3);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("reports non-Codex instances unavailable without starting a CLI", () =>
  Effect.gen(function* () {
    fixture.calls = [];
    const sessions = yield* makeCodexVoiceSessions();
    expect(yield* sessions.available("owner", ProviderInstanceId.make("claudeAgent"))).toBe(false);
    expect(fixture.calls).toEqual([]);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("waits for preparation and reuses it for availability and recording", () =>
  Effect.gen(function* () {
    fixture.accountType = "chatgpt";
    fixture.failStart = false;
    fixture.calls = [];
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.waitForPrepare = () => {
      entered.resolve();
      return release.promise;
    };
    const sessions = yield* makeCodexVoiceSessions();
    let reported = false;
    const checking = yield* sessions.available("owner", instance).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          reported = true;
        }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.promise(() => entered.promise);
    expect(reported).toBe(false);
    release.resolve();
    expect(yield* Fiber.join(checking)).toBe(true);
    expect(yield* sessions.available("owner", instance)).toBe(true);
    const recording = yield* sessions.start("owner", instance, "offer");
    expect(yield* sessions.available("owner", instance)).toBe(true);
    expect(fixture.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    yield* sessions.stop("owner", recording.sessionId);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("reports failed preparation unavailable, releases it, and allows retry", () =>
  Effect.gen(function* () {
    fixture.closed = 0;
    const sessions = yield* makeCodexVoiceSessions();
    fixture.accountType = "apiKey";
    expect(yield* sessions.available("owner", instance)).toBe(false);
    expect(fixture.closed).toBe(1);
    fixture.accountType = "chatgpt";
    fixture.failClient = true;
    expect(yield* sessions.available("owner", instance)).toBe(false);
    fixture.failClient = false;
    fixture.failPrepare = true;
    expect(yield* sessions.available("owner", instance)).toBe(false);
    expect(fixture.closed).toBe(2);
    fixture.failPrepare = false;
    expect(yield* sessions.available("owner", instance)).toBe(true);
    expect(fixture.closed).toBe(2);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("keeps shared preparation alive when an availability request is cancelled", () =>
  Effect.gen(function* () {
    fixture.accountType = "chatgpt";
    fixture.calls = [];
    fixture.closed = 0;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.waitForPrepare = () => {
      entered.resolve();
      return release.promise;
    };
    const sessions = yield* makeCodexVoiceSessions();
    const checking = yield* sessions.available("owner", instance).pipe(Effect.forkScoped);
    yield* Effect.promise(() => entered.promise);
    yield* Fiber.interrupt(checking);
    expect(fixture.closed).toBe(0);
    release.resolve();
    expect(yield* sessions.available("owner", instance)).toBe(true);
    expect(fixture.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("bounds availability checks when preparation hangs", () =>
  Effect.gen(function* () {
    fixture.accountType = "chatgpt";
    fixture.closed = 0;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.waitForPrepare = () => {
      entered.resolve();
      return release.promise;
    };
    const sessions = yield* makeCodexVoiceSessions();
    const checking = yield* sessions.available("owner", instance).pipe(Effect.forkScoped);
    yield* Effect.promise(() => entered.promise);
    yield* TestClock.adjust("15 seconds");
    expect(yield* Fiber.join(checking)).toBe(false);
    expect(fixture.closed).toBe(1);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("preserves provider and authentication errors when polishing", () =>
  Effect.gen(function* () {
    const sessions = yield* makeCodexVoiceSessions();
    expect(
      yield* Effect.result(sessions.polish(ProviderInstanceId.make("missing"), "draft", "cleanup")),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "EnvironmentHttpBadRequestError" } });
    fixture.accountType = "apiKey";
    fixture.closed = 0;
    expect(yield* Effect.result(sessions.polish(instance, "draft", "cleanup"))).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "EnvironmentHttpForbiddenError",
        message: expect.stringContaining("codex login"),
      },
    });
    expect(fixture.closed).toBe(1);
    fixture.accountType = "chatgpt";
    fixture.failPrepare = true;
    expect(yield* Effect.result(sessions.polish(instance, "draft", "cleanup"))).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "EnvironmentHttpInternalServerError",
        message: "Could not polish this text. Your draft has not changed. Please try again.",
      },
    });
    expect(fixture.closed).toBe(2);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("reuses preparation and releases unused warm processes", () =>
  Effect.gen(function* () {
    fixture.accountType = "chatgpt";
    fixture.failStart = false;
    fixture.calls = [];
    fixture.closed = 0;
    const sessions = yield* makeCodexVoiceSessions();
    yield* Effect.all([sessions.warm("owner", instance), sessions.warm("owner", instance)], {
      concurrency: "unbounded",
    });
    const recording = yield* sessions.start("owner", instance, "offer");
    expect(fixture.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    yield* TestClock.adjust("2 minutes");
    expect(fixture.closed).toBe(0);
    const ready = Promise.withResolvers<void>();
    fixture.prepared = () => ready.resolve();
    yield* sessions.stop("owner", recording.sessionId);
    yield* Effect.promise(() => ready.promise);
    fixture.prepared = null;
    yield* TestClock.adjust("1 minute");
    yield* sessions.warm("owner", instance);
    yield* TestClock.adjust("1 minute");
    expect(fixture.closed).toBe(1);
    yield* TestClock.adjust("1 minute");
    expect(fixture.closed).toBe(2);
  }).pipe(Effect.provide(dependencies)),
);
it.effect("formats only the owner's recording and rejects changed words", () =>
  Effect.gen(function* () {
    fixture.accountType = "chatgpt";
    fixture.failStart = false;
    fixture.formatted = '{"text":"Can you check the microphone, please?"}';
    const sessions = yield* makeCodexVoiceSessions();
    const recording = yield* sessions.start("owner", instance, "offer");
    expect(
      (yield* Effect.result(sessions.finish("someone-else", recording.sessionId, "text")))._tag,
    ).toBe("Failure");
    expect(
      yield* sessions.finish("owner", recording.sessionId, "can you check the microphone please"),
    ).toBe("Can you check the microphone, please?");
    const second = yield* sessions.start("owner", instance, "offer");
    fixture.formatted = '{"text":"Yes, I can check it."}';
    expect(yield* sessions.finish("owner", second.sessionId, "can you check it")).toBe(
      "can you check it",
    );
  }).pipe(Effect.provide(dependencies)),
);

it.effect("polishes on demand without opening realtime or consuming the warm recording slot", () =>
  Effect.gen(function* () {
    fixture.accountType = "chatgpt";
    fixture.failStart = false;
    fixture.calls = [];
    fixture.closed = 0;
    fixture.formatted = '{"text":"Please check the microphone."}';
    const sessions = yield* makeCodexVoiceSessions();
    yield* sessions.warm("owner", instance);
    expect(yield* sessions.polish(instance, "um could you check the microphone", "concise")).toBe(
      "Please check the microphone.",
    );
    expect(fixture.calls.find((call) => call.method === "turn/start")).toMatchObject({
      params: { model: "gpt-5.6-luna", effort: "medium" },
    });
    expect(fixture.closed).toBe(1);
    expect(fixture.calls.some((call) => call.method === "thread/realtime/start")).toBe(false);
    const recording = yield* sessions.start("owner", instance, "offer");
    expect(fixture.calls.filter((call) => call.method === "thread/start")).toHaveLength(2);
    yield* sessions.stop("owner", recording.sessionId);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("releases failed AI edits and reports the failure instead of replacing the draft", () =>
  Effect.gen(function* () {
    fixture.accountType = "chatgpt";
    fixture.closed = 0;
    fixture.formatted = '{"text":""}';
    const sessions = yield* makeCodexVoiceSessions();
    expect((yield* Effect.result(sessions.polish(instance, "keep my draft", "cleanup")))._tag).toBe(
      "Failure",
    );
    expect(fixture.closed).toBe(1);
    fixture.formatted = '{"text":"Keep my draft."}';
    expect(yield* sessions.polish(instance, "keep my draft", "cleanup")).toBe("Keep my draft.");
    expect(fixture.closed).toBe(2);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("keeps recording available while an optional AI suggestion is pending", () =>
  Effect.gen(function* () {
    fixture.accountType = "chatgpt";
    fixture.failStart = false;
    fixture.calls = [];
    fixture.closed = 0;
    fixture.formatted = '{"text":"A shorter draft."}';
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.waitForEdit = () => {
      entered.resolve();
      return release.promise;
    };
    const sessions = yield* makeCodexVoiceSessions();
    const editing = yield* sessions
      .polish(instance, "a draft to shorten", "concise")
      .pipe(Effect.forkScoped);
    yield* Effect.promise(() => entered.promise);
    const recording = yield* sessions.start("owner", instance, "offer");
    expect(recording.sdp).toBe("answer");
    expect(fixture.closed).toBe(0);
    release.resolve();
    expect(yield* Fiber.join(editing)).toBe("A shorter draft.");
    fixture.waitForEdit = null;
    yield* sessions.stop("owner", recording.sessionId);
  }).pipe(Effect.provide(dependencies)),
);
