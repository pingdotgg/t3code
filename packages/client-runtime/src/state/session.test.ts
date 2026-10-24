import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import { Atom, AtomRegistry } from "effect/reactivity";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { RemoteEnvironmentAuthFetchError, RemoteEnvironmentAuthTimeoutError } from "../rpc/http.ts";
import { createEnvironmentSessionAtoms, currentSessionGrant } from "./session.ts";

// Each session recheck takes the next scripted environment answer.
type SessionAnswer = Effect.Effect<
  AuthSessionState,
  RemoteEnvironmentAuthFetchError | RemoteEnvironmentAuthTimeoutError
>;
const answers: Array<SessionAnswer> = [];
vi.mock("./environmentHttpAuth.ts", () => ({
  executeAuthenticatedEnvironmentHttpRequest: () =>
    Effect.suspend(() => answers.shift() ?? Effect.never),
}));

const env = EnvironmentId.make("target");
const target = new PrimaryConnectionTarget({
  environmentId: env,
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const prepared: PreparedConnection = {
  environmentId: env,
  label: target.label,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target,
};
const grant: AuthSessionState = {
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: [AuthOrchestrationOperateScope],
  permissions: [AuthOrchestrationOperateScope],
};
const rejected = new RemoteEnvironmentAuthFetchError({
  message: "The environment rejected the renewed session authorization.",
  cause: { ...grant, authenticated: false },
});
const timedOut = new RemoteEnvironmentAuthTimeoutError(`${target.httpBaseUrl}/api/auth/session`, 1);

const setup = Effect.gen(function* () {
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    prepared: yield* SubscriptionRef.make(Option.some(prepared)),
  } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(
        EnvironmentRegistry.EnvironmentRegistry,
        EnvironmentRegistry.EnvironmentRegistry.of({
          followStream: <A, E, R>(_id: EnvironmentId, stream: Stream.Stream<A, E, R>) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      ),
      Layer.succeed(HttpClient.HttpClient, {} as HttpClient.HttpClient),
    ),
  );
  const atom = createEnvironmentSessionAtoms(runtime).sessionStateAtom(env);
  const registry = AtomRegistry.make();
  registry.mount(atom);
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const recheck = (answer: SessionAnswer) =>
    Effect.gen(function* () {
      answers.push(answer);
      registry.refresh(atom);
      yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }).pipe(Effect.ignore);
      return currentSessionGrant(registry.get(atom));
    });
  return recheck;
});

describe("environment session grant", () => {
  it.effect("a timed-out recheck neither keeps nor revives a rejected grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const recheck = yield* setup;
        expect(yield* recheck(Effect.succeed(grant))).toEqual(grant);
        expect(yield* recheck(Effect.fail(timedOut))).toEqual(grant);
        expect(yield* recheck(Effect.fail(rejected))).toBeNull();
        expect(yield* recheck(Effect.fail(timedOut))).toBeNull();
        expect(yield* recheck(Effect.fail(timedOut))).toBeNull();
        expect(yield* recheck(Effect.succeed(grant))).toEqual(grant);
      }),
    ),
  );
});
