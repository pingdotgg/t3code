import type { ThreadSplitSuggestionInput, ThreadSplitSuggestionResult } from "@t3tools/contracts";
import question from "@t3tools/shared/threadSplitPrompt.json" with { type: "json" };
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Orchestrator from "./Orchestrator.ts";
import * as ServerSettings from "../serverSettings.ts";

const noSuggestion = { suggest: false } as const;
const Answer = Schema.Struct({
  model: Schema.String,
  answers: Schema.Struct({
    q: Schema.Struct({
      type: Schema.Literal("noul"),
      noul: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    }),
  }),
  truncated: Schema.optional(Schema.Boolean),
});
export class ThreadSplitSuggestions extends Context.Service<
  ThreadSplitSuggestions,
  {
    readonly suggest: (
      input: ThreadSplitSuggestionInput,
    ) => Effect.Effect<ThreadSplitSuggestionResult>;
  }
>()("t3/orchestration-v2/ThreadSplitSuggestions") {}

function isLocalDecisionEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      ["127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/v1/systemone"
    );
  } catch {
    return false;
  }
}

const decodeAnswer = Schema.decodeUnknownEffect(Answer);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const threads = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const http = yield* HttpClient.HttpClient;
  const busy = yield* Ref.make(false);
  const evaluate = Effect.fn("ThreadSplitSuggestions.evaluate")(function* (
    input: ThreadSplitSuggestionInput,
  ) {
    const config = yield* settings.getSettings;
    if (
      !config.threadSplitSuggestionsEnabled ||
      !isLocalDecisionEndpoint(config.threadSplitModelEndpoint)
    )
      return noSuggestion;
    const count = yield* threads.getMessageCount(input.threadId);
    if (count < 2 || count > 100) return noSuggestion;
    const source = yield* threads.getThreadRecords(input.threadId, ["messages", "runs"]);
    const inactive = (runs: typeof source.runs) =>
      runs.every((run) =>
        ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(run.status),
      );
    if (
      !inactive(source.runs) ||
      source.thread.forkedFrom ||
      source.thread.historyOrigin === "v1_import" ||
      source.thread.archivedAt ||
      source.thread.deletedAt
    )
      return noSuggestion;
    const prior: Array<{ user: string; assistant_final: string }> = [];
    for (const message of source.messages) {
      if (
        message.streaming ||
        message.attachments.length ||
        message.context?.records.length ||
        message.notification ||
        message.delegatedCompletion ||
        (message.role === "user" && message.createdBy !== "user") ||
        message.senderThreadId ||
        message.workflowScript ||
        message.role === "system"
      )
        return noSuggestion;
      if (message.role === "user") prior.push({ user: message.text, assistant_final: "" });
      else if (prior.length) prior[prior.length - 1]!.assistant_final = message.text.slice(0, 300);
    }
    if (!prior.length || !prior[prior.length - 1]!.assistant_final) return noSuggestion;
    const state = { prior_thread: prior, new_message: input.message };
    if (encodeJson(state).length > 24000) return noSuggestion;
    const response = yield* http.execute(
      HttpClientRequest.post(config.threadSplitModelEndpoint).pipe(
        HttpClientRequest.setBody(
          HttpBody.text(
            encodeJson({ model: "pplx-decider-flash-v1.2", state, questions: { q: question } }),
            "application/json",
          ),
        ),
      ),
    );
    if (response.status !== 200 || response.headers["x-mlx-decision-truncated"] === "true")
      return noSuggestion;
    const answer = yield* decodeAnswer(yield* response.json);
    if (
      answer.model !== "pplx-decider-flash-v1.2" ||
      answer.truncated ||
      answer.answers.q.noul < 0.94
    )
      return noSuggestion;
    const current = yield* threads.getThreadRecords(input.threadId, ["runs"]);
    const latestConfig = yield* settings.getSettings;
    return {
      suggest:
        latestConfig.threadSplitSuggestionsEnabled &&
        latestConfig.threadSplitModelEndpoint === config.threadSplitModelEndpoint &&
        inactive(current.runs) &&
        DateTime.toEpochMillis(current.thread.updatedAt) ===
          DateTime.toEpochMillis(source.thread.updatedAt),
    };
  });
  const suggest = Effect.fn("ThreadSplitSuggestions.suggest")(function* (
    input: ThreadSplitSuggestionInput,
  ) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const occupied = yield* Ref.getAndSet(busy, true);
        if (occupied) return noSuggestion;
        return yield* restore(evaluate(input)).pipe(
          Effect.timeout("15 seconds"),
          Effect.orElseSucceed(() => noSuggestion),
          Effect.ensuring(Ref.set(busy, false)),
        );
      }),
    );
  });
  return ThreadSplitSuggestions.of({ suggest });
});
export const layer = Layer.effect(ThreadSplitSuggestions, make);
