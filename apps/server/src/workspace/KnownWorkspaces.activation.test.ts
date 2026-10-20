import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { GitCommandError, ProjectId, VcsRepositoryDetectionError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as JjRepo from "../vcs/JjRepo.ts";
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";

interface Scenario {
  readonly kind?: "git" | "jj";
  readonly listed?: boolean;
  readonly gitListed?: boolean;
  readonly coexist?: boolean;
  readonly staleSibling?: boolean;
  readonly thread?: "active" | "deleted" | "missing" | "other-project";
  readonly failure?:
    | "detect"
    | "list"
    | "git-list"
    | "jj-list"
    | "project-paths"
    | "workspace-paths"
    | "sql";
  readonly workspace?: "missing" | "replaced" | "marker" | "unrelated" | "symlink" | "nested";
  readonly omitRegistry?: boolean;
  readonly omitJj?: boolean;
}

const withWorkspace = (scenario: Scenario) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-known-workspaces-" });
    const root = yield* fs.realPath(base);
    const projectRoot = path.join(root, "project");
    const external = path.join(root, "external");
    const gitExternal = path.join(root, "git-external");
    const descendant = path.join(external, "src");
    yield* fs.makeDirectory(path.join(projectRoot, ".jj", "repo"), { recursive: true });
    yield* fs.makeDirectory(descendant, { recursive: true });
    if (scenario.coexist) yield* fs.makeDirectory(gitExternal);
    yield* fs.makeDirectory(path.join(external, ".jj"));
    yield* fs.writeFileString(
      path.join(external, ".jj", "repo"),
      path.relative(path.join(external, ".jj"), path.join(projectRoot, ".jj", "repo")),
    );
    if (scenario.workspace === "missing" || scenario.workspace === "symlink") {
      yield* fs.remove(external, { recursive: true });
      if (scenario.workspace === "symlink") {
        const unrelated = path.join(root, "unrelated");
        yield* fs.makeDirectory(path.join(unrelated, ".jj", "repo"), { recursive: true });
        yield* fs.makeDirectory(path.join(unrelated, "src"));
        yield* fs.symlink(unrelated, external);
      }
    } else if (scenario.workspace !== undefined) {
      yield* fs.remove(path.join(external, ".jj"), { recursive: true });
      if (scenario.workspace === "marker") {
        yield* fs.makeDirectory(path.join(external, ".jj"));
      } else if (scenario.workspace === "unrelated") {
        yield* fs.makeDirectory(path.join(external, ".jj", "repo"), { recursive: true });
      } else if (scenario.workspace === "nested") {
        yield* fs.makeDirectory(path.join(root, ".jj"));
        yield* fs.writeFileString(path.join(root, ".jj", "repo"), "../project/.jj/repo");
      }
    }
    yield* sql`
      CREATE TABLE orchestration_v2_projection_threads (
        project_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        deleted_at TEXT
      )
    `;
    if (scenario.thread !== "missing") {
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (project_id, payload_json, deleted_at)
        VALUES (
          ${scenario.thread === "other-project" ? "other" : "project"},
          ${JSON.stringify({ worktreePath: external })},
          ${scenario.thread === "deleted" ? "2026-10-01T00:00:00.000Z" : null}
        )
      `;
    }
    if (scenario.coexist) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (project_id, payload_json, deleted_at)
        VALUES ('project', ${JSON.stringify({ worktreePath: gitExternal })}, NULL)
      `;
    }
    if (scenario.failure === "sql") {
      yield* sql`DROP TABLE orchestration_v2_projection_threads`;
    }

    const calls = { git: [] as string[], jj: [] as string[], detect: [] as string[] };
    const failure = new VcsRepositoryDetectionError({
      operation: "authorization-test",
      cwd: projectRoot,
      detail: "unavailable",
    });
    const jjLayer = Layer.mock(JjVcsDriver.JjVcsDriver)({
      capabilities: {
        kind: "jj",
        supportsWorktrees: true,
        supportsBookmarks: true,
        supportsAtomicSnapshot: true,
        supportsPushDefaultRemote: false,
        ignoreClassifier: "git-compatible-fallback",
      },
      repoPaths: (cwd) =>
        Effect.gen(function* () {
          if (
            (cwd === projectRoot && scenario.failure === "project-paths") ||
            (cwd !== projectRoot && scenario.failure === "workspace-paths")
          ) {
            return yield* Effect.fail(failure);
          }
          const marker = yield* JjRepo.findVcsMarkerRoot(fs, path, cwd);
          if (marker?.marker !== "jj") return yield* Effect.fail(failure);
          return yield* JjRepo.resolveJjRepoPaths(fs, path, marker.root);
        }),
      listWorkspaces: (cwd) => {
        calls.jj.push(cwd);
        return scenario.failure === "list" || scenario.failure === "jj-list"
          ? Effect.fail(failure)
          : Effect.forEach(
              scenario.listed === false
                ? []
                : scenario.staleSibling
                  ? [path.join(root, "deleted-workspace"), external]
                  : [external],
              (workspaceRoot) =>
                fs.realPath(workspaceRoot).pipe(
                  Effect.orElseSucceed(() => workspaceRoot),
                  Effect.map((workspaceRoot) => ({
                    name: path.basename(workspaceRoot),
                    root: workspaceRoot,
                  })),
                ),
            );
      },
    });
    const registryLayer = Layer.effect(
      VcsDriverRegistry.VcsDriverRegistry,
      Effect.gen(function* () {
        const driver = yield* JjVcsDriver.JjVcsDriver;
        return yield* Effect.gen(function* () {
          return yield* VcsDriverRegistry.VcsDriverRegistry;
        }).pipe(
          Effect.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              detect: ({ cwd, jjOnly }) => {
                assert.isTrue(jjOnly);
                assert.include(calls.git, cwd);
                calls.detect.push(cwd);
                return scenario.failure === "detect"
                  ? Effect.fail(failure)
                  : Effect.succeed({
                      kind: scenario.kind ?? "jj",
                      driver,
                      repository: {
                        kind: scenario.kind ?? "jj",
                        rootPath: projectRoot,
                        metadataPath: path.join(projectRoot, ".jj"),
                        freshness: {
                          source: "live-local",
                          observedAt: DateTime.makeUnsafe(0),
                          expiresAt: Option.none(),
                        },
                      },
                    });
              },
            }),
          ),
        );
      }),
    ).pipe(Layer.provide(jjLayer));
    const projectsLayer = Layer.mock(ProjectStore.ProjectStoreV2)({
      listShells: () =>
        Effect.succeed([
          {
            id: ProjectId.make("project"),
            title: "Project",
            workspaceRoot: projectRoot,
            repositoryIdentity: null,
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
          },
        ]),
    });
    const service = yield* KnownWorkspaces.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.ServerConfig.layerTest(projectRoot, path.join(root, "state")),
          ServerSettings.ServerSettingsService.layerTest(),
          projectsLayer,
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            listWorktreePaths: (cwd) => {
              calls.git.push(cwd);
              return scenario.failure === "list" || scenario.failure === "git-list"
                ? Effect.fail(
                    new GitCommandError({
                      operation: "authorization-test",
                      command: "git worktree list",
                      cwd,
                      detail: "unavailable",
                    }),
                  )
                : Effect.succeed(
                    (scenario.gitListed ?? (scenario.kind === "git" && scenario.listed !== false))
                      ? [scenario.coexist ? gitExternal : external]
                      : [],
                  );
            },
          }),
          scenario.omitRegistry ? Layer.empty : registryLayer,
          scenario.omitJj ? Layer.empty : jjLayer,
        ),
      ),
      Effect.provideService(HostProcess.HomeDirectory, path.join(root, "home")),
    );
    const realExternal = yield* fs.realPath(external).pipe(Effect.orElseSucceed(() => external));
    const realDescendant = yield* fs
      .realPath(descendant)
      .pipe(Effect.orElseSucceed(() => descendant));
    const accepted = yield* service.contains(realExternal);
    const descendantAccepted = yield* service.contains(realDescendant);
    const assertion = yield* service.assertContains(descendant).pipe(Effect.result);
    const gitAccepted = scenario.coexist ? yield* service.contains(gitExternal) : undefined;
    return { accepted, descendantAccepted, assertion, gitAccepted, calls, projectRoot };
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })), Effect.scoped);

it.layer(NodeServices.layer, { excludeTestServices: true })("KnownWorkspaces activation", (it) => {
  it.effect("accepts a persisted jj external workspace and its descendants", () =>
    Effect.gen(function* () {
      const result = yield* withWorkspace({});
      assert.isTrue(result.accepted);
      assert.isTrue(result.descendantAccepted);
      assert.equal(result.assertion._tag, "Success");
      assert.deepEqual(result.calls.git, Array(3).fill(result.projectRoot));
      assert.deepEqual(result.calls.jj, Array(3).fill(result.projectRoot));
      assert.deepEqual(result.calls.detect, Array(3).fill(result.projectRoot));
    }),
  );

  it.effect("keeps a valid same-repository jj workspace alongside a stale listing", () =>
    Effect.gen(function* () {
      const result = yield* withWorkspace({ staleSibling: true });
      assert.isTrue(result.accepted);
      assert.isTrue(result.descendantAccepted);
      assert.equal(result.assertion._tag, "Success");
    }),
  );

  for (const scenario of [
    { listed: false },
    { thread: "missing" },
    { thread: "deleted" },
    { thread: "other-project" },
    { failure: "detect" },
    { failure: "list" },
    { failure: "sql" },
    { failure: "project-paths" },
    { failure: "workspace-paths" },
    { workspace: "missing" },
    { workspace: "replaced" },
    { workspace: "marker" },
    { workspace: "unrelated" },
    { workspace: "symlink" },
    { workspace: "nested" },
    { omitJj: true },
  ] satisfies ReadonlyArray<Scenario>) {
    it.effect(`rejects unverified jj external workspace: ${JSON.stringify(scenario)}`, () =>
      Effect.gen(function* () {
        const result = yield* withWorkspace(scenario);
        assert.isFalse(result.accepted);
        assert.isFalse(result.descendantAccepted);
        assert.equal(result.assertion._tag, "Failure");
      }),
    );
  }

  for (const omitRegistry of [false, true]) {
    it.effect(`keeps Git worktree listing (registry omitted: ${omitRegistry})`, () =>
      Effect.gen(function* () {
        const result = yield* withWorkspace({ kind: "git", omitRegistry });
        assert.isTrue(result.accepted);
        assert.isTrue(result.descendantAccepted);
        assert.deepEqual(result.calls.git, Array(3).fill(result.projectRoot));
        assert.deepEqual(result.calls.jj, []);
      }),
    );
  }

  for (const scenario of [
    {},
    { listed: false },
    { failure: "detect" },
    { failure: "jj-list" },
    { failure: "project-paths" },
    { failure: "workspace-paths" },
    { workspace: "replaced" },
    { workspace: "marker" },
    { workspace: "unrelated" },
    { workspace: "symlink" },
    { workspace: "nested" },
    { omitJj: true },
    { omitRegistry: true },
  ] satisfies ReadonlyArray<Scenario>) {
    it.effect(`keeps authoritative Git roots with jj detection: ${JSON.stringify(scenario)}`, () =>
      Effect.gen(function* () {
        const result = yield* withWorkspace({ ...scenario, gitListed: true });
        assert.isTrue(result.accepted);
        assert.isTrue(result.descendantAccepted);
        assert.equal(result.assertion._tag, "Success");
        assert.deepEqual(result.calls.git, Array(3).fill(result.projectRoot));
      }),
    );
  }

  it.effect("accepts distinct Git worktrees and jj workspaces for the same project", () =>
    Effect.gen(function* () {
      const result = yield* withWorkspace({ coexist: true, gitListed: true });
      assert.isTrue(result.accepted);
      assert.isTrue(result.descendantAccepted);
      assert.equal(result.assertion._tag, "Success");
      assert.isTrue(result.gitAccepted);
      assert.deepEqual(result.calls.git, Array(4).fill(result.projectRoot));
      assert.deepEqual(result.calls.jj, Array(4).fill(result.projectRoot));
      assert.deepEqual(result.calls.detect, Array(4).fill(result.projectRoot));
    }),
  );

  it.effect("keeps registered jj roots when Git worktree listing fails", () =>
    Effect.gen(function* () {
      const result = yield* withWorkspace({ failure: "git-list" });
      assert.isTrue(result.accepted);
      assert.isTrue(result.descendantAccepted);
      assert.equal(result.assertion._tag, "Success");
      assert.deepEqual(result.calls.git, Array(3).fill(result.projectRoot));
      assert.deepEqual(result.calls.jj, Array(3).fill(result.projectRoot));
    }),
  );

  it.effect("fails closed when Git worktree listing fails", () =>
    Effect.gen(function* () {
      const result = yield* withWorkspace({ kind: "git", failure: "list" });
      assert.isFalse(result.accepted);
      assert.isFalse(result.descendantAccepted);
      assert.equal(result.assertion._tag, "Failure");
      assert.deepEqual(result.calls.jj, []);
    }),
  );
});
