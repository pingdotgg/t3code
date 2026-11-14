import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { isAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";
import {
  CommandId,
  type ChatAttachment,
  type MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type RunId,
  type ServerSettingsError,
  TextGenerationError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { forkInheritedRunOrdinals, ProjectionStoreThreadNotFoundError } from "./ProjectionStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
export { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";

export class ThreadTitleRegenerationService extends Context.Service<
  ThreadTitleRegenerationService,
  {
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
      readonly kind:
        | { readonly type: "initial"; readonly messageId: MessageId }
        | { readonly type: "regenerate" };
    }) => Effect.Effect<
      void,
      | OrchestratorV2Error
      | ProjectStore.ProjectStoreV2Error
      | ServerSettingsError
      | ThreadManagementService.ThreadManagementProviderInstanceDisabledError
    >;
  }
>()("t3/orchestration-v2/ThreadTitleRegenerationService") {}

type Outcome =
  | { readonly status: "renamed"; readonly title: string }
  | { readonly status: "unchanged" }
  | { readonly status: "failed"; readonly message: string };

const MAX_FAILURE_MESSAGE_LENGTH = 300;
const isTextGenerationError = Schema.is(TextGenerationError);
const isProjectionStoreThreadNotFoundError = Schema.is(ProjectionStoreThreadNotFoundError);

function failureMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  const lines = isTextGenerationError(error)
    ? error.detail
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    : [];
  const detail = lines.at(-1);
  if (detail === undefined) return "Title generation failed.";
  return detail.length > MAX_FAILURE_MESSAGE_LENGTH
    ? `${detail.slice(0, MAX_FAILURE_MESSAGE_LENGTH - 1)}…`
    : detail;
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;

  const complete = (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly kind: { readonly type: "initial" | "regenerate" };
    readonly outcome: Outcome;
  }) =>
    threads
      .dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make(`${input.requestId}:title-complete`),
        threadId: input.threadId,
        requestId: input.requestId,
        ...(input.outcome.status === "renamed" ? { title: input.outcome.title } : {}),
        ...(input.kind.type === "regenerate"
          ? {
              outcome: {
                status: input.outcome.status,
                ...(input.outcome.status === "failed" ? { message: input.outcome.message } : {}),
              },
            }
          : {}),
      })
      .pipe(Effect.asVoid);

  const messagesThroughRun = Effect.fn("ThreadTitleRegenerationService.messagesThroughRun")(
    function* (threadId: ThreadId, runId: RunId, forkCreatedAt: DateTime.Utc) {
      const source = yield* threads.getThreadRecords(threadId, ["messages", "runs"], {
        messageRoles: ["user", "assistant"],
      });
      const ordinals = forkInheritedRunOrdinals(source.runs, forkCreatedAt);
      const forkOrdinal = ordinals.get(runId);
      if (forkOrdinal === undefined) return undefined;
      const messages = source.messages.filter((message) => {
        if (message.streaming) return false;
        if (message.runId === null) return source.thread.historyOrigin === "v1_import";
        return (ordinals.get(message.runId) ?? Infinity) <= forkOrdinal;
      });
      return { thread: source.thread, messages };
    },
  );

  // A fork starts with no messages of its own, so its subject lives in the history it inherited.
  const forkSource = Effect.fn("ThreadTitleRegenerationService.forkSource")(function* (
    thread: OrchestrationV2AppThread,
  ) {
    let title: string | undefined;
    const history: Array<ReadonlyArray<OrchestrationV2ConversationMessage>> = [];
    const seen = new Set([thread.id]);
    let current = thread;
    while (
      current.forkedFrom?.type === "run" &&
      current.lineage.sideChat !== true &&
      !seen.has(current.forkedFrom.threadId)
    ) {
      const { threadId, runId } = current.forkedFrom;
      seen.add(threadId);
      const source = yield* messagesThroughRun(threadId, runId, current.createdAt);
      if (source === undefined) break;
      history.push(source.messages);
      title ??= source.thread.title;
      current = source.thread;
    }
    const context = formatThreadTitleContext(history.reverse().flat());
    return title === undefined || context.message.length === 0
      ? undefined
      : { title, history: context.message };
  });

  const execute: ThreadTitleRegenerationService["Service"]["execute"] = Effect.fn(
    "ThreadTitleRegenerationService.execute",
  )(function* (input) {
    const outcome: Outcome | { readonly status: "stale" } = yield* Effect.gen(function* () {
      const projection = yield* threads.getThreadRecords(
        input.threadId,
        ["messages"],
        input.kind.type === "initial"
          ? { messageIds: [input.kind.messageId] }
          : { messageRoles: ["user", "assistant"] },
      );
      if (projection.thread.titleRegeneration?.requestId !== input.requestId) {
        return { status: "stale" as const };
      }

      const project = yield* projects.get(projection.thread.projectId);
      if (Option.isNone(project)) {
        return { status: "failed" as const, message: "This thread's project no longer exists." };
      }

      let context: {
        readonly message: string;
        readonly attachments: ReadonlyArray<ChatAttachment>;
      };
      if (input.kind.type === "initial") {
        const messageId = input.kind.messageId;
        const message = projection.messages.find(
          (candidate) => candidate.id === messageId && !candidate.streaming,
        );
        context =
          message === undefined
            ? { message: "", attachments: [] }
            : {
                message: isAttachmentOnlyBootstrapPrompt(message.text) ? "" : message.text,
                attachments: message.attachments,
              };
      } else {
        context = formatThreadTitleContext(
          projection.messages.filter((message) => !message.streaming),
        );
      }
      // A deleted source should not cost the fork its title.
      const inherited = yield* forkSource(projection.thread).pipe(
        Effect.catchTags({
          OrchestratorProjectionError: (error) =>
            isProjectionStoreThreadNotFoundError(error.cause)
              ? Effect.undefined
              : Effect.fail(error),
        }),
      );
      if (
        context.message.length === 0 &&
        context.attachments.length === 0 &&
        inherited === undefined
      ) {
        return {
          status: "failed" as const,
          message: "This thread has no messages to title yet.",
        };
      }
      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        projection.thread.projectId,
      ).settings;
      // Storage cleanup removes worktrees but keeps the path; CLIs cannot spawn in a missing cwd.
      const worktreePath = projection.thread.worktreePath;
      const worktreeExists =
        worktreePath !== null &&
        (yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => false)));
      const result = yield* textGeneration.generateThreadTitle({
        cwd: worktreeExists ? worktreePath : project.value.workspaceRoot,
        message: context.message,
        projectTitle: project.value.title,
        attachments: context.attachments,
        ...(input.kind.type === "regenerate" ? { previousTitle: projection.thread.title } : {}),
        ...(inherited === undefined ? {} : { forkSource: inherited }),
        instructions: settings.threadTitleInstructions,
        modelSelection: settings.textGenerationModelSelection,
        projectId: projection.thread.projectId,
      });
      const generatedTitle = result.title.trim();
      return generatedTitle === "New thread" ||
        (input.kind.type === "regenerate" && generatedTitle === projection.thread.title.trim())
        ? { status: "unchanged" as const }
        : { status: "renamed" as const, title: result.title };
    }).pipe(
      Effect.retry({
        times: input.kind.type === "initial" ? 2 : 0,
        schedule: Schedule.exponential("2 seconds"),
      }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Thread title generation failed", {
              threadId: input.threadId,
              requestId: input.requestId,
              cause,
            }).pipe(Effect.as({ status: "failed" as const, message: failureMessage(cause) })),
      ),
    );

    if (outcome.status === "stale") {
      return;
    }
    yield* complete({ ...input, outcome });
  });

  return ThreadTitleRegenerationService.of({ execute });
});

export const layer = Layer.effect(ThreadTitleRegenerationService, make);
