import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsError,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import type { DeepPartial } from "@t3tools/shared/Struct";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "../provider/testUtils/providerRegistryMock.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import * as AgentSessionAutoImporter from "./AgentSessionAutoImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

const NOW_MS = Date.parse("2026-08-24T12:00:00.000Z");
const encodeTranscriptRecord = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const makeTempDir = Effect.fn("AgentSessionAutoImporter.test.makeTempDir")(function* (
  prefix: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTranscript = Effect.fn("AgentSessionAutoImporter.test.writeTranscript")(
  function* (input: {
    readonly filePath: string;
    readonly contents: string;
    /** Epoch millis, so ordering assertions never depend on write timing. */
    readonly mtimeMs: number;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.dirname(input.filePath), { recursive: true });
    yield* fileSystem.writeFileString(input.filePath, input.contents);
    // Numeric utimes arguments are seconds, not milliseconds.
    const seconds = input.mtimeMs / 1000;
    yield* fileSystem.utimes(input.filePath, seconds, seconds);
  },
);

/** Codex rollout with one user prompt and one assistant reply. */
const codexTranscript = (input: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly reply: string;
}) =>
  [
    encodeTranscriptRecord({
      type: "session_meta",
      payload: { id: input.sessionId, cwd: input.cwd },
    }),
    encodeTranscriptRecord({
      type: "event_msg",
      timestamp: "2026-08-24T10:00:00.000Z",
      payload: { type: "user_message", message: input.prompt },
    }),
    encodeTranscriptRecord({
      type: "response_item",
      timestamp: "2026-08-24T10:01:00.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: input.reply }],
      },
    }),
  ].join("\n");

const setupCodexFixture = Effect.fn("AgentSessionAutoImporter.test.setupCodexFixture")(
  function* (input: {
    readonly workspaces: ReadonlyArray<{
      readonly name: string;
      readonly sessionId: string;
      readonly prompt: string;
      readonly reply: string;
    }>;
  }) {
    const path = yield* Path.Path;
    yield* TestClock.setTime(NOW_MS);
    const claudeHome = yield* makeTempDir("t3-auto-import-claude-");
    const codexHome = yield* makeTempDir("t3-auto-import-codex-");
    const roots: Array<string> = [];
    let index = 0;
    for (const workspace of input.workspaces) {
      const root = yield* makeTempDir(`t3-auto-import-workspace-${workspace.name}-`);
      roots.push(root);
      yield* writeTranscript({
        filePath: path.join(
          codexHome,
          "sessions",
          "2026",
          "08",
          "24",
          `rollout-${workspace.sessionId}.jsonl`,
        ),
        contents: codexTranscript({
          sessionId: workspace.sessionId,
          cwd: root,
          prompt: workspace.prompt,
          reply: workspace.reply,
        }),
        mtimeMs: NOW_MS - (index + 1) * 60 * 60 * 1000,
      });
      index += 1;
    }
    return { claudeHome, codexHome, roots };
  },
);

const settingsWithHomes = (
  homes: { readonly claudeHome: string; readonly codexHome: string },
  agentSessionAutoImport: boolean,
) =>
  ServerSettingsService.layerTest({
    agentSessionAutoImport,
    agentSessionImportWindow: "all",
    providers: {
      claudeAgent: { homePath: homes.claudeHome },
      codex: { homePath: homes.codexHome },
    },
  });

const makeSettingsOverride = (overrides: DeepPartial<ServerSettings>) =>
  ServerSettingsService.layerTest(overrides);

const makeHarnessLayer = <E, R>(input: {
  readonly settings: Layer.Layer<ServerSettingsService, ServerSettingsError, never>;
  readonly providerStream: Stream.Stream<ReadonlyArray<ServerProvider>>;
  readonly scannerOverride: Layer.Layer<AgentSessionScanner.AgentSessionScanner, E, R>;
}) => {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-auto-import-test-",
  });
  const runtimeRepository = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const providerRegistryLayer = Layer.succeed(ProviderRegistry.ProviderRegistry, {
    ...makeProviderRegistryMock(),
    streamChanges: input.providerStream,
  });
  const base = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
    runtimeRepository,
    ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepository)),
    input.settings,
    providerRegistryLayer,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  // The scanner (real or stub) reads its requirements from the base layer;
  // the importer then reads everything, including the scanner, from that.
  const withScanner = input.scannerOverride.pipe(Layer.provideMerge(base));
  return AgentSessionAutoImporter.layer.pipe(Layer.provideMerge(withScanner));
};

const realScanner = () => Layer.fresh(AgentSessionScanner.layer);

const makeProviderSnapshot = (
  instanceId: string,
  authStatus: "authenticated" | "unauthenticated",
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: authStatus },
  checkedAt: "2026-08-24T12:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

it.layer(NodeServices.layer)("AgentSessionAutoImporter", (it) => {
  describe("background auto-import", () => {
    it.effect("creates one project per discovered cwd and imports settled threads", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* setupCodexFixture({
            workspaces: [
              { name: "one", sessionId: "session-one", prompt: "Prompt one", reply: "Reply one" },
              { name: "two", sessionId: "session-two", prompt: "Prompt two", reply: "Reply two" },
            ],
          });
          const settings = settingsWithHomes(fixture, true);
          const context = yield* Layer.build(
            makeHarnessLayer({
              settings,
              providerStream: Stream.empty,
              scannerOverride: realScanner(),
            }),
          );
          const importer = Context.get(context, AgentSessionAutoImporter.AgentSessionAutoImporter);
          const snapshots = Context.get(context, ProjectionSnapshotQuery.ProjectionSnapshotQuery);

          yield* importer.runNow;
          yield* importer.drain;

          const status = yield* importer.status;
          expect(status).toMatchObject({
            state: "completed",
            projectsCreated: 2,
            threadsImported: 2,
            threadsSkipped: 0,
            error: null,
          });
          expect(status.startedAt).not.toBeNull();
          expect(status.finishedAt).not.toBeNull();

          const shell = yield* snapshots.getShellSnapshot();
          expect(shell.projects).toHaveLength(2);
          expect(
            new Set(
              shell.projects.map((project) =>
                normalizeProjectPathForComparison(project.workspaceRoot),
              ),
            ),
          ).toEqual(new Set(fixture.roots.map((root) => normalizeProjectPathForComparison(root))));
          const histories: Array<string> = [];
          for (const project of shell.projects) {
            const sources = yield* snapshots.getImportedAgentSessionSources(project.id);
            expect(sources).toHaveLength(1);
            const thread = Option.getOrThrow(
              yield* snapshots.getThreadDetailById(sources[0]!.threadId),
            );
            expect(thread.settledOverride).toBe("settled");
            histories.push(thread.messages.map((message) => message.text).join("\n"));
          }
          expect(new Set(histories)).toEqual(
            new Set(["Prompt one\nReply one", "Prompt two\nReply two"]),
          );
        }),
      ),
    );

    it.effect("counts a drained backlog once instead of once per pass", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fixture = yield* setupCodexFixture({
            workspaces: [
              { name: "one", sessionId: "session-one", prompt: "Prompt one", reply: "Reply one" },
            ],
          });
          const root = fixture.roots[0]!;
          // A second transcript in the same workspace, so one project has a
          // backlog that takes more than one pass to drain.
          yield* writeTranscript({
            filePath: path.join(
              fixture.codexHome,
              "sessions",
              "2026",
              "08",
              "24",
              "rollout-session-two.jsonl",
            ),
            contents: codexTranscript({
              sessionId: "session-two",
              cwd: root,
              prompt: "Prompt two",
              reply: "Reply two",
            }),
            mtimeMs: NOW_MS - 2 * 60 * 60 * 1000,
          });
          const settings = settingsWithHomes(fixture, true);
          const passes = yield* Ref.make(0);
          // Force the first pass to stop on a budget skip after one thread, so
          // the drain loop runs again and re-observes the first thread as
          // already imported.
          const scanner = Layer.effect(
            AgentSessionScanner.AgentSessionScanner,
            Effect.gen(function* () {
              const real = yield* AgentSessionScanner.AgentSessionScanner;
              return AgentSessionScanner.AgentSessionScanner.of({
                scan: real.scan,
                recentThreads: (workspaceRoot, completedSources, options) =>
                  Stream.unwrap(
                    Ref.getAndUpdate(passes, (count) => count + 1).pipe(
                      Effect.map((pass) => {
                        const stream = real.recentThreads(
                          workspaceRoot,
                          completedSources,
                          options,
                        );
                        return pass === 0
                          ? Stream.concat(
                              Stream.take(stream, 1),
                              Stream.make({ _tag: "Skipped", reason: "budget" } as const),
                            )
                          : stream;
                      }),
                    ),
                  ),
              });
            }),
          ).pipe(Layer.provide(Layer.fresh(AgentSessionScanner.layer)));
          const context = yield* Layer.build(
            makeHarnessLayer({ settings, providerStream: Stream.empty, scannerOverride: scanner }),
          );
          const importer = Context.get(context, AgentSessionAutoImporter.AgentSessionAutoImporter);
          const snapshots = Context.get(context, ProjectionSnapshotQuery.ProjectionSnapshotQuery);

          yield* importer.runNow;
          yield* importer.drain;

          expect(yield* Ref.get(passes)).toBeGreaterThan(1);
          const shell = yield* snapshots.getShellSnapshot();
          expect(shell.projects).toHaveLength(1);
          const sources = yield* snapshots.getImportedAgentSessionSources(shell.projects[0]!.id);
          expect(sources).toHaveLength(2);
          // The two threads really on disk, not the sum over passes.
          expect(yield* importer.status).toMatchObject({
            state: "completed",
            threadsImported: 2,
          });
        }),
      ),
    );

    it.effect("reuses an existing project for a discovered cwd", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* setupCodexFixture({
            workspaces: [
              { name: "one", sessionId: "session-one", prompt: "Prompt one", reply: "Reply one" },
            ],
          });
          const settings = settingsWithHomes(fixture, true);
          const context = yield* Layer.build(
            makeHarnessLayer({
              settings,
              providerStream: Stream.empty,
              scannerOverride: realScanner(),
            }),
          );
          const importer = Context.get(context, AgentSessionAutoImporter.AgentSessionAutoImporter);
          const snapshots = Context.get(context, ProjectionSnapshotQuery.ProjectionSnapshotQuery);

          yield* importer.runNow;
          yield* importer.drain;
          expect(yield* importer.status).toMatchObject({
            state: "completed",
            projectsCreated: 1,
            threadsImported: 1,
          });

          // The second run sees the first run's project in the shell snapshot
          // and reuses it instead of creating a duplicate.
          yield* importer.runNow;
          yield* importer.drain;
          expect(yield* importer.status).toMatchObject({
            state: "completed",
            projectsCreated: 0,
          });
          const shell = yield* snapshots.getShellSnapshot();
          expect(shell.projects).toHaveLength(1);
          expect(normalizeProjectPathForComparison(shell.projects[0]!.workspaceRoot)).toBe(
            normalizeProjectPathForComparison(fixture.roots[0]!),
          );
          // The thread is not duplicated either: still exactly one source.
          expect(
            yield* snapshots.getImportedAgentSessionSources(shell.projects[0]!.id),
          ).toHaveLength(1);
        }),
      ),
    );

    it.effect("does nothing on startup when the toggle is off but runNow still imports", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* setupCodexFixture({
            workspaces: [
              { name: "one", sessionId: "session-one", prompt: "Prompt one", reply: "Reply one" },
            ],
          });
          const settingsReads = yield* Queue.unbounded<void>();
          const scanCount = yield* Ref.make(0);
          const settings = Layer.effect(
            ServerSettingsService,
            Effect.gen(function* () {
              const base = yield* ServerSettingsService;
              return ServerSettingsService.of({
                ...base,
                getSettings: Queue.offer(settingsReads, undefined).pipe(
                  Effect.andThen(base.getSettings),
                ),
              });
            }),
          ).pipe(Layer.provide(settingsWithHomes(fixture, false)));
          const scanner = Layer.effect(
            AgentSessionScanner.AgentSessionScanner,
            Effect.gen(function* () {
              const real = yield* AgentSessionScanner.AgentSessionScanner;
              return AgentSessionScanner.AgentSessionScanner.of({
                scan: Ref.update(scanCount, (count) => count + 1).pipe(Effect.andThen(real.scan)),
                recentThreads: (workspaceRoot, completedSources, options) =>
                  real.recentThreads(workspaceRoot, completedSources, options),
              });
            }),
          ).pipe(Layer.provide(Layer.fresh(AgentSessionScanner.layer)));
          const context = yield* Layer.build(
            makeHarnessLayer({ settings, providerStream: Stream.empty, scannerOverride: scanner }),
          );
          const importer = Context.get(context, AgentSessionAutoImporter.AgentSessionAutoImporter);

          yield* importer.start();
          // start() reads settings once itself; the parked startup fiber reads
          // them a second time. Waiting for both proves the startup trigger
          // ran to completion, and with the toggle off it cannot enqueue.
          yield* Queue.take(settingsReads);
          yield* Queue.take(settingsReads);
          yield* importer.drain;
          expect(yield* importer.status).toMatchObject({ state: "idle" });
          expect(yield* Ref.get(scanCount)).toBe(0);

          yield* importer.runNow;
          yield* importer.drain;
          expect(yield* importer.status).toMatchObject({
            state: "completed",
            projectsCreated: 1,
            threadsImported: 1,
          });
          expect(yield* Ref.get(scanCount)).toBe(1);
        }),
      ),
    );

    it.effect("triggers exactly one run for a burst of provider snapshots", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const scans = yield* Queue.unbounded<void>();
          const scanner = Layer.succeed(
            AgentSessionScanner.AgentSessionScanner,
            AgentSessionScanner.AgentSessionScanner.of({
              scan: Queue.offer(scans, undefined).pipe(
                Effect.as({ candidates: [], scannedAt: "2026-08-24T12:00:00.000Z" }),
              ),
              recentThreads: () => Stream.empty,
            }),
          );
          const providerSnapshots = yield* SubscriptionRef.make<ReadonlyArray<ServerProvider>>([]);
          const context = yield* Layer.build(
            makeHarnessLayer({
              settings: makeSettingsOverride({}),
              providerStream: SubscriptionRef.changes(providerSnapshots),
              scannerOverride: scanner,
            }),
          );
          const importer = Context.get(context, AgentSessionAutoImporter.AgentSessionAutoImporter);

          yield* importer.start();
          yield* importer.drain;
          // The startup run fires because the toggle defaults on.
          yield* Queue.take(scans);

          // A burst of three distinct snapshots with no clock movement
          // between them; the 2s debounce must coalesce them into one run.
          // SubscriptionRef replays current state on subscribe, so late
          // subscription still observes the burst as a single latest value.
          yield* SubscriptionRef.set(providerSnapshots, [
            makeProviderSnapshot("codex-1", "unauthenticated"),
          ]);
          yield* SubscriptionRef.set(providerSnapshots, [
            makeProviderSnapshot("codex-1", "authenticated"),
          ]);
          yield* SubscriptionRef.set(providerSnapshots, [
            makeProviderSnapshot("codex-1", "authenticated"),
            makeProviderSnapshot("codex-2", "authenticated"),
          ]);
          yield* TestClock.adjust(Duration.seconds(3));
          yield* Queue.take(scans);
          yield* importer.drain;
          expect(yield* Queue.size(scans)).toBe(0);
          expect(yield* importer.status).toMatchObject({
            state: "completed",
            projectsCreated: 0,
            threadsImported: 0,
            error: null,
          });
          // No straggler debounce emission may produce a second run.
          yield* TestClock.adjust(Duration.seconds(10));
          expect(yield* Queue.size(scans)).toBe(0);
        }),
      ),
    );

    it.effect("coalesces triggers during a run into exactly one follow-up run", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const scanCount = yield* Ref.make(0);
          const firstScanStarted = yield* Deferred.make<void>();
          const releaseFirstScan = yield* Deferred.make<void>();
          const scanner = Layer.succeed(
            AgentSessionScanner.AgentSessionScanner,
            AgentSessionScanner.AgentSessionScanner.of({
              scan: Effect.gen(function* () {
                const count = yield* Ref.updateAndGet(scanCount, (count) => count + 1);
                if (count === 1) {
                  yield* Deferred.succeed(firstScanStarted, undefined);
                  yield* Deferred.await(releaseFirstScan);
                }
                return { candidates: [], scannedAt: "2026-08-24T12:00:00.000Z" };
              }),
              recentThreads: () => Stream.empty,
            }),
          );
          const context = yield* Layer.build(
            makeHarnessLayer({
              settings: makeSettingsOverride({}),
              providerStream: Stream.empty,
              scannerOverride: scanner,
            }),
          );
          const importer = Context.get(context, AgentSessionAutoImporter.AgentSessionAutoImporter);

          yield* importer.runNow;
          yield* Deferred.await(firstScanStarted);
          // Both triggers land while the first run is still scanning, so the
          // worker must coalesce them into a single follow-up run.
          yield* importer.runNow;
          yield* importer.runNow;
          yield* Deferred.succeed(releaseFirstScan, undefined);
          yield* importer.drain;
          expect(yield* Ref.get(scanCount)).toBe(2);
          expect(yield* importer.status).toMatchObject({ state: "completed" });
        }),
      ),
    );
  });
});
