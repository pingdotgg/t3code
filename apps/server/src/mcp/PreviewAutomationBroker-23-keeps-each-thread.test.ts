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

























it.effect("keeps each thread's current tab when threads share a provider session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const routed: Array<RoutedRequest> = [];
      const requests = requestsFrom(yield* broker.connect(makeHost(), { preferred: true }));
      yield* Stream.runForEach(requests, (request) => {
        routed.push(request);
        return broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: { tabId: request.tabId ?? `tab-${request.threadId}` },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      // Codex runs every thread of an instance in one provider session.
      const otherThread = {
        ...scope,
        thread: { ...scope.thread, threadId: ThreadId.make("thread-2") },
      };

      yield* broker.invoke({ scope, operation: "open", input: {} });
      yield* broker.invoke({ scope: otherThread, operation: "snapshot", input: {} });
      yield* broker.invoke({ scope, operation: "snapshot", input: {} });
      yield* broker.invoke({ scope: otherThread, operation: "snapshot", input: {} });

      expect(routed.map(({ threadId, tabId }) => [threadId, tabId])).toEqual([
        ["thread-1", undefined],
        ["thread-2", undefined],
        ["thread-1", "tab-thread-1"],
        ["thread-2", "tab-thread-2"],
      ]);
      expect(routed[0]!.agentSessionId).not.toBe(routed[1]!.agentSessionId);
    }),
  ),
);

