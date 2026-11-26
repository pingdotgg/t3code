import {
  isDelegatedAppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  ProviderDriverKind,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

/** Drivers that produce prompt suggestions natively through their own adapter events. */
const NATIVE_PROMPT_SUGGESTION_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set([
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("codex"),
]);

const MAX_TRANSCRIPT_MESSAGES = 8;

export interface PromptSuggestionRunInput {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly driver: ProviderDriverKind;
}

export interface PromptSuggestionServiceShape {
  readonly generateForRun: (input: PromptSuggestionRunInput) => Effect.Effect<void>;
  readonly scheduleForRun: (input: PromptSuggestionRunInput) => Effect.Effect<void>;
}

export class PromptSuggestionService extends Context.Service<
  PromptSuggestionService,
  PromptSuggestionServiceShape
>()("t3/orchestration-v2/PromptSuggestionService") {}

function latestEffectiveRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | undefined {
  let latest: OrchestrationV2Run | undefined;
  for (const run of runs) {
    // A steered message leaves its queued run cancelled before starting; skip it like the client does.
    if (run.status === "rolled_back" || (run.status === "cancelled" && run.startedAt === null)) {
      continue;
    }
    if (latest === undefined || run.ordinal > latest.ordinal) {
      latest = run;
    }
  }
  return latest;
}

function isLatestCompletedRun(runs: ReadonlyArray<OrchestrationV2Run>, runId: RunId): boolean {
  const latest = latestEffectiveRun(runs);
  return latest !== undefined && latest.id === runId && latest.status === "completed";
}

function formatSuggestionTranscript(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  runs: ReadonlyArray<OrchestrationV2Run>,
): string | null {
  const rolledBackRunIds = new Set<RunId>();
  for (const run of runs) {
    if (run.status === "rolled_back") {
      rolledBackRunIds.add(run.id);
    }
  }
  const eligible = messages.filter((message) => {
    if (message.streaming) return false;
    if (message.role !== "user" && message.role !== "assistant") return false;
    if (message.runId !== null && rolledBackRunIds.has(message.runId)) return false;
    return message.text.trim().length > 0;
  });
  const recent = eligible.slice(-MAX_TRANSCRIPT_MESSAGES);
  if (recent.length === 0 || !recent.some((message) => message.role === "assistant")) {
    return null;
  }
  return recent
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}:\n${message.text.trim()}`)
    .join("\n\n");
}

const make = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const providerSessionManager = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const fileSystem = yield* FileSystem.FileSystem;

  const activeByThread = yield* Ref.make<ReadonlyMap<ThreadId, Fiber.Fiber<void>>>(new Map());

  const generateForRun: PromptSuggestionServiceShape["generateForRun"] = Effect.fn(
    "PromptSuggestionService.generateForRun",
  )(function* (input) {
    if (NATIVE_PROMPT_SUGGESTION_DRIVERS.has(input.driver)) {
      return;
    }

    yield* Effect.gen(function* () {
      const allSettings = yield* serverSettings.getSettings;
      if (!allSettings.promptSuggestionsEnabled) {
        return;
      }

      const projection = yield* projectionStore.getThreadRecords(
        input.threadId,
        ["messages", "runs"],
        { messageRoles: ["user", "assistant"] },
      );
      if (
        projection.thread.deletedAt !== null ||
        isDelegatedAppThread(projection.thread) ||
        !isLatestCompletedRun(projection.runs, input.runId)
      ) {
        return;
      }

      const transcript = formatSuggestionTranscript(projection.messages, projection.runs);
      if (transcript === null) {
        return;
      }

      const project = yield* projects.get(projection.thread.projectId);
      if (Option.isNone(project)) {
        return;
      }

      const worktreePath = projection.thread.worktreePath;
      const worktreeExists =
        worktreePath !== null &&
        (yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => false)));
      const cwd = worktreeExists ? worktreePath : project.value.workspaceRoot;

      const effectiveSettings = resolveProjectSettings(
        allSettings,
        projection.thread.projectId,
      ).settings;

      const generated = yield* textGeneration.generatePromptSuggestion({
        cwd,
        transcript,
        modelSelection: effectiveSettings.textGenerationModelSelection,
        projectId: projection.thread.projectId,
      });
      if (generated.suggestion === null) {
        return;
      }

      const latest = yield* projectionStore.getThreadRecords(input.threadId, ["runs"]);
      if (latest.thread.deletedAt !== null || !isLatestCompletedRun(latest.runs, input.runId)) {
        return;
      }

      yield* providerSessionManager.setPromptSuggestion({
        threadId: input.threadId,
        runId: input.runId,
        text: generated.suggestion,
        overwrite: false,
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.logDebug("Prompt suggestion generation skipped", {
          threadId: input.threadId,
          runId: input.runId,
          driver: input.driver,
          error,
        }),
      ),
    );
  });

  const scheduleForRun: PromptSuggestionServiceShape["scheduleForRun"] = Effect.fn(
    "PromptSuggestionService.scheduleForRun",
  )(function* (input) {
    if (NATIVE_PROMPT_SUGGESTION_DRIVERS.has(input.driver)) {
      return;
    }

    const previous = yield* Ref.modify(activeByThread, (current) => {
      const existing = current.get(input.threadId);
      if (existing === undefined) return [undefined, current] as const;
      const next = new Map(current);
      next.delete(input.threadId);
      return [existing, next] as const;
    });
    if (previous !== undefined) {
      yield* Fiber.interrupt(previous);
    }

    let fiberRef: Fiber.Fiber<void> | undefined;
    const fiber = yield* generateForRun(input).pipe(
      Effect.ensuring(
        Ref.update(activeByThread, (current) => {
          if (fiberRef === undefined || current.get(input.threadId) !== fiberRef) {
            return current;
          }
          const next = new Map(current);
          next.delete(input.threadId);
          return next;
        }),
      ),
      Effect.forkIn(scope),
    );
    fiberRef = fiber;
    yield* Ref.update(activeByThread, (current) => new Map(current).set(input.threadId, fiber));
  });

  return PromptSuggestionService.of({
    generateForRun,
    scheduleForRun,
  });
});

export const layer = Layer.effect(PromptSuggestionService, make);
