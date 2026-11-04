import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import {
  AgentSessionScanError,
  TextGenerationError,
  type AgentSessionHistoryInput,
  type AgentSessionHistoryResult,
  type AgentSessionPreviewInput,
  type AgentSessionPreviewResult,
} from "@t3tools/contracts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

export class AgentSessionHistory extends Context.Service<
  AgentSessionHistory,
  {
    readonly previewSession: (
      input: AgentSessionPreviewInput,
    ) => Effect.Effect<AgentSessionPreviewResult, AgentSessionScanError>;
    readonly generateRecap: (
      input: AgentSessionPreviewInput,
    ) => Effect.Effect<AgentSessionPreviewResult, AgentSessionScanError | TextGenerationError>;
    readonly listSessions: (
      input: AgentSessionHistoryInput,
    ) => Effect.Effect<AgentSessionHistoryResult, AgentSessionScanError>;
  }
>()("t3/project/AgentSessionHistory") {}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const generation = yield* TextGeneration.TextGeneration;
  const settings = yield* ServerSettings.ServerSettingsService;
  const lock = yield* Semaphore.make(1);
  const recaps = new Map<string, Extract<AgentSessionPreviewResult, { status: "ready" }>>();
  const keyFor = (input: AgentSessionPreviewInput) =>
    `${input.session.providerInstanceId}\0${input.session.providerSessionId}\0${input.workspaceRoot}`;
  const remember = (
    input: AgentSessionPreviewInput,
    value: Extract<AgentSessionPreviewResult, { status: "ready" }>,
  ) => {
    const key = keyFor(input);
    recaps.delete(key);
    recaps.set(key, value);
    if (recaps.size > 100) {
      const oldest = recaps.keys().next().value;
      if (oldest !== undefined) recaps.delete(oldest);
    }
  };
  const previewSession = Effect.fn("AgentSessionHistory.previewSession")(function* (
    input: AgentSessionPreviewInput,
  ) {
    const preview = yield* scanner.previewSession(input);
    const cached = recaps.get(keyFor(input));
    const result =
      preview.status === "ready" && cached?.revision === preview.revision
        ? { ...preview, recap: cached.recap }
        : preview;
    if (result.status === "ready" && input.cursor === undefined) remember(input, result);
    return result;
  });
  const generateRecap = Effect.fn("AgentSessionHistory.generateRecap")(function* (
    input: AgentSessionPreviewInput,
  ) {
    const recentInput = { workspaceRoot: input.workspaceRoot, session: input.session };
    const preview = yield* previewSession(recentInput);
    if (preview.status !== "ready" || preview.recap !== undefined || preview.messages.length === 0)
      return preview;
    if (generation.generateSessionRecap === undefined)
      return yield* new TextGenerationError({
        operation: "generateSessionRecap",
        detail: "Session recap generation is unavailable.",
      });
    const config = yield* settings.getSettings.pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-settings", cause })),
    );
    const recap = yield* generation.generateSessionRecap({
      cwd: input.workspaceRoot,
      modelSelection: config.textGenerationModelSelection,
      recentMessages: preview.messages
        .map(
          (message) =>
            `${message.role}: ${message.text}${message.truncated ? " [excerpt truncated]" : ""}`,
        )
        .join("\n\n"),
    });
    const current = yield* scanner.previewSession(recentInput);
    if (current.status !== "ready" || current.revision !== preview.revision)
      return { status: "unavailable", reason: "changed" } as const;
    const result = { ...current, recap };
    remember(input, result);
    return result;
  }, lock.withPermits(1));
  const listSessions = Effect.fn("AgentSessionHistory.listSessions")(function* (
    input: AgentSessionHistoryInput,
  ) {
    return yield* scanner.listSessions(input, recaps);
  });
  return AgentSessionHistory.of({ previewSession, generateRecap, listSessions });
});

export const layer = Layer.effect(AgentSessionHistory, make);
