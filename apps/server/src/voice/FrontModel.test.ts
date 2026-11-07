import * as NodeServices from "@effect/platform-node/NodeServices";
import type { VoiceFrontModel } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { vi } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import * as SpeechModelStore from "../speech/SpeechModelStore.ts";
import * as FrontModel from "./FrontModel.ts";
import type { FrontLlama } from "./llama.ts";

const store = Layer.succeed(
  SpeechModelStore.SpeechModelStore,
  SpeechModelStore.SpeechModelStore.of({
    isReady: () => Effect.succeed(true),
    installedPath: () => Effect.undefined,
    download: (file) => Effect.succeed(`/models/${file.filename}`),
    remove: () => Effect.void,
  }),
);

const services = (voiceFrontModel: VoiceFrontModel) =>
  Layer.mergeAll(
    store,
    NodeServices.layer,
    FetchHttpClient.layer,
    ServerSettings.ServerSettingsService.layerTest({ voiceFrontModel }),
  );

const messages = [
  { role: "system", content: "You are the voice." },
  { role: "user", content: "run the test" },
] as const;

it.effect("loads a managed model once per call and unloads it after idling", () => {
  const loads: string[] = [];
  let disposed = 0;
  const replies = [
    `{"action":"delegate","speech":" On it. ","task":"Run the tests."}`,
    `{"action":"none","speech":"mm-hm","task":"None."}`,
    `{"action":"reply"`,
  ];
  const load = async (path: string): Promise<FrontLlama> => {
    loads.push(path);
    return {
      gpu: "cpu",
      decide: async () => replies.shift()!,
      dispose: async () => void (disposed += 1),
    };
  };
  return Effect.gen(function* () {
    const front = yield* FrontModel.make(load);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* front.acquire;
        expect(yield* session.decide(messages)).toEqual({
          action: "delegate",
          speech: "On it.",
          task: "Run the tests.",
        });
        expect(yield* session.decide(messages)).toEqual({ action: "none", speech: "" });
        const error = yield* Effect.flip(session.decide(messages));
        expect(error.message).toContain("was not a decision");
      }),
    );
    yield* Effect.scoped(front.acquire);
    expect(loads).toEqual(["/models/Qwen3-1.7B-Q4_K_M.gguf"]);
    yield* TestClock.adjust("5 minutes");
    expect(disposed).toBe(1);
  }).pipe(Effect.provide(services("unsloth/Qwen3-1.7B-GGUF")));
});

it.effect("rejects a model id outside the catalog", () =>
  Effect.gen(function* () {
    const front = yield* FrontModel.make(() => Promise.reject(new Error("unreachable")));
    const error = yield* Effect.flip(Effect.scoped(front.acquire));
    expect(error.message).toContain('Unknown front model "someone/else"');
  }).pipe(Effect.provide(services("someone/else"))),
);

const endpoint = { url: "http://127.0.0.1:8080/v1/", model: "qwen" };
const completion = (content: string) =>
  Response.json({ choices: [{ message: { role: "assistant", content } }] });

it.effect("sends the conversation to an OpenAI-compatible server under the decision schema", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async () =>
      completion(`{"action":"reply","speech":"Hi there.","task":""}`),
    );
    const front = yield* FrontModel.make();
    const decision = yield* Effect.scoped(
      Effect.flatMap(front.acquire, (session) => session.decide(messages)),
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    expect(decision).toEqual({ action: "reply", speech: "Hi there." });
    const [url, init] = upstream.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:8080/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: "qwen", messages, temperature: 0 });
    expect(body.response_format.json_schema.schema.required).toEqual(["action", "speech", "task"]);
  }).pipe(Effect.provide(services(endpoint))),
);

it.effect.each([
  [
    "a failed request",
    async () => new Response("model not loaded", { status: 503 }),
    "answered 503: model not loaded",
  ],
  [
    "a reply outside the schema",
    async () => completion("Sure, on it!"),
    'Model "qwen" ignored the decision schema',
  ],
  [
    "a body that is not a completion",
    async () => Response.json({ error: "nope" }),
    "did not return a chat completion",
  ],
] as const)("explains %s from the server", ([, reply, message]) =>
  Effect.gen(function* () {
    const front = yield* FrontModel.make();
    const error = yield* Effect.flip(
      Effect.scoped(Effect.flatMap(front.acquire, (session) => session.decide(messages))),
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, vi.fn<typeof fetch>(reply)));
    expect(error._tag).toBe("FrontModelError");
    expect(error.message).toContain(message);
  }).pipe(Effect.provide(services(endpoint))),
);

it.effect("interrupting a decision aborts the request", () =>
  Effect.gen(function* () {
    const aborted = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const upstream = vi.fn<typeof fetch>(
      (_, init) =>
        new Promise((_resolve, reject) => {
          started.resolve();
          init?.signal?.addEventListener("abort", () => {
            aborted.resolve();
            reject(init.signal?.reason);
          });
        }),
    );
    const front = yield* FrontModel.make();
    const fiber = yield* Effect.scoped(
      Effect.flatMap(front.acquire, (session) => session.decide(messages)),
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, upstream), Effect.forkChild);
    yield* Effect.promise(() => started.promise);
    yield* Fiber.interrupt(fiber);
    yield* Effect.promise(() => aborted.promise);
  }).pipe(Effect.provide(services(endpoint))),
);
