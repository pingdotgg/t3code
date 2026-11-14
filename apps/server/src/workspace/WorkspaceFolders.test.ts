import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, type ProjectTrackedFolder } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
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
  );

// Resolved, so a symlinked temp directory does not show up as a second spelling of each path.
const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-workspace-folders-" }),
  );
});

it.layer(NodeServices.layer)("WorkspaceFolders", (it) => {
  it.effect("scans child repositories and the folders a code-workspace file lists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tmp = yield* makeTempDir;
      const root = path.join(tmp, "wrapper");
      const outside = path.join(tmp, "outside");
      for (const folder of [
        ".git",
        "api/.git",
        "web/.git",
        "sub/.git",
        "notes",
        ".hidden/.git",
        "node_modules/.git",
        "../outside/.git",
      ]) {
        yield* fileSystem.makeDirectory(path.join(root, folder), { recursive: true });
      }
      yield* fileSystem.symlink(outside, path.join(root, "linked"));
      yield* fileSystem.symlink(root, path.join(root, "self"));
      yield* fileSystem.writeFileString(
        path.join(root, ".gitmodules"),
        '[submodule "sub"]\n\tpath = sub\n\turl = https://example.test/sub.git\n',
      );
      yield* fileSystem.writeFileString(
        path.join(root, "team.code-workspace"),
        `{
          // Editors write comments and trailing commas here.
          "folders": [
            { "path": "api", "name": "API" },
            { "path": "notes" },
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
            path: path.join(root, "notes"),
            name: "notes",
            isGitRepository: false,
            source: "code-workspace",
          },
          { path: outside, name: "outside", isGitRepository: true, source: "code-workspace" },
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
      for (const directory of [inside.path, path.join(repository.path, ".git"), shared]) {
        yield* fileSystem.makeDirectory(directory, { recursive: true });
      }
      yield* fileSystem.symlink(shared, linked.path);

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
        assert.deepEqual(
          yield* workspaceFolders.forThread({ projectId, worktreePath: path.join(tmp, "tree") }),
          { folders: [], extraRoots: [] },
        );
      }).pipe(
        Effect.provide(
          layerFor({ workspaceRoot, trackedFolders: [inside, repository, missing, linked] }),
        ),
      );
    }),
  );
});
