import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EventId, ProjectId, type ProjectTrackedFolder } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as TaskFolders from "./TaskFolders.ts";
import * as WorkspaceRepositories from "./WorkspaceRepositories.ts";

const NOW = "2026-10-27T00:00:00.000Z";

const layerTest = WorkspaceRepositories.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(Layer.mergeAll(ProjectStore.layer, TaskFolders.layer)),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-workspace-repos-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const git = Effect.fn("WorkspaceRepositoriesTest.git")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* driver.execute({ operation: "WorkspaceRepositoriesTest.git", cwd, args });
  return result.stdout.trim();
});

const write = Effect.fn("WorkspaceRepositoriesTest.write")(function* (file: string, contents = "") {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
  yield* fileSystem.writeFileString(file, contents);
});

/** A temp folder holding `home` plus whatever folders the test builds beside it. */
const makeBase = Effect.fn("WorkspaceRepositoriesTest.makeBase")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workspace-repos-" });
  const at = (...segments: ReadonlyArray<string>) => path.join(base, ...segments);
  const makeRepo = Effect.fn("WorkspaceRepositoriesTest.makeRepo")(function* (folder: string) {
    yield* fileSystem.makeDirectory(folder, { recursive: true });
    yield* git(folder, ["init", "--quiet"]);
  });
  return { base, at, makeRepo };
});

const createProject = Effect.fn("WorkspaceRepositoriesTest.createProject")(function* (
  workspaceRoot: string,
  folders: ReadonlyArray<string>,
) {
  const path = yield* Path.Path;
  // Temp folders are unique, so the shared store never sees one id twice.
  const projectId = ProjectId.make(`project:${workspaceRoot}`);
  const trackedFolders: ReadonlyArray<ProjectTrackedFolder> = folders.map((folder) => ({
    path: folder,
    name: path.basename(folder),
  }));
  yield* (yield* ProjectStore.ProjectStoreV2).apply({
    sequence: 1,
    eventId: EventId.make(`event-${projectId}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: path.basename(workspaceRoot),
      workspaceRoot,
      defaultModelSelection: null,
      scripts: [],
      trackedFolders,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
  return projectId;
});

/** Isolates Git from the machine's config so commits neither sign nor guess an identity. */
const isolateGitConfig = Effect.fn("WorkspaceRepositoriesTest.isolateGitConfig")(function* (
  config: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-config-" });
  const file = path.join(directory, "gitconfig");
  yield* fileSystem.writeFileString(file, config);
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      vi.stubEnv("GIT_CONFIG_GLOBAL", file);
      vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    }),
    () => Effect.sync(() => vi.unstubAllEnvs()),
  );
});

it.layer(layerTest, { excludeTestServices: true })("WorkspaceRepositories", (it) => {
  describe("resolveThreadWorkspace", () => {
    it.effect("finds the repos in a plain-folder home, beside it, and the missing ones", () =>
      Effect.gen(function* () {
        const repositories = yield* WorkspaceRepositories.WorkspaceRepositories;
        const fileSystem = yield* FileSystem.FileSystem;
        const { at, makeRepo } = yield* makeBase();
        const home = at("wrapper");
        yield* makeRepo(at("wrapper", "api"));
        yield* makeRepo(at("wrapper", "web"));
        yield* makeRepo(at("app"));
        yield* fileSystem.makeDirectory(at("wrapper", "notes"), { recursive: true });
        yield* fileSystem.makeDirectory(at("docs"), { recursive: true });
        const projectId = yield* createProject(home, [
          at("wrapper", "api"),
          at("wrapper", "web"),
          at("wrapper", "notes"),
          at("app"),
          at("docs"),
          at("gone"),
        ]);

        const workspace = yield* repositories.resolveThreadWorkspace({
          projectId,
          worktreePath: null,
        });
        assert.equal(workspace.cwd, home);
        assert.isNull(workspace.taskFolder);
        assert.deepEqual(
          workspace.repositories.map(({ name, relativePath, kind, cwd }) => ({
            name,
            relativePath,
            kind,
            cwd,
          })),
          [
            { name: "api", relativePath: "api", kind: "repository", cwd: at("wrapper", "api") },
            { name: "web", relativePath: "web", kind: "repository", cwd: at("wrapper", "web") },
            { name: "app", relativePath: "../app", kind: "repository", cwd: at("app") },
          ],
        );
        assert.deepEqual(workspace.references, [{ name: "docs", path: at("docs") }]);
        assert.isTrue(WorkspaceRepositories.isMultiRepoWorkspace(workspace));

        const listed = yield* repositories.listForClient({ projectId, cwd: home });
        assert.deepEqual(
          listed.repositories.map(({ name, relativePath, missing }) => ({
            name,
            relativePath,
            missing,
          })),
          [
            { name: "api", relativePath: "api", missing: false },
            { name: "web", relativePath: "web", missing: false },
            { name: "app", relativePath: "../app", missing: false },
            { name: "gone", relativePath: "../gone", missing: true },
          ],
        );
        assert.deepEqual(listed.references, [{ name: "docs", path: at("docs"), missing: false }]);
        assert.isNull(listed.taskFolder);
      }),
    );

    it.effect("keeps home first and ignores plain folders inside a Git home", () =>
      Effect.gen(function* () {
        const repositories = yield* WorkspaceRepositories.WorkspaceRepositories;
        const { at, makeRepo } = yield* makeBase();
        const home = at("home");
        yield* makeRepo(home);
        yield* write(at("home", ".gitignore"), "/api/\n");
        yield* write(at("home", "packages", "ui", "index.ts"));
        yield* makeRepo(at("home", "api"));
        const projectId = yield* createProject(home, [
          at("home", "api"),
          at("home", "packages", "ui"),
        ]);

        const workspace = yield* repositories.resolveThreadWorkspace({
          projectId,
          worktreePath: null,
        });
        assert.deepEqual(
          workspace.repositories.map(({ name, relativePath, kind, originalPath }) => ({
            name,
            relativePath,
            kind,
            originalPath,
          })),
          [
            { name: "home", relativePath: "", kind: "home", originalPath: home },
            {
              name: "api",
              relativePath: "api",
              kind: "repository",
              originalPath: at("home", "api"),
            },
          ],
        );
        assert.deepEqual(workspace.references, []);
      }),
    );

    it.effect("gives a single-repo project its home only, or nothing for a plain folder", () =>
      Effect.gen(function* () {
        const repositories = yield* WorkspaceRepositories.WorkspaceRepositories;
        const fileSystem = yield* FileSystem.FileSystem;
        const { at, makeRepo } = yield* makeBase();
        yield* makeRepo(at("repo"));
        yield* fileSystem.makeDirectory(at("plain"));
        const repoProject = yield* createProject(at("repo"), []);
        const plainProject = yield* createProject(at("plain"), []);

        const repoWorkspace = yield* repositories.resolveThreadWorkspace({
          projectId: repoProject,
          worktreePath: null,
        });
        assert.deepEqual(
          repoWorkspace.repositories.map(({ kind, cwd }) => ({ kind, cwd })),
          [{ kind: "home", cwd: at("repo") }],
        );
        assert.isFalse(WorkspaceRepositories.isMultiRepoWorkspace(repoWorkspace));
        const plainWorkspace = yield* repositories.resolveThreadWorkspace({
          projectId: plainProject,
          worktreePath: null,
        });
        assert.deepEqual(plainWorkspace.repositories, []);
        assert.deepEqual(plainWorkspace.references, []);
      }),
    );

    it.effect("uses a task folder's worktrees and keeps the plain references", () =>
      Effect.gen(function* () {
        const repositories = yield* WorkspaceRepositories.WorkspaceRepositories;
        const taskFolders = yield* TaskFolders.TaskFolderStore;
        const fileSystem = yield* FileSystem.FileSystem;
        const { at, makeRepo } = yield* makeBase();
        yield* makeRepo(at("home"));
        yield* makeRepo(at("app"));
        yield* makeRepo(at("lib"));
        yield* fileSystem.makeDirectory(at("docs"));
        const projectId = yield* createProject(at("home"), [at("app"), at("lib"), at("docs")]);
        const root = at("tasks", "fix-login");
        yield* fileSystem.makeDirectory(at("tasks", "fix-login", "home"), { recursive: true });
        yield* fileSystem.makeDirectory(at("tasks", "fix-login", "app"), { recursive: true });
        const row = { baseRef: "main", branch: "t3/fix-login" };
        yield* taskFolders.upsert({
          root,
          projectId,
          homeWorktreePath: at("tasks", "fix-login", "home"),
          repositories: [
            {
              ...row,
              kind: "home",
              name: "home",
              originalPath: at("home"),
              worktreePath: at("tasks", "fix-login", "home"),
              relativePath: "",
            },
            {
              ...row,
              kind: "repository",
              name: "app",
              originalPath: at("app"),
              worktreePath: at("tasks", "fix-login", "app"),
              relativePath: "../app",
            },
          ],
          createdAt: NOW,
          updatedAt: NOW,
        });

        const workspace = yield* repositories.resolveThreadWorkspace({
          projectId,
          worktreePath: at("tasks", "fix-login", "home"),
        });
        assert.equal(workspace.cwd, at("tasks", "fix-login", "home"));
        assert.equal(workspace.taskFolder?.root, root);
        assert.deepEqual(
          workspace.repositories.map(({ name, cwd, originalPath, relativePath }) => ({
            name,
            cwd,
            originalPath,
            relativePath,
          })),
          [
            {
              name: "home",
              cwd: at("tasks", "fix-login", "home"),
              originalPath: at("home"),
              relativePath: "",
            },
            {
              name: "app",
              cwd: at("tasks", "fix-login", "app"),
              originalPath: at("app"),
              relativePath: "../app",
            },
          ],
        );
        // The unselected Git repo stays out; the plain folder is still a reference.
        assert.deepEqual(workspace.references, [{ name: "docs", path: at("docs") }]);
      }),
    );
  });

  describe("scanFolders", () => {
    it.effect("lists child repos and one workspace file's folders, skipping submodules", () =>
      Effect.gen(function* () {
        const repositories = yield* WorkspaceRepositories.WorkspaceRepositories;
        const fileSystem = yield* FileSystem.FileSystem;
        const { at, makeRepo } = yield* makeBase();
        const home = at("home");
        yield* makeRepo(home);
        yield* write(at("home", ".gitignore"), "/api/\n");
        yield* makeRepo(at("home", "api"));
        yield* makeRepo(at("home", "node_modules"));
        yield* makeRepo(at("home", ".tools"));
        yield* write(at("home", ".gitmodules"), '[submodule "vendor"]\n\tpath = "vendor"\n');
        yield* write(at("home", "vendor", ".git"), "gitdir: ../.git/modules/vendor\n");
        yield* fileSystem.makeDirectory(at("home", "plain"));
        yield* fileSystem.makeDirectory(at("home", "libs", "core"), { recursive: true });
        yield* makeRepo(at("app"));
        yield* write(
          at("home", "acme.code-workspace"),
          `{
  // The repos this workspace opens.
  "folders": [
    { "path": "." },
    { "path": "../app", },
    { "path": "libs/core", "name": "Core" },
    { "path": "missing" },
  ],
  "settings": {},
}`,
        );
        yield* write(at("home", "zeta.code-workspace"), '{ "folders": [{ "path": "plain" }] }');

        const result = yield* repositories.scanFolders({ workspaceRoot: home });
        assert.isTrue(result.homeIsGitRepository);
        assert.equal(result.codeWorkspaceFile, at("home", "acme.code-workspace"));
        assert.deepEqual(result.folders, [
          { path: at("app"), name: "app", isGitRepository: true, source: "code-workspace" },
          { path: at("home", "api"), name: "api", isGitRepository: true, source: "child" },
          {
            path: at("home", "libs", "core"),
            name: "Core",
            isGitRepository: false,
            source: "code-workspace",
          },
        ]);
      }),
    );
  });

  describe("home Git initialization", () => {
    it.effect("previews without touching home, then commits the same files", () =>
      Effect.gen(function* () {
        const repositories = yield* WorkspaceRepositories.WorkspaceRepositories;
        const fileSystem = yield* FileSystem.FileSystem;
        yield* isolateGitConfig("[user]\n\tname = Test\n\temail = test@example.com\n");
        const { at, makeRepo } = yield* makeBase();
        const home = at("home");
        yield* write(at("home", "README.md"), "# Home\n");
        yield* write(at("home", "scripts", "setup.sh"), "vp i\n");
        yield* write(at("home", ".env"), "TOKEN=secret\n");
        yield* write(at("home", ".env.local"), "TOKEN=local\n");
        yield* write(at("home", "notes", "plan.md"), "plan\n");
        yield* makeRepo(at("home", "api"));
        yield* write(at("home", "api", "server.ts"), "export {};\n");
        const projectId = yield* createProject(home, [at("home", "api"), at("home", "notes")]);
        const expectedFiles = [".gitignore", "README.md", "notes/plan.md", "scripts/setup.sh"];

        const preview = yield* repositories.previewHomeGitInit({ projectId });
        assert.deepEqual(preview, {
          files: expectedFiles,
          fileCount: expectedFiles.length,
          ignoreEntries: ["/api/", ".env*"],
        });
        assert.isFalse(yield* fileSystem.exists(at("home", ".git")));

        const initialized = yield* repositories.initializeHomeGit({ projectId });
        assert.equal(initialized.fileCount, expectedFiles.length);
        assert.equal(initialized.commitSha, yield* git(home, ["rev-parse", "HEAD"]));
        assert.deepEqual((yield* git(home, ["ls-files"])).split("\n"), expectedFiles);
        assert.equal(
          yield* git(home, ["log", "-1", "--format=%s"]),
          "Initialize home for T3 Code worktrees",
        );
        assert.equal(yield* fileSystem.readFileString(at("home", ".gitignore")), "/api/\n.env*\n");

        const again = yield* repositories.previewHomeGitInit({ projectId }).pipe(Effect.flip);
        assert.include(again.message, "already inside a Git repository");
      }).pipe(Effect.scoped),
    );

    it.effect("refuses to start without a Git identity and leaves home alone", () =>
      Effect.gen(function* () {
        const repositories = yield* WorkspaceRepositories.WorkspaceRepositories;
        const fileSystem = yield* FileSystem.FileSystem;
        yield* isolateGitConfig("[user]\n\tuseConfigOnly = true\n");
        const { at } = yield* makeBase();
        yield* write(at("home", "README.md"), "# Home\n");
        const projectId = yield* createProject(at("home"), []);

        const failure = yield* repositories.initializeHomeGit({ projectId }).pipe(Effect.flip);
        assert.include(failure.message, "Git has no user identity");
        assert.isFalse(yield* fileSystem.exists(at("home", ".git")));
        assert.isFalse(yield* fileSystem.exists(at("home", ".gitignore")));
      }).pipe(Effect.scoped),
    );
  });
});
