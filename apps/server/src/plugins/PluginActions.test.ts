import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  PLUGIN_ACTIONS_MAX_PER_ENVIRONMENT,
  PLUGIN_ACTIONS_MAX_PER_PLUGIN,
  PLUGIN_ACTIONS_SNAPSHOT_MAX_BYTES,
  PluginActionId,
  PluginActionInvokeInput,
  PluginId,
  PluginInstallationId,
  ProjectId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  type PluginActionsSnapshot,
  type PluginInstallation,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PluginActions from "./PluginActions.ts";
import * as PluginCatalog from "./PluginCatalog.ts";
import { loadPluginDirectory } from "./PluginManifestLoader.ts";
import * as PluginSupervisor from "./PluginSupervisor.ts";

// Children run the real CLI entry, which routes `__plugin-host` to the child runtime.
const BIN_PATH = `${import.meta.dirname}/../bin.ts`;
const FIXTURE = `${import.meta.dirname}/testFixtures/actions`;

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fromJson = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const THREAD = ThreadId.make("thread-1");
const PROJECT = ProjectId.make("project-1");

/** One thread in one project; every other target does not exist. */
const threadsAndProjects = Layer.merge(
  Layer.mock(ThreadManagementService)({
    getThreadShell: (threadId) =>
      Effect.succeed(
        threadId === THREAD
          ? ({
              projectId: PROJECT,
              worktreePath: null,
              branch: "main",
            } as OrchestrationV2ThreadShell)
          : null,
      ),
  }),
  Layer.mock(ProjectStoreV2)({
    getShell: (projectId) =>
      Effect.succeed(
        projectId === PROJECT
          ? Option.some({ workspaceRoot: "/work/project" } as OrchestrationProjectShell)
          : Option.none(),
      ),
  }),
);

const startActions = Effect.fn("startActions")(function* (scope: Scope.Scope) {
  const supervisor = yield* PluginSupervisor.make({
    heapLimitMb: 64,
    activationTimeout: "10 seconds",
    stopGrace: "1 second",
  }).pipe(
    Effect.provideService(HostProcess.Arguments, [process.execPath, BIN_PATH]),
    Effect.provideService(Scope.Scope, scope),
  );
  const catalog = yield* PluginCatalog.make().pipe(
    Effect.provideService(PluginSupervisor.PluginSupervisor, supervisor),
    Effect.provideService(Scope.Scope, scope),
  );
  const actions = yield* PluginActions.make().pipe(
    Effect.provideService(PluginCatalog.PluginCatalog, catalog),
    Effect.provide(threadsAndProjects),
  );
  return { catalog, actions };
});

/** Copies the fixture (or a variant of its manifest) into a fresh directory. */
const preparePlugin = Effect.fn("preparePlugin")(function* (
  manifest?: (manifest: Record<string, unknown>) => Record<string, unknown>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(
    yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-actions-" }),
    "plugin",
  );
  yield* fs.makeDirectory(directory);
  yield* fs.writeFileString(
    path.join(directory, "main.mjs"),
    yield* fs.readFileString(path.join(FIXTURE, "main.mjs")),
  );
  const original = fromJson(yield* fs.readFileString(path.join(FIXTURE, "t3-plugin.json")));
  yield* fs.writeFileString(
    path.join(directory, "t3-plugin.json"),
    toJson(manifest ? manifest(original) : original),
  );
  return directory;
});

const enablePlugin = Effect.fn("enablePlugin")(function* (
  catalog: PluginCatalog.PluginCatalog["Service"],
  directory: string,
) {
  const { installation } = yield* catalog.add({ directory });
  yield* catalog.consent({
    installationId: installation.installationId,
    digest: installation.source!.digest,
  });
  return (yield* catalog.enable({ installationId: installation.installationId })).installation;
});

const awaitActions = (
  actions: PluginActions.PluginActions["Service"],
  predicate: (snapshot: PluginActionsSnapshot) => boolean,
) =>
  actions.subscribe.pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map((snapshot) => Option.getOrThrow(snapshot).actions),
  );

const awaitHostState = (
  catalog: PluginCatalog.PluginCatalog["Service"],
  installationId: PluginInstallationId,
  tags: ReadonlyArray<string>,
) =>
  catalog.subscribe.pipe(
    Stream.filter((snapshot) =>
      snapshot.installations.some(
        (installation) =>
          installation.installationId === installationId &&
          tags.includes(installation.hostState?._tag ?? ""),
      ),
    ),
    Stream.runHead,
  );

const withDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(SqlitePersistence.layerMemory));

it.layer(NodeServices.layer)("PluginActions", (it) => {
  it.effect(
    "lists an enabled plugin's actions without starting it, and drops them on disable",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const { catalog, actions } = yield* startActions(yield* Scope.Scope);
          const directory = yield* preparePlugin();
          const installation = yield* enablePlugin(catalog, directory);
          const { installationId } = installation;

          const listed = yield* awaitActions(actions, (snapshot) => snapshot.actions.length > 0);
          expect(listed.map((action) => [action.name, action.target, action.placements])).toEqual([
            ["echo-target", "thread", ["command-palette", "thread-menu", "composer-slash"]],
            ["say-hello", "environment", ["command-palette"]],
            ["fail", "environment", ["command-palette"]],
            ["wait", "environment", ["command-palette"]],
          ]);
          expect(listed[0]).toMatchObject({
            pluginId: "test.actions",
            pluginName: "Actions fixture",
            title: "Echo target",
            description: "Says which thread it ran on.",
          });
          // Listing read the manifest only: no process was started.
          const [row] = (yield* catalog.list).installations;
          expect(row?.hostState).toEqual({ _tag: "idle" });

          const hello = listed.find((action) => action.name === "say-hello")!;
          expect(
            yield* actions.invoke({ actionId: hello.id, target: { _tag: "environment" } }),
          ).toEqual({ message: "Hello from test.actions" });

          yield* catalog.disable({ installationId });
          expect(yield* awaitActions(actions, () => true)).toEqual([]);
          const disabled = yield* actions
            .invoke({ actionId: hello.id, target: { _tag: "environment" } })
            .pipe(Effect.flip);
          expect(disabled.reason).toBe("not-found");

          // Enabled again: new ids, and the old one can never reach the new registration.
          yield* catalog.enable({ installationId });
          const relisted = yield* awaitActions(actions, (snapshot) => snapshot.actions.length > 0);
          expect(relisted.find((action) => action.name === "say-hello")!.id).not.toBe(hello.id);
          const stale = yield* actions
            .invoke({ actionId: hello.id, target: { _tag: "environment" } })
            .pipe(Effect.flip);
          expect(stale.reason).toBe("stale");

          yield* catalog.remove({ installationId });
          expect(yield* awaitActions(actions, () => true)).toEqual([]);
        }),
      ),
  );

  it.effect("runs an action on its resolved target and reports typed failures", () =>
    withDatabase(
      Effect.gen(function* () {
        const { catalog, actions } = yield* startActions(yield* Scope.Scope);
        const { installationId } = yield* enablePlugin(catalog, yield* preparePlugin());
        const listed = yield* awaitActions(actions, (snapshot) => snapshot.actions.length > 0);
        const byName = (name: string) => listed.find((action) => action.name === name)!.id;

        expect(
          yield* actions.invoke({
            actionId: byName("echo-target"),
            target: { _tag: "thread", threadId: THREAD },
          }),
        ).toEqual({ message: "thread thread-1 in /work/project" });

        const failures = yield* Effect.forEach(
          [
            { actionId: byName("echo-target"), target: { _tag: "environment" as const } },
            {
              actionId: byName("echo-target"),
              target: { _tag: "thread" as const, threadId: ThreadId.make("elsewhere") },
            },
            { actionId: byName("fail"), target: { _tag: "environment" as const } },
            {
              actionId: PluginActionId.make(`${installationId}:1:missing`),
              target: { _tag: "environment" as const },
            },
            {
              actionId: PluginActionId.make("not-an-action"),
              target: { _tag: "environment" as const },
            },
          ],
          (input) => actions.invoke(input).pipe(Effect.flip),
        );
        expect(failures.map((error) => [error.reason, error.message])).toEqual([
          ["target-mismatch", "Echo target runs on a thread."],
          ["target-not-found", "That thread does not exist here."],
          ["failed", "The fixture failed on purpose."],
          ["not-found", "That action is not available now."],
          ["not-found", "That action is not available here."],
        ]);

        // A disable while the action runs revokes it at once.
        const running = yield* actions
          .invoke({ actionId: byName("wait"), target: { _tag: "environment" } })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* awaitHostState(catalog, installationId, ["starting", "running"]);
        yield* catalog.disable({ installationId });
        expect((yield* Fiber.join(running)).reason).toBe("stopped");
      }),
    ),
  );

  it.effect("refuses malformed ids the wire accepts with a typed error, never a defect", () =>
    withDatabase(
      Effect.gen(function* () {
        const { catalog, actions } = yield* startActions(yield* Scope.Scope);
        const { installationId } = yield* enablePlugin(catalog, yield* preparePlugin());
        const decode = Schema.decodeUnknownEffect(PluginActionInvokeInput);
        const exits = yield* Effect.forEach(
          [
            ":1:go",
            `${"x".repeat(65)}:1:go`,
            "::",
            `${installationId}::say-hello`,
            `${installationId}:1.0:say-hello`,
            `${installationId}:99999999999999999999:say-hello`,
            `${installationId} :1:say-hello`,
          ],
          (actionId) =>
            decode({ actionId, target: { _tag: "environment" } }).pipe(
              Effect.flatMap((input) => actions.invoke(input).pipe(Effect.exit)),
            ),
        );
        for (const exit of exits) {
          expect(Exit.isFailure(exit) && !Cause.hasDies(exit.cause)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.squash(exit.cause)).toMatchObject({
              _tag: "PluginActionError",
              reason: "not-found",
            });
          }
        }
      }),
    ),
  );

  it.effect("offers plugins whole up to the environment bound and runs only those", () =>
    withDatabase(
      Effect.gen(function* () {
        const { catalog, actions } = yield* startActions(yield* Scope.Scope);
        const pluginCount = PLUGIN_ACTIONS_MAX_PER_ENVIRONMENT / PLUGIN_ACTIONS_MAX_PER_PLUGIN + 1;
        const installations = yield* Effect.forEach(
          Array.from({ length: pluginCount }, (_, index) => index),
          (index) =>
            preparePlugin((manifest) => ({
              ...manifest,
              id: `test.actions-${index}`,
              actions: Array.from({ length: PLUGIN_ACTIONS_MAX_PER_PLUGIN }, (_, action) => ({
                name: `go-${action}`,
                title: `Go ${action}`,
                target: "environment",
                placements: ["command-palette"],
              })),
            })).pipe(Effect.flatMap((directory) => enablePlugin(catalog, directory))),
        );
        const full = yield* actions.subscribe.pipe(
          Stream.filter((snapshot) => snapshot.omitted !== undefined),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(full.actions).toHaveLength(PLUGIN_ACTIONS_MAX_PER_ENVIRONMENT);
        expect(full.omitted).toEqual({ plugins: 1, actions: PLUGIN_ACTIONS_MAX_PER_PLUGIN });
        const listedIds = new Set(full.actions.map((action) => action.id.split(":")[0]));
        const left = installations.find(
          (installation) => !listedIds.has(installation.installationId),
        )!;

        const refused = yield* actions
          .invoke({
            actionId: PluginActionId.make(`${left.installationId}:${left.generation}:go-0`),
            target: { _tag: "environment" },
          })
          .pipe(Effect.flip);
        expect(refused.reason).toBe("not-found");
        expect(refused.message).toContain("more actions than it shows");

        // Disabling a listed plugin makes room, and the left-out one is offered whole.
        const listed = installations.find((installation) => installation !== left)!;
        yield* catalog.disable({ installationId: listed.installationId });
        const after = yield* awaitActions(actions, (snapshot) => snapshot.omitted === undefined);
        expect(after).toHaveLength(PLUGIN_ACTIONS_MAX_PER_ENVIRONMENT);
        expect(
          after.filter((action) => action.id.startsWith(`${left.installationId}:`)),
        ).toHaveLength(PLUGIN_ACTIONS_MAX_PER_PLUGIN);
      }),
    ),
  );

  it.effect("refuses declarations the host cannot honour", () =>
    Effect.gen(function* () {
      const reasons = yield* Effect.forEach(
        [
          (manifest: Record<string, unknown>) => ({ ...manifest, capabilities: [] }),
          (manifest: Record<string, unknown>) => ({ ...manifest, proposedApi: false }),
          (manifest: Record<string, unknown>) => ({
            ...manifest,
            actions: [
              { name: "same", title: "One", target: "environment", placements: ["thread-menu"] },
              { name: "same", title: "Two", target: "environment", placements: ["thread-menu"] },
            ],
          }),
          (manifest: Record<string, unknown>) => ({
            ...manifest,
            actions: [
              {
                name: "twice",
                title: "Twice",
                target: "environment",
                placements: ["thread-menu", "thread-menu"],
              },
            ],
          }),
        ],
        (variant) =>
          preparePlugin(variant).pipe(
            Effect.flatMap(loadPluginDirectory),
            Effect.flip,
            Effect.map((error) => error.reason),
          ),
      );
      expect(reasons).toEqual([
        "it declares actions without the actions capability.",
        "it declares actions, which need proposedApi: true.",
        "it declares the action same twice.",
        "the action twice repeats a placement.",
      ]);
    }),
  );
});

describe("pluginActionsFromCatalog", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const installation: PluginInstallation = {
    installationId: PluginInstallationId.make("installation-1"),
    generation: 3,
    directory: "/srv/plugins/actions",
    manifest: {
      id: PluginId.make("test.actions"),
      name: "Actions",
      version: "1.0.0",
      capabilities: ["actions"],
      proposedApi: true,
      actions: [{ name: "go", title: "Go", target: "environment", placements: ["thread-menu"] }],
    },
    source: { digest, files: 2, bytes: 10 },
    problem: null,
    inspectedAt: "2026-10-04T00:00:00.000Z",
    consent: { digest, capabilities: ["actions"], grantedAt: "2026-10-04T00:00:00.000Z" },
    enabled: true,
    hostState: { _tag: "running" },
    addedAt: "2026-10-04T00:00:00.000Z",
  };
  const names = (installations: ReadonlyArray<PluginInstallation>) =>
    PluginActions.pluginActionsFromCatalog({ installations }).actions.map((action) => action.id);

  const many = (count: number, description?: string) =>
    Array.from({ length: count }, (_, index): PluginInstallation => {
      const installationId = PluginInstallationId.make(`installation-${index}`);
      return {
        ...installation,
        installationId,
        manifest: {
          ...installation.manifest!,
          id: PluginId.make(`test.actions-${index}`),
          actions: Array.from({ length: PLUGIN_ACTIONS_MAX_PER_PLUGIN }, (_, action) => ({
            name: `go-${action}`,
            title: `Go ${action}`,
            ...(description === undefined ? {} : { description }),
            target: "environment" as const,
            placements: ["command-palette" as const],
          })),
        },
      };
    });
  const frameBytes = (snapshot: PluginActionsSnapshot) =>
    Buffer.byteLength(JSON.stringify(snapshot));

  it("bounds the actions and bytes one environment offers, counting what it leaves out", () => {
    const byCount = PluginActions.pluginActionsFromCatalog({ installations: many(1000) });
    expect(byCount.actions).toHaveLength(PLUGIN_ACTIONS_MAX_PER_ENVIRONMENT);
    const keptPlugins = PLUGIN_ACTIONS_MAX_PER_ENVIRONMENT / PLUGIN_ACTIONS_MAX_PER_PLUGIN;
    expect(byCount.omitted).toEqual({
      plugins: 1000 - keptPlugins,
      actions: (1000 - keptPlugins) * PLUGIN_ACTIONS_MAX_PER_PLUGIN,
    });
    // The first plugins in catalogue order are the ones kept.
    expect(new Set(byCount.actions.map((action) => action.id.split(":")[0]))).toEqual(
      new Set(Array.from({ length: keptPlugins }, (_, index) => `installation-${index}`)),
    );
    expect(frameBytes(byCount)).toBeLessThanOrEqual(PLUGIN_ACTIONS_SNAPSHOT_MAX_BYTES);

    // Escaped control characters make each description six times its length on the wire.
    const byBytes = PluginActions.pluginActionsFromCatalog({
      installations: many(1000, "\u0001".repeat(240)),
    });
    expect(byBytes.actions.length).toBeLessThan(PLUGIN_ACTIONS_MAX_PER_ENVIRONMENT);
    expect(byBytes.actions.length % PLUGIN_ACTIONS_MAX_PER_PLUGIN).toBe(0);
    expect(byBytes.omitted?.actions).toBe(
      1000 * PLUGIN_ACTIONS_MAX_PER_PLUGIN - byBytes.actions.length,
    );
    expect(frameBytes(byBytes)).toBeLessThanOrEqual(PLUGIN_ACTIONS_SNAPSHOT_MAX_BYTES);

    // Within the bounds nothing is left out and `omitted` is absent.
    expect(
      PluginActions.pluginActionsFromCatalog({ installations: many(keptPlugins) }),
    ).not.toHaveProperty("omitted");
  });

  it("offers only actions that can run now", () => {
    expect(names([installation])).toEqual(["installation-1:3:go"]);
    // A state this server version does not know is unknown, not a reason to hide the action.
    const { hostState: _hostState, ...unknownState } = installation;
    expect(names([unknownState])).toEqual(["installation-1:3:go"]);
    for (const hidden of [
      { ...installation, enabled: false },
      { ...installation, consent: null },
      { ...installation, source: null, problem: "gone" },
      { ...installation, hostState: { _tag: "quarantined" as const, failures: 3, reason: "x" } },
      { ...installation, hostState: { _tag: "incompatible" as const, reason: "x" } },
      { ...installation, manifest: { ...installation.manifest!, capabilities: [] } },
    ]) {
      expect(names([hidden])).toEqual([]);
    }
  });
});
