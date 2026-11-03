import {
  ClaudeSettings,
  CommandId,
  resolveProviderInstanceEnabled,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  ProjectId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Subagent,
  type ClaudeSessionAttachmentInput,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import * as ProjectService from "./ProjectService.ts";
import * as Source from "./ClaudeAttachmentSource.ts";
import {
  attachmentEvent,
  attachmentEventId,
  attachmentDetails,
  attachmentReasoningId,
  attachmentNodeId,
  attachmentThreadId,
  projectAttachmentLine,
} from "./claudeAttachmentProjection.ts";

import * as Runtime from "../persistence/ProviderSessionRuntime.ts";
const isSourceError = Schema.is(Source.ClaudeAttachmentSourceError);

export class ClaudeSessionAttachmentError extends Schema.TaggedError<ClaudeSessionAttachmentError>()(
  "ClaudeSessionAttachmentError",
  {
    cause: Schema.Defect(),
    reason: Schema.optional(
      Schema.Literals(["unsupported-provider", "unavailable-instance", "handoff-blocked"]),
    ),
  },
) {
  override get message() {
    if (isSourceError(this.cause)) return this.cause.message;
    if (this.reason === "handoff-blocked" && typeof this.cause === "string") return this.cause;
    if (this.reason === "handoff-blocked" && this.cause instanceof Error) return this.cause.message;
    if (this.reason === "unsupported-provider")
      return "Session handoff is not implemented for this provider. The existing session was not changed.";
    if (this.reason === "unavailable-instance")
      return "Select an enabled provider instance configured in this T3 environment.";
    return "Could not attach the Claude session. Use its exact live name or session ID and an existing T3 project. The Claude process was not changed.";
  }
}
const AttachmentState = Schema.Struct({
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  sessionId: Schema.String,
  configDirectory: Schema.String,
  transcriptPath: Schema.String,
  title: Schema.String,
  interrupted: Schema.Boolean,
  cursors: Schema.Record(
    Schema.String,
    Schema.Struct({
      offset: Schema.Number,
      identity: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
    }),
  ),
});
type AttachmentState = typeof AttachmentState.Type;
const decodeRequiredState = Schema.decodeUnknownEffect(
  Schema.Struct({ claudeHandoff: AttachmentState }),
);
const decodeOptionalState = Schema.decodeUnknownEffect(
  Schema.Struct({ claudeHandoff: Schema.optional(AttachmentState) }),
);
const isAttachmentError = Schema.is(ClaudeSessionAttachmentError);
export class ClaudeSessionAttachment extends Context.Service<
  ClaudeSessionAttachment,
  {
    readonly change: (input: ClaudeSessionAttachmentInput) => Effect.Effect<
      {
        threadId: ThreadId;
        attached: boolean;
        readOnly: boolean;
        blocked?: boolean;
      },
      ClaudeSessionAttachmentError
    >;
  }
>()("t3/project/ClaudeSessionAttachment") {}
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const make = Effect.gen(function* () {
  const source = yield* Source.ClaudeAttachmentSource;
  const events = yield* EventStore.EventStoreV2;
  const handoffCompleted = (id: ThreadId) =>
    events
      .readByIds([attachmentEventId(id, "provider-thread.updated", "handoff-complete")])
      .pipe(Effect.map((rows) => rows.length > 0));
  const sink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const runtimes = yield* Runtime.ProviderSessionRuntimeRepository;
  const projects = yield* ProjectService.ProjectService;
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const path = yield* Path.Path;
  const settings = yield* ServerSettings.ServerSettingsService;
  const gate = yield* Semaphore.make(1);
  const persist = Effect.fn("ClaudeSessionAttachment.persist")(function* (
    threadId: ThreadId,
    state: AttachmentState,
  ) {
    const now = yield* DateTime.now;
    yield* runtimes.upsert({
      threadId,
      providerName: "claudeAgent",
      providerInstanceId: state.providerInstanceId,
      adapterKey: "claudeAgent",
      runtimeMode: "approval-required",
      status: "stopped",
      lastSeenAt: DateTime.formatIso(now),
      resumeCursor: null,
      runtimePayload: { claudeHandoff: state },
    });
  });
  const resolveConfigDirectory = Effect.fn("ClaudeSessionAttachment.resolveConfigDirectory")(
    function* (providerInstanceId: ProviderInstanceId) {
      const configured = (yield* settings.getSettings).providerInstances[providerInstanceId];
      if (configured && configured.driver !== "claudeAgent")
        return yield* new ClaudeSessionAttachmentError({
          reason: "unsupported-provider",
          cause: "Provider has no live attachment adapter",
        });
      if (
        (!configured && providerInstanceId !== "claudeAgent") ||
        (configured && !resolveProviderInstanceEnabled(configured))
      )
        return yield* new ClaudeSessionAttachmentError({
          reason: "unavailable-instance",
          cause: "Provider instance is missing or disabled",
        });
      const config = yield* decodeClaudeSettings(configured?.config ?? {});
      const instanceEnvironment = yield* mergeProviderInstanceEnvironment(
        configured?.environment,
        environment,
      ).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Platform, platform),
      );
      return yield* resolveClaudeHomePath(config, instanceEnvironment).pipe(
        Effect.provideService(Path.Path, path),
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
    },
  );

  const create = Effect.fn("ClaudeSessionAttachment.create")(function* (
    parent: OrchestrationV2AppThread | null,
    data: {
      configDirectory: string;
      providerInstanceId: ProviderInstanceId;
      sessionId: string;
      transcriptPath: string;
      title: string;
      projectId: OrchestrationV2AppThread["projectId"];
      agentId?: string;
      confirmedParent?: boolean;
      model?: string;
    },
  ) {
    const { configDirectory, providerInstanceId } = data;
    const threadId = attachmentThreadId(configDirectory, data.sessionId, data.agentId);
    const existing = yield* projections.getThread(threadId).pipe(Effect.option);
    if (Option.isSome(existing)) {
      if (
        existing.value.projectId !== data.projectId ||
        existing.value.providerInstanceId !== providerInstanceId ||
        existing.value.deletedAt !== null
      ) {
        return yield* new ClaudeSessionAttachmentError({
          cause: "Session already belongs to another project or was deleted",
        });
      }
      if (
        parent &&
        data.confirmedParent &&
        parent.id !== threadId &&
        (existing.value.lineage.parentThreadId !== parent.id || existing.value.title !== data.title)
      ) {
        let ancestor: OrchestrationV2AppThread | null = parent;
        for (let depth = 0; ancestor && depth < 128; depth++) {
          if (ancestor.id === threadId)
            return yield* new ClaudeSessionAttachmentError({ cause: "Cyclic subagent ancestry" });
          ancestor = ancestor.lineage.parentThreadId
            ? yield* projections.getThread(ancestor.lineage.parentThreadId)
            : null;
        }
        if (ancestor)
          return yield* new ClaudeSessionAttachmentError({ cause: "Subagent ancestry too deep" });
        const now = yield* DateTime.now;
        const updated = {
          ...existing.value,
          title: data.title,
          lineage: { ...existing.value.lineage, parentThreadId: parent.id },
        };
        const related = yield* projections.getThreadRecords(
          parent.lineage.rootThreadId,
          ["subagents", "nodes"],
          {
            subagentIds: [attachmentNodeId(threadId)],
            nodeIds: [attachmentNodeId(threadId)],
          },
        );
        const committed = yield* sink.write({
          expectedThread: existing.value,
          skipExistingEventIds: true,
          events: [
            ...related.subagents.map((item) =>
              attachmentEvent(
                item.threadId,
                "subagent.updated",
                {
                  ...item,
                  parentNodeId: attachmentNodeId(parent.id),
                  title: data.title,
                  updatedAt: now,
                },
                now,
                `${threadId}:${parent.id}:${data.title}`,
              ),
            ),
            ...related.nodes.map((item) =>
              attachmentEvent(
                item.threadId,
                "node.updated",
                {
                  ...item,
                  parentNodeId: attachmentNodeId(parent.id),
                },
                now,
                `${threadId}:${parent.id}`,
              ),
            ),
            attachmentEvent(
              threadId,
              "thread.metadata-updated",
              updated,
              now,
              `${parent.id}:${data.title}`,
            ),
          ],
        });
        return committed.length ? updated : yield* projections.getThread(threadId);
      }
      return existing.value;
    }
    const now = yield* DateTime.now;
    const thread: OrchestrationV2AppThread = {
      id: threadId,
      projectId: data.projectId,
      title: data.title,
      createdBy: "agent",
      creationSource: "provider",
      providerInstanceId,
      modelSelection: {
        instanceId: providerInstanceId,
        model:
          data.model ??
          DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make("claudeAgent")] ??
          DEFAULT_MODEL,
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: parent ? null : ProviderThreadId.make(`${threadId}:provider`),
      lineage: {
        parentThreadId: parent?.id ?? null,
        rootThreadId: parent?.lineage.rootThreadId ?? threadId,
        relationshipToParent: parent ? "subagent" : null,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: "active",
      settledAt: null,
      unsettledAt: now,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const binding: OrchestrationV2ProviderThread = {
      id: ProviderThreadId.make(`${threadId}:provider`),
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: {
        driver: ProviderDriverKind.make("claudeAgent"),
        nativeId: data.sessionId,
        strength: "strong",
      },
      nativeConversationHeadRef: null,
      nativeMetadata: { claudeResumeTranscriptPath: data.transcriptPath },
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      createdAt: now,
      updatedAt: now,
    };
    const committed = yield* sink.write({
      skipExistingEventIds: true,
      ...(parent ? {} : { unlessNativeThreadOwned: binding }),
      events: [
        attachmentEvent(threadId, "thread.created", thread, now, threadId),
        ...(parent
          ? []
          : [attachmentEvent(threadId, "provider-thread.updated", binding, now, threadId)]),
      ],
    });
    if (committed.length === 0)
      return yield* new ClaudeSessionAttachmentError({
        cause: "Another T3 thread already owns this session",
      });
    return thread;
  });

  const projectLines = Effect.fn("ClaudeSessionAttachment.projectLines")(function* (
    thread: OrchestrationV2AppThread,
    parent: OrchestrationV2AppThread | null,
    agentId: string | null,
    lines: ReadonlyArray<string>,
    offset: number,
    session: AttachmentState,
  ) {
    const external = session;
    let model: string | undefined;
    for (const line of lines) {
      const details = attachmentDetails(line, external.sessionId);
      if (details?.model) model = details.model;
      if (details?.spawn) {
        yield* create(thread, {
          projectId: thread.projectId,
          configDirectory: external.configDirectory,
          providerInstanceId: thread.providerInstanceId,
          sessionId: external.sessionId,
          agentId: details.spawn.agentId,
          transcriptPath: path.join(
            session.transcriptPath.slice(0, -6),
            "subagents",
            `agent-${details.spawn.agentId}.jsonl`,
          ),
          title: details.spawn.description?.trim() || `Claude subagent ${details.spawn.agentId}`,
          confirmedParent: true,
          ...(details.spawn.resolvedModel ? { model: details.spawn.resolvedModel } : {}),
        });
      }
    }
    let previousSubagent: OrchestrationV2Subagent | undefined = parent
      ? (yield* projections.getThreadRecords(parent.id, ["subagents"], {
          subagentIds: [attachmentNodeId(thread.id)],
        })).subagents[0]
      : undefined;
    const detailsByLine = lines.map((line) => attachmentDetails(line, external.sessionId));
    const reasoningIds = detailsByLine.flatMap((details) =>
      details?.uuid
        ? details.thinkingBlocks.map((index) =>
            attachmentReasoningId(thread.id, details.uuid!, index),
          )
        : [],
    );
    const reasoning = new Map(
      (reasoningIds.length === 0
        ? []
        : (yield* projections.getThreadRecords(thread.id, ["turnItems"], {
            turnItemIds: reasoningIds,
          })).turnItems
      ).map((item) => [item.id, item]),
    );
    let ordinal = offset;
    let lineIndex = 0;
    const tools = new Map<string, OrchestrationV2TurnItem>();
    const events = (yield* Effect.forEach(
      lines,
      Effect.fnUntraced(function* (line) {
        ordinal += Buffer.byteLength(line) + 1;
        const details = detailsByLine[lineIndex++];
        for (const toolId of details?.toolIds ?? []) {
          if (tools.has(toolId)) continue;
          const previous = yield* projections.getTurnItem({
            threadId: thread.id,
            itemId: TurnItemId.make(`${thread.id}:tool:${toolId}`),
          });
          if (previous) tools.set(toolId, previous);
        }
        const projected = projectAttachmentLine({
          previousTools: tools,
          previousReasoning: reasoning,
          sessionId: session.sessionId,
          thread,
          parent,
          agentId,
          line,
          ordinal,
          previousSubagent,
          includeActivity: parent !== null && previousSubagent === undefined,
        });
        for (const event of projected) {
          if (event.type === "turn-item.updated" && event.payload.type === "reasoning")
            reasoning.set(event.payload.id, event.payload);
          if (
            event.type === "turn-item.updated" &&
            event.payload.type === "dynamic_tool" &&
            event.payload.nativeItemRef?.nativeId
          )
            tools.set(event.payload.nativeItemRef.nativeId, event.payload);
        }
        const child = projected.find((event) => event.type === "subagent.updated");
        if (child?.type === "subagent.updated") previousSubagent = child.payload;
        return projected;
      }),
    )).flat();
    // Activity is a snapshot of the last conversation record, not one event per historical line.
    for (let i = lines.length - 1; i >= 0; i--) {
      const activity = projectAttachmentLine({
        sessionId: session.sessionId,
        thread,
        parent,
        agentId,
        line: lines[i]!,
        ordinal,
        previousSubagent,
      }).filter((event) => event.type === "node.updated" || event.type === "subagent.updated");
      if (activity.length === 0) continue;
      events.push(...activity);
      break;
    }
    for (let i = 0; i < events.length; i += 100)
      yield* sink.write({
        skipExistingEventIds: true,
        events: events.slice(i, i + 100),
      });
    return model;
  });

  const change = Effect.fn("ClaudeSessionAttachment.change")(
    function* (input: ClaudeSessionAttachmentInput) {
      if (input.action === "attach") {
        const providerInstanceId =
          input.providerInstanceId ?? ProviderInstanceId.make("claudeAgent");
        const configDirectory = yield* resolveConfigDirectory(providerInstanceId);
        if (Option.isNone(yield* projects.getById(input.projectId)))
          return yield* new ClaudeSessionAttachmentError({ cause: "Project does not exist" });
        const discovered = yield* source.discover(configDirectory, input.session);
        const threadId = attachmentThreadId(configDirectory, discovered.sessionId);
        if (yield* handoffCompleted(threadId))
          return { threadId, attached: false, readOnly: false };
        const previous = yield* runtimes.getByThreadId({ threadId });
        if (Option.isNone(previous))
          yield* persist(threadId, {
            ...discovered,
            configDirectory,
            providerInstanceId,
            projectId: input.projectId,
            interrupted: false,
            cursors: {},
          });
        else {
          const payload = yield* decodeRequiredState(previous.value.runtimePayload);
          if (
            payload.claudeHandoff.projectId !== input.projectId ||
            payload.claudeHandoff.providerInstanceId !== providerInstanceId
          )
            return yield* new ClaudeSessionAttachmentError({
              cause: "Session already belongs to another project or provider instance",
            });
        }
        return { threadId, attached: true, readOnly: false };
      }
      const threadId = input.threadId;
      if (yield* handoffCompleted(threadId)) return { threadId, attached: false, readOnly: false };
      const runtime = yield* runtimes.getByThreadId({ threadId });
      if (Option.isNone(runtime)) {
        // Already adopted conversations no longer need import state.
        yield* projections.getThread(threadId);
        return { threadId, attached: false, readOnly: false };
      }
      const payload = yield* decodeOptionalState(runtime.value.runtimePayload);
      if (!payload.claudeHandoff) return { threadId, attached: false, readOnly: false };
      let session = payload.claudeHandoff;
      if (
        path.resolve(yield* resolveConfigDirectory(session.providerInstanceId)) !==
        path.resolve(session.configDirectory)
      )
        return yield* new ClaudeSessionAttachmentError({
          cause:
            "The provider configuration changed; restore the original Claude home before handoff",
        });
      const running = yield* source.assertStopped(session.configDirectory, session.sessionId).pipe(
        Effect.as(false),
        Effect.catchIf(
          (error) => error.reason === "running",
          () => Effect.succeed(true),
        ),
      );
      if (running && !input.interrupt)
        return { threadId, attached: true, readOnly: false, blocked: true };
      if (running) {
        yield* source.interrupt(session.configDirectory, session.sessionId, { verifyOnly: true });
        session = { ...session, interrupted: true };
        yield* persist(threadId, session);
        yield* source.interrupt(session.configDirectory, session.sessionId);
        yield* source.assertStopped(session.configDirectory, session.sessionId);
      }
      const root = yield* create(null, session);
      let cwd: string | undefined;
      const first = yield* source.read(session.configDirectory, session.transcriptPath, {
        offset: 0,
      });
      for (const line of first.lines) cwd = attachmentDetails(line, session.sessionId)?.cwd ?? cwd;
      const imported = new Set<ThreadId>([root.id]);
      const files = [
        { path: session.transcriptPath, agentId: null },
        ...(yield* source.children(session.configDirectory, session.transcriptPath)),
      ];
      for (const file of files) {
        const child =
          file.agentId === null
            ? root
            : yield* create(root, {
                ...session,
                agentId: file.agentId,
                transcriptPath: file.path,
                title: `Claude subagent ${file.agentId}`,
              });
        imported.add(child.id);
        const parent = child.lineage.parentThreadId
          ? yield* projections.getThread(child.lineage.parentThreadId)
          : null;
        let cursor: AttachmentState["cursors"][string] = session.cursors[file.path] ?? {
          offset: 0,
        };
        let model = cursor.model;
        if (file.agentId === null) cwd = cursor.cwd ?? cwd;
        while (true) {
          const page = yield* source.read(session.configDirectory, file.path, cursor);
          const offset =
            page.cursor.offset -
            page.lines.reduce((bytes, line) => bytes + Buffer.byteLength(line) + 1, 0);
          model =
            (yield* projectLines(child, parent, file.agentId, page.lines, offset, session)) ??
            model;
          if (file.agentId === null)
            for (const line of page.lines)
              cwd = attachmentDetails(line, session.sessionId)?.cwd ?? cwd;
          cursor = {
            ...page.cursor,
            ...(model ? { model } : {}),
            ...(file.agentId === null && cwd ? { cwd } : {}),
          };
          session = { ...session, cursors: { ...session.cursors, [file.path]: cursor } };
          yield* persist(threadId, session);
          if (page.caughtUp) break;
        }
        const tail = yield* source.tail(session.configDirectory, file.path);
        if (cursor.offset !== tail.size || (cursor.identity && cursor.identity !== tail.identity))
          return yield* new ClaudeSessionAttachmentError({
            reason: "handoff-blocked",
            cause:
              "Transcript changed or has an incomplete final record; retry after Claude exits cleanly",
          });
        for (const line of tail.lines) {
          const details = attachmentDetails(line, session.sessionId);
          model = details?.model ?? model;
          if (file.agentId === null) cwd = details?.cwd ?? cwd;
        }
        if (model) {
          const current = yield* projections.getThread(child.id);
          const now = yield* DateTime.now;
          yield* sink.write({
            skipExistingEventIds: true,
            events: [
              attachmentEvent(
                child.id,
                "thread.metadata-updated",
                {
                  ...current,
                  modelSelection: { ...current.modelSelection, model },
                  updatedAt: now,
                },
                now,
                `import-model:${model}`,
              ),
            ],
          });
        }
      }
      for (const id of imported) {
        const records = yield* projections.getThreadRecords(id, ["nodes", "subagents"]);
        const now = yield* DateTime.now;
        yield* sink.write({
          skipExistingEventIds: true,
          events: [
            ...records.nodes
              .filter((node) => node.status === "running")
              .map((node) =>
                attachmentEvent(
                  id,
                  "node.updated",
                  { ...node, status: "idle" },
                  now,
                  `handoff:${node.id}`,
                ),
              ),
            ...records.subagents
              .filter((agent) => agent.status === "running")
              .map((agent) =>
                attachmentEvent(
                  id,
                  "subagent.updated",
                  {
                    ...agent,
                    status: "idle",
                    updatedAt: now,
                    progress: "Original Claude process exited; final outcome was not recorded.",
                  },
                  now,
                  `handoff:${agent.id}`,
                ),
              ),
          ],
        });
      }
      yield* source.assertStopped(session.configDirectory, session.sessionId);
      if (!cwd || !path.isAbsolute(cwd))
        return yield* new ClaudeSessionAttachmentError({
          reason: "handoff-blocked",
          cause: "The workspace could not be determined from the transcript",
        });
      const { thread: current, providerThreads } = yield* projections.getThreadRecords(threadId, [
        "providerThreads",
      ]);
      const binding = providerThreads.find((row) => row.id === current.activeProviderThreadId);
      if (!binding)
        return yield* new ClaudeSessionAttachmentError({
          cause: "Native conversation binding is missing",
        });
      const now = yield* DateTime.now;
      const commandId = CommandId.make(`command:handoff:${threadId}`);
      yield* sink.writeWithEffects({
        expectedThread: current,
        skipExistingEventIds: true,
        events: [
          attachmentEvent(
            threadId,
            "thread.metadata-updated",
            { ...current, worktreePath: cwd, updatedAt: now },
            now,
            "handoff-workspace",
          ),
          // Unlike thread metadata snapshots, provider events survive history compaction.
          attachmentEvent(
            threadId,
            "provider-thread.updated",
            { ...binding, updatedAt: now },
            now,
            "handoff-complete",
          ),
        ],
        effects: session.interrupted
          ? [
              {
                id: `effect:handoff:${threadId}`,
                commandId,
                threadId,
                request: { type: "thread.handoff-continue" },
              },
            ]
          : [],
      });
      if (!(yield* handoffCompleted(threadId)))
        return yield* new ClaudeSessionAttachmentError({
          cause: "The thread changed during handoff; retry the transfer",
        });
      return { threadId, attached: false, readOnly: false };
    },
    gate.withPermit,
    Effect.mapError((cause) =>
      isAttachmentError(cause) ? cause : new ClaudeSessionAttachmentError({ cause }),
    ),
  );
  return ClaudeSessionAttachment.of({ change });
});
export const layer = Layer.effect(ClaudeSessionAttachment, make);
