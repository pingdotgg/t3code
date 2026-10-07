import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import type {
  OrchestrationV2ExplainProviderFailureResult,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderRetry,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { limitSection } from "../textGeneration/TextGenerationUtils.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

/** Everything the model sees, however long the thread or the failure text. */
const MAX_CONTEXT_CHARS = 12_000;
const MAX_USER_MESSAGE_CHARS = 2_000;
const MAX_ITEM_LABEL_CHARS = 80;
const MAX_RECENT_ITEMS = 10;

/** `detail` is safe to show the user: it says why no explanation was produced. */
export class ProviderFailureExplanationError extends Schema.TaggedError<ProviderFailureExplanationError>()(
  "ProviderFailureExplanationError",
  {
    threadId: Schema.String,
    reason: Schema.Literals(["no_failure", "thread_unavailable", "generation_failed"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class ProviderFailureExplanationService extends Context.Service<
  ProviderFailureExplanationService,
  {
    /** Asks the text generation model what probably caused the thread's latest provider failure. */
    readonly explain: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<
      OrchestrationV2ExplainProviderFailureResult,
      ProviderFailureExplanationError
    >;
  }
>()("t3/orchestration-v2/ProviderFailureExplanationService") {}

export interface ProviderFailureContextInput {
  readonly providerInstanceId: string;
  readonly driver: string | null;
  readonly model: string | null;
  readonly runtimeMode: string;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly retry?: OrchestrationV2ProviderRetry | undefined;
  /** Text of the user message that started the failing run. */
  readonly userMessage: string | null;
  /** The failing run's items in timeline order. The failure's own item and message items are skipped. */
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
}

const oneLine = (value: string, maxChars: number) => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 3).trimEnd()}...`;
};

/**
 * A short label per item. Commands reduce to the executable name because the
 * arguments and environment can carry credentials; outputs are never included.
 */
function describeItem(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
    case "error":
      return null;
    case "command_execution": {
      const executable = item.input
        .trim()
        .split(/\s+/)
        .find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
      return [
        executable === undefined ? null : oneLine(executable, MAX_ITEM_LABEL_CHARS),
        item.exitCode === undefined ? null : `exit ${item.exitCode}`,
      ]
        .filter((part) => part !== null)
        .join(" ");
    }
    case "dynamic_tool":
      return item.toolName === null ? "" : oneLine(item.toolName, MAX_ITEM_LABEL_CHARS);
    case "file_change":
      return oneLine(item.fileName, MAX_ITEM_LABEL_CHARS);
    default:
      return item.title === null ? "" : oneLine(item.title, MAX_ITEM_LABEL_CHARS);
  }
}

/** The plain-text context the model reads, bounded to `MAX_CONTEXT_CHARS`. */
export function formatProviderFailureContext(input: ProviderFailureContextInput): string {
  const { failure } = input;
  const retryLine =
    input.retry === undefined
      ? `Provider marked retryable: ${failure.retryable === null ? "unknown" : failure.retryable ? "yes" : "no"}`
      : `Retried by the provider: attempt ${input.retry.attempt}${input.retry.maxAttempts === null ? "" : ` of ${input.retry.maxAttempts}`}`;
  const recent = input.items
    .flatMap((item) => {
      const label = describeItem(item);
      return label === null
        ? []
        : [`- ${[item.type, item.status, label].filter(Boolean).join(" ")}`];
    })
    .slice(-MAX_RECENT_ITEMS);

  const sections = [
    [
      `Provider instance: ${input.providerInstanceId}${input.driver === null ? "" : ` (driver ${input.driver})`}`,
      `Model: ${input.model ?? "unknown"}`,
      `Runtime mode: ${input.runtimeMode}`,
    ].join("\n"),
    [
      "Failure:",
      `Class: ${failure.class}`,
      `Code: ${failure.code ?? "none"}`,
      retryLine,
      `Message: ${failure.message}`,
    ].join("\n"),
    input.userMessage === null || input.userMessage.trim().length === 0
      ? null
      : `Last user message of this run:\n${limitSection(input.userMessage.trim(), MAX_USER_MESSAGE_CHARS)}`,
    recent.length === 0 ? null : `Recent activity in this run, oldest first:\n${recent.join("\n")}`,
  ];
  return limitSection(
    sections.filter((section) => section !== null).join("\n\n"),
    MAX_CONTEXT_CHARS,
  );
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const explain: ProviderFailureExplanationService["Service"]["explain"] = Effect.fn(
    "ProviderFailureExplanationService.explain",
  )(function* (input) {
    const unavailable = (cause: unknown) =>
      new ProviderFailureExplanationError({
        threadId: input.threadId,
        reason: "thread_unavailable",
        detail: "This thread could not be read, so the error cannot be explained.",
        cause,
      });

    const errors = yield* threads
      .getThreadRecords(input.threadId, ["turnItems"], { turnItemTypes: ["error"] })
      .pipe(Effect.mapError(unavailable));
    // Items arrive in timeline order, so the last error is the latest.
    const failureItem = errors.turnItems.findLast((item) => item.type === "error");
    if (failureItem === undefined || failureItem.type !== "error") {
      return yield* new ProviderFailureExplanationError({
        threadId: input.threadId,
        reason: "no_failure",
        detail: "This thread has no provider failure to explain.",
      });
    }

    const run = yield* failureItem.runId === null
      ? Effect.succeed(null)
      : threads
          .getThreadRecords(input.threadId, ["runs", "turnItems", "providerSessions"], {
            runIds: [failureItem.runId],
            turnItemRunId: failureItem.runId,
          })
          .pipe(Effect.mapError(unavailable));
    const thread = (run ?? errors).thread;
    const runRecord = run?.runs[0];
    const runItems = (run?.turnItems ?? []).filter((item) => item.id !== failureItem.id);
    const providerInstanceId = runRecord?.providerInstanceId ?? thread.providerInstanceId;
    const modelSelection = runRecord?.modelSelection ?? thread.modelSelection;

    const project = yield* projects.get(thread.projectId).pipe(Effect.mapError(unavailable));
    if (Option.isNone(project)) return yield* unavailable(undefined);
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings.pipe(Effect.mapError(unavailable)),
      thread.projectId,
    ).settings;

    const userMessage = runItems.findLast((item) => item.type === "user_message");
    const context = formatProviderFailureContext({
      providerInstanceId,
      driver:
        run?.providerSessions.find((session) => session.providerInstanceId === providerInstanceId)
          ?.driver ?? null,
      model: modelSelection.model,
      runtimeMode: thread.runtimeMode,
      failure: failureItem.failure,
      retry: failureItem.retry,
      userMessage: userMessage?.type === "user_message" ? userMessage.text : null,
      items: runItems,
    });

    const explanation = yield* textGeneration
      .explainProviderFailure({
        cwd: thread.worktreePath ?? project.value.workspaceRoot,
        context,
        modelSelection: settings.textGenerationModelSelection,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderFailureExplanationError({
              threadId: input.threadId,
              reason: "generation_failed",
              detail: `The text generation model could not explain this error: ${cause.detail}`,
              cause,
            }),
        ),
      );
    return {
      failureMessage: failureItem.failure.message,
      summary: explanation.summary,
      likelyFix: explanation.likelyFix,
    };
  });

  return ProviderFailureExplanationService.of({ explain });
});

export const layer = Layer.effect(ProviderFailureExplanationService, make);
