import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { decodeLegacy2CodeImportManifestJson } from "@t3tools/shared/fork/legacy2codeImport";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  LEGACY_2CODE_IMPORT_MANIFEST_NAME,
  prepareLegacy2CodeImport,
} from "./Legacy2CodeMigration.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const withTemporaryMigration = <A, E, R>(
  run: (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly legacyUserDataPath: string;
    readonly targetStateDir: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-legacy-2code-" });
    const legacyUserDataPath = path.join(root, "legacy-user-data");
    const targetStateDir = path.join(root, "target-state");
    yield* fileSystem.makeDirectory(path.join(legacyUserDataPath, "config"), {
      recursive: true,
    });
    return yield* run({ fileSystem, path, legacyUserDataPath, targetStateDir });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("Legacy2CodeMigration", () => {
  it.effect("copies first and prepares only real projects and resumable chats", () =>
    withTemporaryMigration(
      Effect.fn(function* ({ fileSystem, path, legacyUserDataPath, targetStateDir }) {
        const alpha = path.join(legacyUserDataPath, "projects", "alpha");
        const beta = path.join(legacyUserDataPath, "projects", "beta");
        const workspacePath = path.join(legacyUserDataPath, "config", "workspace.json");
        yield* fileSystem.makeDirectory(alpha, { recursive: true });
        yield* fileSystem.makeDirectory(beta, { recursive: true });
        const rawWorkspace = encodeJson({
          settings: {
            claudeRoute: "hybrid",
            codexSubagents: true,
            codexSubagentModel: "gpt-5.6-sol",
          },
          workspace: {
            projects: [
              { path: alpha, name: "Alpha" },
              { path: beta, name: "Beta" },
              { path: alpha, name: "Duplicate" },
              { path: "relative/project", name: "Unsafe" },
            ],
            openTabs: [
              {
                id: "claude-tab",
                projectPath: alpha,
                sessionId: "11111111-1111-4111-8111-111111111111",
                title: "Claude task",
                subtitle: "Existing subtitle",
                backend: "claude",
                mode: "chat",
                chatModel: "claude-sonnet-5",
                lastActionAt: 1786019696789,
                chatExecutionProfile: { route: "hybrid" },
              },
              {
                id: "codex-tab",
                projectPath: beta,
                sessionId: "22222222-2222-4222-8222-222222222222",
                title: "Codex task",
                backend: "codex",
                mode: "chat",
                chatModel: "gpt-5.6-sol",
                lastActionAt: -1,
              },
              { id: "terminal", projectPath: alpha, title: "Shell", mode: "terminal" },
              {
                id: "ephemeral",
                projectPath: alpha,
                sessionId: "33333333-3333-4333-8333-333333333333",
                title: "Private",
                mode: "chat",
                chatEphemeral: true,
              },
            ],
          },
        });
        yield* fileSystem.writeFileString(workspacePath, rawWorkspace);

        const legacyAuthDirectory = path.join(
          legacyUserDataPath,
          "providers",
          "codex-via-claude",
          "auth",
        );
        yield* fileSystem.makeDirectory(legacyAuthDirectory, { recursive: true });
        const credential = encodeJson({
          type: "codex",
          refresh_token: "refresh-secret",
          access_token: "access-secret",
        });
        yield* fileSystem.writeFileString(
          path.join(legacyAuthDirectory, "codex-user-pro.json"),
          credential,
        );
        yield* fileSystem.writeFileString(
          path.join(legacyAuthDirectory, "ignore.json"),
          encodeJson({ nope: true }),
        );

        const result = yield* prepareLegacy2CodeImport({
          legacyUserDataPath,
          targetStateDir,
        });

        assert.deepEqual(result, {
          workspaceStatus: "prepared",
          authStatus: "copied",
          projectCount: 2,
          threadCount: 2,
          skippedSessionCount: 2,
        });
        assert.equal(yield* fileSystem.readFileString(workspacePath), rawWorkspace);
        assert.equal(
          yield* fileSystem.readFileString(path.join(legacyAuthDirectory, "codex-user-pro.json")),
          credential,
        );
        const migrationDirectory = path.join(
          targetStateDir,
          "migrations",
          "legacy-2code-electron-v1",
        );
        assert.equal(
          yield* fileSystem.readFileString(
            path.join(migrationDirectory, "workspace.snapshot.json"),
          ),
          rawWorkspace,
        );
        const manifest = yield* fileSystem
          .readFileString(path.join(migrationDirectory, LEGACY_2CODE_IMPORT_MANIFEST_NAME))
          .pipe(Effect.flatMap(decodeLegacy2CodeImportManifestJson));
        assert.deepEqual(
          manifest.projects.map((project) => project.title),
          ["Alpha", "Beta"],
        );
        assert.deepEqual(manifest.threads, [
          {
            legacyId: "claude-tab",
            projectPath: alpha,
            title: "Claude task",
            subtitle: "Existing subtitle",
            model: "claude-sonnet-5",
            createdAt: "2026-08-06T12:34:56.789Z",
            legacyRoute: "hybrid",
            provider: "claude",
            resumeCursor: { resume: "11111111-1111-4111-8111-111111111111" },
          },
          {
            legacyId: "codex-tab",
            projectPath: beta,
            title: "Codex task",
            model: "gpt-5.6-sol",
            provider: "codex",
            resumeCursor: { threadId: "22222222-2222-4222-8222-222222222222" },
          },
        ]);
        assert.deepEqual(manifest.claudeCodexRouting, {
          enabled: true,
          model: "gpt-5.6-sol",
        });
        assert.equal(manifest.skippedSessions, 2);
        assert.equal(
          yield* fileSystem.readFileString(
            path.join(
              targetStateDir,
              "providers",
              "claude-codex-bridge",
              "auth",
              "codex-user-pro.json",
            ),
          ),
          credential,
        );
      }),
    ),
  );

  it.effect("is idempotent and keeps using its immutable first snapshot", () =>
    withTemporaryMigration(
      Effect.fn(function* ({ fileSystem, path, legacyUserDataPath, targetStateDir }) {
        const projectPath = path.join(legacyUserDataPath, "project");
        const workspacePath = path.join(legacyUserDataPath, "config", "workspace.json");
        yield* fileSystem.makeDirectory(projectPath, { recursive: true });
        yield* fileSystem.writeFileString(
          workspacePath,
          encodeJson({
            workspace: { projects: [{ path: projectPath, name: "First" }], openTabs: [] },
          }),
        );
        const first = yield* prepareLegacy2CodeImport({ legacyUserDataPath, targetStateDir });
        yield* fileSystem.writeFileString(
          workspacePath,
          encodeJson({
            workspace: { projects: [{ path: projectPath, name: "Changed later" }], openTabs: [] },
          }),
        );
        const second = yield* prepareLegacy2CodeImport({ legacyUserDataPath, targetStateDir });

        assert.equal(first.workspaceStatus, "prepared");
        assert.equal(second.workspaceStatus, "already-prepared");
        const manifest = yield* fileSystem
          .readFileString(
            path.join(
              targetStateDir,
              "migrations",
              "legacy-2code-electron-v1",
              LEGACY_2CODE_IMPORT_MANIFEST_NAME,
            ),
          )
          .pipe(Effect.flatMap(decodeLegacy2CodeImportManifestJson));
        assert.equal(manifest.projects[0]?.title, "First");
      }),
    ),
  );

  it.effect("falls back to an immutable legacy backup when the primary is corrupt", () =>
    withTemporaryMigration(
      Effect.fn(function* ({ fileSystem, path, legacyUserDataPath, targetStateDir }) {
        const projectPath = path.join(legacyUserDataPath, "project");
        const workspacePath = path.join(legacyUserDataPath, "config", "workspace.json");
        const backupPath = `${workspacePath}.backup`;
        const corruptPrimary = "{broken-json";
        const backupWorkspace = encodeJson({
          workspace: {
            projects: [{ path: projectPath, name: "Recovered" }],
            openTabs: [
              {
                id: "recovered-tab",
                projectPath,
                sessionId: "44444444-4444-4444-8444-444444444444",
                title: "Recovered task",
                backend: "claude",
                mode: "chat",
              },
            ],
          },
        });
        yield* fileSystem.makeDirectory(projectPath, { recursive: true });
        yield* fileSystem.writeFileString(workspacePath, corruptPrimary);
        yield* fileSystem.writeFileString(backupPath, backupWorkspace);

        const result = yield* prepareLegacy2CodeImport({ legacyUserDataPath, targetStateDir });

        assert.deepEqual(result, {
          workspaceStatus: "prepared",
          authStatus: "not-found",
          projectCount: 1,
          threadCount: 1,
          skippedSessionCount: 0,
        });
        assert.equal(yield* fileSystem.readFileString(workspacePath), corruptPrimary);
        assert.equal(yield* fileSystem.readFileString(backupPath), backupWorkspace);
        const migrationDirectory = path.join(
          targetStateDir,
          "migrations",
          "legacy-2code-electron-v1",
        );
        assert.equal(
          yield* fileSystem.readFileString(
            path.join(migrationDirectory, "workspace.snapshot.json"),
          ),
          corruptPrimary,
        );
        assert.equal(
          yield* fileSystem.readFileString(
            path.join(migrationDirectory, "workspace.backup.snapshot.json"),
          ),
          backupWorkspace,
        );
        const manifest = yield* fileSystem
          .readFileString(path.join(migrationDirectory, LEGACY_2CODE_IMPORT_MANIFEST_NAME))
          .pipe(Effect.flatMap(decodeLegacy2CodeImportManifestJson));
        assert.equal(manifest.source.workspacePath, backupPath);
        assert.equal(manifest.projects[0]?.title, "Recovered");
        assert.equal(manifest.threads[0]?.title, "Recovered task");
      }),
    ),
  );

  it.effect("lets an explicit Claude execution route override a Codex backend label", () =>
    withTemporaryMigration(
      Effect.fn(function* ({ fileSystem, path, legacyUserDataPath, targetStateDir }) {
        const projectPath = path.join(legacyUserDataPath, "project");
        const workspacePath = path.join(legacyUserDataPath, "config", "workspace.json");
        yield* fileSystem.makeDirectory(projectPath, { recursive: true });
        yield* fileSystem.writeFileString(
          workspacePath,
          encodeJson({
            workspace: {
              projects: [{ path: projectPath, name: "Routed" }],
              openTabs: [
                {
                  id: "routed-tab",
                  projectPath,
                  sessionId: "55555555-5555-4555-8555-555555555555",
                  title: "Codex through Claude",
                  backend: "codex",
                  mode: "chat",
                  chatExecutionProfile: { route: "codex-via-claude" },
                },
              ],
            },
          }),
        );

        const result = yield* prepareLegacy2CodeImport({ legacyUserDataPath, targetStateDir });

        assert.equal(result.threadCount, 1);
        const manifest = yield* fileSystem
          .readFileString(
            path.join(
              targetStateDir,
              "migrations",
              "legacy-2code-electron-v1",
              LEGACY_2CODE_IMPORT_MANIFEST_NAME,
            ),
          )
          .pipe(Effect.flatMap(decodeLegacy2CodeImportManifestJson));
        assert.deepEqual(manifest.threads[0], {
          legacyId: "routed-tab",
          projectPath,
          title: "Codex through Claude",
          legacyRoute: "codex-via-claude",
          provider: "claude",
          resumeCursor: { resume: "55555555-5555-4555-8555-555555555555" },
        });
        assert.deepEqual(manifest.claudeCodexRouting, { enabled: true });
      }),
    ),
  );

  it.effect("preserves a corrupt source snapshot without blocking startup", () =>
    withTemporaryMigration(
      Effect.fn(function* ({ fileSystem, path, legacyUserDataPath, targetStateDir }) {
        const workspacePath = path.join(legacyUserDataPath, "config", "workspace.json");
        yield* fileSystem.writeFileString(workspacePath, "{broken-json");

        const result = yield* prepareLegacy2CodeImport({
          legacyUserDataPath,
          targetStateDir,
        });

        assert.equal(result.workspaceStatus, "failed");
        assert.equal(
          yield* fileSystem.readFileString(
            path.join(
              targetStateDir,
              "migrations",
              "legacy-2code-electron-v1",
              "workspace.snapshot.json",
            ),
          ),
          "{broken-json",
        );
      }),
    ),
  );
});
