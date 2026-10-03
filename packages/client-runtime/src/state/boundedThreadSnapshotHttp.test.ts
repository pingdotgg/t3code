import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as RpcHttp from "../rpc/http.ts";
import * as BoundedThreadSnapshotHttp from "./boundedThreadSnapshotHttp.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: "environment-bounded" as never,
  label: "Bounded",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

const THREAD_ID = ThreadId.make("thread-bounded");
const NOW = "2026-06-20T00:00:00.000Z";

const FULL_SNAPSHOT_BODY = {
  snapshotSequence: 9,
  projection: {
    thread: {
      createdBy: "user",
      creationSource: "web",
      id: String(THREAD_ID),
      projectId: "project-1",
      title: "Full fallback thread",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: String(THREAD_ID),
      },
      forkedFrom: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: NOW,
  },
};

const AT = "2026-06-20T00:00:00.000Z";
const command = (id: string, ordinal: number) => ({
  id,
  type: "command_execution",
  threadId: String(THREAD_ID),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed",
  title: null,
  input: id,
  exitCode: 0,
  startedAt: AT,
  completedAt: AT,
  updatedAt: AT,
});
const LOCAL_ITEMS = [command("local-1", 1), command("local-2", 2)];
const DEPENDENCY = command("older-dependency", 0);
const VISIBLE = LOCAL_ITEMS.map((item, position) => ({
  position,
  visibility: "local",
  sourceThreadId: String(THREAD_ID),
  sourceItemId: item.id,
  item,
}));
const boundedBody = (compact: boolean) => ({
  snapshotSequence: 12,
  projection: {
    ...FULL_SNAPSHOT_BODY.projection,
    turnItems: compact ? [DEPENDENCY] : [...LOCAL_ITEMS, DEPENDENCY],
    visibleTurnItems: VISIBLE,
  },
  historyCursor: "bounded-cursor",
  hasMoreHistory: true,
  latestLocalTurnOrdinal: 2,
  payloadBudgetExceeded: false,
  ...(compact ? { turnItemsOmitLocalVisible: true } : {}),
});

describe("boundedThreadSnapshotLoader", () => {
  it.effect.each([
    ["an older server that ignores the opt-in", false],
    ["a server that sends compact turnItems", true],
  ] as const)("requests compact turnItems and loads %s", ([, compact]) => {
    const urls: string[] = [];
    const fetchFn = ((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(Response.json(boundedBody(compact)));
    }) satisfies typeof fetch;

    return Effect.gen(function* () {
      const loader = yield* ThreadSnapshotLoader.ThreadSnapshotLoader;
      const result = yield* loader.load(PREPARED, THREAD_ID);
      expect(new URL(urls[0]!).searchParams.get("compactTurnItems")).toBe("1");
      expect(result._tag).toBe("present");
      if (result._tag !== "present") return;
      expect(result.snapshot.projection.turnItems.map((item) => String(item.id))).toEqual([
        "local-1",
        "local-2",
        "older-dependency",
      ]);
      expect("turnItemsOmitLocalVisible" in result.snapshot).toBe(false);
      expect(result.history).toEqual({
        historyCursor: "bounded-cursor",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 2,
      });
    }).pipe(
      Effect.provide(
        Layer.provide(boundedThreadSnapshotLoaderLayer, remoteHttpClientLayer(fetchFn)),
      ),
    );
  });

  it.effect("falls back to full HTTP snapshot when bounded returns a plain route 404", () => {
    const fetchFn = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/api/orchestration/threads/${THREAD_ID}/bounded`)) {
        // Generic HTML/route 404: not a structured thread_not_found payload.
        return Promise.resolve(
          new Response("Not Found", {
            status: 404,
            headers: { "content-type": "text/plain" },
          }),
        );
      }
      expect(url).toContain(`/api/orchestration/threads/${THREAD_ID}`);
      expect(url.includes("/bounded")).toBe(false);
      return Promise.resolve(
        new Response(JSON.stringify(FULL_SNAPSHOT_BODY), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) satisfies typeof fetch;

    return Effect.gen(function* () {
      const loader = yield* ThreadSnapshotLoader.ThreadSnapshotLoader;
      const result = yield* loader.load(PREPARED, THREAD_ID);
      expect(result._tag).toBe("present");
      if (result._tag === "present") {
        expect(result.snapshot.snapshotSequence).toBe(9);
        expect(result.snapshot.projection.thread.title).toBe("Full fallback thread");
        expect(result.history).toBeUndefined();
      }
    }).pipe(
      Effect.provide(
        Layer.provide(BoundedThreadSnapshotHttp.layer, RpcHttp.layerRemoteHttpClient(fetchFn)),
      ),
    );
  });

  it.effect("treats structured EnvironmentResourceNotFoundError from bounded as missing", () => {
    const fetchFn = ((input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain(`/api/orchestration/threads/${THREAD_ID}/bounded`);
      return Promise.resolve(
        Response.json(
          {
            _tag: "EnvironmentResourceNotFoundError",
            code: "not_found",
            reason: "thread_not_found",
            traceId: "trace-bounded-missing",
          },
          { status: 404 },
        ),
      );
    }) satisfies typeof fetch;

    return Effect.gen(function* () {
      const loader = yield* ThreadSnapshotLoader.ThreadSnapshotLoader;
      const result = yield* loader.load(PREPARED, THREAD_ID);
      expect(result).toEqual({ _tag: "missing" });
    }).pipe(
      Effect.provide(
        Layer.provide(BoundedThreadSnapshotHttp.layer, RpcHttp.layerRemoteHttpClient(fetchFn)),
      ),
    );
  });

  it.effect("treats structured missing from full fallback as missing", () => {
    let fullCalls = 0;
    const fetchFn = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/bounded")) {
        return Promise.resolve(
          new Response("Not Found", {
            status: 404,
            headers: { "content-type": "text/plain" },
          }),
        );
      }
      fullCalls += 1;
      return Promise.resolve(
        Response.json(
          {
            _tag: "EnvironmentResourceNotFoundError",
            code: "not_found",
            reason: "thread_not_found",
            traceId: "trace-full-missing",
          },
          { status: 404 },
        ),
      );
    }) satisfies typeof fetch;

    return Effect.gen(function* () {
      const loader = yield* ThreadSnapshotLoader.ThreadSnapshotLoader;
      const result = yield* loader.load(PREPARED, THREAD_ID);
      expect(result).toEqual({ _tag: "missing" });
      expect(fullCalls).toBe(1);
    }).pipe(
      Effect.provide(
        Layer.provide(BoundedThreadSnapshotHttp.layer, RpcHttp.layerRemoteHttpClient(fetchFn)),
      ),
    );
  });

  it.effect(
    "uses socket fallback directly when the bounded endpoint has a transient failure",
    () => {
      let fullCalls = 0;
      const fetchFn = ((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/bounded")) {
          return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
        }
        fullCalls += 1;
        return Promise.resolve(
          new Response(JSON.stringify(FULL_SNAPSHOT_BODY), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }) satisfies typeof fetch;

      return Effect.gen(function* () {
        const loader = yield* ThreadSnapshotLoader.ThreadSnapshotLoader;
        const result = yield* loader.load(PREPARED, THREAD_ID);
        expect(result).toEqual({ _tag: "unavailable" });
        expect(fullCalls).toBe(0);
      }).pipe(
        Effect.provide(
          Layer.provide(BoundedThreadSnapshotHttp.layer, RpcHttp.layerRemoteHttpClient(fetchFn)),
        ),
      );
    },
  );
});
