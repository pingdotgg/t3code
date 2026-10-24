import {
  OrchestrationV2SuggestNextMessageError,
  type OrchestrationV2SuggestNextMessageInput,
  type OrchestrationV2SuggestNextMessageResult,
} from "@t3tools/contracts";
import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

export class NextMessageSuggestionService extends Context.Service<
  NextMessageSuggestionService,
  {
    readonly suggest: (
      input: OrchestrationV2SuggestNextMessageInput,
    ) => Effect.Effect<
      OrchestrationV2SuggestNextMessageResult,
      OrchestrationV2SuggestNextMessageError
    >;
  }
>()("t3/orchestration-v2/NextMessageSuggestionService") {}

const NO_SUGGESTION: OrchestrationV2SuggestNextMessageResult = { suggestion: "" };

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const unavailable = (input: OrchestrationV2SuggestNextMessageInput) => (cause?: unknown) =>
    new OrchestrationV2SuggestNextMessageError({
      threadId: input.threadId,
      reason: "unavailable",
      ...(cause === undefined ? {} : { cause }),
    });

  const generate = Effect.fn("NextMessageSuggestionService.generate")(function* (
    input: OrchestrationV2SuggestNextMessageInput,
  ) {
    const projection = yield* threads
      .getThreadRecords(input.threadId, ["messages", "runs"], {
        messageRoles: ["user", "assistant"],
      })
      .pipe(Effect.mapError(unavailable(input)));
    // Only the thread's last message, once its turn is over. A provider can finish a message
    // mid-run, so the latest run must have completed too.
    const latest = projection.messages.at(-1);
    if (
      latest?.id !== input.afterMessageId ||
      latest.role !== "assistant" ||
      latest.streaming ||
      ThreadManagementService.latestRun(projection)?.status !== "completed"
    ) {
      return NO_SUGGESTION;
    }

    const [settings, project] = yield* Effect.all([
      serverSettings.getSettings,
      projects.get(projection.thread.projectId),
    ]).pipe(Effect.mapError(unavailable(input)));
    if (Option.isNone(project)) return yield* unavailable(input)();

    const { settings: projectSettings } = resolveProjectSettings(
      settings,
      projection.thread.projectId,
    );
    return yield* textGeneration
      .generateNextMessageSuggestion({
        cwd: projection.thread.worktreePath ?? project.value.workspaceRoot,
        threadContext: formatThreadTitleContext(projection.messages).message,
        modelSelection: projectSettings.textGenerationModelSelection,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2SuggestNextMessageError({
              threadId: input.threadId,
              reason: "generation-failed",
              cause,
            }),
        ),
      );
  });

  // Keyed by reply, so every client that shows it, including after a reload, shares one model
  // call. Only model answers are kept: a failure, or a request that came before the run
  // completed, must not stop a later request from asking.
  const suggestions = yield* Cache.makeWith(generate, {
    capacity: 256,
    timeToLive: (exit) => (Exit.isSuccess(exit) && exit.value !== NO_SUGGESTION ? "1 hour" : 0),
  });

  const suggest: NextMessageSuggestionService["Service"]["suggest"] = Effect.fn(
    "NextMessageSuggestionService.suggest",
  )(function* (input) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(unavailable(input)));
    if (!settings.nextMessageSuggestionsEnabled) {
      return yield* new OrchestrationV2SuggestNextMessageError({
        threadId: input.threadId,
        reason: "disabled",
      });
    }
    return yield* Cache.get(suggestions, {
      threadId: input.threadId,
      afterMessageId: input.afterMessageId,
    });
  });

  return NextMessageSuggestionService.of({ suggest });
});

export const layer = Layer.effect(NextMessageSuggestionService, make);
