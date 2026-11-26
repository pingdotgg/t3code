import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it } from "@effect/vitest";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect, vi } from "vite-plus/test";

import * as CloudSpeech from "./CloudSpeech.ts";
import * as OpenRouterSignIn from "./OpenRouterSignIn.ts";

const setup = (respond: (body: Record<string, string>) => Response) => {
  const exchanges: Array<{ url: string; body: Record<string, string> }> = [];
  const setKey = vi.fn((_provider: string, _key: unknown) => Effect.void);
  const layer = OpenRouterSignIn.layer.pipe(
    Layer.provide(Layer.mock(CloudSpeech.CloudSpeech)({ setKey })),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            const body =
              request.body._tag === "Uint8Array"
                ? JSON.parse(new TextDecoder().decode(request.body.body))
                : {};
            exchanges.push({ url: request.url, body });
            return HttpClientResponse.fromWeb(request, respond(body));
          }),
        ),
      ),
    ),
    Layer.provide(NodeCrypto.layer),
  );
  return { exchanges, setKey, layer };
};

it.effect("saves the key OpenRouter returns for a started sign-in, once", () => {
  const fake = setup(() => Response.json({ key: "sk-or-v1-signed-in" }));
  return Effect.gen(function* () {
    const signIn = yield* OpenRouterSignIn.OpenRouterSignIn;
    const { authorizationUrl, state } = yield* signIn.start({
      callbackUrl: "http://localhost:7243/api/voice/cloud/openrouter/callback",
      label: "T3 Code (Laptop)",
    });
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://openrouter.ai/auth");
    expect(url.searchParams.get("callback_url")).toBe(
      "http://localhost:7243/api/voice/cloud/openrouter/callback",
    );
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("key_label")).toBe("T3 Code (Laptop)");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(yield* signIn.status(state)).toBe("pending");

    yield* signIn.finish(state, "returned-code");
    expect(yield* signIn.status(state)).toBe("signed-in");
    const [exchange] = fake.exchanges;
    expect(exchange?.url).toBe("https://openrouter.ai/api/v1/auth/keys");
    expect(exchange?.body).toMatchObject({ code: "returned-code", code_challenge_method: "S256" });
    // The verifier sent is the one the challenge was made from.
    const digest = yield* Digest.Digest;
    const challenge = Base64Url.encode(
      yield* digest.digest(Digest.sha256, new TextEncoder().encode(exchange!.body.code_verifier)),
    );
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(fake.setKey).toHaveBeenCalledTimes(1);
    const [provider, key] = fake.setKey.mock.calls[0]!;
    expect(provider).toBe("openrouter");
    expect(Redacted.value(key as Redacted.Redacted<string>)).toBe("sk-or-v1-signed-in");

    // A state works once, so a replayed callback cannot save another key.
    const replay = yield* signIn.finish(state, "returned-code").pipe(Effect.flip);
    expect(replay.reason).toBe("expired");
    expect(fake.exchanges).toHaveLength(1);
    // The replay does not change how the real sign-in ended.
    expect(yield* signIn.status(state)).toBe("signed-in");
  }).pipe(Effect.provide(Layer.merge(fake.layer, NodeCrypto.layer)));
});

it.effect("asks for a code to paste without a callback, and reports a refused code", () => {
  const fake = setup(() => new Response("Invalid code or code_verifier", { status: 403 }));
  return Effect.gen(function* () {
    const signIn = yield* OpenRouterSignIn.OpenRouterSignIn;
    const { authorizationUrl, state } = yield* signIn.start({ callbackUrl: null, label: "T3" });
    expect(new URL(authorizationUrl).searchParams.has("callback_url")).toBe(false);
    const refused = yield* signIn.finish(state, "typo").pipe(Effect.flip);
    expect(refused.reason).toBe("rejected");
    expect(yield* signIn.status(state)).toBe("rejected");
    expect(yield* signIn.status("never-started")).toBe("expired");
    expect(fake.setKey).not.toHaveBeenCalled();
    expect((yield* signIn.finish("never-started", "code").pipe(Effect.flip)).reason).toBe(
      "expired",
    );
  }).pipe(Effect.provide(fake.layer));
});
