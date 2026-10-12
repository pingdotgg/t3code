import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  contributionStatusSourceKey,
  EnvironmentId,
  type PluginInstallationId,
  PluginEventPage,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeOS from "node:os";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as ContributionStatusStore from "@t3tools/provider-core/server/ContributionStatusStore";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PluginCatalog from "./PluginCatalog.ts";
import { PLUGIN_EVENTS_HANDLER } from "./pluginIpcFraming.ts";
import * as PluginNotifications from "./PluginNotifications.ts";
import * as PluginSettings from "./PluginSettings.ts";
import * as PluginStatus from "./PluginStatus.ts";
import * as PluginSupervisor from "./PluginSupervisor.ts";
import * as PluginTools from "./PluginTools.ts";

// The example plugins under examples/plugins, run exactly as a user would install them.
const EXAMPLES_DIR = `${import.meta.dirname}/../../../../examples/plugins`;
// Children run the real CLI entry, which routes `__plugin-host` to the child runtime.
const BIN_PATH = `${import.meta.dirname}/../bin.ts`;

const environmentId = EnvironmentId.make("environment:examples");
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodePage = Schema.decodeUnknownSync(PluginEventPage);

/** A secret store in memory; the examples declare no secrets. */
const secretStore = () => {
  const entries = new Map<string, Uint8Array>();
  return ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(entries.get(name))),
    set: (name, value) => Effect.sync(() => void entries.set(name, value)),
    create: (name, value) => Effect.sync(() => void entries.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const value = entries.get(name) ?? new Uint8Array(bytes);
        entries.set(name, value);
        return value;
      }),
    remove: (name) => Effect.sync(() => void entries.delete(name)),
  });
};

/** The plugin services one server start runs, with a real supervisor and child processes. */
const start = Effect.fn("start")(function* () {
  const supervisor = yield* PluginSupervisor.make({
    heapLimitMb: 64,
    activationTimeout: "10 seconds",
    stopGrace: "1 second",
  }).pipe(Effect.provideService(HostProcess.Arguments, [process.execPath, BIN_PATH]));
  const catalog = yield* PluginCatalog.make().pipe(
    Effect.provideService(PluginSupervisor.PluginSupervisor, supervisor),
  );
  const store = yield* ContributionStatusStore.make();
  yield* PluginStatus.make().pipe(
    Effect.provideService(PluginSupervisor.PluginSupervisor, supervisor),
    Effect.provideService(ContributionStatusStore.ContributionStatusStore, store),
  );
  const notifications = yield* PluginNotifications.make().pipe(
    Effect.provideService(PluginSupervisor.PluginSupervisor, supervisor),
  );
  const settings = yield* PluginSettings.make().pipe(
    Effect.provideService(PluginSupervisor.PluginSupervisor, supervisor),
    Effect.provideService(PluginCatalog.PluginCatalog, catalog),
    Effect.provideService(ServerSecretStore, secretStore()),
  );
  const tools = yield* PluginTools.make.pipe(
    Effect.provideService(PluginCatalog.PluginCatalog, catalog),
  );

  /** Copies an example to a scoped directory, then adds, approves and enables it. */
  const install = Effect.fn("install")(function* (example: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-example-" }),
      example,
    );
    yield* fs.copy(path.join(EXAMPLES_DIR, example), directory);
    const { installation } = yield* catalog.add({ directory });
    assert.strictEqual(installation.problem, null);
    const installationId = installation.installationId;
    yield* catalog.consent({ installationId, digest: installation.source!.digest });
    yield* catalog.enable({ installationId });
    return installationId;
  });

  /**
   * Delivers turn events to a plugin as the event feed would: `run.finalized` with
   * `outcome`, or `run.finalization-failed` with `operation`.
   */
  const finishTurns = (
    installationId: PluginInstallationId,
    turns: ReadonlyArray<
      { readonly threadId: ThreadId; readonly title: string } & (
        | { readonly outcome: string }
        | { readonly operation: string }
      )
    >,
  ) => {
    const events = turns.map((turn, index) => ({
      ...("outcome" in turn
        ? { type: "run.finalized", outcome: turn.outcome }
        : { type: "run.finalization-failed", operation: turn.operation }),
      deliveryId: `event-${index}`,
      sequence: index,
      occurredAt: "2026-10-04T00:00:00.000Z",
      environmentId,
      threadId: turn.threadId,
      runId: `run-${index}`,
      thread: { projectId: "project-a", title: turn.title },
    }));
    // Checks the page is exactly what the feed sends.
    decodePage({ events });
    return catalog.invoke(installationId, PLUGIN_EVENTS_HANDLER, { events });
  };

  return { store, notifications, settings, tools, install, finishTurns };
});

/** `thread: source item=text (tone)` per plugin status, in snapshot order. */
const statuses = (store: ContributionStatusStore.ContributionStatusStoreShape) =>
  store.snapshot.pipe(
    Effect.map((snapshot) =>
      snapshot.entries.flatMap((entry) =>
        entry.items.map(
          (item) =>
            `${entry.threadId}: ${contributionStatusSourceKey(entry.source)} ${item.key}=${item.text} (${item.tone ?? "neutral"})`,
        ),
      ),
    ),
  );

const withDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(SqlitePersistence.layerMemory), Effect.scoped);

it.layer(NodeServices.layer)("example plugins", (it) => {
  describe("turn-notifier", () => {
    it.effect("notifies once per finished turn, naming the thread and the outcome", () =>
      withDatabase(
        Effect.gen(function* () {
          const { install, finishTurns, notifications } = yield* start();
          const installationId = yield* install("turn-notifier");
          yield* finishTurns(installationId, [
            { threadId: THREAD_A, title: "Fix login", outcome: "completed" },
            { threadId: THREAD_B, title: "Upgrade deps", outcome: "failed" },
          ]);
          const frame = yield* Stream.runHead(notifications.subscribe).pipe(
            Effect.map(Option.getOrThrow),
          );
          assert.deepStrictEqual(
            frame.notifications.map(({ pluginId, title, tone, threadId }) => ({
              pluginId,
              title,
              tone,
              threadId,
            })),
            [
              {
                pluginId: "example.turn-notifier",
                title: "Fix login finished",
                tone: "success",
                threadId: THREAD_A,
              },
              {
                pluginId: "example.turn-notifier",
                title: "Upgrade deps failed",
                tone: "error",
                threadId: THREAD_B,
              },
            ],
          );
        }),
      ),
    );

    it.effect("notifies when finishing a turn fails, naming the failed step", () =>
      withDatabase(
        Effect.gen(function* () {
          const { install, finishTurns, notifications } = yield* start();
          const installationId = yield* install("turn-notifier");
          yield* finishTurns(installationId, [
            { threadId: THREAD_A, title: "Fix login", operation: "capture-checkpoint" },
          ]);
          const frame = yield* Stream.runHead(notifications.subscribe).pipe(
            Effect.map(Option.getOrThrow),
          );
          assert.deepStrictEqual(
            frame.notifications.map(({ title, body, tone, threadId }) => ({
              title,
              body,
              tone,
              threadId,
            })),
            [
              {
                title: "Fix login: finishing the turn failed",
                body: "Saving the checkpoint failed.",
                tone: "warning",
                threadId: THREAD_A,
              },
            ],
          );
        }),
      ),
    );
  });

  describe("todo-count", () => {
    it.effect("offers agents a tool that counts TODO and FIXME comments by file", () =>
      withDatabase(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { install, tools } = yield* start();
          yield* install("todo-count");
          const project = yield* fs.makeTempDirectoryScoped({ prefix: "t3-todo-project-" });
          yield* fs.makeDirectory(path.join(project, "src"));
          yield* fs.makeDirectory(path.join(project, "node_modules"));
          yield* fs.writeFileString(
            path.join(project, "src", "a.ts"),
            "// TODO: one\n// FIXME: two\n// TODOS is not a marker\n",
          );
          yield* fs.writeFileString(path.join(project, "b.md"), "TODO: three\n");
          yield* fs.writeFileString(path.join(project, "node_modules", "c.js"), "// TODO skip\n");

          // The agent's path: the declared schema is checked before the plugin runs.
          const grants = yield* tools.grants;
          const listed = yield* tools.list(grants);
          assert.deepStrictEqual(
            listed.tools.map((tool) => tool.tool),
            ["example.todo-count/count_todos"],
          );
          const context = { environmentId, threadId: THREAD_A };
          const result = yield* tools.call(grants, {
            tool: "example.todo-count/count_todos",
            input: { directory: project, top: 5 },
            context,
          });
          assert.deepStrictEqual(result, {
            total: 3,
            filesScanned: 2,
            truncated: false,
            files: [
              { path: path.join("src", "a.ts"), count: 2 },
              { path: "b.md", count: 1 },
            ],
          });
          const invalid = yield* tools
            .call(grants, {
              tool: "example.todo-count/count_todos",
              input: { top: 5 },
              context,
            })
            .pipe(Effect.flip);
          assert.strictEqual(invalid.reason, "invalid-input");
          const relative = yield* tools
            .call(grants, {
              tool: "example.todo-count/count_todos",
              input: { directory: "src" },
              context,
            })
            .pipe(Effect.flip);
          assert.strictEqual(relative.reason, "failed");
          assert.include(relative.message, "absolute directory path");
        }),
      ),
    );
  });

  describe("machine-label", () => {
    it.effect("labels threads that finish a turn with the configured label and color", () =>
      withDatabase(
        Effect.gen(function* () {
          const { install, finishTurns, settings, store } = yield* start();
          const installationId = yield* install("machine-label");
          const source = toJson(["plugin", "example.machine-label"]);

          // Without a label it shows the host name, in the default color.
          yield* finishTurns(installationId, [
            { threadId: THREAD_A, title: "a", outcome: "completed" },
          ]);
          assert.deepStrictEqual(yield* statuses(store), [
            `thread-a: ${source} machine=${NodeOS.hostname()} (info)`,
          ]);

          yield* settings.update({
            installationId,
            changes: [
              { key: "label", value: "Build box" },
              { key: "tone", value: "warning" },
            ],
          });
          yield* finishTurns(installationId, [
            { threadId: THREAD_B, title: "b", outcome: "interrupted" },
          ]);
          assert.deepStrictEqual(yield* statuses(store), [
            `thread-a: ${source} machine=${NodeOS.hostname()} (info)`,
            `thread-b: ${source} machine=Build box (warning)`,
          ]);
        }),
      ),
    );
  });
});
