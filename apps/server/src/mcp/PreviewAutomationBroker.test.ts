import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewAutomationNoFocusedOwnerError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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

it.effect("routes a request to the focused owner and correlates its response", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.__testing.make;
      const requests = yield* broker.connect("client-1");
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({
          requestId: request.requestId,
          ok: true,
          result: { available: true },
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* broker.reportOwner({
        clientId: "client-1",
        environmentId: scope.environmentId,
        threadId: scope.threadId,
        tabId: null,
        visible: false,
        supportsAutomation: true,
        focusedAt: "2026-06-11T00:00:00.000Z",
      });

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
      const requests = yield* broker.connect("client-hidden");
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({ requestId: request.requestId, ok: true }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* broker.reportOwner({
        clientId: "client-hidden",
        environmentId: scope.environmentId,
        threadId: scope.threadId,
        tabId: "tab-hidden",
        visible: false,
        supportsAutomation: true,
        focusedAt: "2026-06-11T00:00:00.000Z",
      });

      yield* broker.invoke<void>({ scope, operation: "click", input: { x: 10, y: 10 } });
    }),
  ),
);
