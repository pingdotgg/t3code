import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import * as OpenCode2Client from "./OpenCode2Client.ts";
import * as OpenCode2Server from "./OpenCode2Server.ts";
import * as TextGenerator from "./textGenerator.ts";

const make = Effect.fn("test.makeOpenCodeTextGenerator")(function* (http: HttpClient.HttpClient) {
  const opencode = yield* OpenCode2Client.make.pipe(
    Effect.provideService(HttpClient.HttpClient, http),
  );
  const connection = {
    ...(yield* opencode.connect({ baseUrl: "http://opencode.test", password: "password" })),
    url: "http://opencode.test",
    version: "2.2.5",
    external: false,
  };
  return yield* TextGenerator.make().pipe(
    Effect.provideService(OpenCode2Server.OpenCode2Server, {
      withConnection: (use) => use(connection),
    }),
  );
});

const input = {
  prompt: "Return only the cleaned transcript.",
  modelSelection: {
    instanceId: ProviderInstanceId.make("opencode-work"),
    model: "openai/gpt-6-luna",
    options: [{ id: "variant", value: "low" }],
  },
};

it.effect("generates raw text using the configured server authentication, model, and variant", () =>
  Effect.gen(function* () {
    const generate = yield* make(
      HttpClient.make((request) =>
        Effect.sync(() => {
          assert.equal(request.url, "http://opencode.test/api/experimental/generate/text");
          assert.equal(
            request.headers.authorization,
            `Basic ${Buffer.from("opencode:password").toString("base64")}`,
          );
          assert.equal(request.body._tag, "Uint8Array");
          if (request.body._tag === "Uint8Array")
            assert.deepEqual(JSON.parse(new TextDecoder().decode(request.body.body)), {
              prompt: input.prompt,
              model: { providerID: "openai", id: "gpt-6-luna", variant: "low" },
            });
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ data: { text: " Hello, world. " } }),
          );
        }),
      ),
    );
    assert.equal(yield* generate(input), "Hello, world.");
  }),
);

it.effect.each([401, 403, 404, 429, 503, "empty", "malformed"] as const)(
  "fails without creating an agent session when raw generation returns %s",
  (response) =>
    Effect.gen(function* () {
      const generate = yield* make(
        HttpClient.make((request) => {
          assert.equal(request.url, "http://opencode.test/api/experimental/generate/text");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                response === "empty"
                  ? { data: { text: "" } }
                  : response === "malformed"
                    ? { data: { text: 123 } }
                    : { message: "secret provider error" },
                { status: typeof response === "number" ? response : 200 },
              ),
            ),
          );
        }),
      );
      const failure = yield* generate(input).pipe(Effect.flip);
      assert.notInclude(failure.detail, "secret provider error");
      assert.equal(failure._tag, "TextGenerationError");
    }),
);

it.effect("cancels a stalled raw request without starting a session", () =>
  Effect.gen(function* () {
    const sent = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const generate = yield* make(
      HttpClient.make((request) => {
        assert.equal(request.url, "http://opencode.test/api/experimental/generate/text");
        return Deferred.succeed(sent, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(cancelled, undefined)),
        );
      }),
    );
    const running = yield* generate(input).pipe(Effect.flip, Effect.forkScoped);
    yield* Deferred.await(sent);
    yield* TestClock.adjust("2 minutes");
    assert.equal((yield* Fiber.join(running))._tag, "TextGenerationError");
    assert.isTrue(yield* Deferred.isDone(cancelled));
  }).pipe(Effect.scoped),
);
