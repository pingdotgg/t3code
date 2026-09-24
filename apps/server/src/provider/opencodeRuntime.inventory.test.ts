import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { HostProcessExecutablePath } from "@t3tools/shared/hostProcess";

import { OpenCodeRuntime, OpenCodeRuntimeLive } from "./opencodeRuntime.ts";

const testLayer = OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer));

it.layer(testLayer)("OpenCodeRuntime inventory", (it) => {
  it.effect("aborts pending SDK requests when inventory loading is interrupted", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const started = yield* Queue.make<void>();
      const aborted = yield* Queue.make<string>();
      const client = OpenCode.make({
        baseUrl: "http://opencode.test",
        fetch: Object.assign(
          (input: string | Request | URL, init?: RequestInit) => {
            const request = new Request(input, init);
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

      const inventoryFiber = yield* runtime
        .loadOpenCodeInventory(client, "/workspace/project")
        .pipe(Effect.forkChild);
      yield* Queue.takeN(started, 5);
      yield* Fiber.interrupt(inventoryFiber);

      NodeAssert.deepEqual((yield* Queue.takeAll(aborted)).toSorted(), [
        "/api/agent",
        "/api/command",
        "/api/model",
        "/api/provider",
        "/api/skill",
      ]);
    }),
  );

  it.effect("discovers directory-scoped commands without retaining prompt templates", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const requests: Request[] = [];
      const client = OpenCode.make({
        baseUrl: "http://opencode.test",
        fetch: Object.assign(
          async (input: string | Request | URL, init?: RequestInit) => {
            const request = new Request(input, init);
            requests.push(request);
            const route = new URL(request.url).pathname;
            return Response.json({
              location: { directory: "/workspace/project" },
              data:
                route === "/api/command" ? [{ name: "review", description: "Review changes" }] : [],
            });
          },
          { preconnect: () => undefined },
        ),
      });
      const inventory = yield* runtime.loadOpenCodeInventory(client, "/workspace/project");
      NodeAssert.deepEqual(inventory.commands, [
        {
          name: "review",
          description: "Review changes",
        },
      ]);
      const commandRequest = requests.find(
        (request) => new URL(request.url).pathname === "/api/command",
      );
      NodeAssert.ok(commandRequest);
      NodeAssert.equal(
        new URL(commandRequest.url).searchParams.get("location[directory]"),
        "/workspace/project",
      );
    }),
  );

  it.effect("keeps provider inventory when agent discovery fails", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const client = {
        provider: {
          list: () =>
            Promise.resolve({
              data: [{ id: "openai" }],
            }),
        },
        model: { list: () => Promise.resolve({ data: [] }) },
        agent: { list: () => Promise.reject(new Error("agents endpoint unavailable")) },
        skill: { list: () => Promise.resolve({ data: [] }) },
      } as unknown as OpenCodeClient;

      const inventory = yield* runtime.loadOpenCodeInventory(client, "/workspace/project");

      NodeAssert.deepEqual(
        inventory.providers.map((provider) => provider.id),
        ["openai"],
      );
      NodeAssert.deepEqual(inventory.agents, []);
      NodeAssert.deepEqual(inventory.skills, []);
    }),
  );

  it.effect("keeps provider inventory when skill discovery fails", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const client = {
        provider: {
          list: () =>
            Promise.resolve({
              data: [{ id: "openai" }],
            }),
        },
        model: { list: () => Promise.resolve({ data: [] }) },
        agent: { list: () => Promise.resolve({ data: [] }) },
        skill: { list: () => Promise.reject(new Error("skills endpoint unavailable")) },
      } as unknown as OpenCodeClient;

      const inventory = yield* runtime.loadOpenCodeInventory(client, "/workspace/project");

      NodeAssert.deepEqual(
        inventory.providers.map((provider) => provider.id),
        ["openai"],
      );
      NodeAssert.deepEqual(inventory.agents, []);
      NodeAssert.deepEqual(inventory.skills, []);
    }),
  );

  it.effect("keeps only SDK skill metadata in inventory", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const client = {
        provider: {
          list: () =>
            Promise.resolve({
              data: [{ id: "openai" }],
            }),
        },
        model: { list: () => Promise.resolve({ data: [] }) },
        agent: { list: () => Promise.resolve({ data: [] }) },
        skill: {
          list: () =>
            Promise.resolve({
              data: [
                {
                  name: "review",
                  description: "Review code changes",
                  path: "/skills/review/SKILL.md",
                },
              ],
            }),
        },
      } as unknown as OpenCodeClient;

      const inventory = yield* runtime.loadOpenCodeInventory(client, "/workspace/project");

      NodeAssert.deepEqual(inventory.skills, [
        {
          name: "review",
          description: "Review code changes",
          path: "/skills/review/SKILL.md",
        },
      ]);
    }),
  );

  it.effect("caps and drains command stdout and stderr when requested", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const executablePath = yield* HostProcessExecutablePath;
      const outputBytes = 2 * 1024 * 1024;
      const result = yield* runtime.runOpenCodeCommand({
        binaryPath: executablePath,
        args: [
          "-e",
          `process.stdout.write("o".repeat(${outputBytes})); process.stderr.write("e".repeat(${outputBytes}));`,
        ],
        maxOutputBytes: 64,
      });

      NodeAssert.equal(result.stdout, "o".repeat(64));
      NodeAssert.equal(result.stderr, "e".repeat(64));
      NodeAssert.equal(result.code, 0);
    }),
  );
});
