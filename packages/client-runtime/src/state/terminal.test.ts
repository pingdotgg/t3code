import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createTerminalEnvironmentAtoms } from "./terminal.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

describe("terminal environment atoms", () => {
  it.effect("serializes subprocess inspection with restart and close", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const inspectionStarted = Latch.makeUnsafe();
        const releaseInspection = Latch.makeUnsafe();
        const events: string[] = [];
        const client = {
          [WS_METHODS.terminalInspectSubprocesses]: () =>
            Effect.sync(() => {
              events.push("inspect:start");
              inspectionStarted.openUnsafe();
            }).pipe(
              Effect.andThen(releaseInspection.await),
              Effect.tap(() => Effect.sync(() => events.push("inspect:end"))),
              Effect.as({
                terminals: [{ terminalId: "term-1", hasRunningSubprocess: false }],
              }),
            ),
          [WS_METHODS.terminalRestart]: () =>
            Effect.sync(() => {
              events.push("restart:start");
              return {};
            }),
          [WS_METHODS.terminalClose]: () =>
            Effect.sync(() => {
              events.push("close:start");
            }),
        } as unknown as WsRpcProtocolClient;
        const connectionState: SupervisorConnectionState = {
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online",
          phase: "connected",
          attempt: 1,
          generation: 1,
        };
        const session: RpcSession = {
          client,
          initialConfig: Effect.never,
          subscribeServerConfig: (input) => client.subscribeServerConfig(input),
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
        };
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(connectionState),
          session: yield* SubscriptionRef.make(Option.some(session)),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
          _environmentId,
          effect,
        ) => Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          run,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const runtime = Atom.runtime(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
        );
        const atoms = createTerminalEnvironmentAtoms(runtime);
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
          Effect.sync(() => registry.dispose()),
        );

        const inspection = atoms.inspectSubprocesses.run(registry, {
          environmentId: TARGET.environmentId,
          input: { threadId: "thread-1", terminalIds: ["term-1"] },
        });
        yield* inspectionStarted.await;
        const restart = atoms.restart.run(registry, {
          environmentId: TARGET.environmentId,
          input: {
            threadId: "thread-1",
            terminalId: "term-1",
            cwd: "/repo",
            cols: 80,
            rows: 24,
          },
        });
        const close = atoms.close.run(registry, {
          environmentId: TARGET.environmentId,
          input: { threadId: "thread-1", terminalId: "term-1" },
        });

        expect(events).toEqual(["inspect:start"]);
        releaseInspection.openUnsafe();
        const results = yield* Effect.promise(() => Promise.all([inspection, restart, close]));

        expect(results.map((result) => result._tag)).toEqual(["Success", "Success", "Success"]);
        expect(events).toEqual(["inspect:start", "inspect:end", "restart:start", "close:start"]);
      }),
    ),
  );
});
