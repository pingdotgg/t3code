import type {
  MessageId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2SuggestNextPromptInput,
  OrchestrationV2SuggestNextPromptResult,
  ThreadId,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const RECENT_USER_MESSAGES = 4;

const NO_SUGGESTION = { suggestion: null } as const;

/**
 * Only suggest once the agent has the last word and is done talking. A trailing user
 * message means a turn is queued or running, so the user already chose what to say.
 * Messages from rolled-back runs are gone from the conversation and must not steer it.
 */
export function selectPromptSuggestionContext(
  allMessages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "id" | "role" | "text" | "streaming" | "runId">
  >,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">>,
) {
  const rolledBackRunIds = new Set(
    runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
  );
  const messages = allMessages.filter(
    (message) => message.runId === null || !rolledBackRunIds.has(message.runId),
  );
  const lastMessage = messages.at(-1);
  if (lastMessage?.role !== "assistant" || lastMessage.streaming) {
    return null;
  }
  const lastAssistantMessage = assistantCitationsToPlainText(lastMessage.text).trim();
  if (lastAssistantMessage.length === 0) {
    return null;
  }
  return {
    messageId: lastMessage.id,
    lastAssistantMessage,
    recentUserMessages: messages
      .filter((message) => message.role === "user" && message.text.trim().length > 0)
      .slice(-RECENT_USER_MESSAGES)
      .map((message) => message.text),
  };
}

export class PromptSuggestionService extends Context.Service<
  PromptSuggestionService,
  {
    readonly suggestNextPrompt: (
      input: OrchestrationV2SuggestNextPromptInput,
    ) => Effect.Effect<OrchestrationV2SuggestNextPromptResult, OrchestratorV2Error>;
  }
>()("t3/orchestration-v2/PromptSuggestionService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const generate = Effect.fn("PromptSuggestionService.generate")(function* (
    input: OrchestrationV2SuggestNextPromptInput,
  ) {
    const projection = yield* threads.getThreadRecords(input.threadId, ["messages", "runs"], {
      messageRoles: ["user", "assistant"],
    });
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings.pipe(Effect.orDie),
      projection.thread.projectId,
    ).settings;
    if (!settings.promptSuggestionsEnabled) {
      return NO_SUGGESTION;
    }

    const context = selectPromptSuggestionContext(projection.messages, projection.runs);
    if (context === null || context.messageId !== input.afterMessageId) {
      return NO_SUGGESTION;
    }

    const project = yield* projects
      .get(projection.thread.projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(project)) {
      return NO_SUGGESTION;
    }

    const providers = yield* providerRegistry.getProviders;
    const modelSelection = ServerSettings.resolvePromptSuggestionModelSelection(
      settings,
      providers,
      projection.thread.projectId,
    );
    return yield* textGeneration
      .generatePromptSuggestion({
        cwd: projection.thread.worktreePath ?? project.value.workspaceRoot,
        recentUserMessages: context.recentUserMessages,
        lastAssistantMessage: context.lastAssistantMessage,
        modelSelection,
      })
      .pipe(
        Effect.map(({ suggestion }) => ({ suggestion: suggestion.length > 0 ? suggestion : null })),
        // A suggestion is a convenience; a failed one should never surface as an error.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Prompt suggestion generation failed", {
                threadId: input.threadId,
                cause,
              }).pipe(Effect.as(NO_SUGGESTION)),
        ),
      );
  });

  // Every viewer of a thread asks when the same reply settles, from each tab and device.
  // Concurrent lookups for one reply share a single model call, and the answer is kept
  // briefly for viewers that ask a little later. A failed lookup is not kept.
  const suggestions = yield* Cache.makeWith(
    (key: string) => {
      const [threadId, afterMessageId] = JSON.parse(key) as [ThreadId, MessageId];
      return generate({ threadId, afterMessageId });
    },
    {
      capacity: 256,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? "5 minutes" : Duration.zero),
    },
  );

  return PromptSuggestionService.of({
    suggestNextPrompt: (input) =>
      Cache.get(suggestions, JSON.stringify([input.threadId, input.afterMessageId])),
  });
});

export const layer = Layer.effect(PromptSuggestionService, make);
