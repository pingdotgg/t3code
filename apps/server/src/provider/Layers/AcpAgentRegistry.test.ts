import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import { AcpAgentRegistryLive } from "./AcpAgentRegistry.ts";
import { AcpAgentRegistry } from "../Services/AcpAgentRegistry.ts";

const settingsLayer = Layer.mock(ServerSettingsService)({
  start: Effect.void,
  ready: Effect.void,
  getSettings: Effect.succeed({
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      acp: {
        ...DEFAULT_SERVER_SETTINGS.providers.acp,
        agentServers: [
          {
            id: "node-agent",
            name: "Node Agent",
            enabled: true,
            source: "manual",
            distributionType: "manual",
            launch: {
              command: process.execPath,
              args: [],
            },
          },
          {
            id: "missing-agent",
            name: "Missing Agent",
            enabled: true,
            source: "manual",
            distributionType: "manual",
            launch: {
              command: "t3-code-missing-acp-agent",
              args: [],
            },
          },
        ],
      },
    },
  }),
  updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
  streamChanges: Stream.empty,
});

const testLayer = AcpAgentRegistryLive.pipe(Layer.provide(settingsLayer));

it.effect("reports installed and missing ACP agent commands", () =>
  Effect.gen(function* () {
    const registry = yield* AcpAgentRegistry;
    const statuses = yield* registry.listStatuses;

    const installed = statuses.find((status) => status.agentServerId === "node-agent");
    const missing = statuses.find((status) => status.agentServerId === "missing-agent");

    assert.equal(installed?.status, "ready");
    assert.equal(installed?.installed, true);
    assert.equal(missing?.status, "error");
    assert.equal(missing?.installed, false);
    assert.match(missing?.message ?? "", /not found/);
  }).pipe(Effect.provide(testLayer)),
);
