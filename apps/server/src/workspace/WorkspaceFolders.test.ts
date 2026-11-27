import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, type ProjectTrackedFolder } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TaskFolderStore from "./TaskFolderStore.ts";
import * as WorkspaceFolders from "./WorkspaceFolders.ts";

const projectId = ProjectId.make("project:workspace-folders");

const layerFor = (project?: {
  readonly workspaceRoot: string;
  readonly trackedFolders: ReadonlyArray<ProjectTrackedFolder>;
}) =>
  WorkspaceFolders.layer.pipe(
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () =>
          project === undefined
            ? Effect.succeedNone
            : Effect.succeedSome({
                projectId,
                title: "Project",
                hasCustomTitle: false,
                defaultModelSelection: null,
                defaultThreadEnvMode: null,
                autoPull: false,
                faviconPath: null,
                projectIcon: null,
                scripts: [],
                pinnedAt: null,
                archivedAt: null,
                createdAt: "2026-06-21T00:00:00.000Z",
                updatedAt: "2026-06-21T00:00:00.000Z",
                deletedAt: null,
                ...project,
              }),
      }),
    ),
    Layer.provideMerge(TaskFolderStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
  );

// Resolved, so a symlinked temp directory does not show up as a second spelling of each path.
const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-workspace-folders-" }),
  );
});

it("matches reopened submodule sections by their decoded, case-sensitive names", () => {
  const gitmodules = String.raw`
[submodule.Legacy] path = stale
[SUBMODULE "le\gacy"] path = real
[submodule "Legacy"] path = another
`;
  assert.deepEqual(WorkspaceFolders.parseGitmodulesPaths(gitmodules), ["real", "another"]);
});

it.layer(NodeServices.layer)("WorkspaceFolders", (it) => {
  it.effect("scans child repositories and the folders a code-workspace file lists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tmp = yield* makeTempDir;
      const root = path.join(tmp, "wrapper");
      const outside = path.join(tmp, "outside");
      // Labels are cut at 128 UTF-16 units; an emoji across the cut is left out whole.
      const cut = `${"a".repeat(127)}🚀`;
      const fits = `${"b".repeat(126)}🚀`;
      const padded = `${" ".repeat(127)}🚀`;
      for (const folder of [
        ".git",
        `${cut}/.git`,
        `${fits}/.git`,
        `${padded}/.git`,
        "api/.git",
        "web/.git",
        "unrelated/.git",
        "sub/.git",
        "libs/hash/.git",
        "libs/semi/.git",
        "libs/a#b/.git",
        "libs/cont/.git",
        "libs/inline/.git",
        "extra/repo/.git",
        "extra/joined/.git",
        " notes",
        "notes",
        "src/svc/.git",
        "tree",
        ".hidden/.git",
        "node_modules/.git",
        "../outside/.git",
      ]) {
        yield* fileSystem.makeDirectory(path.join(root, folder), { recursive: true });
      }
      if (!(yield* HostProcess.isWindows)) {
        yield* fileSystem.makeDirectory(path.join(root, "trailing "), { recursive: true });
      }
      yield* fileSystem.symlink(outside, path.join(root, "linked"));
      yield* fileSystem.symlink(root, path.join(root, "self"));
      // A worktree of `api`: its history is that repository's.
      yield* fileSystem.writeFileString(
        path.join(root, "tree", ".git"),
        `gitdir: ${path.join(root, "api", ".git", "worktrees", "tree")}\n`,
      );
      // Read as Git reads it: comments, quotes, escapes and keys outside `submodule` sections.
      yield* fileSystem.writeFileString(
        path.join(root, ".gitmodules"),
        [
          "[include]",
          "\tpath = extra/repo",
          '[submodule "sub"]',
          "\tpath = unrelated",
          "\tpath = sub",
          "\turl = https://example.test/sub.git",
          '[submodule "hash"]',
          "\tpath = libs/hash # pinned",
          '[submodule "semi"]',
          "\tpath = libs/semi ; pinned",
          '[submodule "quoted"]',
          '\tpath = "libs/a#b"',
          '[submodule "cont"]',
          "\tpath = libs/\\",
          "cont",
          '[submodule "inline"] path = libs/inline',
          '[submodule "joined"]',
          "\turl = https://example.test/joined.git\\",
          "\tpath = extra/joined",
          "",
        ].join("\n"),
      );
      yield* fileSystem.writeFileString(
        path.join(root, "team.code-workspace"),
        `{
          // Editors write comments and trailing commas here.
          "folders": [
            // Entries that lead nowhere take none of the room the real ones need.
            ${Array.from({ length: 130 }, (_, index) => `{ "path": "gone-${index}" },`).join("")}
            { "path": "api", "name": "API" },
            { "path": " notes", "name": "Intended" },
            { "path": "notes" },
            { "path": "trailing /", "name": "TrailingSlash" },
            { "path": "../outside" },
            { "path": "gone" },
            { "path": "." },
          ],
        }`,
      );

      const workspaceFolders = yield* WorkspaceFolders.WorkspaceFolders;
      assert.deepEqual(yield* workspaceFolders.scan({ workspaceRoot: `${root}${path.sep}` }), {
        workspaceRoot: root,
        isGitRepository: true,
        codeWorkspaceFile: path.join(root, "team.code-workspace"),
        folders: [
          {
            path: path.join(root, "api"),
            name: "API",
            isGitRepository: true,
            source: "code-workspace",
          },
          {
            path: path.join(root, " notes"),
            name: "Intended",
            isGitRepository: false,
            source: "code-workspace",
          },
          {
            path: path.join(root, "notes"),
            name: "notes",
            isGitRepository: false,
            source: "code-workspace",
          },
          { path: outside, name: "outside", isGitRepository: true, source: "code-workspace" },
          { path: path.join(root, padded), name: "🚀", isGitRepository: true, source: "child" },
          {
            path: path.join(root, cut),
            name: "a".repeat(127),
            isGitRepository: true,
            source: "child",
          },
          { path: path.join(root, fits), name: fits, isGitRepository: true, source: "child" },
          // One level below a plain folder is looked into.
          {
            path: path.join(root, "extra", "joined"),
            name: "joined",
            isGitRepository: true,
            source: "child",
          },
          {
            path: path.join(root, "extra", "repo"),
            name: "repo",
            isGitRepository: true,
            source: "child",
          },
          {
            path: path.join(root, "src", "svc"),
            name: "svc",
            isGitRepository: true,
            source: "child",
          },
          {
            path: path.join(root, "unrelated"),
            name: "unrelated",
            isGitRepository: true,
            source: "child",
          },
          { path: path.join(root, "web"), name: "web", isGitRepository: true, source: "child" },
        ],
      });
      assert.equal(
        (yield* workspaceFolders.scan({ workspaceRoot: path.join(root, "gone") }).pipe(Effect.flip))
          ._tag,
        "WorkspaceFoldersError",
      );
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("finds the repositories inside a project folder from disk each time", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tmp = yield* makeTempDir;
      const workspaceRoot = path.join(tmp, "wrapper");
      const outside = path.join(tmp, "outside");
      const repository = (name: string) => path.join(workspaceRoot, "src", name);
      for (const folder of ["src/api/.git", "src/notes", "docs/.git", "vendor/big/.git", "tree"]) {
        yield* fileSystem.makeDirectory(path.join(workspaceRoot, folder), { recursive: true });
      }
      // A worktree of `docs` follows that repository, even when a workspace file lists it.
      yield* fileSystem.writeFileString(
        path.join(workspaceRoot, "tree", ".git"),
        `gitdir: ${path.join(workspaceRoot, "docs", ".git", "worktrees", "tree")}\n`,
      );
      yield* fileSystem.writeFileString(
        path.join(workspaceRoot, "team.code-workspace"),
        JSON.stringify({ folders: [{ path: "tree" }] }),
      );
      yield* fileSystem.makeDirectory(path.join(outside, ".git"), { recursive: true });
      // A link to a repository elsewhere is not inside the project.
      yield* fileSystem.symlink(outside, path.join(workspaceRoot, "linked"));
      yield* fileSystem.writeFileString(
        path.join(workspaceRoot, "t3.json"),
        JSON.stringify({ ignoreRepositories: ["vendor/big"] }),
      );
      // The stored list is only trusted for what someone added.
      const trackedFolders = [
        { path: path.join(workspaceRoot, "gone"), name: "gone", discovered: true },
        { path: outside, name: "Outside" },
      ];

      yield* Effect.gen(function* () {
        const workspaceFolders = yield* WorkspaceFolders.WorkspaceFolders;
        const listed = Effect.map(workspaceFolders.list({ projectId }), ({ folders }) =>
          folders.map((folder) => [folder.name, folder.path]),
        );
        assert.deepEqual(yield* listed, [
          ["docs", path.join(workspaceRoot, "docs")],
          ["api", repository("api")],
          ["Outside", outside],
        ]);
        yield* fileSystem.makeDirectory(path.join(repository("web"), ".git"), { recursive: true });
        yield* fileSystem.remove(repository("api"), { recursive: true });
        assert.deepEqual(yield* listed, [
          ["docs", path.join(workspaceRoot, "docs")],
          ["web", repository("web")],
          ["Outside", outside],
        ]);
      }).pipe(Effect.provide(layerFor({ workspaceRoot, trackedFolders })));
    }),
  );

  it.effect("does not walk a project's folders when t3.json ignores the whole project", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* makeTempDir;
      for (const folder of ["api/.git", "src/web/.git", "notes"]) {
        yield* fileSystem.makeDirectory(path.join(workspaceRoot, folder), { recursive: true });
      }
      yield* fileSystem.writeFileString(
        path.join(workspaceRoot, "t3.json"),
        JSON.stringify({ ignoreRepositories: ["."] }),
      );
      const probed: Array<string> = [];
      const counting = FileSystem.FileSystem.of({
        ...fileSystem,
        readDirectory: (target, options) => {
          probed.push(target);
          return fileSystem.readDirectory(target, options);
        },
        stat: (target) => {
          probed.push(target);
          return fileSystem.stat(target);
        },
      });

      const found = yield* WorkspaceFolders.discoverFolders(workspaceRoot).pipe(
        Effect.provideService(FileSystem.FileSystem, counting),
      );

      assert.deepEqual(found, []);
      assert.deepEqual(
        probed.filter((target) => target !== workspaceRoot),
        [],
      );
    }),
  );

  it.effect("keeps the folders someone added when a project holds more than fit", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tmp = yield* makeTempDir;
      const workspaceRoot = path.join(tmp, "wrapper");
      const outside = path.join(tmp, "outside");
      const longName = "r".repeat(200);
      yield* Effect.forEach(
        [longName, ...Array.from({ length: 130 }, (_, index) => `s${index}`)],
        (name) =>
          fileSystem.makeDirectory(path.join(workspaceRoot, "src", name, ".git"), {
            recursive: true,
          }),
        { discard: true },
      );
      yield* fileSystem.makeDirectory(outside, { recursive: true });

      yield* Effect.gen(function* () {
        const workspaceFolders = yield* WorkspaceFolders.WorkspaceFolders;
        const { folders } = yield* workspaceFolders.list({ projectId });
        assert.equal(folders.length, 128);
        assert.deepEqual(
          [folders[0]!.name, folders[0]!.path],
          ["r".repeat(128), path.join(workspaceRoot, "src", longName)],
        );
        assert.deepEqual([folders.at(-1)!.name, folders.at(-1)!.path], ["Outside", outside]);
      }).pipe(
        Effect.provide(
          layerFor({ workspaceRoot, trackedFolders: [{ path: outside, name: "Outside" }] }),
        ),
      );
    }),
  );

  it.effect("reports each tracked folder's state and grants a thread the ones outside", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tmp = yield* makeTempDir;
      const workspaceRoot = path.join(tmp, "app");
      const folder = (name: string, ...segments: ReadonlyArray<string>) => ({
        name,
        path: path.join(tmp, ...segments),
      });
      const inside = folder("web", "app", "packages", "web");
      const repository = folder("api", "api");
      const missing = folder("gone", "gone");
      const linked = folder("shared", "app", "linked");
      const shared = path.join(tmp, "shared");
      const worktree = path.join(tmp, "tree");
      // `lib` is checked out with a submodule of its own; `docs` was never initialized. A path
      // listed twice is one submodule. Git reads config keys in any case, so `PATH` declares one.
      // `ext` is a symlink out of the repository, so what it leads to is no submodule of it.
      const gitmodules =
        '[submodule "lib"]\n\tpath = vendor/lib\n[submodule "docs"]\n\tpath = docs\n[submodule "again"]\n\tpath = vendor/lib\n[submodule "out"]\n\tpath = ext/x\n';
      for (const root of [workspaceRoot, worktree]) {
        yield* fileSystem.makeDirectory(path.join(root, "vendor", "lib", "deep", ".git"), {
          recursive: true,
        });
        yield* fileSystem.makeDirectory(path.join(root, "docs"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(root, "vendor", "lib", ".git"), "gitdir: x\n");
        yield* fileSystem.writeFileString(path.join(root, ".gitmodules"), gitmodules);
        yield* fileSystem.writeFileString(
          path.join(root, "vendor", "lib", ".gitmodules"),
          '[submodule "deep"]\n\tPATH = deep\n',
        );
      }
      for (const directory of [inside.path, path.join(repository.path, ".git"), shared]) {
        yield* fileSystem.makeDirectory(directory, { recursive: true });
      }
      yield* fileSystem.symlink(shared, linked.path);
      yield* fileSystem.makeDirectory(path.join(tmp, "elsewhere", "x", ".git"), {
        recursive: true,
      });
      yield* fileSystem.symlink(path.join(tmp, "elsewhere"), path.join(workspaceRoot, "ext"));

      yield* Effect.gen(function* () {
        const workspaceFolders = yield* WorkspaceFolders.WorkspaceFolders;
        assert.deepEqual(yield* workspaceFolders.list({ projectId }), {
          folders: [
            { ...inside, state: "plain" },
            { ...repository, state: "git" },
            { ...missing, state: "missing" },
            { ...linked, state: "plain" },
          ],
        });
        assert.deepEqual(yield* workspaceFolders.forThread({ projectId, worktreePath: null }), {
          folders: [
            { ...inside, isGitRepository: false },
            { ...repository, isGitRepository: true },
            { ...linked, isGitRepository: false },
          ],
          // A symlink inside the project folder still leads outside it.
          extraRoots: [repository.path, linked.path, shared],
        });
        assert.deepEqual(yield* workspaceFolders.forThread({ projectId, worktreePath: worktree }), {
          folders: [],
          extraRoots: [],
        });
        const { folders } = yield* workspaceFolders.forThread({ projectId, worktreePath: null });
        assert.deepEqual(
          yield* workspaceFolders.submodules({ projectId, worktreePath: null, folders }),
          [
            { name: "lib", path: path.join(workspaceRoot, "vendor", "lib"), isGitRepository: true },
            {
              name: "deep",
              path: path.join(workspaceRoot, "vendor", "lib", "deep"),
              isGitRepository: true,
            },
          ],
        );
        // A worktree reaches its own submodules, named by where the project folder has them.
        assert.deepEqual(
          yield* workspaceFolders.submodules({ projectId, worktreePath: worktree, folders: [] }),
          [
            {
              name: "lib",
              path: path.join(worktree, "vendor", "lib"),
              isGitRepository: true,
              repositoryPath: path.join(workspaceRoot, "vendor", "lib"),
            },
            {
              name: "deep",
              path: path.join(worktree, "vendor", "lib", "deep"),
              isGitRepository: true,
              repositoryPath: path.join(workspaceRoot, "vendor", "lib", "deep"),
            },
          ],
        );
      }).pipe(
        Effect.provide(
          layerFor({ workspaceRoot, trackedFolders: [inside, repository, missing, linked] }),
        ),
      );
    }),
  );
  it.effect("gives a task folder thread its worktrees, never the checkouts they came from", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tmp = yield* makeTempDir;
      const ctx = path.join(tmp, "x", "ctx");
      const app = path.join(tmp, "x", "app");
      const lib = path.join(ctx, "vendor", "lib");
      // The worktrees directory is reached through a symlink, as on a machine that moved it.
      const realWorktrees = path.join(tmp, "disk", "worktrees");
      const worktrees = path.join(tmp, "worktrees");
      const taskRoot = path.join(worktrees, "x", "feature-0123");
      for (const directory of [
        lib,
        app,
        path.join(realWorktrees, "x", "feature-0123", "ctx", "vendor", "lib"),
        path.join(realWorktrees, "x", "feature-0123", "app"),
        path.join(realWorktrees, "x", "single"),
      ]) {
        yield* fileSystem.makeDirectory(directory, { recursive: true });
      }
      yield* fileSystem.symlink(realWorktrees, worktrees);
      const trackedFolders = [
        { name: "app", path: app },
        { name: "lib", path: lib },
      ];

      yield* Effect.gen(function* () {
        const taskFolders = yield* TaskFolderStore.TaskFolderStore;
        const workspaceFolders = yield* WorkspaceFolders.WorkspaceFolders;
        const taskFolder = {
          root: taskRoot,
          projectId,
          projectRoot: ctx,
          anchor: path.join(tmp, "x"),
          projectPath: path.join(taskRoot, "ctx"),
          projectIsWorktree: true,
          repositories: [
            { repositoryPath: app, worktreePath: path.join(taskRoot, "app"), name: "app" },
            {
              repositoryPath: lib,
              worktreePath: path.join(taskRoot, "ctx", "vendor", "lib"),
              name: "lib",
            },
          ],
        };
        yield* taskFolders.put(taskFolder);
        const expected = {
          folders: [
            {
              name: "app",
              path: path.join(taskRoot, "app"),
              isGitRepository: true,
              repositoryPath: app,
            },
            {
              name: "lib",
              path: path.join(taskRoot, "ctx", "vendor", "lib"),
              isGitRepository: true,
              repositoryPath: lib,
            },
          ],
          // Only the sibling lies outside the thread's folder, under both of its spellings.
          extraRoots: [
            path.join(taskRoot, "app"),
            path.join(realWorktrees, "x", "feature-0123", "app"),
          ],
        };
        // The thread stores the path as named; a sandbox or Git may hand back the resolved one.
        for (const worktreePath of [
          path.join(taskRoot, "ctx"),
          path.join(realWorktrees, "x", "feature-0123", "ctx"),
        ]) {
          assert.deepEqual(
            yield* workspaceFolders.forThread({ projectId, worktreePath }),
            expected,
          );
        }
        assert.deepEqual(
          yield* taskFolders.findContaining(
            path.join(realWorktrees, "x", "feature-0123", "app", "src"),
          ),
          taskFolder,
        );
        // A single worktree beside it is no task folder.
        assert.deepEqual(
          yield* workspaceFolders.forThread({
            projectId,
            worktreePath: path.join(worktrees, "x", "single"),
          }),
          { folders: [], extraRoots: [] },
        );
      }).pipe(Effect.provide(layerFor({ workspaceRoot: ctx, trackedFolders })));
    }),
  );
  it.effect("gives a task folder thread the tracked repositories checked out in it later", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tmp = yield* makeTempDir;
      const project = path.join(tmp, "project");
      const taskRoot = path.join(tmp, "worktrees", "feature");
      for (const name of ["web", "backend", "mobile"]) {
        yield* fileSystem.makeDirectory(path.join(project, name, ".git"), { recursive: true });
      }
      yield* fileSystem.makeDirectory(path.join(taskRoot, "web"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(taskRoot, "mobile"), { recursive: true });
      // A linked worktree keeps `.git` as a file; `mobile` was never checked out.
      yield* fileSystem.writeFileString(path.join(taskRoot, "web", ".git"), "gitdir: elsewhere\n");

      yield* Effect.gen(function* () {
        const taskFolders = yield* TaskFolderStore.TaskFolderStore;
        const workspaceFolders = yield* WorkspaceFolders.WorkspaceFolders;
        yield* taskFolders.put({
          root: taskRoot,
          projectId,
          projectRoot: project,
          anchor: project,
          projectPath: taskRoot,
          projectIsWorktree: true,
          repositories: [],
        });
        assert.deepEqual(yield* workspaceFolders.forThread({ projectId, worktreePath: taskRoot }), {
          folders: [
            {
              name: "web",
              path: path.join(taskRoot, "web"),
              isGitRepository: true,
              repositoryPath: path.join(project, "web"),
            },
          ],
          extraRoots: [],
        });
      }).pipe(Effect.provide(layerFor({ workspaceRoot: project, trackedFolders: [] })));
    }),
  );
});
