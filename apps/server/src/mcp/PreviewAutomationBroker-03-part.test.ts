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

























it.effect.each([true, false])(
  "keeps an older target stable while a newer explicit tab responds (implicit: %s)",
  (implicit) =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        const olderTabId = PreviewTabId.make("tab-older-request");
        const newerTabId = PreviewTabId.make("tab-newer-request");
        const releaseOlderResponse = yield* Deferred.make<void>();
        const routedRequests: RoutedRequest[] = [];
        const requests = requestsFrom(yield* broker.connect(makeHost()));
        yield* Stream.runForEach(requests, (request) => {
          routedRequests.push(request);
          const response = Effect.gen(function* () {
            if (request.tabId === olderTabId && request.operation === "snapshot") {
              yield* Deferred.await(releaseOlderResponse);
            }
            yield* broker.respond({
              clientId: "client-1",
              connectionId: request.connectionId,
              requestId: request.requestId,
              ok: true,
              result: { url: "http://localhost:3200" },
            });
            if (request.tabId === newerTabId) {
              yield* Deferred.succeed(releaseOlderResponse, undefined);
            }
          });
          return response.pipe(Effect.forkScoped, Effect.asVoid);
        }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        yield* broker.invoke({ scope, operation: "status", input: {}, tabId: olderTabId });
        let capturedTabId: PreviewTabId | undefined;
        const older = yield* broker
          .invoke({
            scope,
            operation: "snapshot",
            input: {},
            ...(implicit ? {} : { tabId: olderTabId }),
            onTargetTab: (tabId) => {
              capturedTabId = tabId;
            },
          })
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        const newer = yield* broker
          .invoke({ scope, operation: "snapshot", input: {}, tabId: newerTabId })
          .pipe(Effect.forkScoped);
        yield* Fiber.join(newer);
        yield* Fiber.join(older);
        yield* broker.invoke({
          scope,
          operation: "status",
          input: {},
          tabId: olderTabId,
          updateCurrentTab: false,
        });
        yield* broker.invoke({ scope, operation: "snapshot", input: {} });

        expect(routedRequests.at(-1)?.tabId).toBe(newerTabId);
        expect(capturedTabId).toBe(olderTabId);
      }),
    ),
);

