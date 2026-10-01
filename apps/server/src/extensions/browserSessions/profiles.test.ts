import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  BrowserEnginePageStatus,
  ExtensionOperationError,
  ProjectId,
  ThreadId,
  extensionWorkspaceRevision,
  type BrowserEngineHostCommandResultInput,
  type BrowserEngineHostStreamEvent,
  type BrowserEngineProfileCommand,
} from "@t3tools/contracts";
import {
  BROWSER_CLEAR_CACHE,
  BROWSER_CLEAR_COOKIES,
  BROWSER_IMPORT_COOKIES,
  BROWSER_OPERATE,
  BROWSER_PROFILES,
  BROWSER_SESSIONS,
  browserProfilesApi,
  browserProfilesApiV1,
} from "@t3tools/extension-sdk/catalogue";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import type {
  HostApiInvocationMetadata,
  HostApiProvider,
  HostApiRootAuthority,
} from "@t3tools/extension-runtime";
import { createExtensionRuntime } from "@t3tools/extension-runtime";
import { Ajv } from "ajv";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProcessRunner from "../../processRunner.ts";
import * as BrowserEngineHosts from "../../preview/BrowserEngineHosts.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import { type BrowserFaviconAssets, makeBrowserFaviconAssets } from "./faviconAssets.ts";
import { createBrowserProfilesApiProvider } from "./profiles.ts";
import { createBrowserSessionsApiProvider } from "./v1.ts";

const isOperationError = Schema.is(ExtensionOperationError);
const signal = new AbortController().signal;
const ENV_ID = "env";
const PROJECT_ID = "project";
const THREAD_ID = "thread";
const WORKSPACE = "/repo/workspace";
/** `createExtensionRuntime`'s default broker deadline. */
const BROKER_DEFAULT_TIMEOUT_MS = 10_000;
const DESKTOP_SOCKET = { socketId: "desktop-ws", grantMethod: "desktop-bootstrap" } as const;

class InvokeRejection extends Data.TaggedError("InvokeRejection")<{ readonly cause: unknown }> {}

const context = (threadId: string | null = THREAD_ID): ViewContext => ({
  resource: {
    namespace: "test.extension",
    id: "view",
    environmentId: ENV_ID,
    projectId: PROJECT_ID,
    ...(threadId === null ? {} : { threadId }),
  },
  client: "test",
  workspaceRevision: extensionWorkspaceRevision(WORKSPACE, null),
});

const meta = (
  provider: HostApiProvider,
  scopes: readonly string[] = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
): HostApiInvocationMetadata => ({
  callId: "call",
  rootCallerId: "t3.browser",
  callerId: "t3.browser",
  providerId: provider.providerId,
  providerGeneration: 1,
  callerGenerations: [],
  principal: { kind: "environment-session", id: "session", environmentId: ENV_ID, scopes },
  assertAuthority: async () => {},
});

const threads = {
  getById: (input: { readonly threadId: ThreadId }) =>
    Effect.succeed(
      input.threadId === THREAD_ID
        ? Option.some({
            projectId: ProjectId.make(PROJECT_ID),
            worktreePath: null,
            deletedAt: null,
          })
        : Option.none(),
    ),
};

const deps = (
  preview: PreviewManager.PreviewManager["Service"],
  engineHosts: BrowserEngineHosts.BrowserEngineHosts["Service"],
  favicons: BrowserFaviconAssets,
  importAckTimeoutMs = BrowserEngineHosts.IMPORT_ACK_TIMEOUT_MS,
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
  threads,
  preview,
  engineHosts,
  favicons,
  importAckTimeoutMs,
});

const harnessWith = (options: { readonly importAckTimeoutMs?: number }) =>
  Effect.gen(function* () {
    const preview = yield* PreviewManager.PreviewManager;
    const engineHosts = yield* BrowserEngineHosts.BrowserEngineHosts;
    const importAckTimeoutMs = yield* BrowserEngineHosts.ImportAckTimeoutMs;
    // One store for both providers, as the environment wires them.
    const favicons = makeBrowserFaviconAssets();
    return {
      preview,
      engineHosts,
      profiles: createBrowserProfilesApiProvider(
        deps(preview, engineHosts, favicons, importAckTimeoutMs),
      ),
      sessions: createBrowserSessionsApiProvider(deps(preview, engineHosts, favicons)),
    };
  }).pipe(
    Effect.provide(
      BrowserEngineHosts.layer.pipe(
        Layer.provideMerge(PreviewManager.layer),
        Layer.provide(NodeServices.layer),
      ),
    ),
    Effect.provideService(
      BrowserEngineHosts.ImportAckTimeoutMs,
      options.importAckTimeoutMs ?? BrowserEngineHosts.IMPORT_ACK_TIMEOUT_MS,
    ),
  );
const harness = harnessWith({});

const invoke = (provider: HostApiProvider, method: string, input: unknown, ctx = context()) =>
  Effect.tryPromise({
    try: () =>
      Promise.resolve(provider.invoke(method, input as never, ctx, signal, meta(provider))),
    catch: (cause) => new InvokeRejection({ cause }),
  });

const invokeError = (...args: Parameters<typeof invoke>) =>
  invoke(...args).pipe(
    Effect.flip,
    Effect.map((rejection) => {
      if (!isOperationError(rejection.cause)) throw rejection.cause;
      return rejection.cause.detail;
    }),
  );

type Answer = BrowserEngineHostCommandResultInput["result"] | "silent";

const loadedStatus = Schema.decodeUnknownSync(BrowserEnginePageStatus)({
  navStatus: { _tag: "Success", url: "http://localhost:5173/", title: "App" },
  canGoBack: false,
  canGoForward: false,
  zoomFactor: 1,
  appearance: "system",
  audioMuted: false,
  audible: false,
  devToolsOpen: false,
  pictureInPicture: false,
  favicon: null,
});

const WORK_PROFILES: Answer = {
  outcome: "profiles",
  profiles: [
    { id: "default", name: "Default" },
    { id: "incognito", name: "Incognito" },
    { id: "work", name: "Work" },
  ],
  defaultProfileId: "default",
};

/**
 * Registers the desktop as the engine host and answers every profile frame
 * with `answer(command)`, recording what arrived. Page command frames queue
 * on `pageCommands`; import proceed/cancel frames queue on `controls`, and a
 * silent frame can be answered later through `respond`.
 */
const attachProfileHost = Effect.fn("test.attachProfileHost")(function* (
  engineHosts: BrowserEngineHosts.BrowserEngineHosts["Service"],
  answer: (command: BrowserEngineProfileCommand) => Answer,
) {
  const received: BrowserEngineProfileCommand[] = [];
  const arrivals = yield* Queue.unbounded<BrowserEngineProfileCommand>();
  const pageCommands = yield* Queue.unbounded<BrowserEngineHostStreamEvent>();
  const controls = yield* Queue.unbounded<BrowserEngineHostStreamEvent>();
  const commandIds: string[] = [];
  const registered = yield* Deferred.make<string>();
  const stream = yield* engineHosts.register(DESKTOP_SOCKET);
  let hostConnectionId = "";
  const fiber = yield* stream.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        if (event.type === "registered") {
          hostConnectionId = event.hostConnectionId;
          yield* Deferred.succeed(registered, event.hostConnectionId);
          return;
        }
        if (event.type === "command") {
          yield* Queue.offer(pageCommands, event);
          return;
        }
        if (event.type !== "profile-command") {
          yield* Queue.offer(controls, event);
          return;
        }
        received.push(event.command);
        commandIds.push(event.commandId);
        yield* Queue.offer(arrivals, event.command);
        const result = answer(event.command);
        if (result === "silent") return;
        yield* engineHosts.commandResult(DESKTOP_SOCKET, {
          hostConnectionId,
          commandId: event.commandId,
          result,
        });
      }),
    ),
    Effect.forkScoped,
  );
  // Registration lands before the first command can be dispatched.
  yield* Deferred.await(registered);
  /** Answers the `index`th profile frame, as a host that kept the user waiting. */
  const respond = (index: number, result: BrowserEngineHostCommandResultInput["result"]) =>
    engineHosts.commandResult(DESKTOP_SOCKET, {
      hostConnectionId,
      commandId: commandIds[index]!,
      result,
    });
  return {
    received,
    arrivals,
    pageCommands,
    controls,
    commandIds,
    respond,
    fiber,
    hostConnectionId: () => hostConnectionId,
  };
});

const listProfilesOr =
  (other: (command: BrowserEngineProfileCommand) => Answer) =>
  (command: BrowserEngineProfileCommand): Answer =>
    command._tag === "listProfiles" ? WORK_PROFILES : other(command);

describe("browser profiles adapter", () => {
  it.effect("declares one distinct grant per capability", () =>
    Effect.sync(() => {
      const grants = Object.fromEntries(
        browserProfilesApi.definition.methods!.map((method) => [
          method.name,
          method.requiredGrants,
        ]),
      );
      expect(grants).toEqual({
        list: [BROWSER_PROFILES],
        open: [BROWSER_SESSIONS, BROWSER_OPERATE, BROWSER_PROFILES],
        clearCookies: [BROWSER_CLEAR_COOKIES],
        clearCache: [BROWSER_CLEAR_CACHE],
        listImportSources: [BROWSER_IMPORT_COOKIES],
        importCookies: [BROWSER_IMPORT_COOKIES],
      });
    }),
  );

  it.effect("every method fails desktop-required by name when no engine host is connected", () =>
    Effect.gen(function* () {
      const { profiles, preview } = yield* harness;
      const calls: ReadonlyArray<readonly [string, unknown]> = [
        ["list", {}],
        ["open", { profileId: "work" }],
        ["clearCookies", { profileId: "work" }],
        ["clearCache", { profileId: "work" }],
        ["listImportSources", {}],
        ["importCookies", { profileId: "work", sourceId: "chrome", sourceProfile: "p0" }],
      ];
      for (const [method, input] of calls) {
        const detail = yield* invokeError(profiles, method, input);
        expect(detail, method).toContain("BrowserProfilesUnsupported");
        expect(detail, method).toContain("(desktop-required)");
      }
      // Nothing was opened on the way to the refusal.
      expect((yield* preview.listDetails({ threadId: ThreadId.make(THREAD_ID) })).sessions).toEqual(
        [],
      );
    }),
  );

  it.effect("a host lacking an operation fails engine-unsupported, not desktop-required", () =>
    Effect.gen(function* () {
      const { profiles, engineHosts } = yield* harness;
      yield* attachProfileHost(engineHosts, () => ({
        outcome: "rejected",
        reason: "not-applicable",
      }));
      const detail = yield* invokeError(profiles, "clearCache", { profileId: "work" });
      expect(detail).toContain("BrowserProfilesUnsupported");
      expect(detail).toContain("(engine-unsupported)");
    }),
  );

  it.effect("list projects opaque ids and names only", () =>
    Effect.gen(function* () {
      const { profiles, engineHosts } = yield* harness;
      yield* attachProfileHost(engineHosts, () => WORK_PROFILES);
      expect(yield* invoke(profiles, "list", {})).toEqual({
        profiles: [
          { id: "default", name: "Default" },
          { id: "incognito", name: "Incognito" },
          { id: "work", name: "Work" },
        ],
        defaultProfileId: "default",
      });
    }),
  );

  it.effect("open fixes a known profile on the new session and refuses an unknown one", () =>
    Effect.gen(function* () {
      const { profiles, engineHosts, preview } = yield* harness;
      yield* attachProfileHost(engineHosts, () => WORK_PROFILES);
      const receipt = (yield* invoke(profiles, "open", {
        profileId: "work",
        url: "localhost:5173",
      })) as { outcome: string; session: { profileId?: string; tabId: string } };
      expect(receipt.outcome).toBe("accepted");
      expect(receipt.session.profileId).toBe("work");

      const missing = yield* invokeError(profiles, "open", { profileId: "personal" });
      expect(missing).toContain("BrowserProfileNotFound");
      // The refused id minted no session (and so no orphan partition at attach).
      const listed = yield* preview.listDetails({ threadId: ThreadId.make(THREAD_ID) });
      expect(listed.sessions.map((entry) => entry.snapshot.profileId)).toEqual(["work"]);

      const threadless = yield* invokeError(profiles, "open", { profileId: "work" }, context(null));
      expect(threadless).toContain("thread-scoped");
    }),
  );

  it.effect("profile-opened sessions are DevTools-owned by the calling installation", () =>
    Effect.gen(function* () {
      const { profiles, sessions, engineHosts } = yield* harness;
      yield* attachProfileHost(engineHosts, () => WORK_PROFILES);
      const receipt = (yield* invoke(profiles, "open", { profileId: "work" })) as {
        serverEpoch: string;
        session: { tabId: string };
      };
      const guard = {
        tabId: receipt.session.tabId,
        serverEpoch: receipt.serverEpoch,
        expectedEngineGeneration: null,
      };
      const devToolsRefusal = (callerId: string) =>
        Effect.flip(
          Effect.tryPromise({
            try: () =>
              Promise.resolve(
                sessions.invoke("openDevTools", guard as never, context(), signal, {
                  ...meta(sessions),
                  callerId,
                }),
              ),
            catch: (cause) => new InvokeRejection({ cause }),
          }),
        ).pipe(
          Effect.map((rejection) =>
            isOperationError(rejection.cause) ? rejection.cause.detail : String(rejection.cause),
          ),
        );
      // The owning installation gets past ownership (refused later, no attached engine).
      const own = yield* devToolsRefusal("t3.browser");
      expect(own).not.toContain("BrowserSessionNotOwned");
      // Another installation is refused as not-owned before any host is asked.
      const foreign = yield* devToolsRefusal("t3.other");
      expect(foreign).toContain("BrowserSessionNotOwned");
    }),
  );

  it.effect("sessions.open refuses a profile: operate alone cannot choose one", () =>
    Effect.gen(function* () {
      const { sessions, engineHosts, preview } = yield* harness;
      yield* attachProfileHost(engineHosts, () => WORK_PROFILES);
      const detail = yield* invokeError(sessions, "open", {
        url: "localhost:5173",
        profileId: "work",
      });
      expect(detail).toContain("BrowserProfileGrantRequired");
      expect((yield* preview.listDetails({ threadId: ThreadId.make(THREAD_ID) })).sessions).toEqual(
        [],
      );
      // Without a profile it still opens under the default partition.
      const opened = (yield* invoke(sessions, "open", { url: "localhost:5173" })) as {
        session: { profileId?: string };
      };
      expect(opened.session.profileId).toBeUndefined();
    }),
  );

  it.effect("a session's profile survives guest crash recovery with the engine verbs", () =>
    Effect.gen(function* () {
      const { profiles, sessions, engineHosts } = yield* harness;
      const host = yield* attachProfileHost(engineHosts, () => WORK_PROFILES);
      const receipt = (yield* invoke(profiles, "open", {
        profileId: "work",
        url: "localhost:5173",
      })) as { serverEpoch: string; session: { tabId: string } };
      const fence = {
        hostConnectionId: host.hostConnectionId(),
        target: {
          threadId: ThreadId.make(THREAD_ID),
          tabId: receipt.session.tabId,
          serverEpoch: receipt.serverEpoch,
        },
        engineGeneration: "41",
      };
      yield* engineHosts.claim(DESKTOP_SOCKET, fence);
      const status = loadedStatus;
      yield* engineHosts.report(DESKTOP_SOCKET, { ...fence, status });
      yield* engineHosts.report(DESKTOP_SOCKET, { ...fence, lifecycle: "crashed" });
      yield* engineHosts.report(DESKTOP_SOCKET, { ...fence, lifecycle: "recovering" });
      // The replacement guest remounts from the session snapshot: new generation, same profile.
      yield* engineHosts.release(DESKTOP_SOCKET, fence);
      const replacement = { ...fence, engineGeneration: "42" };
      yield* engineHosts.claim(DESKTOP_SOCKET, replacement);
      yield* engineHosts.report(DESKTOP_SOCKET, { ...replacement, status });

      const listed = (yield* invoke(sessions, "list", {})) as {
        sessions: { profileId?: string; engine: unknown }[];
      };
      expect(listed.sessions).toHaveLength(1);
      expect(listed.sessions[0]!.profileId).toBe("work");
      expect(listed.sessions[0]!.engine).toEqual({ state: "ready", generation: "42" });

      // Engine verbs reach the recovered guest under its new generation.
      const reload = yield* Effect.forkChild(
        invoke(sessions, "reload", {
          tabId: receipt.session.tabId,
          serverEpoch: receipt.serverEpoch,
          expectedEngineGeneration: "42",
        }),
      );
      const frame = yield* Queue.take(host.pageCommands);
      if (frame.type !== "command") throw new Error("expected a page command");
      expect(frame.engineGeneration).toBe("42");
      yield* engineHosts.commandResult(DESKTOP_SOCKET, {
        hostConnectionId: host.hostConnectionId(),
        commandId: frame.commandId,
        result: { outcome: "applied" },
      });
      const reloaded = (yield* Fiber.join(reload)) as {
        outcome: string;
        session: { profileId?: string };
      };
      expect(reloaded.outcome).toBe("accepted");
      expect(reloaded.session.profileId).toBe("work");
    }),
  );

  it.effect("clearCookies and clearCache each reach the host for exactly the named profile", () =>
    Effect.gen(function* () {
      const { profiles, engineHosts } = yield* harness;
      const host = yield* attachProfileHost(engineHosts, () => ({ outcome: "applied" }));
      expect(yield* invoke(profiles, "clearCookies", { profileId: "work" })).toEqual({
        outcome: "cleared",
        profileId: "work",
      });
      expect(yield* invoke(profiles, "clearCache", { profileId: "incognito" })).toEqual({
        outcome: "cleared",
        profileId: "incognito",
      });
      expect(host.received).toEqual([
        { _tag: "clearCookies", profileId: "work" },
        { _tag: "clearCache", profileId: "incognito" },
      ]);
      // There is no all-profiles clear: an absent profile never reaches the host.
      const unnamed = yield* invokeError(profiles, "clearCookies", {});
      expect(unnamed).toContain("BrowserProfileInputError");
      expect(host.received).toHaveLength(2);
    }),
  );

  it.effect("a clear the host cannot map to a profile fails by name", () =>
    Effect.gen(function* () {
      const { profiles, engineHosts } = yield* harness;
      yield* attachProfileHost(engineHosts, () => ({
        outcome: "rejected",
        reason: "unknown-profile",
      }));
      expect(yield* invokeError(profiles, "clearCookies", { profileId: "gone" })).toContain(
        "BrowserProfileNotFound",
      );
    }),
  );

  it.effect("a host that disconnects mid-clear yields unknown, never cleared", () =>
    Effect.gen(function* () {
      const { profiles, engineHosts } = yield* harness;
      const host = yield* attachProfileHost(engineHosts, () => "silent");
      const pending = yield* Effect.forkChild(
        invoke(profiles, "clearCookies", { profileId: "work" }),
      );
      yield* Queue.take(host.arrivals);
      yield* Fiber.interrupt(host.fiber);
      expect(yield* Fiber.join(pending)).toEqual({ outcome: "unknown", profileId: "work" });
    }),
  );

  it.effect("cookie import sends a handle and the requester, and returns counts only", () =>
    Effect.gen(function* () {
      const { profiles, engineHosts } = yield* harness;
      const host = yield* attachProfileHost(
        engineHosts,
        listProfilesOr((command) =>
          command._tag === "listImportSources"
            ? {
                outcome: "import-sources",
                sources: [
                  {
                    id: "chrome",
                    name: "Google Chrome",
                    profiles: [{ handle: "p0", name: "Person 1", cookieCount: 12 }],
                  },
                  {
                    id: "safari",
                    name: "Safari",
                    unavailable: "needsFullDiskAccess",
                    profiles: [],
                  },
                ],
              }
            : { outcome: "imported", imported: 10, skipped: 2 },
        ),
      );
      expect(yield* invoke(profiles, "listImportSources", {})).toEqual({
        sources: [
          {
            id: "chrome",
            name: "Google Chrome",
            profiles: [{ handle: "p0", name: "Person 1", cookieCount: 12 }],
          },
          { id: "safari", name: "Safari", unavailable: "needsFullDiskAccess", profiles: [] },
        ],
      });
      expect(
        yield* invoke(profiles, "importCookies", {
          profileId: "work",
          sourceId: "chrome",
          sourceProfile: "p0",
        }),
      ).toEqual({ outcome: "imported", profileId: "work", imported: 10, skipped: 2 });
      expect(host.received.at(-1)).toEqual({
        _tag: "importCookies",
        profileId: "work",
        sourceId: "chrome",
        sourceProfile: "p0",
        requester: "t3.browser",
      });
      // Directories never pass the public schema.
      expect(
        yield* invokeError(profiles, "importCookies", {
          profileId: "work",
          sourceId: "chrome",
          sourceProfile: "p0",
          sourceProfileDirectory: "Profile 1",
        }),
      ).toContain("BrowserProfileInputError");
      expect(
        yield* invokeError(profiles, "importCookies", {
          profileId: "work",
          sourceId: "netscape",
          sourceProfile: "p0",
        }),
      ).toContain("BrowserProfileInputError");
    }),
  );

  it.effect("authority lost while the prompt is open cancels once the user confirms", () =>
    Effect.gen(function* () {
      const { profiles, engineHosts } = yield* harness;
      const host = yield* attachProfileHost(engineHosts, () => "silent");
      let authorized = true;
      const metadata: HostApiInvocationMetadata = {
        ...meta(profiles),
        assertAuthority: async () => {
          if (!authorized) throw new Error("revoked");
        },
      };
      const importing = yield* Effect.forkChild(
        Effect.tryPromise({
          try: () =>
            Promise.resolve(
              profiles.invoke(
                "importCookies",
                { profileId: "work", sourceId: "chrome", sourceProfile: "p0" },
                context(),
                signal,
                metadata,
              ),
            ),
          catch: (cause) => new InvokeRejection({ cause }),
        }),
      );
      yield* Queue.take(host.arrivals);
      authorized = false;
      yield* host.respond(0, { outcome: "confirmed" });
      expect(yield* Queue.take(host.controls)).toEqual({
        type: "profile-command-cancel",
        commandId: host.commandIds[0],
      });
      const refused = yield* Fiber.join(importing).pipe(Effect.flip);
      expect(isOperationError(refused.cause) && refused.cause.detail).toContain(
        "authority was revoked",
      );
      expect(yield* Queue.size(host.controls)).toBe(0);
    }),
  );

  it.effect("declined and failed imports come back as closed outcomes", () =>
    Effect.gen(function* () {
      const { profiles, engineHosts } = yield* harness;
      const answers: Answer[] = [
        { outcome: "declined" },
        { outcome: "import-failed", reason: "browserRunning" },
        // New-profile bookkeeping cannot occur for an existing target.
        { outcome: "import-failed", reason: "profileLimitReached" },
      ];
      yield* attachProfileHost(engineHosts, () => answers.shift()!);
      const input = { profileId: "work", sourceId: "chrome", sourceProfile: "p0" };
      expect(yield* invoke(profiles, "importCookies", input)).toEqual({
        outcome: "declined",
        profileId: "work",
      });
      expect(yield* invoke(profiles, "importCookies", input)).toEqual({
        outcome: "failed",
        profileId: "work",
        reason: "browserRunning",
      });
      expect(yield* invoke(profiles, "importCookies", input)).toEqual({
        outcome: "failed",
        profileId: "work",
        reason: "readFailed",
      });
    }),
  );

  it.effect("read-only principals cannot clear, import or open", () =>
    Effect.gen(function* () {
      const { profiles, engineHosts } = yield* harness;
      const host = yield* attachProfileHost(engineHosts, () => ({ outcome: "applied" }));
      for (const method of ["open", "clearCookies", "clearCache", "importCookies"]) {
        const refused = yield* Effect.tryPromise({
          try: () =>
            Promise.resolve(
              profiles.invoke(
                method,
                { profileId: "work", sourceId: "chrome", sourceProfile: "p0" } as never,
                context(),
                signal,
                meta(profiles, [AuthOrchestrationReadScope]),
              ),
            ),
          catch: (cause) => new InvokeRejection({ cause }),
        }).pipe(Effect.flip);
        expect(isOperationError(refused.cause), method).toBe(true);
      }
      expect(host.received).toEqual([]);
    }),
  );
});

/**
 * The real extension runtime and broker around `profiles`, with the browser
 * profiles example installed as a consumer that declares only
 * `t3.browser/profiles`, so grants alone decide.
 */
const brokerRuntime = Effect.fn("test.brokerRuntime")(function* (
  profiles: HostApiProvider,
  options: { readonly timeoutMs?: number; readonly grants?: ReadonlyArray<string> } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packages = path.resolve(import.meta.dirname, "../../../../../packages");
  const exampleDir = path.join(packages, "extension-sdk/examples/browser-profiles");
  const runner = yield* ProcessRunner.ProcessRunner;
  const built = yield* runner.run({
    command: "node",
    args: [path.join(packages, "extension-sdk/bin/t3-extension.mjs"), "build", exampleDir],
  });
  expect(built.code, built.stderr).toBe(0);
  const rootDir = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "s7a-profiles-" }),
  );
  const runtime = yield* Effect.promise(() =>
    createExtensionRuntime({
      rootDir,
      environmentId: ENV_ID,
      services: [],
      apiProviders: [profiles],
      authorize: (installation, grant, ctx) =>
        installation.grants.capabilities.includes(grant) &&
        installation.grants.projectIds.includes(ctx.resource.projectId ?? ""),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }),
  );
  yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()));
  const installed = yield* Effect.promise(() =>
    runtime.install(path.join(exampleDir, ".t3-extension"), {
      capabilities: [...(options.grants ?? [])],
      projectIds: [PROJECT_ID],
    }),
  );
  const root: HostApiRootAuthority = {
    principal: meta(profiles).principal!,
    allowWrite: true,
    revalidate: () => {},
  };
  const call = (method: string, input: Record<string, unknown>) =>
    runtime.invokeApi(
      installed.id,
      installed.contentHash,
      {
        id: BROWSER_PROFILES,
        versionRange: "^1.0.0",
        method,
        input: input as never,
        context: context(),
      },
      new AbortController().signal,
      root,
    );
  return { runtime, installed, call };
});

describe("browser profiles grants through the broker", () => {
  it.effect("each grant unlocks its own method and implies none of the others", () =>
    Effect.gen(function* () {
      const { profiles, engineHosts } = yield* harness;
      yield* attachProfileHost(
        engineHosts,
        listProfilesOr((command) =>
          command._tag === "listImportSources"
            ? { outcome: "import-sources", sources: [] }
            : command._tag === "importCookies"
              ? { outcome: "declined" }
              : { outcome: "applied" },
        ),
      );
      const { runtime, installed, call } = yield* brokerRuntime(profiles);
      const calls: Record<string, Record<string, unknown>> = {
        list: {},
        clearCookies: { profileId: "work" },
        clearCache: { profileId: "work" },
        listImportSources: {},
        importCookies: { profileId: "work", sourceId: "chrome", sourceProfile: "p0" },
      };
      const grantFor: Record<string, string> = {
        list: BROWSER_PROFILES,
        clearCookies: BROWSER_CLEAR_COOKIES,
        clearCache: BROWSER_CLEAR_CACHE,
        listImportSources: BROWSER_IMPORT_COOKIES,
        importCookies: BROWSER_IMPORT_COOKIES,
      };
      for (const held of [
        BROWSER_PROFILES,
        BROWSER_CLEAR_COOKIES,
        BROWSER_CLEAR_CACHE,
        BROWSER_IMPORT_COOKIES,
      ]) {
        yield* Effect.promise(() =>
          runtime.updateGrants(installed.id, { capabilities: [held], projectIds: [PROJECT_ID] }),
        );
        for (const [method, input] of Object.entries(calls)) {
          const outcome = yield* Effect.promise(() =>
            call(method, input).then(
              () => "allowed",
              (error: unknown) => (error instanceof Error ? error.message : String(error)),
            ),
          );
          if (grantFor[method] === held) expect(outcome, `${held} → ${method}`).toBe("allowed");
          else
            expect(outcome, `${held} → ${method}`).toContain(
              `API capability denied: ${grantFor[method]}`,
            );
        }
      }
      // Opening under a profile needs the profiles grant on top of operate.
      yield* Effect.promise(() =>
        runtime.updateGrants(installed.id, {
          capabilities: [BROWSER_SESSIONS, BROWSER_OPERATE],
          projectIds: [PROJECT_ID],
        }),
      );
      yield* Effect.promise(() =>
        expect(call("open", { profileId: "work" })).rejects.toThrow(
          `API capability denied: ${BROWSER_PROFILES}`,
        ),
      );
      yield* Effect.promise(() =>
        runtime.updateGrants(installed.id, {
          capabilities: [BROWSER_SESSIONS, BROWSER_OPERATE, BROWSER_PROFILES],
          projectIds: [PROJECT_ID],
        }),
      );
      const opened = (yield* Effect.promise(() => call("open", { profileId: "work" }))) as {
        session: { profileId?: string };
      };
      expect(opened.session.profileId).toBe("work");

      // The broker's schema gate runs before any grant is consulted: no
      // all-profiles clear and no source directory ever reach the adapter.
      yield* Effect.promise(() =>
        runtime.updateGrants(installed.id, {
          capabilities: [BROWSER_CLEAR_COOKIES, BROWSER_IMPORT_COOKIES],
          projectIds: [PROJECT_ID],
        }),
      );
      yield* Effect.promise(() =>
        expect(call("clearCookies", {})).rejects.toThrow("API input does not match schema"),
      );
      yield* Effect.promise(() =>
        expect(
          call("importCookies", {
            profileId: "work",
            sourceId: "chrome",
            sourceProfile: "p0",
            sourceProfileDirectory: "Profile 1",
          }),
        ).rejects.toThrow("API input does not match schema"),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
  );

  const IMPORT_INPUT = { profileId: "work", sourceId: "chrome", sourceProfile: "p0" };
  const settled = <A>(promise: Promise<A>) =>
    Effect.promise(() =>
      promise.then(
        (value) => ({ value }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
      ),
    );

  it.effect("an import outlives the broker's default deadline and still returns its outcome", () =>
    Effect.gen(function* () {
      const { profiles, engineHosts } = yield* harness;
      const host = yield* attachProfileHost(engineHosts, () => "silent");
      // Installation finishes on the worker's ready handshake in real time;
      // only then do the deadlines move to a clock this test advances.
      const { call } = yield* brokerRuntime(profiles, {
        grants: [BROWSER_PROFILES, BROWSER_IMPORT_COOKIES],
      });
      yield* Effect.acquireRelease(
        Effect.sync(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })),
        () => Effect.sync(() => vi.useRealTimers()),
      );

      // The user takes longer than the default deadline to confirm: a list
      // issued after the import expires under that deadline first.
      const importing = call("importCookies", IMPORT_INPUT);
      expect((yield* Queue.take(host.arrivals))._tag).toBe("importCookies");
      const listing = settled(call("list", {}));
      expect((yield* Queue.take(host.arrivals))._tag).toBe("listProfiles");
      vi.advanceTimersByTime(BROKER_DEFAULT_TIMEOUT_MS);
      expect(yield* listing).toEqual({ error: "API deadline exceeded" });
      yield* host.respond(0, { outcome: "confirmed" });
      expect(yield* Queue.take(host.controls)).toMatchObject({ type: "profile-command-proceed" });
      yield* host.respond(0, { outcome: "imported", imported: 5, skipped: 1 });
      expect(yield* settled(importing)).toEqual({
        value: { outcome: "imported", profileId: "work", imported: 5, skipped: 1 },
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
  );

  it.effect("a prompt nobody answers expires on the import wait, not the broker's", () =>
    Effect.gen(function* () {
      const { profiles, engineHosts } = yield* harness;
      const host = yield* attachProfileHost(engineHosts, () => "silent");
      yield* Effect.acquireRelease(
        Effect.sync(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })),
        () => Effect.sync(() => vi.useRealTimers()),
      );
      // The provider runner itself, as the broker calls it: its import wait
      // is armed before the frame reaches the host.
      const abandoned = settled(
        Promise.resolve(
          profiles.invoke("importCookies", IMPORT_INPUT, context(), signal, meta(profiles)),
        ),
      );
      yield* Queue.take(host.arrivals);
      // The broker's deadline for an import lies beyond the import wait.
      expect(profiles.deadlineMs!("importCookies")).toBeGreaterThan(
        BrowserEngineHosts.IMPORT_ACK_TIMEOUT_MS,
      );
      vi.advanceTimersByTime(BrowserEngineHosts.IMPORT_ACK_TIMEOUT_MS);
      expect(yield* Queue.take(host.controls)).toEqual({
        type: "profile-command-cancel",
        commandId: host.commandIds[0],
      });
      expect(yield* abandoned).toEqual({ value: { outcome: "unknown", profileId: "work" } });
    }),
  );

  it.effect("revoking the grant while the prompt is open cancels the import on the host", () =>
    Effect.gen(function* () {
      const { profiles, engineHosts } = yield* harness;
      const host = yield* attachProfileHost(
        engineHosts,
        listProfilesOr(() => "silent"),
      );
      const { runtime, installed, call } = yield* brokerRuntime(profiles, {
        grants: [BROWSER_IMPORT_COOKIES],
      });
      const importing = call("importCookies", IMPORT_INPUT);
      yield* Queue.take(host.arrivals);
      yield* Effect.promise(() =>
        runtime.updateGrants(installed.id, { capabilities: [], projectIds: [PROJECT_ID] }),
      );
      expect(yield* settled(importing)).toEqual({ error: "API configuration changed" });
      expect(yield* Queue.take(host.controls)).toEqual({
        type: "profile-command-cancel",
        commandId: host.commandIds[0],
      });
      // The user accepts the prompt anyway: nothing tells the host to proceed.
      yield* host.respond(0, { outcome: "confirmed" });
      expect(yield* Queue.size(host.controls)).toBe(0);
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
  );
});

describe("browser profiles changes stream (1.1.0)", () => {
  const LIST = {
    profiles: [
      { id: "default", name: "Default" },
      { id: "work", name: "Work" },
    ],
    defaultProfileId: "default",
  };
  const RENAMED = {
    ...LIST,
    profiles: [LIST.profiles[0]!, { id: "work", name: "Client work" }],
  };
  const DELETED = { ...LIST, profiles: [LIST.profiles[0]!] };
  const NEW_DEFAULT = { ...RENAMED, defaultProfileId: "work" };
  /** A desktop is connected but has not published its list yet. */
  const LOADING = { type: "data", value: { list: null, pending: true } };

  /** Opens `changes` as the broker would; `next` pulls one event. */
  const openChanges = (provider: HostApiProvider, metadata = meta(provider)) =>
    Effect.sync(() => {
      const iterator = provider.subscribe!("changes", {}, context(), signal, metadata)[
        Symbol.asyncIterator
      ]();
      return {
        next: Effect.promise(() => iterator.next()),
        close: Effect.promise(async () => {
          await iterator.return?.();
        }),
      };
    });

  const publish = (
    engineHosts: BrowserEngineHosts.BrowserEngineHosts["Service"],
    hostConnectionId: string,
    list: typeof LIST,
  ) => engineHosts.publishProfiles(DESKTOP_SOCKET, { hostConnectionId, ...list });

  /** A window that answers a list read with whatever it last published. */
  const attachWindow = Effect.fn("test.attachWindow")(function* (
    engineHosts: BrowserEngineHosts.BrowserEngineHosts["Service"],
  ) {
    let published: typeof LIST | null = null;
    const host = yield* attachProfileHost(engineHosts, (command) =>
      command._tag === "listProfiles" && published !== null
        ? { outcome: "profiles", ...published }
        : "silent",
    );
    return {
      ...host,
      publish: (list: typeof LIST) => {
        published = list;
        return publish(engineHosts, host.hostConnectionId(), list);
      },
    };
  });

  const listed = (profiles: HostApiProvider) => invoke(profiles, "list", {});

  it.effect("declares the stream under the list grant, with 1.0.0 kept frozen", () =>
    Effect.sync(() => {
      expect(browserProfilesApi.definition.version).toBe("1.1.0");
      expect(browserProfilesApi.baseline).toBe("1.0.0");
      expect(browserProfilesApi.definition.streams).toEqual([
        expect.objectContaining({ name: "changes", requiredGrants: [BROWSER_PROFILES] }),
      ]);
      expect(browserProfilesApiV1.definition.version).toBe("1.0.0");
      expect(browserProfilesApiV1.definition.streams).toBeUndefined();
      expect(browserProfilesApiV1.definition.methods).toEqual(
        browserProfilesApi.definition.methods,
      );
    }),
  );

  it.effect(
    "an event is a list, null, or null and pending, as strict validation reads the schema",
    () =>
      Effect.sync(() => {
        const validate = new Ajv({ strict: true, addUsedSchema: false }).compile(
          browserProfilesApi.definition.streams![0]!.eventSchema,
        );
        expect(validate({ list: LIST })).toBe(true);
        expect(validate({ list: null })).toBe(true);
        expect(validate({ list: null, pending: true })).toBe(true);
        expect(validate({ list: LIST, pending: true })).toBe(false);
        expect(validate({ list: null, pending: false })).toBe(false);
        expect(validate({ list: { profiles: [], defaultProfileId: "default" } })).toBe(true);
        expect(validate(LIST)).toBe(false);
        expect(validate({})).toBe(false);
        expect(validate({ list: { profiles: [] } })).toBe(false);
      }),
  );

  it.effect("starts from the published list, then sends each change and no repeats", () =>
    Effect.gen(function* () {
      const { profiles, engineHosts } = yield* harness;
      const host = yield* attachWindow(engineHosts);
      yield* host.publish(LIST);
      const changes = yield* openChanges(profiles);
      expect(yield* changes.next).toEqual({
        done: false,
        value: { type: "snapshot", value: { list: LIST } },
      });
      // An unchanged publication (another settings edit) sends nothing: the
      // next event is the rename that follows it.
      yield* host.publish(LIST);
      yield* host.publish(RENAMED);
      expect(yield* changes.next).toEqual({
        done: false,
        value: { type: "data", value: { list: RENAMED } },
      });
      yield* host.publish(DELETED);
      expect((yield* changes.next).value).toEqual({ type: "data", value: { list: DELETED } });
      yield* host.publish(NEW_DEFAULT);
      expect((yield* changes.next).value).toEqual({ type: "data", value: { list: NEW_DEFAULT } });
      yield* changes.close;
    }),
  );

  it.effect("a change published from any window reaches every subscriber and `list`", () =>
    Effect.gen(function* () {
      const { profiles, engineHosts } = yield* harness;
      const windowA = yield* attachWindow(engineHosts);
      const windowB = yield* attachWindow(engineHosts);
      yield* windowA.publish(LIST);
      yield* windowB.publish(LIST);
      const changes = yield* openChanges(profiles);
      expect((yield* changes.next).value).toEqual({ type: "snapshot", value: { list: LIST } });

      // Rename, delete and a new default, each edited in window B while
      // window A (registered first) has not yet heard of it.
      for (const edit of [RENAMED, DELETED, NEW_DEFAULT]) {
        yield* windowB.publish(edit);
        expect((yield* changes.next).value).toEqual({ type: "data", value: { list: edit } });
        expect(yield* listed(profiles)).toEqual(edit);
      }
      // Window A catches up with the same list: nothing new.
      yield* windowA.publish(NEW_DEFAULT);
      // An edit made back in window A is just as current.
      yield* windowA.publish(LIST);
      expect((yield* changes.next).value).toEqual({ type: "data", value: { list: LIST } });
      expect(yield* listed(profiles)).toEqual(LIST);
      // Window A leaves: B's list (caught up) is the same, so nothing new;
      // B leaving too makes the list unavailable, and a window that connects
      // again brings it back.
      yield* windowB.publish(LIST);
      yield* Fiber.interrupt(windowA.fiber);
      yield* Fiber.interrupt(windowB.fiber);
      expect((yield* changes.next).value).toEqual({ type: "data", value: { list: null } });
      const windowC = yield* attachWindow(engineHosts);
      expect((yield* changes.next).value).toEqual(LOADING);
      yield* windowC.publish(RENAMED);
      expect((yield* changes.next).value).toEqual({ type: "data", value: { list: RENAMED } });
      expect(yield* listed(profiles)).toEqual(RENAMED);
      yield* changes.close;
    }),
  );

  it.effect(
    "a window registered before any publication does not answer for one that published",
    () =>
      Effect.gen(function* () {
        const { profiles, engineHosts } = yield* harness;
        // Registered first, never published; it would answer a read with WORK_PROFILES.
        const early = yield* attachProfileHost(
          engineHosts,
          listProfilesOr(() => "silent"),
        );
        const late = yield* attachWindow(engineHosts);
        yield* late.publish(RENAMED);
        const changes = yield* openChanges(profiles);
        expect((yield* changes.next).value).toEqual({ type: "snapshot", value: { list: RENAMED } });
        expect(yield* listed(profiles)).toEqual(RENAMED);
        expect(early.received).toEqual([]);
        yield* changes.close;
      }),
  );

  it.effect(
    "says when no desktop is connected: at start, on the last one leaving, until one returns",
    () =>
      Effect.gen(function* () {
        const { profiles, engineHosts } = yield* harness;
        const changes = yield* openChanges(profiles);
        // A web-only environment learns at once that there is no list to show.
        expect(yield* changes.next).toEqual({
          done: false,
          value: { type: "snapshot", value: { list: null } },
        });
        const first = yield* attachWindow(engineHosts);
        expect((yield* changes.next).value).toEqual(LOADING);
        yield* first.publish(LIST);
        expect((yield* changes.next).value).toEqual({ type: "data", value: { list: LIST } });
        yield* Fiber.interrupt(first.fiber);
        expect((yield* changes.next).value).toEqual({ type: "data", value: { list: null } });
        const second = yield* attachWindow(engineHosts);
        expect((yield* changes.next).value).toEqual(LOADING);
        yield* second.publish(LIST);
        expect((yield* changes.next).value).toEqual({ type: "data", value: { list: LIST } });
        // An available list with no profiles is not the same as none at all.
        const empty = { profiles: [], defaultProfileId: "default" };
        yield* second.publish(empty);
        expect((yield* changes.next).value).toEqual({ type: "data", value: { list: empty } });
        yield* changes.close;
      }),
  );

  it.effect("a connected desktop that has not published yet is loading, not absent", () =>
    Effect.gen(function* () {
      const { profiles, engineHosts } = yield* harness;
      /** What a subscriber joining now is handed first. */
      const state = Stream.runHead(engineHosts.profileChanges).pipe(Effect.map(Option.getOrThrow));
      expect(yield* state).toBeNull();
      const host = yield* attachWindow(engineHosts);
      expect(yield* state).toBe("pending");
      // A new view starts loading, and its next event is the list.
      const changes = yield* openChanges(profiles);
      expect(yield* changes.next).toEqual({
        done: false,
        value: { type: "snapshot", value: { list: null, pending: true } },
      });
      yield* host.publish(LIST);
      expect((yield* changes.next).value).toEqual({ type: "data", value: { list: LIST } });
      // A reload: the new window registers before the old one leaves, and has
      // not read its settings yet. That is loading, not "no desktop", and the
      // old list is not passed off as current.
      const reloaded = yield* attachWindow(engineHosts);
      yield* Fiber.interrupt(host.fiber);
      expect(yield* state).toBe("pending");
      expect((yield* changes.next).value).toEqual(LOADING);
      yield* reloaded.publish(RENAMED);
      expect((yield* changes.next).value).toEqual({ type: "data", value: { list: RENAMED } });
      yield* Fiber.interrupt(reloaded.fiber);
      expect(yield* state).toBeNull();
      expect((yield* changes.next).value).toEqual({ type: "data", value: { list: null } });
      yield* changes.close;
    }),
  );

  it.effect("an existing view told no desktop hears loading when one connects, then its list", () =>
    Effect.gen(function* () {
      const { profiles, engineHosts } = yield* harness;
      const changes = yield* openChanges(profiles);
      expect((yield* changes.next).value).toEqual({ type: "snapshot", value: { list: null } });
      const host = yield* attachWindow(engineHosts);
      expect((yield* changes.next).value).toEqual(LOADING);
      yield* host.publish(LIST);
      expect((yield* changes.next).value).toEqual({ type: "data", value: { list: LIST } });
      yield* Fiber.interrupt(host.fiber);
      expect((yield* changes.next).value).toEqual({ type: "data", value: { list: null } });
      yield* changes.close;
    }),
  );

  it.effect("a change from any window reaches every subscriber, early or late", () =>
    Effect.gen(function* () {
      const { profiles, engineHosts } = yield* harness;
      const early = yield* openChanges(profiles);
      expect((yield* early.next).value).toEqual({ type: "snapshot", value: { list: null } });
      const windowA = yield* attachWindow(engineHosts);
      expect((yield* early.next).value).toEqual(LOADING);
      const windowB = yield* attachWindow(engineHosts);
      yield* windowA.publish(LIST);
      expect((yield* early.next).value).toEqual({ type: "data", value: { list: LIST } });
      const late = yield* openChanges(profiles);
      expect((yield* late.next).value).toEqual({ type: "snapshot", value: { list: LIST } });
      const everyone = Effect.fn("test.everyone")(function* (list: typeof LIST) {
        for (const changes of [early, late]) {
          expect((yield* changes.next).value).toEqual({ type: "data", value: { list } });
        }
        expect(yield* listed(profiles)).toEqual(list);
      });
      yield* windowB.publish(RENAMED);
      yield* everyone(RENAMED);
      yield* windowA.publish(DELETED);
      yield* everyone(DELETED);
      // Window C registers; the others leave before it has published, which
      // leaves the list loading rather than absent.
      const windowC = yield* attachWindow(engineHosts);
      // B's older list leaves first, so no older list resurfaces.
      yield* Fiber.interrupt(windowB.fiber);
      yield* Fiber.interrupt(windowA.fiber);
      for (const changes of [early, late]) {
        expect((yield* changes.next).value).toEqual(LOADING);
      }
      yield* windowC.publish(NEW_DEFAULT);
      yield* everyone(NEW_DEFAULT);
      yield* early.close;
      yield* late.close;
    }),
  );

  it.effect("a stalled subscriber keeps only the latest list, not every change it missed", () =>
    Effect.gen(function* () {
      const { profiles, engineHosts } = yield* harness;
      const host = yield* attachWindow(engineHosts);
      yield* host.publish(LIST);
      const changes = yield* openChanges(profiles);
      expect((yield* changes.next).value).toEqual({ type: "snapshot", value: { list: LIST } });
      const edits = Array.from({ length: 256 }, (_, index) => ({
        profiles: [{ id: "default", name: `Default ${index + 1}` }],
        defaultProfileId: "default",
      }));
      for (const edit of edits) yield* host.publish(edit);
      // Resuming yields the current list; the 255 before it were dropped.
      expect((yield* changes.next).value).toEqual({ type: "data", value: { list: edits[255] } });
      yield* host.publish(LIST);
      expect((yield* changes.next).value).toEqual({ type: "data", value: { list: LIST } });
      yield* changes.close;
    }),
  );

  it.effect("only the registered desktop socket can publish", () =>
    Effect.gen(function* () {
      const { engineHosts } = yield* harness;
      const host = yield* attachProfileHost(engineHosts, () => "silent");
      const foreign = yield* Effect.flip(
        engineHosts.publishProfiles(
          { socketId: "other-ws", grantMethod: "desktop-bootstrap" },
          { hostConnectionId: host.hostConnectionId(), ...LIST },
        ),
      );
      expect(foreign.reason).toBe("host-not-registered");
      const web = yield* Effect.flip(
        engineHosts.publishProfiles(
          { socketId: "desktop-ws", grantMethod: undefined },
          { hostConnectionId: host.hostConnectionId(), ...LIST },
        ),
      );
      expect(web.reason).toBe("desktop-required");
    }),
  );

  it.effect("refuses a caller without read authority, and unknown streams", () =>
    Effect.gen(function* () {
      const { profiles } = yield* harness;
      expect(() =>
        profiles.subscribe!("changes", {}, context(), signal, meta(profiles, [])),
      ).toThrow();
      expect(() => profiles.subscribe!("events", {}, context(), signal, meta(profiles))).toThrow();
    }),
  );
});
