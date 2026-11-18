import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ComputerAnswer, ComputerQuestions } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as ComputerDecider from "./ComputerDecider.ts";

const questions: ComputerQuestions = {
  next: {
    type: "choice",
    instructions: "What is the one next step toward the goal on this screen?",
    criteria: { c0: "Click the button “Search”", stuck: "None of these moves toward the goal." },
  },
  risky: {
    type: "noul",
    instructions: "Could this send something?",
  },
};

const deciderWith = (
  grounder: {
    readonly kind?: "jev" | "openai-compatible" | "systemone";
    readonly baseUrl?: string;
    readonly model?: string;
    readonly apiKey?: string;
  } | null,
) =>
  ComputerDecider.ComputerDecider.pipe(
    Effect.provide(
      ComputerDecider.layer.pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          ServerSettings.layerTest({
            computerGrounder:
              grounder === null
                ? null
                : {
                    kind: grounder.kind ?? "openai-compatible",
                    baseUrl: grounder.baseUrl ?? "https://api.test/v1",
                    model: grounder.model ?? "grounder",
                    apiKey: grounder.apiKey ?? "secret",
                  },
          }),
        ),
      ),
    ),
  );

const chatReply = (content: string) =>
  Response.json({ choices: [{ finish_reason: "stop", message: { content } }] });

it.effect("an OpenAI-compatible grounder answers with the keys the question offered", () => {
  const seen: Array<{ url: string; body: unknown; auth: string | null }> = [];
  const upstream = async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    seen.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      auth: new Headers(init?.headers).get("authorization"),
    });
    return chatReply('{"next":{"choice":"c0","confidence":"high"}}');
  };
  return Effect.gen(function* () {
    const decider = yield* deciderWith({});
    const answer = yield* decider
      .ask({ state: { goal: "search" }, questions })
      .pipe(
        Effect.provideService(FetchHttpClient.Fetch, upstream),
        Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );

    assert.deepStrictEqual(answer, {
      _tag: "answers",
      answers: { next: { type: "choice", choice: "c0", probability: 0.9 } },
    });
    const request = seen[0]!;
    assert.strictEqual(request.url, "https://api.test/v1/chat/completions");
    assert.strictEqual(request.auth, "Bearer secret");
    const body = request.body as {
      model: string;
      temperature: number;
      response_format: { json_schema: { schema: { properties: Record<string, unknown> } } };
      messages: ReadonlyArray<{ content: string }>;
    };
    assert.strictEqual(body.model, "grounder");
    assert.strictEqual(body.temperature, 0);
    assert.deepStrictEqual(body.response_format.json_schema.schema.properties.next, {
      type: "object",
      properties: {
        choice: { type: "string", enum: ["c0", "stuck"] },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
      },
      required: ["choice", "confidence"],
      additionalProperties: false,
    });
    assert.match(body.messages[1]!.content, /c0: Click the button/);
  });
});

it.effect("a reply naming a key the question never offered is dropped", () => {
  const upstream = async () => chatReply('{"next":{"choice":"c99","confidence":"high"}}');
  return Effect.gen(function* () {
    const decider = yield* deciderWith({});
    const answer = yield* decider
      .ask({ state: { goal: "search" }, questions })
      .pipe(
        Effect.provideService(FetchHttpClient.Fetch, upstream),
        Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );
    assert.deepStrictEqual(answer, { _tag: "answers", answers: {} });
  });
});

it.effect("a System One grounder reads its own answer shape", () => {
  const seen: Array<{ url: string; body: unknown }> = [];
  const upstream = async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({
      model: "jev-1",
      answers: {
        next: { type: "choice", choice: "stuck", confidence: 0.6 },
        risky: { type: "noul", noul: 0.8 },
      },
    });
  };
  return Effect.gen(function* () {
    const decider = yield* deciderWith({ kind: "systemone", baseUrl: "https://jev.test" });
    const answer = yield* decider
      .ask({ state: { goal: "search" }, questions })
      .pipe(
        Effect.provideService(FetchHttpClient.Fetch, upstream),
        Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );

    assert.deepStrictEqual(answer, {
      _tag: "answers",
      answers: {
        next: { type: "choice", choice: "stuck", probability: 0.6 },
        risky: { type: "noul", probability: 0.8 },
      },
    });
    assert.strictEqual(seen[0]!.url, "https://jev.test/v1/systemone");
    const body = seen[0]!.body as {
      model: string;
      state: unknown;
      questions: Record<string, unknown>;
    };
    assert.strictEqual(body.model, "grounder");
    assert.deepStrictEqual(body.state, { goal: "search" });
    assert.deepStrictEqual(body.questions.next, {
      type: "choice",
      instructions: "What is the one next step toward the goal on this screen?",
      criteria: { c0: "Click the button “Search”", stuck: "None of these moves toward the goal." },
    });
  });
});

it.effect("a key on the Jev preset sends the step to TypeSafe's System One endpoint", () => {
  const seen: Array<{ url: string; body: unknown; auth: string | null }> = [];
  const upstream = async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    seen.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      auth: new Headers(init?.headers).get("authorization"),
    });
    return Response.json({
      model: "jev-1.14.0",
      answers: {
        next: { type: "choice", choice: "c0", confidence: 1, probabilities: { c0: 1, stuck: 0 } },
      },
    });
  };
  return Effect.gen(function* () {
    const decider = yield* deciderWith({
      kind: "jev",
      baseUrl: "",
      model: "",
      apiKey: "jev_key",
    });
    const answer = yield* decider
      .ask({ state: { goal: "search" }, questions })
      .pipe(
        Effect.provideService(FetchHttpClient.Fetch, upstream),
        Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );

    assert.deepStrictEqual(answer, {
      _tag: "answers",
      answers: { next: { type: "choice", choice: "c0", probability: 1 } },
    });
    const request = seen[0]!;
    assert.strictEqual(request.url, "https://api.typesafe.ai/v1/systemone");
    assert.strictEqual((request.body as { model: string }).model, "jev-latest");
    assert.strictEqual(request.auth, "Bearer jev_key");
  });
});

it.effect("the Jev preset without a key leaves the step to the planner", () => {
  const upstream = async () => {
    throw new Error("no request expected");
  };
  return Effect.gen(function* () {
    const decider = yield* deciderWith({ kind: "jev", baseUrl: "", model: "", apiKey: "" });
    assert.deepStrictEqual(
      yield* decider
        .ask({ state: {}, questions })
        .pipe(
          Effect.provideService(FetchHttpClient.Fetch, upstream),
          Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      { _tag: "not_configured" },
    );
  });
});

it.effect("a custom endpoint answers without a key, as a local model needs none", () => {
  const seen: Array<string | null> = [];
  const upstream = async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("authorization"));
    return Response.json({ answers: { next: { type: "choice", choice: "c0", confidence: 1 } } });
  };
  return Effect.gen(function* () {
    const decider = yield* deciderWith({
      kind: "systemone",
      baseUrl: "http://localhost:11434",
      apiKey: "",
    });
    const answer = yield* decider
      .ask({ state: {}, questions })
      .pipe(
        Effect.provideService(FetchHttpClient.Fetch, upstream),
        Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );
    assert.strictEqual(answer._tag, "answers");
    assert.deepStrictEqual(seen, [null]);
  });
});

it.effect("with no grounder configured there is nothing to ask", () => {
  const upstream = async () => {
    throw new Error("no request expected");
  };
  return Effect.gen(function* () {
    const decider = yield* deciderWith(null);
    assert.deepStrictEqual(
      yield* decider
        .ask({ state: {}, questions })
        .pipe(
          Effect.provideService(FetchHttpClient.Fetch, upstream),
          Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      { _tag: "not_configured" },
    );
  });
});

it.effect("a grounder that fails is reported so the task can fall back", () => {
  const upstream = async () => Response.json({ error: { message: "busy" } }, { status: 503 });
  return Effect.gen(function* () {
    const decider = yield* deciderWith({});
    const answer = yield* decider
      .ask({ state: {}, questions })
      .pipe(
        Effect.provideService(FetchHttpClient.Fetch, upstream),
        Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );
    assert.strictEqual(answer._tag, "failed");
    if (answer._tag === "failed") assert.match(answer.detail, /HTTP 503/);
  });
});

it.effect(
  "a grounder silent for ten seconds is reported failed, so the step goes to the planner",
  () => {
    const upstream = () => new Promise<Response>(() => {});
    return Effect.gen(function* () {
      const decider = yield* deciderWith({});
      const asked = yield* decider
        .ask({ state: {}, questions })
        .pipe(
          Effect.provideService(FetchHttpClient.Fetch, upstream),
          Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          Effect.forkScoped,
        );
      yield* TestClock.adjust("10 seconds");
      assert.deepStrictEqual(yield* Fiber.join(asked), {
        _tag: "failed",
        detail: "The decision model did not answer in time.",
      });
    });
  },
);

it.effect(
  "answers are checked again: wrong kind, duplicate, unknown question and out of range",
  () =>
    Effect.sync(() => {
      const raw: Record<string, ComputerAnswer> = {
        next: { type: "choice", choice: "c0", probability: 0.8 },
        risky: { type: "choice", choice: "c0", probability: 0.5 },
        other: { type: "noul", probability: 0.5 },
        stuck: { type: "noul", probability: 1.5 },
      };
      assert.deepStrictEqual(ComputerDecider.keepValid(questions, raw), {
        next: { type: "choice", choice: "c0", probability: 0.8 },
      });
      assert.deepStrictEqual(
        ComputerDecider.keepValid(questions, {
          next: { type: "choice", choice: "stuck", probability: 1.2 },
        }),
        {},
      );
    }),
);
