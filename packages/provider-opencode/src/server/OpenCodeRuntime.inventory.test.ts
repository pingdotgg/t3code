import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerLedger from "./OpenCodeServerLedger.ts";

const layerTest = OpenCodeRuntime.layer.pipe(
  Layer.provide(OpenCodeServerLedger.layerTest),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layerTest)("OpenCodeRuntime inventory", (it) => {
  it.effect("aborts pending SDK requests when inventory loading is interrupted", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
      const started = yield* Queue.make<void>();
      const aborted = yield* Queue.make<string>();
      const client = createOpencodeClient({
        baseUrl: "http://opencode.test",
        fetch: Object.assign(
          (input: string | Request | URL) => {
            const request = input instanceof Request ? input : new Request(input.toString());
            return new Promise<Response>((_resolve, reject) => {
              request.signal.addEventListener(
                "abort",
                () => {
                  Queue.offerUnsafe(aborted, new URL(request.url).pathname);
                  reject(request.signal.reason);
                },
                { once: true },
              );
              Queue.offerUnsafe(started, undefined);
            });
          },
          { preconnect: () => undefined },
        ),
      });

      const inventoryFiber = yield* runtime.loadOpenCodeInventory(client).pipe(Effect.forkChild);
      yield* Queue.takeN(started, 4);
      yield* Fiber.interrupt(inventoryFiber);

      NodeAssert.deepEqual((yield* Queue.takeAll(aborted)).toSorted(), [
        "/agent",
        "/command",
        "/provider",
        "/skill",
      ]);
    }),
  );

  it.effect("discovers directory-scoped commands without retaining prompt templates", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
      const requests: Request[] = [];
      const client = createOpencodeClient({
        baseUrl: "http://opencode.test",
        directory: "/workspace/project",
        fetch: Object.assign(
          async (input: string | Request | URL) => {
            const request = input instanceof Request ? input : new Request(input.toString());
            requests.push(request);
            const route = new URL(request.url).pathname;
            return Response.json(
              route === "/provider"
                ? { connected: ["openai"], all: [], default: {} }
                : route === "/command"
                  ? [
                      {
                        name: "review",
                        description: "Review changes",
                        source: "command",
                        hints: ["$ARGUMENTS"],
                        template: "private native template",
                      },
                    ]
                  : [],
            );
          },
          { preconnect: () => undefined },
        ),
      });
      const inventory = yield* runtime.loadOpenCodeInventory(client);
      NodeAssert.deepEqual(inventory.commands, [
        {
          name: "review",
          description: "Review changes",
          source: "command",
          hints: ["$ARGUMENTS"],
        },
      ]);
      const commandRequest = requests.find(
        (request) => new URL(request.url).pathname === "/command",
      );
      NodeAssert.ok(commandRequest);
      NodeAssert.equal(
        new URL(commandRequest.url).searchParams.get("directory") ??
          decodeURIComponent(commandRequest.headers.get("x-opencode-directory") ?? ""),
        "/workspace/project",
      );
    }),
  );

  it.effect("keeps provider inventory when agent discovery fails", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
      const client = {
        provider: {
          list: () =>
            Promise.resolve({
              data: {
                connected: ["openai"],
                all: [],
                default: {},
              },
            }),
        },
        app: {
          agents: () => Promise.reject(new Error("agents endpoint unavailable")),
          skills: () => Promise.resolve({ data: [] }),
        },
      } as unknown as OpencodeClient;

      const inventory = yield* runtime.loadOpenCodeInventory(client);

      NodeAssert.deepEqual(inventory.providerList.connected, ["openai"]);
      NodeAssert.deepEqual(inventory.agents, []);
      NodeAssert.deepEqual(inventory.skills, []);
    }),
  );
});
