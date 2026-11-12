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

























it.effect("fails requests assigned to the stream that is replaced", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runDrain(requests).pipe(Effect.forkScoped);
      const pending = yield* broker
        .invoke<void>({ scope, operation: "status", input: {} })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;

      const replacementRequests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runDrain(replacementRequests).pipe(Effect.forkScoped);

      const error = yield* Fiber.join(pending);
      expect(error).toBeInstanceOf(PreviewAutomationClientDisconnectedError);
      expect(error).toMatchObject({
        operation: "status",
        environmentId: scope.environmentId,
        threadId: scope.thread.threadId,
        providerSessionId: scope.thread.providerSessionId,
        providerInstanceId: scope.thread.providerInstanceId,
        clientId: "client-1",
        requestId: "preview-0",
        timeoutMs: 15_000,
      });
    }),
  ),
);

