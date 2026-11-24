import {
  AuthSessionId,
  CommandId,
  type AuthEnvironmentScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentId,
  EventId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  OrchestrationV2AppThread,
  OrchestrationV2Run,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2TurnItem,
  OrchestrationV2ThreadTranscript,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { threadTranscriptHeader } from "@t3tools/shared/threadTranscript";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Etag from "effect/http/Etag";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
import * as OrchestrationHttp from "./http.ts";
import { OrchestratorProjectionError } from "./Orchestrator.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

class TranscriptTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.orchestration,
) {}
const decodeTranscript = Schema.decodeUnknownEffect(
  Schema.toCodecJson(OrchestrationV2ThreadTranscript),
);

const now = DateTime.makeUnsafe("2026-09-29T00:00:00.000Z");
const environmentId = EnvironmentId.make("source-بيئة");
const output = "Full tool output. ".repeat(4_000);
const thread = Schema.decodeSync(OrchestrationV2AppThread)({
  id: "source-thread",
  projectId: "source-project",
  title: "Source 界\nconversation",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: "source-thread", parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});
const items = Schema.decodeUnknownSync(Schema.Array(OrchestrationV2TurnItem))(
  Array.from({ length: 200 }, (_, position) => ({
    id: `item-${position}`,
    threadId: "source-thread",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: position,
    type: "command_execution",
    status: "completed",
    title: "Read notes",
    input: "cat notes.md",
    output: position === 0 ? output : "Done",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  })),
);

const rolledBackRun = Schema.decodeSync(OrchestrationV2Run)({
  id: "run:rolled-back",
  threadId: "source-thread",
  ordinal: 1,
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  providerThreadId: null,
  userMessageId: "message:rolled-back",
  rootNodeId: null,
  activeAttemptId: null,
  status: "rolled_back",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
});

// Serves the orchestration HTTP routes over real stores; `allowed` gates the read scope.
const serveOrchestrationHttp = (
  allowed: () => boolean,
  getThreadSnapshot?: ThreadManagementService.ThreadManagementServiceShape["getThreadSnapshot"],
  options?: {
    readonly scopes?: () => ReadonlyArray<AuthEnvironmentScope>;
    readonly launch?: ThreadLaunchService.ThreadLaunchService["Service"]["launch"];
    readonly projectShell?: ProjectStore.ProjectStoreV2["Service"]["getShell"];
  },
) =>
  Effect.gen(function* () {
    const runtime = ProviderReplayHarness.layerWithRegistry(
      { name: "thread-transcript" },
      ProviderAdapterRegistry.layerFromAdapters([]),
      { runEffectWorker: false },
    );
    const serverSettingsLayer = ServerSettings.layerTest({});
    const services = yield* Layer.build(
      Layer.mergeAll(
        runtime,
        ThreadManagementService.layer.pipe(
          Layer.provide(Layer.mergeAll(runtime, CommandReceiptStore.layer, serverSettingsLayer)),
        ),
        OrchestrationEventStore.layer,
        ProjectStore.layer,
        serverSettingsLayer,
      ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    );
    const eventSink = Context.get(services, EventSinkV2);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("create-source"),
          type: "thread.created",
          threadId: thread.id,
          occurredAt: now,
          payload: thread,
        },
      ],
    });
    const baseContext =
      getThreadSnapshot === undefined
        ? services
        : Context.add(services, ThreadManagementService.ThreadManagementService, {
            ...Context.get(services, ThreadManagementService.ThreadManagementService),
            getThreadSnapshot,
          });
    const serviceContext =
      options?.projectShell === undefined
        ? baseContext
        : Context.add(baseContext, ProjectStore.ProjectStoreV2, {
            ...Context.get(baseContext, ProjectStore.ProjectStoreV2),
            getShell: options.projectShell,
          });
    const routes = HttpApiBuilder.layer(TranscriptTestApi).pipe(
      Layer.provide(OrchestrationHttp.layer),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
      Layer.provide(
        Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
          Effect.suspend(() =>
            effect.pipe(
              Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                sessionId: AuthSessionId.make("test-session"),
                subject: "test",
                method: "bearer-access-token",
                scopes: new Set<AuthEnvironmentScope>(
                  options?.scopes ? options.scopes() : allowed() ? ["orchestration:read"] : [],
                ),
              }),
            ),
          ),
        ),
      ),
      Layer.provide(Layer.succeedContext(serviceContext)),
      Layer.provide(Layer.mock(ProjectEnrichmentService)({})),
      Layer.provide(
        Layer.mock(ThreadLaunchService.ThreadLaunchService)(
          options?.launch ? { launch: options.launch } : {},
        ),
      ),
      Layer.provide(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            {
              instanceId: "codex",
              driver: "codex",
              label: "Codex",
              enabled: true,
              status: "ready",
              installed: true,
              auth: { status: "authenticated" },
              models: [
                {
                  slug: "gpt-5.4",
                  name: "GPT-5.4",
                  isCustom: false,
                  capabilities: null,
                },
              ],
              supportedRuntimeModes: ["full-access", "approval-required"],
              checkedAt: "2026-09-29T00:00:00.000Z",
            } as unknown as import("@t3tools/contracts").ServerProvider,
          ]),
        }),
      ),
      Layer.provide(HttpPlatform.layer),
      Layer.provide(Etag.layerWeak),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    return { services, eventSink, handler };
  });

it.effect("exports full history with size, scope, and missing-thread checks", () =>
  Effect.gen(function* () {
    let allowed = true;
    const { services, eventSink, handler } = yield* serveOrchestrationHttp(() => allowed);
    const read = (threadId: ThreadId) =>
      Effect.promise(() =>
        handler(
          new Request(`http://localhost/api/orchestration/threads/${threadId}/transcript`, {
            headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
          }),
        ),
      );

    const readTranscriptError = Context.get(
      services,
      ThreadManagementService.ThreadManagementService,
    )
      .getThreadTranscript(thread.id)
      .pipe(
        Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
        Effect.flip,
      );

    const emptyResponse = yield* read(thread.id);
    expect(emptyResponse.status).toBe(200);
    expect(
      (yield* decodeTranscript(yield* Effect.promise(() => emptyResponse.json()))).items,
    ).toEqual([]);
    yield* eventSink.write({
      events: items.map((item) => ({
        id: EventId.make(`create-${item.id}`),
        type: "turn-item.updated" as const,
        threadId: thread.id,
        occurredAt: now,
        payload: item,
      })),
    });

    const response = yield* read(thread.id);
    expect(response.status).toBe(200);
    const transcript = yield* decodeTranscript(yield* Effect.promise(() => response.json()));
    expect(transcript.items).toHaveLength(200);
    expect(transcript.items[0]?.item).toMatchObject({ output });
    expect(transcript.items[0]?.visibility).toBe("local");
    expect(transcript.items[199]?.position).toBe(199);

    const emptyOutputRows = transcript.items.map((row, position) =>
      position === 0 ? { ...row, item: { ...row.item, output: "" } } : row,
    );
    const header = threadTranscriptHeader(environmentId, transcript);
    const baseSize =
      Buffer.byteLength(header, "utf8") +
      emptyOutputRows.reduce(
        (size, row) => size + Buffer.byteLength(`${JSON.stringify(row)}\n`, "utf8"),
        0,
      );
    const boundaryOutput = "界" + "x".repeat(PROVIDER_SEND_TURN_MAX_FILE_BYTES - baseSize - 3);
    for (const [suffix, expectedStatus] of [
      ["", 200],
      ["x", 400],
    ] as const) {
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`boundary-${expectedStatus}`),
            type: "turn-item.updated",
            threadId: thread.id,
            occurredAt: now,
            payload: {
              ...items.find((item) => item.type === "command_execution")!,
              output: boundaryOutput + suffix,
            },
          },
        ],
      });
      const response = yield* read(thread.id);
      expect(response.status).toBe(expectedStatus);
      if (expectedStatus === 200) continue;
      expect(yield* readTranscriptError).toBeInstanceOf(
        ThreadManagementService.ThreadTranscriptTooLargeError,
      );
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        _tag: "EnvironmentRequestInvalidError",
        reason: "thread_transcript_too_large",
      });
    }

    const sql = Context.get(services, SqlClient.SqlClient);
    const commandItemId = items.find((item) => item.type === "command_execution")!.id;
    const setCommandPayload = (payload: Statement.Fragment) => sql`
      UPDATE orchestration_v2_projection_turn_items SET payload_json = ${payload}
      WHERE turn_item_id = ${commandItemId}
    `;
    const fill = (bytes: number) => sql`printf('%.*c', ${bytes}, 'x')`;
    // Stored bytes the export drops do not count, and neither does a row SQLite cannot parse:
    // only what the export keeps can reject it.
    yield* setCommandPayload(sql`json_set(
      payload_json, '$.output', 'x',
      '$.droppedLegacyField', ${fill(PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1)}
    )`);
    expect((yield* read(thread.id)).status).toBe(200);
    const deepField = sql`'"droppedDeepField":' || printf('%.*c', 1001, '[') || printf('%.*c', 1001, ']') || ','`;
    yield* setCommandPayload(
      sql`replace(payload_json, '"droppedLegacyField":', ${deepField} || '"droppedLegacyField":')`,
    );
    expect((yield* read(thread.id)).status).toBe(200);
    // Tool output over the limit rejects the export, here as the content array a dynamic tool
    // stores. Its only read is the size.
    yield* sql`
      UPDATE orchestration_v2_projection_turn_items SET type = 'dynamic_tool'
      WHERE turn_item_id = ${commandItemId}
    `;
    yield* setCommandPayload(sql`json_set(
      replace(payload_json, ${deepField}, ''), '$.type', 'dynamic_tool', '$.toolName', NULL,
      '$.output',
      json_array(json_object('type', 'text', 'text', ${fill(PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1)}))
    )`);
    const reads: Array<string> = [];
    expect(
      yield* readTranscriptError.pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) => {
          reads.push(statement.compile()[0]);
          return Effect.succeed(statement);
        }),
      ),
    ).toBeInstanceOf(ThreadManagementService.ThreadTranscriptTooLargeError);
    expect(reads).toEqual([expect.stringContaining("octet_length(payload_json)")]);
    expect((yield* read(thread.id)).status).toBe(400);
    // The export leaves a rolled back run out, so its output cannot reject it.
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("create-rolled-back-run"),
          type: "run.created",
          threadId: thread.id,
          occurredAt: now,
          payload: rolledBackRun,
        },
      ],
    });
    yield* sql`
      UPDATE orchestration_v2_projection_turn_items SET run_id = ${rolledBackRun.id}
      WHERE turn_item_id = ${commandItemId}
    `;
    yield* setCommandPayload(sql`json_set(payload_json, '$.runId', ${rolledBackRun.id})`);
    const withoutRolledBackRun = yield* read(thread.id);
    expect(withoutRolledBackRun.status).toBe(200);
    expect(
      (yield* decodeTranscript(yield* Effect.promise(() => withoutRolledBackRun.json()))).items,
    ).toHaveLength(199);

    expect((yield* read(ThreadId.make("missing"))).status).toBe(404);
    allowed = false;
    expect((yield* read(thread.id)).status).toBe(403);
  }),
);

const decodeThreadSnapshot = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot),
);

it.effect("streams the full snapshot with the endpoint's errors", () =>
  Effect.gen(function* () {
    const { services, eventSink, handler } = yield* serveOrchestrationHttp(() => true);
    yield* eventSink.write({
      events: items.map((item) => ({
        id: EventId.make(`create-${item.id}`),
        type: "turn-item.updated" as const,
        threadId: thread.id,
        occurredAt: now,
        payload: item,
      })),
    });
    const read = (serve: typeof handler, threadId: ThreadId) =>
      Effect.promise(() =>
        serve(
          new Request(`http://localhost/api/orchestration/threads/${threadId}`, {
            headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
          }),
        ),
      );
    const snapshot = yield* Context.get(
      services,
      ThreadManagementService.ThreadManagementService,
    ).getThreadSnapshot(thread.id);

    const response = yield* read(handler, thread.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = decodeThreadSnapshot(yield* Effect.promise(() => response.json()));
    expect(body.snapshotSequence).toBe(snapshot.snapshotSequence);
    expect(body.projection.turnItems).toHaveLength(snapshot.projection.turnItems.length);

    const missing = yield* read(handler, ThreadId.make("missing"));
    expect(missing.status).toBe(404);
    expect(yield* Effect.promise(() => missing.json())).toMatchObject({
      _tag: "EnvironmentResourceNotFoundError",
      reason: "thread_not_found",
    });
    const failing = yield* serveOrchestrationHttp(
      () => true,
      (threadId) =>
        Effect.fail(new OrchestratorProjectionError({ threadId, cause: new Error("disk I/O") })),
    );
    const failed = yield* read(failing.handler, thread.id);
    expect(failed.status).toBe(500);
    expect(yield* Effect.promise(() => failed.json())).toMatchObject({
      _tag: "EnvironmentInternalError",
      reason: "orchestration_thread_snapshot_failed",
    });
    // A projection its schema rejects is an empty 500, as a failed response encoding is.
    const [first, ...rest] = snapshot.projection.turnItems;
    const unencodable = yield* serveOrchestrationHttp(
      () => true,
      () =>
        Effect.succeed({
          ...snapshot,
          projection: {
            ...snapshot.projection,
            turnItems: [
              { ...first!, status: "unknown" } as unknown as OrchestrationV2TurnItem,
              ...rest,
            ],
          },
        }),
    );
    const rejected = yield* read(unencodable.handler, thread.id);
    expect(rejected.status).toBe(500);
    expect(yield* Effect.promise(() => rejected.text())).toBe("");
  }),
);

it.effect("leaves older settled threads out of the HTTP shell only when asked", () =>
  Effect.gen(function* () {
    const { eventSink, handler } = yield* serveOrchestrationHttp(() => true);
    yield* eventSink.write({
      events: Array.from({ length: 26 }, (_, index) => {
        const id = ThreadId.make(`settled-${index}`);
        return {
          id: EventId.make(`create-${id}`),
          type: "thread.created" as const,
          threadId: id,
          occurredAt: now,
          payload: {
            ...thread,
            id,
            lineage: { ...thread.lineage, rootThreadId: id },
            settledOverride: "settled" as const,
            settledAt: DateTime.makeUnsafe(Date.UTC(2026, 8, 1 + index)),
          },
        };
      }),
    });
    const shell = (query: string) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://localhost/api/orchestration/shell${query}`, {
            headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
          }),
        );
        return (await response.json()) as {
          readonly snapshotSequence: number;
          readonly projectIdentities?: string;
          readonly threads: ReadonlyArray<{ readonly id: string }>;
          readonly olderSettled?: { readonly counts: ReadonlyArray<unknown> };
        };
      });

    const full = yield* shell("");
    expect(full.threads).toHaveLength(27);
    expect(full.olderSettled).toBeUndefined();
    const cut = yield* shell("?omitOlderSettled=1");
    expect(cut.threads.map((row) => row.id).toSorted()).toEqual(
      [thread.id, ...Array.from({ length: 25 }, (_, index) => `settled-${index + 1}`)].toSorted(),
    );
    expect(cut.olderSettled?.counts).toEqual([{ projectId: thread.projectId, count: 1 }]);

    // A client that holds rows the socket can replay from keeps them; any other cursor reloads.
    expect(full.projectIdentities).toBeTypeOf("string");
    expect(yield* shell(`?resumeFrom=${full.snapshotSequence}`)).toEqual({ resumable: true });
    expect(yield* shell(`?resumeFrom=${full.snapshotSequence - 1}`)).toEqual({ resumable: true });
    for (const cursor of [full.snapshotSequence + 1, "x"]) {
      expect((yield* shell(`?omitOlderSettled=1&resumeFrom=${cursor}`)).threads).toHaveLength(26);
    }
  }),
);

it.effect("dispatches commands, sends messages, and launches threads with scope enforcement", () =>
  Effect.gen(function* () {
    let scopes: ReadonlyArray<AuthEnvironmentScope> = ["orchestration:read"];
    const launchedCalls: Array<ThreadLaunchService.ThreadLaunchInput> = [];
    const { services, handler } = yield* serveOrchestrationHttp(() => true, undefined, {
      scopes: () => scopes,
      projectShell: (projectId) => {
        if (projectId !== ProjectId.make("source-project")) {
          return Effect.succeedNone;
        }
        return Effect.succeedSome({
          id: projectId,
          title: "t3code",
          workspaceRoot: "/tmp/t3code",
          defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          scripts: [],
          createdAt: "2026-09-29T00:00:00.000Z",
          updatedAt: "2026-09-29T00:00:00.000Z",
        });
      },
      launch: (input) => {
        launchedCalls.push(input);
        return Effect.succeed({
          threadId: input.threadId ?? ThreadId.make("launched-thread"),
          projection: {
            thread: {
              ...thread,
              id: input.threadId ?? ThreadId.make("launched-thread"),
              title: input.title,
            },
            runs: [],
            attempts: [],
            nodes: [],
            subagents: [],
            providerSessions: [],
            providerThreads: [],
            providerTurns: [],
            runtimeRequests: [],
            messages: [],
            plans: [],
            turnItems: [],
            checkpointScopes: [],
            checkpoints: [],
            contextHandoffs: [],
            contextTransfers: [],
            visibleTurnItems: [],
            updatedAt: now,
          },
          resumed: false,
          sequence: 9,
        });
      },
    });

    const post = (path: string, body: unknown) =>
      Effect.promise(() =>
        handler(
          new Request(`http://localhost${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
            },
            body: JSON.stringify(body),
          }),
        ),
      );

    // Read-only token cannot mutate.
    const denied = yield* post("/api/orchestration/commands", {
      type: "thread.pin",
      commandId: CommandId.make("cmd-denied"),
      threadId: thread.id,
    });
    expect(denied.status).toBe(403);

    scopes = ["orchestration:read", "orchestration:operate"];

    // Pin succeeds and updates persisted shell state.
    const pinned = yield* post("/api/orchestration/commands", {
      type: "thread.pin",
      commandId: CommandId.make("cmd-pin"),
      threadId: thread.id,
    });
    expect(pinned.status).toBe(200);
    expect(yield* Effect.promise(() => pinned.json())).toMatchObject({
      sequence: expect.any(Number),
    });
    const updatedShell = yield* Context.get(
      services,
      ThreadManagementService.ThreadManagementService,
    ).getThreadShell(thread.id);
    expect(updatedShell?.pinnedAt).not.toBeNull();

    // Sign-out prompt requires providers:manage scope.
    const signOutDenied = yield* post(`/api/orchestration/threads/${thread.id}/messages`, {
      commandId: CommandId.make("cmd-logout"),
      text: "/logout",
    });
    expect(signOutDenied.status).toBe(403);

    // Missing thread on message send yields 404.
    const missingThread = yield* post("/api/orchestration/threads/missing/messages", {
      commandId: CommandId.make("cmd-missing-msg"),
      text: "Check build status",
    });
    expect(missingThread.status).toBe(404);

    // Launch resolves project default model and passes initial prompt.
    const launched = yield* post("/api/orchestration/threads", {
      commandId: CommandId.make("cmd-launch"),
      projectId: ProjectId.make("source-project"),
      message: "Fix the failing unit test",
      creationSource: "mobile",
    });
    expect(launched.status).toBe(200);
    expect(yield* Effect.promise(() => launched.json())).toMatchObject({
      threadId: "launched-thread",
      projectId: "source-project",
      resumed: false,
      sequence: 9,
    });
    expect(launchedCalls).toHaveLength(1);
    expect(launchedCalls[0]).toMatchObject({
      projectId: "source-project",
      creationSource: "mobile",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      initialMessage: { text: "Fix the failing unit test", attachments: [] },
    });

    // Missing project on launch yields 404.
    const missingProject = yield* post("/api/orchestration/threads", {
      commandId: CommandId.make("cmd-launch-missing"),
      projectId: ProjectId.make("unknown-project"),
    });
    expect(missingProject.status).toBe(404);
  }),
);
