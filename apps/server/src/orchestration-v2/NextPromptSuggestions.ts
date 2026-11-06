// Custom build: next-prompt suggestion buttons above the composer.
import * as NodeOS from "node:os";

import {
  isDelegatedAppThread,
  type ModelSelection,
  type OrchestrationV2NextPromptCommand,
  type OrchestrationV2NextPromptSuggestions,
  type OrchestrationV2SuggestNextPromptsInput,
  type RunId,
} from "@t3tools/contracts";
import { parseReplyOptions } from "@t3tools/provider-core/server/nextPromptSuggestions";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type * as ProjectStore from "./ProjectStore.ts";
import type * as ThreadManagementService from "./ThreadManagementService.ts";

export interface NextPromptSuggestionsRequest {
  readonly runId: RunId;
  readonly cwd: string;
  readonly userMessage: string;
  readonly assistantReply: string;
  readonly commands: ReadonlyArray<OrchestrationV2NextPromptCommand>;
  readonly modelSelection: ModelSelection;
}

export class NextPromptSuggestionsService extends Context.Service<
  NextPromptSuggestionsService,
  {
    /** Up to four next messages for a completed run; empty when the model fails or has none. */
    readonly suggest: (
      input: NextPromptSuggestionsRequest,
    ) => Effect.Effect<OrchestrationV2NextPromptSuggestions>;
  }
>()("t3/orchestration-v2/NextPromptSuggestions/NextPromptSuggestionsService") {}

// A run's suggestions never change, and every read is a model call, so keep recent ones.
const CACHE_LIMIT = 200;

export const make = Effect.gen(function* () {
  const textGeneration = yield* TextGeneration.TextGeneration;
  const cache = new Map<RunId, OrchestrationV2NextPromptSuggestions>();

  const suggest: NextPromptSuggestionsService["Service"]["suggest"] = Effect.fn(
    "NextPromptSuggestions.suggest",
  )(function* (input) {
    const cached = cache.get(input.runId);
    if (cached !== undefined) return cached;
    const empty: OrchestrationV2NextPromptSuggestions = { runId: input.runId, suggestions: [] };
    const generate = textGeneration.suggestNextPrompts;
    if (generate === undefined || input.assistantReply.trim().length === 0) return empty;
    const result = yield* generate({
      cwd: input.cwd,
      userMessage: input.userMessage,
      assistantReply: input.assistantReply,
      commands: input.commands,
      modelSelection: input.modelSelection,
    }).pipe(
      Effect.map((generated): OrchestrationV2NextPromptSuggestions => ({
        runId: input.runId,
        suggestions: generated.suggestions,
      })),
      Effect.tapError((cause) =>
        Effect.logWarning("Next-prompt suggestions failed", { detail: cause.detail }),
      ),
      // A failure is not cached, so the next read of the run tries again.
      Effect.orElseSucceed(() => undefined),
    );
    if (result === undefined) return empty;
    cache.set(input.runId, result);
    if (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    return result;
  });

  return { suggest } satisfies NextPromptSuggestionsService["Service"];
});

export const layer = Layer.effect(NextPromptSuggestionsService, make);

/**
 * Answer the RPC: read the run's own messages and use the reply's `options` block when it has
 * one, otherwise ask the thread title model. Any failure, a delegated thread, or (without an
 * options block) the Labs switch being off answers an empty list.
 */
export const suggestForThread = (
  input: OrchestrationV2SuggestNextPromptsInput,
  services: {
    readonly suggestions: NextPromptSuggestionsService["Service"];
    readonly threads: ThreadManagementService.ThreadManagementService["Service"];
    readonly projects: ProjectStore.ProjectStoreV2["Service"];
    readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  },
): Effect.Effect<OrchestrationV2NextPromptSuggestions> => {
  const empty: OrchestrationV2NextPromptSuggestions = { runId: input.runId, suggestions: [] };
  return Effect.gen(function* () {
    const settings = yield* services.serverSettings.getSettings;
    const records = yield* services.threads.getThreadRecords(input.threadId, ["messages"], {
      messageRunIds: [input.runId],
      messageRoles: ["user", "assistant"],
    });
    if (isDelegatedAppThread(records.thread)) return empty;
    const settled = records.messages.filter((message) => !message.streaming);
    const userMessage = settled.find((message) => message.role === "user")?.text ?? "";
    const assistantReply = settled.findLast((message) => message.role === "assistant")?.text ?? "";
    // Options the reply listed itself are exact and need no model, so they show even with the
    // Labs switch off.
    const replyOptions = parseReplyOptions(assistantReply, input.commands);
    if (replyOptions !== null) {
      return { runId: input.runId, suggestions: replyOptions, fromReply: true };
    }
    if (!settings.promptSuggestionsEnabled) return empty;
    const project = yield* services.projects.get(records.thread.projectId);
    const cwd =
      records.thread.worktreePath ??
      Option.match(project, { onNone: () => NodeOS.tmpdir(), onSome: (row) => row.workspaceRoot });
    return yield* services.suggestions.suggest({
      runId: input.runId,
      cwd,
      userMessage,
      assistantReply,
      commands: input.commands,
      modelSelection: resolveProjectSettings(settings, records.thread.projectId).settings
        .textGenerationModelSelection,
    });
  }).pipe(
    Effect.tapCause((cause) => Effect.logDebug("Next-prompt suggestions skipped", cause)),
    Effect.orElseSucceed(() => empty),
  );
};
