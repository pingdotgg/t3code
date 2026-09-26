import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ExtensionOperationError,
  ProjectId,
  ThreadId,
  extensionWorkspaceRevision,
} from "@t3tools/contracts";
import {
  BROWSER_OPERATE,
  BROWSER_SESSIONS,
  browserSessionsApi,
  type BrowserSessionStreamValue,
} from "@t3tools/extension-sdk/catalogue";
import type { ApiStreamEvent } from "@t3tools/extension-sdk/capabilities";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import type {
  HostApiInvocationMetadata,
  HostApiProvider,
  HostApiRootAuthority,
} from "@t3tools/extension-runtime";
import { createExtensionRuntime } from "@t3tools/extension-runtime";
import { it, expect, describe } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProcessRunner from "../../processRunner.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import { createBrowserSessionsApiProvider } from "./v1.ts";

const isOperationError = Schema.is(ExtensionOperationError);
const signal = new AbortController().signal;
const ENV_ID = "env";
const PROJECT_ID = "project";
const THREAD_ID = "thread";
const WORKSPACE = "/repo/workspace";

class InvokeRejection extends Data.TaggedError("InvokeRejection")<{
  readonly cause: unknown;
}> {}

const context = (
  threadId: string | null = THREAD_ID,
  environmentId = ENV_ID,
  projectId: string | null = PROJECT_ID,
): ViewContext => ({
  resource: {
    namespace: "test.extension",
    id: "view",
    environmentId,
    ...(projectId === null ? {} : { projectId }),
    ...(threadId === null ? {} : { threadId }),
  },
  client: "test",
  workspaceRevision: extensionWorkspaceRevision(WORKSPACE, null),
});

const meta = (
  provider: HostApiProvider,
  options: {
    readonly scopes?: readonly string[];
    readonly environmentId?: string;
    readonly assertAuthority?: () => Promise<void>;
    readonly omitAuthority?: boolean;
    readonly omitPrincipal?: boolean;
  } = {},
): HostApiInvocationMetadata => ({
  callId: "call",
  rootCallerId: "root",
  callerId: "caller",
  providerId: provider.providerId,
  providerGeneration: 1,
  callerGenerations: [],
  ...(options.omitPrincipal === true
    ? {}
    : {
        principal: {
          kind: "environment-session" as const,
          id: "session",
          environmentId: options.environmentId ?? ENV_ID,
          scopes: options.scopes ?? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        },
      }),
  ...(options.omitAuthority === true
    ? {}
    : { assertAuthority: options.assertAuthority ?? (async () => {}) }),
});

interface ThreadRow {
  readonly projectId: string;
  readonly worktreePath: string | null;
  readonly deletedAt: string | null;
}

const makeThreads = (rows: Record<string, ThreadRow>) => ({
  getById: (input: { readonly threadId: ThreadId }) =>
    Effect.succeed(
      Option.fromNullishOr(rows[input.threadId]).pipe(
        Option.map((row) => ({
          projectId: ProjectId.make(row.projectId),
          worktreePath: row.worktreePath,
          deletedAt: row.deletedAt,
        })),
      ),
    ),
});

const defaultThreads = makeThreads({
  [THREAD_ID]: { projectId: PROJECT_ID, worktreePath: null, deletedAt: null },
  foreign: { projectId: "other-project", worktreePath: null, deletedAt: null },
  deleted: { projectId: PROJECT_ID, worktreePath: null, deletedAt: "2026-09-14T00:00:00.000Z" },
});

const makeDeps = (
  preview: PreviewManager.PreviewManager["Service"],
  overrides: {
    readonly threads?: ReturnType<typeof makeThreads>;
  } = {},
) => ({
  environmentId: ENV_ID,
  projects: {
    getById: () =>
      Effect.succeedSome({
        projectId: ProjectId.make(PROJECT_ID),
        workspaceRoot: WORKSPACE,
        deletedAt: null,
      }),
  },
  threads: overrides.threads ?? defaultThreads,
  preview,
});

/** A real PreviewManager under test — provenance semantics are the point. */
const harness = Effect.gen(function* () {
  const preview = yield* PreviewManager.PreviewManager;
  const provider = createBrowserSessionsApiProvider(makeDeps(preview));
  return { preview, provider };
}).pipe(Effect.provide(PreviewManager.layer));

const invoke = (
  provider: HostApiProvider,
  method: string,
  input: unknown,
  ctx = context(),
  metadata?: HostApiInvocationMetadata,
) =>
  Effect.tryPromise({
    try: () =>
      Promise.resolve(
        provider.invoke(method, input as never, ctx, signal, metadata ?? meta(provider)),
      ),
    catch: (cause) => new InvokeRejection({ cause }),
  });

const invokeError = (...args: Parameters<typeof invoke>) =>
  invoke(...args).pipe(
    Effect.flip,
    Effect.map((rejection) => {
      if (!isOperationError(rejection.cause)) throw rejection.cause;
      return rejection.cause;
    }),
  );

const eventValue = (event: ApiStreamEvent): BrowserSessionStreamValue =>
  event.value as BrowserSessionStreamValue;

describe("browser sessions adapter", () => {
  it.effect("requires authority before any read", () =>
    Effect.gen(function* () {
      const { provider } = yield* harness;
      const denied = yield* invokeError(
        provider,
        "list",
        {},
        context(),
        meta(provider, { omitPrincipal: true }),
      );
      expect(denied.detail).toContain("authority");
      const missingAssert = yield* invokeError(
        provider,
        "list",
        {},
        context(),
        meta(provider, { omitAuthority: true }),
      );
      expect(missingAssert.detail).toContain("authority");
      const revoked = yield* invokeError(
        provider,
        "list",
        {},
        context(),
        meta(provider, {
          assertAuthority: async () => {
            throw new Error("revoked");
          },
        }),
      );
      expect(revoked.detail).toContain("revoked");
    }),
  );

  it.effect("denies writes to a read-only principal", () =>
    Effect.gen(function* () {
      const { provider } = yield* harness;
      const error = yield* invokeError(
        provider,
        "open",
        {},
        context(),
        meta(provider, { scopes: [AuthOrchestrationReadScope] }),
      );
      expect(error.detail).toContain("authority");
    }),
  );

  it.effect("denies a principal from a foreign environment", () =>
    Effect.gen(function* () {
      const { provider } = yield* harness;
      const error = yield* invokeError(
        provider,
        "list",
        {},
        context(),
        meta(provider, { environmentId: "other-env" }),
      );
      expect(error.detail).toContain("authority");
    }),
  );

  it.effect("rejects a foreign environment context", () =>
    Effect.gen(function* () {
      const { provider } = yield* harness;
      const error = yield* invokeError(provider, "list", {}, context(THREAD_ID, "other-env"));
      expect(error.detail).toContain("environment");
    }),
  );

  it.effect("rejects a foreign project context", () =>
    Effect.gen(function* () {
      const { provider } = yield* harness;
      // Thread resolves to project-a... projectId mismatch is a scope failure.
      const error = yield* invokeError(
        provider,
        "list",
        {},
        context(THREAD_ID, ENV_ID, "other-project"),
      );
      expect(error.detail).toContain("project");
    }),
  );

  it.effect("rejects a deleted thread scope", () =>
    Effect.gen(function* () {
      const { provider } = yield* harness;
      const error = yield* invokeError(provider, "list", {}, context("deleted"));
      expect(error.detail).toContain("thread");
    }),
  );

  it.effect("rejects a missing thread scope", () =>
    Effect.gen(function* () {
      const { provider } = yield* harness;
      const error = yield* invokeError(provider, "list", {}, context("missing"));
      expect(error.detail).toContain("thread");
    }),
  );

  it.effect("rejects a context without a thread", () =>
    Effect.gen(function* () {
      const { provider } = yield* harness;
      const error = yield* invokeError(provider, "list", {}, context(null));
      expect(error.detail).toContain("thread");
    }),
  );

  it.effect("declares the read/write grant split on every member", () =>
    Effect.sync(() => {
      const definition = browserSessionsApi.definition;
      const writes = new Set([
        "open",
        "navigate",
        "close",
        "back",
        "forward",
        "reload",
        "hardReload",
        "resize",
        "zoom",
        "setAppearance",
        "setAudioMuted",
      ]);
      for (const method of definition.methods ?? []) {
        expect(method.requiredGrants).toEqual(
          writes.has(method.name) ? [BROWSER_SESSIONS, BROWSER_OPERATE] : [BROWSER_SESSIONS],
        );
      }
      expect(definition.streams?.[0]?.requiredGrants).toEqual([BROWSER_SESSIONS]);
    }),
  );

  it.effect("getCapabilities reports metadata support and desktop-required presentation", () =>
    Effect.gen(function* () {
      const { provider } = yield* harness;
      const capabilities = (yield* invoke(provider, "getCapabilities", {})) as {
        readonly metadata: { readonly supported: boolean };
        readonly presentation: { readonly supported: boolean; readonly reason?: string };
        readonly commands: readonly string[];
      };
      expect(capabilities.metadata.supported).toBe(true);
      expect(capabilities.presentation).toEqual({
        supported: false,
        reason: "desktop-required",
      });
      // Only verbs with real dispatch are advertised; the rest fail by name.
      expect(capabilities.commands).toEqual(["resize"]);
    }),
  );

  it.effect("unary reads reject excess input properties by name", () =>
    Effect.gen(function* () {
      const { provider } = yield* harness;
      for (const method of ["getCapabilities", "list"]) {
        const error = yield* invokeError(provider, method, { unexpected: true });
        expect(error.detail).toContain("BrowserSessionInputError");
      }
    }),
  );

  it.effect("open then list projects real manager state with honest pending navigation", () =>
    Effect.gen(function* () {
      const { provider } = yield* harness;
      const opened = (yield* invoke(provider, "open", {
        url: "localhost:5173",
      })) as {
        readonly outcome: string;
        readonly serverEpoch: string;
        readonly revision: number;
        readonly session: {
          readonly tabId: string;
          readonly requestedUrl: string | null;
          readonly navigation: { readonly kind: string; readonly url: string | null };
          readonly engine: { readonly state: string; readonly generation: string | null };
        };
      };
      expect(opened.outcome).toBe("accepted");
      // Dispatch acceptance is not a load: the engine has not reported.
      expect(opened.session.navigation.kind).toBe("pending");
      expect(opened.session.requestedUrl).toBe("http://localhost:5173/");
      expect(opened.session.engine).toEqual({
        state: "unavailable",
        generation: null,
        reason: "desktop-required",
      });
      const listed = (yield* invoke(provider, "list", {})) as {
        readonly serverEpoch: string;
        readonly sessions: readonly { readonly tabId: string }[];
      };
      expect(listed.serverEpoch).toBe(opened.serverEpoch);
      expect(listed.sessions.map((s) => s.tabId)).toEqual([opened.session.tabId]);
    }),
  );

  it.effect("navigate acceptance never projects as loaded until the engine reports", () =>
    Effect.gen(function* () {
      const { provider, preview } = yield* harness;
      const opened = (yield* invoke(provider, "open", {})) as {
        readonly serverEpoch: string;
        readonly session: { readonly tabId: string };
      };
      const navigated = (yield* invoke(provider, "navigate", {
        tabId: opened.session.tabId,
        serverEpoch: opened.serverEpoch,
        url: "localhost:5173",
        expectedEngineGeneration: null,
      })) as {
        readonly outcome: string;
        readonly session: { readonly navigation: { readonly kind: string } };
      };
      expect(navigated.outcome).toBe("accepted");
      // Native navigate sets navStatus Success immediately — the public
      // projection must still say pending because the engine has not reported.
      expect(navigated.session.navigation.kind).toBe("pending");

      yield* preview.reportStatus({
        threadId: ThreadId.make(THREAD_ID),
        tabId: opened.session.tabId,
        navStatus: { _tag: "Loading", url: "http://localhost:5173/", title: "" },
        canGoBack: false,
        canGoForward: false,
      });
      const afterReport = (yield* invoke(provider, "list", {})) as {
        readonly sessions: readonly {
          readonly navigation: { readonly kind: string; readonly url: string | null };
        }[];
      };
      expect(afterReport.sessions[0]?.navigation.kind).toBe("loading");

      yield* preview.reportStatus({
        threadId: ThreadId.make(THREAD_ID),
        tabId: opened.session.tabId,
        navStatus: { _tag: "Success", url: "http://localhost:5173/", title: "Dev" },
        canGoBack: true,
        canGoForward: false,
      });
      const loaded = (yield* invoke(provider, "list", {})) as {
        readonly sessions: readonly {
          readonly navigation: {
            readonly kind: string;
            readonly url: string | null;
            readonly title: string;
          };
          readonly canGoBack: boolean;
        }[];
      };
      expect(loaded.sessions[0]?.navigation).toEqual({
        kind: "loaded",
        url: "http://localhost:5173/",
        title: "Dev",
      });
      expect(loaded.sessions[0]?.canGoBack).toBe(true);
    }),
  );

  it.effect("engine-reported failure projects the closed failure enum, never native strings", () =>
    Effect.gen(function* () {
      const { provider, preview } = yield* harness;
      const opened = (yield* invoke(provider, "open", { url: "localhost:9" })) as {
        readonly session: { readonly tabId: string };
      };
      yield* preview.reportStatus({
        threadId: ThreadId.make(THREAD_ID),
        tabId: opened.session.tabId,
        navStatus: {
          _tag: "LoadFailed",
          url: "http://localhost:9/",
          title: "",
          code: -105,
          description: "net::ERR_NAME_NOT_RESOLVED with internal details",
        },
        canGoBack: false,
        canGoForward: false,
      });
      const listed = (yield* invoke(provider, "list", {})) as {
        readonly sessions: readonly {
          readonly navigation: {
            readonly kind: string;
            readonly failureCode?: string;
          };
        }[];
      };
      const navigation = listed.sessions[0]?.navigation;
      expect(navigation?.kind).toBe("failed");
      expect(navigation?.failureCode).toBe("dns");
      // The native Chromium description never crosses the boundary.
      expect(Object.keys(navigation ?? {})).not.toContain("description");
    }),
  );

  it.effect("stale server epoch is a named error, never already-closed", () =>
    Effect.gen(function* () {
      const { provider } = yield* harness;
      const opened = (yield* invoke(provider, "open", {})) as {
        readonly serverEpoch: string;
        readonly session: { readonly tabId: string };
      };
      const stale = yield* invokeError(provider, "close", {
        tabId: opened.session.tabId,
        serverEpoch: "not-the-epoch",
      });
      expect(stale.detail).toContain("BrowserStaleServerEpoch");
      const staleNavigate = yield* invokeError(provider, "navigate", {
        tabId: opened.session.tabId,
        serverEpoch: "not-the-epoch",
        url: "localhost:5173",
        expectedEngineGeneration: null,
      });
      expect(staleNavigate.detail).toContain("BrowserStaleServerEpoch");
    }),
  );

  it.effect("a non-null engine generation expectation fails by name", () =>
    Effect.gen(function* () {
      const { provider } = yield* harness;
      const opened = (yield* invoke(provider, "open", {})) as {
        readonly serverEpoch: string;
        readonly session: { readonly tabId: string };
      };
      const error = yield* invokeError(provider, "navigate", {
        tabId: opened.session.tabId,
        serverEpoch: opened.serverEpoch,
        url: "localhost:5173",
        expectedEngineGeneration: "gen-7",
      });
      expect(error.detail).toContain("BrowserStaleEngineGeneration");
    }),
  );

  it.effect("close is idempotent within the epoch and removes the session", () =>
    Effect.gen(function* () {
      const { provider } = yield* harness;
      const opened = (yield* invoke(provider, "open", {})) as {
        readonly serverEpoch: string;
        readonly session: { readonly tabId: string };
      };
      const closed = (yield* invoke(provider, "close", {
        tabId: opened.session.tabId,
        serverEpoch: opened.serverEpoch,
      })) as { readonly outcome: string };
      expect(closed.outcome).toBe("closed");
      const again = (yield* invoke(provider, "close", {
        tabId: opened.session.tabId,
        serverEpoch: opened.serverEpoch,
      })) as { readonly outcome: string };
      expect(again.outcome).toBe("already-closed");
    }),
  );

  it.effect("navigate on a missing tab fails with BrowserSessionNotFound", () =>
    Effect.gen(function* () {
      const { provider } = yield* harness;
      const listed = (yield* invoke(provider, "list", {})) as {
        readonly serverEpoch: string;
      };
      const error = yield* invokeError(provider, "navigate", {
        tabId: "tab_missing",
        serverEpoch: listed.serverEpoch,
        url: "localhost:5173",
        expectedEngineGeneration: null,
      });
      expect(error.detail).toContain("BrowserSessionNotFound");
    }),
  );

  it.effect("resize dispatches through the manager and enforces viewport bounds", () =>
    Effect.gen(function* () {
      const { provider } = yield* harness;
      const opened = (yield* invoke(provider, "open", {})) as {
        readonly serverEpoch: string;
        readonly session: { readonly tabId: string };
      };
      const resized = (yield* invoke(provider, "resize", {
        tabId: opened.session.tabId,
        serverEpoch: opened.serverEpoch,
        expectedEngineGeneration: null,
        viewport: { _tag: "freeform", width: 1024, height: 768 },
      })) as {
        readonly outcome: string;
        readonly session: { readonly viewport: unknown };
      };
      expect(resized.outcome).toBe("accepted");
      expect(resized.session.viewport).toEqual({
        _tag: "freeform",
        width: 1024,
        height: 768,
      });
      const overArea = yield* invokeError(provider, "resize", {
        tabId: opened.session.tabId,
        serverEpoch: opened.serverEpoch,
        expectedEngineGeneration: null,
        viewport: { _tag: "freeform", width: 3840, height: 3840 },
      });
      expect(overArea.detail).toContain("BrowserSessionInputError");
    }),
  );

  it.effect("commands without engine dispatch fail by name, never silently accepted", () =>
    Effect.gen(function* () {
      const { provider } = yield* harness;
      const opened = (yield* invoke(provider, "open", {})) as {
        readonly serverEpoch: string;
        readonly session: { readonly tabId: string };
      };
      for (const method of [
        "back",
        "forward",
        "reload",
        "hardReload",
        "zoom",
        "setAppearance",
        "setAudioMuted",
      ]) {
        const extra =
          method === "zoom"
            ? { zoomFactor: 1.5 }
            : method === "setAppearance"
              ? { appearance: "dark" }
              : method === "setAudioMuted"
                ? { muted: true }
                : {};
        const error = yield* invokeError(provider, method, {
          tabId: opened.session.tabId,
          serverEpoch: opened.serverEpoch,
          expectedEngineGeneration: null,
          ...extra,
        });
        expect(error.detail).toContain("BrowserSessionCommandUnsupported");
      }
      // Verb-specific schema still applies before the unsupported error.
      const badZoom = yield* invokeError(provider, "zoom", {
        tabId: opened.session.tabId,
        serverEpoch: opened.serverEpoch,
        expectedEngineGeneration: null,
        zoomFactor: 99,
      });
      expect(badZoom.detail).toContain("BrowserSessionInputError");
    }),
  );

  it.effect("open fails with BrowserSessionLimitExceeded at the session cap", () =>
    Effect.gen(function* () {
      const { provider, preview } = yield* harness;
      const threadId = ThreadId.make(THREAD_ID);
      for (let index = 0; index < 64; index += 1) {
        yield* preview.open({ threadId });
      }
      const error = yield* invokeError(provider, "open", {});
      expect(error.detail).toContain("BrowserSessionLimitExceeded");
      // 64 is inside the cap — list must still succeed, never a partial lie.
      const listed = (yield* invoke(provider, "list", {})) as {
        readonly sessions: readonly unknown[];
      };
      expect(listed.sessions).toHaveLength(64);
    }),
  );

  it.effect("list enforces the session cap with a named error", () =>
    Effect.gen(function* () {
      yield* harness;
      const oversized = createBrowserSessionsApiProvider(
        makeDeps({
          listDetails: () =>
            Effect.succeed({
              sessions: Array.from({ length: 65 }, (_, index) => ({
                snapshot: {
                  threadId: THREAD_ID,
                  tabId: `tab-${index}`,
                  navStatus: { _tag: "Idle" as const },
                  canGoBack: false,
                  canGoForward: false,
                  updatedAt: "2026-09-14T00:00:00.000Z",
                },
                navigation: {
                  requestedUrl: null,
                  requestRevision: null,
                  engineRevision: null,
                },
              })),
              serverEpoch: "epoch-1",
              revision: 0,
            }),
        } as never),
      );
      const error = yield* invokeError(oversized, "list", {});
      expect(error.detail).toContain("BrowserSessionLimitExceeded");
    }),
  );

  it.effect("streams a complete first snapshot then live upserts", () =>
    Effect.gen(function* () {
      const { provider, preview } = yield* harness;
      const threadId = ThreadId.make(THREAD_ID);
      // Sessions opened before the first pull land inside the snapshot.
      yield* preview.open({ threadId, url: "http://localhost:5173" });
      const iterable = provider.subscribe!(
        "events",
        {},
        context(),
        signal,
        meta(provider, { scopes: [AuthOrchestrationReadScope] }),
      );
      const iterator = iterable[Symbol.asyncIterator]();
      try {
        const first = yield* Effect.promise(() => iterator.next());
        expect(eventValue(first.value!).kind).toBe("snapshot-start");
        const second = yield* Effect.promise(() => iterator.next());
        const kinds: string[] = [eventValue(second.value!).kind];
        // Drain until snapshot-complete.
        while (kinds.at(-1) !== "snapshot-complete") {
          const next = yield* Effect.promise(() => iterator.next());
          kinds.push(eventValue(next.value!).kind);
        }
        // The pre-subscribe open is inside the snapshot, not replayed as an
        // upsert after the boundary.
        expect(kinds).not.toContain("session-upsert");
        yield* preview.open({ threadId, url: "http://localhost:3000" });
        const live = yield* Effect.promise(() => iterator.next());
        const liveValue = eventValue(live.value!);
        expect(liveValue.kind).toBe("session-upsert");
        if (liveValue.kind === "session-upsert") {
          expect(liveValue.session.requestedUrl).toBe("http://localhost:3000/");
          expect(liveValue.session.navigation.kind).toBe("pending");
        }
      } finally {
        yield* Effect.promise(() => iterator.return!());
      }
    }),
  );

  it.effect("session-removed is ordinary data and never terminates the stream", () =>
    Effect.gen(function* () {
      const { provider, preview } = yield* harness;
      const threadId = ThreadId.make(THREAD_ID);
      const iterable = provider.subscribe!(
        "events",
        {},
        context(),
        signal,
        meta(provider, { scopes: [AuthOrchestrationReadScope] }),
      );
      const iterator = iterable[Symbol.asyncIterator]();
      try {
        // Complete the snapshot handshake.
        for (;;) {
          const next = yield* Effect.promise(() => iterator.next());
          if (eventValue(next.value!).kind === "snapshot-complete") break;
        }
        const doomed = yield* preview.open({ threadId });
        const upsert = yield* Effect.promise(() => iterator.next());
        expect(eventValue(upsert.value!).kind).toBe("session-upsert");
        yield* preview.close({ threadId, tabId: doomed.tabId });
        const removed = yield* Effect.promise(() => iterator.next());
        const removedValue = eventValue(removed.value!);
        expect(removedValue.kind).toBe("session-removed");
        if (removedValue.kind === "session-removed") {
          expect(removedValue.tabId).toBe(doomed.tabId);
          expect(removedValue.reason).toBe("user-closed");
        }
        // The stream stays alive: another session still produces an upsert.
        yield* preview.open({ threadId });
        const again = yield* Effect.promise(() => iterator.next());
        expect(eventValue(again.value!).kind).toBe("session-upsert");
      } finally {
        yield* Effect.promise(() => iterator.return!());
      }
    }),
  );

  it.effect("thread deletion delivers session-removed:thread-deleted then closes", () =>
    Effect.gen(function* () {
      const { preview } = yield* harness;
      const threadId = ThreadId.make(THREAD_ID);
      const doomed = yield* preview.open({ threadId });
      const rows: Record<string, ThreadRow> = {
        [THREAD_ID]: { projectId: PROJECT_ID, worktreePath: null, deletedAt: null },
      };
      const provider = createBrowserSessionsApiProvider(
        makeDeps(preview, { threads: makeThreads(rows) }),
      );
      const iterable = provider.subscribe!(
        "events",
        {},
        context(),
        signal,
        meta(provider, { scopes: [AuthOrchestrationReadScope] }),
      );
      const iterator = iterable[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = yield* Effect.promise(() => iterator.next());
          if (eventValue(next.value!).kind === "snapshot-complete") break;
        }
        // The projection now records the thread as deleted; the native close
        // lands after scope death, so the removal reports thread-deleted and
        // the stream then closes scope-invalidated.
        rows[THREAD_ID] = {
          projectId: PROJECT_ID,
          worktreePath: null,
          deletedAt: "2026-09-14T00:00:00.000Z",
        };
        yield* preview.close({ threadId, tabId: doomed.tabId });
        const removed = yield* Effect.promise(() => iterator.next());
        const removedValue = eventValue(removed.value!);
        expect(removedValue.kind).toBe("session-removed");
        if (removedValue.kind === "session-removed") {
          expect(removedValue.tabId).toBe(doomed.tabId);
          expect(removedValue.reason).toBe("thread-deleted");
        }
        const closed = yield* Effect.promise(() => iterator.next());
        const closedValue = eventValue(closed.value!);
        expect(closedValue.kind).toBe("closed");
        if (closedValue.kind === "closed") {
          expect(closedValue.reason).toBe("scope-invalidated");
        }
      } finally {
        yield* Effect.promise(() => iterator.return!());
      }
    }),
  );

  it.effect("queue overflow terminates with closed:overflow", () =>
    Effect.gen(function* () {
      const { provider, preview } = yield* harness;
      const threadId = ThreadId.make(THREAD_ID);
      const iterable = provider.subscribe!(
        "events",
        {},
        context(),
        signal,
        meta(provider, { scopes: [AuthOrchestrationReadScope] }),
      );
      const iterator = iterable[Symbol.asyncIterator]();
      try {
        // Finish the snapshot handshake, then flood the queue without pulling.
        yield* Effect.promise(() => iterator.next()); // snapshot-start
        for (;;) {
          const next = yield* Effect.promise(() => iterator.next());
          if (eventValue(next.value!).kind === "snapshot-complete") break;
        }
        for (let index = 0; index < 200; index += 1) {
          yield* preview.open({ threadId });
        }
        // The pump enqueues eagerly; after 128 queued events the terminal
        // overflow value replaces the backlog.
        let sawOverflow = false;
        for (let index = 0; index < 260; index += 1) {
          const next = yield* Effect.promise(() => iterator.next());
          if (next.done) break;
          const value = eventValue(next.value!);
          if (value.kind === "closed") {
            expect(value.reason).toBe("overflow");
            sawOverflow = true;
            break;
          }
        }
        expect(sawOverflow).toBe(true);
      } finally {
        yield* Effect.promise(() => iterator.return!());
      }
    }),
  );

  it.effect("a large but valid initial snapshot completes without overflow", () =>
    Effect.gen(function* () {
      const { provider, preview } = yield* harness;
      const threadId = ThreadId.make(THREAD_ID);
      // 64 sessions × ~2 KiB URLs ≈ 280 KiB of session data — comfortably
      // inside the 512 KiB snapshot cap. Queue accounting must charge the
      // actual emitted envelopes once, not the session array per marker.
      const url = `https://example.com/${"a".repeat(2000)}`;
      for (let index = 0; index < 64; index += 1) {
        yield* preview.open({ threadId, url });
      }
      const iterable = provider.subscribe!(
        "events",
        {},
        context(),
        signal,
        meta(provider, { scopes: [AuthOrchestrationReadScope] }),
      );
      const iterator = iterable[Symbol.asyncIterator]();
      try {
        const kinds: string[] = [];
        for (;;) {
          const next = yield* Effect.promise(() => iterator.next());
          expect(next.done).toBe(false);
          const value = eventValue(next.value!);
          kinds.push(value.kind);
          expect(value.kind).not.toBe("closed");
          if (value.kind === "snapshot-complete") break;
        }
        expect(kinds[0]).toBe("snapshot-start");
        expect(kinds.at(-1)).toBe("snapshot-complete");
        // The snapshot needed multiple <64 KiB chunk frames between markers.
        expect(kinds.filter((kind) => kind === "snapshot-chunk").length).toBeGreaterThan(1);
        // The stream survives: a live upsert still arrives after the
        // snapshot — no overflow was tripped by queue accounting.
        yield* preview.open({ threadId });
        const live = yield* Effect.promise(() => iterator.next());
        expect(live.done).not.toBe(true);
        expect(eventValue(live.value!).kind).toBe("session-upsert");
      } finally {
        yield* Effect.promise(() => iterator.return!());
      }
    }),
  );

  it.effect("a second consumer cannot observe another thread's sessions", () =>
    Effect.gen(function* () {
      const { preview } = yield* harness;
      const threadA = ThreadId.make("thread-a-scope");
      const rows: Record<string, ThreadRow> = {
        [THREAD_ID]: { projectId: PROJECT_ID, worktreePath: null, deletedAt: null },
        "thread-a-scope": { projectId: PROJECT_ID, worktreePath: null, deletedAt: null },
      };
      const scoped = createBrowserSessionsApiProvider(
        makeDeps(preview, { threads: makeThreads(rows) }),
      );
      const iterable = scoped.subscribe!(
        "events",
        {},
        context("thread-a-scope"),
        signal,
        meta(scoped, { scopes: [AuthOrchestrationReadScope] }),
      );
      const iterator = iterable[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = yield* Effect.promise(() => iterator.next());
          if (eventValue(next.value!).kind === "snapshot-complete") break;
        }
        // Publish on the foreign thread, then on the scoped thread. The
        // foreign event is filtered before delivery.
        yield* preview.open({
          threadId: ThreadId.make(THREAD_ID),
          url: "http://localhost:9999",
        });
        yield* preview.open({ threadId: threadA, url: "http://localhost:3000" });
        const delivered = yield* Effect.promise(() => iterator.next());
        const value = eventValue(delivered.value!);
        expect(value.kind).toBe("session-upsert");
        if (value.kind === "session-upsert") {
          expect(value.session.requestedUrl).toBe("http://localhost:3000/");
        }
        // And the list projection is thread-scoped as well.
        const listed = (yield* invoke(
          scoped,
          "list",
          {},
          context("thread-a-scope"),
          meta(scoped),
        )) as { readonly sessions: readonly { readonly requestedUrl: string | null }[] };
        expect(listed.sessions.map((s) => s.requestedUrl)).toEqual(["http://localhost:3000/"]);
      } finally {
        yield* Effect.promise(() => iterator.return!());
      }
    }),
  );

  it.effect(
    "installed packed consumer reaches the adapter through public broker APIs and denies a missing grant by name",
    () =>
      Effect.gen(function* () {
        const { provider } = yield* harness;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runner = yield* ProcessRunner.ProcessRunner;
        const exampleDir = path.resolve(
          import.meta.dirname,
          "../../../../../packages/extension-sdk/examples/browser-sessions",
        );
        const built = yield* runner.run({
          command: "node",
          args: [
            path.resolve(
              import.meta.dirname,
              "../../../../../packages/extension-sdk/bin/t3-extension.mjs",
            ),
            "build",
            exampleDir,
          ],
        });
        expect(built.code, built.stderr).toBe(0);
        const temp = yield* fs.makeTempDirectoryScoped({ prefix: "p08b-installed-" });
        const rootDir = yield* fs.realPath(temp);
        const runtime = yield* Effect.promise(() =>
          createExtensionRuntime({
            rootDir,
            environmentId: ENV_ID,
            services: [],
            apiProviders: [provider],
            authorize: (installation, grant, ctx) =>
              installation.grants.capabilities.includes(grant) &&
              installation.grants.projectIds.includes(ctx.resource.projectId ?? ""),
          }),
        );
        try {
          const grants = {
            capabilities: [BROWSER_SESSIONS, BROWSER_OPERATE],
            projectIds: [PROJECT_ID],
          };
          const installed = yield* Effect.promise(() =>
            runtime.install(path.resolve(exampleDir, ".t3-extension"), grants),
          );
          const controller = new AbortController();
          const root: HostApiRootAuthority = {
            principal: meta(provider).principal!,
            allowWrite: true,
            revalidate: () => {},
          };
          const mirror = "example.browser-sessions/mirror";
          const invokeMirror = (method: string, input: Record<string, unknown> = {}) =>
            runtime.invokeApi(
              installed.id,
              installed.contentHash,
              {
                id: mirror,
                versionRange: "^1.0.0",
                method,
                input: input as never,
                context: context(),
              },
              controller.signal,
              root,
            );

          // The packed server.mjs relays every verb through invokeApi.
          const capabilities = (yield* Effect.promise(() => invokeMirror("getCapabilities"))) as {
            metadata: { supported: boolean };
          };
          expect(capabilities.metadata.supported).toBe(true);
          const opened = (yield* Effect.promise(() =>
            invokeMirror("open", { url: "localhost:5173" }),
          )) as {
            outcome: string;
            serverEpoch: string;
            session: {
              tabId: string;
              navigation: { kind: string };
              engine: { state: string };
            };
          };
          expect(opened.outcome).toBe("accepted");
          expect(opened.session.navigation.kind).toBe("pending");
          expect(opened.session.engine.state).toBe("unavailable");
          const navigated = (yield* Effect.promise(() =>
            invokeMirror("navigate", {
              tabId: opened.session.tabId,
              serverEpoch: opened.serverEpoch,
              url: "localhost:3000",
              expectedEngineGeneration: null,
            }),
          )) as { outcome: string; session: { navigation: { kind: string } } };
          expect(navigated.outcome).toBe("accepted");
          expect(navigated.session.navigation.kind).toBe("pending");
          const listed = (yield* Effect.promise(() => invokeMirror("list"))) as {
            sessions: { tabId: string }[];
          };
          expect(listed.sessions.map((s) => s.tabId)).toEqual([opened.session.tabId]);

          // The events stream relays through the packed subscribe path:
          // complete snapshot first, then the live removal.
          const eventsIterable = runtime.subscribeApi(
            installed.id,
            installed.contentHash,
            {
              id: mirror,
              versionRange: "^1.0.0",
              name: "events",
              input: {},
              context: context(),
            },
            controller.signal,
            root,
          );
          const stream = eventsIterable[Symbol.asyncIterator]();
          const frames: BrowserSessionStreamValue[] = [];
          frames.push(eventValue((yield* Effect.promise(() => stream.next())).value!));
          frames.push(eventValue((yield* Effect.promise(() => stream.next())).value!));
          while (frames.at(-1)?.kind !== "snapshot-complete") {
            frames.push(eventValue((yield* Effect.promise(() => stream.next())).value!));
          }
          expect(frames[0]?.kind).toBe("snapshot-start");
          const closeResult = (yield* Effect.promise(() =>
            invokeMirror("close", {
              tabId: opened.session.tabId,
              serverEpoch: opened.serverEpoch,
            }),
          )) as { outcome: string };
          expect(closeResult.outcome).toBe("closed");
          const removed = eventValue((yield* Effect.promise(() => stream.next())).value!);
          expect(removed.kind).toBe("session-removed");
          if (removed.kind === "session-removed") {
            expect(removed.tabId).toBe(opened.session.tabId);
            expect(removed.reason).toBe("user-closed");
          }
          yield* Effect.promise(() => stream.return!());

          // Grant revocation denies by name through the real broker.
          yield* Effect.promise(() =>
            runtime.updateGrants(installed.id, { ...grants, capabilities: [] }),
          );
          yield* Effect.promise(() =>
            expect(invokeMirror("list")).rejects.toThrow(/t3\.browser\/sessions/),
          );
          yield* Effect.promise(() =>
            expect(invokeMirror("open", { url: "localhost:5173" })).rejects.toThrow(
              /t3\.browser\/(sessions|operate)/,
            ),
          );
        } finally {
          yield* Effect.promise(() => runtime.dispose());
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      ),
  );
});
