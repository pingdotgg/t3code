import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  RpcClientId,
  ThreadId,
  type ClientActivityLease,
  type ClientFocusHost,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ClientFocusBroker from "./ClientFocusBroker.ts";

const NOW = DateTime.makeUnsafe("2026-09-23T00:00:00.000Z");
const windowsDesktop: ClientFocusHost = {
  clientId: "windows-desktop",
  clientKind: "desktop-renderer",
  label: "WIN-STUDIO",
  platform: "Windows",
};

const lease = (
  rpcClientId: number,
  activity: { readonly visible: boolean; readonly focused: boolean },
): ClientActivityLease => ({
  sessionId: AuthSessionId.make("session-1"),
  rpcClientId: RpcClientId.make(rpcClientId),
  clientId: windowsDesktop.clientId,
  clientKind: windowsDesktop.clientKind,
  recentlyInteracted: activity.focused,
  scopes: [],
  updatedAt: NOW,
  expiresAt: DateTime.add(NOW, { minutes: 1 }),
  ...activity,
});

const connection = (rpcClientId: number) => ({
  sessionId: AuthSessionId.make("session-1"),
  rpcClientId: RpcClientId.make(rpcClientId),
});

const makeBroker = (leases: Ref.Ref<ReadonlyArray<ClientActivityLease>>) =>
  ClientFocusBroker.make(Ref.get(leases)).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

it.effect("delivers to the focused window when a device has several connections", () =>
  Effect.gen(function* () {
    const leases = yield* Ref.make<ReadonlyArray<ClientActivityLease>>([
      lease(1, { visible: true, focused: true }),
      lease(2, { visible: false, focused: false }),
    ]);
    const broker = yield* makeBroker(leases);
    const focusedWindow = yield* broker.connect(connection(1), windowsDesktop);
    // Connecting registers the window; its request stream is never read here.
    const _backgroundWindow = yield* broker.connect(connection(2), windowsDesktop);
    // One device, active because any of its windows is.
    assert.deepStrictEqual(
      (yield* broker.list).map(({ clientId, visible, focused }) => ({
        clientId,
        visible,
        focused,
      })),
      [{ clientId: "windows-desktop", visible: true, focused: true }],
    );
    const received = yield* Stream.runHead(focusedWindow).pipe(Effect.forkScoped);

    const result = yield* broker.focus({
      clientId: windowsDesktop.clientId,
      target: { _tag: "thread", threadId: ThreadId.make("thread-1") },
    });

    const request = Option.getOrThrow(yield* Fiber.join(received));
    assert.equal(request.requestId, result.requestId);
    assert.deepStrictEqual(request.target, {
      _tag: "thread",
      threadId: ThreadId.make("thread-1"),
    });
    assert.equal(result.label, "WIN-STUDIO");
  }),
);

it.effect("forgets a device once its focus stream ends", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker(yield* Ref.make<ReadonlyArray<ClientActivityLease>>([]));
    const requests = yield* broker.connect(connection(1), windowsDesktop);
    const received = yield* Stream.runHead(requests).pipe(Effect.forkScoped);
    yield* broker.focus({ clientId: windowsDesktop.clientId, target: { _tag: "agents" } });
    yield* Fiber.join(received);

    assert.deepStrictEqual(yield* broker.list, []);
    const error = yield* broker
      .focus({ clientId: windowsDesktop.clientId, target: { _tag: "agents" } })
      .pipe(Effect.flip);
    assert.equal(error._tag, "ClientNotConnectedError");
  }),
);
