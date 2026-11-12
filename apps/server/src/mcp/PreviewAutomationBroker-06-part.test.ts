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

























it.effect.each([
  {
    clientId: SERVER_BROWSER_AUTOMATION_CLIENT_ID,
    shown: true,
    message: "page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:4719/",
  },
  {
    clientId: "client-1",
    shown: false,
    message: "page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:4719/",
  },
  {
    clientId: SERVER_BROWSER_AUTOMATION_CLIENT_ID,
    shown: true,
    message: new PreviewBrowserRootError().message,
  },
])("preserves server browser failure guidance ($clientId)", ({ clientId, shown, message }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requests = requestsFrom(yield* broker.connect(makeHost({ clientId })));
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({
          clientId,
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: false,
          error: {
            _tag: "PreviewAutomationExecutionError",
            message,
          },
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const error = yield* broker
        .invoke<void>({ scope, operation: "open", input: {} })
        .pipe(Effect.flip);
      expect(error._tag).toBe("PreviewAutomationExecutionError");
      expect(error.message.includes(message)).toBe(shown);
    }),
  ),
);

