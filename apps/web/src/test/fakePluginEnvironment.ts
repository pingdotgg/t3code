import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  type PreparedConnection,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { RpcSession, WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import {
  type EnvironmentId,
  type PluginInstallation,
  type ServerConfig,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/reactivity";

/** One request the fake server holds until the test answers it. */
export interface HeldCall {
  readonly method: string;
  readonly input: unknown;
  /** True once the client gave up on the request, so an answer is never delivered. */
  readonly interrupted: boolean;
  readonly reply: (value: unknown) => void;
  readonly fail: (error: Error) => void;
}

/**
 * A connected environment whose server is the test: every unary request is
 * held until answered, and the plugin catalogue is whatever was last published.
 * Only the transport is fake; atoms, commands, and the registry are real.
 */
export function makeFakePluginEnvironment(input: {
  readonly environmentId: EnvironmentId;
  readonly capabilities: ServerConfig["environment"]["capabilities"];
}) {
  const calls: Array<HeldCall> = [];
  const taken = new Set<HeldCall>();
  const waiters = new Set<() => void>();
  const catalog = Effect.runSync(SubscriptionRef.make<ReadonlyArray<PluginInstallation>>([]));
  const client = new Proxy(
    {},
    {
      get: (_target, method: string) => (request: unknown) => {
        if (method === WS_METHODS.pluginsSubscribe)
          return SubscriptionRef.changes(catalog).pipe(
            Stream.map((installations) => ({ installations })),
          );
        return Effect.callback<unknown, Error>((resume) => {
          const call = {
            method,
            input: request,
            interrupted: false,
            reply: (value: unknown) => resume(Effect.succeed(value)),
            fail: (error: Error) => resume(Effect.fail(error)),
          };
          calls.push(call);
          for (const wake of waiters) wake();
          return Effect.sync(() => {
            call.interrupted = true;
          });
        });
      },
    },
  ) as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed({
      environment: { capabilities: input.capabilities },
    } as ServerConfig),
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId: input.environmentId,
      label: "Build box",
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    }),
    state: Effect.runSync(
      SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        phase: "connected",
      }),
    ),
    session: Effect.runSync(SubscriptionRef.make(Option.some(session))),
    prepared: Effect.runSync(
      SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    ),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    followStream,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);

  return {
    runtime: Atom.runtime(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
    ),
    /** Every request of `method` received so far, in order. */
    calls: (method: string) => calls.filter((call) => call.method === method),
    /** The oldest request of `method` not yet taken, once it has been sent. */
    next: (method: string) =>
      new Promise<HeldCall>((resolve) => {
        const check = () => {
          const call = calls.find(
            (candidate) => candidate.method === method && !taken.has(candidate),
          );
          if (call === undefined) return;
          taken.add(call);
          waiters.delete(check);
          resolve(call);
        };
        waiters.add(check);
        check();
      }),
    /** Replaces the catalogue the server reports. */
    publish: (installations: ReadonlyArray<PluginInstallation>) =>
      Effect.runSync(SubscriptionRef.set(catalog, installations)),
    reset: () => {
      calls.length = 0;
      taken.clear();
      waiters.clear();
      Effect.runSync(SubscriptionRef.set(catalog, []));
    },
  };
}
