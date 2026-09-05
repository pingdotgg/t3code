import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type TerminalAttachStreamEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

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
import {
  createTerminalEnvironmentAtoms,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  terminalOutputText,
} from "./terminal.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

it.effect("observes live attach output before retention without another RPC subscription", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<TerminalAttachStreamEvent>();
      const started = Latch.makeUnsafe();
      let subscriptions = 0;
      const client = {
        [WS_METHODS.terminalAttach]: () =>
          Stream.suspend(() => {
            subscriptions += 1;
            started.openUnsafe();
            return Stream.concat(
              Stream.succeed({
                type: "output",
                threadId: ThreadId.make("thread"),
                terminalId: "term",
                data: "",
              } as const),
              Stream.fromQueue(events),
            );
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
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(connectionState),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        runStream: (_environmentId, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        followStream: (_environmentId, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]);

      const logs: unknown[] = [];
      const runtime = Atom.runtime(
        Layer.mergeAll(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
          Logger.layer([Logger.make(({ message }) => logs.push(message))]),
        ),
      );
      const atoms = createTerminalEnvironmentAtoms(runtime);
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      const target = {
        environmentId: TARGET.environmentId,
        input: {
          threadId: ThreadId.make("thread"),
          terminalId: "term",
          cwd: "/tmp",
          providerInstanceId: ProviderInstanceId.make("provider-1"),
          cols: 80,
          rows: 24,
        },
      };
      const observed: TerminalAttachStreamEvent[] = [];
      const unrelated: TerminalAttachStreamEvent[] = [];
      const observerFailure = new Error("observer failed");
      const stopBrokenObserver = atoms.observeAttach(target, () => {
        throw observerFailure;
      });
      const stop = atoms.observeAttach(target, (event) => observed.push(event));
      const stopOtherEnvironment = atoms.observeAttach(
        { ...target, environmentId: EnvironmentId.make("other") },
        (event) => unrelated.push(event),
      );
      const stopOtherAttach = atoms.observeAttach(
        { ...target, input: { ...target.input, cols: 90 } },
        (event) => unrelated.push(event),
      );
      const stopOtherProvider = atoms.observeAttach(
        {
          ...target,
          input: { ...target.input, providerInstanceId: ProviderInstanceId.make("provider-2") },
        },
        (event) => unrelated.push(event),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          stop();
          stopBrokenObserver();
          stopOtherEnvironment();
          stopOtherAttach();
          stopOtherProvider();
        }),
      );
      const atom = atoms.attach(target);
      const text = "x".repeat(600 * 1024);
      const firstUpdate = Latch.makeUnsafe();
      const secondUpdate = Latch.makeUnsafe();
      const unmount = registry.subscribe(atom, (result) => {
        if (!AsyncResult.isSuccess(result)) return;
        if (result.value.output.nextOffset === text.length) firstUpdate.openUnsafe();
        if (result.value.output.nextOffset === text.length + 4) secondUpdate.openUnsafe();
      });
      yield* Effect.addFinalizer(() => Effect.sync(unmount));
      yield* AtomRegistry.getResult(registry, atom);
      observed.length = 0;
      yield* started.await;
      const event = {
        type: "output",
        threadId: target.input.threadId,
        terminalId: "term",
        data: text,
      } as const;
      yield* Queue.offer(events, event);
      yield* firstUpdate.await;
      expect(observed).toEqual([event]);
      const state = yield* AtomRegistry.getResult(registry, atom);
      expect(state.output.retainedBytes).toBe(DEFAULT_MAX_TERMINAL_BUFFER_BYTES);
      expect(terminalOutputText(state.output)).toHaveLength(DEFAULT_MAX_TERMINAL_BUFFER_BYTES);
      stop();
      yield* Queue.offer(events, { ...event, data: "tail" });
      yield* secondUpdate.await;
      expect(observed).toEqual([event]);
      expect(unrelated).toEqual([]);
      expect(subscriptions).toBe(1);
      expect(logs).toContainEqual(["Terminal attach observer failed", observerFailure]);
    }),
  ),
);
