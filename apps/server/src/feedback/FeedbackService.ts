import * as NodeOS from "node:os";

import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import { providerDimensions } from "../telemetry/ProviderDimensions.ts";
import {
  FEEDBACK_AWAITING_APPROVAL_NOTE,
  FEEDBACK_SUBJECT_MESSAGE,
  type FeedbackAwaitingApproval,
  type FeedbackInput,
  type FeedbackLimitError,
  type FeedbackNotRequestedError,
  type FeedbackOffError,
  type FeedbackReport,
  type FeedbackSource,
  FeedbackStorageError,
  resolveFeedbackSubject,
} from "./FeedbackReport.ts";
import * as Store from "./FeedbackStore.ts";
import {
  buildFeedbackTrace,
  FEEDBACK_TRACE_ITEM_TYPES,
  feedbackTraceWindow,
} from "./FeedbackTrace.ts";
import { scrubFeedback } from "./scrubFeedback.ts";

export class FeedbackSubjectError extends Schema.TaggedError<FeedbackSubjectError>()(
  "FeedbackSubjectError",
  {},
) {
  override get message() {
    return FEEDBACK_SUBJECT_MESSAGE;
  }
}

/** A requested report needs a thread with an active turn to show the user its card. */
export class FeedbackApprovalError extends Schema.TaggedError<FeedbackApprovalError>()(
  "FeedbackApprovalError",
  {},
) {
  override get message() {
    return "A report the user asks for is shown to them for approval in their thread, and this call has no active thread turn, so nothing was sent.";
  }
}

export interface FeedbackCaller {
  readonly source: FeedbackSource;
  readonly threadId?: ThreadId;
}

export class FeedbackService extends Context.Service<
  FeedbackService,
  {
    /**
     * Sends an unprompted report at once. A requested one is shown to the user in a card and
     * returns at once; it is stored and sent only if they choose Send.
     */
    readonly submit: (
      input: FeedbackInput,
      caller: FeedbackCaller,
    ) => Effect.Effect<
      FeedbackReport | FeedbackAwaitingApproval,
      | FeedbackOffError
      | FeedbackNotRequestedError
      | FeedbackSubjectError
      | FeedbackApprovalError
      | FeedbackLimitError
      | FeedbackStorageError
    >;
  }
>()("t3/feedback/FeedbackService") {}

const storageError = (cause: unknown) => new FeedbackStorageError({ cause });

/** `mcpToolNames` is read per report: the MCP server registers tools after this service starts. */
const make = Effect.fn("FeedbackService.make")(function* (
  mcpToolNames: () => ReadonlyArray<string>,
) {
  const threads = yield* Threads.ThreadManagementService;
  const projects = yield* Projects.ProjectService;
  const providers = yield* Providers.ProviderRegistry;
  const settings = yield* Settings.ServerSettingsService;
  const random = yield* SecureRandom.SecureRandom;
  const store = yield* Store.FeedbackStore;

  const submit = Effect.fn("FeedbackService.submit")(function* (
    input: FeedbackInput,
    caller: FeedbackCaller,
  ) {
    const { agentFeedback } = yield* settings.getSettings.pipe(Effect.mapError(storageError));
    // Early, so a refused report shows no card; storing applies the rule again under the lock.
    yield* Store.allowedBy(agentFeedback.mode, input.userRequested, caller.source);
    const subject = resolveFeedbackSubject(input.subject, mcpToolNames());
    if (subject === undefined) return yield* new FeedbackSubjectError({});
    if (input.userRequested && caller.threadId === undefined) {
      return yield* new FeedbackApprovalError({});
    }

    const thread =
      caller.threadId === undefined
        ? undefined
        : ((yield* threads.getThreadShell(caller.threadId).pipe(Effect.mapError(storageError))) ??
          undefined);
    const project =
      thread === undefined
        ? undefined
        : Option.getOrUndefined(
            yield* projects.getById(thread.projectId).pipe(Effect.mapError(storageError)),
          );
    const repository = project?.repositoryIdentity ?? undefined;
    const sensitive = [
      caller.threadId ?? "",
      thread?.projectId ?? "",
      NodeOS.homedir(),
      NodeOS.userInfo().username,
      NodeOS.hostname(),
      thread?.worktreePath ?? "",
      thread?.branch ?? "",
      project?.workspaceRoot ?? "",
      project?.title ?? "",
      repository?.locator.remoteUrl ?? "",
      repository?.origin?.remoteUrl ?? "",
      repository?.webUrl ?? "",
      repository?.canonicalKey ?? "",
      repository?.owner !== undefined && repository.name !== undefined
        ? `${repository.owner}/${repository.name}`
        : "",
    ];
    const fields = {
      kind: input.kind,
      subject,
      expected: scrubFeedback(input.expected, sensitive),
      actual: scrubFeedback(input.actual, sensitive),
      workaround: scrubFeedback(input.workaround, sensitive),
    };
    const id = yield* random.uuidV7();
    const runId = thread?.activeRunId ?? null;
    const providerList = yield* providers.getProviders;
    if (!input.userRequested) {
      return yield* store.store({
        id,
        preview: { ...fields, trace: null },
        source: caller.source,
        threadId: caller.threadId ?? null,
        runId,
        dimensions:
          caller.source === "mcp" && thread !== undefined
            ? providerDimensions(providerList, thread.modelSelection)
            : {},
      });
    }

    const threadId = caller.threadId!;
    const run =
      runId === null
        ? undefined
        : (yield* threads
            .getThreadRecords(threadId, ["runs"], { runIds: [runId] })
            .pipe(Effect.mapError(storageError))).runs.find((candidate) => candidate.id === runId);
    if (run === undefined || run.rootNodeId === null) return yield* new FeedbackApprovalError({});
    // Both traces are built now, so the card shows exactly what each choice sends.
    const traces = yield* Effect.gen(function* () {
      // Records cannot filter on started, so widen past the unstarted (queued) runs the last
      // read found. Each pass reads more runs than the one before, until it holds enough
      // started runs or the whole thread.
      const window = feedbackTraceWindow(input.turns);
      let limit = window;
      let runs = (yield* threads.getThreadRecords(threadId, ["runs"], { latestRunLimit: limit }))
        .runs;
      while (runs.length === limit) {
        const unstarted = runs.filter((candidate) => candidate.startedAt === null).length;
        if (runs.length - unstarted >= window) break;
        limit = window + unstarted;
        runs = (yield* threads.getThreadRecords(threadId, ["runs"], { latestRunLimit: limit }))
          .runs;
      }
      const { turnItems } = yield* threads.getThreadRecords(threadId, ["turnItems"], {
        turnItemRunIds: runs.map((candidate) => candidate.id),
        turnItemTypes: FEEDBACK_TRACE_ITEM_TYPES,
      });
      const build = (withText: boolean) =>
        buildFeedbackTrace({
          runs,
          items: turnItems,
          turns: input.turns,
          withText,
          sensitive,
          t3Tools: mcpToolNames(),
          driverOf: (candidate) =>
            providerList.find((provider) => provider.instanceId === candidate.providerInstanceId)
              ?.driver,
          submittingRunId: run.id,
        });
      return { outline: build(false), conversation: build(true) };
    }).pipe(Effect.mapError(storageError));
    yield* store.showCard({
      reportId: id,
      threadId,
      runId: run.id,
      nodeId: run.rootNodeId,
      preview: { ...fields, trace: traces.outline },
      conversationTrace: traces.conversation.textTurns > 0 ? traces.conversation : null,
    });
    return { status: "awaiting_approval", note: FEEDBACK_AWAITING_APPROVAL_NOTE } as const;
  });

  return FeedbackService.of({ submit });
});

export const layer = (mcpToolNames: () => ReadonlyArray<string>) =>
  Layer.effect(FeedbackService, make(mcpToolNames));
