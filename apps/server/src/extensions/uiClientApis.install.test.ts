import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ClientProviderServerFrame,
} from "@t3tools/contracts";
import type { HostApiRootAuthority } from "@t3tools/extension-runtime";
import { createExtensionRuntime } from "@t3tools/extension-runtime";
import {
  BROWSER_HISTORY_MAX_ENTRIES,
  fitBrowserHistoryList,
  type BrowserHistoryList,
} from "@t3tools/extension-sdk/catalogue";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProcessRunner from "../processRunner.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ClientApiProviders, layer as clientApiProvidersLayer } from "./ClientApiProviders.ts";
import { createUiClientApiProviders } from "./uiClientApis.ts";

const ENV = "env-a";

const testLayer = Layer.mergeAll(
  clientApiProvidersLayer.pipe(
    Layer.provide(
      Layer.succeed(ServerEnvironment, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make(ENV)),
        getDescriptor: Effect.die("unused"),
      }),
    ),
  ),
  ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer)),
);

const context: ViewContext = {
  client: "web",
  workspaceRevision: JSON.stringify(["/workspace", null]),
  resource: {
    namespace: "example.ui-theme-session",
    id: "view",
    environmentId: EnvironmentId.make(ENV),
    projectId: ProjectId.make("project-a"),
  },
};

const root: HostApiRootAuthority = {
  principal: {
    kind: "environment-session",
    id: "session-a",
    environmentId: ENV,
    scopes: ["orchestration:read"],
  },
  allowWrite: true,
  revalidate: () => {},
};

/**
 * Packed install proof: a real `t3-extension build` package installs into the
 * runtime, and its re-exposed `applySessionTheme`/`getState` methods drive the
 * public `t3.ui/theme` contract through the real adapter, the real
 * `ClientApiProviders` connect stream, and a connected client provider.
 */
it.effect(
  "installed packed consumer drives t3.ui/theme over a live client connection and loses write on grant revoke",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.ProcessRunner;
      const built = yield* runner.run({
        command: "node",
        args: [
          path.resolve("../../packages/extension-sdk/bin/t3-extension.mjs"),
          "build",
          path.resolve("../../packages/extension-sdk/examples/ui-theme-session"),
        ],
      });
      expect(built.code, built.stderr).toBe(0);

      const clientApiProviders = yield* ClientApiProviders;
      // The fake web client: a minimal t3.client/theme provider holding a
      // stored preference plus the writer-tagged session overlay.
      const applied: { writer?: string; preference?: unknown; target?: unknown } = {};
      const state: { overlay: { theme: string; writer: string } | null } = { overlay: null };
      const stream = yield* clientApiProviders.connect(
        {
          connectionId: "conn-x",
          sessionId: "session-a",
          announcedOrigin: { surface: "web" },
        },
        { providers: [{ id: "t3.client/theme", version: "1.0.0" }] },
      );
      const driver = yield* stream.pipe(
        Stream.runForEach((frame: ClientProviderServerFrame) =>
          Effect.gen(function* () {
            if (frame.type !== "invoke") return;
            if (frame.apiId !== "t3.client/theme") {
              yield* clientApiProviders.respond("conn-x", {
                requestId: frame.requestId,
                ok: false,
                error: { code: "client-provider-unavailable", message: "unknown api" },
              });
              return;
            }
            const input = frame.input as {
              target: unknown;
              writer: string;
              preference?: { mode: string; theme?: string; clear?: boolean };
            };
            if (frame.method === "applyPreference") {
              applied.writer = input.writer;
              applied.preference = input.preference;
              applied.target = input.target;
              state.overlay = input.preference?.clear
                ? null
                : { theme: input.preference?.theme ?? "system", writer: input.writer };
              yield* clientApiProviders.respond("conn-x", {
                requestId: frame.requestId,
                ok: true,
                value: { applied: true },
              });
            } else if (frame.method === "getState") {
              yield* clientApiProviders.respond("conn-x", {
                requestId: frame.requestId,
                ok: true,
                value: {
                  theme: "system",
                  resolvedTheme: "light",
                  systemDark: false,
                  followSystem: true,
                  appearanceMode: "system",
                  themeHalves: null,
                  effectiveTheme: state.overlay
                    ? {
                        kind: "session-overlay",
                        theme: state.overlay.theme,
                        writer: state.overlay.writer,
                      }
                    : { kind: "stored", theme: "system" },
                  sessionOverlay: state.overlay,
                },
              });
            }
          }),
        ),
        Effect.forkChild,
      );
      try {
        const temp = yield* fs.makeTempDirectoryScoped({ prefix: "ui-theme-install-" });
        const rootDir = yield* fs.realPath(temp);
        const runtime = yield* Effect.promise(() =>
          createExtensionRuntime({
            rootDir,
            environmentId: ENV,
            services: [],
            apiProviders: createUiClientApiProviders({
              environmentId: ENV,
              clientApiProviders,
              authorizeGrant: () => Promise.resolve(true),
              resolveThreadProject: () => Promise.resolve(null),
              readThreadAgentSessions: () => Promise.resolve(null),
            }),
            authorize: (installation, grant, invokeContext) =>
              installation.grants.capabilities.includes(grant) &&
              installation.grants.projectIds.includes(invokeContext.resource.projectId ?? ""),
          }),
        );
        try {
          const installed = yield* Effect.promise(() =>
            runtime.install(
              path.resolve("../../packages/extension-sdk/examples/ui-theme-session/.t3-extension"),
              {
                capabilities: ["t3.ui/theme.read", "t3.ui/theme.write"],
                projectIds: ["project-a"],
              },
            ),
          );
          const signal = new AbortController().signal;
          // The environment session's client stamps its own connection id on
          // the call; the extension forwards it to t3.ui/theme.setPreference.
          const appliedResult = (yield* Effect.promise(() =>
            runtime.invokeApi(
              installed.id,
              installed.contentHash,
              {
                id: "example.ui-theme-session/theme",
                versionRange: "^1.0.0",
                method: "applySessionTheme",
                input: { theme: "ocean", clientConnectionId: "conn-x" },
                context,
                clientConnectionId: "conn-x",
              },
              signal,
              root,
            ),
          )) as { applied: boolean };
          expect(appliedResult.applied).toBe(true);
          // The adapter stamped the verified caller as the writer and the
          // self-proof target — never a raw connection selector.
          expect(applied.writer).toBe("example.ui-theme-session");
          expect(applied.target).toEqual({ kind: "self" });
          expect(applied.preference).toEqual({ mode: "session", theme: "ocean" });

          const stateResult = (yield* Effect.promise(() =>
            runtime.invokeApi(
              installed.id,
              installed.contentHash,
              {
                id: "example.ui-theme-session/theme",
                versionRange: "^1.0.0",
                method: "getState",
                input: { clientConnectionId: "conn-x" },
                context,
                clientConnectionId: "conn-x",
              },
              signal,
              root,
            ),
          )) as Json;
          expect((stateResult as { effectiveTheme: unknown }).effectiveTheme).toEqual({
            kind: "session-overlay",
            theme: "ocean",
            writer: "example.ui-theme-session",
          });

          // Revoking the write grant closes the door in both directions.
          yield* Effect.promise(() =>
            runtime.updateGrants(installed.id, {
              capabilities: ["t3.ui/theme.read"],
              projectIds: ["project-a"],
            }),
          );
          yield* Effect.promise(() =>
            expect(
              runtime.invokeApi(
                installed.id,
                installed.contentHash,
                {
                  id: "example.ui-theme-session/theme",
                  versionRange: "^1.0.0",
                  method: "applySessionTheme",
                  input: { theme: "ember", clientConnectionId: "conn-x" },
                  context,
                  clientConnectionId: "conn-x",
                },
                signal,
                root,
              ),
            ).rejects.toThrow(/grant|denied|authorized|permission/i),
          );
          // The read path still resolves after the revoke.
          const afterRevoke = (yield* Effect.promise(() =>
            runtime.invokeApi(
              installed.id,
              installed.contentHash,
              {
                id: "example.ui-theme-session/theme",
                versionRange: "^1.0.0",
                method: "getState",
                input: { clientConnectionId: "conn-x" },
                context,
                clientConnectionId: "conn-x",
              },
              signal,
              root,
            ),
          )) as Json;
          expect((afterRevoke as { effectiveTheme: { theme: string } }).effectiveTheme.theme).toBe(
            "ocean",
          );
        } finally {
          yield* Effect.promise(() => runtime.dispose());
        }
      } finally {
        yield* Fiber.interrupt(driver);
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

/** A server-entry-only package that declares `t3.ui/external`. */
const EXTERNAL_CONSUMER_MANIFEST =
  '{"format":2,"manifest":{"id":"test.external","apiVersion":1,"version":"1.0.0","surfaces":[]},' +
  '"serverEntry":"server.mjs","tools":[],"provides":[],' +
  '"requires":[{"id":"t3.ui/external","versionRange":"^1.0.0"}],"dependencies":[]}';

/**
 * `t3.ui/external` through the real broker and connect stream: the
 * `t3.ui/external.open` grant gates the invoke before anything reaches the
 * client, and a granted call lands on the caller's own connection.
 */
it.effect("t3.ui/external open is denied without its grant and opened with it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const clientApiProviders = yield* ClientApiProviders;
    const opened: string[] = [];
    const stream = yield* clientApiProviders.connect(
      { connectionId: "conn-x", sessionId: "session-a", announcedOrigin: { surface: "web" } },
      { providers: [{ id: "t3.client/external", version: "1.0.0" }] },
    );
    const driver = yield* stream.pipe(
      Stream.runForEach((frame: ClientProviderServerFrame) =>
        Effect.gen(function* () {
          if (frame.type !== "invoke") return;
          const url = (frame.input as { url: string }).url;
          opened.push(url);
          yield* clientApiProviders.respond("conn-x", {
            requestId: frame.requestId,
            ok: true,
            value: { status: "opened", url, opener: "browser-window" },
          });
        }),
      ),
      Effect.forkChild,
    );
    try {
      const rootDir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "ui-external-install-" }),
      );
      const source = path.join(rootDir, "source");
      yield* fs.makeDirectory(source);
      yield* fs.writeFileString(path.join(source, "t3-extension.json"), EXTERNAL_CONSUMER_MANIFEST);
      yield* fs.writeFileString(
        path.join(source, "server.mjs"),
        "export default {tools:[],apis:[]};",
      );
      const runtime = yield* Effect.promise(() =>
        createExtensionRuntime({
          rootDir: path.join(rootDir, "state"),
          environmentId: ENV,
          services: [],
          apiProviders: createUiClientApiProviders({
            environmentId: ENV,
            clientApiProviders,
            authorizeGrant: () => Promise.resolve(true),
            resolveThreadProject: () => Promise.resolve(null),
            readThreadAgentSessions: () => Promise.resolve(null),
          }),
          authorize: (installation, grant) => installation.grants.capabilities.includes(grant),
        }),
      );
      try {
        const installed = yield* Effect.promise(() =>
          runtime.install(source, { capabilities: [], projectIds: ["project-a"] }),
        );
        const invoke = () =>
          runtime.invokeApi(
            installed.id,
            installed.contentHash,
            {
              id: "t3.ui/external",
              versionRange: "^1.0.0",
              method: "open",
              input: { url: "https://example.com" },
              context,
              clientConnectionId: "conn-x",
            },
            new AbortController().signal,
            root,
          );
        yield* Effect.promise(() =>
          expect(invoke()).rejects.toThrow("API capability denied: t3.ui/external.open"),
        );
        expect(opened).toEqual([]);

        yield* Effect.promise(() =>
          runtime.updateGrants(installed.id, {
            capabilities: ["t3.ui/external.open"],
            projectIds: ["project-a"],
          }),
        );
        const receipt = yield* Effect.promise(() => invoke());
        expect(receipt).toEqual({
          status: "opened",
          url: "https://example.com/",
          opener: "browser-window",
        });
        expect(opened).toEqual(["https://example.com/"]);
      } finally {
        yield* Effect.promise(() => runtime.dispose());
      }
    } finally {
      yield* Fiber.interrupt(driver);
    }
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

/** Browser history is thread-scoped: the client maps the thread to its project. */
const threadContext: ViewContext = {
  ...context,
  resource: { ...context.resource, threadId: "thread-a" },
};

/** A server-entry-only package that declares `t3.browser/history`. */
const HISTORY_CONSUMER_MANIFEST =
  '{"format":2,"manifest":{"id":"test.history","apiVersion":1,"version":"1.0.0","surfaces":[]},' +
  '"serverEntry":"server.mjs","tools":[],"provides":[],' +
  '"requires":[{"id":"t3.browser/history","versionRange":"^1.1.0"}],"dependencies":[]}';

/** A native-maximum project list: 50 distinct 2048-char URLs, most recent first. */
const MAX_HISTORY = Array.from({ length: BROWSER_HISTORY_MAX_ENTRIES }, (_, index) => {
  const prefix = `https://site.test/${String(index).padStart(2, "0")}/`;
  return { url: prefix + "a".repeat(2048 - prefix.length), lastVisitedAt: index };
});

/**
 * `t3.browser/history` through the real broker and connect stream: reads and
 * writes are gated by their own grants before anything reaches the client,
 * a granted call lands on the caller's own connection, and a maximum-size
 * list comes back budgeted rather than rejected at the envelope.
 */
it.effect("t3.browser/history ops are gated by their grants and reach the client", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const clientApiProviders = yield* ClientApiProviders;
    const seen: string[] = [];
    // What the client answers; unset answers with the requested URL alone.
    let answer: BrowserHistoryList | undefined;
    const stream = yield* clientApiProviders.connect(
      { connectionId: "conn-h", sessionId: "session-a", announcedOrigin: { surface: "web" } },
      { providers: [{ id: "t3.client/browser-history", version: "1.1.0" }] },
    );
    const driver = yield* stream.pipe(
      Stream.runForEach((frame: ClientProviderServerFrame) =>
        Effect.gen(function* () {
          if (frame.type !== "invoke") return;
          seen.push(frame.method);
          const url = (frame.input as { url?: string }).url;
          yield* clientApiProviders.respond("conn-h", {
            requestId: frame.requestId,
            ok: true,
            value: answer ?? { entries: url ? [{ url, lastVisitedAt: 1 }] : [] },
          });
        }),
      ),
      Effect.forkChild,
    );
    try {
      const rootDir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "browser-history-install-" }),
      );
      const source = path.join(rootDir, "source");
      yield* fs.makeDirectory(source);
      yield* fs.writeFileString(path.join(source, "t3-extension.json"), HISTORY_CONSUMER_MANIFEST);
      yield* fs.writeFileString(
        path.join(source, "server.mjs"),
        "export default {tools:[],apis:[]};",
      );
      const runtime = yield* Effect.promise(() =>
        createExtensionRuntime({
          rootDir: path.join(rootDir, "state"),
          environmentId: ENV,
          services: [],
          apiProviders: createUiClientApiProviders({
            environmentId: ENV,
            clientApiProviders,
            authorizeGrant: () => Promise.resolve(true),
            resolveThreadProject: () => Promise.resolve(null),
            readThreadAgentSessions: () => Promise.resolve(null),
          }),
          authorize: (installation, grant) => installation.grants.capabilities.includes(grant),
        }),
      );
      try {
        const installed = yield* Effect.promise(() =>
          runtime.install(source, { capabilities: [], projectIds: ["project-a"] }),
        );
        const invoke = (method: string, input: Record<string, string>) =>
          runtime.invokeApi(
            installed.id,
            installed.contentHash,
            {
              id: "t3.browser/history",
              versionRange: "^1.1.0",
              method,
              input,
              context: threadContext,
              clientConnectionId: "conn-h",
            },
            new AbortController().signal,
            root,
          );
        yield* Effect.promise(() =>
          expect(invoke("list", {})).rejects.toThrow(
            "API capability denied: t3.browser/read-history",
          ),
        );
        yield* Effect.promise(() =>
          runtime.updateGrants(installed.id, {
            capabilities: ["t3.browser/read-history"],
            projectIds: ["project-a"],
          }),
        );
        yield* Effect.promise(() =>
          expect(invoke("record", { url: "https://example.com/" })).rejects.toThrow(
            "API capability denied: t3.browser/record-history",
          ),
        );
        expect(seen).toEqual([]);
        expect(yield* Effect.promise(() => invoke("list", {}))).toEqual({ entries: [] });
        yield* Effect.promise(() =>
          runtime.updateGrants(installed.id, {
            capabilities: ["t3.browser/read-history", "t3.browser/record-history"],
            projectIds: ["project-a"],
          }),
        );
        expect(
          yield* Effect.promise(() => invoke("record", { url: "https://example.com/" })),
        ).toEqual({ entries: [{ url: "https://example.com/", lastVisitedAt: 1 }] });
        expect(seen).toEqual(["list", "record"]);

        // The whole native-maximum list is over the envelope: the bridge refuses it.
        answer = { entries: MAX_HISTORY };
        yield* Effect.promise(() =>
          expect(invoke("list", {})).rejects.toThrow("exceeds the envelope bound"),
        );
        // Budgeted as the client provider answers, a read and a write both land.
        answer = fitBrowserHistoryList(MAX_HISTORY);
        for (const [method, input] of [
          ["list", {}],
          ["record", { url: MAX_HISTORY[0]!.url }],
        ] as const) {
          const result = (yield* Effect.promise(() => invoke(method, input))) as {
            entries: { url: string }[];
            truncated?: true;
          };
          expect(result.truncated).toBe(true);
          expect(result.entries.length).toBeGreaterThan(0);
          expect(result.entries.length).toBeLessThan(MAX_HISTORY.length);
          expect(result.entries.map((entry) => entry.url)).toEqual(
            MAX_HISTORY.slice(0, result.entries.length).map((entry) => entry.url),
          );
        }
      } finally {
        yield* Effect.promise(() => runtime.dispose());
      }
    } finally {
      yield* Fiber.interrupt(driver);
    }
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

/** A server-entry-only package that declares `t3.ui/navigation`. */
const NAVIGATION_CONSUMER_MANIFEST =
  '{"format":2,"manifest":{"id":"test.navigation","apiVersion":1,"version":"1.0.0","surfaces":[]},' +
  '"serverEntry":"server.mjs","tools":[],"provides":[],' +
  '"requires":[{"id":"t3.ui/navigation","versionRange":"^1.0.0"}],"dependencies":[]}';

/**
 * `t3.ui/navigation` through the real broker and connect stream: the grant
 * gates the invoke by name, targets outside the caller's project or unknown
 * threads refuse before any client frame, and a scoped target lands on the
 * caller's own connection.
 */
it.effect("t3.ui/navigation openThread is grant-gated and project-scoped", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const clientApiProviders = yield* ClientApiProviders;
    const frames: Json[] = [];
    const stream = yield* clientApiProviders.connect(
      { connectionId: "conn-x", sessionId: "session-a", announcedOrigin: { surface: "web" } },
      { providers: [{ id: "t3.client/navigation", version: "1.0.0" }] },
    );
    const driver = yield* stream.pipe(
      Stream.runForEach((frame: ClientProviderServerFrame) =>
        Effect.gen(function* () {
          if (frame.type !== "invoke") return;
          frames.push(frame.input);
          const { threadId, surfaceId, agentId } = frame.input as {
            threadId?: string;
            surfaceId?: string;
            agentId?: string;
          };
          yield* clientApiProviders.respond("conn-x", {
            requestId: frame.requestId,
            ok: true,
            value:
              frame.method === "openSession"
                ? { status: "opened", agentId: agentId!, opener: "browser-window" }
                : { status: "opened", threadId: threadId!, ...(surfaceId ? { surfaceId } : {}) },
          });
        }),
      ),
      Effect.forkChild,
    );
    try {
      const rootDir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "ui-navigation-install-" }),
      );
      const source = path.join(rootDir, "source");
      yield* fs.makeDirectory(source);
      yield* fs.writeFileString(
        path.join(source, "t3-extension.json"),
        NAVIGATION_CONSUMER_MANIFEST,
      );
      yield* fs.writeFileString(
        path.join(source, "server.mjs"),
        "export default {tools:[],apis:[]};",
      );
      const threadProjects: Record<string, string> = {
        "thread-a": "project-a",
        "thread-b": "project-a",
        "thread-other": "project-b",
      };
      const runtime = yield* Effect.promise(() =>
        createExtensionRuntime({
          rootDir: path.join(rootDir, "state"),
          environmentId: ENV,
          services: [],
          apiProviders: createUiClientApiProviders({
            environmentId: ENV,
            clientApiProviders,
            authorizeGrant: () => Promise.resolve(true),
            resolveThreadProject: (threadId) => Promise.resolve(threadProjects[threadId] ?? null),
            readThreadAgentSessions: (threadId) =>
              Promise.resolve(
                threadId === "thread-a"
                  ? [{ id: "workflow-1", sessionUrl: "https://claude.ai/code/session_1" }]
                  : null,
              ),
          }),
          authorize: (installation, grant, invokeContext) =>
            installation.grants.capabilities.includes(grant) &&
            installation.grants.projectIds.includes(invokeContext.resource.projectId ?? ""),
        }),
      );
      try {
        const installed = yield* Effect.promise(() =>
          runtime.install(source, { capabilities: [], projectIds: ["project-a"] }),
        );
        const openThread = (input: Json) =>
          runtime.invokeApi(
            installed.id,
            installed.contentHash,
            {
              id: "t3.ui/navigation",
              versionRange: "^1.0.0",
              method: "openThread",
              input,
              context,
              clientConnectionId: "conn-x",
            },
            new AbortController().signal,
            root,
          );
        yield* Effect.promise(() =>
          expect(openThread({ threadId: "thread-b" })).rejects.toThrow(
            "API capability denied: t3.ui/navigation.open",
          ),
        );
        // Granted in both projects, the view is still scoped to its own.
        yield* Effect.promise(() =>
          runtime.updateGrants(installed.id, {
            capabilities: ["t3.ui/navigation.open"],
            projectIds: ["project-a", "project-b"],
          }),
        );
        yield* Effect.promise(async () => {
          await expect(openThread({ threadId: "thread-other" })).resolves.toEqual({
            status: "refused",
            reason: "out-of-scope",
          });
          await expect(openThread({ threadId: "thread-gone" })).resolves.toEqual({
            status: "refused",
            reason: "unknown-thread",
          });
        });
        expect(frames).toEqual([]);
        const receipt = yield* Effect.promise(() =>
          openThread({ threadId: "thread-b", surfaceId: "test.navigation/view" }),
        );
        expect(receipt).toEqual({
          status: "opened",
          threadId: "thread-b",
          surfaceId: "test.navigation/view",
        });
        expect(frames).toEqual([
          { target: { kind: "self" }, threadId: "thread-b", surfaceId: "test.navigation/view" },
        ]);
        // Opening an agent's session page is its own capability: the thread
        // navigation grant does not carry it.
        const threadContext: ViewContext = {
          ...context,
          resource: { ...context.resource, threadId: ThreadId.make("thread-a") },
        };
        const openAgentSession = (agentId: string) =>
          runtime.invokeApi(
            installed.id,
            installed.contentHash,
            {
              id: "t3.ui/navigation",
              versionRange: "^1.0.0",
              method: "openAgentSession",
              input: { agentId },
              context: threadContext,
              clientConnectionId: "conn-x",
            },
            new AbortController().signal,
            root,
          );
        yield* Effect.promise(() =>
          expect(openAgentSession("workflow-1")).rejects.toThrow(
            "API capability denied: t3.ui/navigation.open-session",
          ),
        );
        yield* Effect.promise(() =>
          runtime.updateGrants(installed.id, {
            capabilities: ["t3.ui/navigation.open-session"],
            projectIds: ["project-a"],
          }),
        );
        yield* Effect.promise(() =>
          expect(openAgentSession("nobody")).resolves.toEqual({
            status: "refused",
            reason: "unknown-agent",
          }),
        );
        expect(frames).toHaveLength(1);
        yield* Effect.promise(() =>
          expect(openAgentSession("workflow-1")).resolves.toEqual({
            status: "opened",
            agentId: "workflow-1",
            opener: "browser-window",
          }),
        );
        expect(frames.at(-1)).toEqual({
          target: { kind: "self" },
          agentId: "workflow-1",
          url: "https://claude.ai/code/session_1",
        });
      } finally {
        yield* Effect.promise(() => runtime.dispose());
      }
    } finally {
      yield* Fiber.interrupt(driver);
    }
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
