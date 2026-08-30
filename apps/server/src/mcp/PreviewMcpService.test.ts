import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  PREVIEW_MCP_NAV_DIAGNOSTIC_MAX_LENGTH,
  PreviewMcpListResult,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationRequest,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as PreviewManager from "../preview/Manager.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as PreviewMcpService from "./PreviewMcpService.ts";

const environmentId = EnvironmentId.make("environment-preview-mcp");
const decodePreviewMcpListResult = Schema.decodeUnknownSync(PreviewMcpListResult);
const scopeFor = (
  threadId: ThreadId,
  capabilities: McpInvocationContext.McpInvocationScope["capabilities"] = new Set(["preview"]),
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  threadId,
  providerSessionId: `provider-session-${threadId}`,
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities,
  issuedAt: 1,
});

const TestLayer = PreviewMcpService.layer.pipe(
  Layer.provideMerge(PreviewManager.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
);

it.layer(TestLayer)("PreviewMcpService", (it) => {
  it.effect("uses a stable thread-bound cursor when an earlier tab closes", () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const service = yield* PreviewMcpService.PreviewMcpService;
      const currentThreadId = ThreadId.make("thread-preview-paging");
      const foreignThreadId = ThreadId.make("thread-preview-paging-foreign");
      const scope = scopeFor(currentThreadId);
      const opened = yield* Effect.all([
        manager.open({ threadId: currentThreadId }),
        manager.open({ threadId: currentThreadId }),
        manager.open({ threadId: currentThreadId }),
      ]);
      yield* manager.open({ threadId: foreignThreadId });
      const sortedIds = opened.map((session) => session.tabId).toSorted();

      const first = yield* service.list(scope, { limit: 1 });
      expect(first.sessions.map((session) => session.tabId)).toEqual([sortedIds[0]]);
      expect(first.nextCursor).not.toBeNull();

      yield* service.close(scope, { tabId: sortedIds[0]! });
      const second = yield* service.list(scope, {
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.sessions.map((session) => session.tabId)).toEqual([sortedIds[1]]);
      expect(second.sessions.every((session) => session.threadId === currentThreadId)).toBe(true);

      const foreignCursorError = yield* service
        .list(scopeFor(foreignThreadId), { cursor: first.nextCursor! })
        .pipe(Effect.flip);
      expect(foreignCursorError._tag).toBe("PreviewMcpInvalidCursorError");
    }),
  );

  it.effect("keeps long thread ids out of cursors and bounds failed-navigation diagnostics", () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const service = yield* PreviewMcpService.PreviewMcpService;
      const currentThreadId = ThreadId.make(`thread-preview-long-${"x".repeat(4_000)}`);
      const scope = scopeFor(currentThreadId);
      const opened = yield* Effect.all([
        manager.open({ threadId: currentThreadId }),
        manager.open({ threadId: currentThreadId }),
      ]);
      const failed = opened[0]!;
      yield* manager.reportStatus({
        threadId: currentThreadId,
        tabId: failed.tabId,
        navStatus: {
          _tag: "LoadFailed",
          url: "http://localhost:3000",
          title: "Failed preview",
          code: -2,
          description: "diagnostic".repeat(1_000),
        },
        canGoBack: false,
        canGoForward: false,
      });

      const first = yield* service.list(scope, { limit: 1 });
      expect(first.nextCursor?.length).toBeLessThanOrEqual(512);
      const second = yield* service.list(scope, { limit: 1, cursor: first.nextCursor! });
      expect([...first.sessions, ...second.sessions]).toHaveLength(2);
      const failedResult = [...first.sessions, ...second.sessions].find(
        (session) => session.tabId === failed.tabId,
      );
      expect(failedResult?.navStatus._tag).toBe("LoadFailed");
      if (failedResult?.navStatus._tag === "LoadFailed") {
        expect(failedResult.navStatus.description).toHaveLength(
          PREVIEW_MCP_NAV_DIAGNOSTIC_MAX_LENGTH,
        );
        expect(failedResult.navStatus.descriptionTruncated).toBe(true);
      }
      expect(() => decodePreviewMcpListResult(first)).not.toThrow();
      expect(() => decodePreviewMcpListResult(second)).not.toThrow();

      const foreignLongThreadId = ThreadId.make(`thread-preview-other-${"x".repeat(4_000)}`);
      const foreign = yield* service
        .list(scopeFor(foreignLongThreadId), { cursor: first.nextCursor! })
        .pipe(Effect.flip);
      expect(foreign._tag).toBe("PreviewMcpInvalidCursorError");
    }),
  );

  it.effect("closes through manager events and clears the broker's current-tab lease", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* PreviewManager.PreviewManager;
        const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
        const service = yield* PreviewMcpService.PreviewMcpService;
        const currentThreadId = ThreadId.make("thread-preview-close");
        const scope = scopeFor(currentThreadId);
        const opened = yield* manager.open({ threadId: currentThreadId });
        const events = yield* manager.subscribeEvents;
        const requests: PreviewAutomationRequest[] = [];
        const connected = yield* Deferred.make<void>();
        const targetedRequest = yield* Deferred.make<void>();
        const releaseTargetedResponse = yield* Deferred.make<void>();
        const hostEvents = yield* broker.connect({ clientId: "preview-host", environmentId });
        yield* Stream.runForEach(hostEvents, (event) => {
          if (event.type === "connected") return Deferred.succeed(connected, undefined);
          const request = { ...event.request, connectionId: event.connectionId };
          requests.push(request);
          return Effect.gen(function* () {
            if (request.tabId === opened.tabId) {
              yield* Deferred.succeed(targetedRequest, undefined);
              yield* Deferred.await(releaseTargetedResponse);
            }
            yield* broker.respond({
              clientId: "preview-host",
              connectionId: request.connectionId,
              requestId: request.requestId,
              ok: true,
              result: {
                available: true,
                visible: false,
                tabId: request.tabId ?? null,
                url: null,
                title: null,
                loading: false,
              },
            });
          }).pipe(Effect.forkScoped, Effect.asVoid);
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(connected);

        const delayedStatus = yield* broker
          .invoke({ scope, operation: "status", input: {}, tabId: opened.tabId })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(targetedRequest);
        expect(requests.at(-1)?.tabId).toBe(opened.tabId);

        expect(yield* service.close(scope, { tabId: opened.tabId })).toEqual({
          tabId: opened.tabId,
          closed: true,
        });
        const closedEvent = yield* PubSub.take(events);
        expect(closedEvent).toMatchObject({
          type: "closed",
          threadId: currentThreadId,
          tabId: opened.tabId,
        });

        yield* Deferred.succeed(releaseTargetedResponse, undefined);
        yield* Fiber.join(delayedStatus);

        yield* broker.invoke({ scope, operation: "status", input: {} });
        expect(requests.at(-1)?.tabId).toBeUndefined();
        const repeated = yield* service.close(scope, { tabId: opened.tabId }).pipe(Effect.flip);
        expect(repeated._tag).toBe("PreviewSessionLookupError");
      }),
    ),
  );

  it.effect("rejects foreign tabs and credentials without preview access", () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const service = yield* PreviewMcpService.PreviewMcpService;
      const currentThreadId = ThreadId.make("thread-preview-authority");
      const foreignThreadId = ThreadId.make("thread-preview-authority-foreign");
      const scope = scopeFor(currentThreadId);
      const foreign = yield* manager.open({ threadId: foreignThreadId });

      const foreignError = yield* service.close(scope, { tabId: foreign.tabId }).pipe(Effect.flip);
      expect(foreignError._tag).toBe("PreviewSessionLookupError");
      expect((yield* manager.list({ threadId: foreignThreadId })).sessions).toHaveLength(1);

      const deniedScope = scopeFor(currentThreadId, new Set());
      const deniedList = yield* service.list(deniedScope, {}).pipe(Effect.flip);
      expect(deniedList._tag).toBe("PreviewAutomationUnavailableError");
      const deniedClose = yield* service
        .close(deniedScope, { tabId: foreign.tabId })
        .pipe(Effect.flip);
      expect(deniedClose._tag).toBe("PreviewAutomationUnavailableError");
      expect((yield* manager.list({ threadId: foreignThreadId })).sessions).toHaveLength(1);
    }),
  );
});

it.effect("finishes broker cleanup when close is interrupted after manager removal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cleanupEntered = yield* Deferred.make<void>();
      const releaseCleanup = yield* Deferred.make<void>();
      const cleanupCompleted = yield* Ref.make(false);
      const manager = yield* PreviewManager.make;
      const broker = PreviewAutomationBroker.PreviewAutomationBroker.of({
        connect: () => Effect.die("unused"),
        focusHost: () => Effect.die("unused"),
        respond: () => Effect.die("unused"),
        invoke: () => Effect.die("unused"),
        forgetClosedTab: () =>
          Deferred.succeed(cleanupEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseCleanup)),
            Effect.andThen(Ref.set(cleanupCompleted, true)),
          ),
      });
      const service = yield* PreviewMcpService.make.pipe(
        Effect.provideService(PreviewManager.PreviewManager, manager),
        Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
      );
      const threadId = ThreadId.make("thread-preview-interrupted-close");
      const scope = scopeFor(threadId);
      const opened = yield* manager.open({ threadId });
      const closeFiber = yield* service
        .close(scope, { tabId: opened.tabId })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(cleanupEntered);
      expect((yield* manager.list({ threadId })).sessions).toHaveLength(0);

      const interruption = yield* Fiber.interrupt(closeFiber).pipe(Effect.forkScoped);
      yield* Deferred.succeed(releaseCleanup, undefined);
      yield* Fiber.join(interruption);
      expect(yield* Ref.get(cleanupCompleted)).toBe(true);
      const repeated = yield* service.close(scope, { tabId: opened.tabId }).pipe(Effect.flip);
      expect(repeated._tag).toBe("PreviewSessionLookupError");
    }),
  ),
);
