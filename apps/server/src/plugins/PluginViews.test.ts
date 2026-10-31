// @effect-diagnostics nodeBuiltinImport:off - the test hashes view bytes the way PluginViews does.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { PLUGIN_VIEW_SCRIPT_MAX_BYTES, type PluginViewsSnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PluginCatalog from "./PluginCatalog.ts";
import * as PluginManifestLoader from "./PluginManifestLoader.ts";
import * as PluginSupervisor from "./PluginSupervisor.ts";
import * as PluginViews from "./PluginViews.ts";
import * as ViewFile from "./pluginViewFile.ts";

// Children run the real CLI entry, which routes `__plugin-host` to the child runtime.
const BIN_PATH = `${import.meta.dirname}/../bin.ts`;
/** A views plugin whose `board` view has `view:board:*` handlers; tests never write to it. */
const BOARD_FIXTURE = `${import.meta.dirname}/testFixtures/views`;

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const VIEW_SCRIPT = `t3View.ready.then(() => t3View.call("echo", { from: "view" }));\n`;

const withAssetReads = (
  read: (
    target: string,
    file: ViewFile.ViewFile,
    buffer: Uint8Array,
  ) => ReturnType<ViewFile.ViewFile["read"]>,
) => {
  const open = ViewFile.open;
  return vi.spyOn(ViewFile, "open").mockImplementation((target) =>
    open(target).pipe(
      Effect.map((file) => ({
        ...file,
        read: (buffer: Uint8Array) => read(target, file, buffer),
      })),
    ),
  );
};

/** Starts a catalogue, its supervisor, and the views service in `scope`, as one server start would. */
const startViews = Effect.fn("startViews")(function* (
  scope: Scope.Scope,
  viewFileSystem?: FileSystem.FileSystem,
) {
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
  const views = yield* PluginViews.make().pipe(
    Effect.provideService(PluginCatalog.PluginCatalog, catalog),
    Effect.provideService(FileSystem.FileSystem, viewFileSystem ?? (yield* FileSystem.FileSystem)),
    Effect.provideService(Scope.Scope, scope),
  );
  return { catalog, views };
});

/** Writes a views plugin with a `panel` view, in a directory the test may edit. */
const preparePlugin = Effect.fn("preparePlugin")(function* (options?: {
  readonly script?: string;
  readonly views?: unknown;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-views-" });
  const directory = path.join(root, "plugin");
  yield* fs.makeDirectory(path.join(directory, "views"), { recursive: true });
  yield* fs.writeFileString(path.join(directory, "main.mjs"), `export function activate() {}\n`);
  yield* fs.writeFileString(
    path.join(directory, "views", "panel.js"),
    options?.script ?? VIEW_SCRIPT,
  );
  yield* fs.writeFileString(path.join(directory, "views", "panel.css"), "body { margin: 0; }\n");
  yield* fs.writeFileString(
    path.join(directory, "t3-plugin.json"),
    toJson({
      id: "test.views",
      name: "Views",
      version: "1.0.0",
      apiVersion: 1,
      entry: "main.mjs",
      capabilities: ["views"],
      proposedApi: true,
      views: options?.views ?? [
        {
          id: "panel",
          title: "Panel",
          placement: "side-panel",
          script: "views/panel.js",
          style: "views/panel.css",
        },
      ],
    }),
  );
  return { directory, script: path.join(directory, "views", "panel.js") };
});

type Views = PluginViews.PluginViews["Service"];

/** Waits, through the subscription, for a snapshot that satisfies `predicate`. */
const awaitViews = (views: Views, predicate: (snapshot: PluginViewsSnapshot) => boolean) =>
  views.subscribe.pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map((snapshot) => Option.getOrThrow(snapshot)),
  );

/** Adds, approves, and enables the plugin; returns its installation. */
const install = Effect.fn("install")(function* (
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

const withDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(SqlitePersistence.layerMemory));

it.layer(NodeServices.layer)("PluginViews", (it) => {
  describe("bundles", () => {
    it.effect("revokes cached bundles immediately when the disabled record cannot be saved", () =>
      withDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const fs = yield* FileSystem.FileSystem;
          const { catalog, views } = yield* startViews(yield* Scope.Scope);
          const plugin = yield* preparePlugin();
          const installation = yield* install(catalog, plugin.directory);
          yield* awaitViews(views, (snapshot) => snapshot.views.length > 0);
          const target = {
            installationId: installation.installationId,
            generation: installation.generation,
            viewId: "panel",
          };
          expect((yield* views.readBundle(target)).script.text).toBe(VIEW_SCRIPT);
          yield* sql`CREATE TRIGGER refuse_view_revocation BEFORE UPDATE ON plugin_installations BEGIN SELECT RAISE(FAIL, 'test write failure'); END`;
          yield* fs.writeFileString(plugin.script, `${VIEW_SCRIPT}// changed after consent\n`);
          const failed = yield* catalog
            .refresh({ installationId: installation.installationId })
            .pipe(Effect.flip);
          expect(failed.reason).toBe("storage");
          expect(Exit.isFailure(yield* views.readBundle(target).pipe(Effect.exit))).toBe(true);
          expect((yield* catalog.list).installations[0]?.enabled).toBe(false);
          yield* sql`DROP TRIGGER refuse_view_revocation`;
          yield* catalog.refresh({ installationId: installation.installationId });
          const saved = yield* sql<{
            readonly record_json: string;
          }>`SELECT record_json FROM plugin_installations`;
          expect(JSON.parse(saved[0]!.record_json).enabled).toBe(false);
        }),
      ),
    );

    // quarantine: #16056 POSIX FIFOs are unavailable on Windows.
    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "rejects an asset swapped to a FIFO without waiting for a writer",
      () =>
        withDatabase(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const plugin = yield* preparePlugin();
            const serviceScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
              Scope.close(scope, Exit.void),
            );
            yield* Effect.addFinalizer(() =>
              Effect.tryPromise(async () => {
                const writer = await NodeFSP.open(
                  plugin.script,
                  NodeFS.constants.O_WRONLY | NodeFS.constants.O_NONBLOCK,
                );
                await writer.close();
              }).pipe(Effect.ignore),
            );
            let swapped = false;
            const viewFs: FileSystem.FileSystem = {
              ...fs,
              realPath: (target) =>
                fs.realPath(target).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      if (target !== plugin.script || swapped) return;
                      swapped = true;
                      NodeFS.unlinkSync(target);
                      NodeChildProcess.execFileSync("mkfifo", [target]);
                    }),
                  ),
                ),
            };
            const { catalog, views } = yield* startViews(serviceScope, viewFs);
            yield* install(catalog, plugin.directory);
            const shown = yield* awaitViews(views, (snapshot) => snapshot.problems.length > 0);
            expect(swapped).toBe(true);
            expect(shown.views).toEqual([]);
            expect(shown.problems).toHaveLength(1);
          }),
        ),
    );

    it.effect.each(["asset", "manifest"] as const)(
      "bounds reads when a %s grows after its handle was statted",
      (kind) =>
        withDatabase(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const plugin = yield* preparePlugin();
            const targetPath =
              kind === "asset" ? plugin.script : `${plugin.directory}/t3-plugin.json`;
            const maxBytes = kind === "asset" ? PLUGIN_VIEW_SCRIPT_MAX_BYTES : 64 * 1024;
            let bytesRead = 0;
            const open = ViewFile.open;
            using _open = vi.spyOn(ViewFile, "open").mockImplementation((target) =>
              open(target).pipe(
                Effect.map((file) => ({
                  ...file,
                  stat: file.stat.pipe(
                    Effect.tap(() =>
                      target === targetPath
                        ? fs.writeFileString(target, "x".repeat(maxBytes + 4096)).pipe(Effect.orDie)
                        : Effect.void,
                    ),
                  ),
                  read: (buffer: Uint8Array) =>
                    file.read(buffer).pipe(
                      Effect.tap((count) =>
                        Effect.sync(() => {
                          if (target === targetPath) bytesRead += count;
                        }),
                      ),
                    ),
                })),
              ),
            );
            const { catalog, views } = yield* startViews(yield* Scope.Scope);
            yield* install(catalog, plugin.directory);
            const shown = yield* awaitViews(
              views,
              (snapshot) => snapshot.problems.length > 0 || snapshot.views.length > 0,
            );
            expect(shown.views).toEqual([]);
            expect(bytesRead).toBe(maxBytes + 1);
          }),
        ),
    );
    it.effect("serves a view's consented bytes only to its current generation", () =>
      withDatabase(
        Effect.gen(function* () {
          const { catalog, views } = yield* startViews(yield* Scope.Scope);
          const plugin = yield* preparePlugin();
          const { installation: added } = yield* catalog.add({ directory: plugin.directory });
          const installationId = added.installationId;
          const notEnabled = yield* views
            .readBundle({ installationId, generation: 0, viewId: "panel" })
            .pipe(Effect.flip);
          expect(notEnabled.reason).toBe("unavailable");

          yield* catalog.consent({ installationId, digest: added.source!.digest });
          const enabled = (yield* catalog.enable({ installationId })).installation;
          const shown = yield* awaitViews(views, (snapshot) => snapshot.views.length > 0);
          expect(shown).toEqual({
            views: [
              {
                installationId,
                generation: enabled.generation,
                pluginId: "test.views",
                pluginName: "Views",
                viewId: "panel",
                title: "Panel",
                placement: "side-panel",
              },
            ],
            problems: [],
          });

          const bundle = yield* views.readBundle({
            installationId,
            generation: enabled.generation,
            viewId: "panel",
          });
          expect(bundle).toEqual({
            installationId,
            generation: enabled.generation,
            viewId: "panel",
            sourceDigest: enabled.consent!.digest,
            script: {
              text: VIEW_SCRIPT,
              sha256: NodeCrypto.createHash("sha256").update(VIEW_SCRIPT).digest("base64"),
            },
            style: {
              text: "body { margin: 0; }\n",
              sha256: NodeCrypto.createHash("sha256")
                .update("body { margin: 0; }\n")
                .digest("base64"),
            },
          });
          const missing = yield* views
            .readBundle({ installationId, generation: enabled.generation, viewId: "other" })
            .pipe(Effect.flip);
          expect(missing.reason).toBe("not-found");

          // Disable revokes: the views leave the snapshot and the generation serves nothing.
          yield* catalog.disable({ installationId });
          yield* awaitViews(views, (snapshot) => snapshot.views.length === 0);
          const disabled = yield* views
            .readBundle({ installationId, generation: enabled.generation, viewId: "panel" })
            .pipe(Effect.flip);
          expect(disabled.reason).toBe("unavailable");

          // A re-enable is a new generation; the old one stays refused.
          const again = (yield* catalog.enable({ installationId })).installation;
          expect(again.generation).toBe(enabled.generation + 1);
          yield* awaitViews(
            views,
            (snapshot) => snapshot.views[0]?.generation === again.generation,
          );
          const stale = yield* views
            .readBundle({ installationId, generation: enabled.generation, viewId: "panel" })
            .pipe(Effect.flip);
          expect(stale.reason).toBe("generation-changed");

          yield* catalog.remove({ installationId });
          yield* awaitViews(views, (snapshot) => snapshot.views.length === 0);
          const removed = yield* views
            .readBundle({ installationId, generation: again.generation, viewId: "panel" })
            .pipe(Effect.flip);
          expect(removed.reason).toBe("not-found");
        }),
      ),
    );

    it.effect.each([
      {
        name: "bytes change",
        change: (fs: FileSystem.FileSystem, plugin: { directory: string; script: string }) =>
          fs.writeFileString(plugin.script, `${VIEW_SCRIPT}// edited\n`),
      },
      {
        // The read fails before the digest, which still finds the edit.
        name: "bytes change into an invalid view",
        change: (fs: FileSystem.FileSystem, plugin: { directory: string; script: string }) =>
          fs.writeFileString(plugin.script, `document.write("</script>");\n`),
      },
      {
        // The final digest refuses a symlinked tree instead of computing a different digest.
        name: "directory stops being digestible",
        change: (fs: FileSystem.FileSystem, plugin: { directory: string; script: string }) =>
          fs.symlink("main.mjs", `${plugin.directory}/late-link`),
      },
    ])("disables a plugin whose $name while its views are read", ({ change }) =>
      withDatabase(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const plugin = yield* preparePlugin();
          // The views service reads the script through a file system that stops at it once.
          const reached = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let held = false;
          using _holding = withAssetReads((target, file, buffer) =>
            Effect.suspend(() => {
              if (held || !target.endsWith("panel.js")) return file.read(buffer);
              held = true;
              return Deferred.succeed(reached, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(file.read(buffer)),
              );
            }),
          );
          const { catalog, views } = yield* startViews(yield* Scope.Scope);
          const installation = yield* install(catalog, plugin.directory);

          yield* Deferred.await(reached);
          const target = {
            installationId: installation.installationId,
            generation: installation.generation,
            viewId: "panel",
          };
          // A fetch waiting on that read is answered from the same check.
          const waiting = yield* views
            .readBundle(target)
            .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
          yield* change(fs, plugin);
          yield* Deferred.succeed(release, undefined);

          expect((yield* Fiber.join(waiting)).reason).toBe("source-changed");
          // The catalogue re-inspects and disables it; nothing is shown or served.
          yield* catalog.subscribe.pipe(
            Stream.filter((snapshot) => snapshot.installations[0]?.enabled === false),
            Stream.runHead,
          );
          const shown = yield* awaitViews(views, (snapshot) => snapshot.problems.length === 0);
          expect(shown.views).toEqual([]);
          const refused = yield* views.readBundle(target).pipe(Effect.flip);
          expect(refused.reason).toBe("unavailable");
        }),
      ),
    );

    it.effect("serves nothing when the bytes read differ from the bytes digested", () =>
      withDatabase(
        Effect.gen(function* () {
          const plugin = yield* preparePlugin();
          // As if the script changed for the read and was restored before the digest.
          const positions = new WeakMap<ViewFile.ViewFile, number>();
          using _swapped = withAssetReads((target, file, buffer) => {
            if (!target.endsWith("panel.js")) return file.read(buffer);
            return Effect.suspend(() => {
              const bytes = new TextEncoder().encode(`${VIEW_SCRIPT}// swapped\n`);
              const position = positions.get(file) ?? 0;
              const part = bytes.subarray(position, position + buffer.length);
              buffer.set(part);
              positions.set(file, position + part.length);
              return Effect.succeed(part.length);
            });
          });
          const { catalog, views } = yield* startViews(yield* Scope.Scope);
          const installation = yield* install(catalog, plugin.directory);
          const shown = yield* awaitViews(
            views,
            (snapshot) => snapshot.views.length > 0 || snapshot.problems.length > 0,
          );
          expect(shown.views).toEqual([]);
          expect(shown.problems[0]?.message).toBe(
            "The plugin's files changed while its views were read.",
          );
          const refused = yield* views
            .readBundle({
              installationId: installation.installationId,
              generation: installation.generation,
              viewId: "panel",
            })
            .pipe(Effect.flip);
          expect(refused.reason).toBe("source-changed");
        }),
      ),
    );

    it.effect("serves nothing when views sharing a script read it differently", () =>
      withDatabase(
        Effect.gen(function* () {
          const plugin = yield* preparePlugin({
            views: [
              { id: "panel", title: "Panel", placement: "side-panel", script: "views/panel.js" },
              { id: "other", title: "Other", placement: "side-panel", script: "views/panel.js" },
            ],
          });
          // As if the script changed for the first view's read and was restored before the second.
          let reads = 0;
          const open = ViewFile.open;
          using _swapped = vi.spyOn(ViewFile, "open").mockImplementation((target) =>
            open(target).pipe(
              Effect.map((file) => {
                if (!target.endsWith("panel.js") || reads++ !== 0) return file;
                const bytes = new TextEncoder().encode(`${VIEW_SCRIPT}// swapped\n`);
                let offset = 0;
                return {
                  ...file,
                  read: (buffer: Uint8Array) =>
                    Effect.sync(() => {
                      const part = bytes.subarray(offset, offset + buffer.length);
                      buffer.set(part);
                      offset += part.length;
                      return part.length;
                    }),
                };
              }),
            ),
          );
          const { catalog, views } = yield* startViews(yield* Scope.Scope);
          const installation = yield* install(catalog, plugin.directory);
          const shown = yield* awaitViews(
            views,
            (snapshot) => snapshot.views.length > 0 || snapshot.problems.length > 0,
          );
          expect(shown.views).toEqual([]);
          expect(shown.problems[0]?.message).toBe(
            "The plugin's files changed while its views were read.",
          );
          const refused = yield* views
            .readBundle({
              installationId: installation.installationId,
              generation: installation.generation,
              viewId: "panel",
            })
            .pipe(Effect.flip);
          expect(refused.reason).toBe("source-changed");
        }),
      ),
    );

    it.effect("reports view files that cannot be inlined exactly instead of serving them", () =>
      withDatabase(
        Effect.gen(function* () {
          const { catalog, views } = yield* startViews(yield* Scope.Scope);
          const unsafe = yield* preparePlugin({ script: `document.write("</script>");\n` });
          const installation = yield* install(catalog, unsafe.directory);
          const shown = yield* awaitViews(views, (snapshot) => snapshot.problems.length > 0);
          expect(shown.views).toEqual([]);
          expect(shown.problems).toEqual([
            {
              installationId: installation.installationId,
              generation: installation.generation,
              message: expect.stringContaining("views/panel.js contains CR, NUL"),
            },
          ]);
          const refused = yield* views
            .readBundle({
              installationId: installation.installationId,
              generation: installation.generation,
              viewId: "panel",
            })
            .pipe(Effect.flip);
          expect(refused.reason).toBe("invalid-view");
          yield* catalog.disable({ installationId: installation.installationId });
          yield* awaitViews(views, (snapshot) => snapshot.problems.length === 0);

          const escaping = yield* preparePlugin({
            views: [
              { id: "panel", title: "Panel", placement: "side-panel", script: "../outside.js" },
            ],
          });
          const second = yield* install(catalog, escaping.directory);
          const invalid = yield* awaitViews(views, (snapshot) =>
            snapshot.problems.some((problem) => problem.installationId === second.installationId),
          );
          expect(invalid.problems[0]?.message).toContain("The views in t3-plugin.json are invalid");
          yield* catalog.disable({ installationId: second.installationId });
          yield* awaitViews(views, (snapshot) => snapshot.problems.length === 0);

          // Under the raw size limit, but each control character escapes to six bytes of JSON.
          const escaped = yield* preparePlugin({
            script: `//${"\u0001".repeat(400 * 1024)}\n`,
          });
          const third = yield* install(catalog, escaped.directory);
          const oversized = yield* awaitViews(views, (snapshot) =>
            snapshot.problems.some((problem) => problem.installationId === third.installationId),
          );
          expect(oversized.problems[0]?.message).toContain("once encoded for delivery");
        }),
      ),
    );

    it.effect("serves an asset whose name only starts with two dots", () =>
      withDatabase(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { catalog, views } = yield* startViews(yield* Scope.Scope);
          const plugin = yield* preparePlugin({
            views: [{ id: "panel", title: "Panel", placement: "side-panel", script: "..board.js" }],
          });
          yield* fs.writeFileString(path.join(plugin.directory, "..board.js"), VIEW_SCRIPT);
          const installation = yield* install(catalog, plugin.directory);
          const shown = yield* awaitViews(
            views,
            (snapshot) => snapshot.views.length > 0 || snapshot.problems.length > 0,
          );
          expect(shown.problems).toEqual([]);
          const bundle = yield* views.readBundle({
            installationId: installation.installationId,
            generation: installation.generation,
            viewId: "panel",
          });
          expect(bundle.script.text).toBe(VIEW_SCRIPT);
        }),
      ),
    );
  });

  describe("calls", () => {
    it.effect("refuses the views capability without the proposed API opt-in", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-views-" });
        yield* fs.writeFileString(
          path.join(directory, "main.mjs"),
          "export function activate() {}\n",
        );
        yield* fs.writeFileString(
          path.join(directory, "t3-plugin.json"),
          toJson({
            id: "test.views-no-opt-in",
            name: "test.views-no-opt-in",
            version: "1.0.0",
            apiVersion: 1,
            entry: "main.mjs",
            capabilities: ["views"],
          }),
        );
        const error = yield* PluginManifestLoader.loadPluginDirectory(directory).pipe(Effect.flip);
        expect(error.reason).toContain('"views" capability needs "proposedApi": true');
      }).pipe(Effect.scoped),
    );
    it.effect("reaches only the view's own handlers of the current generation", () =>
      withDatabase(
        Effect.gen(function* () {
          const { catalog, views } = yield* startViews(yield* Scope.Scope);
          const installation = yield* install(catalog, BOARD_FIXTURE);
          const target = {
            installationId: installation.installationId,
            generation: installation.generation,
            viewId: "board",
          };

          const echoed = yield* views.call({ ...target, handler: "echo", input: { n: 1 } });
          expect(echoed).toEqual({ value: { echo: { n: 1 } } });
          // `ping` exists, but not under the view's prefix.
          const foreign = yield* views
            .call({ ...target, handler: "ping", input: null })
            .pipe(Effect.flip);
          expect(foreign.reason).toBe("call-failed");
          const big = yield* views
            .call({ ...target, handler: "big", input: null })
            .pipe(Effect.flip);
          expect(big.reason).toBe("too-large");
          const tooLarge = yield* views
            .call({ ...target, handler: "echo", input: "x".repeat(70 * 1024) })
            .pipe(Effect.flip);
          expect(tooLarge.reason).toBe("too-large");
          const stale = yield* views
            .call({ ...target, generation: target.generation + 1, handler: "echo", input: null })
            .pipe(Effect.flip);
          expect(stale.reason).toBe("generation-changed");

          // A call in flight when the plugin is disabled fails instead of answering later.
          const hanging = yield* views
            .call({ ...target, handler: "hang", input: null })
            .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
          yield* catalog.subscribe.pipe(
            Stream.filter((snapshot) =>
              snapshot.installations.some((row) => row.hostState?._tag === "running"),
            ),
            Stream.runHead,
          );
          yield* catalog.disable({ installationId: installation.installationId });
          const revoked = yield* Fiber.join(hanging);
          expect(revoked.reason).toBe("unavailable");
          const after = yield* views
            .call({ ...target, handler: "echo", input: null })
            .pipe(Effect.flip);
          expect(after.reason).toBe("unavailable");
        }),
      ),
    );
  });
});
