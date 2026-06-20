import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewAutomationNoFocusedOwnerError,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationOwner,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const scope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
  expiresAt: 2,
};

const makeOwner = (overrides: Partial<PreviewAutomationOwner> = {}): PreviewAutomationOwner => ({
  clientId: "client-1",
  environmentId: scope.environmentId,
  threadId: scope.threadId,
  tabId: null,
  visible: false,
  supportsAutomation: true,
  focusedAt: "2026-06-11T00:00:00.000Z",
  ...overrides,
});

it.effect("atomically registers a connected owner and correlates its response", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.__testing.make;
      const requests = yield* broker.connect(makeOwner());
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({
          requestId: request.requestId,
          ok: true,
          result: { available: true },
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const result = yield* broker.invoke<{ available: boolean }>({
        scope,
        operation: "open",
        input: {},
      });

      expect(result).toEqual({ available: true });
    }),
  ),
);

it.effect("rejects calls when no focused owner exists", () =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.__testing.make;
    const error = yield* broker
      .invoke<void>({ scope, operation: "status", input: {} })
      .pipe(Effect.flip);
    expect(error).toBeInstanceOf(PreviewAutomationNoFocusedOwnerError);
  }),
);

it.effect("routes interactive commands to a hidden durable browser host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.__testing.make;
      const requests = yield* broker.connect(
        makeOwner({ clientId: "client-hidden", tabId: "tab-hidden" }),
      );
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({ requestId: request.requestId, ok: true }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* broker.invoke<void>({ scope, operation: "click", input: { x: 10, y: 10 } });
    }),
  ),
);

it.effect("lets the browser host resolve an active tab that has not been reported yet", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.__testing.make;
      const requests = yield* broker.connect(makeOwner({ tabId: null }));
      let routedTabId: string | undefined;
      yield* Stream.runForEach(requests, (request) => {
        routedTabId = request.tabId;
        return broker.respond({ requestId: request.requestId, ok: true });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* broker.invoke<void>({ scope, operation: "click", input: { x: 10, y: 10 } });

      expect(routedTabId).toBeUndefined();
    }),
  ),
);

it.effect("preserves current owner metadata when its request stream reconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.__testing.make;
      const firstRequests = yield* broker.connect(makeOwner());
      yield* Stream.runDrain(firstRequests).pipe(Effect.forkScoped);
      yield* broker.reportOwner(makeOwner({ tabId: "tab-current", visible: true }));

      const reconnectedRequests = yield* broker.connect(makeOwner());
      let routedTabId: string | undefined;
      yield* Stream.runForEach(reconnectedRequests, (request) => {
        routedTabId = request.tabId;
        return broker.respond({ requestId: request.requestId, ok: true });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* broker.invoke<void>({ scope, operation: "click", input: { x: 10, y: 10 } });

      expect(routedTabId).toBe("tab-current");
    }),
  ),
);

it.effect("ignores stale owner cleanup after the client moves to another thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.__testing.make;
      const requests = yield* broker.connect(makeOwner());
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({ requestId: request.requestId, ok: true }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* broker.clearOwner({
        clientId: "client-1",
        environmentId: scope.environmentId,
        threadId: ThreadId.make("thread-stale"),
      });

      yield* broker.invoke<void>({ scope, operation: "status", input: {} });
    }),
  ),
);

it.effect("fails requests assigned to a browser stream when that stream reconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.__testing.make;
      const _requests = yield* broker.connect(makeOwner());
      const pending = yield* broker
        .invoke<void>({ scope, operation: "status", input: {} })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;

      const _replacementRequests = yield* broker.connect(makeOwner());

      const error = yield* Fiber.join(pending);
      expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
    }),
  ),
);

it.effect("falls back to an older connected owner when a newer report is not connected", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.__testing.make;
      const requests = yield* broker.connect(makeOwner({ clientId: "client-connected" }));
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({ requestId: request.requestId, ok: true, result: "connected" }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* broker.reportOwner(
        makeOwner({
          clientId: "client-report-only",
          focusedAt: "2026-06-11T00:00:01.000Z",
        }),
      );

      const result = yield* broker.invoke<string>({ scope, operation: "status", input: {} });

      expect(result).toBe("connected");
    }),
  ),
);
