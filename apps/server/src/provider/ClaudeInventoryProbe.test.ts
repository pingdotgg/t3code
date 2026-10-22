import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { vi } from "vite-plus/test";

import { probeClaudeInventory } from "./ClaudeProvider.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const settings = Schema.decodeSync(ClaudeSettings)({});

it.effect("can refresh Claude inventory repeatedly and closes each probe", () =>
  Effect.gen(function* () {
    const controllers: Array<AbortController> = [];
    using query = vi.spyOn(ClaudeSdk, "query").mockImplementation((input) => {
      const controller = input.options!.abortController!;
      assert.isFalse(controller.signal.aborted);
      controllers.push(controller);
      return {
        initializationResult: async () => ({}),
        mcpServerStatus: async () => [],
        reloadPlugins: async () => ({ plugins: [] }),
        reloadSkills: async () => ({ skills: [{ name: "pdf", description: "Read PDFs" }] }),
      } as unknown as ReturnType<typeof ClaudeSdk.query>;
    });

    const probe = probeClaudeInventory(settings, {}, "/inventory-test");
    const first = yield* probe;
    const second = yield* probe;

    assert.deepStrictEqual(first, second);
    assert.deepStrictEqual(first.skills, {
      _tag: "Listed",
      canDisable: true,
      items: [{ id: "pdf", name: "pdf", description: "Read PDFs" }],
    });
    assert.strictEqual(query.mock.calls.length, 2);
    assert.notStrictEqual(controllers[0], controllers[1]);
    assert.isTrue(controllers.every((controller) => controller.signal.aborted));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("closes a Claude inventory probe if initialization fails", () =>
  Effect.gen(function* () {
    let controller: AbortController | undefined;
    using _query = vi.spyOn(ClaudeSdk, "query").mockImplementation((input) => {
      controller = input.options!.abortController!;
      return {
        initializationResult: async () => {
          throw new Error("Initialization failed");
        },
      } as unknown as ReturnType<typeof ClaudeSdk.query>;
    });

    const result = yield* probeClaudeInventory(settings, {}, "/inventory-test").pipe(Effect.exit);

    assert.isTrue(Exit.isFailure(result));
    assert.isTrue(controller?.signal.aborted);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["servers", "plugins", "skills"] as const)(
  "preserves other Claude inventory sections when %s fail",
  (failedPart) =>
    Effect.gen(function* () {
      let controller: AbortController | undefined;
      using _query = vi.spyOn(ClaudeSdk, "query").mockImplementation((input) => {
        controller = input.options!.abortController!;
        const read = <A>(part: typeof failedPart, value: A) =>
          part === failedPart
            ? Promise.reject(new Error("Private provider diagnostic"))
            : Promise.resolve(value);
        return {
          initializationResult: async () => ({}),
          mcpServerStatus: () =>
            read("servers", [
              { name: "claude.ai Gmail", source: "claudeai", status: "connected" },
              { name: "github", source: "user", status: "connected" },
            ]),
          reloadPlugins: () =>
            read("plugins", { plugins: [{ name: "design", source: "design@synced" }] }),
          reloadSkills: () =>
            read("skills", { skills: [{ name: "pdf", description: "Read PDFs" }] }),
        } as unknown as ReturnType<typeof ClaudeSdk.query>;
      });
      const inventory = yield* probeClaudeInventory(settings, {}, "/inventory-test");
      if (failedPart === "servers") {
        assert.deepEqual(inventory.connectors, {
          _tag: "Failed",
          message: "Claude could not list its MCP servers.",
        });
        assert.deepEqual(inventory.mcpServers, inventory.connectors);
      } else {
        assert.equal(inventory.connectors._tag, "Listed");
        if (inventory.connectors._tag === "Listed") {
          assert.deepEqual(
            inventory.connectors.items.map((item) => item.id),
            ["claude.ai Gmail"],
          );
        }
        assert.equal(inventory.mcpServers._tag, "Listed");
      }
      assert.equal(inventory.plugins._tag, failedPart === "plugins" ? "Failed" : "Listed");
      if (inventory.plugins._tag === "Listed") {
        assert.deepEqual(
          inventory.plugins.items.map((item) => item.id),
          ["design@synced"],
        );
      }
      assert.equal(inventory.skills._tag, failedPart === "skills" ? "Failed" : "Listed");
      if (inventory.skills._tag === "Listed") {
        assert.deepEqual(
          inventory.skills.items.map((item) => item.id),
          ["pdf"],
        );
        assert.equal(inventory.skills.canDisable, failedPart !== "plugins");
      }
      assert.isFalse(JSON.stringify(inventory).includes("Private provider diagnostic"));
      assert.isTrue(controller?.signal.aborted);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("preserves loaded Claude inventory when a plugin lookup never responds", () =>
  Effect.gen(function* () {
    const pluginsStarted = yield* Deferred.make<void>();
    let controller: AbortController | undefined;
    using _query = vi.spyOn(ClaudeSdk, "query").mockImplementation((input) => {
      controller = input.options!.abortController!;
      return {
        initializationResult: async () => ({}),
        mcpServerStatus: async () => [
          { name: "claude.ai Gmail", source: "claudeai", status: "connected" },
        ],
        reloadPlugins: () => {
          Deferred.doneUnsafe(pluginsStarted, Effect.void);
          return new Promise(() => {});
        },
        reloadSkills: async () => ({ skills: [{ name: "pdf", description: "Read PDFs" }] }),
      } as unknown as ReturnType<typeof ClaudeSdk.query>;
    });
    const fiber = yield* probeClaudeInventory(settings, {}, "/inventory-test").pipe(
      Effect.forkScoped,
    );
    yield* Deferred.await(pluginsStarted);
    yield* TestClock.adjust("4 seconds");
    assert.isDefined(fiber.pollUnsafe());
    const inventory = yield* Fiber.join(fiber);
    assert.equal(inventory.connectors._tag, "Listed");
    assert.deepEqual(inventory.plugins, {
      _tag: "Failed",
      message: "Claude could not list its plugins.",
    });
    assert.equal(inventory.skills._tag, "Listed");
    assert.isTrue(controller?.signal.aborted);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps the last Claude server listing when a later poll fails", () =>
  Effect.gen(function* () {
    const firstRead = yield* Deferred.make<void>();
    const servers = vi
      .fn()
      .mockImplementationOnce(() => {
        Deferred.doneUnsafe(firstRead, Effect.void);
        return Promise.resolve([
          { name: "claude.ai Gmail", source: "claudeai", status: "connected" },
          { name: "slow", source: "user", status: "pending" },
        ]);
      })
      .mockRejectedValue(new Error("Server disconnected"));
    using _query = vi.spyOn(ClaudeSdk, "query").mockReturnValue({
      initializationResult: async () => ({}),
      mcpServerStatus: servers,
      reloadPlugins: async () => ({ plugins: [] }),
      reloadSkills: async () => ({ skills: [] }),
    } as unknown as ReturnType<typeof ClaudeSdk.query>);

    const fiber = yield* probeClaudeInventory(settings, {}, "/inventory-test").pipe(
      Effect.forkScoped,
    );
    yield* Deferred.await(firstRead);
    yield* TestClock.adjust("250 millis");
    const inventory = yield* Fiber.join(fiber);
    assert.equal(inventory.connectors._tag, "Listed");
    if (inventory.connectors._tag === "Listed") {
      assert.deepEqual(
        inventory.connectors.items.map((item) => item.id),
        ["claude.ai Gmail"],
      );
    }
    assert.equal(inventory.mcpServers._tag, "Listed");
    if (inventory.mcpServers._tag === "Listed") {
      assert.equal(inventory.mcpServers.items[0]?.status, "pending");
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("finishes partial Claude inventory before the outer deadline after a slow startup", () =>
  Effect.gen(function* () {
    const initializationStarted = yield* Deferred.make<void>();
    const initialization = Promise.withResolvers<object>();
    const firstRead = yield* Deferred.make<void>();
    let controller: AbortController | undefined;
    const plugins = vi.fn(() => new Promise(() => {}));
    const skills = vi.fn(() => new Promise(() => {}));
    using _query = vi.spyOn(ClaudeSdk, "query").mockImplementation((input) => {
      controller = input.options!.abortController!;
      return {
        initializationResult: () => {
          Deferred.doneUnsafe(initializationStarted, Effect.void);
          return initialization.promise;
        },
        mcpServerStatus: () => {
          Deferred.doneUnsafe(firstRead, Effect.void);
          return Promise.resolve([
            { name: "claude.ai Gmail", source: "claudeai", status: "connected" },
            { name: "slow", source: "user", status: "pending" },
          ]);
        },
        reloadPlugins: plugins,
        reloadSkills: skills,
      } as unknown as ReturnType<typeof ClaudeSdk.query>;
    });

    const fiber = yield* probeClaudeInventory(settings, {}, "/inventory-test").pipe(
      Effect.forkScoped,
    );
    yield* Deferred.await(initializationStarted);
    yield* TestClock.adjust("9 seconds");
    initialization.resolve({});
    yield* Deferred.await(firstRead);
    yield* TestClock.adjust("15 seconds");
    assert.isDefined(fiber.pollUnsafe());
    const inventory = yield* Fiber.join(fiber);
    assert.equal(inventory.connectors._tag, "Listed");
    assert.equal(inventory.mcpServers._tag, "Listed");
    assert.equal(inventory.plugins._tag, "Failed");
    assert.equal(inventory.skills._tag, "Failed");
    assert.isTrue(controller?.signal.aborted);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("closes a Claude inventory probe when the request is cancelled", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let controller: AbortController | undefined;
    using _query = vi.spyOn(ClaudeSdk, "query").mockImplementation((input) => {
      controller = input.options!.abortController!;
      return {
        initializationResult: () => {
          Deferred.doneUnsafe(started, Effect.void);
          return new Promise(() => {});
        },
      } as unknown as ReturnType<typeof ClaudeSdk.query>;
    });

    const probe = yield* probeClaudeInventory(settings, {}, "/inventory-test").pipe(
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* Fiber.interrupt(probe);

    assert.isTrue(controller?.signal.aborted);
  }).pipe(Effect.provide(NodeServices.layer)),
);
