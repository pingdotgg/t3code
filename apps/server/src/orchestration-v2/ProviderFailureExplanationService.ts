import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import type {
  OrchestrationV2ExplainProviderFailureResult,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderRetry,
  OrchestrationV2TurnItem,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import packageJson from "../../package.json" with { type: "json" };
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { limitSection } from "../textGeneration/TextGenerationUtils.ts";
import * as KnownIssueSearch from "./KnownIssueSearch.ts";
import { buildProviderFailureReportUrl } from "./ProviderFailureReportLink.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

/** Everything the model sees, however long the thread or the failure text. */
const MAX_CONTEXT_CHARS = 12_000;
const MAX_FAILURE_MESSAGE_CHARS = 4_096;
const MAX_USER_MESSAGE_CHARS = 2_000;
const MAX_RECENT_ITEMS = 10;

/**
 * The run's items worth describing. Reading is limited to these so a long run
 * of file changes (whose bodies are large) is never loaded for ten labels.
 */
const DESCRIBED_ITEM_TYPES = [
  "user_message",
  "error",
  "command_execution",
  "dynamic_tool",
] as const satisfies ReadonlyArray<OrchestrationV2TurnItem["type"]>;

const GENERATION_FAILED_MESSAGE =
  "The text generation model could not explain this error. Check the server logs for details.";

/** `message` is fixed T3 text, safe to show the user. The underlying cause is only logged. */
export class ProviderFailureExplanationError extends Schema.TaggedError<ProviderFailureExplanationError>()(
  "ProviderFailureExplanationError",
  {
    threadId: Schema.String,
    reason: Schema.Literals(["no_failure", "thread_unavailable", "changed", "generation_failed"]),
    message: Schema.String,
  },
) {}

export class ProviderFailureExplanationService extends Context.Service<
  ProviderFailureExplanationService,
  {
    /**
     * Asks the text generation model what probably caused the error the thread
     * reports as its `lastError`. `runId` and `revision`, when given, are what
     * the caller is showing; a thread that has moved on is refused.
     */
    readonly explain: (input: {
      readonly threadId: ThreadId;
      readonly runId?: RunId | undefined;
      readonly revision?: string | undefined;
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
  /** The user message that started the failing run, when the failure belongs to a run. */
  readonly userMessage: { readonly text: string; readonly imageCount: number } | null;
  /** The failing run's items in timeline order. The failure's own item and message items are skipped. */
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
}

/**
 * A label per item. Commands contribute only their status and exit code: their
 * text, arguments, and output can carry credentials in forms no parser catches.
 */
function describeItem(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
    case "error":
      return null;
    case "command_execution":
      return [
        item.type,
        item.status,
        ...(item.exitCode === undefined ? [] : [`exit ${item.exitCode}`]),
      ].join(" ");
    case "dynamic_tool":
      return [item.type, item.status, item.toolName ?? ""].filter(Boolean).join(" ");
    default:
      return [item.type, item.status].join(" ");
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
      return label === null ? [] : [`- ${label}`];
    })
    .slice(-MAX_RECENT_ITEMS);
  const userMessage = input.userMessage;

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
      `Message: ${limitSection(failure.message, MAX_FAILURE_MESSAGE_CHARS)}`,
    ].join("\n"),
    userMessage === null
      ? null
      : [
          userMessage.text.trim().length === 0
            ? null
            : `Last user message of this run:\n${limitSection(userMessage.text.trim(), MAX_USER_MESSAGE_CHARS)}`,
          userMessage.imageCount === 0
            ? null
            : `User message had ${userMessage.imageCount} image attachment${userMessage.imageCount === 1 ? "" : "s"}`,
        ]
          .filter((part) => part !== null)
          .join("\n"),
    recent.length === 0 ? null : `Recent activity in this run, oldest first:\n${recent.join("\n")}`,
  ];
  return limitSection(
    sections.filter((section) => section !== null && section.length > 0).join("\n\n"),
    MAX_CONTEXT_CHARS,
  );
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const knownIssueSearch = yield* KnownIssueSearch.KnownIssueSearch;

  const explain: ProviderFailureExplanationService["Service"]["explain"] = Effect.fn(
    "ProviderFailureExplanationService.explain",
  )(function* (input) {
    const refuse = (
      reason: ProviderFailureExplanationError["reason"],
      message: string,
      cause?: unknown,
    ) =>
      (cause === undefined
        ? Effect.void
        : Effect.logWarning("Provider failure explanation failed", reason, cause)
      ).pipe(
        Effect.andThen(
          Effect.fail(
            new ProviderFailureExplanationError({ threadId: input.threadId, reason, message }),
          ),
        ),
        Effect.annotateLogs({ threadId: input.threadId }),
      );
    const unavailable = (cause: unknown) =>
      refuse(
        "thread_unavailable",
        "This thread could not be read, so the error cannot be explained.",
        cause,
      );

    // The thread shell decides what the banner shows as `lastError`, including
    // a session-level error that supersedes the run's own failure.
    const shell = yield* threads.getThreadShell(input.threadId).pipe(
      Effect.catch(unavailable),
      Effect.flatMap((found) => (found === null ? unavailable(undefined) : Effect.succeed(found))),
    );
    const lastError = shell.lastError ?? null;
    if (lastError === null) {
      return yield* refuse("no_failure", "This thread has no provider failure to explain.");
    }
    if (
      (input.runId !== undefined && input.runId !== shell.latestRunId) ||
      (input.revision !== undefined && input.revision !== lastError)
    ) {
      return yield* refuse("changed", "The error changed before it could be explained.");
    }

    const runId = shell.latestRunId;
    const records =
      runId === null
        ? {
            run: null,
            runItems: [] as ReadonlyArray<OrchestrationV2TurnItem>,
            providerSessions: (yield* threads
              .getThreadRecords(input.threadId, ["providerSessions"])
              .pipe(Effect.catch(unavailable))).providerSessions,
          }
        : yield* threads
            .getThreadRecords(input.threadId, ["runs", "turnItems", "providerSessions"], {
              runIds: [runId],
              turnItemRunId: runId,
              turnItemTypes: DESCRIBED_ITEM_TYPES,
            })
            .pipe(
              Effect.catch(unavailable),
              Effect.map((found) => ({
                run: found.runs.find((candidate) => candidate.id === runId) ?? null,
                runItems: found.turnItems,
                providerSessions: found.providerSessions,
              })),
            );
    const { run, runItems } = records;

    // The run's own failure when it is the one reported; otherwise the failure is
    // the session's, and only its message and class are known.
    const runFailure = latestRootProviderFailure(run, runItems);
    const reportsRunFailure = runFailure !== null && runFailure.message === lastError;
    const failure: OrchestrationV2ProviderFailure =
      runFailure !== null && reportsRunFailure
        ? runFailure
        : {
            class: shell.lastErrorClass ?? "unknown",
            message: lastError,
            code: null,
            retryable: null,
          };
    const failureItem = runItems.find(
      (item) => item.type === "error" && item.failure === runFailure,
    );
    const userMessageItem = runItems.findLast((item) => item.type === "user_message");

    const providerInstanceId = run?.providerInstanceId ?? shell.providerInstanceId;
    const driver =
      records.providerSessions.find((session) => session.providerInstanceId === providerInstanceId)
        ?.driver ?? null;
    const model = (run?.modelSelection ?? shell.modelSelection).model;
    const context = formatProviderFailureContext({
      providerInstanceId,
      driver,
      model,
      runtimeMode: shell.runtimeMode,
      failure,
      // Retry progress belongs to the run's failure, not to a session error replacing it.
      retry: reportsRunFailure && failureItem?.type === "error" ? failureItem.retry : undefined,
      userMessage:
        userMessageItem?.type === "user_message"
          ? {
              text: userMessageItem.text,
              imageCount: userMessageItem.attachments.filter(
                (attachment) => attachment.type === "image",
              ).length,
            }
          : null,
      items: runItems.filter((item) => item !== failureItem),
    });

    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings.pipe(
        Effect.catch((cause) => refuse("generation_failed", GENERATION_FAILED_MESSAGE, cause)),
      ),
      shell.projectId,
    ).settings;
    // Best effort: a failed lookup is an empty list and the explanation goes on without it.
    const candidates = yield* knownIssueSearch.search({ message: failure.message, driver });
    const explanation = yield* textGeneration
      .explainProviderFailure({
        context,
        knownIssues: candidates,
        modelSelection: settings.textGenerationModelSelection,
      })
      .pipe(Effect.catch((cause) => refuse("generation_failed", GENERATION_FAILED_MESSAGE, cause)));
    const platform = `${yield* HostProcessPlatform} ${yield* HostProcessArchitecture}`;
    // The model's choice counts only if it is one of the issues it was shown.
    const knownIssue = KnownIssueSearch.selectKnownIssue(
      candidates,
      explanation.matchingIssueNumber,
    );
    return {
      failureMessage: lastError,
      summary: explanation.summary,
      likelyFix: explanation.likelyFix,
      knownIssue:
        knownIssue === null
          ? null
          : { number: knownIssue.number, title: knownIssue.title, url: knownIssue.url },
      reportUrl: buildProviderFailureReportUrl({
        failureMessage: failure.message,
        driver,
        runtimeMode: shell.runtimeMode,
        platform,
        serverVersion: packageJson.version,
      }),
    };
  });

  return ProviderFailureExplanationService.of({ explain });
});

export const layer = Layer.effect(ProviderFailureExplanationService, make);
