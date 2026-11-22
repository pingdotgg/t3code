import {
  BotCollection,
  BotError,
  BotWorkRun,
  CommandId,
  MessageId,
  type BotAssignInput,
  type BotGrantSource,
  type BotWorkAction,
  type BotWorkSnapshot,
  type ProjectId,
  type RunId,
  type ScheduledTaskId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as BotStore from "./BotStore.ts";

export class BotWorkService extends Context.Service<
  BotWorkService,
  {
    readonly subscribe: () => Stream.Stream<typeof BotWorkSnapshot.Type, BotError>;
    readonly act: (input: typeof BotWorkAction.Type) => Effect.Effect<void, BotError>;
    readonly saveWorkflow: (
      input: Extract<BotCollection, { type: "workflow" }>,
    ) => Effect.Effect<void, BotError>;
    readonly workflowForTask: (
      taskId: ScheduledTaskId,
    ) => Effect.Effect<CommandId | undefined, BotError>;
    readonly validateWorkflow: (
      id: CommandId,
      projectId: ProjectId,
    ) => Effect.Effect<void, BotError>;
    readonly bindTrigger: (id: CommandId, taskId: ScheduledTaskId) => Effect.Effect<void, BotError>;
    readonly managesRun: (runId: RunId) => Effect.Effect<boolean, BotError>;
    readonly pauseWorkflow: (id: CommandId) => Effect.Effect<void, BotError>;
    readonly assign: (
      author: ThreadId,
      input: typeof BotAssignInput.Type,
    ) => Effect.Effect<BotWorkRun, BotError>;
    readonly start: (input: {
      readonly id: CommandId;
      readonly collectionId: CommandId;
      readonly text: string;
      readonly source: BotGrantSource;
      readonly mention?: ThreadId | undefined;
    }) => Effect.Effect<void, BotError>;
  }
>()("t3/bots/BotWorkService") {}

const collectionJson = Schema.fromJsonString(BotCollection);
const runJson = Schema.fromJsonString(BotWorkRun);
const decodeCollection = Schema.decodeEffect(collectionJson);
const encodeCollection = Schema.encodeEffect(collectionJson);
const decodeRun = Schema.decodeEffect(runJson);
const encodeRun = Schema.encodeEffect(runJson);
const missing = new BotError({ reason: "not_found" });
const conflict = new BotError({ reason: "conflict" });
const unavailable = (cause: unknown) => new BotError({ reason: "unavailable", cause });
type DataRow = { readonly data: string };

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const bots = yield* BotStore.BotStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const events = yield* EventSink.EventSinkV2;
  const changes = yield* PubSub.sliding<void>(1);
  const lock = yield* Semaphore.make(1);
  const serialized = lock.withPermits(1);
  const notify = PubSub.publish(changes, undefined);

  const collectionById = Effect.fn("BotWorkService.collectionById")(function* (id: CommandId) {
    const [row] = yield* sql<DataRow>`SELECT data FROM bot_collections WHERE id = ${id}`.pipe(
      Effect.mapError(unavailable),
    );
    return row === undefined
      ? yield* missing
      : yield* decodeCollection(row.data).pipe(Effect.mapError(unavailable));
  });

  const runById = Effect.fn("BotWorkService.runById")(function* (id: CommandId) {
    const [row] = yield* sql<DataRow>`SELECT data FROM bot_work_runs WHERE id = ${id}`;
    return row === undefined ? undefined : yield* decodeRun(row.data);
  }, Effect.mapError(unavailable));

  const putRun = Effect.fn("BotWorkService.putRun")(function* (run: BotWorkRun) {
    const data = yield* encodeRun(run).pipe(Effect.mapError(unavailable));
    yield* sql`
      INSERT INTO bot_work_runs (id, root_id, collection_id, run_id, status, data)
      VALUES (${run.id}, ${run.rootId}, ${run.collectionId}, ${run.runId}, ${run.status}, ${data})
      ON CONFLICT (id) DO UPDATE SET run_id = excluded.run_id, status = excluded.status, data = excluded.data
    `.pipe(
      Effect.mapError(unavailable),
      Effect.tap(() => notify),
    );
  });

  const requireBot = Effect.fn("BotWorkService.requireBot")(function* (
    threadId: ThreadId,
    projectId: ProjectId,
  ) {
    const bot = yield* bots.find(threadId);
    if (bot === undefined || bot.projectId !== projectId || bot.state === "archived")
      return yield* missing;
    return bot;
  });

  const putCollection = Effect.fn("BotWorkService.putCollection")(function* (
    collection: BotCollection,
  ) {
    const targets =
      collection.type === "channel"
        ? collection.members
        : collection.steps.map((step) => step.threadId);
    if (
      collection.type === "channel" &&
      collection.leader !== null &&
      !targets.includes(collection.leader)
    ) {
      return yield* conflict;
    }
    for (const target of new Set(targets)) yield* requireBot(target, collection.projectId);
    const data = yield* encodeCollection(collection).pipe(Effect.mapError(unavailable));
    const rows = yield* sql<{ readonly id: string }>`
      INSERT INTO bot_collections (id, data) VALUES (${collection.id}, ${data})
      ON CONFLICT (id) DO UPDATE SET data = excluded.data
      WHERE json_extract(bot_collections.data, '$.type') = ${collection.type}
        AND json_extract(bot_collections.data, '$.projectId') = ${collection.projectId}
      RETURNING id
    `.pipe(Effect.mapError(unavailable));
    if (rows.length === 0) return yield* conflict;
    yield* notify;
  });

  const complete = Effect.fn("BotWorkService.complete")(function* (work: BotWorkRun) {
    if (work.status !== "running" || work.targetThreadId === null || work.runId === null) return;
    const { runs, messages } = yield* threads
      .getThreadRecords(work.targetThreadId, ["runs", "messages"], {
        runIds: [work.runId],
        messageRunIds: [work.runId],
        messageRoles: ["assistant"],
      })
      .pipe(Effect.mapError(unavailable));
    const run = runs.find((candidate) => candidate.id === work.runId);
    if (
      run === undefined ||
      run.status === "failed" ||
      run.status === "interrupted" ||
      run.status === "cancelled"
    ) {
      yield* putRun({ ...work, status: "failed" });
      return;
    }
    if (run.status !== "completed") return;
    const result = messages
      .map((message) => message.text)
      .join("\n\n")
      .slice(0, 8000);
    const outputs = [
      ...work.outputs,
      { threadId: work.targetThreadId, runId: work.runId, text: result },
    ];
    const step = work.step + 1;
    if (step >= work.steps.length) {
      yield* putRun({ ...work, outputs, step, status: "completed" });
      return;
    }
    const next = {
      ...work,
      outputs,
      step,
      runId: null,
      targetThreadId: null,
      status: "waiting" as const,
    };
    yield* putRun(next);
    return next;
  });

  const recentChannelContext = Effect.fn("BotWorkService.recentChannelContext")(function* (
    collectionId: CommandId,
    currentId: CommandId,
  ) {
    const rows = yield* sql<DataRow>`
      SELECT data FROM bot_work_runs WHERE collection_id = ${collectionId}
        AND rowid < (SELECT rowid FROM bot_work_runs WHERE id = ${currentId})
      ORDER BY rowid DESC LIMIT 6
    `;
    const recent = yield* Effect.forEach(rows, ({ data }) => decodeRun(data));
    return recent
      .reverse()
      .flatMap((item) => [
        item.input.slice(0, 600),
        ...item.outputs.slice(-1).map((output) => output.text.slice(0, 600)),
      ])
      .filter(Boolean)
      .join("\n\n");
  }, Effect.mapError(unavailable));

  const send = Effect.fn("BotWorkService.send")(function* (
    work: BotWorkRun,
  ): Effect.fn.Return<void, BotError> {
    if (work.status !== "waiting") return;
    const collection = yield* collectionById(work.collectionId);
    if (collection.type === "workflow" && !collection.enabled) return;
    const step =
      work.steps[work.step] ??
      (collection.type === "channel" && collection.leader !== null
        ? { threadId: collection.leader, prompt: work.input }
        : undefined);
    if (step === undefined) return;
    if (collection.type === "channel" && work.steps.length === 0) {
      const leader = yield* bots.find(step.threadId);
      if (leader?.state !== "active") return;
    } else {
      yield* requireBot(step.threadId, collection.projectId);
    }
    if (collection.type === "channel" && !collection.members.includes(step.threadId)) {
      yield* putRun({ ...work, status: "failed" });
      return;
    }
    const key = `bot-work-turn:${work.source}:${work.id}:${work.step}:${work.attempt}`;
    const prior = work.outputs[work.outputs.length - 1]?.text;
    const members =
      collection.type === "channel"
        ? yield* Effect.forEach(collection.members, (threadId) => bots.find(threadId))
        : [];
    const channelContext =
      collection.type === "channel" ? yield* recentChannelContext(collection.id, work.id) : "";
    const text =
      collection.type === "channel"
        ? [
            `Channel: ${collection.title}`,
            `Channel leader: ${collection.leader ?? "Unassigned"}`,
            `Members: ${members.flatMap((bot) => (bot === undefined ? [] : [`${bot.name} (${bot.threadId})`])).join(", ")}`,
            step.threadId === collection.leader
              ? "Use t3_bot_assign to hand work to a member. Their results appear in the channel."
              : "",
            channelContext && `Recent channel messages and results:\n${channelContext}`,
            `Current request:\n${step.prompt}`,
          ]
            .filter(Boolean)
            .join("\n\n")
        : [
            step.prompt,
            `Workflow input:\n${work.input}`,
            prior && `Previous step result:\n${prior}`,
          ]
            .filter(Boolean)
            .join("\n\n");
    const dispatch = yield* threads
      .sendToThread({
        projectId: collection.projectId,
        commandId: CommandId.make(key),
        threadId: step.threadId,
        messageId: MessageId.make(key),
        text,
        mode: "queue",
        attachments: [],
        createdBy: "system",
        creationSource: "server",
        ...(work.source === "webhook" ? { freshContext: true } : {}),
      })
      .pipe(Effect.result);
    if (dispatch._tag === "Failure") {
      yield* putRun({ ...work, status: "failed" });
      yield* Effect.logWarning("Could not send bot work", {
        collectionId: collection.id,
        workId: work.id,
      });
      return;
    }

    const running = {
      ...work,
      ancestry:
        work.ancestry.length === 0 && collection.type === "channel"
          ? [step.threadId]
          : work.ancestry,
      targetThreadId: step.threadId,
      runId: dispatch.success.run.id,
      status: "running" as const,
    };
    yield* putRun(running);
    const next = yield* complete(running);
    if (next !== undefined) yield* send(next);
  });

  const start = Effect.fn("BotWorkService.start")(function* (
    input: Parameters<BotWorkService["Service"]["start"]>[0],
  ) {
    const existing = yield* runById(input.id);
    if (existing !== undefined) {
      yield* send(existing);
      return;
    }
    const collection = yield* collectionById(input.collectionId);
    if (collection.type === "workflow" && !collection.enabled) return yield* conflict;
    if (
      input.mention !== undefined &&
      (collection.type !== "channel" || !collection.members.includes(input.mention))
    ) {
      return yield* missing;
    }
    const target = input.mention ?? null;
    const work: BotWorkRun = {
      id: input.id,
      collectionId: collection.id,
      rootId: input.id,
      ancestry: target === null ? [] : [target],
      source: input.source,
      input: input.text,
      steps:
        collection.type === "workflow"
          ? collection.steps
          : target === null
            ? []
            : [{ threadId: target, prompt: input.text }],
      outputs: [],
      targetThreadId: null,
      runId: null,
      step: 0,
      attempt: 1,
      status: "waiting",
    };
    yield* putRun(work);
    yield* send(work);
  }, serialized);

  const waitingForCollection = Effect.fn("BotWorkService.waitingForCollection")(function* (
    id: CommandId,
  ) {
    const waiting = yield* sql<DataRow>`
      SELECT data FROM bot_work_runs WHERE collection_id = ${id} AND status = 'waiting' ORDER BY rowid
    `.pipe(Effect.mapError(unavailable));
    for (const row of waiting)
      yield* decodeRun(row.data).pipe(Effect.mapError(unavailable), Effect.flatMap(send));
  });

  const saveWorkflow = Effect.fn("BotWorkService.saveWorkflow")(function* (
    workflow: Extract<BotCollection, { type: "workflow" }>,
  ) {
    yield* serialized(putCollection(workflow));
    if (workflow.enabled) yield* serialized(waitingForCollection(workflow.id));
  });

  const pauseWorkflow = Effect.fn("BotWorkService.pauseWorkflow")(function* (id: CommandId) {
    const collection = yield* collectionById(id);
    if (collection.type !== "workflow") return yield* missing;
    yield* putCollection({ ...collection, enabled: false });
  }, serialized);

  const act = Effect.fn("BotWorkService.act")(function* (input: typeof BotWorkAction.Type) {
    switch (input.type) {
      case "save_workflow": {
        const { type: _type, ...workflow } = input;
        yield* saveWorkflow({ ...workflow, type: "workflow", enabled: true });
        return;
      }
      case "save_channel": {
        const { type: _type, ...channel } = input;
        yield* serialized(
          putCollection({ ...channel, type: "channel" }).pipe(
            Effect.andThen(waitingForCollection(channel.id)),
          ),
        );
        return;
      }
      case "start":
        return yield* start({
          id: input.id,
          collectionId: input.collectionId,
          text: input.text,
          source: "direct",
          mention: input.mention,
        });
      case "retry":
        return yield* serialized(
          Effect.gen(function* () {
            const work = yield* runById(input.id);
            if (work?.status !== "failed") return yield* conflict;
            const retry = {
              ...work,
              runId: null,
              status: "waiting" as const,
              attempt: work.attempt + 1,
            };
            yield* putRun(retry);
            yield* send(retry);
          }),
        );
    }
  });

  const assign = Effect.fn("BotWorkService.assign")(function* (
    author: ThreadId,
    input: typeof BotAssignInput.Type,
  ) {
    const thread = yield* threads.getThreadShell(author).pipe(Effect.mapError(unavailable));
    if (thread?.activeRunId == null) return yield* missing;
    const [row] =
      yield* sql<DataRow>`SELECT data FROM bot_work_runs WHERE run_id = ${thread.activeRunId}`.pipe(
        Effect.mapError(unavailable),
      );
    if (row === undefined) return yield* missing;
    const parent = yield* decodeRun(row.data).pipe(Effect.mapError(unavailable));
    const collection = yield* collectionById(parent.collectionId);
    if (
      collection.type !== "channel" ||
      parent.status !== "running" ||
      parent.targetThreadId !== author ||
      collection.leader !== author ||
      !collection.members.includes(author) ||
      !collection.members.includes(input.target) ||
      parent.ancestry.includes(input.target)
    )
      return yield* conflict;
    yield* requireBot(input.target, collection.projectId);
    const id = CommandId.make(`bot-assignment:${parent.runId}:${input.clientRequestId}`);
    const existing = yield* runById(id);
    if (existing !== undefined) return existing;
    const [count] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM bot_work_runs WHERE root_id = ${parent.rootId}
      `.pipe(Effect.mapError(unavailable));
    if ((count?.count ?? 0) >= 8) return yield* conflict;
    const work: BotWorkRun = {
      id,
      collectionId: collection.id,
      rootId: parent.rootId,
      ancestry: [...parent.ancestry, input.target],
      input: input.prompt,
      source: parent.source === "webhook" ? "webhook" : "handoff",
      steps: [{ threadId: input.target, prompt: input.prompt }],
      outputs: [],
      targetThreadId: null,
      runId: null,
      step: 0,
      attempt: 1,
      status: "waiting",
    };
    yield* putRun(work);
    yield* send(work);
    return (yield* runById(id)) ?? work;
  }, serialized);

  const finish = Effect.fn("BotWorkService.finish")(function* (runId: RunId) {
    const [row] =
      yield* sql<DataRow>`SELECT data FROM bot_work_runs WHERE run_id = ${runId} AND status = 'running'`.pipe(
        Effect.mapError(unavailable),
      );
    if (row === undefined) return;
    const work = yield* decodeRun(row.data).pipe(Effect.mapError(unavailable));
    const next = yield* complete(work);
    if (next !== undefined) yield* send(next);
  }, serialized);

  const sequence = yield* events.latestSequence().pipe(Effect.orDie);
  yield* events.stream({ afterSequence: sequence, eventType: "run.updated" }).pipe(
    Stream.filter(
      ({ event }) => event.type === "run.updated" && event.payload.completedAt !== null,
    ),
    Stream.runForEach(({ event }) =>
      event.runId === undefined
        ? Effect.void
        : finish(event.runId).pipe(
            Effect.catch((cause) => Effect.logWarning("Could not finish bot work", { cause })),
          ),
    ),
    Effect.catch((cause) => Effect.logWarning("Bot work event subscription stopped", { cause })),
    Effect.forkScoped,
  );

  yield* serialized(
    Effect.gen(function* () {
      const pending =
        yield* sql<DataRow>`SELECT data FROM bot_work_runs WHERE status IN ('waiting', 'running') ORDER BY rowid`.pipe(
          Effect.mapError(unavailable),
        );
      for (const row of pending) {
        const work = yield* decodeRun(row.data).pipe(Effect.mapError(unavailable));
        const next = work.status === "running" ? yield* complete(work) : work;
        if (next !== undefined)
          yield* send(next).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not recover bot work", { workId: work.id, cause }),
            ),
          );
      }
    }),
  ).pipe(Effect.catch((cause) => Effect.logWarning("Could not load pending bot work", { cause })));

  const managesRun = Effect.fn("BotWorkService.managesRun")(function* (runId: RunId) {
    const rows =
      yield* sql`SELECT 1 FROM bot_work_runs WHERE run_id = ${runId} AND status = 'running'`.pipe(
        Effect.mapError(unavailable),
      );
    return rows.length !== 0;
  });

  const workflowForTask = Effect.fn("BotWorkService.workflowForTask")(function* (
    taskId: ScheduledTaskId,
  ) {
    const [row] = yield* sql<{ readonly workflow_id: string }>`
      SELECT workflow_id FROM bot_workflow_triggers WHERE task_id = ${taskId}
    `.pipe(Effect.mapError(unavailable));
    return row === undefined ? undefined : CommandId.make(row.workflow_id);
  });

  const validateWorkflow = Effect.fn("BotWorkService.validateWorkflow")(function* (
    id: CommandId,
    projectId: ProjectId,
  ) {
    const workflow = yield* collectionById(id);
    if (workflow.type !== "workflow" || workflow.projectId !== projectId) return yield* missing;
  });

  const bindTrigger = Effect.fn("BotWorkService.bindTrigger")(function* (
    id: CommandId,
    taskId: ScheduledTaskId,
  ) {
    yield* sql`
      INSERT INTO bot_workflow_triggers (task_id, workflow_id)
      VALUES (${taskId}, ${id}) ON CONFLICT (task_id) DO UPDATE SET workflow_id = excluded.workflow_id
    `.pipe(Effect.mapError(unavailable));
  });

  const snapshot = Effect.fn("BotWorkService.snapshot")(function* () {
    const collections = yield* sql<DataRow>`SELECT data FROM bot_collections ORDER BY rowid`.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeCollection(row.data))),
    );
    const runs =
      yield* sql<DataRow>`SELECT data FROM bot_work_runs ORDER BY rowid DESC LIMIT 200`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeRun(row.data))),
      );
    return { collections, runs };
  }, Effect.mapError(unavailable));

  return BotWorkService.of({
    subscribe: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(snapshot()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(snapshot)),
          );
        }),
      ),
    act,
    saveWorkflow,
    pauseWorkflow,
    workflowForTask,
    managesRun,
    validateWorkflow,
    bindTrigger,
    assign,
    start,
  });
});

export const layer = Layer.effect(BotWorkService, make);
