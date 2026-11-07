import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { isAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";
import { truncate } from "@t3tools/shared/String";
import {
  CommandId,
  TextGenerationError,
  type ChatAttachment,
  type MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type RunId,
  type ServerSettingsError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
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

type TitleOutcome =
  | { readonly type: "stale" }
  | { readonly type: "complete"; readonly title?: string; readonly failure?: string };

const GENERIC_FAILURE = "The title could not be generated.";
const isTextGenerationError = Schema.is(TextGenerationError);

function failureMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.findErrorOption(cause);
  const detail =
    Option.isSome(error) && isTextGenerationError(error.value) ? error.value.detail.trim() : "";
  return detail.length === 0 ? GENERIC_FAILURE : truncate(detail, 500);
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
    readonly title?: string;
    readonly failure?: string;
  }) =>
    threads
      .dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make(`${input.requestId}:title-complete`),
        threadId: input.threadId,
        requestId: input.requestId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.failure === undefined ? {} : { failure: input.failure }),
      })
      .pipe(Effect.asVoid);

  const messagesThroughRun = Effect.fn("ThreadTitleRegenerationService.messagesThroughRun")(
    function* (threadId: ThreadId, runId: RunId) {
      const source = yield* threads.getThreadRecords(threadId, ["messages", "runs"], {
        messageRoles: ["user", "assistant"],
      });
      const ordinals = new Map(
        source.runs
          .filter((run) => run.status !== "rolled_back")
          .map((run) => [run.id, run.ordinal]),
      );
      const forkOrdinal = ordinals.get(runId) ?? -1;
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
    let forkedFrom = thread.forkedFrom;
    while (forkedFrom?.type === "run") {
      const source = yield* messagesThroughRun(forkedFrom.threadId, forkedFrom.runId);
      history.push(source.messages);
      title ??= source.thread.title;
      forkedFrom = source.thread.forkedFrom;
    }
    const context = formatThreadTitleContext(history.reverse().flat());
    return title === undefined || context.message.length === 0
      ? undefined
      : { title, history: context.message };
  });

  const execute: ThreadTitleRegenerationService["Service"]["execute"] = Effect.fn(
    "ThreadTitleRegenerationService.execute",
  )(function* (input) {
    const outcome: TitleOutcome = yield* Effect.gen(function* () {
      const projection = yield* threads.getThreadRecords(
        input.threadId,
        ["messages"],
        input.kind.type === "initial"
          ? { messageIds: [input.kind.messageId] }
          : { messageRoles: ["user", "assistant"] },
      );
      if (projection.thread.titleRegeneration?.requestId !== input.requestId) {
        return { type: "stale" as const };
      }

      const project = yield* projects.get(projection.thread.projectId);
      if (Option.isNone(project)) {
        return { type: "complete" as const };
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
      if (context.message.length === 0 && context.attachments.length === 0) {
        return { type: "complete" as const };
      }

      // A deleted source should not cost the fork its title.
      const inherited = yield* forkSource(projection.thread).pipe(
        Effect.orElseSucceed(() => undefined),
      );
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
        attachments: context.attachments,
        ...(input.kind.type === "regenerate" ? { previousTitle: projection.thread.title } : {}),
        ...(inherited === undefined ? {} : { forkSource: inherited }),
        instructions: settings.threadTitleInstructions,
        modelSelection: settings.textGenerationModelSelection,
      });
      const generatedTitle = result.title.trim();
      return generatedTitle === "New thread" ||
        (input.kind.type === "regenerate" && generatedTitle === projection.thread.title.trim())
        ? { type: "complete" as const }
        : { type: "complete" as const, title: result.title };
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
            }).pipe(
              Effect.as({
                type: "complete" as const,
                // A first title falls back to the prompt; only a requested regeneration reports.
                ...(input.kind.type === "regenerate" ? { failure: failureMessage(cause) } : {}),
              }),
            ),
      ),
    );

    if (outcome.type === "stale") {
      return;
    }
    yield* complete({
      ...input,
      ...(outcome.title === undefined ? {} : { title: outcome.title }),
      ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
    });
  });

  return ThreadTitleRegenerationService.of({ execute });
});

export const layer = Layer.effect(ThreadTitleRegenerationService, make);
