import type { SendUserTurnOptions } from "@muse-code/sdk";
import {
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  MUSE_REASONING_EFFORT_OPTIONS,
  type ModelSelection,
  type MuseSettings,
  TextGenerationError,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { MUSE_DEFAULT_MODEL } from "../provider/Layers/MuseProvider.ts";
import { createMuseSdkHost, type MuseSdkHost } from "../provider/museSdk.ts";
import type * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";

const SessionStarted = Schema.Struct({ session: Schema.Struct({ sessionId: Schema.String }) });
const ItemNotification = Schema.Struct({
  sessionId: Schema.String,
  item: Schema.Struct({
    itemId: Schema.String,
    kind: Schema.String,
    revision: Schema.Int,
    turnId: Schema.optionalKey(Schema.String),
    text: Schema.optionalKey(Schema.String),
    retracted: Schema.optionalKey(Schema.Boolean),
    truncated: Schema.optionalKey(Schema.Boolean),
  }),
});
const TurnCompleted = Schema.Struct({
  sessionId: Schema.String,
  turnId: Schema.String,
  terminal: Schema.String,
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
});
const ApprovalRequested = Schema.Struct({
  sessionId: Schema.String,
  approvalId: Schema.String,
  currentRequirementId: Schema.Unknown,
  availableChoices: Schema.Array(
    Schema.Struct({ choiceId: Schema.String, decision: Schema.String }),
  ),
});
const UserInputRequested = Schema.Struct({
  sessionId: Schema.String,
  userInputId: Schema.String,
});
const decodeSession = Schema.decodeUnknownSync(SessionStarted);
const decodeItem = Schema.decodeUnknownSync(ItemNotification);
const decodeCompleted = Schema.decodeUnknownSync(TurnCompleted);
const decodeApproval = Schema.decodeUnknownSync(ApprovalRequested);
const decodeUserInput = Schema.decodeUnknownSync(UserInputRequested);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const SUPPORTED_EFFORTS = new Set<string>(
  MUSE_REASONING_EFFORT_OPTIONS.map((option) => option.id) satisfies ReadonlyArray<
    NonNullable<SendUserTurnOptions<never>["reasoningEffort"]>
  >,
);

type Operation = keyof TextGeneration.TextGeneration["Service"];

async function generateMuseText(
  host: MuseSdkHost,
  workspaceRoot: string,
  prompt: string,
  selection: ModelSelection,
  signal: AbortSignal,
) {
  let sessionId: string | undefined;
  const turnId = host.connection.mintCommandId();
  const messages = new Map<string, (typeof ItemNotification.Type)["item"]>();
  let resolveCompletion: (text: string) => void = () => {};
  let rejectCompletion: (error: unknown) => void = () => {};
  const completion = new Promise<string>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // Notifications may settle the turn before the turn/start acknowledgement arrives.
  void completion.catch(() => {});
  const rejectInteractive = async (method: string, params: Record<string, unknown>) => {
    if (method === "approval/requested") {
      const approval = decodeApproval(params);
      if (approval.sessionId !== sessionId) return;
      rejectCompletion(new Error("Muse requested an interactive action during text generation."));
      const deny = approval.availableChoices.find((choice) => choice.decision === "denied");
      if (deny) {
        await host.connection.command("approval/decide", {
          sessionId,
          approvalId: approval.approvalId,
          requirementId: approval.currentRequirementId,
          choiceId: deny.choiceId,
        });
      }
    } else {
      const request = decodeUserInput(params);
      if (request.sessionId !== sessionId) return;
      rejectCompletion(new Error("Muse requested an interactive action during text generation."));
      await host.connection.command("userInput/cancel", {
        sessionId,
        userInputId: request.userInputId,
        reason: "T3 Code text generation cannot request user input.",
      });
    }
  };
  host.connection.onNotification((notification) => {
    try {
      if (notification.method === "item/completed" || notification.method === "item/updated") {
        const { item, sessionId: itemSessionId } = decodeItem(notification.params);
        if (itemSessionId !== sessionId || item.turnId !== turnId || item.kind !== "agentMessage")
          return;
        const previous = messages.get(item.itemId);
        if (!previous || item.revision > previous.revision) messages.set(item.itemId, item);
      } else if (notification.method === "turn/completed") {
        const completed = decodeCompleted(notification.params);
        if (completed.sessionId !== sessionId || completed.turnId !== turnId) return;
        if (completed.terminal === "completed") {
          // A turn may include commentary before its final structured answer.
          const answer = [...messages.values()].findLast((item) => !item.retracted);
          if (answer?.truncated) {
            rejectCompletion(new Error("Muse text generation returned a truncated response."));
          } else {
            resolveCompletion(answer?.text ?? "");
          }
        } else {
          rejectCompletion(
            new Error(completed.error?.message ?? `Muse turn ${completed.terminal}.`),
          );
        }
      } else if (
        notification.method === "approval/requested" ||
        notification.method === "userInput/requested"
      ) {
        void rejectInteractive(notification.method, notification.params ?? {}).catch(
          rejectCompletion,
        );
      } else if (notification.method === "view/gap") {
        rejectCompletion(new Error("Muse text generation lost part of its response."));
      }
    } catch (error) {
      rejectCompletion(error);
    }
  });
  host.connection.onProtocolError(rejectCompletion);
  host.connection.onServerRequest(async () => {
    const error = new Error("T3 Code text generation cannot approve interactive requests.");
    rejectCompletion(error);
    throw error;
  });
  void host.connection.closed.then(() => {
    rejectCompletion(new Error("Muse connection closed before text generation completed."));
  });
  void host.exited.then(() => {
    rejectCompletion(new Error("Muse exited before text generation completed."));
  });
  const onAbort = () => rejectCompletion(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const started = decodeSession(
      await host.connection.command("session/start", {
        workspaceRoot,
        providerId: "meta",
        modelId: selection.model.trim() || MUSE_DEFAULT_MODEL,
        approvalMode: "denyUnmatched",
      }),
    );
    sessionId = started.session.sessionId;
    const selectedEffort = getModelSelectionStringOptionValue(selection, "reasoningEffort");
    const acknowledged = host.connection.command(
      "turn/start",
      {
        sessionId,
        input: [{ type: "text", text: prompt }],
        reasoningEffort: selectedEffort ?? DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
      },
      { commandId: turnId },
    );
    return await Promise.race([acknowledged.then(() => completion), completion]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export const makeMuseTextGeneration = Effect.fn("makeMuseTextGeneration")(function* (
  settings: MuseSettings,
  environment?: NodeJS.ProcessEnv,
  createHost: typeof createMuseSdkHost = createMuseSdkHost,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const runMuseJson = Effect.fn("runMuseJson")(function* <S extends Schema.Top>(input: {
    operation: Operation;
    prompt: string;
    outputSchema: S;
    modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const { operation } = input;
    if (!settings.enabled) {
      return yield* new TextGenerationError({ operation, detail: "Muse Code is disabled." });
    }
    const selectedEffort = getModelSelectionStringOptionValue(
      input.modelSelection,
      "reasoningEffort",
    );
    if (selectedEffort !== undefined && !SUPPORTED_EFFORTS.has(selectedEffort)) {
      return yield* new TextGenerationError({
        operation,
        detail: `Muse does not support reasoning effort '${selectedEffort}'. Choose ${[...SUPPORTED_EFFORTS].join(", ")}.`,
      });
    }
    const jsonSchema = yield* encodeJson(toJsonSchemaObject(input.outputSchema)).pipe(
      Effect.mapError(
        (cause) => new TextGenerationError({ operation, detail: "Invalid output schema.", cause }),
      ),
    );
    const response = yield* Effect.gen(function* () {
      // Metadata requests already include their context and do not need checkout configuration.
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-muse-text-" });
      const host = yield* Effect.acquireRelease(
        Effect.tryPromise<MuseSdkHost>((signal) =>
          createHost({
            binaryPath: settings.binaryPath,
            cwd,
            ...(environment ? { environment } : {}),
            readOnly: true,
            // Muse derives SDK turn events from its session log, including completion.
            sessionLogging: true,
            signal,
          }),
        ),
        (host: MuseSdkHost) => Effect.promise(() => host.close()),
        { interruptible: true },
      );
      return yield* Effect.tryPromise((signal) =>
        generateMuseText(
          host,
          cwd,
          `${input.prompt}\n\nReturn only a JSON object matching this schema, with no markdown fences. Do not use tools or ask questions.\n${jsonSchema}`,
          input.modelSelection,
          signal,
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail:
              "Muse Code text generation failed. Check Muse login and availability on this T3 server host.",
            cause,
          }),
      ),
      Effect.timeoutOption(180_000),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new TextGenerationError({ operation, detail: "Muse request timed out." })),
          onSome: Effect.succeed,
        }),
      ),
    );
    const decodeOutput = Schema.decodeEffect(input.outputSchema);
    return yield* decodeJson(extractJsonObject(response)).pipe(
      Effect.flatMap(decodeOutput),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Muse returned invalid structured output.",
            cause,
          }),
      ),
    );
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("MuseTextGeneration.generateCommitMessage")(function* (input) {
      const generated = yield* runMuseJson({
        operation: "generateCommitMessage",
        ...buildCommitMessagePrompt({ ...input, includeBranch: input.includeBranch === true }),
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });
  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("MuseTextGeneration.generatePrContent")(function* (input) {
      const generated = yield* runMuseJson({
        operation: "generatePrContent",
        ...buildPrContentPrompt(input),
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });
  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("MuseTextGeneration.generateBranchName")(function* (input) {
      const generated = yield* runMuseJson({
        operation: "generateBranchName",
        ...buildBranchNamePrompt(input),
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });
  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("MuseTextGeneration.generateThreadTitle")(function* (input) {
      const generated = yield* runMuseJson({
        operation: "generateThreadTitle",
        ...buildThreadTitlePrompt(input),
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });
  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
