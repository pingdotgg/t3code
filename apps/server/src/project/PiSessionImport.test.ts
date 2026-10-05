import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { OrchestrationV2EventSinkLayerLive } from "../orchestration-v2/runtimeLayer.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("pi-import-project");
const piInstance = ProviderInstanceId.make("pi");
const timestamp = "2026-01-01T10:00:00.000Z";
const header = {
  type: "session",
  version: 3,
  id: "pi-session-uuid",
  cwd: "/workspace/pi",
  timestamp,
};
const message = (id: string, parentId: string | null, role: string, text: string) => ({
  type: "message",
  id,
  parentId,
  timestamp,
  message: { role, content: [{ type: "text", text }] },
});
const records = [
  header,
  {
    type: "model_change",
    id: "model",
    parentId: null,
    provider: "anthropic",
    modelId: "claude-sonnet",
    timestamp,
  },
  message("user", "model", "user", "Remember PI-CANARY-4413"),
  message("old-answer", "user", "assistant", "Alternative answer"),
  message("new-answer", "user", "assistant", "Current answer"),
  { type: "session_info", id: "name", parentId: "new-answer", name: "Imported Pi chat", timestamp },
];
const jsonl = (entries: ReadonlyArray<unknown>) =>
  entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
const parse = (entries: ReadonlyArray<unknown> = records) =>
  AgentSessionScanner.parseAgentSessionTranscript({
    source: "pi",
    providerInstanceId: piInstance,
    fallbackSessionId: "filename",
    filePath: "/workspace/sessions/pi.jsonl",
    lastActiveAtMs: Date.parse(timestamp),
    contents: jsonl(entries),
  });

describe("Pi transcript", () => {
  it("imports the restored branch, session name, model, and exact native cursor", () => {
    expect(parse()).toMatchObject({
      providerSessionId: header.id,
      nativeThreadId: "/workspace/sessions/pi.jsonl",
      nativeConversationHeadId: "name",
      title: "Imported Pi chat",
      model: "anthropic/claude-sonnet",
      createdAt: timestamp,
    });
    expect(parse()?.messages.map((entry) => entry.text)).toEqual([
      "Remember PI-CANARY-4413",
      "Current answer",
    ]);
  });
  it("keeps tree links through tools, compaction, and extension entries without importing their payloads", () => {
    const entries = [
      ...records,
      { type: "compaction", id: "compact", parentId: "name", summary: "Summary", timestamp },
      message("tool", "compact", "toolResult", "Tool output"),
      { type: "custom", id: "extension", parentId: "tool", data: { secret: "ignored" }, timestamp },
      message("next", "extension", "user", "Next prompt"),
    ];
    expect(parse(entries)?.messages.map((entry) => entry.text)).toEqual([
      "Remember PI-CANARY-4413",
      "Current answer",
      "Next prompt",
    ]);
  });
  it("reads version 1 linear history without inventing entry IDs before Pi migrates it", () => {
    const parsed = parse([
      { ...header, version: 1 },
      { type: "message", message: { role: "user", content: "Legacy prompt" }, timestamp },
    ]);
    expect(parsed?.messages[0]?.text).toBe("Legacy prompt");
    expect(parsed?.nativeConversationHeadId).toBeUndefined();
  });
  it("preserves more than 200 messages instead of silently dropping older Pi history", () => {
    const entries = [
      header,
      ...Array.from({ length: 250 }, (_, index) =>
        message(
          `m${index}`,
          index === 0 ? null : `m${index - 1}`,
          index % 2 === 0 ? "user" : "assistant",
          `message ${index}`,
        ),
      ),
    ];
    expect(parse(entries)?.messages).toHaveLength(250);
  });
  it("rejects broken trees, duplicate IDs and unsupported versions before importing", () => {
    expect(parse([header, message("broken", "missing", "user", "Wrong branch")])).toBeNull();
    expect(parse([...records, message("user", "name", "user", "Duplicate")])).toBeNull();
    expect(parse([{ ...header, version: 99 }, ...records.slice(1)])).toBeNull();
    expect(parse([header, message("loop", "loop", "user", "Cycle")])).toBeNull();
    expect(parse([...records, { type: "message", id: 42, parentId: "name" }])).toBeNull();
  });
});

const fixture = Effect.fnUntraced(function* (
  storage: "home" | "environment" | "launch" = "home",
  disabled = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-import-" });
  const workspaceRoot = path.join(directory, "workspace");
  const home = path.join(directory, "pi-home");
  const sessionDirectory = path.join(directory, "custom sessions");
  const filePath =
    storage === "home"
      ? path.join(home, "sessions", "--lossy-path--", "session.jsonl")
      : path.join(sessionDirectory, "session.jsonl");
  yield* fs.makeDirectory(workspaceRoot, { recursive: true });
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  const contents = jsonl([{ ...header, cwd: workspaceRoot }, ...records.slice(1)]);
  yield* fs.writeFileString(filePath, contents);
  const seconds = Date.parse(timestamp) / 1000;
  yield* fs.utimes(filePath, seconds, seconds);
  yield* TestClock.setTime(Date.parse("2026-10-05T12:00:00.000Z"));
  const project = {
    id: projectId,
    title: "Pi project",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const config = ServerConfig.layerTest(workspaceRoot, { prefix: "t3-pi-import-config-" });
  const settings = ServerSettings.layerTest({
    providerInstances: {
      [piInstance]: {
        driver: ProviderDriverKind.make("pi"),
        enabled: !disabled,
        config: storage === "launch" ? { launchArgs: `--session-dir="${sessionDirectory}"` } : {},
        environment: [
          { name: "PI_CODING_AGENT_DIR", value: home, sensitive: false },
          ...(storage === "home"
            ? []
            : [
                {
                  name: "PI_CODING_AGENT_SESSION_DIR",
                  value:
                    storage === "launch" ? path.join(directory, "wrong-root") : sessionDirectory,
                  sensitive: false,
                },
              ]),
        ],
      },
      [ProviderInstanceId.make("claudeAgent")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: false,
        config: {},
      },
      [ProviderInstanceId.make("codex")]: {
        driver: ProviderDriverKind.make("codex"),
        enabled: false,
        config: {},
      },
    },
  });
  const scanner = AgentSessionScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        config,
        settings,
        Layer.succeed(HostProcessEnvironment, {}),
        Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([project]) }),
      ),
    ),
  );
  const stores = Layer.mergeAll(
    ProjectionStore.layer,
    ProviderSessionRuntime.layer,
    IdAllocator.layer,
    OrchestrationV2EventSinkLayerLive,
  );
  const orchestrator = Layer.unwrap(
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      return Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadRecords: (threadId, fields) =>
          projections
            .getThreadRecords(threadId, fields)
            .pipe(
              Effect.mapError(() => new Orchestrator.OrchestratorProjectionError({ threadId })),
            ),
      });
    }),
  ).pipe(Layer.provide(stores));
  const importer = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        scanner,
        stores,
        orchestrator,
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.some(project as never)),
        }),
      ),
    ),
  );
  const layer = Layer.mergeAll(importer, scanner, stores, settings).pipe(
    Layer.provide(
      Layer.mergeAll(SqlitePersistenceMemory, config).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );
  return { filePath, fs, contents, workspaceRoot, layer };
});

it.layer(NodeServices.layer)("Pi import service", (it) => {
  it.effect.each(["environment", "launch"] as const)(
    "discovers flat storage configured by %s, with launch arguments taking precedence",
    (storage) =>
      Effect.gen(function* () {
        const test = yield* fixture(storage);
        yield* Effect.gen(function* () {
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          expect((yield* scanner.scan).candidates).toHaveLength(1);
          const outcomes = yield* scanner.recentThreads(test.workspaceRoot).pipe(Stream.runCollect);
          expect(Array.from(outcomes)).toMatchObject([
            {
              _tag: "Importable",
              thread: { nativeThreadId: test.filePath, providerInstanceId: piInstance },
            },
          ]);
        }).pipe(Effect.provide(test.layer));
      }),
  );
  it.effect("does not scan disabled Pi instances", () =>
    Effect.gen(function* () {
      const test = yield* fixture("home", true);
      yield* Effect.gen(function* () {
        const scanner = yield* AgentSessionScanner.AgentSessionScanner;
        expect((yield* scanner.scan).candidates).toEqual([]);
      }).pipe(Effect.provide(test.layer));
    }),
  );
  it.effect.each([
    { name: "dangling parent", entry: message("bad", "missing", "user", "Unlinked") },
    { name: "invalid entry ID", entry: { type: "message", id: 42, parentId: "name" } },
  ])("skips malformed sessions ($name) without writing partial history", ({ entry }) =>
    Effect.gen(function* () {
      const test = yield* fixture();
      yield* test.fs.writeFileString(
        test.filePath,
        jsonl([{ ...header, cwd: test.workspaceRoot }, ...records.slice(1), entry]),
      );
      yield* test.fs.utimes(
        test.filePath,
        Date.parse(timestamp) / 1000,
        Date.parse(timestamp) / 1000,
      );
      yield* Effect.gen(function* () {
        const importer = yield* AgentSessionImporter.AgentSessionImporter;
        expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
          importedCount: 0,
          skippedCount: 1,
        });
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        expect(
          yield* projections.getThreadShell(ThreadId.make(`import:pi:${header.id}`)),
        ).toBeNull();
      }).pipe(Effect.provide(test.layer));
    }),
  );
  it.effect(
    "discovers and persists old Pi history, retains native continuation and retries without duplicate messages",
    () =>
      Effect.gen(function* () {
        const test = yield* fixture();
        yield* Effect.gen(function* () {
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          expect((yield* scanner.scan).candidates).toMatchObject([
            { path: test.workspaceRoot, sources: ["pi"], threadCount: 1, projectId },
          ]);
          const importer = yield* AgentSessionImporter.AgentSessionImporter;
          expect(
            yield* importer.importRecentAgentThreads({
              projectId,
              expectedWorkspaceRoot: test.workspaceRoot,
            }),
          ).toEqual({ importedCount: 1, skippedCount: 0 });
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const threadId = ThreadId.make(`import:pi:${header.id}`);
          const projection = yield* projections.getThreadRecords(threadId, [
            "messages",
            "providerThreads",
          ]);
          expect(projection.messages.map((entry) => entry.text)).toEqual([
            "Remember PI-CANARY-4413",
            "Current answer",
          ]);
          expect(projection.providerThreads[0]).toMatchObject({
            nativeThreadRef: { driver: "pi", nativeId: test.filePath },
            nativeConversationHeadRef: { nativeId: "name" },
          });
          expect(projection.thread.modelSelection).toEqual({
            instanceId: piInstance,
            model: "anthropic/claude-sonnet",
          });
          expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
            importedCount: 1,
            skippedCount: 0,
          });
          expect(
            (yield* projections.getThreadRecords(threadId, ["messages"])).messages,
          ).toHaveLength(2);
          const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
          expect((yield* runtimes.list())[0]).toMatchObject({
            providerName: "pi",
            resumeCursor: { sessionFile: test.filePath },
          });
          expect(yield* test.fs.readFileString(test.filePath)).toBe(test.contents);
        }).pipe(Effect.provide(test.layer));
      }),
  );
  it.effect("never rebinds a session already owned by a T3 thread", () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      yield* Effect.gen(function* () {
        const importer = yield* AgentSessionImporter.AgentSessionImporter;
        yield* importer.importRecentAgentThreads({ projectId });
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const threadId = ThreadId.make(`import:pi:${header.id}`);
        const original = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
        const owner = ThreadId.make("existing-native-pi-thread");
        const sink = yield* EventSink.EventSinkV2;
        const now = original.thread.updatedAt;
        yield* sink.write({
          events: [
            {
              id: "native-thread-created" as never,
              type: "thread.created",
              threadId: owner,
              occurredAt: now,
              payload: {
                ...original.thread,
                id: owner,
                historyOrigin: "native",
                lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: owner },
              },
            },
            {
              id: "native-provider-bound" as never,
              type: "provider-thread.updated",
              threadId: owner,
              occurredAt: now,
              payload: { ...original.providerThreads[0]!, appThreadId: owner },
            },
          ],
        });
        // A new import identity proves the ownership check, rather than the retry shortcut.
        yield* test.fs.writeFileString(
          test.filePath,
          test.contents.replace(header.id, "new-session-uuid"),
        );
        yield* test.fs.utimes(
          test.filePath,
          Date.parse(timestamp) / 1000,
          Date.parse(timestamp) / 1000,
        );
        expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
          importedCount: 1,
          skippedCount: 0,
        });
        expect(
          yield* projections.getProviderThreadOwner({
            threadId,
            providerThreadId: original.providerThreads[0]!.id,
          }),
        ).toBe(owner);
        expect(
          yield* projections.getThreadShell(ThreadId.make("import:pi:new-session-uuid")),
        ).toBeNull();
      }).pipe(Effect.provide(test.layer));
    }),
  );
});
