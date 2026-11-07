import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as ServerSettings from "../serverSettings.ts";
import * as SpeechModelStore from "../speech/SpeechModelStore.ts";
import { parseFrontDecision } from "./decision.ts";
import { type FrontModelEntry, getFrontModel } from "./frontModels.ts";
import { type FrontLlama, loadFrontLlama } from "./llama.ts";
import { makeOpenAiFrontSession } from "./openai.ts";

export type FrontAction = "reply" | "delegate" | "note" | "none";

export interface FrontDecision {
  readonly action: FrontAction;
  readonly speech: string;
  readonly task?: string;
}

export interface FrontMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export class FrontModelError extends Schema.TaggedError<FrontModelError>()("FrontModelError", {
  operation: Schema.Literals(["download", "load", "decide"]),
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const base = `The voice front model failed to ${this.operation}.`;
    return this.detail ? `${base} ${this.detail}` : base;
  }
}

export interface FrontModelSession {
  /** Output forced through a JSON schema, so it always decodes. A shared message prefix reuses the KV cache. Interrupting the effect aborts generation. */
  readonly decide: (
    messages: readonly FrontMessage[],
  ) => Effect.Effect<FrontDecision, FrontModelError>;
}

export class FrontModel extends Context.Service<
  FrontModel,
  {
    /** Loads the configured model (managed GGUF, or the OpenAI-compatible URL override) and keeps it loaded for the scope, e.g. one call. */
    readonly acquire: Effect.Effect<FrontModelSession, FrontModelError, Scope.Scope>;
  }
>()("t3/voice/FrontModel") {}

/** A loaded model holds 2-4 GiB, so it goes once no call has used it for a while. */
const IDLE_UNLOAD = "5 minutes";

export const make = Effect.fn("FrontModel.make")(function* (
  load: (path: string, signal: AbortSignal) => Promise<FrontLlama> = loadFrontLlama,
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const store = yield* SpeechModelStore.SpeechModelStore;
  const http = yield* HttpClient.HttpClient;
  const workers = yield* RcMap.make({
    lookup: Effect.fn("FrontModel.load")(function* (model: FrontModelEntry) {
      const path = yield* store
        .download(model)
        .pipe(Effect.mapError((cause) => new FrontModelError({ operation: "download", cause })));
      return yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: (signal) => load(path, signal),
          catch: (cause) => new FrontModelError({ operation: "load", cause }),
        }),
        (loaded) => Effect.promise(() => loaded.dispose()),
      );
    }),
    idleTimeToLive: IDLE_UNLOAD,
  });
  const acquire = Effect.fn("FrontModel.acquire")(function* () {
    const configured = (yield* settings.getSettings.pipe(
      Effect.mapError((cause) => new FrontModelError({ operation: "load", cause })),
    )).voiceFrontModel;
    if (typeof configured !== "string")
      return yield* makeOpenAiFrontSession(configured).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
    const model = getFrontModel(configured);
    if (!model)
      return yield* new FrontModelError({
        operation: "load",
        detail: `Unknown front model "${configured}".`,
      });
    const loaded = yield* RcMap.get(workers, model);
    const decide: FrontModelSession["decide"] = Effect.fn("FrontModel.decide")(
      function* (messages) {
        const text = yield* Effect.tryPromise({
          try: (signal) => loaded.decide(messages, signal),
          catch: (cause) => new FrontModelError({ operation: "decide", cause }),
        });
        const decision = parseFrontDecision(text);
        if (!decision)
          return yield* new FrontModelError({
            operation: "decide",
            detail: `The model's reply was not a decision: ${text.slice(0, 200)}`,
          });
        return decision;
      },
    );
    return { decide } satisfies FrontModelSession;
  });
  return FrontModel.of({ acquire: acquire() });
});

export const layer = Layer.effect(FrontModel, make());
