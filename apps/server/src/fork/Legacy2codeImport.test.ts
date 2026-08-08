import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, type OrchestrationCommand } from "@t3tools/contracts";
import {
  encodeLegacy2CodeImportManifestJson,
  type Legacy2CodeImportManifest,
} from "@t3tools/shared/fork/legacy2codeImport";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderRuntimeBinding } from "../provider/Services/ProviderSessionDirectory.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import * as Legacy2CodeImport from "./Legacy2codeImport.ts";

const SOURCE_SHA = "a".repeat(64);

const manifestFixture = {
  version: 1,
  source: {
    workspacePath: "/legacy/2code/workspace.json",
    sha256: SOURCE_SHA,
  },
  projects: [
    { legacyPath: "/work/new-project", title: "New Project" },
    { legacyPath: "/work/existing-project", title: "Existing Project" },
  ],
  threads: [
    {
      legacyId: "claude-session-1",
      projectPath: "/work/new-project",
      title: "Claude migration",
      subtitle: "Waiting for a follow-up",
      createdAt: "2026-08-06T12:34:56.789Z",
      model: "claude-opus-5",
      provider: "claude",
      resumeCursor: { resume: "claude-session-1" },
    },
    {
      legacyId: "codex-session-1",
      projectPath: "/work/existing-project",
      title: "Codex migration",
      provider: "codex",
      resumeCursor: { threadId: "codex-session-1" },
    },
  ],
  claudeCodexRouting: {
    enabled: true,
    model: "gpt-5.6-sol",
  },
  skippedSessions: 2,
  createdAt: "2026-08-08T08:00:00.000Z",
} as const satisfies Legacy2CodeImportManifest;

const testConfigLayer = () =>
  ServerConfig.layerTest("/work/test", { prefix: "t3-legacy-2code-import-test-" }).pipe(
    Layer.provide(NodeServices.layer),
  );
const testRuntimeLayer = () =>
  Layer.mergeAll(NodeServices.layer, testConfigLayer(), ServerSettings.layerTest());

const makeProjectionQuery = (input?: {
  readonly existingProjectId?: ProjectId;
  readonly threadIds?: Ref.Ref<ReadonlySet<string>>;
}) =>
  ({
    getActiveProjectByWorkspaceRoot: (workspaceRoot: string) =>
      Effect.succeed(
        workspaceRoot === "/work/existing-project" && input?.existingProjectId
          ? Option.some({ id: input.existingProjectId } as never)
          : Option.none(),
      ),
    getThreadShellById: (threadId: string) =>
      input?.threadIds
        ? Ref.get(input.threadIds).pipe(
            Effect.map((threadIds) =>
              threadIds.has(threadId) ? Option.some({ id: threadId } as never) : Option.none(),
            ),
          )
        : Effect.succeed(Option.none()),
  }) as never;

const makeEngine = (
  commands: Ref.Ref<ReadonlyArray<OrchestrationCommand>>,
  threadIds?: Ref.Ref<ReadonlySet<string>>,
) =>
  ({
    readEvents: () => Stream.empty,
    dispatch: (command: OrchestrationCommand) =>
      Effect.gen(function* () {
        yield* Ref.update(commands, (current) => [...current, command]);
        if (command.type === "thread.create" && threadIds) {
          yield* Ref.update(threadIds, (current) => new Set([...current, command.threadId]));
        }
        return { sequence: 1 };
      }),
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
  }) satisfies OrchestrationEngine.OrchestrationEngineService["Service"];

const makeDirectory = (bindings: Ref.Ref<ReadonlyArray<ProviderRuntimeBinding>>) =>
  ({
    upsert: (binding: ProviderRuntimeBinding) =>
      Ref.update(bindings, (current) => [...current, binding]),
    getProvider: () => Effect.die("unused"),
    getBinding: () => Effect.die("unused"),
    listThreadIds: () => Effect.die("unused"),
    listBindings: () => Effect.die("unused"),
  }) satisfies ProviderSessionDirectory.ProviderSessionDirectory["Service"];

const writeManifest = (manifest: Legacy2CodeImportManifest) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const paths = Legacy2CodeImport.resolveLegacy2CodeImportPaths(config.stateDir, path);
    const encoded = yield* encodeLegacy2CodeImportManifestJson(manifest);
    yield* fileSystem.makeDirectory(paths.migrationDirectory, { recursive: true });
    yield* fileSystem.writeFileString(paths.manifestPath, encoded);
    return paths;
  });

describe("Legacy2codeImport", () => {
  it.effect("does nothing when the desktop hand-off is absent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
        const bindings = yield* Ref.make<ReadonlyArray<ProviderRuntimeBinding>>([]);
        const outcome = yield* Legacy2CodeImport.importLegacy2CodeManifest.pipe(
          Effect.provideService(
            OrchestrationEngine.OrchestrationEngineService,
            makeEngine(commands),
          ),
          Effect.provideService(
            ProjectionSnapshotQuery.ProjectionSnapshotQuery,
            makeProjectionQuery(),
          ),
          Effect.provideService(
            ProviderSessionDirectory.ProviderSessionDirectory,
            makeDirectory(bindings),
          ),
        );
        assert.equal(outcome.status, "not-found");
      }).pipe(Effect.provide(testRuntimeLayer())),
    ),
  );

  it.effect("imports event-sourced threads and stopped provider resume bindings exactly once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
        const bindings = yield* Ref.make<ReadonlyArray<ProviderRuntimeBinding>>([]);
        const importedThreadIds = yield* Ref.make<ReadonlySet<string>>(new Set());
        const existingProjectId = ProjectId.make("existing-project-id");

        const program = Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* writeManifest(manifestFixture);

          const first = yield* Legacy2CodeImport.importLegacy2CodeManifest;
          assert.equal(first.status, "imported");
          if (first.status !== "imported") return;
          assert.equal(first.projectsCreated, 1);
          assert.equal(first.projectsReused, 1);
          assert.equal(first.threadsCreated, 2);
          assert.equal(first.threadsReused, 0);
          assert.isTrue(yield* fileSystem.exists(first.receiptPath));
          assert.include(yield* fileSystem.readFileString(first.receiptPath), SOURCE_SHA);

          const commandsAfterFirstImport = yield* Ref.get(commands);
          const bindingsAfterFirstImport = yield* Ref.get(bindings);
          const migratedSettings = yield* ServerSettings.ServerSettingsService.pipe(
            Effect.flatMap((settings) => settings.getSettings),
          );
          const second = yield* Legacy2CodeImport.importLegacy2CodeManifest;

          assert.equal(second.status, "already-imported");
          assert.deepEqual(yield* Ref.get(commands), commandsAfterFirstImport);
          assert.deepEqual(yield* Ref.get(bindings), bindingsAfterFirstImport);
          assert.equal(migratedSettings.providers.claudeAgent.codexRouting?.enabled, true);
          assert.equal(migratedSettings.providers.claudeAgent.codexRouting?.model, "gpt-5.6-sol");
          assert.deepEqual(
            commandsAfterFirstImport.map((command) => command.type),
            ["project.create", "thread.create", "thread.meta.update", "thread.create"],
          );
          assert.notInclude(
            commandsAfterFirstImport.map((command) => command.type),
            "thread.turn.start",
          );
          const projectCreate = commandsAfterFirstImport.find(
            (command) => command.type === "project.create",
          );
          const claudeThreadCreate = commandsAfterFirstImport.find(
            (command) => command.type === "thread.create" && command.title === "Claude migration",
          );
          const codexThreadCreate = commandsAfterFirstImport.find(
            (command) => command.type === "thread.create" && command.title === "Codex migration",
          );
          assert.equal(
            projectCreate?.type === "project.create" ? projectCreate.projectId : undefined,
            claudeThreadCreate?.type === "thread.create" ? claudeThreadCreate.projectId : undefined,
          );
          assert.equal(
            codexThreadCreate?.type === "thread.create" ? codexThreadCreate.projectId : undefined,
            existingProjectId,
          );
          assert.equal(
            claudeThreadCreate?.type === "thread.create"
              ? claudeThreadCreate.runtimeMode
              : undefined,
            "approval-required",
          );
          assert.equal(
            claudeThreadCreate?.type === "thread.create" ? claudeThreadCreate.createdAt : undefined,
            "2026-08-06T12:34:56.789Z",
          );
          assert.equal(
            codexThreadCreate?.type === "thread.create" ? codexThreadCreate.runtimeMode : undefined,
            "approval-required",
          );
          assert.equal(
            codexThreadCreate?.type === "thread.create" ? codexThreadCreate.createdAt : undefined,
            manifestFixture.createdAt,
          );

          assert.lengthOf(bindingsAfterFirstImport, 2);
          const claudeBinding = bindingsAfterFirstImport[0];
          assert.equal(claudeBinding?.provider, "claudeAgent");
          assert.equal(claudeBinding?.providerInstanceId, "claudeAgent");
          assert.equal(claudeBinding?.adapterKey, "claudeAgent");
          assert.equal(claudeBinding?.status, "stopped");
          assert.equal(claudeBinding?.runtimeMode, "approval-required");
          assert.deepEqual(claudeBinding?.resumeCursor, { resume: "claude-session-1" });
          assert.deepEqual(claudeBinding?.runtimePayload, {
            cwd: "/work/new-project",
            modelSelection: {
              instanceId: "claudeAgent",
              model: "claude-opus-5",
            },
          });
          const codexBinding = bindingsAfterFirstImport[1];
          assert.equal(codexBinding?.provider, "codex");
          assert.equal(codexBinding?.providerInstanceId, "codex");
          assert.equal(codexBinding?.adapterKey, "codex");
          assert.equal(codexBinding?.status, "stopped");
          assert.equal(codexBinding?.runtimeMode, "approval-required");
          assert.deepEqual(codexBinding?.resumeCursor, { threadId: "codex-session-1" });
        }).pipe(
          Effect.provideService(
            OrchestrationEngine.OrchestrationEngineService,
            makeEngine(commands, importedThreadIds),
          ),
          Effect.provideService(
            ProjectionSnapshotQuery.ProjectionSnapshotQuery,
            makeProjectionQuery({ existingProjectId, threadIds: importedThreadIds }),
          ),
          Effect.provideService(
            ProviderSessionDirectory.ProviderSessionDirectory,
            makeDirectory(bindings),
          ),
        );

        yield* program;
      }).pipe(Effect.provide(testRuntimeLayer())),
    ),
  );

  it.effect("logs malformed hand-offs without failing server startup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
        const bindings = yield* Ref.make<ReadonlyArray<ProviderRuntimeBinding>>([]);
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const paths = Legacy2CodeImport.resolveLegacy2CodeImportPaths(config.stateDir, path);
        yield* fileSystem.makeDirectory(paths.migrationDirectory, { recursive: true });
        yield* fileSystem.writeFileString(paths.manifestPath, "{not-json");

        yield* Legacy2CodeImport.runLegacy2CodeImportOnStartup.pipe(
          Effect.provideService(
            OrchestrationEngine.OrchestrationEngineService,
            makeEngine(commands),
          ),
          Effect.provideService(
            ProjectionSnapshotQuery.ProjectionSnapshotQuery,
            makeProjectionQuery(),
          ),
          Effect.provideService(
            ProviderSessionDirectory.ProviderSessionDirectory,
            makeDirectory(bindings),
          ),
        );
      }).pipe(Effect.provide(testRuntimeLayer())),
    ),
  );

  it.effect("retries idempotently when an interrupted import left a corrupt receipt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
        const bindings = yield* Ref.make<ReadonlyArray<ProviderRuntimeBinding>>([]);
        const importedThreadIds = yield* Ref.make<ReadonlySet<string>>(new Set());
        const fileSystem = yield* FileSystem.FileSystem;
        const paths = yield* writeManifest(manifestFixture);
        yield* fileSystem.writeFileString(paths.receiptPathForSource(SOURCE_SHA), "{interrupted");

        const outcome = yield* Legacy2CodeImport.importLegacy2CodeManifest.pipe(
          Effect.provideService(
            OrchestrationEngine.OrchestrationEngineService,
            makeEngine(commands, importedThreadIds),
          ),
          Effect.provideService(
            ProjectionSnapshotQuery.ProjectionSnapshotQuery,
            makeProjectionQuery({ threadIds: importedThreadIds }),
          ),
          Effect.provideService(
            ProviderSessionDirectory.ProviderSessionDirectory,
            makeDirectory(bindings),
          ),
        );

        assert.equal(outcome.status, "imported");
        assert.include(
          yield* fileSystem.readFileString(paths.receiptPathForSource(SOURCE_SHA)),
          SOURCE_SHA,
        );
      }).pipe(Effect.provide(testRuntimeLayer())),
    ),
  );
});
