import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type AuthSessionState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { RelayConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as RpcHttp from "../rpc/http.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";

const TARGET = new RelayConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Environment",
});
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: "https://environment.example.test",
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: { _tag: "Bearer", token: "bearer-token" },
  target: TARGET,
};
const SESSION = {
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["desktop-bootstrap"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
  },
  scopes: ["orchestration:read", "orchestration:operate"],
} satisfies AuthSessionState;

function makeSessionAtom(reply: (requestNumber: number) => Promise<Response>) {
  let calls = 0;
  const fetchFn: typeof fetch = () => reply(++calls);
  const layer = Effect.gen(function* () {
    const supervisor = {
      target: TARGET,
      prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
    } as unknown as EnvironmentSupervisor["Service"];
    const registry = {
      followStream: <A, E, R>(_environmentId: EnvironmentId, stream: Stream.Stream<A, E, R>) =>
        stream.pipe(Stream.provideService(EnvironmentSupervisor, supervisor)),
    } as unknown as EnvironmentRegistry["Service"];
    return Layer.merge(
      Layer.succeed(EnvironmentRegistry, registry),
      RpcHttp.layerRemoteHttpClient(fetchFn),
    );
  }).pipe(Layer.unwrap);
  const atom = createEnvironmentSessionAtoms(Atom.runtime(layer)).sessionStateAtom(
    TARGET.environmentId,
  );
  return { atom, calls: () => calls };
}

const settle = (
  registry: AtomRegistry.AtomRegistry,
  atom: ReturnType<typeof makeSessionAtom>["atom"],
) => AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }).pipe(Effect.result);

describe("environment session state", () => {
  it.effect("keeps a confirmed grant through a failed refresh and retries it", () =>
    Effect.gen(function* () {
      const session = makeSessionAtom(async (requestNumber) => {
        if (requestNumber === 2) throw new TypeError("Failed to fetch");
        return Response.json(SESSION);
      });
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const observed: Array<string> = [];
      registry.mount(session.atom);
      registry.subscribe(session.atom, (result) => observed.push(result._tag));

      expect(yield* settle(registry, session.atom)).toMatchObject({ success: SESSION });
      registry.refresh(session.atom);
      expect(yield* settle(registry, session.atom)).toMatchObject({ success: SESSION });

      expect(session.calls()).toBe(3);
      expect(observed).not.toContain("Failure");
    }).pipe(Effect.scoped),
  );

  it.effect("reports a failed first load without retrying", () =>
    Effect.gen(function* () {
      const session = makeSessionAtom(async () => {
        throw new TypeError("Failed to fetch");
      });
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      registry.mount(session.atom);

      const result = yield* settle(registry, session.atom);
      expect(result._tag).toBe("Failure");
      expect(AsyncResult.isFailure(registry.get(session.atom))).toBe(true);
      expect(session.calls()).toBe(1);
    }).pipe(Effect.scoped),
  );
});
