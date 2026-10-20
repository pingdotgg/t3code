import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as SqlClient from "effect/sql/SqlClient";
import { ProjectId } from "@t3tools/contracts";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as ReviewService from "./ReviewService.ts";

function layer(input: {
  readonly gitLayer?: typeof GitVcsDriver.layer;
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
  readonly worktreesDirectory?: string;
  readonly previousWorktreesDirectories?: ReadonlyArray<string>;
  readonly projectRoots?: ReadonlyArray<string> | "unavailable";
  readonly threadWorktrees?: ReadonlyArray<{ worktreePath: string; deleted?: boolean }>;
  /** What `git worktree list` reports for every project. */
  readonly gitWorktrees?: ReadonlyArray<string>;
}) {
  const projectRoots = input.projectRoots ?? [];
  return ReviewService.layer.pipe(
    Layer.provide(KnownWorkspaces.layer),
    Layer.provide(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const [index, thread] of (input.threadWorktrees ?? []).entries()) {
            yield* sql`
              INSERT INTO orchestration_v2_projection_threads (
                thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
                created_at, updated_at, deleted_at, payload_json
              ) VALUES (
                ${`thread-${index}`}, 'project-0', 'Thread', 'codex', 'full-access', 'default',
                '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
                ${thread.deleted ? "2026-01-02T00:00:00.000Z" : null},
                ${JSON.stringify({ worktreePath: thread.worktreePath })}
              )
            `;
          }
        }),
      ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    ),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        generateStagedCommitMessage: () => Effect.succeed("Generated staged commit"),
        invalidateLocalStatus: () => Effect.void,
        invalidateStatus: () => Effect.void,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: () =>
          projectRoots === "unavailable"
            ? Effect.fail(
                new ProjectStore.ProjectStoreV2Error({ operation: "list", cause: "offline" }),
              )
            : Effect.succeed(
                projectRoots.map((workspaceRoot, index) => ({
                  id: ProjectId.make(`project-${index}`),
                  title: `Project ${index}`,
                  workspaceRoot,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                })),
              ),
      }),
    ),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: () => Effect.die("unexpected VCS registry get"),
        resolve: () => Effect.die("unexpected VCS registry resolve"),
        detect: (request) =>
          Effect.sync(() => {
            input.detectCalls?.push({ cwd: request.cwd });
            return null;
          }),
      }),
    ),
    Layer.provideMerge(
      input.gitLayer ??
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          listWorktreePaths: () => Effect.succeed([...(input.gitWorktrees ?? [])]),
        }),
    ),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        worktreesDirectory: input.worktreesDirectory ?? "",
        previousWorktreesDirectories: [...(input.previousWorktreesDirectories ?? [])],
      }),
    ),
    Layer.provide(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("ReviewService", () => {
  it.effect("stages a hunk, stages its file, and unstages without changing the working copy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-staging-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-state-" });
      yield* Effect.gen(function* () {
        const git = yield* GitVcsDriver.GitVcsDriver;
        const service = yield* ReviewService.ReviewService;
        const run = (args: ReadonlyArray<string>) =>
          git
            .execute({ operation: "review.test", cwd: workspaceRoot, args })
            .pipe(Effect.map((result) => result.stdout));
        yield* run(["init"]);
        yield* run(["config", "user.name", "Test"]);
        yield* run(["config", "user.email", "test@example.com"]);
        yield* fs.writeFileString(`${workspaceRoot}/file.txt`, "one\ntwo\nthree\n");
        yield* run(["add", "."]);
        yield* run(["commit", "-m", "initial"]);
        const contents = "ONE\ntwo\nTHREE\n";
        yield* fs.writeFileString(`${workspaceRoot}/file.txt`, contents);
        const patch =
          "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n";
        yield* service.setStaged({ cwd: workspaceRoot, paths: ["file.txt"], staged: true, patch });
        assert.include(yield* run(["diff", "--cached"]), "+ONE");
        assert.notInclude(yield* run(["diff", "--cached"]), "+THREE");
        assert.include(yield* run(["diff"]), "+THREE");
        yield* service.setStaged({ cwd: workspaceRoot, paths: ["file.txt"], staged: false, patch });
        assert.equal(yield* run(["diff", "--cached"]), "");
        yield* service.setStaged({ cwd: workspaceRoot, paths: ["file.txt"], staged: true });
        assert.include(yield* run(["diff", "--cached"]), "+THREE");
        yield* service.setStaged({ cwd: workspaceRoot, paths: ["file.txt"], staged: false });
        assert.equal(yield* run(["diff", "--cached"]), "");
        assert.equal(yield* fs.readFileString(`${workspaceRoot}/file.txt`), contents);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, gitLayer: GitVcsDriver.layer })));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "commits only staged content, amends without another commit, and reports a failed push after committing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-commit-" });
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-state-" });
        yield* Effect.gen(function* () {
          const git = yield* GitVcsDriver.GitVcsDriver;
          const service = yield* ReviewService.ReviewService;
          const run = (args: string[]) =>
            git
              .execute({ operation: "review.test", cwd: workspaceRoot, args })
              .pipe(Effect.map((result) => result.stdout.trim()));
          yield* run(["init", "-b", "main"]);
          yield* run(["config", "user.name", "Test"]);
          yield* run(["config", "user.email", "test@example.com"]);
          yield* fs.writeFileString(`${workspaceRoot}/file.txt`, "initial\n");
          yield* run(["add", "."]);
          yield* run(["commit", "-m", "initial"]);
          yield* fs.writeFileString(`${workspaceRoot}/file.txt`, "staged\n");
          yield* run(["add", "file.txt"]);
          yield* fs.writeFileString(`${workspaceRoot}/file.txt`, "unstaged\n");
          const committed = yield* service.commit({
            cwd: workspaceRoot,
            message: "index only",
            action: "commit",
          });
          assert.strictEqual(committed.pushStatus, "not-requested");
          assert.strictEqual(yield* run(["show", "HEAD:file.txt"]), "staged");
          assert.strictEqual(yield* fs.readFileString(`${workspaceRoot}/file.txt`), "unstaged\n");
          const amended = yield* service.commit({
            cwd: workspaceRoot,
            message: "index only",
            action: "amend",
          });
          assert.notStrictEqual(amended.commitSha, "");
          assert.strictEqual(yield* run(["rev-list", "--count", "HEAD"]), "2");
          assert.strictEqual(yield* run(["log", "-1", "--format=%s"]), "index only");
          yield* run(["add", "file.txt"]);
          const pushed = yield* service.commit({
            cwd: workspaceRoot,
            message: "push fails",
            action: "commit-push",
          });
          assert.strictEqual(pushed.pushStatus, "failed");
          assert.strictEqual(yield* run(["show", "HEAD:file.txt"]), "unstaged");
          assert.strictEqual(yield* run(["rev-list", "--count", "HEAD"]), "3");
          const remote = `${baseDir}/remote.git`;
          yield* run(["init", "--bare", remote]);
          yield* run(["remote", "add", "origin", remote]);
          yield* fs.writeFileString(`${workspaceRoot}/file.txt`, "pushed\n");
          yield* run(["add", "file.txt"]);
          const success = yield* service.commit({
            cwd: workspaceRoot,
            message: "local remote",
            action: "commit-push",
          });
          assert.strictEqual(success.pushStatus, "pushed");
          assert.strictEqual(
            yield* run([`--git-dir=${remote}`, "rev-parse", "refs/heads/main"]),
            success.commitSha,
          );
          yield* fs.writeFileString(`${workspaceRoot}/file.txt`, "generated\n");
          yield* run(["add", "file.txt"]);
          yield* fs.writeFileString(`${workspaceRoot}/file.txt`, "still unstaged\n");
          assert.strictEqual(
            yield* service.generateCommitMessage({ cwd: workspaceRoot }),
            "Generated staged commit",
          );
          yield* service.commit({ cwd: workspaceRoot, message: "  ", action: "commit" });
          assert.strictEqual(yield* run(["log", "-1", "--format=%s"]), "Generated staged commit");
          assert.strictEqual(yield* run(["show", "HEAD:file.txt"]), "generated");
          assert.strictEqual(
            yield* fs.readFileString(`${workspaceRoot}/file.txt`),
            "still unstaged\n",
          );
        }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, gitLayer: GitVcsDriver.layer })));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reverts only selected unstaged edits and untracked files while preserving the index and neighboring files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-revert-" });
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-state-" });
        yield* Effect.gen(function* () {
          const git = yield* GitVcsDriver.GitVcsDriver;
          const service = yield* ReviewService.ReviewService;
          const run = (args: string[]) =>
            git
              .execute({ operation: "review.test", cwd: workspaceRoot, args })
              .pipe(Effect.map((result) => result.stdout.trim()));
          yield* run(["init"]);
          yield* run(["config", "user.name", "Test"]);
          yield* run(["config", "user.email", "test@example.com"]);
          yield* fs.makeDirectory(`${workspaceRoot}/src`);
          yield* fs.writeFileString(`${workspaceRoot}/src/[literal].txt`, "initial\n");
          yield* run(["add", "."]);
          yield* run(["commit", "-m", "initial"]);
          yield* fs.writeFileString(`${workspaceRoot}/src/[literal].txt`, "staged\n");
          yield* run(["add", "."]);
          yield* fs.writeFileString(`${workspaceRoot}/src/[literal].txt`, "unstaged\n");
          yield* fs.writeFileString(`${workspaceRoot}/src/new.txt`, "new\n");
          yield* fs.writeFileString(`${workspaceRoot}/keep.txt`, "keep\n");
          yield* service.revert({
            cwd: workspaceRoot,
            paths: ["src/[literal].txt", "src/new.txt"],
          });
          assert.strictEqual(
            yield* fs.readFileString(`${workspaceRoot}/src/[literal].txt`),
            "staged\n",
          );
          assert.strictEqual(yield* run(["show", ":src/[literal].txt"]), "staged");
          assert.strictEqual(yield* fs.exists(`${workspaceRoot}/src/new.txt`), false);
          assert.strictEqual(yield* fs.readFileString(`${workspaceRoot}/keep.txt`), "keep\n");
          const traversal = yield* service
            .revert({ cwd: workspaceRoot, paths: ["../keep.txt"] })
            .pipe(Effect.flip);
          assert.strictEqual(traversal._tag, "GitCommandError");
        }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, gitLayer: GitVcsDriver.layer })));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reverts a hunk or selected addition without changing the index or other edits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-review-partial-revert-",
      });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-state-" });
      yield* Effect.gen(function* () {
        const git = yield* GitVcsDriver.GitVcsDriver;
        const service = yield* ReviewService.ReviewService;
        const run = (args: string[]) =>
          git
            .execute({ operation: "review.test", cwd: workspaceRoot, args })
            .pipe(Effect.map((result) => result.stdout));
        yield* run(["init"]);
        yield* run(["config", "user.name", "Test"]);
        yield* run(["config", "user.email", "test@example.com"]);
        yield* fs.writeFileString(`${workspaceRoot}/file.txt`, "alpha\nbeta\ngamma\ndelta\n");
        yield* run(["add", "."]);
        yield* run(["commit", "-m", "initial"]);
        const index = "ALPHA\nbeta\ngamma\ndelta\n";
        yield* fs.writeFileString(`${workspaceRoot}/file.txt`, index);
        yield* run(["add", "."]);
        yield* fs.writeFileString(
          `${workspaceRoot}/file.txt`,
          "ALPHA\nBETA\nextra\nGAMMA\ndelta\n",
        );
        const header = "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n";
        yield* service.revert({
          cwd: workspaceRoot,
          paths: [],
          patch: header + "@@ -3,0 +3,1 @@\n+extra\n",
        });
        assert.strictEqual(
          yield* fs.readFileString(`${workspaceRoot}/file.txt`),
          "ALPHA\nBETA\nGAMMA\ndelta\n",
        );
        const hunk = header + "@@ -2,1 +2,1 @@\n-beta\n+BETA\n";
        yield* service.revert({ cwd: workspaceRoot, paths: [], patch: hunk });
        assert.strictEqual(
          yield* fs.readFileString(`${workspaceRoot}/file.txt`),
          "ALPHA\nbeta\nGAMMA\ndelta\n",
        );
        assert.strictEqual(yield* run(["show", ":file.txt"]), index);
        const stale = yield* service
          .revert({ cwd: workspaceRoot, paths: [], patch: hunk })
          .pipe(Effect.flip);
        assert.strictEqual(stale._tag, "GitCommandError");
        assert.strictEqual(
          yield* fs.readFileString(`${workspaceRoot}/file.txt`),
          "ALPHA\nbeta\nGAMMA\ndelta\n",
        );
        assert.strictEqual(yield* run(["show", ":file.txt"]), index);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, gitLayer: GitVcsDriver.layer })));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects diff preview cwd outside the configured workspace roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffPreview");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within the configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("attributes file-content workspace violations to the file-content operation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review
          .getDiffFileContents({
            cwd: outsideRoot,
            sourceKind: "working-tree",
            changeType: "change",
            baseRef: "HEAD",
            headRef: null,
            oldPath: "file.ts",
            newPath: "file.ts",
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffFileContents");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within the configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows previous custom worktree locations but never a filesystem root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const previous = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-old-worktrees-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: previous });
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            worktreesDirectory: "/",
            previousWorktreesDirectories: [previous],
          }),
        ),
      );
      assert.strictEqual(result.cwd, previous);

      const rootLink = `${baseDir}/root-link`;
      yield* fs.symlink("/", rootLink);
      for (const worktreesDirectory of ["/", rootLink]) {
        const error = yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
        }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, worktreesDirectory })));
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows registered project roots outside the server cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const projectChild = `${projectRoot}/packages/app`;
      yield* fs.makeDirectory(projectChild, { recursive: true });
      const sibling = `${projectRoot}-sibling`;
      yield* fs.makeDirectory(sibling);
      yield* Effect.addFinalizer(() => fs.remove(sibling, { recursive: true }).pipe(Effect.ignore));

      const review = (cwd: string, projectRoots: ReadonlyArray<string> | "unavailable") =>
        Effect.gen(function* () {
          const service = yield* ReviewService.ReviewService;
          return yield* service.getDiffPreview({ cwd });
        }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, projectRoots })));

      assert.strictEqual((yield* review(projectRoot, [projectRoot])).cwd, projectRoot);
      assert.strictEqual((yield* review(projectChild, [projectRoot])).cwd, projectChild);
      // A child whose name starts with `..` is still inside.
      const dottedChild = `${projectRoot}/..feature`;
      yield* fs.makeDirectory(dottedChild);
      assert.strictEqual((yield* review(dottedChild, [projectRoot])).cwd, dottedChild);
      for (const [cwd, projectRoots] of [
        [sibling, [projectRoot]],
        [projectRoot, []],
        [projectRoot, "unavailable"],
      ] as const) {
        const error = yield* review(cwd, projectRoots).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows the worktree a thread is bound to, and nothing else outside the project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const project = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      // Checkouts outside every managed folder, as `git worktree add ../feature` makes.
      const bound = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-bound-" });
      const deleted = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-deleted-" });
      const unbound = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-unbound-" });
      // A client can set a thread's path to any folder; git doesn't list this one.
      const claimed = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-claimed-" });
      yield* fs.makeDirectory(`${bound}/sub`);

      const review = (cwd: string) =>
        Effect.gen(function* () {
          const service = yield* ReviewService.ReviewService;
          return yield* service.getDiffPreview({ cwd });
        }).pipe(
          Effect.provide(
            layer({
              workspaceRoot,
              baseDir,
              projectRoots: [project],
              gitWorktrees: [project, bound, deleted],
              threadWorktrees: [
                { worktreePath: bound },
                { worktreePath: claimed },
                { worktreePath: deleted, deleted: true },
                // A relative path would resolve against the server's own cwd.
                { worktreePath: "t3-review-relative" },
                // A filesystem root would make every folder look bound.
                { worktreePath: "/" },
              ],
            }),
          ),
        );

      for (const cwd of [bound, `${bound}/sub`]) {
        assert.strictEqual((yield* review(cwd)).cwd, cwd);
      }
      for (const cwd of [deleted, unbound, claimed, `${process.cwd()}/t3-review-relative`]) {
        const error = yield* review(cwd).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows a thread's worktree linked from a managed folder to a checkout elsewhere", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const managed = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-worktrees-" }),
      );
      const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-checkout-" });
      yield* fs.symlink(checkout, `${managed}/feature`);

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: checkout });
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            worktreesDirectory: managed,
            threadWorktrees: [{ worktreePath: `${managed}/feature` }],
          }),
        ),
      );
      assert.strictEqual(result.cwd, checkout);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows diff preview cwd inside the configured workspace root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: workspaceRoot });
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(result.cwd, workspaceRoot);
      assert.deepStrictEqual(result.sources, []);
      assert.deepStrictEqual(detectCalls, [{ cwd: workspaceRoot }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves unexpected path-resolution failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const invalidCwd = `${workspaceRoot}\0invalid`;
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: invalidCwd }).pipe(Effect.flip);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      if (error._tag !== "VcsRepositoryDetectionError") return;
      assert.strictEqual(error.operation, "ReviewService.assertWorkspaceBoundCwd.canonicalizePath");
      assert.strictEqual(error.cwd, invalidCwd);
      assert.match(error.detail, /Failed to resolve a path/);
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
