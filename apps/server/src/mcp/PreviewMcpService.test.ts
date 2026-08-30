import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationRequest,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as PreviewManager from "../preview/Manager.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as PreviewMcpService from "./PreviewMcpService.ts";

const environmentId = EnvironmentId.make("environment-preview-mcp");
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
        const hostEvents = yield* broker.connect({ clientId: "preview-host", environmentId });
        const requestEvents = hostEvents.pipe(
          Stream.filterMap((event) =>
            event.type === "request"
              ? Result.succeed({ ...event.request, connectionId: event.connectionId })
              : Result.failVoid,
          ),
        );
        yield* Stream.runForEach(requestEvents, (request) => {
          requests.push(request);
          return broker.respond({
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
        }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        yield* broker.invoke({ scope, operation: "status", input: {}, tabId: opened.tabId });
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
