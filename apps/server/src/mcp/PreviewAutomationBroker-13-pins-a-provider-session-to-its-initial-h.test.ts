import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewAutomationClientDisconnectedError,
  PreviewAutomationMalformedResponseError,
  PreviewAutomationNoAvailableHostError,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationHost,
  type PreviewAutomationRequest,
  type PreviewAutomationStreamEvent,
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import { PreviewBrowserRootError } from "../preview/PreviewBrowserHost.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const makeBroker = PreviewAutomationBroker.make.pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const scope = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

const makeHost = (overrides: Partial<PreviewAutomationHost> = {}): PreviewAutomationHost => ({
  clientId: "client-1",
  environmentId: scope.environmentId,
  ...overrides,
});

type RoutedRequest = PreviewAutomationRequest & {
  readonly connectionId: PreviewAutomationStreamEvent["connectionId"];
};

const requestsFrom = (
  events: Stream.Stream<PreviewAutomationStreamEvent>,
  onConnected: (connectionId: PreviewAutomationStreamEvent["connectionId"]) => void = () => {},
): Stream.Stream<RoutedRequest> =>
  events.pipe(
    Stream.filterMap((event) => {
      if (event.type === "connected") {
        onConnected(event.connectionId);
        return Result.failVoid;
      }
      return Result.succeed({ ...event.request, connectionId: event.connectionId });
    }),
  );

























it.effect("pins a provider session to its initial host despite later focus changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      let firstConnectionId = "";
      let secondConnectionId = "";
      const firstRequests = requestsFrom(
        yield* broker.connect(makeHost({ clientId: "client-first" })),
        (connectionId) => {
          firstConnectionId = connectionId;
        },
      );
      const secondRequests = requestsFrom(
        yield* broker.connect(makeHost({ clientId: "client-second" })),
        (connectionId) => {
          secondConnectionId = connectionId;
        },
      );
      yield* Stream.runForEach(firstRequests, (request) =>
        broker.respond({
          clientId: "client-first",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "first",
        }),
      ).pipe(Effect.forkScoped);
      yield* Stream.runForEach(secondRequests, (request) =>
        broker.respond({
          clientId: "client-second",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "second",
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* broker.focusHost({
        clientId: "client-first",
        environmentId: scope.environmentId,
        connectionId: "connection-stale",
        focused: true,
        liveTabs: [{ threadId: scope.thread.threadId, tabId: PreviewTabId.make("stale-tab") }],
      });
      expect(yield* broker.invoke<string>({ scope, operation: "status", input: {} })).toBe(
        "second",
      );
      yield* broker.focusHost({
        clientId: "client-first",
        environmentId: scope.environmentId,
        connectionId: firstConnectionId,
        focused: true,
      });

      const firstPinnedScope = {
        ...scope,
        thread: { ...scope.thread, providerSessionId: "provider-session-first-pinned" },
      };
      expect(
        yield* broker.invoke<string>({ scope: firstPinnedScope, operation: "status", input: {} }),
      ).toBe("first");

      yield* broker.focusHost({
        clientId: "client-second",
        environmentId: scope.environmentId,
        connectionId: secondConnectionId,
        focused: true,
      });

      expect(
        yield* broker.invoke<string>({ scope: firstPinnedScope, operation: "status", input: {} }),
      ).toBe("first");
      expect(
        yield* broker.invoke<string>({
          scope: {
            ...scope,
            thread: { ...scope.thread, providerSessionId: "provider-session-second-pinned" },
          },
          operation: "status",
          input: {},
        }),
      ).toBe("second");
    }),
  ),
);

