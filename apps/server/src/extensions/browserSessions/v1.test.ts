import {
  BrowserEnginePageStatus,
  type BrowserEngineHostCommandResultInput,
  type BrowserEngineHostStreamEvent,
  type PreviewNavStatus,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ExtensionOperationError,
  ProjectId,
  ThreadId,
  extensionWorkspaceRevision,
} from "@t3tools/contracts";
import {
  BROWSER_DEVTOOLS,
  BROWSER_OPERATE,
  BROWSER_PICTURE_IN_PICTURE,
  BROWSER_SESSIONS,
  browserSessionsApi,
  browserSessionsApiV1,
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
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProcessRunner from "../../processRunner.ts";
import * as BrowserEngineHosts from "../../preview/BrowserEngineHosts.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import { makeBrowserFaviconAssets } from "./faviconAssets.ts";
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

/** No desktop engine host: web, mobile, relay and tunnel environments. */
const noEngineHosts = {
  dispatch: () => Effect.succeed({ outcome: "unknown" as const }),
  hasHost: Effect.succeed(false),
};

const makeDeps = (
  preview: PreviewManager.PreviewManager["Service"],
  overrides: {
    readonly threads?: ReturnType<typeof makeThreads>;
    readonly engineHosts?: BrowserEngineHosts.BrowserEngineHosts["Service"];
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
  engineHosts: overrides.engineHosts ?? noEngineHosts,
  favicons: makeBrowserFaviconAssets(),
});

/**
 * A real PreviewManager and engine host registry under test — provenance
 * and host authority are the point.
 */
const harness = Effect.gen(function* () {
  const preview = yield* PreviewManager.PreviewManager;
  const engineHosts = yield* BrowserEngineHosts.BrowserEngineHosts;
  const provider = createBrowserSessionsApiProvider(makeDeps(preview, { engineHosts }));
  return { preview, engineHosts, provider };
}).pipe(
  Effect.provide(
    BrowserEngineHosts.layer.pipe(
      Layer.provideMerge(PreviewManager.layer),
      Layer.provide(NodeServices.layer),
    ),
  ),
);

const DESKTOP_SOCKET = { socketId: "desktop-ws", grantMethod: "desktop-bootstrap" } as const;

const decodePageStatus = Schema.decodeUnknownSync(BrowserEnginePageStatus);

const pageStatus = (navStatus: PreviewNavStatus) =>
  decodePageStatus({
    navStatus,
    canGoBack: true,
    canGoForward: false,
    zoomFactor: 1.25,
    appearance: "dark" as const,
    audioMuted: false,
    audible: true,
    devToolsOpen: false,
    pictureInPicture: false,
    favicon: { dataUrl: "data:image/png;base64,AAAA", pageUrl: "http://localhost:5173/" },
  });

/**
 * Registers the desktop as an engine host and claims `tabId` under
 * `generation`. The returned queue yields the host's command events.
 */
const attachDesktopHost = Effect.fn("test.attachDesktopHost")(function* (
  engineHosts: BrowserEngineHosts.BrowserEngineHosts["Service"],
  target: { readonly tabId: string; readonly serverEpoch: string },
  generation = "41",
) {
  const events = yield* Queue.unbounded<BrowserEngineHostStreamEvent>();
  const stream = yield* engineHosts.register(DESKTOP_SOCKET);
  const fiber = yield* stream.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const registered = yield* Queue.take(events);
  if (registered.type !== "registered") throw new Error("expected registration first");
  const fence = {
    hostConnectionId: registered.hostConnectionId,
    target: { threadId: ThreadId.make(THREAD_ID), ...target },
    engineGeneration: generation,
  };
  yield* engineHosts.claim(DESKTOP_SOCKET, fence);
  return { events, fence, fiber };
});

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

const DEVTOOLS_METHODS = ["openDevTools", "closeDevTools"];

/** Packs the SDK's browser-sessions example and a scoped runtime root for it. */
const buildPackedExample = Effect.gen(function* () {
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
  return { exampleDir, rootDir: yield* fs.realPath(temp) };
});

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
          DEVTOOLS_METHODS.includes(method.name)
            ? // DevTools needs its own grant; sessions + operate confer nothing about it.
              [BROWSER_SESSIONS, BROWSER_OPERATE, BROWSER_DEVTOOLS]
            : method.name === "setPictureInPicture"
              ? // Its own grant: operate does not confer it, and it does not need operate.
                [BROWSER_SESSIONS, BROWSER_PICTURE_IN_PICTURE]
              : writes.has(method.name)
                ? [BROWSER_SESSIONS, BROWSER_OPERATE]
                : [BROWSER_SESSIONS],
        );
      }
      // No other method or stream accepts the DevTools grant as authority.
      expect(
        (definition.methods ?? [])
          .filter((method) => method.requiredGrants.includes(BROWSER_DEVTOOLS))
          .map((method) => method.name),
      ).toEqual(DEVTOOLS_METHODS);
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

  it.effect("navigate acceptance never projects as loaded until the owner host reports", () =>
    Effect.gen(function* () {
      const { provider, preview, engineHosts } = yield* harness;
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

      // The unfenced legacy report is not engine provenance.
      yield* preview.reportStatus({
        threadId: ThreadId.make(THREAD_ID),
        tabId: opened.session.tabId,
        navStatus: { _tag: "Success", url: "http://localhost:5173/", title: "Dev" },
        canGoBack: true,
        canGoForward: false,
      });
      const afterLegacy = (yield* invoke(provider, "list", {})) as {
        readonly sessions: readonly {
          readonly navigation: { readonly kind: string };
          readonly canGoBack: boolean;
        }[];
      };
      expect(afterLegacy.sessions[0]?.navigation.kind).toBe("pending");
      expect(afterLegacy.sessions[0]?.canGoBack).toBe(false);

      const { fence } = yield* attachDesktopHost(engineHosts, {
        tabId: opened.session.tabId,
        serverEpoch: opened.serverEpoch,
      });
      yield* engineHosts.report(DESKTOP_SOCKET, {
        ...fence,
        status: pageStatus({ _tag: "Loading", url: "http://localhost:5173/", title: "" }),
      });
      const afterReport = (yield* invoke(provider, "list", {})) as {
        readonly sessions: readonly {
          readonly navigation: { readonly kind: string; readonly url: string | null };
        }[];
      };
      expect(afterReport.sessions[0]?.navigation.kind).toBe("loading");

      yield* engineHosts.report(DESKTOP_SOCKET, {
        ...fence,
        status: pageStatus({ _tag: "Success", url: "http://localhost:5173/", title: "Dev" }),
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

  it.effect(
    "navigate on a held session loads through the owning host and settles on its report",
    () =>
      Effect.gen(function* () {
        const { provider, engineHosts } = yield* harness;
        const opened = (yield* invoke(provider, "open", { url: "localhost:5173" })) as {
          readonly serverEpoch: string;
          readonly session: { readonly tabId: string };
        };
        const { events, fence } = yield* attachDesktopHost(engineHosts, {
          tabId: opened.session.tabId,
          serverEpoch: opened.serverEpoch,
        });
        yield* engineHosts.report(DESKTOP_SOCKET, {
          ...fence,
          status: pageStatus({ _tag: "Success", url: "http://localhost:5173/", title: "Dev" }),
        });
        const answer = (result: BrowserEngineHosts.BrowserEngineDispatchOutcome) =>
          Effect.gen(function* () {
            const event = yield* Queue.take(events);
            if (event.type !== "command") throw new Error("expected a command event");
            if (result.outcome !== "unknown") {
              yield* engineHosts.commandResult(DESKTOP_SOCKET, {
                hostConnectionId: fence.hostConnectionId,
                commandId: event.commandId,
                result,
              });
            }
            return event;
          });
        const guard = {
          tabId: opened.session.tabId,
          serverEpoch: opened.serverEpoch,
          expectedEngineGeneration: "41",
        };
        type Navigation = { readonly kind: string; readonly url: string | null };
        const navigation = Effect.gen(function* () {
          const listed = (yield* invoke(provider, "list", {})) as {
            readonly sessions: readonly { readonly navigation: Navigation }[];
          };
          return listed.sessions[0]?.navigation;
        });

        const hostAnswer = yield* Effect.forkChild(answer({ outcome: "applied" }));
        const navigated = (yield* invoke(provider, "navigate", {
          ...guard,
          url: "localhost:5173/next",
        })) as { readonly outcome: string; readonly session: { readonly navigation: Navigation } };
        const event = yield* Fiber.join(hostAnswer);
        // The owner receives the normalized URL the server recorded, fenced like any page verb.
        expect(event).toMatchObject({
          target: fence.target,
          engineGeneration: "41",
          command: { _tag: "navigate", url: "http://localhost:5173/next" },
        });
        expect(navigated.outcome).toBe("accepted");
        expect(navigated.session.navigation).toMatchObject({
          kind: "pending",
          url: "http://localhost:5173/next",
        });

        yield* engineHosts.report(DESKTOP_SOCKET, {
          ...fence,
          status: pageStatus({ _tag: "Loading", url: "http://localhost:5173/next", title: "Dev" }),
        });
        expect(yield* navigation).toMatchObject({
          kind: "loading",
          url: "http://localhost:5173/next",
        });
        yield* engineHosts.report(DESKTOP_SOCKET, {
          ...fence,
          status: pageStatus({ _tag: "Success", url: "http://localhost:5173/next", title: "Next" }),
        });
        expect(yield* navigation).toEqual({
          kind: "loaded",
          url: "http://localhost:5173/next",
          title: "Next",
        });

        const refusing = yield* Effect.forkChild(
          answer({ outcome: "rejected", reason: "stale-generation" }),
        );
        const refused = (yield* invoke(provider, "navigate", {
          ...guard,
          url: "localhost:5173/other",
        })) as { readonly outcome: string };
        yield* Fiber.join(refusing);
        expect(refused.outcome).toBe("rejected");
      }),
  );

  it.effect("navigate without an owning host stays a recorded request and asks no host", () =>
    Effect.gen(function* () {
      const { preview } = yield* harness;
      let dispatched = 0;
      const provider = createBrowserSessionsApiProvider(
        makeDeps(preview, {
          engineHosts: {
            ...noEngineHosts,
            dispatch: () => {
              dispatched += 1;
              return Effect.succeed({ outcome: "applied" as const });
            },
          } as unknown as BrowserEngineHosts.BrowserEngineHosts["Service"],
        }),
      );
      const opened = (yield* invoke(provider, "open", { url: "localhost:5173" })) as {
        readonly serverEpoch: string;
        readonly session: { readonly tabId: string };
      };
      const navigated = (yield* invoke(provider, "navigate", {
        tabId: opened.session.tabId,
        serverEpoch: opened.serverEpoch,
        url: "localhost:5173/next",
        expectedEngineGeneration: null,
      })) as {
        readonly outcome: string;
        readonly session: {
          readonly requestedUrl: string | null;
          readonly navigation: { readonly kind: string; readonly url: string | null };
        };
      };
      expect(dispatched).toBe(0);
      expect(navigated.outcome).toBe("accepted");
      expect(navigated.session.requestedUrl).toBe("http://localhost:5173/next");
      expect(navigated.session.navigation).toMatchObject({
        kind: "pending",
        url: "http://localhost:5173/next",
      });
    }),
  );

  it.effect("engine-reported failure projects the closed failure enum, never native strings", () =>
    Effect.gen(function* () {
      const { provider, engineHosts } = yield* harness;
      const opened = (yield* invoke(provider, "open", { url: "localhost:9" })) as {
        readonly serverEpoch: string;
        readonly session: { readonly tabId: string };
      };
      const { fence } = yield* attachDesktopHost(engineHosts, {
        tabId: opened.session.tabId,
        serverEpoch: opened.serverEpoch,
      });
      yield* engineHosts.report(DESKTOP_SOCKET, {
        ...fence,
        status: pageStatus({
          _tag: "LoadFailed",
          url: "http://localhost:9/",
          title: "",
          code: -105,
          description: "net::ERR_NAME_NOT_RESOLVED with internal details",
        }),
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

  it.effect("owner lifecycle reports project crashed and recovering honestly", () =>
    Effect.gen(function* () {
      const { provider, engineHosts } = yield* harness;
      const opened = (yield* invoke(provider, "open", { url: "localhost:5173" })) as {
        readonly serverEpoch: string;
        readonly session: { readonly tabId: string };
      };
      const { fence } = yield* attachDesktopHost(engineHosts, {
        tabId: opened.session.tabId,
        serverEpoch: opened.serverEpoch,
      });
      const loaded = pageStatus({ _tag: "Success", url: "http://localhost:5173/", title: "App" });
      yield* engineHosts.report(DESKTOP_SOCKET, { ...fence, status: loaded });
      const session = Effect.map(
        invoke(provider, "list", {}),
        (listed) =>
          (
            listed as {
              readonly sessions: readonly {
                readonly engine: unknown;
                readonly navigation: { readonly kind: string; readonly failureCode?: string };
              }[];
            }
          ).sessions[0]!,
      );

      yield* engineHosts.report(DESKTOP_SOCKET, { ...fence, lifecycle: "crashed" });
      const crashed = yield* session;
      expect(crashed.engine).toEqual({ state: "crashed", generation: "41" });
      expect(crashed.navigation).toMatchObject({ kind: "failed", failureCode: "crash" });

      yield* engineHosts.report(DESKTOP_SOCKET, { ...fence, lifecycle: "recovering" });
      expect((yield* session).engine).toEqual({ state: "recovering", generation: "41" });

      // The replacement guest is a new webContents: release, then a fresh claim.
      yield* engineHosts.release(DESKTOP_SOCKET, fence);
      const replacement = { ...fence, engineGeneration: "42" };
      yield* engineHosts.claim(DESKTOP_SOCKET, replacement);
      expect((yield* session).engine).toEqual({ state: "starting", generation: "42" });
      yield* engineHosts.report(DESKTOP_SOCKET, { ...replacement, status: loaded });
      const recovered = yield* session;
      expect(recovered.engine).toEqual({ state: "ready", generation: "42" });
      expect(recovered.navigation.kind).toBe("loaded");

      yield* engineHosts.report(DESKTOP_SOCKET, { ...replacement, lifecycle: "exhausted" });
      expect((yield* session).engine).toEqual({
        state: "crashed",
        generation: "42",
        reason: "recovery-exhausted",
      });
      // Lifecycle rides the same fence: the released generation cannot report.
      expect(
        yield* engineHosts.report(DESKTOP_SOCKET, { ...fence, lifecycle: "recovering" }).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        ),
      ).toBe("stale-generation");
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

  it.effect("commands without an owning engine host fail by name, never silently accepted", () =>
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
        ...DEVTOOLS_METHODS,
        "setPictureInPicture",
      ]) {
        const extra =
          method === "zoom"
            ? { zoomFactor: 1.5 }
            : method === "setAppearance"
              ? { appearance: "dark" }
              : method === "setAudioMuted"
                ? { muted: true }
                : method === "setPictureInPicture"
                  ? { open: true }
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

  it.effect("engine commands route to the owning host and receipts carry its answer", () =>
    Effect.gen(function* () {
      const { provider, engineHosts } = yield* harness;
      const opened = (yield* invoke(provider, "open", { url: "localhost:5173" })) as {
        readonly serverEpoch: string;
        readonly session: { readonly tabId: string };
      };
      const { events, fence } = yield* attachDesktopHost(engineHosts, {
        tabId: opened.session.tabId,
        serverEpoch: opened.serverEpoch,
      });
      const capabilities = (yield* invoke(provider, "getCapabilities", {})) as {
        readonly commands: readonly string[];
        readonly presentation: unknown;
      };
      expect(capabilities.commands).toEqual([
        "resize",
        "back",
        "forward",
        "reload",
        "hardReload",
        "zoom",
        "setAppearance",
        "setAudioMuted",
        "openDevTools",
        "closeDevTools",
        "setPictureInPicture",
      ]);
      // Presentation stays a named deferral.
      expect(capabilities.presentation).toEqual({ supported: false, reason: "desktop-required" });

      const answer = (result: BrowserEngineHosts.BrowserEngineDispatchOutcome) =>
        Effect.gen(function* () {
          const event = yield* Queue.take(events);
          if (event.type !== "command") throw new Error("expected a command event");
          if (result.outcome !== "unknown") {
            yield* engineHosts.commandResult(DESKTOP_SOCKET, {
              hostConnectionId: fence.hostConnectionId,
              commandId: event.commandId,
              result,
            });
          }
          return event;
        });
      const guard = {
        tabId: opened.session.tabId,
        serverEpoch: opened.serverEpoch,
        expectedEngineGeneration: "41",
      };

      const hostAnswer = yield* Effect.forkChild(answer({ outcome: "applied" }));
      const zoomed = (yield* invoke(provider, "zoom", { ...guard, zoomFactor: 1.5 })) as {
        readonly outcome: string;
      };
      const zoomEvent = yield* Fiber.join(hostAnswer);
      expect(zoomed.outcome).toBe("accepted");
      // The host receives the fenced target and generation, never a lease.
      expect(zoomEvent).toMatchObject({
        target: fence.target,
        engineGeneration: "41",
        command: { _tag: "zoom", zoomFactor: 1.5 },
      });

      const rejecting = yield* Effect.forkChild(
        answer({ outcome: "rejected", reason: "not-applicable" }),
      );
      const back = (yield* invoke(provider, "back", guard)) as { readonly outcome: string };
      yield* Fiber.join(rejecting);
      expect(back.outcome).toBe("rejected");

      // A caller fenced on a replaced guest is refused before dispatch.
      const stale = yield* invokeError(provider, "reload", {
        ...guard,
        expectedEngineGeneration: "40",
      });
      expect(stale.detail).toContain("BrowserStaleEngineGeneration");

      // Page state comes only from the owner's report; the favicon rides as a ref.
      yield* engineHosts.report(DESKTOP_SOCKET, {
        ...fence,
        status: pageStatus({ _tag: "Success", url: "http://localhost:5173/", title: "Dev" }),
      });
      const listed = (yield* invoke(provider, "list", {})) as {
        readonly sessions: readonly Record<string, unknown>[];
      };
      expect(listed.sessions[0]).toMatchObject({
        engine: { state: "ready", generation: "41" },
        zoomFactor: 1.25,
        appearance: "dark",
        audioMuted: false,
        audible: true,
        devToolsOpen: false,
        canGoBack: true,
      });
      expect(Object.keys(listed.sessions[0] ?? {})).not.toContain("favicon");
      expect(listed.sessions[0]).not.toHaveProperty("controller");
      expect(listed.sessions[0]).not.toHaveProperty("remoteLive");
      expect(Object.values(listed.sessions[0] ?? {})).not.toContain("data:image/png;base64,AAAA");
    }),
  );

  it.effect("picture-in-picture routes to the owner host and its state rides session upserts", () =>
    Effect.gen(function* () {
      const { provider, engineHosts } = yield* harness;
      const opened = (yield* invoke(provider, "open", { url: "localhost:5173" })) as {
        readonly serverEpoch: string;
        readonly session: { readonly tabId: string; readonly pictureInPicture: unknown };
      };
      // Unreported state is null, never a fabricated false.
      expect(opened.session.pictureInPicture).toBeNull();
      const { events, fence } = yield* attachDesktopHost(engineHosts, {
        tabId: opened.session.tabId,
        serverEpoch: opened.serverEpoch,
      });
      const guard = {
        tabId: opened.session.tabId,
        serverEpoch: opened.serverEpoch,
        expectedEngineGeneration: "41",
      };
      const loaded = pageStatus({ _tag: "Success", url: "http://localhost:5173/", title: "Dev" });
      yield* engineHosts.report(DESKTOP_SOCKET, { ...fence, status: loaded });

      const iterable = provider.subscribe!(
        "events",
        {},
        context(),
        signal,
        meta(provider, { scopes: [AuthOrchestrationReadScope] }),
      );
      const iterator = iterable[Symbol.asyncIterator]();
      try {
        let frame = eventValue((yield* Effect.promise(() => iterator.next())).value!);
        while (frame.kind !== "snapshot-complete") {
          if (frame.kind === "snapshot-chunk") {
            expect(frame.sessions[0]?.pictureInPicture).toBe(false);
          }
          frame = eventValue((yield* Effect.promise(() => iterator.next())).value!);
        }

        const hostAnswer = yield* Effect.forkChild(
          Effect.gen(function* () {
            const event = yield* Queue.take(events);
            if (event.type !== "command") throw new Error("expected a command event");
            yield* engineHosts.commandResult(DESKTOP_SOCKET, {
              hostConnectionId: fence.hostConnectionId,
              commandId: event.commandId,
              result: { outcome: "applied" },
            });
            return event;
          }),
        );
        const receipt = (yield* invoke(provider, "setPictureInPicture", {
          ...guard,
          open: true,
        })) as { readonly outcome: string; readonly session: { pictureInPicture: unknown } };
        const event = yield* Fiber.join(hostAnswer);
        expect(event).toMatchObject({
          target: fence.target,
          engineGeneration: "41",
          command: { _tag: "setPictureInPicture", open: true },
        });
        // Accepted means dispatched; the window state is whatever the host reports.
        expect(receipt.outcome).toBe("accepted");
        expect(receipt.session.pictureInPicture).toBe(false);

        yield* engineHosts.report(DESKTOP_SOCKET, {
          ...fence,
          status: { ...loaded, pictureInPicture: true },
        });
        let upsert = eventValue((yield* Effect.promise(() => iterator.next())).value!);
        while (upsert.kind === "session-upsert" && upsert.session.pictureInPicture !== true) {
          upsert = eventValue((yield* Effect.promise(() => iterator.next())).value!);
        }
        expect(upsert.kind).toBe("session-upsert");
      } finally {
        yield* Effect.promise(() => iterator.return!());
      }

      // Its own input schema still applies before dispatch.
      const bad = yield* invokeError(provider, "setPictureInPicture", { ...guard, open: "yes" });
      expect(bad.detail).toContain("BrowserSessionInputError");
    }),
  );

  it.effect(
    "picture-in-picture on a recovering or crashed guest fails by name without dispatch",
    () =>
      Effect.gen(function* () {
        const { provider, engineHosts } = yield* harness;
        const opened = (yield* invoke(provider, "open", { url: "localhost:5173" })) as {
          readonly serverEpoch: string;
          readonly session: { readonly tabId: string };
        };
        const { events, fence } = yield* attachDesktopHost(engineHosts, {
          tabId: opened.session.tabId,
          serverEpoch: opened.serverEpoch,
        });
        const request = {
          tabId: opened.session.tabId,
          serverEpoch: opened.serverEpoch,
          expectedEngineGeneration: "41",
          open: true,
        };
        for (const [lifecycle, reason] of [
          ["recovering", "(recovering)"],
          ["crashed", "(crash)"],
          ["exhausted", "(recovery-exhausted)"],
        ] as const) {
          yield* engineHosts.report(DESKTOP_SOCKET, { ...fence, lifecycle });
          const error = yield* invokeError(provider, "setPictureInPicture", request);
          expect(error.detail).toContain("BrowserSessionEngineNotLive");
          expect(error.detail).toContain(reason);
        }
        // Nothing reached the host.
        expect(yield* Queue.size(events)).toBe(0);
      }),
  );

  it.effect("projects a captured favicon as a project-scoped ref resolved by getFavicon", () =>
    Effect.gen(function* () {
      const { provider, engineHosts } = yield* harness;
      const opened = (yield* invoke(provider, "open", { url: "localhost:5173" })) as {
        readonly serverEpoch: string;
        readonly session: { readonly tabId: string };
      };
      const { fence } = yield* attachDesktopHost(engineHosts, {
        tabId: opened.session.tabId,
        serverEpoch: opened.serverEpoch,
      });
      const report = (url: string) =>
        engineHosts.report(DESKTOP_SOCKET, {
          ...fence,
          status: pageStatus({ _tag: "Success", url, title: "Dev" }),
        });
      const firstRef = Effect.map(
        invoke(provider, "list", {}),
        (listed) =>
          (listed as { readonly sessions: readonly { faviconRef?: string }[] }).sessions[0]
            ?.faviconRef,
      );

      yield* report("http://localhost:5173/app");
      const ref = yield* firstRef;
      expect(ref).toEqual(expect.any(String));
      expect(yield* invoke(provider, "getFavicon", { ref })).toEqual({
        ref,
        dataUrl: "data:image/png;base64,AAAA",
      });

      // Another project cannot resolve this project's ref.
      const foreign = yield* invokeError(
        provider,
        "getFavicon",
        { ref },
        context("foreign", ENV_ID, "other-project"),
      );
      expect(foreign.detail).toContain("BrowserFaviconNotFound");
      // An unknown ref is a named miss — the caller renders its fallback tier.
      const missing = yield* invokeError(provider, "getFavicon", { ref: "stale" });
      expect(missing.detail).toContain("BrowserFaviconNotFound");

      // A favicon from another origin than the current page is not projected.
      yield* report("https://example.com/");
      expect(yield* firstRef).toBeUndefined();
    }),
  );

  it.effect(
    "openDevTools and closeDevTools dispatch to the owning host and name every refusal",
    () =>
      Effect.gen(function* () {
        const { provider, engineHosts } = yield* harness;
        const opened = (yield* invoke(provider, "open", { url: "localhost:5173" })) as {
          readonly serverEpoch: string;
          readonly session: { readonly tabId: string; readonly devToolsOpen: boolean | null };
        };
        const guard = {
          tabId: opened.session.tabId,
          serverEpoch: opened.serverEpoch,
          expectedEngineGeneration: null,
        };
        // Unreported is null, never a guessed "closed".
        expect(opened.session.devToolsOpen).toBeNull();

        // No desktop host registered anywhere: desktop-required.
        const noHost = yield* invokeError(provider, "openDevTools", guard);
        expect(noHost.detail).toContain("BrowserSessionCommandUnsupported");
        expect(noHost.detail).toContain("(desktop-required)");

        // A host is registered but only claims another session: no-attached-engine.
        const other = (yield* invoke(provider, "open", { url: "localhost:3000" })) as {
          readonly session: { readonly tabId: string };
        };
        const { events, fence } = yield* attachDesktopHost(engineHosts, {
          tabId: other.session.tabId,
          serverEpoch: opened.serverEpoch,
        });
        const detached = yield* invokeError(provider, "closeDevTools", guard);
        expect(detached.detail).toContain("BrowserSessionEngineDetached");
        expect(detached.detail).toContain("(no-attached-engine)");

        const answer = (result: BrowserEngineHostCommandResultInput["result"]) =>
          Effect.gen(function* () {
            const event = yield* Queue.take(events);
            if (event.type !== "command") throw new Error("expected a command event");
            yield* engineHosts.commandResult(DESKTOP_SOCKET, {
              hostConnectionId: fence.hostConnectionId,
              commandId: event.commandId,
              result,
            });
            return event;
          });
        const attached = {
          tabId: other.session.tabId,
          serverEpoch: opened.serverEpoch,
          expectedEngineGeneration: "41",
        };

        // Each direction is its own operation with its own receipt.
        const opening = yield* Effect.forkChild(answer({ outcome: "applied" }));
        const openReceipt = (yield* invoke(provider, "openDevTools", attached)) as {
          readonly commandId: string;
          readonly outcome: string;
        };
        expect(openReceipt.outcome).toBe("accepted");
        expect(yield* Fiber.join(opening)).toMatchObject({
          target: fence.target,
          engineGeneration: "41",
          command: { _tag: "setDevToolsOpen", open: true },
        });
        const closing = yield* Effect.forkChild(answer({ outcome: "applied" }));
        const closeReceipt = (yield* invoke(provider, "closeDevTools", attached)) as {
          readonly commandId: string;
          readonly outcome: string;
        };
        expect(closeReceipt.outcome).toBe("accepted");
        expect(closeReceipt.commandId).not.toBe(openReceipt.commandId);
        expect(yield* Fiber.join(closing)).toMatchObject({
          command: { _tag: "setDevToolsOpen", open: false },
        });

        // A host that cannot toggle DevTools answers not-applicable: engine-unsupported.
        const refusing = yield* Effect.forkChild(
          answer({ outcome: "rejected", reason: "not-applicable" }),
        );
        const unsupported = yield* invokeError(provider, "openDevTools", attached);
        yield* Fiber.join(refusing);
        expect(unsupported.detail).toContain("BrowserSessionCommandUnsupported");
        expect(unsupported.detail).toContain("(engine-unsupported)");

        // Any other rejection stays an honest receipt, like every page verb.
        const failing = yield* Effect.forkChild(answer({ outcome: "rejected", reason: "failed" }));
        const failed = (yield* invoke(provider, "closeDevTools", attached)) as {
          readonly outcome: string;
        };
        yield* Fiber.join(failing);
        expect(failed.outcome).toBe("rejected");

        // The operations take the bare guard; the old boolean shape is refused.
        const badInput = yield* invokeError(provider, "openDevTools", { ...attached, open: true });
        expect(badInput.detail).toContain("BrowserSessionInputError");
        const retired = yield* invokeError(provider, "setDevToolsOpen", {
          ...attached,
          open: true,
        });
        expect(retired.detail).toContain("method is unavailable");

        // Open/closed state rides the same owner report as mute and appearance.
        yield* engineHosts.report(DESKTOP_SOCKET, {
          ...fence,
          status: {
            ...pageStatus({ _tag: "Success", url: "http://localhost:3000/", title: "Dev" }),
            devToolsOpen: true,
          },
        });
        const listed = (yield* invoke(provider, "list", {})) as {
          readonly sessions: readonly { readonly tabId: string; readonly devToolsOpen: unknown }[];
        };
        expect(
          Object.fromEntries(
            listed.sessions.map((session) => [session.tabId, session.devToolsOpen]),
          ),
        ).toEqual({ [opened.session.tabId]: null, [other.session.tabId]: true });
      }),
  );

  it.effect("DevTools refuses a natively opened session before any host is asked", () =>
    Effect.gen(function* () {
      const { preview, provider, engineHosts } = yield* harness;
      // The client preview panel and MCP open through the manager directly.
      const native = yield* preview.open({
        threadId: ThreadId.make(THREAD_ID),
        url: "http://localhost:5173",
      });
      const listed = (yield* invoke(provider, "list", {})) as { readonly serverEpoch: string };
      const { events } = yield* attachDesktopHost(engineHosts, {
        tabId: native.tabId,
        serverEpoch: listed.serverEpoch,
      });
      for (const method of DEVTOOLS_METHODS) {
        const refused = yield* invokeError(provider, method, {
          tabId: native.tabId,
          serverEpoch: listed.serverEpoch,
          expectedEngineGeneration: "41",
        });
        expect(refused.detail).toContain("BrowserSessionNotOwned");
        expect(refused.detail).toContain("opened natively");
        expect(refused.detail).toContain("(not-owned)");
      }
      // Nothing reached the attached desktop host.
      expect(yield* Queue.size(events)).toBe(0);
    }),
  );

  it.effect("picture-in-picture pops out a natively opened session, unlike DevTools", () =>
    Effect.gen(function* () {
      const { preview, provider, engineHosts } = yield* harness;
      // An agent (MCP) or the native panel opened this page, not the caller.
      const native = yield* preview.open({
        threadId: ThreadId.make(THREAD_ID),
        url: "http://localhost:5173",
      });
      const listed = (yield* invoke(provider, "list", {})) as { readonly serverEpoch: string };
      const { events, fence } = yield* attachDesktopHost(engineHosts, {
        tabId: native.tabId,
        serverEpoch: listed.serverEpoch,
      });
      const hostAnswer = yield* Effect.forkChild(
        Effect.gen(function* () {
          const event = yield* Queue.take(events);
          if (event.type !== "command") throw new Error("expected a command event");
          yield* engineHosts.commandResult(DESKTOP_SOCKET, {
            hostConnectionId: fence.hostConnectionId,
            commandId: event.commandId,
            result: { outcome: "applied" },
          });
          return event;
        }),
      );
      const receipt = (yield* invoke(provider, "setPictureInPicture", {
        tabId: native.tabId,
        serverEpoch: listed.serverEpoch,
        expectedEngineGeneration: "41",
        open: true,
      })) as { readonly outcome: string };
      expect(receipt.outcome).toBe("accepted");
      // The owning desktop host runs the PiP window; the plugin only asked.
      expect(yield* Fiber.join(hostAnswer)).toMatchObject({
        target: fence.target,
        command: { _tag: "setPictureInPicture", open: true },
      });
    }),
  );

  it.effect("DevTools refuses a session another installation opened before any host is asked", () =>
    Effect.gen(function* () {
      const { provider, engineHosts } = yield* harness;
      const foreign = (yield* invoke(provider, "open", { url: "localhost:5173" }, context(), {
        ...meta(provider),
        callerId: "other-installation",
      })) as { readonly serverEpoch: string; readonly session: { readonly tabId: string } };
      const { events, fence } = yield* attachDesktopHost(engineHosts, {
        tabId: foreign.session.tabId,
        serverEpoch: foreign.serverEpoch,
      });
      const guard = {
        tabId: foreign.session.tabId,
        serverEpoch: foreign.serverEpoch,
        expectedEngineGeneration: "41",
      };
      for (const method of DEVTOOLS_METHODS) {
        const refused = yield* invokeError(provider, method, guard);
        expect(refused.detail).toContain("BrowserSessionNotOwned");
        expect(refused.detail).toContain("another installation");
        // The foreign owner's identity never crosses to the caller.
        expect(refused.detail).not.toContain("other-installation");
      }
      expect(yield* Queue.size(events)).toBe(0);
      // Other verbs keep their 1.0.0 behaviour; ownership gates DevTools only.
      const reloading = yield* Effect.forkChild(
        Effect.gen(function* () {
          const event = yield* Queue.take(events);
          if (event.type !== "command") throw new Error("expected a command event");
          yield* engineHosts.commandResult(DESKTOP_SOCKET, {
            hostConnectionId: fence.hostConnectionId,
            commandId: event.commandId,
            result: { outcome: "applied" },
          });
          return event;
        }),
      );
      const reloaded = (yield* invoke(provider, "reload", guard)) as { readonly outcome: string };
      expect(yield* Fiber.join(reloading)).toMatchObject({ command: { _tag: "reload" } });
      expect(reloaded.outcome).toBe("accepted");
    }),
  );

  it.effect("host disconnect answers in-flight commands unknown and unbinds the engine", () =>
    Effect.gen(function* () {
      const { provider, engineHosts } = yield* harness;
      const opened = (yield* invoke(provider, "open", { url: "localhost:5173" })) as {
        readonly serverEpoch: string;
        readonly session: { readonly tabId: string };
      };
      const { events, fiber } = yield* attachDesktopHost(engineHosts, {
        tabId: opened.session.tabId,
        serverEpoch: opened.serverEpoch,
      });
      // The host receives the command, then its socket drops without answering.
      const dropHost = yield* Effect.forkChild(
        Effect.andThen(Queue.take(events), Fiber.interrupt(fiber)),
      );
      const reloaded = (yield* invoke(provider, "reload", {
        tabId: opened.session.tabId,
        serverEpoch: opened.serverEpoch,
        expectedEngineGeneration: null,
      })) as { readonly outcome: string };
      yield* Fiber.join(dropHost);
      expect(reloaded.outcome).toBe("unknown");

      const listed = (yield* invoke(provider, "list", {})) as {
        readonly sessions: readonly { readonly engine: unknown }[];
      };
      expect(listed.sessions[0]?.engine).toEqual({
        state: "unavailable",
        generation: null,
        reason: "desktop-required",
      });
      const capabilities = (yield* invoke(provider, "getCapabilities", {})) as {
        readonly commands: readonly string[];
      };
      expect(capabilities.commands).toEqual(["resize"]);
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
        const { exampleDir, rootDir } = yield* buildPackedExample;
        const path = yield* Path.Path;
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

          // DevTools needs its own grant: sessions + operate are refused by name
          // through the real broker, and adding the grant reaches the adapter.
          // The session is the mirror's own (opened above through the broker),
          // so ownership passes and the refusal is the missing desktop host.
          const devTools = () =>
            invokeMirror("openDevTools", {
              tabId: opened.session.tabId,
              serverEpoch: opened.serverEpoch,
              expectedEngineGeneration: null,
            });
          yield* Effect.promise(() =>
            expect(devTools()).rejects.toThrow(/API capability denied: t3\.browser\/devtools/),
          );
          yield* Effect.promise(() =>
            runtime.updateGrants(installed.id, {
              ...grants,
              capabilities: [...grants.capabilities, BROWSER_DEVTOOLS],
            }),
          );
          yield* Effect.promise(() => expect(devTools()).rejects.toThrow(/desktop-required/));
          // Picture-in-picture is isolated both ways: operate does not confer it...
          const pip = {
            tabId: opened.session.tabId,
            serverEpoch: opened.serverEpoch,
            expectedEngineGeneration: null,
            open: true,
          };
          yield* Effect.promise(() =>
            expect(invokeMirror("setPictureInPicture", pip)).rejects.toThrow(
              /API capability denied: t3\.browser\/picture-in-picture/,
            ),
          );
          // ...and its own grant confers no page verbs. Granted, it reaches the
          // adapter and names the missing desktop engine host.
          yield* Effect.promise(() =>
            runtime.updateGrants(installed.id, {
              ...grants,
              capabilities: [BROWSER_SESSIONS, BROWSER_PICTURE_IN_PICTURE],
            }),
          );
          yield* Effect.promise(() =>
            expect(invokeMirror("setPictureInPicture", pip)).rejects.toThrow(
              /BrowserSessionCommandUnsupported[^]*desktop-required/,
            ),
          );
          yield* Effect.promise(() =>
            expect(
              invokeMirror("back", {
                tabId: pip.tabId,
                serverEpoch: pip.serverEpoch,
                expectedEngineGeneration: null,
              }),
            ).rejects.toThrow(/API capability denied: t3\.browser\/operate/),
          );
          yield* Effect.promise(() => runtime.updateGrants(installed.id, grants));

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
  it.effect(
    "a 1.2.0 consumer is incompatible-api on a 1.0.0 host before any DevTools call reaches it",
    () =>
      Effect.gen(function* () {
        const { provider } = yield* harness;
        const { exampleDir, rootDir } = yield* buildPackedExample;
        const path = yield* Path.Path;
        let reached = 0;
        // A host that still serves the frozen 1.0.0 definition.
        const legacyHost: HostApiProvider = {
          ...provider,
          definition: browserSessionsApiV1.definition,
          invoke: (...args) => {
            reached += 1;
            return provider.invoke(...args);
          },
        };
        const runtime = yield* Effect.promise(() =>
          createExtensionRuntime({
            rootDir,
            environmentId: ENV_ID,
            services: [],
            apiProviders: [legacyHost],
            authorize: () => true,
          }),
        );
        try {
          const installed = yield* Effect.promise(() =>
            runtime.install(path.resolve(exampleDir, ".t3-extension"), {
              capabilities: [BROWSER_SESSIONS, BROWSER_OPERATE, BROWSER_DEVTOOLS],
              projectIds: [PROJECT_ID],
            }),
          );
          const call = runtime.invokeApi(
            installed.id,
            installed.contentHash,
            {
              id: "example.browser-sessions/mirror",
              versionRange: "^1.0.0",
              method: "openDevTools",
              input: { tabId: "tab", serverEpoch: "epoch", expectedEngineGeneration: null },
              context: context(),
            },
            new AbortController().signal,
            { principal: meta(provider).principal!, allowWrite: true, revalidate: () => {} },
          );
          yield* Effect.promise(() => expect(call).rejects.toThrow(/incompatible-api/));
          expect(reached).toBe(0);
        } finally {
          yield* Effect.promise(() => runtime.dispose());
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      ),
  );
});
