import {
  OpenRouterSignInError,
  type OpenRouterSignIn as SignIn,
  type OpenRouterSignInStatus,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as CloudSpeech from "./CloudSpeech.ts";

const AUTHORIZE_URL = "https://openrouter.ai/auth";
const EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
// OpenRouter's codes last ten minutes; a sign-in left open longer is abandoned.
const SIGN_IN_LIFETIME = Duration.minutes(10);
const MAX_PENDING = 16;

const ExchangedKey = Schema.Struct({ key: Schema.String });

/**
 * OpenRouter's OAuth PKCE sign-in, which creates an API key for this environment's cloud speech.
 * The verifier and the key stay on the environment; clients only open the authorization URL.
 */
export class OpenRouterSignIn extends Context.Service<
  OpenRouterSignIn,
  {
    /** The URL to open. OpenRouter returns to `callbackUrl`, or shows a code to paste without one. */
    readonly start: (input: {
      readonly callbackUrl: string | null;
      readonly label: string;
    }) => Effect.Effect<SignIn>;
    /** Exchanges the code a started sign-in returned for a key, and saves it for OpenRouter. */
    readonly finish: (state: string, code: string) => Effect.Effect<void, OpenRouterSignInError>;
    /** Where a sign-in stands, so a client can tell it finished even when a key was saved before. */
    readonly status: (state: string) => Effect.Effect<OpenRouterSignInStatus["status"]>;
  }
>()("t3/speech/OpenRouterSignIn") {}

const make = Effect.gen(function* () {
  const cloud = yield* CloudSpeech.CloudSpeech;
  const http = yield* HttpClient.HttpClient;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const pending = new Map<string, { readonly verifier: string; readonly expiresAt: number }>();
  // How finished sign-ins ended, kept as long as a sign-in could still be waited on.
  const outcomes = new Map<
    string,
    {
      readonly status: Exclude<OpenRouterSignInStatus["status"], "pending">;
      readonly expiresAt: number;
    }
  >();
  const token = (size: number) => random.randomBytes(size).pipe(Effect.map(Base64Url.encode));

  const start = Effect.fn("OpenRouterSignIn.start")(function* (input: {
    readonly callbackUrl: string | null;
    readonly label: string;
  }) {
    const now = yield* Clock.currentTimeMillis;
    for (const [state, entry] of pending) if (entry.expiresAt <= now) pending.delete(state);
    for (const [state, entry] of outcomes) if (entry.expiresAt <= now) outcomes.delete(state);
    // Each start is a click; a flood of them must not grow without bound.
    while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
    const state = yield* token(32);
    const verifier = yield* token(64);
    const challenge = Base64Url.encode(
      yield* digest.digest(Digest.sha256, new TextEncoder().encode(verifier)),
    );
    pending.set(state, { verifier, expiresAt: now + Duration.toMillis(SIGN_IN_LIFETIME) });
    const url = new URL(AUTHORIZE_URL);
    // OpenRouter returns `state` to the callback; the pasted-code flow sends it back itself.
    url.search = new URLSearchParams({
      ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
      code_challenge: challenge,
      code_challenge_method: "S256",
      key_label: input.label,
      state,
    }).toString();
    return { authorizationUrl: url.toString(), state };
  });

  const exchange = Effect.fnUntraced(function* (state: string, code: string) {
    const entry = pending.get(state);
    pending.delete(state);
    if (!entry || entry.expiresAt <= (yield* Clock.currentTimeMillis))
      return yield* new OpenRouterSignInError({ reason: "expired" });
    const unavailable = () => new OpenRouterSignInError({ reason: "unavailable" });
    const response = yield* http
      .execute(
        HttpClientRequest.post(EXCHANGE_URL).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            code,
            code_verifier: entry.verifier,
            code_challenge_method: "S256",
          }),
        ),
      )
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError(unavailable),
      );
    if (response.status === 400 || response.status === 403)
      return yield* new OpenRouterSignInError({ reason: "rejected" });
    if (response.status < 200 || response.status >= 300) return yield* unavailable();
    const { key } = yield* HttpClientResponse.schemaBodyJson(ExchangedKey)(response).pipe(
      Effect.mapError(unavailable),
    );
    yield* cloud.setKey("openrouter", Redacted.make(key)).pipe(Effect.mapError(unavailable));
  });

  const finish = Effect.fn("OpenRouterSignIn.finish")(function* (state: string, code: string) {
    const known = pending.has(state);
    const result = yield* exchange(state, code).pipe(Effect.result);
    // A replayed or unknown state must not overwrite how the real sign-in ended.
    if (known)
      outcomes.set(state, {
        status: result._tag === "Success" ? "signed-in" : result.failure.reason,
        expiresAt: (yield* Clock.currentTimeMillis) + Duration.toMillis(SIGN_IN_LIFETIME),
      });
    if (result._tag === "Failure") return yield* result.failure;
  });

  const status = Effect.fn("OpenRouterSignIn.status")(function* (state: string) {
    const now = yield* Clock.currentTimeMillis;
    const entry = pending.get(state);
    if (entry && entry.expiresAt > now) return "pending" as const;
    const outcome = outcomes.get(state);
    return outcome && outcome.expiresAt > now ? outcome.status : ("expired" as const);
  });

  return OpenRouterSignIn.of({ start, finish, status });
});

export const layer = Layer.effect(OpenRouterSignIn, make);
