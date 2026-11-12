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

























it.effect("prefers the live tab owner for new sessions without moving existing leases", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const connections = new Map<string, string>();
      for (const clientId of ["owner", "other"]) {
        const requests = requestsFrom(
          yield* broker.connect(makeHost({ clientId })),
          (connectionId) => connections.set(clientId, connectionId),
        );
        yield* Stream.runForEach(requests, (request) =>
          broker.respond({
            clientId,
            connectionId: request.connectionId,
            requestId: request.requestId,
            ok: true,
            result: clientId,
          }),
        ).pipe(Effect.forkScoped);
      }
      yield* Effect.yieldNow;
      yield* broker.focusHost({
        clientId: "owner",
        environmentId: scope.environmentId,
        connectionId: connections.get("owner")!,
        focused: false,
        liveTabs: [
          { threadId: scope.thread.threadId, tabId: PreviewTabId.make("signed-in"), visible: true },
        ],
      });
      yield* broker.focusHost({
        clientId: "other",
        environmentId: scope.environmentId,
        connectionId: connections.get("other")!,
        focused: true,
        liveTabs: [
          {
            threadId: scope.thread.threadId,
            tabId: PreviewTabId.make("signed-in"),
            visible: false,
          },
          {
            threadId: ThreadId.make("another-thread"),
            tabId: PreviewTabId.make("different-tab"),
            visible: true,
          },
        ],
      });
      expect(yield* broker.invoke<string>({ scope, operation: "evaluate", input: {} })).toBe(
        "owner",
      );
      expect(
        yield* broker.invoke<string>({
          scope: { ...scope, thread: { ...scope.thread, providerSessionId: "explicit-owner" } },
          tabId: PreviewTabId.make("signed-in"),
          operation: "snapshot",
          input: {},
        }),
      ).toBe("owner");
      expect(
        yield* broker.invoke<string>({
          scope: { ...scope, thread: { ...scope.thread, providerSessionId: "other-tab" } },
          tabId: PreviewTabId.make("different-tab"),
          operation: "evaluate",
          input: {},
        }),
      ).toBe("other");

      yield* broker.focusHost({
        clientId: "owner",
        environmentId: scope.environmentId,
        connectionId: connections.get("owner")!,
        focused: false,
        liveTabs: [],
      });
      expect(yield* broker.invoke<string>({ scope, operation: "evaluate", input: {} })).toBe(
        "owner",
      );
      expect(
        yield* broker.invoke<string>({
          scope: { ...scope, thread: { ...scope.thread, providerSessionId: "after-tab-closed" } },
          operation: "evaluate",
          input: {},
        }),
      ).toBe("other");
    }),
  ),
);

