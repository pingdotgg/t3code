import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { MuseSdkHost } from "../provider/museSdk.ts";
import { makeMuseSessionImport, type MuseImportSession } from "./MuseSessionImport.ts";

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const instance = {
  instanceId: ProviderInstanceId.make("muse_work"),
  binaryPath: "/fake/muse",
  environment: { HOME: "/fake/account" },
};
const session: MuseImportSession = {
  sessionId: SESSION_ID,
  path: `/fake/muse-home/sessions/2026/09/11/${SESSION_ID}/session.jsonl`,
  workspaceRoot: "/work/project",
  modelId: "muse-spark-1.3-contributor",
  providerId: "meta",
  createdAt: "2026-09-11T10:00:00.000Z",
  updatedAt: "2026-09-11T10:01:00.000Z",
};
const limits = { records: 100, historyBytes: 1024, messages: 3 };
const event = (
  itemId: string,
  kind: "userMessage" | "agentMessage",
  text: string,
  extra: Record<string, unknown> = {},
) => ({
  method: "item/completed",
  params: {
    sessionId: SESSION_ID,
    item: {
      itemId,
      kind,
      text,
      status: "completed",
      revision: 1,
      ...extra,
    },
  },
});
const modelEvent = (
  method: "session/tokenUsage" | "session/modelChanged",
  modelId: string,
  extra: Record<string, unknown> = {},
) => ({ method, params: { sessionId: SESSION_ID, modelId, ...extra } });

function makeMuseImportHost(
  request: MuseSdkHost["connection"]["request"],
  museHome = "/fake/muse-home",
): MuseSdkHost {
  return {
    initializeResult: {
      experimentalApi: false,
      grantedCapabilities: [],
      museHome,
      platformFamily: "unix",
      platformOs: "linux",
      schema: { fingerprint: "test", version: 1 },
      serverInfo: { name: "muse", version: "1.1.1" },
      userAgent: "test",
    },
    connection: {
      request,
      command: vi.fn(async () => ({})),
      mintCommandId: () => "unused",
      onNotification: () => {},
      onServerRequest: () => {},
      onProtocolError: () => {},
      closed: new Promise(() => {}),
    },
    exited: new Promise(() => {}),
    close: vi.fn(async () => {}),
  };
}
const historyHost = (
  pages: ReadonlyArray<Record<string, unknown>>,
  metadata: Record<string, unknown> = {},
) => {
  let pageIndex = 0;
  return makeMuseImportHost(
    vi.fn(async (method) => {
      if (method === "session/read")
        return {
          session: { ...session, ...metadata },
          history: { mode: "none", noneReason: "excluded", snapshot: null },
        };
      if (method === "view/page") return pages[pageIndex++]!;
      throw new Error(`Unexpected request ${method}`);
    }),
  );
};

it.layer(NodeServices.layer)("Muse session import", (it) => {
  it.effect("lists root Meta sessions with bounded pagination and closes its read-only host", () =>
    Effect.gen(function* () {
      const request = vi.fn(async (_method: string, params?: Record<string, unknown>) =>
        params?.cursor
          ? { sessions: [session], nextCursor: null }
          : {
              sessions: [
                { ...session, providerId: null },
                { ...session, providerId: "other" },
                { ...session, path: "" },
                {
                  ...session,
                  path: `/fake/muse-home/sessions/2026/09/11/parent/subagent/${SESSION_ID}/session.jsonl`,
                },
              ],
              nextCursor: "page-2",
            },
      );
      const host = makeMuseImportHost(request);
      const createHost = vi.fn(async () => host);
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const reader = yield* makeMuseSessionImport(createHost);
          return yield* reader.list(instance, 10);
        }),
      );
      expect(result).toEqual({ sessions: [session], truncated: false });
      expect(request).toHaveBeenNthCalledWith(2, "session/list", { cursor: "page-2", limit: 6 });
      expect(createHost).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          binaryPath: instance.binaryPath,
          environment: instance.environment,
          readOnly: true,
          sessionLogging: true,
        }),
      );
      expect(host.close).toHaveBeenCalledOnce();
      expect(host.connection.command).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    "folds message revisions and retractions across pages and retains a first prompt plus recent history",
    () =>
      Effect.gen(function* () {
        const host = historyHost([
          {
            events: [
              event("u1", "userMessage", "first"),
              event("a1", "agentMessage", "draft"),
              event("gone", "userMessage", "retracted"),
            ],
            nextCursor: "page-2",
          },
          {
            events: [
              event("a1", "agentMessage", "final", { revision: 2, recordedAt: session.updatedAt }),
              event("a1", "agentMessage", "stale"),
              event("gone", "userMessage", "retracted", { revision: 2, retracted: true }),
              event("u2", "userMessage", "second"),
              event("a2", "agentMessage", "second answer"),
              modelEvent("session/tokenUsage", "muse-spark-1.3-contributor"),
            ],
            nextCursor: null,
          },
        ]);
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const reader = yield* makeMuseSessionImport(async () => host);
            return yield* reader.read(instance, SESSION_ID, limits);
          }),
        );
        expect(result.messages.map((message) => message.text)).toEqual([
          "first",
          "second",
          "second answer",
        ]);
        expect(result.title).toBe("first");
        expect(result.recordCount).toBe(9);
        expect(result.messages[0]?.createdAt).toBe(session.createdAt);
        expect(host.close).toHaveBeenCalledOnce();
      }),
  );

  it.effect("uses effective Contributor usage instead of normalized base-model metadata", () =>
    Effect.gen(function* () {
      const host = historyHost(
        [
          {
            events: [
              event("u", "userMessage", "first"),
              event("a", "agentMessage", "answer"),
              modelEvent("session/tokenUsage", "muse-spark-1.2"),
              modelEvent("session/tokenUsage", "muse-spark-1.3-contributor"),
            ],
            nextCursor: null,
          },
        ],
        { modelId: "muse-spark-1.3" },
      );
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const reader = yield* makeMuseSessionImport(async () => host);
          return yield* reader.read(instance, SESSION_ID, limits);
        }),
      );
      expect(result.session.modelId).toBe("muse-spark-1.3-contributor");
      expect(result.messages.map((message) => message.text)).toEqual(["first", "answer"]);
      expect(host.connection.command).not.toHaveBeenCalled();
      expect(host.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect("preserves the latest explicit model selection over late previous-turn usage", () =>
    Effect.gen(function* () {
      const host = historyHost([
        {
          events: [
            event("u", "userMessage", "first"),
            modelEvent("session/modelChanged", "muse-spark-1.3-contributor", {
              providerId: "meta",
            }),
          ],
          nextCursor: "more",
        },
        {
          events: [
            modelEvent("session/modelChanged", "muse-spark-1.3", { providerId: "meta" }),
            modelEvent("session/tokenUsage", "muse-spark-1.3-contributor"),
          ],
          nextCursor: null,
        },
      ]);
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const reader = yield* makeMuseSessionImport(async () => host);
          return yield* reader.read(instance, SESSION_ID, limits);
        }),
      );
      expect(result.session.modelId).toBe("muse-spark-1.3");
      expect(host.close).toHaveBeenCalledOnce();
    }),
  );

  for (const [label, pages, budget] of [
    [
      "unverifiable effective model",
      [{ events: [event("u", "userMessage", "first")], nextCursor: null }],
      limits,
    ],
    [
      "invalid effective model",
      [
        {
          events: [event("u", "userMessage", "first"), modelEvent("session/tokenUsage", " ")],
          nextCursor: null,
        },
      ],
      limits,
    ],
    [
      "foreign model usage",
      [
        {
          events: [
            event("u", "userMessage", "first"),
            modelEvent("session/tokenUsage", "muse-spark-1.3-contributor", {
              sessionId: "child-session",
            }),
          ],
          nextCursor: null,
        },
      ],
      limits,
    ],
    [
      "foreign model provider",
      [
        {
          events: [
            event("u", "userMessage", "first"),
            modelEvent("session/modelChanged", "another-model", { providerId: "other" }),
          ],
          nextCursor: null,
        },
      ],
      limits,
    ],
    [
      "record limit",
      [{ events: [event("u", "userMessage", "first")], nextCursor: "more" }],
      { ...limits, records: 1 },
    ],
    [
      "text limit",
      [{ events: [event("u", "userMessage", "larger than budget")], nextCursor: null }],
      { ...limits, historyBytes: 4 },
    ],
    [
      "truncated message",
      [
        {
          events: [
            event("u", "userMessage", "first"),
            event("a", "agentMessage", "partial", { truncated: true }),
          ],
          nextCursor: null,
        },
      ],
      limits,
    ],
    [
      "stalled cursor",
      [
        { events: [event("u", "userMessage", "first")], nextCursor: "same" },
        { events: [], nextCursor: "same" },
      ],
      limits,
    ],
    [
      "foreign session",
      [
        {
          events: [{ ...event("u", "userMessage", "first"), params: { sessionId: "another" } }],
          nextCursor: null,
        },
      ],
      limits,
    ],
  ] as const) {
    it.effect(`rejects ${label} and releases the host`, () =>
      Effect.gen(function* () {
        const host = historyHost(pages);
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const reader = yield* makeMuseSessionImport(async () => host);
            return yield* reader.read(instance, SESSION_ID, budget);
          }),
        ).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(host.close).toHaveBeenCalledOnce();
      }),
    );
  }

  it.effect("reuses a host within one import and rejects unknown schemas before reading", () =>
    Effect.gen(function* () {
      const host = makeMuseImportHost(
        vi.fn(async () => ({ sessions: [session], nextCursor: null })),
      );
      const createHost = vi.fn(async () => host);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reader = yield* makeMuseSessionImport(createHost);
          yield* reader.list(instance, 10);
          yield* reader.list(instance, 10);
        }),
      );
      expect(createHost).toHaveBeenCalledOnce();
      expect(host.close).toHaveBeenCalledOnce();
      const unsupported = {
        ...host,
        initializeResult: { ...host.initializeResult, schema: { fingerprint: "new", version: 2 } },
      };
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const reader = yield* makeMuseSessionImport(async () => unsupported);
          return yield* reader.list(instance, 10);
        }),
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }),
  );
});
