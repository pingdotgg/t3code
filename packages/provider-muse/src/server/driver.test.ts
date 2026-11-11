import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HttpClient from "effect/http/HttpClient";
import { vi } from "vite-plus/test";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as sdk from "./sdk.ts";
import { MuseDriver } from "./driver.ts";

vi.mock("./sdk.ts", { spy: true });

const layerTest = TestProviderHost.layer({
  runBackgroundWork: false,
  settings: { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false },
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected HTTP request")),
    ),
  ),
);

function nativeHost() {
  let notify: Parameters<sdk.MuseSdkHost["connection"]["onNotification"]>[0] = () => {};
  let close!: () => void;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  const host: sdk.MuseSdkHost = {
    connection: {
      mintCommandId: () => "command",
      request: async (method) =>
        method.startsWith("session/")
          ? {
              session: { sessionId: "command", modelId: "muse-wonder-1.0", activeTurnId: null },
              history: { items: [] },
            }
          : method === "model/list"
            ? {
                providerId: "meta",
                models: [
                  {
                    modelId: "muse-wonder-1.0",
                    displayLabel: "Muse",
                    providerId: "meta",
                    isDefault: true,
                  },
                ],
              }
            : {},
      command: async (_method, params) => ({
        session: { sessionId: params.sessionId, modelId: "muse-wonder-1.0", activeTurnId: null },
        history: { items: [] },
      }),
      onNotification: (handler) => {
        notify = handler;
      },
      onProtocolError: () => {},
      onServerRequest: () => {},
      closed,
    },
    initializeResult: { grantedCapabilities: [] },
    exited: closed.then(() => ({ code: 0, signal: null })),
    close: async () => {
      close();
    },
  };
  return {
    host,
    emit: (method: string, params: Record<string, unknown>) =>
      notify({ jsonrpc: "2.0", method, params }),
  };
}

it.layer(layerTest)("MuseDriver usage", (it) => {
  it.effect(
    "reads the allowance before any turn and keeps the newest report across turns and refresh",
    () =>
      Effect.gen(function* () {
        const hosts: ReturnType<typeof nativeHost>[] = [];
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        // Older than either turn report, so turn reports must win over it.
        const allowance = {
          allowance: {
            asOfMs: 1791447760000,
            source: "mint",
            tier: "Muse Code High Usage",
            weekly: { resetsAtMs: 1791763200000, usedPercent: 20 },
            window: { resetsAtMs: 1791465557000, usedPercent: 30 },
          },
          hint: null,
          reason: null,
          schemaVersion: 1,
        };
        using _spawn = vi.spyOn(spawner, "spawn").mockImplementation((command) =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.encodeText(
                Stream.make(
                  command._tag === "StandardCommand" && command.args.includes("usage")
                    ? JSON.stringify(allowance)
                    : "muse 1.4.15-R8339.1",
                ),
              ),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        );
        const createHost: typeof sdk.createMuseSdkHost = async () => {
          const fake = nativeHost();
          hosts.push(fake);
          return fake.host;
        };
        const original = (yield* Effect.promise(() => vi.importActual<typeof sdk>("./sdk.ts")))
          .createMuseSdkHostEffect;
        using _hostEffect = vi
          .spyOn(sdk, "createMuseSdkHostEffect")
          .mockImplementation((options) => original(options, createHost));
        using _host = vi.spyOn(sdk, "createMuseSdkHost").mockImplementation(createHost);
        const instanceId = ProviderInstanceId.make("muse-test");
        const instance = yield* MuseDriver.create({
          instanceId,
          displayName: "Muse test",
          enabled: true,
          environment: [],
          config: { ...MuseDriver.defaultConfig(), binaryPath: process.execPath },
        });
        yield* Stream.take(instance.snapshot.streamChanges, 1).pipe(Stream.runDrain);
        const initial = yield* instance.snapshot.getSnapshot;
        expect(initial.status).toBe("ready");
        expect(initial.auth.label).toBe("Muse Code High Usage");
        expect(initial.usageLimits?.windows).toEqual([
          {
            id: "session",
            kind: "session",
            label: "Session",
            usedPercent: 30,
            resetsAt: "2026-10-08T13:19:17.000Z",
          },
          {
            id: "weekly",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 20,
            resetsAt: "2026-10-12T00:00:00.000Z",
            windowDurationMins: 7 * 24 * 60,
          },
        ]);
        const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
        });
        const sessions = yield* Effect.forEach(
          ["one", "two"],
          Effect.fnUntraced(function* (id) {
            const runtime = yield* instance.orchestrationAdapter.openSession({
              threadId: ThreadId.make(id),
              providerSessionId: ProviderSessionId.make(id),
              modelSelection: { instanceId, model: "muse-wonder-1.0", options: [] },
              runtimePolicy: policy,
            });
            const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
            yield* runtime.events.pipe(
              Stream.runForEach((event) => Queue.offer(events, event)),
              Effect.forkScoped,
            );
            yield* runtime.ensureThread({
              threadId: ThreadId.make(id),
              modelSelection: { instanceId, model: "muse-wonder-1.0", options: [] },
              runtimePolicy: policy,
            });
            return { fake: hosts.at(-1)!, events };
          }),
        );
        const reading = (observedAtMs: number, usedPercent: number, tier: string) => ({
          window: { usedPercent, windowDurationMins: 300, resetsAtMs: 1791465557000 },
          weekly: { usedPercent: 50, resetsAtMs: 1791763200000 },
          observedAtMs,
          tier,
        });
        const publish = Effect.fnUntraced(function* (
          index: number,
          report: ReturnType<typeof reading>,
        ) {
          const session = sessions[index]!;
          session.fake.emit("usage/changed", report);
          // The following context event acknowledges that this host has processed the report.
          session.fake.emit("session/contextUsage", {
            sessionId: "command",
            usedTokens: report.observedAtMs,
          });
          yield* Queue.take(session.events).pipe(
            Effect.repeat({
              until: (event) =>
                event.type === "provider_thread.updated" &&
                event.providerThread.contextUsage?.usedTokens === report.observedAtMs,
            }),
          );
        });
        yield* publish(1, reading(1791447762610, 70, "tier-2"));
        const latest = yield* instance.snapshot.getSnapshot;
        expect(latest.usageLimits?.unavailable).toBeUndefined();
        expect(latest.usageLimits?.windows.map((window) => window.usedPercent)).toEqual([70, 50]);
        expect(latest.auth.label).toBe("tier-2");
        yield* publish(0, reading(1791447761610, 10, "tier-1"));
        expect((yield* instance.snapshot.getSnapshot).usageLimits).toEqual(latest.usageLimits);
        expect((yield* instance.snapshot.getSnapshot).auth.label).toBe("tier-2");
        yield* instance.snapshot.refreshUsage!;
        expect((yield* instance.snapshot.getSnapshot).usageLimits).toEqual(latest.usageLimits);
        const refreshed = yield* instance.snapshot.refresh;
        expect(refreshed.usageLimits).toEqual(latest.usageLimits);
        expect(refreshed.auth.label).toBe("tier-2");
      }).pipe(Effect.scoped),
  );
});
