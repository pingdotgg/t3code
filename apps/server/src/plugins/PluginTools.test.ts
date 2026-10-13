import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PLUGIN_TOOL_LIMITS,
  PluginInstallation,
  ThreadId,
  type PluginToolDeclaration,
  type PluginToolError,
  type PluginToolsListResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PluginCatalog from "./PluginCatalog.ts";
import * as PluginSupervisor from "./PluginSupervisor.ts";
import { jsonBytes } from "./pluginToolDeclarations.ts";
import * as PluginTools from "./PluginTools.ts";

// Children run the real CLI entry, which routes `__plugin-host` to the child runtime.
const BIN_PATH = `${import.meta.dirname}/../bin.ts`;
const FIXTURE = `${import.meta.dirname}/testFixtures/toolsPlugin`;

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const context = {
  environmentId: EnvironmentId.make("environment-tools"),
  threadId: ThreadId.make("thread-tools"),
};

/** A real supervisor, catalogue, and tool service in `scope`, as one server start would run them. */
const start = Effect.fn("start")(function* (scope: Scope.Scope) {
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
  const tools = yield* PluginTools.make.pipe(
    Effect.provideService(PluginCatalog.PluginCatalog, catalog),
  );
  /** Adds, approves, and enables a plugin directory. */
  const install = Effect.fn("install")(function* (directory: string) {
    const { installation } = yield* catalog.add({ directory });
    const installationId = installation.installationId;
    yield* catalog.consent({ installationId, digest: installation.source!.digest });
    return (yield* catalog.enable({ installationId })).installation;
  });
  return { supervisor, catalog, tools, install };
});

/** A scoped copy of the committed fixture, so tests never share a plugin directory. */
const copyFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(
    yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-tools-" }),
    "plugin",
  );
  yield* fs.copy(FIXTURE, directory);
  return directory;
});

/** A scoped tool plugin that declares `tools` and answers every call with "pong". */
const declaringPlugin = Effect.fn("declaringPlugin")(function* (
  id: string,
  tools: ReadonlyArray<Record<string, unknown>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(
    yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-tools-" }),
    "plugin",
  );
  yield* fs.makeDirectory(directory);
  yield* fs.writeFileString(
    path.join(directory, "main.mjs"),
    [
      `export function activate(context) {`,
      ...tools.map((tool) => `  context.proposed.handle("t3.tool.${tool.name}", () => "pong");`),
      `}`,
      ``,
    ].join("\n"),
  );
  yield* fs.writeFileString(
    path.join(directory, "t3-plugin.json"),
    toJson({
      id,
      name: id,
      version: "1.0.0",
      apiVersion: 1,
      entry: "main.mjs",
      capabilities: ["tools"],
      proposedApi: true,
      tools,
    }),
  );
  return directory;
});

const tool = (name: string, description: string) => ({
  name,
  description,
  inputSchema: { type: "object", additionalProperties: false },
  sideEffect: "read",
});

const reasonOf = (error: PluginToolError) => error.reason;

const withDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(SqlitePersistence.layerMemory));

const DIGEST = `sha256:${"0".repeat(64)}`;
const decodeInstallation = Schema.decodeUnknownSync(PluginInstallation);

/**
 * An in-memory catalogue of `count` enabled one-tool plugins. It records which
 * plugins had their declarations read and how often the catalogue was listed.
 */
const inventory = (count: number) => {
  const prepared = new Set<string>();
  const counts = { lists: 0, revision: 0 };
  const rows = Array.from({ length: count }, (_, index) => {
    const id = `test.p${String(index).padStart(4, "0")}`;
    const row = decodeInstallation({
      installationId: `installation-${index}`,
      generation: 1,
      directory: `/plugins/${id}`,
      manifest: { id, name: id, version: "1.0.0", capabilities: ["tools"], proposedApi: true },
      source: { digest: DIGEST, files: 1, bytes: 1 },
      problem: null,
      inspectedAt: "2026-01-01T00:00:00.000Z",
      consent: { digest: DIGEST, capabilities: ["tools"], grantedAt: "2026-01-01T00:00:00.000Z" },
      enabled: true,
      addedAt: "2026-01-01T00:00:00.000Z",
    });
    const declaration: PluginToolDeclaration = {
      name: "ping",
      description: "x".repeat(1_500),
      sideEffect: "read",
      openWorld: false,
      get inputSchema() {
        prepared.add(id);
        return { type: "object", additionalProperties: false };
      },
    };
    return { ...row, manifest: { ...row.manifest!, tools: [declaration] } };
  });
  const unused = () => Effect.die("not used by PluginTools");
  const catalog = PluginCatalog.PluginCatalog.of({
    list: Effect.sync(() => {
      counts.lists++;
      return { installations: rows };
    }),
    revision: Effect.sync(() => counts.revision),
    subscribe: Stream.empty,
    add: unused,
    refresh: unused,
    consent: unused,
    enable: unused,
    disable: unused,
    remove: unused,
    resume: unused,
    invoke: () => Effect.succeed("pong"),
  });
  return { rows, prepared, counts, catalog };
};

it.layer(NodeServices.layer)("PluginTools", (it) => {
  describe("granted plugins", () => {
    it.effect("lists declared tools without starting the plugin and calls them in context", () =>
      withDatabase(
        Effect.gen(function* () {
          const { catalog, tools, install } = yield* start(yield* Scope.Scope);
          const installation = yield* install(yield* copyFixture);
          const grants = yield* tools.grants;
          expect(grants).toEqual([{ installationId: installation.installationId, generation: 1 }]);

          const listed = yield* tools.list(grants);
          expect(listed.tools.map((tool) => tool.tool)).toEqual([
            "test.tools/word_count",
            "test.tools/echo_context",
            "test.tools/wait_for_cancel",
            "test.tools/big_result",
          ]);
          expect(listed.tools[0]).toMatchObject({
            tool: "test.tools/word_count",
            plugin: { id: "test.tools", name: "Tools fixture" },
            title: "Count words",
            description: "Count the words in a text.",
            // Exactly what the manifest declares.
            inputSchema: {
              type: "object",
              properties: { text: { type: "string", maxLength: 10000 } },
              required: ["text"],
              additionalProperties: false,
            },
            sideEffect: "read",
            openWorld: false,
          });
          expect(listed.tools[2]).toMatchObject({ sideEffect: "write", openWorld: true });
          expect(listed).not.toHaveProperty("nextCursor");
          expect(listed.notInThisSession).toEqual([]);
          const hostState = Effect.map(
            catalog.list,
            (snapshot) => snapshot.installations[0]?.hostState,
          );
          // Listing reads the consented manifest; only a call starts the plugin.
          expect(yield* hostState).toEqual({ _tag: "idle" });

          const call = (tool: string, input: unknown) =>
            tools.call(grants, { tool, input, context });
          expect(yield* call("test.tools/word_count", { text: "one two  three" })).toEqual({
            words: 3,
          });
          expect((yield* hostState)?._tag).toBe("running");
          // The context comes from the session, never from the input.
          expect(yield* call("test.tools/echo_context", {})).toEqual({ input: {}, context });

          const failures = yield* Effect.forEach(
            [
              ["test.tools/word_count", { text: 5 }],
              ["test.tools/word_count", {}],
              ["test.tools/word_count", { text: "x".repeat(10_001) }],
              ["test.tools/word_count", { text: "closed", extra: 1 }],
              ["test.tools/echo_context", { context: { threadId: "other" } }],
              ["test.tools/nope", {}],
              ["word_count", {}],
              ["test.tools/big_result", { length: 70_000 }],
            ] as const,
            ([tool, input]) => call(tool, input).pipe(Effect.flip, Effect.map(reasonOf)),
          );
          expect(failures).toEqual([
            "invalid-input",
            "invalid-input",
            "invalid-input",
            "invalid-input",
            "invalid-input",
            "unknown-tool",
            "unknown-tool",
            "result-too-large",
          ]);
        }),
      ),
    );

    it.effect("refuses a disabled plugin at once, also mid-call, and its next registration", () =>
      withDatabase(
        Effect.gen(function* () {
          const { supervisor, catalog, tools, install } = yield* start(yield* Scope.Scope);
          const installation = yield* install(yield* copyFixture);
          const installationId = installation.installationId;
          const grants = yield* tools.grants;
          const events = yield* supervisor.subscribe;

          const waiting = yield* tools
            .call(grants, { tool: "test.tools/wait_for_cancel", input: {}, context })
            .pipe(Effect.flip, Effect.forkChild);
          yield* Stream.fromSubscription(events).pipe(
            Stream.filter((event) => event._tag === "Log" && event.message === "wait-started"),
            Stream.runHead,
          );
          yield* catalog.disable({ installationId });
          const revoked = yield* Fiber.join(waiting);
          expect(revoked.reason).toBe("unavailable");

          expect(yield* tools.list(grants)).toEqual({ tools: [], notInThisSession: [] });
          const disabled = yield* tools
            .call(grants, { tool: "test.tools/word_count", input: { text: "a" }, context })
            .pipe(Effect.flip);
          expect(disabled.reason).toBe("unavailable");

          // A re-enable is a new registration: the old session's grant does not reach it.
          yield* catalog.enable({ installationId });
          const stale = yield* tools.list(grants);
          expect(stale.tools).toEqual([]);
          expect(stale.notInThisSession).toEqual([{ id: "test.tools", name: "Tools fixture" }]);
          const notGranted = yield* tools
            .call(grants, { tool: "test.tools/word_count", input: { text: "a" }, context })
            .pipe(Effect.flip);
          expect(notGranted.reason).toBe("not-granted");
          const fresh = yield* tools.grants;
          expect(fresh).toEqual([{ installationId, generation: 2 }]);
          expect(
            yield* tools.call(fresh, {
              tool: "test.tools/word_count",
              input: { text: "a b" },
              context,
            }),
          ).toEqual({ words: 2 });
        }),
      ),
    );
    it.effect("refuses a plugin once the catalogue finds its files changed", () =>
      withDatabase(
        Effect.gen(function* () {
          const { supervisor, catalog, tools, install } = yield* start(yield* Scope.Scope);
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* copyFixture;
          const edit = (note: string) =>
            fs.writeFileString(`${directory}/main.mjs`, `// ${note}\n`, { flag: "a" });
          const { installationId } = yield* install(directory);

          // Idle: the bytes are checked before a call would start a process.
          const grants = yield* tools.grants;
          yield* edit("changed while idle");
          const idle = yield* tools
            .call(grants, { tool: "test.tools/word_count", input: { text: "a" }, context })
            .pipe(Effect.flip);
          expect(idle.reason).toBe("unavailable");
          expect(yield* tools.list(grants)).toEqual({ tools: [], notInThisSession: [] });

          // Running: a refresh finds the change and cancels the call in flight.
          const [changed] = (yield* catalog.list).installations;
          yield* catalog.consent({ installationId, digest: changed!.source!.digest });
          yield* catalog.enable({ installationId });
          const fresh = yield* tools.grants;
          const events = yield* supervisor.subscribe;
          const waiting = yield* tools
            .call(fresh, { tool: "test.tools/wait_for_cancel", input: {}, context })
            .pipe(Effect.flip, Effect.forkChild);
          yield* Stream.fromSubscription(events).pipe(
            Stream.filter((event) => event._tag === "Log" && event.message === "wait-started"),
            Stream.runHead,
          );
          yield* edit("changed while running");
          yield* catalog.refresh({ installationId });
          expect((yield* Fiber.join(waiting)).reason).toBe("unavailable");
          expect(yield* tools.list(fresh)).toEqual({ tools: [], notInThisSession: [] });
        }),
      ),
    );
  });

  describe("declarations", () => {
    it.effect("refuses a manifest whose tools the host cannot enforce when it is added", () =>
      withDatabase(
        Effect.gen(function* () {
          const { catalog } = yield* start(yield* Scope.Scope);
          const refused = (id: string, tools: ReadonlyArray<Record<string, unknown>>) =>
            declaringPlugin(id, tools).pipe(
              Effect.flatMap((directory) => catalog.add({ directory })),
              Effect.flip,
              Effect.map((error) => error.message),
            );
          expect(
            yield* refused("test.pattern", [
              {
                ...tool("ping", "Uses a pattern."),
                inputSchema: {
                  type: "object",
                  properties: { id: { type: "string", pattern: "^(a+)+$" } },
                },
              },
            ]),
          ).toContain("#/properties/id/pattern: this keyword is not supported.");
          expect(
            yield* refused("test.duplicate", [tool("ping", "One."), tool("ping", "Two.")]),
          ).toContain("it declares the tool ping twice.");
          expect(
            yield* refused("test.scalar", [
              { ...tool("ping", "Takes a string."), inputSchema: { type: "string" } },
            ]),
          ).toContain('the root must be "object"');
        }),
      ),
    );

    it.effect("pages whole plugins by id within the byte limit and starts none of them", () =>
      withDatabase(
        Effect.gen(function* () {
          const { catalog, tools, install } = yield* start(yield* Scope.Scope);
          // About 21 KB each to list, so a 64 KiB page holds two of them at most.
          const large = (id: string) =>
            declaringPlugin(
              id,
              Array.from({ length: 10 }, (_, index) => tool(`tool_${index}`, "é".repeat(1_000))),
            );
          for (const id of ["test.large-c", "test.large-a", "test.large-b"])
            yield* install(yield* large(id));
          const grants = yield* tools.grants;
          // Enabled after the snapshot: listed by name only, under notInThisSession.
          yield* install(yield* declaringPlugin("test.late", [tool("ping", "Late.")]));

          const pages: Array<PluginToolsListResult> = [];
          let cursor: string | undefined;
          do {
            const page: PluginToolsListResult = yield* tools.list(
              grants,
              cursor === undefined ? {} : { cursor },
            );
            pages.push(page);
            cursor = page.nextCursor;
          } while (cursor !== undefined);

          for (const page of pages)
            expect(jsonBytes(page)).toBeLessThanOrEqual(PLUGIN_TOOL_LIMITS.maxListBytes);
          expect(pages.length).toBeGreaterThan(1);
          const order = pages.flatMap((page) => [
            ...new Set(page.tools.map((listing) => listing.plugin.id)),
            ...page.notInThisSession.map((plugin) => `late:${plugin.id}`),
          ]);
          expect(order).toEqual(["test.large-a", "test.large-b", "test.large-c", "late:test.late"]);
          expect(pages.flatMap((page) => page.tools)).toHaveLength(30);

          const one = yield* tools.list(grants, { plugin: "test.large-b" });
          expect(one.tools).toHaveLength(10);
          expect(one).not.toHaveProperty("nextCursor");
          expect(jsonBytes(one)).toBeLessThanOrEqual(PLUGIN_TOOL_LIMITS.maxListBytes);

          const states = (yield* catalog.list).installations.map((row) => row.hostState?._tag);
          expect(states).toEqual(["idle", "idle", "idle", "idle"]);
        }),
      ),
    );

    it.effect("prepares only the plugins a page shows, however many are installed", () =>
      Effect.gen(function* () {
        const { rows, prepared, counts, catalog } = inventory(1_000);
        const tools = yield* PluginTools.make.pipe(
          Effect.provideService(PluginCatalog.PluginCatalog, catalog),
        );
        const grants = yield* tools.grants;
        expect(grants).toHaveLength(1_000);
        expect(prepared.size).toBe(0);

        const one = yield* tools.list(grants, { plugin: "test.p0500" });
        expect(one.tools.map((listing) => listing.tool)).toEqual(["test.p0500/ping"]);
        expect([...prepared]).toEqual(["test.p0500"]);

        prepared.clear();
        const first = yield* tools.list(grants);
        const shown = first.tools.map((listing) => listing.plugin.id);
        expect(first.nextCursor).toBe(shown.at(-1));
        expect(shown.length).toBeLessThan(100);
        // The page, and the one plugin after it that did not fit.
        expect([...prepared].toSorted()).toEqual(
          [...shown, `test.p${String(shown.length).padStart(4, "0")}`].toSorted(),
        );

        prepared.clear();
        const second = yield* tools.list(grants, { cursor: first.nextCursor! });
        expect(second.tools[0]?.plugin.id).toBe(`test.p${String(shown.length).padStart(4, "0")}`);
        expect(prepared.size).toBe(second.tools.length);
        expect(yield* tools.call(grants, { tool: "test.p0999/ping", input: {}, context })).toBe(
          "pong",
        );
        // Requests read the catalogue only when its records changed.
        expect(counts.lists).toBe(1);

        rows[999] = { ...rows[999]!, enabled: false };
        counts.revision++;
        const refused = yield* tools
          .call(grants, { tool: "test.p0999/ping", input: {}, context })
          .pipe(Effect.flip);
        expect(refused.reason).toBe("unavailable");
        expect((yield* tools.list(grants, { plugin: "test.p0999" })).tools).toEqual([]);
        expect(counts.lists).toBe(2);
      }),
    );
  });
});
