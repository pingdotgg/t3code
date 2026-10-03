import { assert, it } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  hasCompatibleOrchestrationProtocol,
  resolveAvailableEditorsForConfig,
  resolveOpenDiscoveryForConfig,
  shouldUseBoundedThreadSnapshot,
} from "./ws.ts";

it("accepts only the current orchestration protocol before websocket RPC setup", () => {
  assert.isTrue(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`),
    ),
  );
  assert.isFalse(hasCompatibleOrchestrationProtocol(new URL("https://host.test/ws")));
  assert.isFalse(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION - 1}`),
    ),
  );
});

it("keeps full thread snapshot fallback unless the client opts into bounded history", () => {
  assert.isFalse(shouldUseBoundedThreadSnapshot({}));
  assert.isFalse(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: false }));
  assert.isTrue(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: true }));
});

it.effect("does not block server config when editor discovery never resolves", () =>
  Effect.gen(function* () {
    const discoveryInterrupted = yield* Deferred.make<void>();
    const responseFiber = yield* resolveAvailableEditorsForConfig(
      Effect.never.pipe(
        Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
      ),
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.seconds(5));

    const availableEditors = yield* Fiber.join(responseFiber);
    yield* Deferred.await(discoveryInterrupted);
    assert.deepEqual(availableEditors, []);
  }),
);

it.effect("runs editor and remote open target discovery side by side for server config", () =>
  Effect.gen(function* () {
    // Each discovery finishes only once the other has started, so a config
    // that ran them one after another would never resolve.
    const editorsStarted = yield* Deferred.make<void>();
    const targetsStarted = yield* Deferred.make<void>();

    const discovery = yield* resolveOpenDiscoveryForConfig({
      editors: Deferred.succeed(editorsStarted, undefined).pipe(
        Effect.andThen(Deferred.await(targetsStarted)),
        Effect.as(["file-manager" as const]),
      ),
      fileManagerRevealKind: Effect.succeed("finder" as const),
      remoteOpenTargets: Deferred.succeed(targetsStarted, undefined).pipe(
        Effect.andThen(Deferred.await(editorsStarted)),
        Effect.as([]),
      ),
    });

    assert.deepEqual(discovery, {
      availableEditors: ["file-manager"],
      fileManagerRevealKind: "finder",
      remoteOpenTargets: [],
    });
  }),
);
