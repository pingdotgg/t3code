import * as Maintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import { OrchestrationV2AppThread } from "@t3tools/contracts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as RunFinalization from "../orchestration-v2/RunFinalizationService.ts";
import * as Rollback from "../orchestration-v2/CheckpointRollbackService.ts";
import * as TurnControl from "../orchestration-v2/ProviderTurnControlService.ts";
import * as TurnStart from "../orchestration-v2/ProviderTurnStartService.ts";
import * as RuntimeRequests from "../orchestration-v2/RuntimeRequestService.ts";
import * as ThreadTitle from "../orchestration-v2/ThreadTitleRegenerationService.ts";
import { CONTINUE_PROMPT } from "../orchestration-v2/RestartContinuation.ts";
import type { OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as Runtime from "../persistence/ProviderSessionRuntime.ts";
import * as Outbox from "../orchestration-v2/EffectOutbox.ts";
import * as Option from "effect/Option";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProjectId, ProviderDriverKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Source from "./ClaudeAttachmentSource.ts";
import * as Attachment from "./ClaudeSessionAttachment.ts";
import * as Project from "./ProjectService.ts";
import { attachmentThreadId, attachmentEvent } from "./claudeAttachmentProjection.ts";

const threadCodec = Schema.toCodecJson(OrchestrationV2AppThread);
const encodeThread = Schema.encodeSync(threadCodec);
const decodeThread = Schema.decodeUnknownSync(threadCodec);

it.effect.each(["wait", "interrupt"] as const)(
  "preserves history and resumes only an interrupted handoff (interrupt: %s)",
  (mode) =>
    Effect.gen(function* () {
      const interrupt = mode !== "wait";
      let alive = true;
      let interruptions = 0;
      let restartDuringImport = false;
      let incomplete = false;
      let accountHome = "/claude";
      let accountEnabled = true;
      const root = "/claude/projects/project/session.jsonl";
      const child = "/claude/projects/project/session/subagents/agent-child.jsonl";
      const record = (uuid: string) =>
        JSON.stringify({
          type: "assistant",
          uuid,
          sessionId: "session",
          cwd: uuid === "latest" ? "/work/later" : "/work/original",
          timestamp: "2026-01-01T00:00:00Z",
          message: { content: uuid, stop_reason: "end_turn", model: "claude-sonnet-4-6" },
        });
      const files = new Map([
        [root, [record("first"), record("latest")]],
        [child, [record("child-final")]],
      ]);
      const source = Layer.mock(Source.ClaudeAttachmentSource)({
        interrupt: (_home, _sessionId, options) =>
          Effect.sync(() => {
            if (options?.verifyOnly) return;
            interruptions++;
            alive = false;
          }),
        discover: () =>
          Effect.succeed({ sessionId: "session", title: "Session", transcriptPath: root }),
        assertStopped: () =>
          alive
            ? Effect.fail(
                new Source.ClaudeAttachmentSourceError({
                  operation: "handoff",
                  reason: "running",
                  cause: "alive",
                }),
              )
            : Effect.void,
        children: () =>
          Effect.sync(() => (files.has(child) ? [{ agentId: "child", path: child }] : [])),
        tail: (_home, path) =>
          Effect.sync(() => {
            if (restartDuringImport && path === child) alive = true;
            return {
              lines: files.get(path)!,
              offset: 0,
              modifiedAt: 0,
              size: Buffer.byteLength(files.get(path)!.join("\n") + "\n") + (incomplete ? 1 : 0),
            };
          }),
        read: (_home, path, cursor) =>
          Effect.sync(() => {
            const bytes = Buffer.from(files.get(path)!.join("\n") + "\n");
            const remaining = bytes.subarray(cursor.offset);
            const end = remaining.indexOf(10);
            return end < 0
              ? { lines: [], cursor, caughtUp: true }
              : {
                  lines: [remaining.subarray(0, end).toString()],
                  cursor: { offset: cursor.offset + end + 1 },
                  caughtUp: cursor.offset + end + 1 === bytes.length,
                };
          }),
      });
      const projectId = ProjectId.make("project");
      const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
        Layer.provideMerge(Sqlite.layerMemory),
      );
      const deps = Layer.mergeAll(
        Runtime.layer.pipe(Layer.provide(stores)),
        Maintenance.layer.pipe(Layer.provide(stores)),
        Outbox.layer.pipe(Layer.provide(stores)),
        stores,
        EventSink.layer.pipe(Layer.provide(stores)),
        source,
        Layer.succeed(HostProcess.HomeDirectory, "/"),
        Layer.succeed(HostProcess.Environment, { CLAUDE_CONFIG_DIR: "/claude" }),
        Path.layer,
        Layer.succeed(ServerActivation, Effect.never),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.sync(() => ({
            ...DEFAULT_SERVER_SETTINGS,
            providerInstances: {
              claudeAgent: {
                driver: ProviderDriverKind.make("claudeAgent"),
                enabled: accountEnabled,
                config: { homePath: accountHome },
              },
            },
          })),
        }),
        Layer.mock(Project.ProjectService)({
          getById: () =>
            Effect.succeedSome({
              id: projectId,
              title: "Project",
              workspaceRoot: "/work/project",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              deletedAt: null,
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* Attachment.ClaudeSessionAttachment;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const attached = yield* service.change({ action: "attach", projectId, session: "Session" });
        const outbox = yield* Outbox.EffectOutboxV2;
        accountHome = "/another-account";
        yield* service.change({ action: "handoff", threadId: attached.threadId }).pipe(Effect.flip);
        accountHome = "/claude";
        accountEnabled = false;
        expect(
          (yield* service
            .change({ action: "handoff", threadId: attached.threadId })
            .pipe(Effect.flip)).reason,
        ).toBe("unavailable-instance");
        accountEnabled = true;
        expect(
          (yield* service.change({ action: "handoff", threadId: attached.threadId })).blocked,
        ).toBe(true);
        expect(
          Option.isNone(yield* projections.getThread(attached.threadId).pipe(Effect.option)),
        ).toBe(true);
        expect(interruptions).toBe(0);
        alive = false;
        incomplete = true;
        yield* service.change({ action: "handoff", threadId: attached.threadId }).pipe(Effect.flip);
        expect(Option.isNone(yield* outbox.claimNext({ workerId: "test" }))).toBe(true);
        incomplete = false;
        restartDuringImport = true;
        yield* service.change({ action: "handoff", threadId: attached.threadId }).pipe(Effect.flip);
        restartDuringImport = false;
        alive = interrupt;
        const sql = yield* SqlClient.SqlClient;
        if (interrupt) {
          yield* sql`CREATE TEMP TRIGGER reject_handoff_effect BEFORE INSERT ON orchestration_v2_effect_outbox
            BEGIN SELECT RAISE(ABORT, 'Simulated outbox write failure'); END`;
          yield* service
            .change({ action: "handoff", threadId: attached.threadId, interrupt })
            .pipe(Effect.flip);
          yield* sql`DROP TRIGGER reject_handoff_effect`;
          expect((yield* projections.getThread(attached.threadId)).worktreePath).toBeNull();
        }
        expect(
          yield* service.change({ action: "handoff", threadId: attached.threadId, interrupt }),
        ).toEqual({ threadId: attached.threadId, attached: false, readOnly: false });
        expect(interruptions).toBe(interrupt ? 1 : 0);
        const imported = yield* sql<{ ordinal: number }>`SELECT ordinal
          FROM orchestration_v2_projection_turn_items WHERE thread_id = ${attached.threadId}
          ORDER BY ordinal`;
        expect(imported.map((item) => item.ordinal)).toEqual([1, 2]);
        const after = yield* projections.getThread(attached.threadId);
        expect(after.worktreePath).toBe("/work/later");
        // Deployed histories retain these former fields; the current codec strips them without a migration.
        expect(
          decodeThread(
            Object.assign({}, encodeThread(after), {
              externalSession: {
                provider: "claude",
                state: "handed-off",
                cursor: 100,
                projectionVersion: 3,
              },
              handoffContinuationId: "legacy-continuation",
            }),
          ),
        ).toEqual(after);
        expect(after.modelSelection.model).toBe("claude-sonnet-4-6");
        const records = yield* projections.getThreadRecords(attached.threadId, [
          "messages",
          "providerThreads",
        ]);
        expect(records.messages.map((message) => message.text).sort()).toEqual(["first", "latest"]);
        expect(records.providerThreads[0]?.nativeThreadRef?.nativeId).toBe("session");
        expect(records.providerThreads[0]?.nativeMetadata?.claudeResumeTranscriptPath).toBe(root);
        expect(
          (yield* projections.getThreadRecords(attached.threadId, ["subagents"])).subagents,
        ).toMatchObject([{ status: "completed", title: "Claude subagent child" }]);
        const childId = attachmentThreadId("/claude", "session", "child");
        expect((yield* projections.getThreadRecords(childId, ["messages"])).messages[0]?.text).toBe(
          "child-final",
        );
        const sink = yield* EventSink.EventSinkV2;
        yield* sink.write({
          events: [
            attachmentEvent(
              after.id,
              "thread.metadata-updated",
              after,
              after.updatedAt,
              "after-handoff",
            ),
          ],
        });
        const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
        expect((yield* maintenance.compactEventStore()).deletedEventCount).toBeGreaterThan(0);
        const runtimes = yield* Runtime.ProviderSessionRuntimeRepository;
        const stored = yield* runtimes.getByThreadId({ threadId: attached.threadId });
        expect(Option.isSome(stored)).toBe(true);
        if (Option.isSome(stored)) {
          const managed = {
            ...stored.value,
            status: "running" as const,
            runtimePayload: { managed: true },
          };
          yield* runtimes.upsert(managed);
          alive = true;
          yield* service.change({
            action: "handoff",
            threadId: attached.threadId,
            interrupt: true,
          });
          yield* service.change({ action: "attach", projectId, session: "Session" });
          expect(yield* runtimes.getByThreadId({ threadId: attached.threadId })).toEqual(
            Option.some(managed),
          );
          expect(interruptions).toBe(interrupt ? 1 : 0);
        }
        expect(yield* projections.getThread(attached.threadId)).toEqual(after);
        const effect = yield* outbox.claimNext({ workerId: "test" });
        expect(Option.isSome(effect)).toBe(interrupt);
        if (Option.isSome(effect))
          expect(effect.value.request.type).toBe("thread.handoff-continue");
        expect(Option.isNone(yield* outbox.claimNext({ workerId: "test" }))).toBe(true);
        const commands: OrchestrationV2ServerCommand[] = [];
        // Recover a claim abandoned by a crashed worker, then drain through the real executor.
        yield* outbox.reconcileAfterProcessLoss;
        const executor = EffectWorker.layerExecutor.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProviderSessions.ProviderSessionManagerV2)({}),
              Layer.mock(RunFinalization.RunFinalizationService)({}),
              Layer.mock(Rollback.CheckpointRollbackServiceV2)({}),
              Layer.mock(TurnControl.ProviderTurnControlServiceV2)({}),
              Layer.mock(TurnStart.ProviderTurnStartServiceV2)({}),
              Layer.mock(RuntimeRequests.RuntimeRequestServiceV2)({}),
              Layer.mock(ThreadTitle.ThreadTitleRegenerationService)({}),
              ServerSettings.layerTest(),
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getThreadRecords: (id, sections) =>
                  projections.getThreadRecords(id, sections).pipe(Effect.orDie),
                dispatch: (command) =>
                  Effect.sync(() => {
                    commands.push(command);
                    return { sequence: 1, storedEvents: [] };
                  }),
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          expect(yield* worker.drain()).toBe(interrupt ? 1 : 0);
          expect(yield* worker.drain()).toBe(0);
        }).pipe(Effect.provide(EffectWorker.layer.pipe(Layer.provide(executor))));
        expect(commands).toHaveLength(interrupt ? 1 : 0);
        if (interrupt)
          expect(commands[0]).toMatchObject({
            type: "message.dispatch",
            text: CONTINUE_PROMPT,
            createdBy: "agent",
            creationSource: "server",
            notification: { source: { kind: "system" } },
            dispatchMode: { type: "queue_after_active" },
          });
      }).pipe(Effect.provide(Attachment.layer.pipe(Layer.provideMerge(deps))));
    }),
);
