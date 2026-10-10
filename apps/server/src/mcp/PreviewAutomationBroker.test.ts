import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewAutomationClientDisconnectedError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationMalformedResponseError,
  PreviewAutomationNoAvailableHostError,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationTimeoutError,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationHost,
  type PreviewAutomationRequest,
  type PreviewAutomationStreamEvent,
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const makeBroker = PreviewAutomationBroker.make.pipe(Effect.provide(NodeServices.layer));

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

it.effect("atomically registers a connected host and correlates its response", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
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

it.effect("targets multiple tabs explicitly while retaining a default tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const appTabId = PreviewTabId.make("tab-web-app");
      const simulatorTabId = PreviewTabId.make("tab-ios-simulator");
      const openedTabIds = [appTabId, simulatorTabId];
      let openIndex = 0;
      const routedRequests: RoutedRequest[] = [];
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(requests, (request) => {
        routedRequests.push(request);
        return broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result:
            request.operation === "open"
              ? { available: true, tabId: openedTabIds[openIndex++] }
              : { url: "http://localhost:3200" },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* broker.invoke({ scope, operation: "open", input: { reuseExistingTab: false } });
      yield* broker.invoke({ scope, operation: "open", input: { reuseExistingTab: false } });
      yield* broker.invoke({ scope, operation: "snapshot", input: {} });
      yield* broker.invoke({ scope, operation: "snapshot", input: {}, tabId: appTabId });
      yield* broker.invoke({ scope, operation: "snapshot", input: {} });

      expect(routedRequests).toHaveLength(5);
      expect(routedRequests[0]?.tabId).toBeUndefined();
      expect(routedRequests[1]?.tabId).toBe(appTabId);
      expect(routedRequests[2]?.tabId).toBe(simulatorTabId);
      expect(routedRequests[2]?.tabIdExplicit).toBe(false);
      expect(routedRequests[3]?.tabId).toBe(appTabId);
      expect(routedRequests[3]?.tabIdExplicit).toBe(true);
      expect(routedRequests[4]?.tabId).toBe(appTabId);
    }),
  ),
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

it.effect("tracks the tab returned by a targeted recording stop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const browsingTabId = PreviewTabId.make("tab-session-b");
      const recordingTabId = PreviewTabId.make("tab-session-a-recording");
      const routedRequests: RoutedRequest[] = [];
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(requests, (request) => {
        routedRequests.push(request);
        return broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result:
            request.operation === "open"
              ? { available: true, tabId: browsingTabId }
              : request.operation === "recordingStop"
                ? { id: "recording-1", tabId: recordingTabId }
                : { url: "http://localhost:3200" },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* broker.invoke({ scope, operation: "open", input: {} });
      yield* broker.invoke({ scope, operation: "recordingStop", input: {} });
      yield* broker.invoke({ scope, operation: "snapshot", input: {} });

      expect(routedRequests.at(-1)?.tabId).toBe(recordingTabId);
    }),
  ),
);

it.effect("does not let a no-tab response suppress an earlier tab decision", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const initialTabId = PreviewTabId.make("tab-initial");
      const openedTabId = PreviewTabId.make("tab-opened-late");
      const releaseOpenResponse = yield* Deferred.make<void>();
      const routedRequests: RoutedRequest[] = [];
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(requests, (request) => {
        routedRequests.push(request);
        const marker =
          typeof request.input === "object" && request.input !== null && "marker" in request.input
            ? request.input.marker
            : undefined;
        const response = Effect.gen(function* () {
          if (marker === "older") {
            yield* Deferred.await(releaseOpenResponse);
          }
          yield* broker.respond({
            clientId: "client-1",
            connectionId: request.connectionId,
            requestId: request.requestId,
            ok: true,
            result:
              request.operation === "open"
                ? { available: true, tabId: marker === "older" ? openedTabId : initialTabId }
                : { url: "http://localhost:3200" },
          });
          if (marker === "newer") {
            yield* Deferred.succeed(releaseOpenResponse, undefined);
          }
        });
        return response.pipe(Effect.forkScoped, Effect.asVoid);
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* broker.invoke({ scope, operation: "open", input: {} });
      const older = yield* broker
        .invoke({
          scope,
          operation: "open",
          input: { marker: "older", reuseExistingTab: false },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const newer = yield* broker
        .invoke({ scope, operation: "snapshot", input: { marker: "newer" } })
        .pipe(Effect.forkScoped);
      yield* Fiber.join(newer);
      yield* Fiber.join(older);
      yield* broker.invoke({ scope, operation: "snapshot", input: {} });

      expect(routedRequests.at(-1)?.tabId).toBe(openedTabId);
    }),
  ),
);

it.effect("announces a live replacement stream before delivering requests", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const events = yield* broker.connect(makeHost());
      const receivedTypes: PreviewAutomationStreamEvent["type"][] = [];
      const consumer = yield* events.pipe(
        Stream.take(2),
        Stream.runForEach((event) => {
          receivedTypes.push(event.type);
          return event.type === "connected"
            ? Effect.void
            : broker.respond({
                clientId: "client-1",
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                ok: true,
                result: "ready",
              });
        }),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      const result = yield* broker.invoke<string>({ scope, operation: "status", input: {} });
      yield* Fiber.join(consumer);

      expect(receivedTypes).toEqual(["connected", "request"]);
      expect(result).toBe("ready");
    }),
  ),
);

it.effect(
  "keeps a server-host open alive for installation without extending other operations",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        const received = yield* Deferred.make<RoutedRequest>();
        const requests = requestsFrom(yield* broker.connect(makeHost(), { preferred: true }));
        yield* Stream.runForEach(requests, (request) =>
          request.operation === "open"
            ? Deferred.succeed(received, request)
            : broker.respond({
                clientId: "client-1",
                connectionId: request.connectionId,
                requestId: request.requestId,
                ok: true,
                result: request.timeoutMs,
              }),
        ).pipe(Effect.forkScoped);
        const opening = yield* broker
          .invoke({ scope, operation: "open", input: {} })
          .pipe(Effect.forkScoped);
        const request = yield* Deferred.await(received);
        yield* TestClock.adjust(16_000);
        yield* broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "opened",
        });
        expect(yield* Fiber.join(opening)).toBe("opened");
        expect(yield* broker.invoke({ scope, operation: "status", input: {} })).toBe(15_000);
        expect(yield* broker.invoke({ scope, operation: "navigate", input: {} })).toBe(15_000);
      }),
    ),
);

it.effect("preserves bounded request and remote selector diagnostics", () => {
  const locator = "role=button[name='request-secret']";
  const remoteMessage = "Unexpected token near remote-secret.";
  const remoteError = {
    _tag: "PreviewAutomationInvalidSelectorError",
    message: remoteMessage,
    detail: { selector: "role=button[name='remote-secret']" },
  } as const;

  return Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: false,
          error: remoteError,
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const error = yield* broker
        .invoke<void>({
          scope,
          operation: "click",
          input: { locator },
          tabId: PreviewTabId.make("tab-1"),
          timeoutMs: 1_234,
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(PreviewAutomationInvalidSelectorError);
      expect(error).toMatchObject({
        operation: "click",
        environmentId: scope.environmentId,
        threadId: scope.thread.threadId,
        providerSessionId: scope.thread.providerSessionId,
        providerInstanceId: scope.thread.providerInstanceId,
        clientId: "client-1",
        requestId: "preview-0",
        tabId: "tab-1",
        timeoutMs: 1_234,
        selectorKind: "locator",
        selectorLength: locator.length,
        remoteTag: "PreviewAutomationInvalidSelectorError",
        remoteMessageLength: remoteMessage.length,
        remoteDetailKind: "object",
      });
      expect(error.message).toBe(
        `Preview automation click received an invalid locator (${locator.length} characters).`,
      );
      expect(error.message).not.toContain("secret");
      expect(error.cause).toBe(remoteError);
      expect("selector" in error).toBe(false);
      expect("remoteMessage" in error).toBe(false);
      expect("remoteDetail" in error).toBe(false);
    }),
  );
});

it.effect("classifies a remote non-editable target without collapsing it to execution", () => {
  const remoteError = {
    _tag: "PreviewAutomationTargetNotEditableError",
    message: "remote target details",
    detail: { selectorKind: "focused-element" },
  } as const;

  return Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: false,
          error: remoteError,
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const error = yield* broker
        .invoke<void>({
          scope,
          operation: "type",
          input: { text: "hello" },
          tabId: PreviewTabId.make("tab-1"),
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(PreviewAutomationTargetNotEditableError);
      expect(error).toMatchObject({
        operation: "type",
        tabId: "tab-1",
        selectorKind: "focused-element",
        remoteTag: "PreviewAutomationTargetNotEditableError",
      });
      expect(error.message).toBe("Preview automation type requires an editable focused element.");
    }),
  );
});

it.effect.each([
  "PreviewAutomationRecordingTransferError",
  "PreviewAutomationRecordingDesktopUpdateRequiredError",
  "PreviewAutomationRecordingTooLargeError",
  "PreviewAutomationRecordingDeadlineExpiredError",
] as const)("preserves recording failure %s", (tag) =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const remoteError = {
        _tag: tag,
        message: "remote recording details",
        detail: { reason: "untrusted-reason", threadId: "untrusted-thread" },
      };
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: false,
          error: remoteError,
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const error = yield* broker
        .invoke<void>({
          scope,
          operation: "recordingStop",
          input: {},
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: tag,
        threadId: scope.thread.threadId,
      });
      expect(error.cause).toBe(remoteError);
      expect(error.message).not.toContain("remote recording details");
    }),
  ),
);

it.effect.each([
  { clientId: SERVER_BROWSER_AUTOMATION_CLIENT_ID, shown: true },
  { clientId: "client-1", shown: false },
])("tells the agent why its own server browser failed ($clientId)", ({ clientId, shown }) =>
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
            message: "page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:4719/",
          },
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const error = yield* broker
        .invoke<void>({ scope, operation: "open", input: {} })
        .pipe(Effect.flip);
      expect(error._tag).toBe("PreviewAutomationExecutionError");
      // A desktop or other remote host's text stays out of the agent's context.
      expect(error.message.includes("ERR_CONNECTION_REFUSED")).toBe(shown);
    }),
  ),
);

it.effect("distinguishes malformed remote failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: false,
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const error = yield* broker
        .invoke<void>({ scope, operation: "status", input: {}, timeoutMs: 2_000 })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(PreviewAutomationMalformedResponseError);
      expect(error).toMatchObject({
        operation: "status",
        environmentId: scope.environmentId,
        threadId: scope.thread.threadId,
        providerSessionId: scope.thread.providerSessionId,
        providerInstanceId: scope.thread.providerInstanceId,
        clientId: "client-1",
        requestId: "preview-0",
        timeoutMs: 2_000,
      });
    }),
  ),
);

it.effect("rejects calls when no connected host exists", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker;
    const error = yield* broker
      .invoke<void>({ scope, operation: "status", input: {} })
      .pipe(Effect.flip);

    expect(error).toBeInstanceOf(PreviewAutomationNoAvailableHostError);
    expect(error).toMatchObject({
      operation: "status",
      environmentId: scope.environmentId,
      threadId: scope.thread.threadId,
      providerSessionId: scope.thread.providerSessionId,
      providerInstanceId: scope.thread.providerInstanceId,
    });
  }),
);

it.effect("does not create host state from focus updates without a live stream", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker;
    yield* broker.focusHost({
      clientId: "client-1",
      environmentId: scope.environmentId,
      connectionId: "connection-missing",
      focused: true,
    });

    const error = yield* broker
      .invoke<void>({ scope, operation: "status", input: {} })
      .pipe(Effect.flip);
    expect(error).toBeInstanceOf(PreviewAutomationNoAvailableHostError);
  }),
);

it.effect("removes host availability when the authoritative request stream disconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      const beforeAcquisition = yield* broker
        .invoke<void>({ scope, operation: "status", input: {} })
        .pipe(Effect.flip);
      expect(beforeAcquisition).toBeInstanceOf(PreviewAutomationNoAvailableHostError);

      const consumer = yield* Stream.runDrain(requests).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(consumer);

      const error = yield* broker
        .invoke<void>({ scope, operation: "status", input: {} })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(PreviewAutomationNoAvailableHostError);
    }),
  ),
);

it.effect("routes requests for background threads through an environment-level host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const backgroundThreadId = ThreadId.make("thread-background");
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      let routedThreadId: string | undefined;
      yield* Stream.runForEach(requests, (request) => {
        routedThreadId = request.threadId;
        return broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "background",
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const result = yield* broker.invoke<string>({
        scope: {
          ...scope,
          thread: {
            ...scope.thread,
            threadId: backgroundThreadId,
            providerSessionId: "provider-session-background",
          },
        },
        operation: "status",
        input: {},
      });

      expect(result).toBe("background");
      expect(routedThreadId).toBe(backgroundThreadId);
    }),
  ),
);

it.effect("never routes a provider session to a host from another environment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const matchingRequests = requestsFrom(
        yield* broker.connect(makeHost({ clientId: "client-matching" })),
      );
      const foreignRequests = requestsFrom(
        yield* broker.connect(
          makeHost({
            clientId: "client-foreign",
            environmentId: EnvironmentId.make("environment-foreign"),
          }),
        ),
      );
      yield* Stream.runForEach(matchingRequests, (request) =>
        broker.respond({
          clientId: "client-matching",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "matching",
        }),
      ).pipe(Effect.forkScoped);
      yield* Stream.runForEach(foreignRequests, (request) =>
        broker.respond({
          clientId: "client-foreign",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "foreign",
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      expect(yield* broker.invoke<string>({ scope, operation: "status", input: {} })).toBe(
        "matching",
      );
    }),
  ),
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

it.effect("prefers a focused host over unrelated extra capabilities for a new session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      let focusedConnectionId = "";
      for (const [clientId, supportedOperations] of [
        ["focused", ["status"]],
        ["background", ["status", "resize"]],
      ] as const) {
        const requests = requestsFrom(
          yield* broker.connect(makeHost({ clientId, supportedOperations })),
          (connectionId) => {
            if (clientId === "focused") focusedConnectionId = connectionId;
          },
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
        clientId: "focused",
        environmentId: scope.environmentId,
        connectionId: focusedConnectionId,
        focused: true,
      });
      expect(yield* broker.invoke<string>({ scope, operation: "status", input: {} })).toBe(
        "focused",
      );
    }),
  ),
);

it.effect("does not route new operations to legacy hosts that did not advertise support", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const legacyEvents = yield* broker.connect(makeHost());
      yield* Stream.runDrain(legacyEvents).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const error = yield* broker
        .invoke<void>({ scope, operation: "resize", input: { mode: "fill" } })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(PreviewAutomationNoAvailableHostError);
      expect(error).toMatchObject({ operation: "resize", environmentId: scope.environmentId });
    }),
  ),
);

it.effect("routes resize to a capable host instead of a newer legacy connection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const capableRequests = requestsFrom(
        yield* broker.connect(
          makeHost({ clientId: "client-capable", supportedOperations: ["resize"] }),
        ),
      );
      const legacyRequests = requestsFrom(
        yield* broker.connect(makeHost({ clientId: "client-legacy" })),
      );
      yield* Stream.runForEach(capableRequests, (request) =>
        broker.respond({
          clientId: "client-capable",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "capable",
        }),
      ).pipe(Effect.forkScoped);
      yield* Stream.runForEach(legacyRequests, (request) =>
        broker.respond({
          clientId: "client-legacy",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "legacy",
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      expect(
        yield* broker.invoke<string>({ scope, operation: "resize", input: { mode: "fill" } }),
      ).toBe("capable");
    }),
  ),
);

it.effect("does not move a live legacy assignment to another runtime for resize", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const legacyRequests = requestsFrom(
        yield* broker.connect(makeHost({ clientId: "client-legacy" })),
      );
      yield* Stream.runForEach(legacyRequests, (request) =>
        broker.respond({
          clientId: "client-legacy",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "legacy",
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      expect(yield* broker.invoke<string>({ scope, operation: "status", input: {} })).toBe(
        "legacy",
      );

      const capableRequests = requestsFrom(
        yield* broker.connect(
          makeHost({ clientId: "client-capable", supportedOperations: ["resize"] }),
        ),
      );
      yield* Stream.runForEach(capableRequests, (request) =>
        broker.respond({
          clientId: "client-capable",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "capable",
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const error = yield* broker
        .invoke<void>({ scope, operation: "resize", input: { mode: "fill" } })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(PreviewAutomationNoAvailableHostError);
      expect(yield* broker.invoke<string>({ scope, operation: "status", input: {} })).toBe(
        "legacy",
      );
    }),
  ),
);

it.effect("ignores stale focus updates for a different environment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      let firstConnectionId = "";
      const firstRequests = requestsFrom(
        yield* broker.connect(makeHost({ clientId: "client-first" })),
        (connectionId) => {
          firstConnectionId = connectionId;
        },
      );
      const secondRequests = requestsFrom(
        yield* broker.connect(makeHost({ clientId: "client-second" })),
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
        environmentId: EnvironmentId.make("environment-stale"),
        connectionId: firstConnectionId,
        focused: true,
      });

      expect(yield* broker.invoke<string>({ scope, operation: "status", input: {} })).toBe(
        "second",
      );
    }),
  ),
);

it.effect("fails over a pinned provider session only after its host disconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const firstTabId = PreviewTabId.make("tab-on-first-host");
      let firstConnectionId = "";
      let secondRoutedTabId: PreviewTabId | undefined;
      const firstRequests = requestsFrom(
        yield* broker.connect(makeHost({ clientId: "client-first" })),
        (connectionId) => {
          firstConnectionId = connectionId;
        },
      );
      const secondRequests = requestsFrom(
        yield* broker.connect(makeHost({ clientId: "client-second" })),
      );
      const firstConsumer = yield* Stream.runForEach(firstRequests, (request) =>
        broker.respond({
          clientId: "client-first",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: request.operation === "open" ? { host: "first", tabId: firstTabId } : "first",
        }),
      ).pipe(Effect.forkScoped);
      yield* Stream.runForEach(secondRequests, (request) => {
        secondRoutedTabId = request.tabId;
        return broker.respond({
          clientId: "client-second",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "second",
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* broker.focusHost({
        clientId: "client-first",
        environmentId: scope.environmentId,
        connectionId: firstConnectionId,
        focused: true,
        liveTabs: [{ threadId: scope.thread.threadId, tabId: firstTabId }],
      });
      expect(yield* broker.invoke({ scope, operation: "open", input: {} })).toEqual({
        host: "first",
        tabId: firstTabId,
      });

      yield* Fiber.interrupt(firstConsumer);
      yield* Effect.yieldNow;

      expect(yield* broker.invoke<string>({ scope, operation: "status", input: {} })).toBe(
        "second",
      );
      expect(secondRoutedTabId).toBeUndefined();
    }),
  ),
);

it.effect("lets the browser host resolve an active tab locally", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      let routedTabId: string | undefined;
      yield* Stream.runForEach(requests, (request) => {
        routedTabId = request.tabId;
        return broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* broker.invoke<void>({ scope, operation: "click", input: { x: 10, y: 10 } });

      expect(routedTabId).toBeUndefined();
    }),
  ),
);

it.effect("keeps a replacement stream authoritative when the old stream finalizes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      let firstConnectionId = "";
      let replacementConnectionId = "";
      const firstRequests = requestsFrom(yield* broker.connect(makeHost()), (connectionId) => {
        firstConnectionId = connectionId;
      });
      yield* Stream.runDrain(firstRequests).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const replacementRequests = requestsFrom(
        yield* broker.connect(makeHost()),
        (connectionId) => {
          replacementConnectionId = connectionId;
        },
      );
      yield* Stream.runForEach(replacementRequests, (request) =>
        broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "replacement",
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      expect(replacementConnectionId).not.toBe(firstConnectionId);
      const result = yield* broker.invoke<string>({ scope, operation: "status", input: {} });
      expect(result).toBe("replacement");
    }),
  ),
);

it.effect("does not carry a tab id across a replacement automation stream", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const openedTabId = PreviewTabId.make("tab-first-webcontents");
      const firstRequests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(firstRequests, (request) =>
        broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result:
            request.operation === "open"
              ? { host: "first", tabId: openedTabId }
              : { host: "first" },
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      expect(yield* broker.invoke({ scope, operation: "open", input: {} })).toEqual({
        host: "first",
        tabId: openedTabId,
      });

      const routedRequests: RoutedRequest[] = [];
      const replacementRequests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(replacementRequests, (request) => {
        routedRequests.push(request);
        return broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "replacement",
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      expect(yield* broker.invoke<string>({ scope, operation: "status", input: {} })).toBe(
        "replacement",
      );
      expect(routedRequests.at(-1)?.tabId).toBeUndefined();
    }),
  ),
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

it.effect("accepts responses only from the host that received the request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(requests, (request) =>
        Effect.gen(function* () {
          yield* broker.respond({
            clientId: "client-foreign",
            connectionId: request.connectionId,
            requestId: request.requestId,
            ok: true,
            result: "foreign",
          });
          yield* broker.respond({
            clientId: "client-1",
            connectionId: "connection-stale",
            requestId: request.requestId,
            ok: true,
            result: "stale",
          });
          yield* broker.respond({
            clientId: "client-1",
            connectionId: request.connectionId,
            requestId: request.requestId,
            ok: true,
            result: "owner",
          });
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const result = yield* broker.invoke<string>({ scope, operation: "status", input: {} });
      expect(result).toBe("owner");
    }),
  ),
);

it.effect("discards buffered actions before completing an evicted host stream", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const connected = yield* Deferred.make<void>();
      const received = yield* Deferred.make<void>();
      const actionRouted = yield* Deferred.make<void>();
      const releaseConsumer = yield* Deferred.make<void>();
      const operations: string[] = [];
      const consumer = yield* Stream.runForEach(yield* broker.connect(makeHost()), (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        operations.push(event.request.operation);
        return Deferred.succeed(received, undefined).pipe(
          Effect.andThen(Deferred.await(releaseConsumer)),
        );
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);
      const timedOut = yield* broker
        .invoke<void>({ scope, operation: "snapshot", input: {}, timeoutMs: 1_000 })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(received);
      const buffered = yield* broker
        .invoke<void>({
          scope,
          operation: "click",
          input: {},
          timeoutMs: 10_000,
          onTargetTab: () => {
            Deferred.doneUnsafe(actionRouted, Effect.void);
          },
        })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(actionRouted);
      yield* TestClock.adjust(2_000);
      expect(yield* Fiber.join(timedOut)).toMatchObject({ _tag: "PreviewAutomationTimeoutError" });
      expect(yield* Fiber.join(buffered)).toMatchObject({
        _tag: "PreviewAutomationClientDisconnectedError",
      });
      yield* Deferred.succeed(releaseConsumer, undefined);
      expect(Exit.isSuccess(yield* Fiber.await(consumer))).toBe(true);
      expect(operations).toEqual(["snapshot"]);
    }),
  ),
);

it.effect("rejects a routed action when its generation is evicted before delivery", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const connected = yield* Deferred.make<void>();
      const received = yield* Deferred.make<void>();
      const actionRouted = yield* Deferred.make<void>();
      const operations: string[] = [];
      const consumer = yield* Stream.runForEach(yield* broker.connect(makeHost()), (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        operations.push(event.request.operation);
        return Deferred.succeed(received, undefined);
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);
      const timedOut = yield* broker
        .invoke<void>({ scope, operation: "snapshot", input: {}, timeoutMs: 1_000 })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(received);

      // Suspend only this invocation in the gap between route selection and delivery.
      const tasks: Array<() => void> = [];
      let paused = false;
      const dispatcher: Scheduler.SchedulerDispatcher = {
        scheduleTask: (task) => tasks.push(task),
        flush: () => {
          let task: (() => void) | undefined;
          while ((task = tasks.shift()) !== undefined) task();
        },
      };
      const scheduler: Scheduler.Scheduler = {
        executionMode: "async",
        makeDispatcher: () => dispatcher,
        shouldYield: () => paused,
      };
      const action = yield* broker
        .invoke<void>({
          scope,
          operation: "click",
          input: {},
          onTargetTab: () => {
            paused = true;
            Deferred.doneUnsafe(actionRouted, Effect.void);
          },
        })
        .pipe(
          Effect.flip,
          Effect.provideService(Scheduler.Scheduler, scheduler),
          Effect.forkScoped,
        );
      yield* Deferred.await(actionRouted);
      yield* TestClock.adjust(2_000);
      expect(yield* Fiber.join(timedOut)).toMatchObject({ _tag: "PreviewAutomationTimeoutError" });
      expect(Exit.isSuccess(yield* Fiber.await(consumer))).toBe(true);

      paused = false;
      dispatcher.flush();
      expect(yield* Fiber.join(action)).toMatchObject({
        _tag: "PreviewAutomationClientDisconnectedError",
      });
      expect(operations).toEqual(["snapshot"]);
    }),
  ),
);

it.effect.each(["snapshot", "evaluate", "navigate"] as const)(
  "retains an opted-in host, pending open, and session tabs after a %s timeout",
  (operation) =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        const connected = yield* Deferred.make<void>();
        const timedOutReceived = yield* Deferred.make<RoutedRequest>();
        const openReceived = yield* Deferred.make<RoutedRequest>();
        const firstTabId = PreviewTabId.make("tab-first-session");
        const secondTabId = PreviewTabId.make("tab-second-session");
        const openedTabId = PreviewTabId.make("tab-opened-second-session");
        const lateTabId = PreviewTabId.make("tab-late-response");
        const otherScope = {
          ...scope,
          thread: {
            ...scope.thread,
            threadId: ThreadId.make("thread-2"),
            providerSessionId: "provider-session-2",
          },
        };
        const routedRequests: RoutedRequest[] = [];
        // The policy is a registration option, independent of the client id or preference.
        const events = yield* broker.connect(makeHost(), { disconnectOnTimeout: false });
        const consumer = yield* Stream.runForEach(events, (event) => {
          if (event.type === "connected") return Deferred.succeed(connected, undefined);
          const request = { ...event.request, connectionId: event.connectionId };
          routedRequests.push(request);
          if (request.operation === operation) return Deferred.succeed(timedOutReceived, request);
          if (request.operation === "open") return Deferred.succeed(openReceived, request);
          return broker.respond({
            clientId: "client-1",
            connectionId: request.connectionId,
            requestId: request.requestId,
            ok: true,
            result: { host: "client-1", targetTabId: request.tabId },
          });
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(connected);
        yield* broker.invoke({ scope, operation: "status", input: {}, tabId: firstTabId });
        yield* broker.invoke({
          scope: otherScope,
          operation: "status",
          input: {},
          tabId: secondTabId,
        });

        const timedOut = yield* broker
          .invoke<void>({ scope, operation, input: {}, timeoutMs: 1_000 })
          .pipe(Effect.flip, Effect.forkScoped);
        const timedOutRequest = yield* Deferred.await(timedOutReceived);
        const opening = yield* broker
          .invoke({ scope: otherScope, operation: "open", input: {}, timeoutMs: 10_000 })
          .pipe(Effect.forkScoped);
        const openRequest = yield* Deferred.await(openReceived);

        // A new host wins new sessions, exposing any accidental loss of existing leases.
        const otherConnected = yield* Deferred.make<void>();
        const otherEvents = yield* broker.connect(makeHost({ clientId: "client-newer" }));
        yield* Stream.runForEach(otherEvents, (event) =>
          event.type === "connected"
            ? Deferred.succeed(otherConnected, undefined)
            : broker.respond({
                clientId: "client-newer",
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                ok: true,
                result: { host: "client-newer" },
              }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(otherConnected);
        expect(
          yield* broker.invoke({
            scope: {
              ...scope,
              thread: { ...scope.thread, providerSessionId: "provider-session-new" },
            },
            operation: "status",
            input: {},
          }),
        ).toEqual({ host: "client-newer" });

        yield* TestClock.adjust(2_000);
        const error = yield* Fiber.join(timedOut);
        expect(error).toBeInstanceOf(PreviewAutomationTimeoutError);
        expect(error).toMatchObject({
          operation,
          timeoutMs: 1_000,
          requestId: timedOutRequest.requestId,
          clientId: "client-1",
          connectionId: timedOutRequest.connectionId,
          threadId: scope.thread.threadId,
          providerSessionId: scope.thread.providerSessionId,
          tabId: firstTabId,
        });
        expect(opening.pollUnsafe()).toBeUndefined();
        expect(consumer.pollUnsafe()).toBeUndefined();

        let lateErrorRead = false;
        yield* broker.respond({
          clientId: "client-1",
          connectionId: timedOutRequest.connectionId,
          requestId: timedOutRequest.requestId,
          ok: false,
          error: {
            _tag: "PreviewAutomationExecutionError",
            get message() {
              lateErrorRead = true;
              return "Late operation failed";
            },
          },
        });
        expect(lateErrorRead).toBe(false);
        yield* broker.respond({
          clientId: "client-1",
          connectionId: timedOutRequest.connectionId,
          requestId: timedOutRequest.requestId,
          ok: true,
          result: { tabId: lateTabId },
        });
        expect(yield* broker.invoke({ scope, operation: "status", input: {} })).toEqual({
          host: "client-1",
          targetTabId: firstTabId,
        });
        expect(yield* broker.invoke({ scope: otherScope, operation: "status", input: {} })).toEqual(
          { host: "client-1", targetTabId: secondTabId },
        );
        expect(opening.pollUnsafe()).toBeUndefined();
        expect(openRequest.connectionId).toBe(timedOutRequest.connectionId);
        expect(openRequest.agentSessionId).not.toBe(timedOutRequest.agentSessionId);

        yield* broker.respond({
          clientId: "client-1",
          connectionId: openRequest.connectionId,
          requestId: openRequest.requestId,
          ok: true,
          result: { tabId: openedTabId },
        });
        expect(yield* Fiber.join(opening)).toEqual({ tabId: openedTabId });
        expect(yield* broker.invoke({ scope: otherScope, operation: "status", input: {} })).toEqual(
          { host: "client-1", targetTabId: openedTabId },
        );
        expect(routedRequests.filter((request) => request.operation === operation)).toEqual([
          timedOutRequest,
        ]);
        expect(routedRequests.filter((request) => request.operation === "open")).toEqual([
          openRequest,
        ]);
        expect(consumer.pollUnsafe()).toBeUndefined();
      }),
    ),
);

it.effect.each([
  { label: "default", clientId: "client-1", options: undefined },
  {
    label: "explicit eviction",
    clientId: "client-1",
    options: { disconnectOnTimeout: true },
  },
  {
    label: "preferred server-browser id without opt-in",
    clientId: SERVER_BROWSER_AUTOMATION_CLIENT_ID,
    options: { preferred: true },
  },
])("evicts an unanswered host and its unrelated open ($label)", ({ clientId, options }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const connected = yield* Deferred.make<void>();
      const snapshotReceived = yield* Deferred.make<RoutedRequest>();
      const openReceived = yield* Deferred.make<RoutedRequest>();
      const operations: string[] = [];
      const consumer = yield* Stream.runForEach(
        yield* broker.connect(makeHost({ clientId }), options),
        (event) => {
          if (event.type === "connected") return Deferred.succeed(connected, undefined);
          operations.push(event.request.operation);
          const request = { ...event.request, connectionId: event.connectionId };
          return Deferred.succeed(
            event.request.operation === "open" ? openReceived : snapshotReceived,
            request,
          );
        },
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);
      const snapshot = yield* broker
        .invoke<void>({ scope, operation: "snapshot", input: {}, timeoutMs: 1_000 })
        .pipe(Effect.flip, Effect.forkScoped);
      const snapshotRequest = yield* Deferred.await(snapshotReceived);
      const opening = yield* broker
        .invoke<void>({
          scope: {
            ...scope,
            thread: { ...scope.thread, providerSessionId: "provider-session-other" },
          },
          operation: "open",
          input: {},
          timeoutMs: 10_000,
        })
        .pipe(Effect.flip, Effect.forkScoped);
      const openRequest = yield* Deferred.await(openReceived);
      yield* TestClock.adjust(2_000);

      expect(yield* Fiber.join(snapshot)).toBeInstanceOf(PreviewAutomationTimeoutError);
      expect(yield* Fiber.join(opening)).toMatchObject({
        _tag: "PreviewAutomationClientDisconnectedError",
        operation: "open",
        requestId: openRequest.requestId,
        connectionId: snapshotRequest.connectionId,
      });
      expect(Exit.isSuccess(yield* Fiber.await(consumer))).toBe(true);
      expect(
        yield* broker.invoke<void>({ scope, operation: "status", input: {} }).pipe(Effect.flip),
      ).toBeInstanceOf(PreviewAutomationNoAvailableHostError);
      yield* broker.respond({
        clientId,
        connectionId: snapshotRequest.connectionId,
        requestId: snapshotRequest.requestId,
        ok: true,
        result: "late",
      });
      expect(operations).toEqual(["snapshot", "open"]);
    }),
  ),
);

it.effect.each([true, false])(
  "cleans up an interrupted invocation without eviction or replay (before delivery: %s)",
  (beforeDelivery) =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        const connected = yield* Deferred.make<string>();
        const received = yield* Deferred.make<RoutedRequest>();
        const routed = yield* Deferred.make<void>();
        const tabId = PreviewTabId.make("tab-before-interruption");
        const requests: RoutedRequest[] = [];
        const events = yield* broker.connect(makeHost(), { disconnectOnTimeout: false });
        const consumer = yield* Stream.runForEach(events, (event) => {
          if (event.type === "connected") return Deferred.succeed(connected, event.connectionId);
          const request = { ...event.request, connectionId: event.connectionId };
          requests.push(request);
          return request.operation === "evaluate"
            ? Deferred.succeed(received, request)
            : broker.respond({
                clientId: "client-1",
                connectionId: request.connectionId,
                requestId: request.requestId,
                ok: true,
                result: { requestId: request.requestId, targetTabId: request.tabId },
              });
        }).pipe(Effect.forkScoped);
        const connectionId = yield* Deferred.await(connected);
        expect(yield* broker.invoke({ scope, operation: "status", input: {}, tabId })).toEqual({
          requestId: "preview-0",
          targetTabId: tabId,
        });

        const tasks: Array<() => void> = [];
        let paused = false;
        const dispatcher: Scheduler.SchedulerDispatcher = {
          scheduleTask: (task) => tasks.push(task),
          flush: () => {
            let task: (() => void) | undefined;
            while ((task = tasks.shift()) !== undefined) task();
          },
        };
        const scheduler: Scheduler.Scheduler = {
          executionMode: "async",
          makeDispatcher: () => dispatcher,
          shouldYield: () => paused,
        };
        const invocation = yield* broker
          .invoke({
            scope,
            operation: "evaluate",
            input: {},
            timeoutMs: 1_000,
            onTargetTab: () => {
              if (!beforeDelivery) return;
              paused = true;
              Deferred.doneUnsafe(routed, Effect.void);
            },
          })
          .pipe(Effect.provideService(Scheduler.Scheduler, scheduler), Effect.forkScoped);
        const request = beforeDelivery
          ? yield* Deferred.await(routed).pipe(Effect.as({ requestId: "preview-1", connectionId }))
          : yield* Deferred.await(received);
        // Signal interruption while its dispatcher may be paused, then let cleanup run.
        yield* Effect.sync(() => invocation.interruptUnsafe());
        paused = false;
        dispatcher.flush();
        expect(Exit.hasInterrupts(yield* Fiber.await(invocation))).toBe(true);

        // Ignoring a retired response includes ignoring its error payload entirely.
        let lateErrorRead = false;
        yield* broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: false,
          error: {
            _tag: "PreviewAutomationExecutionError",
            get message() {
              lateErrorRead = true;
              return "Late evaluation failed";
            },
          },
        });
        expect(lateErrorRead).toBe(false);
        yield* TestClock.adjust(1_000);
        expect(yield* broker.invoke({ scope, operation: "status", input: {} })).toEqual({
          requestId: "preview-2",
          targetTabId: tabId,
        });
        expect(requests.map((request) => request.operation)).toEqual(
          beforeDelivery ? ["status", "status"] : ["status", "evaluate", "status"],
        );
        expect(consumer.pollUnsafe()).toBeUndefined();
      }),
    ),
);

it.effect("keeps a host whose operation timeout arrives just after the budget", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const received = yield* Deferred.make<void>();
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(requests, (request) =>
        Effect.gen(function* () {
          if (request.operation === "waitFor") {
            yield* Deferred.succeed(received, undefined);
            // The browser starts its own timer after delivery, so its timeout lands late.
            yield* Effect.sleep(request.timeoutMs + 50);
          }
          yield* broker.respond({
            clientId: "client-1",
            connectionId: request.connectionId,
            requestId: request.requestId,
            ...(request.operation === "waitFor"
              ? {
                  ok: false,
                  error: { _tag: "PreviewAutomationTimeoutError", message: "Selector timed out" },
                }
              : { ok: true, result: "responsive" }),
          });
        }),
      ).pipe(Effect.forkScoped);
      const timedOut = yield* broker
        .invoke<void>({ scope, operation: "waitFor", input: {}, timeoutMs: 1_000 })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(received);
      yield* TestClock.adjust(1_050);
      expect(yield* Fiber.join(timedOut)).toMatchObject({
        _tag: "PreviewAutomationTimeoutError",
        remoteTag: "PreviewAutomationTimeoutError",
      });
      expect(yield* broker.invoke({ scope, operation: "status", input: {} })).toBe("responsive");
    }),
  ),
);

it.effect("keeps the host connected when a background status read times out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      // A busy host answers its actions but not the metadata read behind them.
      yield* Stream.runForEach(requests, (request) =>
        request.operation === "status"
          ? Effect.void
          : broker.respond({
              clientId: "client-1",
              connectionId: request.connectionId,
              requestId: request.requestId,
              ok: true,
              result: { operation: request.operation },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const status = yield* broker
        .invoke<void>({
          scope,
          operation: "status",
          input: {},
          timeoutMs: 500,
          updateCurrentTab: false,
        })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* TestClock.adjust(500);
      expect(yield* Fiber.join(status)).toMatchObject({ _tag: "PreviewAutomationTimeoutError" });

      expect(yield* broker.invoke({ scope, operation: "snapshot", input: {} })).toEqual({
        operation: "snapshot",
      });
    }),
  ),
);

// Leave transport delivery separate from execution so these tests can hold
// a host event without starting a fresh timeout at dequeue.
const makeGuardedRequest = Effect.gen(function* () {
  const broker = yield* makeBroker;
  const connected = yield* Deferred.make<void>();
  const received = yield* Deferred.make<RoutedRequest>();
  const consumer = yield* Stream.runForEach(
    yield* broker.connect(makeHost(), { disconnectOnTimeout: false }),
    (event) =>
      event.type === "connected"
        ? Deferred.succeed(connected, undefined)
        : Deferred.succeed(received, { ...event.request, connectionId: event.connectionId }),
  ).pipe(Effect.forkScoped);
  yield* Deferred.await(connected);
  const caller = yield* broker
    .invoke<void>({ scope, operation: "click", input: {}, timeoutMs: 1_000 })
    .pipe(Effect.forkScoped);
  const request = yield* Deferred.await(received);
  const identity = {
    clientId: "client-1",
    connectionId: request.connectionId,
    requestId: request.requestId,
  };
  return { broker, caller, consumer, identity };
});

it.effect.each(["timeout", "interrupt"] as const)(
  "skips host events held until after caller %s and ignores their late responses",
  (retirement) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, caller, identity } = yield* makeGuardedRequest;
        if (retirement === "timeout") {
          yield* TestClock.adjust(2_000);
          expect(yield* Fiber.join(caller).pipe(Effect.flip)).toBeInstanceOf(
            PreviewAutomationTimeoutError,
          );
        } else {
          yield* Fiber.interrupt(caller);
          expect(Exit.hasInterrupts(yield* Fiber.await(caller))).toBe(true);
        }
        let executions = 0;
        yield* broker.runRequest(identity, () =>
          Effect.sync(() => executions++).pipe(Effect.asVoid),
        );
        expect(executions).toBe(0);
        let lateErrorRead = false;
        yield* broker.respond({
          ...identity,
          ok: false,
          error: {
            _tag: "PreviewAutomationExecutionError",
            get message() {
              lateErrorRead = true;
              return "Late action failed";
            },
          },
        });
        yield* broker.respond({ ...identity, ok: true, result: undefined });
        expect(lateErrorRead).toBe(false);
        yield* broker.runRequest(identity, () =>
          Effect.sync(() => executions++).pipe(Effect.asVoid),
        );
        expect(executions).toBe(0);
      }),
    ),
);

it.effect("keeps response grace separate from expired host execution", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, caller, identity } = yield* makeGuardedRequest;
      yield* TestClock.adjust(1_000);
      expect(caller.pollUnsafe()).toBeUndefined();
      let executions = 0;
      yield* broker.runRequest(identity, () => Effect.sync(() => executions++).pipe(Effect.asVoid));
      expect(executions).toBe(0);

      yield* TestClock.adjust(250);
      yield* broker.respond({
        ...identity,
        ok: false,
        error: { _tag: "PreviewAutomationTimeoutError", message: "Action budget expired" },
      });
      expect(yield* Fiber.join(caller).pipe(Effect.flip)).toMatchObject({
        _tag: "PreviewAutomationTimeoutError",
        remoteTag: "PreviewAutomationTimeoutError",
      });
      expect(executions).toBe(0);
    }),
  ),
);

it.effect("passes only the original request's remaining budget after host dispatch delay", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, caller, identity } = yield* makeGuardedRequest;
      yield* TestClock.adjust(400);
      const budgetReceived = yield* Deferred.make<number>();
      const guarded = yield* broker
        .runRequest(identity, (remainingTimeoutMs) =>
          Deferred.succeed(budgetReceived, remainingTimeoutMs).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkScoped);
      expect(yield* Deferred.await(budgetReceived)).toBe(600);
      yield* TestClock.adjust(600);
      expect(Exit.isSuccess(yield* Fiber.await(guarded))).toBe(true);
      expect(caller.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(1_000);
      expect(yield* Fiber.join(caller).pipe(Effect.flip)).toBeInstanceOf(
        PreviewAutomationTimeoutError,
      );
    }),
  ),
);

it.effect.each(["timeout", "interrupt", "success", "error", "disconnect"] as const)(
  "aborts active host effects and revokes queued actions on caller %s",
  (retirement) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, caller, consumer, identity } = yield* makeGuardedRequest;
        const started = yield* Deferred.make<AbortSignal>();
        const aborted = yield* Deferred.make<void>();
        const queuedActions: Array<() => void> = [];
        let executions = 0;
        const guarded = yield* broker
          .runRequest(identity, () =>
            Effect.tryPromise({
              try: (signal) =>
                new Promise<void>(() => {
                  // The host's dispatcher starts this only after it acquires its turn.
                  queuedActions.push(() => {
                    if (!signal.aborted) executions++;
                  });
                  signal.addEventListener(
                    "abort",
                    () => Deferred.doneUnsafe(aborted, Effect.void),
                    {
                      once: true,
                    },
                  );
                  Deferred.doneUnsafe(started, Effect.succeed(signal));
                }),
              catch: () => ({ _tag: "GuardedHostError" as const }),
            }),
          )
          .pipe(Effect.forkScoped);
        const signal = yield* Deferred.await(started);
        if (retirement === "timeout") {
          yield* TestClock.adjust(1_000);
          yield* Deferred.await(aborted);
          expect(signal.aborted).toBe(true);
          expect(Exit.isSuccess(yield* Fiber.await(guarded))).toBe(true);
          expect(caller.pollUnsafe()).toBeUndefined();
          yield* TestClock.adjust(1_000);
          expect(yield* Fiber.join(caller).pipe(Effect.flip)).toBeInstanceOf(
            PreviewAutomationTimeoutError,
          );
        } else if (retirement === "interrupt") {
          yield* Fiber.interrupt(caller);
          expect(Exit.hasInterrupts(yield* Fiber.await(caller))).toBe(true);
        } else if (retirement === "disconnect") {
          yield* Fiber.interrupt(consumer);
          expect(yield* Fiber.join(caller).pipe(Effect.flip)).toBeInstanceOf(
            PreviewAutomationClientDisconnectedError,
          );
        } else if (retirement === "success") {
          yield* broker.respond({ ...identity, ok: true, result: undefined });
          yield* Fiber.join(caller);
        } else {
          yield* broker.respond({
            ...identity,
            ok: false,
            error: { _tag: "PreviewAutomationExecutionError", message: "Action failed" },
          });
          expect(yield* Fiber.join(caller).pipe(Effect.flip)).toMatchObject({
            _tag: "PreviewAutomationExecutionError",
          });
        }
        yield* Deferred.await(aborted);
        expect(Exit.isSuccess(yield* Fiber.await(guarded))).toBe(true);
        expect(signal.aborted).toBe(true);
        queuedActions.forEach((action) => action());
        expect(executions).toBe(0);
        yield* broker.respond({ ...identity, ok: true, result: undefined });
        yield* broker.runRequest(identity, () =>
          Effect.sync(() => executions++).pipe(Effect.asVoid),
        );
        expect(executions).toBe(0);
      }),
    ),
);

it.effect("rejects wrong client and connection guards without retiring the valid invocation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, caller, identity } = yield* makeGuardedRequest;
      const wrongIdentities = [
        { ...identity, clientId: "client-other" },
        { ...identity, connectionId: "retired-connection" },
        { ...identity, requestId: "retired-request" },
      ];
      let executions = 0;
      for (const wrongIdentity of wrongIdentities) {
        yield* broker.runRequest(wrongIdentity, () =>
          Effect.sync(() => executions++).pipe(Effect.asVoid),
        );
        yield* broker.respond({ ...wrongIdentity, ok: true, result: "wrong response" });
      }
      expect(executions).toBe(0);
      expect(caller.pollUnsafe()).toBeUndefined();
      yield* broker.runRequest(identity, () =>
        Effect.sync(() => executions++).pipe(
          Effect.andThen(broker.respond({ ...identity, ok: true, result: undefined })),
        ),
      );
      yield* Fiber.join(caller);
      expect(executions).toBe(1);
      yield* broker.runRequest(identity, () => Effect.sync(() => executions++).pipe(Effect.asVoid));
      expect(executions).toBe(1);
    }),
  ),
);

it.effect("preserves the guarded host effect's error channel", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, caller, identity } = yield* makeGuardedRequest;
      const failure = { _tag: "GuardedHostError" as const };
      expect(yield* broker.runRequest(identity, () => Effect.fail(failure)).pipe(Effect.flip)).toBe(
        failure,
      );
      yield* Fiber.interrupt(caller);
    }),
  ),
);

it.effect("guards host work directly at delivery and permits its response", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const connected = yield* Deferred.make<void>();
      let executions = 0;
      yield* Stream.runForEach(
        yield* broker.connect(makeHost(), { disconnectOnTimeout: false }),
        (event) => {
          if (event.type === "connected") return Deferred.succeed(connected, undefined);
          const identity = {
            clientId: "client-1",
            connectionId: event.connectionId,
            requestId: event.request.requestId,
          };
          return broker.runRequest(identity, (remainingTimeoutMs) =>
            Effect.gen(function* () {
              expect(remainingTimeoutMs).toBe(1_000);
              executions++;
              yield* broker.respond({ ...identity, ok: true, result: "executed" });
            }),
          );
        },
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);
      expect(
        yield* broker.invoke<string>({
          scope,
          operation: "click",
          input: {},
          timeoutMs: 1_000,
        }),
      ).toBe("executed");
      expect(executions).toBe(1);
    }),
  ),
);
