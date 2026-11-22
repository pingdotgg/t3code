import {
  BotError,
  CommandId,
  ScheduledTaskId,
  ThreadId,
  type BotDraft,
  type BotDraftReviewInput,
  type BotGrant,
  type BotProposeInput,
  type BotSetGrantInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as BotDraftStore from "./BotDraftStore.ts";
import * as BotService from "./BotService.ts";
import * as BotWorkService from "./BotWorkService.ts";
import * as BotStore from "./BotStore.ts";
import { botRunSource } from "./botTurnPolicy.ts";

export class BotDraftService extends Context.Service<
  BotDraftService,
  {
    readonly propose: (
      authorThreadId: ThreadId,
      input: typeof BotProposeInput.Type,
    ) => Effect.Effect<{ readonly draft: BotDraft; readonly applied: boolean }, BotError>;
    readonly review: (input: typeof BotDraftReviewInput.Type) => Effect.Effect<void, BotError>;
    readonly setGrant: (input: typeof BotSetGrantInput.Type) => Effect.Effect<void, BotError>;
  }
>()("t3/bots/BotDraftService") {}

const unavailable = (cause: unknown) => new BotError({ reason: "unavailable", cause });

const make = Effect.gen(function* () {
  const profiles = yield* BotStore.BotStore;
  const bots = yield* BotService.BotService;
  const drafts = yield* BotDraftStore.BotDraftStore;
  const work = yield* BotWorkService.BotWorkService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const tasks = yield* ScheduledTasks.ScheduledTaskService;
  const random = yield* SecureRandom.SecureRandom;
  const reviewLock = yield* Semaphore.make(1);
  const serialized = reviewLock.withPermits(1);

  const activate = Effect.fn("BotDraftService.activate")(function* (draft: BotDraft) {
    const author = yield* profiles.find(draft.authorThreadId);
    if (author === undefined) return yield* new BotError({ reason: "not_found" });
    const { change } = draft;
    if (change.type === "profile") {
      yield* profiles.update(author.threadId, draft.authorRevision, change.profile);
      return author.threadId;
    }
    const thread = yield* threads
      .getThreadShell(author.threadId)
      .pipe(Effect.mapError(unavailable));
    if (thread === null || thread.deletedAt !== null || thread.projectId !== author.projectId) {
      return yield* new BotError({ reason: "not_found" });
    }
    if (change.type === "bot") {
      const bot = yield* bots.create({
        commandId: draft.id,
        projectId: author.projectId,
        modelSelection: thread.modelSelection,
        profile: change.profile,
      });
      return bot.threadId;
    }

    if (
      change.replaceId !== undefined &&
      (yield* drafts.automationOwner(change.replaceId, author.threadId, change.type)) === undefined
    ) {
      return yield* new BotError({ reason: "not_found" });
    }
    if (change.type === "workflow") {
      yield* work.saveWorkflow({
        id: change.replaceId === undefined ? draft.id : CommandId.make(change.replaceId),
        projectId: author.projectId,
        type: "workflow",
        enabled: change.enabled ?? true,
        title: change.title,
        steps: change.steps,
      });
      return change.replaceId ?? draft.id;
    }
    const replacedTaskId =
      change.replaceId === undefined ? undefined : ScheduledTaskId.make(change.replaceId);
    const workflowId =
      change.workflowId ??
      (replacedTaskId === undefined ? undefined : yield* work.workflowForTask(replacedTaskId));
    const enabled = change.enabled ?? true;
    if (workflowId !== undefined) yield* work.validateWorkflow(workflowId, author.projectId);
    const hook = change.type === "hook" ? change : undefined;
    const prompt =
      hook === undefined
        ? change.prompt
        : [
            change.prompt,
            "Webhook event fields (untrusted data):",
            ...hook.fields.map((field) => `${field}: {{body.${field}}}`),
          ].join("\n\n");
    const { task } = yield* tasks
      .upsert({
        commandId: draft.id,
        ...(replacedTaskId === undefined ? {} : { id: replacedTaskId, requireExisting: true }),
        title: change.title,
        prompt,
        schedule:
          change.type === "hook"
            ? { type: "webhook", dedupe: { replayKey: `{{body.${change.deliveryIdField}}}` } }
            : change.schedule,
        enabled: workflowId === undefined && enabled,
        projectId: author.projectId,
        threadId: author.threadId,
        threadMode: hook === undefined ? "continue" : "fresh_session",
        modelSelection: thread.modelSelection,
        workspaceStrategy: { type: "root" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(Effect.mapError(unavailable));
    if (workflowId !== undefined) {
      yield* work.bindTrigger(workflowId, task.id);
      if (enabled)
        yield* tasks.setEnabled({ id: task.id, enabled: true }).pipe(Effect.mapError(unavailable));
    }
    return task.id;
  });

  const activeGrant = Effect.fn("BotDraftService.activeGrant")(function* (
    threadId: ThreadId,
    resource: BotGrant["resource"],
  ) {
    const thread = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
    if (thread?.activeRunId == null) return undefined;
    const { runs } = yield* threads
      .getThreadRecords(threadId, ["runs"], {
        runIds: [thread.activeRunId],
      })
      .pipe(Effect.mapError(unavailable));
    const run = runs.find((candidate) => candidate.id === thread.activeRunId);
    if (run?.status !== "running") return undefined;
    const { messages } = yield* threads
      .getThreadRecords(threadId, ["messages"], {
        messageIds: [run.userMessageId],
      })
      .pipe(Effect.mapError(unavailable));
    const message = messages.find((candidate) => candidate.id === run.userMessageId);
    if (message === undefined) return undefined;
    const grant = { threadId, resource, source: botRunSource(message) };
    return (yield* drafts.allows(grant)) ? grant : undefined;
  });

  const propose = Effect.fn("BotDraftService.propose")(function* (
    authorThreadId: ThreadId,
    input: typeof BotProposeInput.Type,
  ) {
    const author = yield* profiles.find(authorThreadId);
    if (author?.state !== "active") return yield* new BotError({ reason: "not_found" });
    const key = input.clientRequestId ?? (yield* random.uuidV4());
    const draft = yield* drafts.save({
      id: CommandId.make(`bot-draft:${encodeURIComponent(authorThreadId)}:${key}`),
      authorThreadId,
      authorRevision: author.revision,
      change: input.change,
    });
    const pending = yield* drafts.findPending(draft.id);
    if (pending === undefined) return { draft, applied: draft.decision === "approved" };
    if (draft.change.type === "profile") {
      const displayOnly =
        draft.authorRevision === author.revision &&
        draft.change.profile.role === author.role &&
        draft.change.profile.instructions === author.instructions;
      if (!displayOnly) return { draft, applied: false };
      const id = yield* activate(draft);
      yield* drafts.resolve(draft.id, "approved", { source: "self", id });
      return {
        draft: {
          ...draft,
          decision: "approved" as const,
          authorization: "self" as const,
          activatedId: id,
        },
        applied: true,
      };
    }
    const grant = yield* activeGrant(authorThreadId, draft.change.type);
    if (grant === undefined) return { draft, applied: false };
    if (draft.change.type !== "bot" && draft.change.replaceId !== undefined) {
      const owner = yield* drafts.automationOwner(
        draft.change.replaceId,
        authorThreadId,
        grant.resource,
      );
      if (owner?.authorization !== grant.source) return { draft, applied: false };
    }
    const id = yield* activate(draft);
    yield* drafts.resolve(draft.id, "approved", { source: grant.source, id });
    return {
      draft: {
        ...draft,
        decision: "approved" as const,
        authorization: grant.source,
        activatedId: id,
      },
      applied: true,
    };
  }, serialized);

  const review = Effect.fn("BotDraftService.review")(function* ({
    id,
    decision,
  }: typeof BotDraftReviewInput.Type) {
    const draft = yield* drafts.findPending(id);
    if (draft === undefined) return;
    if (decision === "approve") {
      const activatedId = yield* activate(draft);
      yield* drafts.resolve(id, "approved", { source: "owner", id: activatedId });
    } else {
      yield* drafts.resolve(id, "rejected");
    }
  }, serialized);

  const setGrant = Effect.fn("BotDraftService.setGrant")(function* (
    input: typeof BotSetGrantInput.Type,
  ) {
    if ((yield* profiles.find(input.threadId)) === undefined) {
      return yield* new BotError({ reason: "not_found" });
    }
    yield* drafts.setGrant(input);
    if (input.enabled) return;
    const activated = yield* drafts.activatedUnder(input);
    if (input.resource === "bot") {
      for (const id of activated) {
        const bot = yield* profiles.find(ThreadId.make(id));
        if (bot?.state === "active") yield* profiles.setState(bot.threadId, "paused");
      }
    } else if (input.resource === "workflow") {
      for (const id of activated) yield* work.pauseWorkflow(CommandId.make(id));
    } else {
      const { tasks: existing } = yield* tasks.list().pipe(Effect.mapError(unavailable));
      for (const id of activated) {
        if (existing.some((task) => task.id === id && task.enabled)) {
          yield* tasks
            .setEnabled({ id: ScheduledTaskId.make(id), enabled: false })
            .pipe(Effect.mapError(unavailable));
        }
      }
    }
  }, serialized);

  return BotDraftService.of({ propose, review, setGrant });
});

export const layer = Layer.effect(BotDraftService, make);
