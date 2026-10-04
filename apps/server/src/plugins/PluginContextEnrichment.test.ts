import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  isPluginContextTurnItem,
  NodeId,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import type * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  prepareRunContext,
  type RunContextEnricherV2Shape,
  withPluginContext,
} from "../orchestration-v2/RunContextEnrichment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PluginCatalog from "./PluginCatalog.ts";
import * as PluginContextEnrichment from "./PluginContextEnrichment.ts";
import * as PluginSupervisor from "./PluginSupervisor.ts";

// Children run the real CLI entry, which routes `__plugin-host` to the child runtime.
const BIN_PATH = `${import.meta.dirname}/../bin.ts`;
const FIXTURE = `${import.meta.dirname}/testFixtures/contextPlugin`;

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fromJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const environmentId = EnvironmentId.make("environment-context");

const runInput = (text: string) => ({
  projectId: ProjectId.make("project-context"),
  threadId: ThreadId.make("thread-context"),
  runId: RunId.make("run-context"),
  cwd: "/work/context",
  message: { text, truncated: false },
});

/** A real supervisor, catalogue, and enricher in `scope`, as one server start would run them. */
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
  const enricher = yield* PluginContextEnrichment.make.pipe(
    Effect.provideService(PluginCatalog.PluginCatalog, catalog),
    Effect.provideService(
      ServerEnvironment,
      ServerEnvironment.of({ getEnvironmentId: Effect.succeed(environmentId) } as never),
    ),
  );
  /** Adds, approves, and enables a plugin directory. */
  const install = Effect.fn("install")(function* (directory: string) {
    const { installation } = yield* catalog.add({ directory });
    const installationId = installation.installationId;
    yield* catalog.consent({ installationId, digest: installation.source!.digest });
    return (yield* catalog.enable({ installationId })).installation;
  });
  return { supervisor, catalog, enricher, install };
});

/** A scoped plugin directory: the committed fixture, or that fixture with a changed manifest. */
const pluginDirectory = Effect.fn("pluginDirectory")(function* (
  manifest?: (fixture: Record<string, unknown>) => Record<string, unknown>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(
    yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-context-" }),
    "plugin",
  );
  yield* fs.copy(FIXTURE, directory);
  if (manifest !== undefined) {
    const file = path.join(directory, "t3-plugin.json");
    const fixture = fromJson(yield* fs.readFileString(file)) as Record<string, unknown>;
    yield* fs.writeFileString(file, toJson(manifest(fixture)));
  }
  return directory;
});

const withDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(SqlitePersistence.layerMemory));

/**
 * Starts one run the way the provider-turn start does, against an in-memory
 * timeline whose run stays `starting`, and returns its plugin-context records
 * and the text the provider would receive.
 */
const startRun = Effect.fn("startRun")(function* (
  enricher: RunContextEnricherV2Shape,
  name: string,
) {
  const items = new Map<string, OrchestrationV2TurnItem>();
  const eventSink = {
    writeIfRunCurrent: (input: Parameters<EventSink.EventSinkV2Shape["writeIfRunCurrent"]>[0]) =>
      Effect.sync(() => {
        for (const event of input.events)
          if (event.type === "turn-item.updated") items.set(event.payload.id, event.payload);
        return { committed: true, storedEvents: [] };
      }),
  } as unknown as EventSink.EventSinkV2Shape;
  const userText = "What is the project codename?";
  const prepared = yield* prepareRunContext({
    enricher,
    withThreadLock: (effect) => effect,
    eventSink,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    threadId: ThreadId.make("thread-context"),
    projectId: ProjectId.make("project-context"),
    runId: RunId.make(`run-${name}`),
    attemptId: RunAttemptId.make(`attempt-${name}`),
    rootNodeId: NodeId.make(`node-${name}`),
    providerThreadId: ProviderThreadId.make("provider-thread-context"),
    providerInstanceId: ProviderInstanceId.make("claude-context"),
    turnItems: [],
    userText,
    cwd: "/work/context",
  });
  return {
    records: [...items.values()].filter(isPluginContextTurnItem),
    providerText: withPluginContext(userText, prepared._tag === "ready" ? prepared.entries : []),
  };
});

it.layer(NodeServices.layer)("PluginContextEnrichment", (it) => {
  describe("sources", () => {
    it.effect("lists only enabled plugins whose consent covers a declared enrich transform", () =>
      withDatabase(
        Effect.gen(function* () {
          const { catalog, enricher, install } = yield* start(yield* Scope.Scope);
          expect(yield* enricher.sources).toEqual([]);

          const pending = yield* catalog.add({ directory: yield* pluginDirectory() });
          // Added but not consented or enabled: never called.
          expect(yield* enricher.sources).toEqual([]);
          yield* catalog.remove({ installationId: pending.installation.installationId });

          const installation = yield* install(yield* pluginDirectory());
          // The capability alone is harmless: without the declaration nothing is called.
          yield* install(
            yield* pluginDirectory(({ transforms: _transforms, ...fixture }) => ({
              ...fixture,
              id: "test.capability-only",
            })),
          );
          expect(yield* enricher.sources).toEqual([
            {
              installationId: installation.installationId,
              generation: installation.generation,
              pluginId: "test.context",
              name: "Context fixture",
              timeoutSeconds: 2,
            },
          ]);

          yield* catalog.disable({ installationId: installation.installationId });
          expect(yield* enricher.sources).toEqual([]);
        }),
      ),
    );

    it.effect("refuses a manifest that declares transforms without what they need", () =>
      withDatabase(
        Effect.gen(function* () {
          const { catalog } = yield* start(yield* Scope.Scope);
          const refused = (change: (fixture: Record<string, unknown>) => Record<string, unknown>) =>
            pluginDirectory(change).pipe(
              Effect.flatMap((directory) => catalog.add({ directory })),
              Effect.flip,
              Effect.map((error) => error.message),
            );
          expect(yield* refused((fixture) => ({ ...fixture, capabilities: [] }))).toContain(
            "it declares transforms without the transforms capability.",
          );
          expect(yield* refused((fixture) => ({ ...fixture, proposedApi: false }))).toContain(
            "it declares transforms, which need proposedApi: true.",
          );
          expect(
            yield* refused((fixture) => ({
              ...fixture,
              transforms: { enrich: { timeoutSeconds: 11 } },
            })),
          ).toContain("t3-plugin.json is invalid");
        }),
      ),
    );
  });

  describe("enrich", () => {
    it.effect("passes the run to the plugin and returns its context", () =>
      withDatabase(
        Effect.gen(function* () {
          const { enricher, install } = yield* start(yield* Scope.Scope);
          yield* install(yield* pluginDirectory());
          const [source] = yield* enricher.sources;

          expect(yield* enricher.enrich(source!, runInput("Which codename?"))).toEqual({
            _tag: "added",
            context: [
              { title: "Project codename", text: "The project codename is PERIWINKLE-42." },
            ],
          });
          const echoed = yield* enricher.enrich(source!, runInput("[echo]"));
          expect(echoed._tag).toBe("added");
          expect(fromJson(echoed._tag === "added" ? echoed.context[0]!.text : "null")).toEqual({
            environmentId,
            ...runInput("[echo]"),
          });
          expect(yield* enricher.enrich(source!, runInput("[none]"))).toEqual({
            _tag: "added",
            context: [],
          });
        }),
      ),
    );

    it.effect("fails open on an error or an answer outside the bounds", () =>
      withDatabase(
        Effect.gen(function* () {
          const { enricher, install } = yield* start(yield* Scope.Scope);
          yield* install(yield* pluginDirectory());
          const [source] = yield* enricher.sources;
          const reasonOf = (text: string) =>
            enricher
              .enrich(source!, runInput(text))
              .pipe(Effect.map((outcome) => (outcome._tag === "skipped" ? outcome.reason : "")));

          expect(yield* reasonOf("[fail]")).toContain("the notes index is offline");
          expect(yield* reasonOf("[bad]")).toContain(
            "Context fixture answered with context outside the allowed shape",
          );
          expect(yield* reasonOf("[big]")).toBe(
            "Context fixture answered with more than 8 KiB of context.",
          );
          // The plugin keeps answering after each refusal.
          expect((yield* enricher.enrich(source!, runInput("ok")))._tag).toBe("added");
        }),
      ),
    );

    it.effect("gives up at the declared deadline and when the plugin is disabled mid-call", () =>
      withDatabase(
        Effect.gen(function* () {
          const { supervisor, catalog, enricher, install } = yield* start(yield* Scope.Scope);
          const installation = yield* install(yield* pluginDirectory());
          const [source] = yield* enricher.sources;
          const events = yield* supervisor.subscribe;
          const waitStarted = Stream.fromSubscription(events).pipe(
            Stream.filter((event) => event._tag === "Log" && event.message === "wait-started"),
            Stream.runHead,
          );

          const slow = yield* enricher
            .enrich(source!, runInput("[wait]"))
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* waitStarted;
          yield* TestClock.adjust("2 seconds");
          expect(yield* Fiber.join(slow)).toEqual({
            _tag: "skipped",
            reason: "Context fixture did not answer within 2 seconds.",
          });

          const revoked = yield* enricher
            .enrich(source!, runInput("[wait]"))
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* waitStarted;
          yield* catalog.disable({ installationId: installation.installationId });
          expect(yield* Fiber.join(revoked)).toEqual({
            _tag: "skipped",
            reason: "Plugin test.context was stopped before the call finished.",
          });
          // Later runs do not call it at all.
          expect(yield* enricher.sources).toEqual([]);
          // A call pinned to the revoked registration is refused before it reaches a process.
          yield* catalog.enable({ installationId: installation.installationId });
          expect(yield* enricher.enrich(source!, runInput("ok"))).toEqual({
            _tag: "skipped",
            reason: "The plugin was enabled again since this call was prepared.",
          });
        }),
      ),
    );
  });

  describe("runs", () => {
    it.effect("adds context from four plugins and records that a fifth was not called", () =>
      withDatabase(
        Effect.gen(function* () {
          const { catalog, enricher, install } = yield* start(yield* Scope.Scope);
          for (const index of [1, 2, 3, 4, 5])
            yield* install(
              yield* pluginDirectory((fixture) => ({
                ...fixture,
                id: `test.context-${index}`,
                name: `Context ${index}`,
              })),
            );
          const inOrder = (yield* catalog.list).installations.map(
            (installation) => installation.manifest!.name,
          );

          const run = yield* startRun(enricher, "five");
          expect(run.records.map((record) => [record.status, record.title])).toEqual([
            ...inOrder.slice(0, 4).map((name) => ["completed", `Added context from ${name}`]),
            ["failed", "Context from 1 more plugin not added"],
          ]);
          expect(run.records.at(-1)?.output).toEqual({
            reason: "At most 4 plugins add context to one run; 1 more was not called.",
          });
          // The provider receives the four answers, in catalogue order, ahead of the text.
          expect(run.providerText.match(/<plugin-context plugin="[^"]+"/g)).toEqual(
            (yield* enricher.sources)
              .slice(0, 4)
              .map((source) => `<plugin-context plugin="${source.pluginId}"`),
          );
          expect(run.providerText.endsWith("\n\nWhat is the project codename?")).toBe(true);
        }).pipe(Effect.provide(IdAllocator.layer)),
      ),
    );

    it.effect("stops adding context while the plugin is disabled and resumes once enabled", () =>
      withDatabase(
        Effect.gen(function* () {
          const { catalog, enricher, install } = yield* start(yield* Scope.Scope);
          const installation = yield* install(yield* pluginDirectory());
          const { installationId } = installation;
          const generationOf = (record: OrchestrationV2TurnItem | undefined) =>
            record?.type === "dynamic_tool"
              ? (record.input as { plugin: { generation: number } }).plugin.generation
              : null;

          const before = yield* startRun(enricher, "before");
          expect(before.records.map((record) => record.title)).toEqual([
            "Added context from Context fixture",
          ]);
          expect(generationOf(before.records[0])).toBe(installation.generation);

          yield* catalog.disable({ installationId });
          const disabled = yield* startRun(enricher, "disabled");
          expect(disabled.records).toEqual([]);
          expect(disabled.providerText).toBe("What is the project codename?");

          const enabled = (yield* catalog.enable({ installationId })).installation;
          const after = yield* startRun(enricher, "after");
          expect(after.records.map((record) => record.title)).toEqual([
            "Added context from Context fixture",
          ]);
          expect(generationOf(after.records[0])).toBe(enabled.generation);
          expect(enabled.generation).toBeGreaterThan(installation.generation);
          expect(after.providerText).toContain("The project codename is PERIWINKLE-42.");
        }).pipe(Effect.provide(IdAllocator.layer)),
      ),
    );
  });
});
