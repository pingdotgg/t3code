import { makeLanguageModel } from "@alchemy.run/cloudflare/AI/LanguageModel";
/// <reference types="@cloudflare/workers-types" />
import { describe, expect, test } from "@alchemy.run/test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { LanguageModel, Tool, Toolkit } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const tags = ["unit", "provider:cloudflare", "provider:cloudflare:ai", "local"];

interface WireTool {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}
interface WireBody {
  messages: Array<{ role: string; content: unknown }>;
  tools?: WireTool[];
  tool_choice?: string;
  stream?: boolean;
}

// Capture requests at the public adapter boundary, including the real Effect
// prompt/tool preparation. A fresh response is required for every invocation.
const capture = (onRequest?: (body: WireBody, index: number) => void) => {
  const requests: WireBody[] = [];
  const ai = {
    run: async (_model: string, input: unknown) => {
      const body = input as WireBody;
      requests.push(structuredClone(body));
      onRequest?.(body, requests.length - 1);
      return body.stream
        ? new Response('data: {"response":"ok"}\n\ndata: [DONE]\n\n')
        : Response.json({ response: "ok" });
    },
  } as unknown as Ai;
  return {
    requests,
    layer: Layer.effect(
      LanguageModel.LanguageModel,
      makeLanguageModel({
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        client: { raw: Effect.succeed(ai) },
      }),
    ).pipe(Layer.provide(RuntimeContext.phantom)),
  };
};

describe("Workers AI request preparation", () => {
  for (const native of [true, false]) {
    test.effect(
      `${native ? "native" : "fallback"} image encoding preserves offsets, all bytes and padding`,
      () => {
        const { requests, layer } = capture();
        return Effect.gen(function* () {
          const storage = new Uint8Array(264).fill(42);
          for (let i = 0; i < 256; i++) storage[i + 4] = i;
          const inputs = [
            new Uint8Array(),
            new Uint8Array([255]),
            new Uint8Array([255, 254]),
            new Uint8Array([255, 254, 253]),
            storage.subarray(4, 260),
          ];
          let nativeCalls = 0;
          for (const data of inputs) {
            // Shadow the capability on this fixture only. Never mutate the shared
            // prototype: unrelated tests may encode bytes concurrently.
            Object.defineProperty(data, "toBase64", {
              value: native
                ? function (this: Uint8Array) {
                    expect(this).toBe(data);
                    nativeCalls++;
                    return btoa(String.fromCharCode(...this));
                  }
                : undefined,
            });
            yield* LanguageModel.generateText({
              prompt: [{ role: "user", content: [{ type: "file", mediaType: "image/png", data }] }],
            });
          }
          expect(requests.map((request) => request.messages[0]?.content)).toEqual(
            inputs.map((data) => [
              {
                type: "image_url",
                image_url: {
                  // Independent web encoder; neither branch requires node:buffer.
                  url: `data:image/png;base64,${btoa(String.fromCharCode(...data))}`,
                },
              },
            ]),
          );
          expect(Array.from(storage.subarray(0, 4))).toEqual([42, 42, 42, 42]);
          expect(Array.from(storage.subarray(260))).toEqual([42, 42, 42, 42]);
          expect(nativeCalls).toBe(native ? inputs.length : 0);
        }).pipe(Effect.provide(layer));
      },
      { tags },
    );
  }

  test.effect(
    "schemas preserve Unicode, transforms and all tool choices",
    () => {
      const primary = Tool.make("primary", {
        description: "Météo 東京 🌦️",
        parameters: Schema.Struct({
          count: Schema.NumberFromString,
          city: Schema.String.annotate({ description: "São Paulo / 東京" }),
        }),
      });
      const secondary = Tool.make("secondary", {
        parameters: Schema.Struct({ yes: Schema.Boolean }),
      });
      const toolkit = Toolkit.make(primary, secondary);
      const handlers = toolkit.toLayer({
        primary: () => Effect.void,
        secondary: () => Effect.void,
      });
      const { requests, layer } = capture();
      return Effect.gen(function* () {
        for (const toolChoice of [
          "auto",
          "none",
          "required",
          { tool: "primary" },
          { oneOf: ["secondary"], mode: "auto" },
          { oneOf: ["primary"], mode: "required" },
        ] as const) {
          yield* LanguageModel.generateText({ prompt: "hi", toolkit, toolChoice });
        }
        // Exercise the same cached preparation through the streaming entrypoint.
        yield* LanguageModel.streamText({ prompt: "hi", toolkit, toolChoice: "auto" }).pipe(
          Stream.runDrain,
        );
        expect(requests.map((r) => r.tool_choice)).toEqual([
          "auto",
          "none",
          "required",
          "required",
          "auto",
          "required",
          "auto",
        ]);
        expect(requests.map((r) => r.tools?.map((t) => t.function.name))).toEqual([
          ["primary", "secondary"],
          ["primary", "secondary"],
          ["primary", "secondary"],
          ["primary"],
          ["secondary"],
          ["primary"],
          ["primary", "secondary"],
        ]);
        for (const request of requests) {
          for (const tool of request.tools ?? []) {
            if (tool.function.name === "primary") {
              expect(tool.function.description).toBe("Météo 東京 🌦️");
              expect(tool.function.parameters).toMatchObject({
                properties: {
                  count: { type: "string" },
                  city: { type: "string", description: "São Paulo / 東京" },
                },
              });
            }
          }
        }
      }).pipe(Effect.provide(handlers), Effect.provide(layer));
    },
    { tags },
  );

  test.effect(
    "schema replacement and metadata updates cannot reuse stale preparation",
    () => {
      const tool = Tool.make("mutable", {
        description: "before",
        parameters: Schema.Struct({ old: Schema.String }),
      });
      const toolkit = Toolkit.make(tool);
      const handlers = toolkit.toLayer({ mutable: () => Effect.void });
      const { requests, layer } = capture();
      return Effect.gen(function* () {
        yield* LanguageModel.generateText({ prompt: "hi", toolkit });
        // JS consumers can replace readonly fields despite the TS contract.
        Object.assign(tool, {
          description: "after",
          parametersSchema: Schema.Struct({ next: Schema.Boolean }),
        });
        yield* LanguageModel.generateText({ prompt: "hi", toolkit });
        expect(requests[0]?.tools?.[0]?.function).toMatchObject({
          description: "before",
          parameters: { properties: { old: { type: "string" } } },
        });
        expect(requests[1]?.tools?.[0]?.function).toMatchObject({
          description: "after",
          parameters: { properties: { next: { type: "boolean" } } },
        });
        expect(requests[1]?.tools?.[0]?.function.parameters.properties).not.toHaveProperty("old");
      }).pipe(Effect.provide(handlers), Effect.provide(layer));
    },
    { tags },
  );

  test.effect(
    "public setParameters clones prepare their new schema",
    () => {
      const first = Tool.make("replace", { parameters: Schema.Struct({ old: Schema.String }) });
      const next = first.setParameters(Schema.Struct({ next: Schema.Boolean }));
      const oldToolkit = Toolkit.make(first);
      const nextToolkit = Toolkit.make(next);
      const { requests, layer } = capture();
      return Effect.gen(function* () {
        yield* LanguageModel.generateText({ prompt: "hi", toolkit: oldToolkit }).pipe(
          Effect.provide(oldToolkit.toLayer({ replace: () => Effect.void })),
        );
        yield* LanguageModel.generateText({ prompt: "hi", toolkit: nextToolkit }).pipe(
          Effect.provide(nextToolkit.toLayer({ replace: () => Effect.void })),
        );
        expect(requests[0]?.tools?.[0]?.function.parameters).toMatchObject({
          properties: { old: { type: "string" } },
        });
        expect(requests[1]?.tools?.[0]?.function.parameters).toMatchObject({
          properties: { next: { type: "boolean" } },
        });
      }).pipe(Effect.provide(layer));
    },
    { tags },
  );

  test.effect(
    "dynamic caller-owned JSON schemas remain live after nested mutation",
    () => {
      const parameters = {
        type: "object" as const,
        properties: { value: { type: "string" as "string" | "number" } },
      };
      const dynamic = Tool.dynamic("dynamic", { parameters });
      const toolkit = Toolkit.make(dynamic);
      const { requests, layer } = capture();
      return Effect.gen(function* () {
        yield* LanguageModel.generateText({ prompt: "hi", toolkit });
        parameters.properties.value.type = "number";
        yield* LanguageModel.generateText({ prompt: "hi", toolkit });
        expect(requests[0]?.tools?.[0]?.function.parameters).toMatchObject({
          properties: { value: { type: "string" } },
        });
        expect(requests[1]?.tools?.[0]?.function.parameters).toMatchObject({
          properties: { value: { type: "number" } },
        });
      }).pipe(
        Effect.provide(toolkit.toLayer({ dynamic: () => Effect.void })),
        Effect.provide(layer),
      );
    },
    { tags },
  );

  test.effect(
    "a runtime client mutating one compiled request cannot poison later requests",
    () => {
      const tool = Tool.make("isolated", { parameters: Schema.Struct({ value: Schema.String }) });
      const toolkit = Toolkit.make(tool);
      const { requests, layer } = capture((request, index) => {
        if (index === 0) {
          const parameters = request.tools?.[0]?.function.parameters;
          if (parameters) {
            parameters.properties = {};
            parameters.description = "poisoned";
          }
        }
      });
      return Effect.gen(function* () {
        yield* LanguageModel.generateText({ prompt: "hi", toolkit });
        yield* LanguageModel.generateText({ prompt: "hi", toolkit });
        expect(requests[0]?.tools?.[0]?.function.parameters).toMatchObject({
          properties: { value: { type: "string" } },
        });
        expect(requests[1]?.tools?.[0]?.function.parameters).toEqual(
          requests[0]?.tools?.[0]?.function.parameters,
        );
      }).pipe(
        Effect.provide(toolkit.toLayer({ isolated: () => Effect.void })),
        Effect.provide(layer),
      );
    },
    { tags },
  );
});
