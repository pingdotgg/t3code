import { assert, it } from "@effect/vitest";
import {
  CommandId,
  CompletionAudioError,
  CompletionAudioBulkOffResult,
  CompletionAudioMetadata,
  CompletionAudioPage,
  CompletionAudioSetResult,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type CompletionAudioMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CloudLink from "../cloud/CloudLink.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Receipts from "./CommandReceiptStore.ts";
import * as Projections from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as Registry from "./ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Harness from "./testkit/ProviderReplayHarness.ts";
import * as Completion from "./CompletionNotificationService.ts";
import * as McpInvocation from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as CompletionHandlers from "../mcp/toolkits/completionAudio/handlers.ts";
import { CompletionAudioToolkit } from "../mcp/toolkits/completionAudio/tools.ts";
import * as EnvironmentHandlers from "../mcp/toolkits/environment/handlers.ts";
import { EnvironmentToolkit } from "../mcp/toolkits/environment/tools.ts";
import { scopedThreadCommandId } from "./scopedThreadCommandId.ts";

const environmentId = EnvironmentId.make("environment:completion-test");
const projectId = ProjectId.make("project:completion-test");
const instanceId = ProviderInstanceId.make("codex");
const database = Sqlite.layerMemory;
const adapter = ProviderAdapter.ProviderAdapterV2.of({
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("No provider execution in completion preference tests"),
});
const runtime = Harness.layerWithRegistry(
  { name: "completion-preferences" },
  Registry.layerFromAdapters([adapter]),
  { databaseLayer: database, runEffectWorker: false },
);
const threadsLayer = ThreadManagement.layer.pipe(
  Layer.provide(
    Layer.mergeAll(runtime, Settings.layerTest(), Receipts.layer.pipe(Layer.provide(database))),
  ),
);
const base = Layer.mergeAll(
  runtime,
  threadsLayer,
  Projections.layer.pipe(Layer.provide(database)),
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(environmentId),
  }),
);
const layerTest = Completion.layer.pipe(Layer.provideMerge(base));
const caller = { requestNamespace: "client:completion-test" };

const seed = Effect.fn("CompletionTest.seed")(function* (
  id: string,
  input: {
    mode?: CompletionAudioMode;
    runtimeMode?: RuntimeMode;
    archived?: boolean;
    child?: boolean;
    deleted?: boolean;
    otherProject?: boolean;
    otherProvider?: boolean;
  } = {},
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* Projections.ProjectionStoreV2;
  const threadId = ThreadId.make(id);
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${id}`),
    threadId,
    projectId: input.otherProject ? ProjectId.make("project:other") : projectId,
    title: "Private title must not appear in preference responses",
    modelSelection: { instanceId, model: "test" },
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    completionAudio: input.mode ?? "voice",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  if (input.archived || input.child || input.deleted || input.otherProvider) {
    const thread = yield* projections.getThread(threadId);
    yield* projections.apply({
      id: EventId.make(`fixture:${id}`),
      type: "thread.metadata-updated",
      threadId,
      occurredAt: thread.updatedAt,
      payload: {
        ...thread,
        archivedAt: input.archived ? thread.updatedAt : null,
        deletedAt: input.deleted ? thread.updatedAt : null,
        ...(input.otherProvider ? { providerInstanceId: ProviderInstanceId.make("claude") } : {}),
        ...(input.child
          ? {
              lineage: {
                rootThreadId: ThreadId.make("parent"),
                parentThreadId: ThreadId.make("parent"),
                relationshipToParent: "subagent" as const,
              },
            }
          : {}),
      },
    });
  }
  return threadId;
});

it.effect(
  "reads only preference metadata and pages all providers, archived threads and children",
  () =>
    Effect.gen(function* () {
      const service = yield* Completion.CompletionNotificationService;
      const a = yield* seed("a");
      yield* seed("b", { mode: "sound", archived: true, child: true, otherProvider: true });
      yield* seed("c", { mode: "off", otherProject: true });
      const deleted = yield* seed("d", { deleted: true });
      assert.deepEqual(yield* service.get({ threadId: a }), {
        environmentId,
        projectId,
        threadId: a,
        mode: "voice",
        voiceNotifications: true,
        archived: false,
      });
      const page = yield* service.list({ projectId, limit: 1 });
      assert.equal(page.items.length, 1);
      assert.equal(page.nextCursor, 1);
      const next = yield* service.list({ projectId, cursor: page.nextCursor!, limit: 1 });
      assert.deepEqual(next.items, [
        {
          environmentId,
          projectId,
          threadId: ThreadId.make("b"),
          mode: "sound",
          voiceNotifications: false,
          archived: true,
        },
      ]);
      assert.isNull(next.nextCursor);
      assert.equal((yield* service.list({})).items.length, 3);
      assert.equal(
        (yield* service.get({ threadId: deleted }).pipe(Effect.flip)).reason,
        "not_found",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "returns current persisted state on canonical receipt retries and isolates caller keys",
  () =>
    Effect.gen(function* () {
      const service = yield* Completion.CompletionNotificationService;
      const id = yield* seed("receipt");
      const request = { threadId: id, mode: "off" as const, clientRequestId: "same-key" };
      const first = yield* service.set(request, caller);
      assert.isFalse(first.hadReceipt);
      assert.equal(first.state.mode, "off");
      yield* service.set({ ...request, mode: "sound", clientRequestId: "new-choice" }, caller);
      const replay = yield* service.set(request, caller);
      assert.isTrue(replay.hadReceipt);
      assert.equal(replay.sequence, first.sequence);
      assert.equal(replay.state.mode, "sound");
      assert.isFalse(replay.state.voiceNotifications);
      const other = yield* service.set(request, { requestNamespace: "client:other" });
      assert.isFalse(other.hadReceipt);
      assert.equal(other.state.mode, "off");
      assert.equal(
        scopedThreadCommandId({
          requestNamespace: "provider:a/b",
          threadId: id,
          action: "rename",
          requestKey: "retry:1",
        }),
        "command:mcp:provider%3Aa%2Fb:thread-update:receipt:rename:retry%3A1",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "bulk includes all targets, records already-Off receipts and preserves later opt-ins on retry",
  () =>
    Effect.gen(function* () {
      const service = yield* Completion.CompletionNotificationService;
      const root = yield* seed("a-root");
      const quiet = yield* seed("b-quiet", { mode: "off" });
      yield* seed("c-child", { mode: "sound", child: true, archived: true, otherProvider: true });
      yield* seed("d-other", { otherProject: true });
      yield* seed("e-deleted", { deleted: true });
      const input = { projectId, clientRequestId: "bulk" };
      const first = yield* service.bulkOff(input, caller);
      assert.deepEqual(
        {
          total: first.total,
          turnedOff: first.turnedOff,
          alreadyOff: first.alreadyOff,
          failedCount: first.failedCount,
          complete: first.complete,
        },
        { total: 3, turnedOff: 2, alreadyOff: 1, failedCount: 0, complete: true },
      );
      for (const threadId of [root, quiet])
        yield* service.set(
          { threadId, mode: "sound", clientRequestId: `enable:${threadId}` },
          caller,
        );
      const retry = yield* service.bulkOff(input, caller);
      assert.equal(retry.turnedOff, 0);
      assert.equal(retry.alreadyOff, 1);
      assert.equal(retry.failedCount, 2);
      assert.isFalse(retry.complete);
      assert.isTrue(
        retry.failed.every(
          (failure) => failure.reason === "superseded" && failure.mode === "sound",
        ),
      );
      assert.equal((yield* service.get({ threadId: root })).mode, "sound");
      assert.equal((yield* service.get({ threadId: ThreadId.make("d-other") })).mode, "voice");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("checks target ceilings inside dispatch and continues authorized bulk targets", () =>
  Effect.gen(function* () {
    const service = yield* Completion.CompletionNotificationService;
    const denied = yield* seed("a-denied");
    const allowed = yield* seed("b-allowed", { runtimeMode: "approval-required" });
    const limited = {
      ...caller,
      authorize: () =>
        Effect.succeed({
          runtimeMode: "approval-required" as const,
          interactionMode: "default" as const,
        }),
    };
    const result = yield* service.bulkOff({ clientRequestId: "limited" }, limited);
    assert.equal(result.turnedOff, 1);
    assert.equal(result.failedCount, 1);
    assert.deepEqual(result.failed, [{ threadId: denied, reason: "permission_denied" }]);
    assert.isFalse(result.complete);
    assert.equal((yield* service.get({ threadId: allowed })).mode, "off");
    assert.equal((yield* service.get({ threadId: denied })).mode, "voice");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a target raised after service lookup using the lock-time mode check", () =>
  Effect.gen(function* () {
    const service = yield* Completion.CompletionNotificationService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = yield* seed("raised-target", { runtimeMode: "approval-required" });
    const refused = yield* service
      .set(
        { threadId, mode: "off", clientRequestId: "raise-race" },
        {
          ...caller,
          authorize: () =>
            threads
              .dispatch({
                type: "thread.runtime-mode.set",
                commandId: CommandId.make("raise-target"),
                threadId,
                runtimeMode: "full-access",
              })
              .pipe(
                Effect.as({
                  runtimeMode: "approval-required" as const,
                  interactionMode: "default" as const,
                }),
                Effect.mapError(() => new CompletionAudioError({ reason: "failed" })),
              ),
        },
      )
      .pipe(Effect.flip);
    assert.equal(refused.reason, "permission_denied");
    assert.equal((yield* service.get({ threadId })).mode, "voice");
  }).pipe(Effect.provide(layerTest)),
);

const scope = (
  access: "read-only" | "full-access" | "approval-required",
  wrongEnvironment = false,
): McpInvocation.McpInvocationScope => ({
  environmentId: wrongEnvironment ? EnvironmentId.make("wrong") : environmentId,
  requestNamespace: `client:${access}`,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  thread: undefined,
  client: { sessionId: access, label: "test", access },
});
const errorCode = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }));
const decodeMetadata = Schema.decodeUnknownEffect(CompletionAudioMetadata);
const decodeSet = Schema.decodeUnknownEffect(CompletionAudioSetResult);
const decodeBulk = Schema.decodeUnknownEffect(CompletionAudioBulkOffResult);
const decodePage = Schema.decodeUnknownEffect(CompletionAudioPage);
const decodePreferences = Schema.decodeUnknownEffect(
  Schema.Struct({
    completionAudio: Schema.Struct({
      defaultMode: Schema.String,
      tone: Schema.String,
      volume: Schema.Number,
    }),
  }),
);
const tools = Layer.mergeAll(
  McpToolAccess.HandlersLayer.layer(CompletionHandlers.layer),
  McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer),
).pipe(
  Layer.provideMerge(layerTest),
  Layer.provideMerge(Settings.layerTest()),
  Layer.provideMerge(ThreadCommandExecutor.layer),
  Layer.provideMerge(Layer.mock(CloudLink.CloudLink)({})),
  Layer.provideMerge(
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  ),
  Layer.provideMerge(
    Layer.mock(Registry.ProviderAdapterRegistryV2)({ list: () => Effect.succeed([]) }),
  ),
  Layer.provideMerge(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getDescriptor: Effect.succeed({
        environmentId,
        label: "test",
        serverVersion: "test",
        platform: { os: "linux", arch: "x64" },
        capabilities: { repositoryIdentity: false },
      }),
    }),
  ),
);

it.effect(
  "MCP enforces read-only/environment/default access and exposes durable preference readback",
  () =>
    Effect.gen(function* () {
      const threadId = yield* seed("mcp");
      const completion = yield* CompletionAudioToolkit;
      const environment = yield* EnvironmentToolkit;
      const call = <Name extends keyof typeof CompletionAudioToolkit.tools>(
        name: Name,
        input: Schema.Json,
        invocation = scope("full-access"),
      ) =>
        completion.handle(name, input).pipe(
          Stream.unwrap,
          Stream.runHead,
          Effect.map(Option.getOrThrow),
          Effect.map((result) => result.encodedResult),
          Effect.provideService(McpInvocation.McpInvocationContext, invocation),
        );
      const all = yield* call("t3_completion_audio_read", {}, scope("read-only"));
      assert.equal((yield* decodePage(all)).items.length, 1);
      const read = yield* call("t3_completion_audio_read", { threadId }, scope("read-only"));
      assert.equal((yield* decodeMetadata(read)).mode, "voice");
      assert.equal(
        errorCode(
          yield* call(
            "t3_completion_audio_set",
            { threadId, mode: "off", clientRequestId: "denied" },
            scope("read-only"),
          ),
        ).code,
        "capability_denied",
      );
      assert.equal(
        errorCode(yield* call("t3_completion_audio_read", { threadId }, scope("read-only", true)))
          .code,
        "capability_denied",
      );
      const ended = {
        ...scope("full-access"),
        client: undefined,
        thread: { threadId, providerSessionId: "ended", providerInstanceId: instanceId },
      };
      assert.equal(
        errorCode(
          yield* call(
            "t3_completion_audio_set",
            { threadId, mode: "off", clientRequestId: "ended" },
            ended,
          ),
        ).code,
        "parent_not_active",
      );
      const limitedBulk = yield* call(
        "t3_completion_audio_bulk_off",
        { clientRequestId: "limited" },
        scope("approval-required"),
      );
      assert.equal((yield* decodeBulk(limitedBulk)).failedCount, 1);
      assert.equal((yield* decodeBulk(limitedBulk)).complete, false);
      const updated = yield* call("t3_completion_audio_set", {
        threadId,
        mode: "sound",
        clientRequestId: "sound",
      });
      assert.equal((yield* decodeSet(updated)).state.mode, "sound");
      const bulk = yield* call("t3_completion_audio_bulk_off", { clientRequestId: "bulk" });
      assert.isTrue((yield* decodeBulk(bulk)).complete);
      const envCall = (invocation: McpInvocation.McpInvocationScope) =>
        environment
          .handle("t3_environment_preferences_update", {
            completionAudio: { defaultMode: "sound", tone: "input", volume: 0.5 },
          })
          .pipe(
            Stream.unwrap,
            Stream.runHead,
            Effect.map(Option.getOrThrow),
            Effect.map((result) => result.encodedResult),
            Effect.provideService(McpInvocation.McpInvocationContext, invocation),
          );
      assert.equal(errorCode(yield* envCall(scope("approval-required"))).code, "capability_denied");
      const saved = yield* envCall(scope("full-access"));
      assert.deepEqual((yield* decodePreferences(saved)).completionAudio, {
        defaultMode: "sound",
        tone: "input",
        volume: 0.5,
      });
      const page = yield* call("t3_completion_audio_read", { projectId });
      assert.equal((yield* decodePage(page)).items[0]?.mode, "off");
    }).pipe(Effect.provide(tools)),
);

it.effect("reports total failures when bulk failure details are truncated", () =>
  Effect.gen(function* () {
    const shells = Array.from({ length: 101 }, (_, index) => ({
      ...liveThreadShell(ThreadId.make(`failed:${index}`)),
      completionAudio: "voice" as const,
      voiceNotifications: true,
    }));
    const service = yield* Completion.CompletionNotificationService.pipe(
      Effect.provide(
        Completion.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getShellSnapshot: () =>
                  Effect.succeed({
                    schemaVersion: 1,
                    snapshotSequence: 0,
                    threads: shells,
                    archivedThreads: [],
                  }),
                getThreadShell: (id) =>
                  Effect.succeed(shells.find((shell) => shell.id === id) ?? null),
              }),
              Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(environmentId),
              }),
            ),
          ),
        ),
      ),
    );
    const result = yield* service.bulkOff(
      { clientRequestId: "failures" },
      {
        ...caller,
        authorize: () => Effect.fail(new CompletionAudioError({ reason: "permission_denied" })),
      },
    );
    assert.equal(result.total, 101);
    assert.equal(result.failedCount, 101);
    assert.equal(result.failed.length, 100);
    assert.isTrue(result.failuresTruncated);
    assert.isFalse(result.complete);
  }),
);
