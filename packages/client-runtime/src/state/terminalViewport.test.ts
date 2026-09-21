import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  WS_METHODS,
  ThreadId,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createTerminalViewportAtom } from "./terminal.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("terminal-environment"),
  label: "Terminal environment",
  httpBaseUrl: "https://terminal.example.test",
  wsBaseUrl: "wss://terminal.example.test",
});
const INPUT = { threadId: ThreadId.make("thread-1"), terminalId: "terminal-1", cwd: "/project" };

const makeHarness = Effect.fn("TerminalViewportTest.makeHarness")(function* () {
  const requests = yield* Queue.unbounded<{
    input: TerminalAttachInput;
    events: Queue.Queue<TerminalAttachStreamEvent>;
  }>();
  const closed = yield* Queue.unbounded<TerminalAttachInput>();
  const client = {
    [WS_METHODS.terminalAttach]: (input: TerminalAttachInput) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<TerminalAttachStreamEvent>();
          yield* Effect.addFinalizer(() => Queue.offer(closed, input));
          yield* Queue.offer(requests, { input, events });
          return Stream.fromQueue(events);
        }),
      ),
  } satisfies Record<
    typeof WS_METHODS.terminalAttach,
    (input: TerminalAttachInput) => Stream.Stream<TerminalAttachStreamEvent>
  >;
  const session = (): RpcSession => ({
    client: client as unknown as WsRpcProtocolClient,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) =>
      (client as unknown as WsRpcProtocolClient).subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  });
  const activeSession = yield* SubscriptionRef.make(Option.some(session()));
  const supervisor = EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: activeSession,
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const environments = EnvironmentRegistry.of({
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, environments));
  const registry = yield* Effect.acquireRelease(
    Effect.sync(() => AtomRegistry.make({ defaultIdleTTL: 300_000 })),
    (registry) => Effect.sync(() => registry.dispose()),
  );
  let grid: { cols: number; rows: number } | null = { cols: 120, rows: 30 };
  const create = () =>
    createTerminalViewportAtom(
      runtime,
      {
        environmentId: TARGET.environmentId,
        input: INPUT,
      },
      () => grid,
    );
  return {
    registry,
    requests,
    closed,
    create,
    setGrid: (next: typeof grid) => {
      grid = next;
    },
    reconnect: () => SubscriptionRef.set(activeSession, Option.some(session())),
  };
});

describe("terminal viewport attachment", () => {
  it.effect("uses the current grid on reconnect and omits dimensions while hidden", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const atom = h.create();
        const unmount = h.registry.mount(atom);
        expect((yield* Queue.take(h.requests)).input).toEqual({ ...INPUT, cols: 120, rows: 30 });

        h.setGrid({ cols: 80, rows: 24 });
        yield* h.reconnect();
        expect((yield* Queue.take(h.requests)).input).toEqual({ ...INPUT, cols: 80, rows: 24 });
        yield* Queue.take(h.closed);

        h.setGrid(null);
        yield* h.reconnect();
        expect((yield* Queue.take(h.requests)).input).toEqual(INPUT);
        yield* Queue.take(h.closed);

        h.setGrid({ cols: 100, rows: 28 });
        yield* h.reconnect();
        expect((yield* Queue.take(h.requests)).input).toEqual({ ...INPUT, cols: 100, rows: 28 });
        yield* Queue.take(h.closed);
        unmount();
        yield* Queue.take(h.closed);
      }),
    ),
  );
});
