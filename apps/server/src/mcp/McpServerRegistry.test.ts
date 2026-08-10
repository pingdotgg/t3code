import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettingsModule from "../serverSettings.ts";
import * as McpServerRegistry from "./McpServerRegistry.ts";

const makeRegistryLayer = () =>
  McpServerRegistry.layer.pipe(Layer.provide(ServerSettingsModule.layerTest()));

it.effect("upserts, lists, and removes MCP servers", () =>
  Effect.gen(function* () {
    const registry = yield* McpServerRegistry.McpServerRegistry;

    const created = yield* registry.upsert({
      config: {
        name: "My Server",
        enabled: true,
        transport: { type: "http", url: "https://example.com/mcp" },
      },
    });
    assert.equal(created.config.name, "My Server");

    const listed = yield* registry.list;
    assert.equal(listed.servers.length, 1);
    assert.equal(listed.servers[0]?.id, created.id);

    yield* registry.remove({ id: created.id });
    const afterRemove = yield* registry.list;
    assert.equal(afterRemove.servers.length, 0);
  }).pipe(Effect.provide(makeRegistryLayer())),
);

it.effect("testConnection fails clearly when neither id nor config is given", () =>
  Effect.gen(function* () {
    const registry = yield* McpServerRegistry.McpServerRegistry;
    const result = yield* Effect.exit(registry.testConnection({}));
    assert.equal(result._tag, "Failure");
  }).pipe(Effect.provide(makeRegistryLayer())),
);

it.effect("testConnection reports an error result for an unreachable server", () =>
  Effect.gen(function* () {
    const registry = yield* McpServerRegistry.McpServerRegistry;
    const result = yield* registry.testConnection({
      config: {
        name: "Unreachable",
        enabled: true,
        transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
      },
    });
    assert.equal(result.status, "error");
  }).pipe(Effect.provide(makeRegistryLayer())),
);
