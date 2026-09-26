import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ExtensionOperationError,
  ProjectId,
  extensionWorkspaceRevision,
  type VcsStatusResult as NativeVcsStatusResult,
  type VcsStatusStreamEvent as NativeVcsStatusStreamEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import { it, expect, describe } from "@effect/vitest";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { HostApiProvider } from "@t3tools/extension-runtime";
import type { ApiStreamEvent } from "@t3tools/extension-sdk/capabilities";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import * as ServerConfig from "../config.ts";
import { ReviewService, layer as reviewServiceLayer } from "../review/ReviewService.ts";
import { GitVcsDriver, layer as gitVcsDriverLayer } from "../vcs/GitVcsDriver.ts";
import {
  VcsDriverRegistry,
  layer as vcsDriverRegistryLayer,
  type VcsDriverHandle,
} from "../vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  VcsProvisioningService,
  layer as vcsProvisioningLayer,
} from "../vcs/VcsProvisioningService.ts";
import { createVcsApiProviders, parsePorcelainStatus } from "./vcsApi.ts";
import { createVcsDiffApiProvider } from "./vcsDiffApi.ts";

const isOperationError = Schema.is(ExtensionOperationError);
const READ_AND_OPERATE = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] as const;
const signal = new AbortController().signal;

class InvokeRejection extends Data.TaggedError("InvokeRejection")<{
  readonly cause: unknown;
}> {}

const makeVcsLayer = (workspaceRoot: string, baseDir: string) => {
  const registry = vcsDriverRegistryLayer.pipe(Layer.provide(VcsProjectConfig.layer));
  return Layer.mergeAll(
    gitVcsDriverLayer,
    registry,
    vcsProvisioningLayer.pipe(Layer.provide(registry)),
    reviewServiceLayer.pipe(Layer.provideMerge(gitVcsDriverLayer), Layer.provideMerge(registry)),
  ).pipe(
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
};

const makeContext = (root: string): ViewContext => ({
  resource: {
    namespace: "test.extension",
    id: "surface",
    environmentId: "env",
    projectId: "project",
    threadId: "thread",
  },
  client: "test",
  workspaceRevision: extensionWorkspaceRevision(root, null),
});

const meta = (
  provider: HostApiProvider,
  scopes: readonly string[] = READ_AND_OPERATE,
): Parameters<HostApiProvider["invoke"]>[4] => ({
  callId: "call",
  rootCallerId: "root",
  callerId: "caller",
  providerId: provider.providerId,
  providerGeneration: 1,
  callerGenerations: [],
  principal: {
    kind: "environment-session",
    id: "session",
    environmentId: "env",
    scopes,
  },
  assertAuthority: async () => {},
});

type Deps = Parameters<typeof createVcsApiProviders>[0];

const toSnapshotEvent = (status: NativeVcsStatusResult): NativeVcsStatusStreamEvent => ({
  _tag: "snapshot",
  local: {
    isRepo: status.isRepo,
    ...(status.sourceControlProvider === undefined
      ? {}
      : { sourceControlProvider: status.sourceControlProvider }),
    hasPrimaryRemote: status.hasPrimaryRemote,
    isDefaultRef: status.isDefaultRef,
    refName: status.refName,
    hasWorkingTreeChanges: status.hasWorkingTreeChanges,
    workingTree: status.workingTree,
  },
  remote: {
    hasUpstream: status.hasUpstream,
    aheadCount: status.aheadCount,
    behindCount: status.behindCount,
    ...(status.aheadOfDefaultCount === undefined
      ? {}
      : { aheadOfDefaultCount: status.aheadOfDefaultCount }),
    pr: status.pr,
  },
});

interface TestVcsServices {
  readonly git: GitVcsDriver["Service"];
  readonly registry: VcsDriverRegistry["Service"];
  readonly provisioning: VcsProvisioningService["Service"];
  readonly review: ReviewService["Service"];
  readonly worktreesDir: string;
  /** Completed with the cwd whenever the adapter requests a post-mutation refresh. */
  readonly refreshed?: Deferred.Deferred<string>;
}

const makeDeps = (
  workspaceRoot: string,
  services: TestVcsServices,
  overrides: Partial<Pick<Deps, "vcsRegistry">> = {},
): Deps => ({
  environmentId: "env",
  projects: {
    getById: () =>
      Effect.succeed(
        Option.some({
          projectId: ProjectId.make("project"),
          workspaceRoot,
          deletedAt: null,
        }),
      ),
  },
  threads: {
    getById: () =>
      Effect.succeed(
        Option.some({
          projectId: ProjectId.make("project"),
          worktreePath: null,
          deletedAt: null,
        }),
      ),
  },
  vcsStatus: {
    getStatus: (input) => services.git.status(input),
    refreshStatus: (cwd) =>
      (services.refreshed ? Deferred.succeed(services.refreshed, cwd) : Effect.void).pipe(
        Effect.andThen(services.git.status({ cwd })),
      ),
    streamStatus: (input) =>
      Stream.fromEffect(services.git.status(input).pipe(Effect.map(toSnapshotEvent))),
  },
  gitWorkflow: {
    listRefs: (input) => services.git.listRefs(input),
    createRef: (input) => services.git.createRef(input),
    switchRef: (input) => services.git.switchRef(input),
    pullCurrentBranch: (cwd) => services.git.pullCurrentBranch(cwd),
    fetchRemote: (input) => services.git.fetchRemote(input),
    createWorktree: (input) => services.git.createWorktree(input),
    removeWorktree: (input) => services.git.removeWorktree(input),
  },
  git: services.git,
  vcsRegistry: overrides.vcsRegistry ?? services.registry,
  vcsProvisioning: services.provisioning,
  worktreesDir: services.worktreesDir,
  automaticRemoteRefreshInterval: Effect.succeed(Duration.seconds(30)),
});

const providerOf = (providers: readonly HostApiProvider[], id: string) => {
  const provider = providers.find((entry) => entry.definition.id === id);
  if (!provider) throw new Error(`missing provider ${id}`);
  return provider;
};

const invoke = (
  provider: HostApiProvider,
  method: string,
  input: Parameters<HostApiProvider["invoke"]>[1],
  context: ViewContext,
  scopes: readonly string[] = READ_AND_OPERATE,
) =>
  Effect.tryPromise({
    try: () =>
      Promise.resolve(provider.invoke(method, input, context, signal, meta(provider, scopes))),
    catch: (cause) => new InvokeRejection({ cause }),
  });

const invokeError = (
  provider: HostApiProvider,
  method: string,
  input: Parameters<HostApiProvider["invoke"]>[1],
  context: ViewContext,
  scopes: readonly string[] = READ_AND_OPERATE,
) =>
  invoke(provider, method, input, context, scopes).pipe(
    Effect.flip,
    Effect.map((rejection) => {
      if (!isOperationError(rejection.cause)) {
        throw new Error(`expected ExtensionOperationError, got ${String(rejection.cause)}`);
      }
      return rejection.cause;
    }),
  );

const gitOutput = (git: GitVcsDriver["Service"], cwd: string, args: readonly string[]) =>
  git
    .execute({ operation: "vcsApi.test.git", cwd, args: [...args] })
    .pipe(Effect.map((result) => result.stdout.trim()));

/** Real Git services over a disposable workspace, wired like server.ts. */
const withVcsServices = <A, E>(
  workspaceRoot: string,
  run: (
    services: TestVcsServices & { readonly refreshed: Deferred.Deferred<string> },
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-base-" });
    return yield* Effect.gen(function* () {
      const realGit = yield* GitVcsDriver;
      const registry = yield* VcsDriverRegistry;
      const provisioning = yield* VcsProvisioningService;
      const review = yield* ReviewService;
      const config = yield* ServerConfig.ServerConfig;
      // The adapter mirrors ws.ts and detaches its post-mutation refresh; the
      // production broadcaster serializes per-cwd internally, so tests wrap
      // the driver in a semaphore to keep `.git/index.lock` access honest.
      const lock = yield* Semaphore.make(1);
      const git = new Proxy(realGit, {
        get: (target, property, receiver) => {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) =>
            lock.withPermits(1)(
              (value as (...input: unknown[]) => Effect.Effect<unknown, Error>).apply(target, args),
            );
        },
      });
      const refreshed = yield* Deferred.make<string>();
      return yield* run({
        git,
        registry,
        provisioning,
        review,
        worktreesDir: config.worktreesDir,
        refreshed,
      });
    }).pipe(Effect.provide(makeVcsLayer(workspaceRoot, baseDir)));
  });

const initRepo = (git: GitVcsDriver["Service"], cwd: string) =>
  Effect.gen(function* () {
    yield* git.execute({ operation: "vcsApi.test.init", cwd, args: ["init", "-b", "main"] });
    yield* git.execute({
      operation: "vcsApi.test.config",
      cwd,
      args: ["config", "user.email", "test@test.com"],
    });
    yield* git.execute({
      operation: "vcsApi.test.config",
      cwd,
      args: ["config", "user.name", "Test"],
    });
  });

describe("parsePorcelainStatus", () => {
  it("maps porcelain XY state to per-path index flags", () => {
    const parsed = parsePorcelainStatus(
      [
        "M  staged.txt",
        " M unstaged.txt",
        "MM both.txt",
        "?? untracked.txt",
        "UU conflicted.txt",
        "!! ignored.txt",
        "R  renamed-new.txt\0renamed-old.txt",
        "A  added.txt",
        "",
      ].join("\0"),
    );
    expect(parsed).toEqual([
      { path: "staged.txt", staged: true, unstaged: false, untracked: false, conflicted: false },
      { path: "unstaged.txt", staged: false, unstaged: true, untracked: false, conflicted: false },
      { path: "both.txt", staged: true, unstaged: true, untracked: false, conflicted: false },
      { path: "untracked.txt", staged: false, unstaged: false, untracked: true, conflicted: false },
      {
        path: "conflicted.txt",
        staged: false,
        unstaged: false,
        untracked: false,
        conflicted: true,
      },
      {
        path: "renamed-new.txt",
        staged: true,
        unstaged: false,
        untracked: false,
        conflicted: false,
      },
      { path: "added.txt", staged: true, unstaged: false, untracked: false, conflicted: false },
    ]);
  });

  it("consumes the origin record for worktree-side renames (R in the Y column)", () => {
    const parsed = parsePorcelainStatus(
      [" R renamed-new.txt\0renamed-old.txt", " M next.txt", ""].join("\0"),
    );
    expect(parsed).toEqual([
      {
        path: "renamed-new.txt",
        staged: false,
        unstaged: true,
        untracked: false,
        conflicted: false,
      },
      { path: "next.txt", staged: false, unstaged: true, untracked: false, conflicted: false },
    ]);
  });

  it("drops the unterminated tail record when git output was truncated", () => {
    const truncated = ["M  staged.txt", " M partial-path-that-was-cut"].join("\0");
    const parsed = parsePorcelainStatus(truncated, true);
    expect(parsed).toEqual([
      { path: "staged.txt", staged: true, unstaged: false, untracked: false, conflicted: false },
    ]);
    // The same bytes are all trustworthy when the capture was complete.
    const complete = parsePorcelainStatus(truncated + "\0", false);
    expect(complete).toHaveLength(2);
  });
});

it.layer(NodeServices.layer)("t3.vcs adapters", (it) => {
  it.effect("reports status and per-path staging lanes against a real repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-ws-" });
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-vcs-repo-",
        directory: workspace,
      });
      yield* withVcsServices(workspace, ({ git, registry, provisioning, review, worktreesDir }) =>
        Effect.gen(function* () {
          yield* initRepo(git, root);
          const providers = createVcsApiProviders(
            makeDeps(root, { git, registry, provisioning, review, worktreesDir }),
          );
          const status = providerOf(providers, "t3.vcs/status");
          const changes = providerOf(providers, "t3.vcs/changes");
          const context = makeContext(root);

          const clean = (yield* invoke(status, "get", {}, context)) as {
            isRepo: boolean;
            refName: string | null;
            hasWorkingTreeChanges: boolean;
            workingTree: { files: readonly { path: string }[]; truncated: boolean };
          };
          expect(clean.isRepo).toBe(true);
          expect(clean.refName).toBe("main");
          expect(clean.hasWorkingTreeChanges).toBe(false);
          expect(clean.workingTree.files).toEqual([]);

          yield* fs.writeFileString(path.join(root, "a.txt"), "one\n");
          yield* git.execute({
            operation: "test",
            cwd: root,
            args: ["add", "a.txt"],
          });
          yield* git.execute({
            operation: "test",
            cwd: root,
            args: ["commit", "-m", "seed"],
          });
          yield* fs.writeFileString(path.join(root, "a.txt"), "two\n");
          yield* fs.writeFileString(path.join(root, "b.txt"), "new\n");
          yield* git.execute({
            operation: "test",
            cwd: root,
            args: ["add", "b.txt"],
          });
          yield* fs.writeFileString(path.join(root, "c.txt"), "untracked\n");

          const dirty = (yield* invoke(status, "get", {}, context)) as {
            hasWorkingTreeChanges: boolean;
            workingTree: { files: readonly { path: string }[]; truncated: boolean };
          };
          expect(dirty.hasWorkingTreeChanges).toBe(true);
          // The native status payload lists untracked files too; only the
          // per-path index state is missing (covered by changes.list).
          expect(dirty.workingTree.files.map((file) => file.path).sort()).toEqual([
            "a.txt",
            "b.txt",
            "c.txt",
          ]);

          const listed = (yield* invoke(changes, "list", {}, context)) as {
            isRepo: boolean;
            entries: readonly {
              path: string;
              staged: boolean;
              unstaged: boolean;
              untracked: boolean;
            }[];
          };
          const byPath = new Map(listed.entries.map((entry) => [entry.path, entry]));
          expect(byPath.get("a.txt")).toMatchObject({
            staged: false,
            unstaged: true,
            untracked: false,
          });
          expect(byPath.get("b.txt")).toMatchObject({
            staged: true,
            unstaged: false,
            untracked: false,
          });
          expect(byPath.get("c.txt")).toMatchObject({
            staged: false,
            unstaged: false,
            untracked: true,
          });
        }),
      );
    }),
  );

  it.effect("stages, unstages, and commits against a real repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-ws-" });
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-vcs-repo-",
        directory: workspace,
      });
      yield* withVcsServices(
        workspace,
        ({ git, registry, provisioning, review, worktreesDir, refreshed }) =>
          Effect.gen(function* () {
            yield* initRepo(git, root);
            const providers = createVcsApiProviders(
              makeDeps(root, { git, registry, provisioning, review, worktreesDir, refreshed }),
            );
            const changes = providerOf(providers, "t3.vcs/changes");
            const context = makeContext(root);

            yield* fs.writeFileString(path.join(root, "a.txt"), "a\n");
            yield* fs.writeFileString(path.join(root, "b.txt"), "b\n");

            yield* invoke(changes, "stage", { paths: ["a.txt"] }, context);
            // Mutations request a detached status refresh, mirroring ws.ts.
            expect(yield* Deferred.await(refreshed)).toBe(root);
            const porcelain = yield* gitOutput(git, root, ["status", "--porcelain=v1"]);
            expect(porcelain).toContain("A  a.txt");
            expect(porcelain).toContain("?? b.txt");

            yield* invoke(changes, "unstage", { paths: ["a.txt"] }, context);
            const unstaged = yield* gitOutput(git, root, ["status", "--porcelain=v1"]);
            expect(unstaged).toContain("?? a.txt");

            const headBefore = yield* gitOutput(git, root, ["rev-parse", "HEAD"]).pipe(
              Effect.orElseSucceed(() => ""),
            );
            const committed = (yield* invoke(
              changes,
              "commit",
              { message: "add both files", paths: ["a.txt", "b.txt"] },
              context,
            )) as { commitSha: string; refName: string | null };
            const headAfter = yield* gitOutput(git, root, ["rev-parse", "HEAD"]);
            expect(committed.commitSha).toBe(headAfter);
            expect(headAfter).not.toBe(headBefore);
            expect(committed.refName).toBe("main");
            expect(yield* gitOutput(git, root, ["log", "-1", "--format=%s"])).toBe(
              "add both files",
            );
          }),
      );
    }),
  );

  it.effect("commits a path subset without touching other staged files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-ws-" });
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-vcs-repo-",
        directory: workspace,
      });
      yield* withVcsServices(workspace, ({ git, registry, provisioning, review, worktreesDir }) =>
        Effect.gen(function* () {
          yield* initRepo(git, root);
          const providers = createVcsApiProviders(
            makeDeps(root, { git, registry, provisioning, review, worktreesDir }),
          );
          const changes = providerOf(providers, "t3.vcs/changes");
          const context = makeContext(root);

          yield* fs.writeFileString(path.join(root, "a.txt"), "a\n");
          yield* fs.writeFileString(path.join(root, "b.txt"), "b\n");
          yield* invoke(changes, "commit", { message: "only a", paths: ["a.txt"] }, context);
          const porcelain = yield* gitOutput(git, root, ["status", "--porcelain=v1"]);
          expect(porcelain).toContain("?? b.txt");
          expect(porcelain).not.toContain("a.txt");
        }),
      );
    }),
  );

  it.effect("lists, creates, and switches refs against a real repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-ws-" });
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-vcs-repo-",
        directory: workspace,
      });
      yield* withVcsServices(workspace, ({ git, registry, provisioning, review, worktreesDir }) =>
        Effect.gen(function* () {
          yield* initRepo(git, root);
          yield* fs.writeFileString(path.join(root, "a.txt"), "a\n");
          yield* git.execute({ operation: "test", cwd: root, args: ["add", "a.txt"] });
          yield* git.execute({ operation: "test", cwd: root, args: ["commit", "-m", "seed"] });
          const providers = createVcsApiProviders(
            makeDeps(root, { git, registry, provisioning, review, worktreesDir }),
          );
          const refs = providerOf(providers, "t3.vcs/refs");
          const context = makeContext(root);

          const listed = (yield* invoke(refs, "list", {}, context)) as {
            isRepo: boolean;
            refs: readonly { name: string; current: boolean }[];
          };
          expect(listed.isRepo).toBe(true);
          expect(listed.refs.some((ref) => ref.name === "main" && ref.current)).toBe(true);

          // Contract allows `query: ""` (cleared search field) — must list unfiltered.
          const emptyQuery = (yield* invoke(refs, "list", { query: "" }, context)) as {
            refs: readonly { name: string }[];
          };
          expect(emptyQuery.refs.some((ref) => ref.name === "main")).toBe(true);

          yield* invoke(refs, "create", { refName: "feature-a", switchRef: true }, context);
          expect(yield* gitOutput(git, root, ["branch", "--show-current"])).toBe("feature-a");
          yield* invoke(refs, "switch", { refName: "main" }, context);
          expect(yield* gitOutput(git, root, ["branch", "--show-current"])).toBe("main");
        }),
      );
    }),
  );

  it.effect("initializes a repository in a non-repo workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-ws-" });
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-vcs-repo-",
        directory: workspace,
      });
      yield* withVcsServices(workspace, ({ git, registry, provisioning, review, worktreesDir }) =>
        Effect.gen(function* () {
          const providers = createVcsApiProviders(
            makeDeps(root, { git, registry, provisioning, review, worktreesDir }),
          );
          const repository = providerOf(providers, "t3.vcs/repository");
          const status = providerOf(providers, "t3.vcs/status");
          const context = makeContext(root);

          const before = (yield* invoke(repository, "getCapabilities", {}, context)) as {
            detected: boolean;
            kind: string | null;
            operations: Record<string, boolean>;
          };
          expect(before.detected).toBe(false);
          expect(before.kind).toBeNull();
          expect(before.operations["changes.commit"]).toBe(false);
          expect(before.operations["repository.init"]).toBe(true);

          yield* invoke(repository, "init", {}, context);
          const after = (yield* invoke(status, "get", {}, context)) as { isRepo: boolean };
          expect(after.isRepo).toBe(true);
        }),
      );
    }),
  );

  it.effect("pushes, fetches, pulls, and lists remotes against a local-path upstream", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-ws-" });
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-vcs-repo-",
        directory: workspace,
      });
      yield* withVcsServices(workspace, ({ git, registry, provisioning, review, worktreesDir }) =>
        Effect.gen(function* () {
          yield* initRepo(git, root);
          yield* fs.writeFileString(path.join(root, "a.txt"), "a\n");
          yield* git.execute({ operation: "test", cwd: root, args: ["add", "a.txt"] });
          yield* git.execute({ operation: "test", cwd: root, args: ["commit", "-m", "seed"] });
          const bare = path.join(workspace, "remote.git");
          yield* git.execute({
            operation: "test",
            cwd: workspace,
            args: ["init", "--bare", "-b", "main", bare],
          });
          const providers = createVcsApiProviders(
            makeDeps(root, { git, registry, provisioning, review, worktreesDir }),
          );
          const repository = providerOf(providers, "t3.vcs/repository");
          const context = makeContext(root);

          const empty = (yield* invoke(repository, "listRemotes", {}, context)) as {
            isRepo: boolean;
            remotes: readonly unknown[];
          };
          expect(empty).toEqual({ isRepo: true, remotes: [] });
          yield* git.execute({
            operation: "test",
            cwd: root,
            args: ["remote", "add", "origin", bare],
          });
          const listed = (yield* invoke(repository, "listRemotes", {}, context)) as {
            remotes: readonly {
              name: string;
              url: string;
              pushUrl: string | null;
              isPrimary: boolean;
            }[];
          };
          // `git remote -v` reports a push line for every remote, so
          // pushUrl is the configured push URL — verbatim, not resolved.
          expect(listed.remotes).toEqual([
            { name: "origin", url: bare, pushUrl: bare, isPrimary: true },
          ]);

          const fetched = (yield* invoke(repository, "fetch", {}, context)) as {
            remotes: readonly string[];
          };
          expect(fetched.remotes).toEqual(["origin"]);
          const named = (yield* invoke(repository, "fetch", { remoteName: "origin" }, context)) as {
            remotes: readonly string[];
          };
          expect(named.remotes).toEqual(["origin"]);
          const badName = yield* invokeError(repository, "fetch", { remoteName: "--all" }, context);
          expect(badName.detail).toContain("Invalid");

          // No upstream yet: push publishes with -u onto the primary remote.
          const published = (yield* invoke(repository, "push", {}, context)) as {
            status: string;
            refName: string;
            upstreamRef: string | null;
            setUpstream: boolean;
          };
          expect(published).toEqual({
            status: "pushed",
            refName: "main",
            upstreamRef: "origin/main",
            setUpstream: true,
          });
          const skipped = (yield* invoke(repository, "push", {}, context)) as {
            status: string;
          };
          expect(skipped.status).toBe("skipped_up_to_date");

          // Advance the upstream from a clone, then pull through the contract.
          const other = path.join(workspace, "other");
          yield* git.execute({
            operation: "test",
            cwd: workspace,
            args: ["clone", bare, other],
          });
          yield* git.execute({
            operation: "test",
            cwd: other,
            args: ["config", "user.email", "test@test.com"],
          });
          yield* git.execute({
            operation: "test",
            cwd: other,
            args: ["config", "user.name", "Test"],
          });
          yield* fs.writeFileString(path.join(other, "b.txt"), "b\n");
          yield* git.execute({ operation: "test", cwd: other, args: ["add", "b.txt"] });
          yield* git.execute({ operation: "test", cwd: other, args: ["commit", "-m", "upstream"] });
          yield* git.execute({
            operation: "test",
            cwd: other,
            args: ["push", "origin", "main"],
          });
          const pulled = (yield* invoke(repository, "pull", {}, context)) as {
            status: string;
            refName: string;
            upstreamRef: string | null;
          };
          expect(pulled.status).toBe("pulled");
          expect(pulled.upstreamRef).toBe("origin/main");
          expect(yield* fs.exists(path.join(root, "b.txt"))).toBe(true);
          const again = (yield* invoke(repository, "pull", {}, context)) as { status: string };
          expect(again.status).toBe("skipped_up_to_date");

          // Detached HEAD push fails with the named driver error.
          yield* git.execute({
            operation: "test",
            cwd: root,
            args: ["checkout", "--detach", "HEAD"],
          });
          const detached = yield* invokeError(repository, "push", {}, context);
          expect(detached.detail).toContain("detached");
        }),
      );
    }),
  );

  it.effect("creates, lists, and removes worktrees inside the host worktrees directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-ws-" });
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-vcs-repo-",
        directory: workspace,
      });
      yield* withVcsServices(workspace, ({ git, registry, provisioning, review, worktreesDir }) =>
        Effect.gen(function* () {
          yield* initRepo(git, root);
          yield* fs.writeFileString(path.join(root, "a.txt"), "a\n");
          yield* git.execute({ operation: "test", cwd: root, args: ["add", "a.txt"] });
          yield* git.execute({ operation: "test", cwd: root, args: ["commit", "-m", "seed"] });
          const providers = createVcsApiProviders(
            makeDeps(root, { git, registry, provisioning, review, worktreesDir }),
          );
          const repository = providerOf(providers, "t3.vcs/repository");
          const refs = providerOf(providers, "t3.vcs/refs");
          const context = makeContext(root);

          const escaped = yield* invokeError(
            repository,
            "createWorktree",
            { refName: "main", newRefName: "escape", path: "../escape" },
            context,
          );
          expect(escaped.detail).toContain("worktrees");

          const created = (yield* invoke(
            repository,
            "createWorktree",
            { refName: "main", newRefName: "wt-branch", baseRefName: "main", path: null },
            context,
          )) as { worktree: { path: string; refName: string } };
          expect(created.worktree.refName).toBe("wt-branch");
          expect(created.worktree.path.startsWith(worktreesDir)).toBe(true);

          const listed = (yield* invoke(refs, "list", {}, context)) as {
            refs: readonly { name: string; worktreePath: string | null }[];
          };
          // refs.list reports the canonical path (/var → /private/var on macOS).
          const createdReal = yield* fs.realPath(created.worktree.path);
          expect(listed.refs.find((ref) => ref.name === "wt-branch")?.worktreePath).toBe(
            createdReal,
          );

          // A dirty worktree refuses plain removal, then yields to force.
          yield* fs.writeFileString(path.join(created.worktree.path, "dirty.txt"), "dirty\n");
          const refused = yield* invokeError(
            repository,
            "removeWorktree",
            { path: created.worktree.path },
            context,
          );
          expect(refused.detail).toContain("GitCommandError");
          yield* invoke(
            repository,
            "removeWorktree",
            { path: created.worktree.path, force: true },
            context,
          );
          expect(yield* fs.exists(created.worktree.path)).toBe(false);
        }),
      );
    }),
  );

  it.effect("reports honest capabilities and named unsupported errors for a non-git driver", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-ws-" });
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-vcs-repo-",
        directory: workspace,
      });
      yield* withVcsServices(workspace, ({ git, registry, provisioning, review, worktreesDir }) =>
        Effect.gen(function* () {
          yield* initRepo(git, root);
          const fakeJjDriver = {
            capabilities: {
              kind: "jj",
              supportsWorktrees: false,
              supportsBookmarks: true,
              supportsAtomicSnapshot: false,
              supportsPushDefaultRemote: false,
              ignoreClassifier: "git-compatible-fallback",
            },
            listRemotes: (_cwd: string): ReturnType<VcsDriverHandle["driver"]["listRemotes"]> =>
              Effect.succeed({
                remotes: [
                  {
                    name: "origin",
                    url: "https://user:password@example.com/repo.git",
                    pushUrl: Option.some("git@example.com:org/repo.git"),
                    isPrimary: true,
                  },
                  {
                    name: "broken-bracket",
                    url: "https://user:password@[unclosed",
                    pushUrl: Option.none(),
                    isPrimary: false,
                  },
                  {
                    name: "encoded-userinfo",
                    url: "https://user%40x:password@[unclosed",
                    pushUrl: Option.none(),
                    isPrimary: false,
                  },
                  {
                    name: "empty-host",
                    url: "https://user:password@",
                    pushUrl: Option.none(),
                    isPrimary: false,
                  },
                  {
                    name: "single-slash",
                    url: "https:/user:password@[broken",
                    pushUrl: Option.none(),
                    isPrimary: false,
                  },
                  {
                    name: "backslash-sep",
                    url: "https:\\\\user:password@[broken",
                    pushUrl: Option.none(),
                    isPrimary: false,
                  },
                  {
                    name: "mixed-sep",
                    url: "https:\\/user:password@[broken",
                    pushUrl: Option.some("https:/user:password@[also-broken"),
                    isPrimary: false,
                  },
                  {
                    name: "control-in-prefix",
                    url: "https:/\u0001/user:password@[broken",
                    pushUrl: Option.none(),
                    isPrimary: false,
                  },
                  {
                    name: "zero-separator",
                    url: "https:user:password@[broken",
                    pushUrl: Option.some("https:\tuser:password@[pushed"),
                    isPrimary: false,
                  },
                ],
                freshness: {
                  source: "live-local",
                  observedAt: DateTime.makeUnsafe("2026-09-13T00:00:00.000Z"),
                  expiresAt: Option.none(),
                },
              }),
          } satisfies Pick<VcsDriverHandle["driver"], "capabilities" | "listRemotes">;
          const fakeJj: VcsDriverHandle = {
            kind: "jj",
            repository: { kind: "jj" } as VcsDriverHandle["repository"],
            driver: fakeJjDriver as VcsDriverHandle["driver"],
          };
          const fakeRegistry = {
            get: registry.get,
            detect: () => Effect.succeed(fakeJj),
            resolve: () => Effect.succeed(fakeJj),
          };
          const providers = createVcsApiProviders(
            makeDeps(
              root,
              { git, registry, provisioning, review, worktreesDir },
              { vcsRegistry: fakeRegistry },
            ),
          );
          const changes = providerOf(providers, "t3.vcs/changes");
          const repository = providerOf(providers, "t3.vcs/repository");
          const context = makeContext(root);

          const capabilities = (yield* invoke(repository, "getCapabilities", {}, context)) as {
            detected: boolean;
            kind: string | null;
            driver: { supportsWorktrees: boolean } | null;
            operations: Record<string, boolean>;
          };
          expect(capabilities.detected).toBe(true);
          expect(capabilities.kind).toBe("jj");
          expect(capabilities.operations["changes.stage"]).toBe(false);
          expect(capabilities.operations["repository.createWorktree"]).toBe(false);
          // 1.1.0 sync ops are git-only; listRemotes rides the driver interface.
          expect(capabilities.operations["repository.push"]).toBe(false);
          expect(capabilities.operations["repository.fetch"]).toBe(false);
          expect(capabilities.operations["repository.listRemotes"]).toBe(true);

          // The capability claim is backed by the driver method — invoke it
          // through the adapter and check the projection (including URL
          // userinfo redaction at the boundary).
          const remotes = (yield* invoke(repository, "listRemotes", {}, context)) as {
            isRepo: boolean;
            remotes: readonly {
              name: string;
              url: string;
              pushUrl: string | null;
              isPrimary: boolean;
            }[];
          };
          expect(remotes).toEqual({
            isRepo: true,
            remotes: [
              {
                name: "origin",
                url: "https://example.com/repo.git",
                pushUrl: "git@example.com:org/repo.git",
                isPrimary: true,
              },
              // Malformed URLs must not pass userinfo through verbatim — the
              // `scheme://userinfo@` prefix is stripped at the boundary.
              {
                name: "broken-bracket",
                url: "https://[unclosed",
                pushUrl: null,
                isPrimary: false,
              },
              {
                name: "encoded-userinfo",
                url: "https://[unclosed",
                pushUrl: null,
                isPrimary: false,
              },
              {
                name: "empty-host",
                url: "https://",
                pushUrl: null,
                isPrimary: false,
              },
              // Alternate separator spellings a special-scheme URL would
              // normalize lose their userinfo prefix just the same.
              {
                name: "single-slash",
                url: "https:/[broken",
                pushUrl: null,
                isPrimary: false,
              },
              {
                name: "backslash-sep",
                url: "https:\\\\[broken",
                pushUrl: null,
                isPrimary: false,
              },
              {
                name: "mixed-sep",
                url: "https:\\/[broken",
                pushUrl: "https:/[also-broken",
                isPrimary: false,
              },
              // Control characters are non-printable: stripped before the
              // userinfo match, and absent separators do not save a
              // credential-bearing scheme prefix.
              {
                name: "control-in-prefix",
                url: "https://[broken",
                pushUrl: null,
                isPrimary: false,
              },
              {
                name: "zero-separator",
                url: "https:[broken",
                pushUrl: "https:[pushed",
                isPrimary: false,
              },
            ],
          });

          const stagedError = yield* invokeError(changes, "stage", { paths: ["a.txt"] }, context);
          expect(stagedError.detail).toContain("VcsUnsupportedOperationError");
          const listedError = yield* invokeError(changes, "list", {}, context);
          expect(listedError.detail).toContain("VcsUnsupportedOperationError");
          const pushError = yield* invokeError(repository, "push", {}, context);
          expect(pushError.detail).toContain("VcsUnsupportedOperationError");
          const fetchError = yield* invokeError(repository, "fetch", {}, context);
          expect(fetchError.detail).toContain("VcsUnsupportedOperationError");
        }),
      );
    }),
  );

  it.effect("enforces schema bounds and rejects excess properties", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-ws-" });
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-vcs-repo-",
        directory: workspace,
      });
      yield* withVcsServices(workspace, ({ git, registry, provisioning, review, worktreesDir }) =>
        Effect.gen(function* () {
          yield* initRepo(git, root);
          const providers = createVcsApiProviders(
            makeDeps(root, { git, registry, provisioning, review, worktreesDir }),
          );
          const changes = providerOf(providers, "t3.vcs/changes");
          const refs = providerOf(providers, "t3.vcs/refs");
          const repository = providerOf(providers, "t3.vcs/repository");
          const context = makeContext(root);

          const excess = yield* invokeError(
            changes,
            "stage",
            { paths: ["a.txt"], extra: true },
            context,
          );
          expect(excess.detail).toContain("Invalid");
          const emptyPaths = yield* invokeError(changes, "stage", { paths: [] }, context);
          expect(emptyPaths.detail).toContain("Invalid");
          const longPath = yield* invokeError(
            changes,
            "stage",
            { paths: ["x".repeat(513)] },
            context,
          );
          expect(longPath.detail).toContain("Invalid");
          const manyPaths = yield* invokeError(
            changes,
            "unstage",
            { paths: Array.from({ length: 101 }, (_, index) => `f${index}.txt`) },
            context,
          );
          expect(manyPaths.detail).toContain("Invalid");
          const badRef = yield* invokeError(refs, "create", { refName: "bad..name" }, context);
          expect(badRef.detail).toContain("Invalid");
          const overLimit = yield* invokeError(refs, "list", { limit: 500 }, context);
          expect(overLimit.detail).toContain("Invalid");
          const longMessage = yield* invokeError(
            changes,
            "commit",
            { message: "x".repeat(10_001) },
            context,
          );
          expect(longMessage.detail).toContain("Invalid");
          // DEL and C1 controls are not whitespace; the first-char bound must
          // still reject them.
          for (const remoteName of ["\x7forigin", "\u0085rigin"]) {
            const control = yield* invokeError(repository, "fetch", { remoteName }, context);
            expect(control.detail).toContain("Invalid");
          }
        }),
      );
    }),
  );

  it.effect("denies mutations under a read-only principal and reads without a principal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-ws-" });
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-vcs-repo-",
        directory: workspace,
      });
      yield* withVcsServices(workspace, ({ git, registry, provisioning, review, worktreesDir }) =>
        Effect.gen(function* () {
          yield* initRepo(git, root);
          yield* fs.writeFileString(path.join(root, "a.txt"), "a\n");
          const providers = createVcsApiProviders(
            makeDeps(root, { git, registry, provisioning, review, worktreesDir }),
          );
          const changes = providerOf(providers, "t3.vcs/changes");
          const status = providerOf(providers, "t3.vcs/status");
          const context = makeContext(root);

          const denied = yield* invokeError(changes, "stage", { paths: ["a.txt"] }, context, [
            AuthOrchestrationReadScope,
          ]);
          expect(denied.detail).toContain("authority");
          const committed = yield* invokeError(changes, "commit", { message: "nope" }, context, [
            AuthOrchestrationReadScope,
          ]);
          expect(committed.detail).toContain("authority");
          const readDenied = yield* invokeError(status, "get", {}, context, []);
          expect(readDenied.detail).toContain("authority");
          const result = yield* invoke(changes, "list", {}, context, [AuthOrchestrationReadScope]);
          expect((result as { isRepo: boolean }).isRepo).toBe(true);
        }),
      );
    }),
  );

  it.effect("streams a snapshot then local updates through the public event shape", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-ws-" });
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-vcs-repo-",
        directory: workspace,
      });
      yield* withVcsServices(workspace, ({ git, registry, provisioning, review, worktreesDir }) =>
        Effect.gen(function* () {
          yield* initRepo(git, root);
          const providers = createVcsApiProviders(
            makeDeps(root, { git, registry, provisioning, review, worktreesDir }),
          );
          const status = providerOf(providers, "t3.vcs/status");
          const context = makeContext(root);

          const iterable = status.subscribe!(
            "subscribe",
            {},
            context,
            signal,
            meta(status, [AuthOrchestrationReadScope]),
          );
          const events = yield* Effect.promise(async () => {
            const collected: { type: string; value: unknown }[] = [];
            for await (const event of iterable) collected.push(event);
            return collected;
          });
          expect(events).toHaveLength(1);
          expect(events[0]!.type).toBe("snapshot");
          const value = events[0]!.value as {
            kind: string;
            local: { isRepo: boolean; workingTree: { truncated: boolean } };
            remote: { pr: unknown } | null;
          };
          expect(value.kind).toBe("snapshot");
          expect(value.local.isRepo).toBe(true);
          expect(value.local.workingTree.truncated).toBe(false);
        }),
      );
    }),
  );
});

it.layer(NodeServices.layer)("t3.vcs/diff adapter", (it) => {
  it.effect("returns the working-tree preview and file contents for a real repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-ws-" });
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-vcs-repo-",
        directory: workspace,
      });
      yield* withVcsServices(workspace, ({ git, registry, provisioning, review, worktreesDir }) =>
        Effect.gen(function* () {
          yield* initRepo(git, root);
          yield* fs.writeFileString(path.join(root, "a.txt"), "before\n");
          yield* git.execute({ operation: "test", cwd: root, args: ["add", "a.txt"] });
          yield* git.execute({ operation: "test", cwd: root, args: ["commit", "-m", "seed"] });
          yield* fs.writeFileString(path.join(root, "a.txt"), "after\n");

          const deps = makeDeps(root, { git, registry, provisioning, review, worktreesDir });
          const diff = createVcsDiffApiProvider({ ...deps, review });
          const context = makeContext(root);

          const preview = (yield* invoke(diff, "getPreview", {}, context)) as {
            sources: readonly {
              kind: string;
              diff: string;
              diffHash: string;
              truncated: boolean;
            }[];
            generatedAt: string;
          };
          const working = preview.sources.find((source) => source.kind === "working-tree");
          expect(working).toBeDefined();
          expect(working!.truncated).toBe(false);
          const native = yield* gitOutput(git, root, ["diff", "HEAD"]);
          expect(working!.diff).toContain("+after");
          expect(native).toContain("+after");

          const contents = (yield* invoke(
            diff,
            "getFileContents",
            {
              sourceKind: "working-tree",
              changeType: "change",
              baseRef: null,
              headRef: null,
              oldPath: "a.txt",
              newPath: "a.txt",
            },
            context,
          )) as { oldContents: string; newContents: string };
          expect(contents.oldContents).toBe("before\n");
          expect(contents.newContents).toBe("after\n");
        }),
      );
    }),
  );

  it.effect("rejects oversized and malformed diff inputs by name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-ws-" });
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-vcs-repo-",
        directory: workspace,
      });
      yield* withVcsServices(workspace, ({ git, registry, provisioning, review, worktreesDir }) =>
        Effect.gen(function* () {
          yield* initRepo(git, root);
          const diff = createVcsDiffApiProvider({
            ...makeDeps(root, { git, registry, provisioning, review, worktreesDir }),
            review,
          });
          const context = makeContext(root);

          const excess = yield* invokeError(
            diff,
            "getPreview",
            { baseRef: "main", extra: true },
            context,
          );
          expect(excess.detail).toContain("Invalid");
          const longPath = yield* invokeError(
            diff,
            "getFileContents",
            {
              sourceKind: "working-tree",
              changeType: "change",
              baseRef: null,
              headRef: null,
              oldPath: "x".repeat(513),
              newPath: "a.txt",
            },
            context,
          );
          expect(longPath.detail).toContain("Invalid");
          // A `-`-prefixed revspec would inject options into git diff/show argv.
          const injected = yield* invokeError(
            diff,
            "getPreview",
            { baseRef: "--output=/tmp/vcs-escape" },
            context,
          );
          expect(injected.detail).toContain("Invalid");
          const injectedShow = yield* invokeError(
            diff,
            "getFileContents",
            {
              sourceKind: "branch-range",
              changeType: "change",
              baseRef: "--output=/tmp/vcs-escape",
              headRef: "HEAD",
              oldPath: "a.txt",
              newPath: "a.txt",
            },
            context,
          );
          expect(injectedShow.detail).toContain("Invalid");
        }),
      );
    }),
  );

  it.effect("bounds caller-supplied worktree paths to the host worktrees directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-ws-" });
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-vcs-repo-",
        directory: workspace,
      });
      yield* withVcsServices(workspace, ({ git, registry, provisioning, review, worktreesDir }) =>
        Effect.gen(function* () {
          yield* initRepo(git, root);
          yield* fs.writeFileString(path.join(root, "a.txt"), "a\n");
          yield* git.execute({ operation: "test", cwd: root, args: ["add", "a.txt"] });
          yield* git.execute({ operation: "test", cwd: root, args: ["commit", "-m", "seed"] });
          yield* git.execute({ operation: "test", cwd: root, args: ["branch", "base"] });
          const repository = providerOf(
            createVcsApiProviders(
              makeDeps(root, { git, registry, provisioning, review, worktreesDir }),
            ),
            "t3.vcs/repository",
          );
          const context = makeContext(root);

          const escaped = yield* invokeError(
            repository,
            "createWorktree",
            { refName: "base", path: path.join(workspace, "escape") },
            context,
          );
          expect(escaped.detail).toContain("worktrees directory");
          const dotdot = yield* invokeError(
            repository,
            "createWorktree",
            { refName: "base", path: "../../escape" },
            context,
          );
          expect(dotdot.detail).toContain("worktrees directory");

          // A path inside the host worktrees dir resolves and is passed through.
          const created = (yield* invoke(
            repository,
            "createWorktree",
            { refName: "base", path: "nested/inside" },
            context,
          )) as { worktree: { path: string; refName: string } };
          expect(created.worktree.path).toContain(worktreesDir);
          expect(created.worktree.refName).toBe("base");
          expect(yield* fs.exists(created.worktree.path)).toBe(true);
        }),
      );
    }),
  );

  const collectStream = (
    provider: HostApiProvider,
    name: string,
    input: unknown,
    context: ViewContext,
    scopes: readonly string[] = READ_AND_OPERATE,
    resumeCursor?: string,
  ) =>
    Effect.tryPromise({
      try: async () => {
        const iterable = provider.subscribe!(
          name,
          input as Parameters<NonNullable<HostApiProvider["subscribe"]>>[1],
          context,
          signal,
          meta(provider, scopes),
          resumeCursor,
        );
        const events: ApiStreamEvent[] = [];
        for await (const event of iterable) events.push(event);
        return events;
      },
      catch: (cause) => new InvokeRejection({ cause }),
    });

  const collectStreamError = (...args: Parameters<typeof collectStream>) =>
    collectStream(...args).pipe(
      Effect.flip,
      Effect.map((rejection) => {
        if (!isOperationError(rejection.cause)) {
          throw new Error(`expected ExtensionOperationError, got ${String(rejection.cause)}`);
        }
        return rejection.cause;
      }),
    );

  it.effect(
    "streamPreview delivers a driver-truncated diff in bounded frames with a verifiable terminal hash",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-ws-" });
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-vcs-repo-",
          directory: workspace,
        });
        yield* withVcsServices(workspace, ({ git, registry, provisioning, review, worktreesDir }) =>
          Effect.gen(function* () {
            yield* initRepo(git, root);
            // ~160 KB committed then fully rewritten: the joined tracked patch
            // crosses the driver's 120 KB cap, so the delivered body is a real
            // truncated slice larger than the 64 KiB invoke envelope.
            const before = Array.from(
              { length: 4_000 },
              (_, index) => `before-${index}-${"a".repeat(32)}`,
            ).join("\n");
            const after = Array.from(
              { length: 4_000 },
              (_, index) => `after-${index}-${"b".repeat(32)}`,
            ).join("\n");
            yield* fs.writeFileString(path.join(root, "a.txt"), before);
            yield* git.execute({ operation: "test", cwd: root, args: ["add", "a.txt"] });
            yield* git.execute({ operation: "test", cwd: root, args: ["commit", "-m", "seed"] });
            yield* fs.writeFileString(path.join(root, "a.txt"), after);

            const diff = createVcsDiffApiProvider({
              ...makeDeps(root, { git, registry, provisioning, review, worktreesDir }),
              review,
            });
            const context = makeContext(root);
            const events = yield* collectStream(diff, "streamPreview", {}, context);

            const manifest = events[0]!.value as {
              kind: string;
              generatedAt: string;
              sources: readonly {
                id: string;
                kind: string;
                truncated: boolean;
                diffHash: string;
                diffByteLength: number;
                chunkCount: number;
              }[];
            };
            expect(events[0]!.type).toBe("snapshot");
            expect(manifest.kind).toBe("manifest");
            const working = manifest.sources.find((source) => source.kind === "working-tree");
            expect(working).toBeDefined();
            expect(working!.truncated).toBe(true);
            expect(working!.diffByteLength).toBeGreaterThan(64 * 1024);

            const complete = events.at(-1)!.value as { kind: string; payloadSha256: string };
            expect(complete.kind).toBe("complete");
            const chunks = events.slice(1, -1);
            for (const [index, event] of chunks.entries()) {
              expect(event.type).toBe("data");
              const value = event.value as {
                kind: string;
                sourceIndex: number;
                chunkIndex: number;
                data: string;
              };
              expect(value.kind).toBe("chunk");
              expect(value.sourceIndex).toBe(0);
              expect(value.chunkIndex).toBe(index);
              expect(value.data.length).toBeLessThanOrEqual(8_192);
              // Every emitted frame fits the broker's 64 KiB per-frame limit.
              // @effect-diagnostics-next-line preferSchemaOverJson:off - measures the broker-serialized frame size.
              expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(64 * 1024);
            }
            expect(chunks.length).toBe(working!.chunkCount);
            expect(chunks.length).toBeGreaterThan(8);

            const reassembled = chunks
              .map((event) => (event.value as { data: string }).data)
              .join("");
            expect(Buffer.byteLength(reassembled, "utf8")).toBe(working!.diffByteLength);
            const sha256 = (value: string) =>
              NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");
            expect(sha256(reassembled)).toBe(working!.diffHash);
            expect(complete.payloadSha256).toBe(sha256(reassembled));
          }),
        );
      }),
  );

  it.effect("streamPreview serves a small diff as one chunk matching the unary result", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-ws-" });
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-vcs-repo-",
        directory: workspace,
      });
      yield* withVcsServices(workspace, ({ git, registry, provisioning, review, worktreesDir }) =>
        Effect.gen(function* () {
          yield* initRepo(git, root);
          yield* fs.writeFileString(path.join(root, "a.txt"), "before\n");
          yield* git.execute({ operation: "test", cwd: root, args: ["add", "a.txt"] });
          yield* git.execute({ operation: "test", cwd: root, args: ["commit", "-m", "seed"] });
          yield* fs.writeFileString(path.join(root, "a.txt"), "after\n");

          const diff = createVcsDiffApiProvider({
            ...makeDeps(root, { git, registry, provisioning, review, worktreesDir }),
            review,
          });
          const context = makeContext(root);
          const events = yield* collectStream(diff, "streamPreview", {}, context);
          expect(events).toHaveLength(3);
          const manifest = events[0]!.value as {
            sources: readonly { truncated: boolean; chunkCount: number; diffHash: string }[];
          };
          expect(manifest.sources[0]!.truncated).toBe(false);
          expect(manifest.sources[0]!.chunkCount).toBe(1);
          const reassembled = (events[1]!.value as { data: string }).data;

          const unary = (yield* invoke(diff, "getPreview", {}, context)) as {
            sources: readonly { diff: string; diffHash: string }[];
          };
          expect(reassembled).toBe(unary.sources[0]!.diff);
          expect(manifest.sources[0]!.diffHash).toBe(unary.sources[0]!.diffHash);
        }),
      );
    }),
  );

  it.effect("streamFileContents reassembles both sides with per-side integrity hashes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-ws-" });
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-vcs-repo-",
        directory: workspace,
      });
      yield* withVcsServices(workspace, ({ git, registry, provisioning, review, worktreesDir }) =>
        Effect.gen(function* () {
          yield* initRepo(git, root);
          // Both sides above the 64 KiB invoke envelope but under the 1 MiB bound.
          const before = `${"old-line\n".repeat(8_000)}tail\n`;
          const after = `${"new-line\n".repeat(8_000)}tail\n`;
          yield* fs.writeFileString(path.join(root, "a.txt"), before);
          yield* git.execute({ operation: "test", cwd: root, args: ["add", "a.txt"] });
          yield* git.execute({ operation: "test", cwd: root, args: ["commit", "-m", "seed"] });
          yield* fs.writeFileString(path.join(root, "a.txt"), after);

          const diff = createVcsDiffApiProvider({
            ...makeDeps(root, { git, registry, provisioning, review, worktreesDir }),
            review,
          });
          const context = makeContext(root);
          const events = yield* collectStream(
            diff,
            "streamFileContents",
            {
              sourceKind: "working-tree",
              changeType: "change",
              baseRef: null,
              headRef: null,
              oldPath: "a.txt",
              newPath: "a.txt",
            },
            context,
          );

          const manifest = events[0]!.value as {
            kind: string;
            oldByteLength: number;
            oldChunkCount: number;
            newByteLength: number;
            newChunkCount: number;
          };
          expect(manifest.kind).toBe("manifest");
          expect(manifest.oldByteLength).toBeGreaterThan(64 * 1024);
          expect(manifest.newByteLength).toBeGreaterThan(64 * 1024);
          const complete = events.at(-1)!.value as {
            kind: string;
            oldSha256: string;
            newSha256: string;
          };
          expect(complete.kind).toBe("complete");
          const sha256 = (value: string) =>
            NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");
          const sides = { old: "", new: "" };
          for (const event of events.slice(1, -1)) {
            const value = event.value as { kind: string; side: "old" | "new"; data: string };
            expect(value.kind).toBe("chunk");
            expect(value.data.length).toBeLessThanOrEqual(8_192);
            sides[value.side] += value.data;
          }
          expect(sides.old).toBe(before);
          expect(sides.new).toBe(after);
          expect(complete.oldSha256).toBe(sha256(before));
          expect(complete.newSha256).toBe(sha256(after));
        }),
      );
    }),
  );

  it.effect("streamFileContents never splits a surrogate pair across chunk boundaries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-ws-" });
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-vcs-repo-",
        directory: workspace,
      });
      yield* withVcsServices(workspace, ({ git, registry, provisioning, review, worktreesDir }) =>
        Effect.gen(function* () {
          yield* initRepo(git, root);
          // An astral pair straddles the first 8 192-unit boundary, so the
          // first chunk must shrink to 8 191 units rather than split it.
          const crafted = `${"a".repeat(8_191)}\u{1F980}${"z".repeat(100)}`;
          yield* fs.writeFileString(path.join(root, "a.txt"), "x\n");
          yield* git.execute({ operation: "test", cwd: root, args: ["add", "a.txt"] });
          yield* git.execute({ operation: "test", cwd: root, args: ["commit", "-m", "seed"] });
          yield* fs.writeFileString(path.join(root, "a.txt"), crafted);

          const diff = createVcsDiffApiProvider({
            ...makeDeps(root, { git, registry, provisioning, review, worktreesDir }),
            review,
          });
          const context = makeContext(root);
          const events = yield* collectStream(
            diff,
            "streamFileContents",
            {
              sourceKind: "working-tree",
              changeType: "change",
              baseRef: null,
              headRef: null,
              oldPath: "a.txt",
              newPath: "a.txt",
            },
            context,
          );
          const manifest = events[0]!.value as { newChunkCount: number; newByteLength: number };
          expect(manifest.newChunkCount).toBe(2);
          expect(manifest.newByteLength).toBe(Buffer.byteLength(crafted, "utf8"));
          const newChunks = events
            .slice(1, -1)
            .map((event) => event.value as { side: string; data: string })
            .filter((chunk) => chunk.side === "new");
          expect(newChunks).toHaveLength(2);
          expect(newChunks[0]!.data).toBe("a".repeat(8_191));
          expect(newChunks[1]!.data).toBe(`\u{1F980}${"z".repeat(100)}`);
          expect(newChunks.map((chunk) => chunk.data).join("")).toBe(crafted);
        }),
      );
    }),
  );

  it.effect(
    "diff streams reject unknown names, resume cursors, bad input, and missing authority",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-ws-" });
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-vcs-repo-",
          directory: workspace,
        });
        yield* withVcsServices(workspace, ({ git, registry, provisioning, review, worktreesDir }) =>
          Effect.gen(function* () {
            yield* initRepo(git, root);
            const diff = createVcsDiffApiProvider({
              ...makeDeps(root, { git, registry, provisioning, review, worktreesDir }),
              review,
            });
            const context = makeContext(root);

            const unknown = yield* collectStreamError(diff, "nope", {}, context);
            expect(unknown.detail).toContain("unavailable");
            const resumed = yield* collectStreamError(
              diff,
              "streamPreview",
              {},
              context,
              READ_AND_OPERATE,
              "cursor-1",
            );
            expect(resumed.detail).toContain("resume");
            const invalid = yield* collectStreamError(
              diff,
              "streamPreview",
              { baseRef: "main", extra: true },
              context,
            );
            expect(invalid.detail).toContain("Invalid");
            const denied = yield* collectStreamError(diff, "streamPreview", {}, context, []);
            expect(denied.detail).toContain("authority");
          }),
        );
      }),
  );

  it.effect("streamPreview re-checks authority mid-stream and stops on revocation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-ws-" });
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-vcs-repo-",
        directory: workspace,
      });
      yield* withVcsServices(workspace, ({ git, registry, provisioning, review, worktreesDir }) =>
        Effect.gen(function* () {
          yield* initRepo(git, root);
          yield* fs.writeFileString(path.join(root, "a.txt"), `${"line\n".repeat(20_000)}`);
          const diff = createVcsDiffApiProvider({
            ...makeDeps(root, { git, registry, provisioning, review, worktreesDir }),
            review,
          });
          const context = makeContext(root);
          let allowed = true;
          const failure = yield* Effect.tryPromise({
            try: async () => {
              const stream = diff.subscribe!("streamPreview", {}, context, signal, {
                ...meta(diff),
                assertAuthority: async () => {
                  if (!allowed) throw new Error("revoked");
                },
              })[Symbol.asyncIterator]();
              const manifest = await stream.next();
              expect(manifest.done).toBe(false);
              allowed = false;
              await stream.next();
            },
            catch: () => new InvokeRejection({ cause: undefined }),
          }).pipe(Effect.flip);
          expect(failure).toBeInstanceOf(InvokeRejection);
        }),
      );
    }),
  );
});
