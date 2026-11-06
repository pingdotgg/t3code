// @effect-diagnostics nodeBuiltinImport:off -- Driver tests probe a fake daemon over a real socket.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { agentOptionDescriptor, probeZeroClaw, ZeroClawDriver } from "./driver.ts";

interface DaemonState {
  agents: string[];
  failAgentDiscovery: boolean;
  onCatalogModels?: (reply: () => void) => void;
}

const withDaemon = <A, E, R>(
  use: (
    socketPath: string,
    initializeParams: unknown[],
    state: DaemonState,
  ) => Effect.Effect<A, E, R | import("effect/Scope").Scope>,
) =>
  Effect.gen(function* () {
    const initializeParams: unknown[] = [];
    const state: DaemonState = { agents: ["coder", "reviewer"], failAgentDiscovery: false };
    const dir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "zc-driver-")),
    );
    const dataDir = NodePath.join(dir, "data");
    yield* Effect.promise(() => NodeFSP.mkdir(dataDir));
    const socketPath = NodePath.join(dataDir, "daemon.sock");
    const server = NodeNet.createServer((socket) => {
      socket.on("error", () => {});
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (line.length === 0) continue;
          const frame = JSON.parse(line) as {
            id?: string;
            method?: string;
            params?: { model_provider?: string };
          };
          if (frame.id === undefined || frame.method === undefined) continue;
          if (frame.method === "initialize") initializeParams.push(frame.params);
          if (frame.method === "agents/list" && state.failAgentDiscovery) {
            socket.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: frame.id,
                error: { code: -32000, message: "Agent discovery failed" },
              })}\n`,
            );
            continue;
          }
          // Shapes match the daemon's snake_case serde output.
          const result =
            frame.method === "initialize"
              ? { protocol_version: 1, server_version: "0.4.0", server_pid: 1, commands: [] }
              : frame.method === "status"
                ? {
                    server_version: "0.4.0",
                    protocol_version: 1,
                    active_sessions: 0,
                    session_ids: [],
                  }
                : frame.method === "agents/list"
                  ? {
                      agents: state.agents.map((alias) => ({ alias, enabled: true, channels: [] })),
                    }
                  : frame.method === "config/catalog"
                    ? {
                        model_providers: [{ name: "openai", display_name: "OpenAI", local: false }],
                      }
                    : frame.method === "config/catalog-models"
                      ? {
                          model_provider: frame.params?.model_provider,
                          models: frame.params?.model_provider === "openai" ? ["gpt"] : [],
                          local: false,
                          live: false,
                        }
                      : {};
          const reply = () =>
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result })}\n`);
          if (frame.method === "config/catalog-models" && state.onCatalogModels) {
            state.onCatalogModels(reply);
          } else reply();
        }
      });
    });
    yield* Effect.callback<void>((resume) => {
      server.listen(socketPath, () => resume(Effect.void));
      return Effect.sync(() => server.close());
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => server.close()).pipe(
        Effect.andThen(Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }))),
        Effect.ignore,
      ),
    );
    return yield* use(socketPath, initializeParams, state);
  }).pipe(Effect.scoped);

describe("probeZeroClaw", () => {
  it.effect("preserves cached probe time and timestamps each disabled refresh", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(2_000);
      const cached = yield* probeZeroClaw({
        socketPath: "unused",
        instanceId: ProviderInstanceId.make("zc"),
        cache: { current: { at: 1_000, models: [], agents: [], version: "0.8.7" } },
      });
      expect(cached.checkedAt).toBe("1970-01-01T00:00:01.000Z");
      const instance = yield* ZeroClawDriver.create({
        instanceId: ProviderInstanceId.make("zc"),
        enabled: false,
        config: ZeroClawDriver.defaultConfig(),
        environment: [],
        displayName: undefined,
      });
      expect((yield* instance.snapshot.getSnapshot).checkedAt).toBe("1970-01-01T00:00:02.000Z");
      yield* TestClock.setTime(3_000);
      yield* instance.snapshot.refresh;
      expect((yield* instance.snapshot.getSnapshot).checkedAt).toBe("1970-01-01T00:00:03.000Z");
    }).pipe(Effect.provide(Path.layer)),
  );
  it.live("returns readiness with the default model without opening a session", () =>
    withDaemon((socketPath) =>
      Effect.gen(function* () {
        const snapshot = yield* probeZeroClaw({
          socketPath,
          instanceId: ProviderInstanceId.make("zc"),
          cache: { current: undefined },
        });
        expect(snapshot.status).toBe("ready");
        expect(snapshot.models?.map((model) => model.slug)).toEqual(["default"]);
        expect(agentOptionDescriptor(["coder", "reviewer"]).options).toEqual([
          { id: "coder", label: "coder" },
          { id: "reviewer", label: "reviewer" },
        ]);
      }),
    ),
  );

  it.live("publishes readiness and refreshes while model discovery is pending", () =>
    withDaemon((socketPath, _initializeParams, state) =>
      Effect.gen(function* () {
        const requested = yield* Deferred.make<() => void>();
        state.onCatalogModels = (reply) => Deferred.doneUnsafe(requested, Effect.succeed(reply));
        const created = yield* ZeroClawDriver.create({
          instanceId: ProviderInstanceId.make("zc"),
          enabled: true,
          config: { ...ZeroClawDriver.defaultConfig(), socketPath },
          environment: [],
          displayName: undefined,
        }).pipe(Effect.forkScoped);
        const reply = yield* Deferred.await(requested);
        expect(created.pollUnsafe()).toBeDefined();
        const instance = yield* Fiber.join(created);
        expect(yield* instance.snapshot.getSnapshot).toMatchObject({ status: "ready" });
        expect((yield* instance.snapshotForCwd!("/w")).optionDescriptors).toEqual([
          agentOptionDescriptor(["coder", "reviewer"]),
        ]);
        const refreshedRequest = yield* Deferred.make<() => void>();
        state.onCatalogModels = (send) =>
          Deferred.doneUnsafe(refreshedRequest, Effect.succeed(send));
        const refreshed = yield* instance.snapshot.refresh.pipe(Effect.forkScoped);
        const refreshReply = yield* Deferred.await(refreshedRequest);
        expect(refreshed.pollUnsafe()).toBeDefined();
        expect(yield* Fiber.join(refreshed)).toMatchObject({ status: "ready" });
        reply();
        refreshReply();
        const enriched = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) => snapshot.models?.some((model) => model.slug === "openai/gpt") === true,
          ),
          Stream.runHead,
        );
        expect(Option.getOrThrow(enriched).models?.map((model) => model.slug)).toEqual([
          "default",
          "openai/gpt",
        ]);
      }),
    ).pipe(Effect.provide(Path.layer)),
  );

  it.live("does not cache failed discovery and refreshes workspace agents", () =>
    withDaemon((socketPath, _initializeParams, state) =>
      Effect.gen(function* () {
        state.failAgentDiscovery = true;
        const cache: Parameters<typeof probeZeroClaw>[0]["cache"] = { current: undefined };
        const failed = yield* probeZeroClaw({
          socketPath,
          instanceId: ProviderInstanceId.make("zc"),
          cache,
        });
        expect(failed.status).toBe("warning");
        expect(cache.current).toBeUndefined();
        const instance = yield* ZeroClawDriver.create({
          instanceId: ProviderInstanceId.make("zc"),
          displayName: "Local daemon",
          environment: [],
          enabled: true,
          config: { ...ZeroClawDriver.defaultConfig(), socketPath },
        });
        expect(yield* instance.snapshot.getSnapshot).toMatchObject({
          enabled: true,
          status: "warning",
          displayName: "Local daemon",
        });
        expect((yield* instance.snapshotForCwd!("/w")).optionDescriptors).toEqual([
          agentOptionDescriptor([]),
        ]);
        state.failAgentDiscovery = false;
        yield* instance.snapshot.refresh;
        expect(yield* instance.snapshot.getSnapshot).toMatchObject({
          enabled: true,
          status: "ready",
        });
        expect((yield* instance.snapshotForCwd!("/w")).optionDescriptors).toEqual([
          agentOptionDescriptor(["coder", "reviewer"]),
        ]);
        state.agents = ["writer"];
        yield* instance.snapshot.refresh;
        expect((yield* instance.snapshotForCwd!("/w")).optionDescriptors).toEqual([
          agentOptionDescriptor(["writer"]),
        ]);
      }),
    ).pipe(Effect.provide(Path.layer)),
  );

  it.live("resolves an explicit socket before the environment and default data directory", () =>
    withDaemon((socketPath) =>
      Effect.gen(function* () {
        const cases = [
          {
            socketPath,
            environment: { ZEROCLAW_SOCKET: `${socketPath}.missing` },
          },
          {
            socketPath: "",
            environment: { ZEROCLAW_SOCKET: `${socketPath}.missing` },
            instanceEnvironment: [{ name: "ZEROCLAW_SOCKET", value: socketPath, sensitive: false }],
          },
          {
            socketPath: "",
            environment: { ZEROCLAW_SOCKET: socketPath },
          },
          {
            socketPath: "",
            environment: { ZEROCLAW_CONFIG_DIR: NodePath.dirname(NodePath.dirname(socketPath)) },
          },
        ];
        for (const testCase of cases) {
          const instance = yield* ZeroClawDriver.create({
            instanceId: ProviderInstanceId.make("zc"),
            enabled: true,
            config: { ...ZeroClawDriver.defaultConfig(), socketPath: testCase.socketPath },
            environment: testCase.instanceEnvironment ?? [],
            displayName: undefined,
          }).pipe(Effect.provideService(HostProcess.Environment, testCase.environment));
          expect(yield* instance.snapshot.getSnapshot).toMatchObject({
            enabled: true,
            status: "ready",
          });
        }
      }),
    ).pipe(Effect.provide(Path.layer)),
  );

  it.live("does not advertise elicitation support on initialize", () =>
    withDaemon((socketPath, initializeParams) =>
      Effect.gen(function* () {
        yield* probeZeroClaw({
          socketPath,
          instanceId: ProviderInstanceId.make("zc"),
          cache: { current: undefined },
        });
        // The daemon reads `elicitation: {}` as form support, so the key must be absent.
        expect(initializeParams).toEqual([{ protocol_version: 1, clientCapabilities: {} }]);
      }),
    ),
  );

  it.effect("returns a warning snapshot when no socket is configured", () =>
    Effect.gen(function* () {
      const snapshot = yield* probeZeroClaw({
        socketPath: "",
        instanceId: ProviderInstanceId.make("zc"),
        cache: { current: undefined },
      });
      expect(snapshot.status).toBe("warning");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("zeroclaw daemon");
    }),
  );
});
