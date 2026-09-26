import { CheckpointDiffQuery } from "../checkpointing/CheckpointDiffQuery.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { PortDiscovery } from "../preview/PortScanner.ts";
import * as ExtensionCatalogueChanges from "./catalogueChanges.ts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ExtensionInvokeInput, ProjectId } from "@t3tools/contracts";
import { createExtensionRuntime } from "@t3tools/extension-runtime";
import { validateEnvironmentPackage } from "@t3tools/extension-sdk/environment";
import { WORKSPACE_READ_TEXT } from "@t3tools/extension-sdk/workspace";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  ProjectionProject,
  ProjectionProjectRepository,
} from "../persistence/Services/ProjectionProjects.ts";
import {
  ProjectionThread,
  ProjectionThreadRepository,
} from "../persistence/Services/ProjectionThreads.ts";
import { ProjectionThreadActivityRepository } from "../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import { WorkspaceEntries } from "../workspace/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "../workspace/WorkspaceFileSystem.ts";
import { toSdkContext } from "./scope.ts";
import { extensionWorkerLaunch, make } from "./EnvironmentExtensions.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { PreviewManager } from "../preview/Manager.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { BrowserFrameLeases } from "../browserFrames/BrowserFrameLeases.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ReviewService } from "../review/ReviewService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";
import { VcsProvisioningService } from "../vcs/VcsProvisioningService.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import {
  PullRequestProviderRegistry,
  fromProviders,
} from "../pullRequest/PullRequestProviderRegistry.ts";
import { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

const project = Schema.decodeUnknownSync(ProjectionProject)({
  projectId: "project-a",
  title: "Fixture",
  workspaceRoot: "/project",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  deletedAt: null,
});
const originalThread = Schema.decodeUnknownSync(ProjectionThread)({
  threadId: "thread-a",
  projectId: "project-a",
  title: "Fixture",
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: "/worktree",
  latestTurnId: null,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  latestUserMessageAt: null,
  pendingApprovalCount: 0,
  pendingUserInputCount: 0,
  hasActionableProposedPlan: 0,
  deletedAt: null,
});
const hash = "a".repeat(64);
const pkg = validateEnvironmentPackage({
  format: 1,
  manifest: { id: "fixture.reader", version: "1.0.0", apiVersion: 1, surfaces: [] },
  serverEntry: "server.mjs",
  tools: [
    {
      id: "fixture.reader/read",
      title: "Read",
      description: "Read fixture",
      inputSchema: { type: "object" },
      readOnly: true,
      capabilities: [WORKSPACE_READ_TEXT],
    },
  ],
});
const invoke = Schema.decodeUnknownSync(ExtensionInvokeInput)({
  toolId: "fixture.reader/read",
  input: { relativePath: "new.txt" },
  expectedContentHash: hash,
  context: {
    resource: {
      namespace: "fixture.reader",
      id: "file",
      environmentId: "env-a",
      projectId: "project-a",
      threadId: "thread-a",
    },
    workspaceRevision: JSON.stringify(["/project", "/worktree"]),
    client: "web",
  },
});
function fixture() {
  let thread = originalThread;
  let entry = {
    id: "fixture.reader",
    contentHash: hash,
    package: pkg,
    enabled: true,
    grants: { capabilities: [WORKSPACE_READ_TEXT], projectIds: ["project-a"] },
  };
  let options: Parameters<typeof createExtensionRuntime>[0] | undefined;
  const calls: Array<{ cwd: string; relativePath: string }> = [];
  const forwardedRoots: unknown[] = [];
  const forwardedApiRequests: unknown[] = [];
  let afterRead = () => {};
  let afterInvoke = () => {};
  let afterClient = () => {};
  let afterStream = () => {};
  let streamSignal: AbortSignal | undefined;
  let streamClosed = false;
  let disposed = false;
  const runtime: Awaited<ReturnType<typeof createExtensionRuntime>> = {
    list: () => [entry],
    catalogue: () => ({ apiSelections: [], apiResolution: [], pluginResolution: [] }),
    rollback: async () => entry,
    selectApi: async () => {},
    discoverApis: async () => [],
    invokeApi: async (_id, _hash, _input, _signal, root) => {
      forwardedRoots.push(root);
      forwardedApiRequests.push(_input);
      afterInvoke();
      return { ok: true };
    },
    subscribeApi: (_id, _hash, _request, signal, root) => {
      forwardedRoots.push(root);
      forwardedApiRequests.push(_request);
      streamSignal = signal;
      return {
        async *[Symbol.asyncIterator]() {
          try {
            yield {
              streamId: "fixture-stream",
              sequence: 1,
              type: "snapshot" as const,
              value: "first",
            };
            afterStream();
            yield {
              streamId: "fixture-stream",
              sequence: 2,
              type: "data" as const,
              value: "stale",
            };
          } finally {
            streamClosed = true;
          }
        },
      };
    },
    install: async () => entry,
    updateGrants: async (_id, grants) => {
      entry = {
        ...entry,
        grants: { capabilities: [...grants.capabilities], projectIds: [...grants.projectIds] },
      };
      return entry;
    },
    enable: async () => entry,
    disable: async () => {
      entry = { ...entry, enabled: false };
      return entry;
    },
    remove: async () => {},
    update: async () => entry,
    readAsset: async () => ({
      bytes: new Uint8Array(),
      mediaType: "application/octet-stream",
      sha256: "a".repeat(64),
    }),
    readClient: async () => {
      afterClient();
      return { code: "export default null", contentHash: hash };
    },
    invoke: async () => {
      afterInvoke();
      return { ok: true };
    },
    dispose: async () => {
      disposed = true;
    },
  };
  const factory: typeof createExtensionRuntime = async (value) => {
    options = value;
    return runtime;
  };
  const services = Layer.mergeAll(
    Layer.mock(CheckpointDiffQuery)({}),
    Layer.mock(OrchestrationCommandReceiptRepository)({}),
    Layer.mock(OrchestrationEngineService)({}),
    Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({}),
    Layer.mock(ProviderService)({}),
    makeProviderRegistryLayer(),
    ExtensionCatalogueChanges.layer,
    Layer.mock(PortDiscovery)({}),
    Layer.succeed(TerminalManager, {
      inspect: () => Effect.succeed(null),
      readOutput: () => Effect.succeed(null),
      subscribeOutput: () => Effect.succeed(() => {}),
      open: () => Effect.die("unused terminal open"),
      attachStream: () => Effect.die("unused terminal attach"),
      openOrAttach: () => Effect.die("unused terminal openOrAttach"),
      write: () => Effect.die("unused terminal write"),
      resize: () => Effect.die("unused terminal resize"),
      clear: () => Effect.die("unused terminal clear"),
      restart: () => Effect.die("unused terminal restart"),
      close: () => Effect.die("unused terminal close"),
      subscribe: () => Effect.die("unused terminal subscribe"),
      subscribeMetadata: () => Effect.die("unused terminal metadata"),
    }),
    WorkspacePaths.layer,
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env-a")),
      getDescriptor: Effect.die("unused"),
    }),
    Layer.succeed(ProjectionProjectRepository, {
      getById: () => Effect.succeed(Option.some(project)),
      upsert: () => Effect.void,
    }),
    Layer.succeed(ProjectionThreadRepository, {
      getById: () => Effect.succeed(Option.some(thread)),
      upsert: () => Effect.void,
    }),
    Layer.succeed(WorkspaceEntries, {
      list: () => Effect.succeed({ entries: [], truncated: false }),
      refresh: () => Effect.void,
      browse: () => Effect.die("unused"),
      search: () => Effect.die("unused"),
      searchContents: () => Effect.die("unused"),
    }),
    Layer.succeed(WorkspaceFileSystem, {
      readFile: (input) =>
        Effect.sync(() => {
          calls.push(input);
          afterRead();
          return {
            relativePath: input.relativePath,
            contents: "hello",
            byteLength: 5,
            truncated: false,
          };
        }),
      readFileBytes: () => Effect.die("unused"),
      writeFile: () => Effect.die("unused"),
    }),
    WorkspacePaths.layer,
    Layer.mock(OrchestrationEngineService)({}),
    Layer.mock(ProjectionThreadActivityRepository)({
      listByThreadId: () => Effect.succeed([]),
    }),
    Layer.mock(ProjectionTurnRepository)({
      listByThreadId: () => Effect.succeed([]),
    }),
    Layer.mock(VcsStatusBroadcaster)({}),
    Layer.mock(GitWorkflowService)({}),
    Layer.mock(GitVcsDriver)({}),
    Layer.mock(VcsDriverRegistry)({}),
    Layer.mock(VcsProvisioningService)({}),
    Layer.mock(ReviewService)({}),
    Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
    Layer.mock(ServerSecretStore.ServerSecretStore)({}),
    Layer.mock(PreviewManager)({}),
    Layer.mock(PreviewAutomationBroker)({}),
    Layer.mock(BrowserFrameLeases)({}),
    Layer.mock(PullRequestService)({}),
    Layer.mock(SourceControlRepositoryService)({}),
    Layer.succeed(PullRequestProviderRegistry, fromProviders([])),
    Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
      getProjectShellById: () => Effect.succeed(Option.none()),
    }),
    SqlitePersistenceMemory,
    ServerSettings.layerTest(),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-extension-service-test-" }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  return {
    factory,
    services,
    runtime,
    calls,
    forwardedRoots,
    forwardedApiRequests,
    getOptions: () => {
      if (!options) throw new Error("Runtime not constructed");
      return options;
    },
    changeWorkspace: () => {
      thread = { ...thread, worktreePath: "/changed" };
    },
    afterRead: (fn: () => void) => {
      afterRead = fn;
    },
    afterInvoke: (fn: () => void) => {
      afterInvoke = fn;
    },
    afterClient: (fn: () => void) => {
      afterClient = fn;
    },
    afterStream: (fn: () => void) => {
      afterStream = fn;
    },
    streamState: () => ({ aborted: streamSignal?.aborted, closed: streamClosed }),
    isDisposed: () => disposed,
    revoke: () => {
      entry = { ...entry, enabled: false };
    },
  };
}

it("the executable runs its hidden worker subcommand and the npm bundle forks the sibling script", () => {
  expect(extensionWorkerLaunch(true, "file:///opt/t3/dist-exe/bin.mjs")).toEqual({
    workerCommand: ["__extension-worker"],
  });
  expect(extensionWorkerLaunch(false, "file:///opt/t3/dist/bin.mjs")).toEqual({
    workerUrl: new URL("file:///opt/t3/dist/extension-worker.mjs"),
  });
  // Unbundled source leaves the runtime on its own worker script.
  expect(
    extensionWorkerLaunch(
      false,
      "file:///repo/apps/server/src/extensions/EnvironmentExtensions.ts",
    ),
  ).toEqual({});
});

it.effect("forwards the verified root authority to unary and stream runtime calls", () => {
  const f = fixture();
  const root = Object.freeze({
    principal: Object.freeze({
      kind: "environment-session" as const,
      id: "session-a",
      environmentId: "env-a",
      subject: "fixture",
      scopes: Object.freeze(["auth:read"]),
    }),
    allowWrite: false,
    revalidate: () => {},
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* make(f.factory);
      const request = {
        installationId: "fixture.reader",
        expectedContentHash: hash,
        request: {
          id: "fixture.reader/events",
          versionRange: "^1.0.0",
          method: "read",
          input: {},
          context: invoke.context,
        },
      };
      yield* service.invokeApi(request, root);
      yield* service
        .subscribeApi(
          {
            installationId: request.installationId,
            expectedContentHash: request.expectedContentHash,
            request: {
              id: request.request.id,
              versionRange: request.request.versionRange,
              name: "changes",
              input: {},
              context: request.request.context,
            },
          },
          root,
        )
        .pipe(Stream.runDrain);
      expect(f.forwardedRoots).toHaveLength(2);
      expect(f.forwardedRoots[0]).toBe(root);
      expect(f.forwardedRoots[1]).toBe(root);
    }).pipe(Effect.provide(f.services)),
  );
});

it.effect("forwards the clientConnectionId self-hint on unary and stream calls", () => {
  const f = fixture();
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* make(f.factory);
      yield* service.invokeApi({
        installationId: "fixture.reader",
        expectedContentHash: hash,
        request: {
          id: "fixture.reader/events",
          versionRange: "^1.0.0",
          method: "read",
          input: {},
          context: invoke.context,
          clientConnectionId: "conn-hint",
        },
      });
      yield* service
        .subscribeApi({
          installationId: "fixture.reader",
          expectedContentHash: hash,
          request: {
            id: "fixture.reader/events",
            versionRange: "^1.0.0",
            name: "changes",
            input: {},
            context: invoke.context,
            clientConnectionId: "conn-hint",
          },
        })
        .pipe(Stream.runDrain);
      expect(f.forwardedApiRequests).toHaveLength(2);
      expect(f.forwardedApiRequests[0]).toMatchObject({ clientConnectionId: "conn-hint" });
      expect(f.forwardedApiRequests[1]).toMatchObject({ clientConnectionId: "conn-hint" });
    }).pipe(Effect.provide(f.services)),
  );
});

it.effect(
  "corrupt runtime startup leaves a constructible service with explicit operation errors",
  () => {
    const f = fixture();
    return Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = path.join(config.stateDir, "extensions");
        const file = path.join(root, "installations.json");
        yield* fs.makeDirectory(root, { recursive: true });
        yield* fs.writeFileString(file, "{broken");
        const service = yield* make();
        const error = yield* Effect.flip(service.list);
        expect(error._tag).toBe("ExtensionOperationError");
        expect(error.operation).toBe("initialize");
        const assetError = yield* Effect.flip(
          service.asset({
            id: "example.asset",
            expectedContentHash: "a".repeat(64),
            path: "assets/value.wasm",
          }),
        );
        expect(assetError._tag).toBe("ExtensionOperationError");
        expect(assetError.operation).toBe("initialize");
        expect(yield* fs.readFileString(file)).toBe("{broken");
      }).pipe(Effect.provide(f.services)),
    );
  },
);
it.effect(
  "workspace reads use derived cwd, deny relative escapes and suppress a stale result",
  () => {
    const f = fixture();
    return Effect.scoped(
      Effect.gen(function* () {
        yield* make(f.factory);
        const service = f.getOptions().services[0]!;
        const signal = new AbortController().signal;
        const result = yield* Effect.promise(() =>
          Promise.resolve(
            service.invoke({ relativePath: "new.txt" }, toSdkContext(invoke.context), signal),
          ),
        );
        expect(result).toEqual({
          relativePath: "new.txt",
          contents: "hello",
          byteLength: 5,
          truncated: false,
        });
        expect(f.calls).toEqual([{ cwd: "/worktree", relativePath: "new.txt" }]);
        yield* Effect.promise(() =>
          expect(
            service.invoke({ relativePath: "../private" }, toSdkContext(invoke.context), signal),
          ).rejects.toThrow(),
        );
        expect(f.calls.length).toBe(1);
        f.afterRead(f.changeWorkspace);
        yield* Effect.promise(() =>
          expect(
            service.invoke({ relativePath: "new.txt" }, toSdkContext(invoke.context), signal),
          ).rejects.toThrow(),
        );
      }).pipe(Effect.provide(f.services)),
    );
  },
);
it.effect(
  "outer invocation rechecks scope even for a pure tool and client delivery rechecks revocation",
  () => {
    const f = fixture();
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* make(f.factory);
        f.afterInvoke(f.changeWorkspace);
        expect((yield* Effect.flip(service.invoke(invoke))).detail).toContain("stale");
        f.afterClient(f.revoke);
        expect((yield* Effect.flip(service.client("fixture.reader", hash))).detail).toContain(
          "unavailable",
        );
      }).pipe(Effect.provide(f.services)),
    );
  },
);
it.effect("catalog and host authorization require independent install/project grants", () => {
  const f = fixture();
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* make(f.factory);
      expect((yield* service.tools(toSdkContext(invoke.context))).length).toBe(1);
      const authorize = f.getOptions().authorize;
      const entry = f.runtime.list()[0]!;
      expect(
        yield* Effect.promise(() =>
          Promise.resolve(authorize(entry, WORKSPACE_READ_TEXT, toSdkContext(invoke.context))),
        ),
      ).toBe(true);
      expect(
        yield* Effect.promise(() =>
          Promise.resolve(
            authorize(
              { ...entry, grants: { ...entry.grants, projectIds: [ProjectId.make("other")] } },
              WORKSPACE_READ_TEXT,
              toSdkContext(invoke.context),
            ),
          ),
        ),
      ).toBe(false);
      f.revoke();
      expect(yield* service.tools(toSdkContext(invoke.context))).toEqual([]);
    }).pipe(Effect.provide(f.services)),
  );
});

it.effect("update requires explicit trusted-code confirmation before calling the runtime", () => {
  const f = fixture();
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* make(f.factory);
      expect(
        (yield* Effect.flip(
          service.manage({ id: "fixture.reader", action: "update", sourceDir: "/fixture" }),
        )).detail,
      ).toContain("trusted-code");
      expect(
        (yield* service.manage({
          id: "fixture.reader",
          action: "update",
          sourceDir: "/fixture",
          trusted: true,
        }))?.contentHash,
      ).toBe(hash);
    }).pipe(Effect.provide(f.services)),
  );
});

it.effect(
  "registers the public host workspace provider and rechecks API scope after dispatch",
  () => {
    const f = fixture();
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* make(f.factory);
        const provider = f
          .getOptions()
          .apiProviders?.find((item) => item.providerId === "host.workspace");
        expect(provider?.definition.id).toBe("t3.workspace/files");
        expect(provider?.definition.methods?.map((method) => method.name)).toEqual([
          "listEntries",
          "readText",
        ]);
        if (!provider) return yield* Effect.die("Missing workspace API provider");
        const result = yield* Effect.promise(() =>
          Promise.resolve(
            provider.invoke(
              "readText",
              { relativePath: "new.txt" },
              toSdkContext(invoke.context),
              new AbortController().signal,
              Object.freeze({
                callId: "host-test",
                rootCallerId: "test.extension",
                callerId: "test.extension",
                providerId: "host.workspace",
                providerGeneration: 1,
                callerGenerations: Object.freeze([]),
              }),
            ),
          ),
        );
        expect(result).toMatchObject({ contents: "hello", relativePath: "new.txt" });
        expect(f.calls).toEqual([{ cwd: "/worktree", relativePath: "new.txt" }]);
        f.afterInvoke(f.changeWorkspace);
        expect(
          (yield* Effect.flip(
            service.invokeApi({
              installationId: "fixture.reader",
              expectedContentHash: hash,
              request: {
                id: "t3.workspace/files",
                versionRange: "^1.0.0",
                method: "readText",
                input: { relativePath: "new.txt" },
                context: invoke.context,
              },
            }),
          )).detail,
        ).toContain("stale");
      }).pipe(Effect.provide(f.services)),
    );
  },
);

it.effect("runtime catalogue callbacks publish into the shared host change stream", () => {
  const f = fixture();
  return Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* ExtensionCatalogueChanges.ExtensionCatalogueChanges;
      yield* make(f.factory);
      const before = yield* changes.changes.pipe(Stream.take(1), Stream.runCollect);
      yield* Effect.sync(() => f.getOptions().onCatalogueChanged?.());
      const after = yield* changes.changes.pipe(Stream.take(1), Stream.runCollect);
      expect(after).toEqual([{ epoch: before[0]!.epoch, revision: before[0]!.revision + 1 }]);
    }).pipe(Effect.provide(f.services)),
  );
});

it.effect(
  "permission management replaces the complete grant set and rejects missing grants",
  () => {
    const f = fixture();
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* make(f.factory);
        const changed = yield* service.manage({
          id: "fixture.reader",
          action: "grants",
          grants: { capabilities: [], projectIds: [] },
        });
        expect(changed?.grants).toEqual({ capabilities: [], projectIds: [] });
        expect(changed?.contentHash).toBe(hash);
        const error = yield* Effect.flip(
          service.manage({ id: "fixture.reader", action: "grants" }),
        );
        expect(error.detail).toContain("complete grant set");
      }).pipe(Effect.provide(f.services)),
    );
  },
);

it.effect("stream suppresses a frame from a changed workspace and releases its lifetime", () => {
  const f = fixture();
  const seen: unknown[] = [];
  return Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* make(f.factory);
        f.afterStream(f.changeWorkspace);
        const failure = yield* Effect.flip(
          service
            .subscribeApi({
              installationId: "fixture.reader",
              expectedContentHash: hash,
              request: {
                id: "fixture.reader/events",
                versionRange: "^1.0.0",
                name: "changes",
                input: {},
                context: invoke.context,
              },
            })
            .pipe(
              Stream.tap((frame) =>
                Effect.sync(() => {
                  seen.push(frame.value);
                }),
              ),
              Stream.runDrain,
            ),
        );
        expect(failure.detail).toContain("stale");
        expect(seen).toEqual(["first"]);
      }).pipe(Effect.provide(f.services)),
    );
    expect(f.streamState()).toEqual({ aborted: true, closed: true });
  });
});
