import { assert, it } from "@effect/vitest";
import { GitCommandError, VcsUnsupportedOperationError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import { commitId, describeJj, runGit, runJj, withJjRepo } from "../vcs/testing/JjTestSupport.ts";
import { makeJjRefs, type JjRefsOps } from "./JjRefs.ts";
import { makeJjRemotes } from "./JjRemotes.ts";
import {
  defaultWorkspacePathForRef,
  isT3WorkspaceName,
  makeJjWorkspaces,
  workspaceNameForRef,
  type JjWorkspaceOps,
} from "./JjWorkspaces.ts";

interface WorkspacesFixture {
  readonly driver: JjVcsDriver.JjVcsDriverShape;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly ops: JjWorkspaceOps;
  readonly refs: JjRefsOps;
  readonly root: string;
  readonly worktreesDir: string;
}

const withRepo = <A, E>(
  use: (fixture: WorkspacesFixture) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  options?: { readonly withRemote?: boolean; readonly colocated?: boolean },
) =>
  withJjRepo({ prefix: "t3-jj-workspaces-", seed: true, ...options }, (repo) =>
    Effect.gen(function* () {
      const { base, driver, fileSystem, path, process, root } = repo;
      const worktreesDir = path.join(base, "worktrees");
      yield* fileSystem.makeDirectory(worktreesDir, { recursive: true });

      const remotes = makeJjRemotes({ driver, process });
      const refs = yield* makeJjRefs({ driver, process });
      const ops = makeJjWorkspaces({
        driver,
        process,
        fileSystem,
        path,
        worktreesDir,
        bookmarkTo: remotes.bookmarkTo,
      });

      return yield* use({ driver, fileSystem, path, ops, refs, root, worktreesDir });
    }),
  );

describeJj("workspace naming", () => {
  it("keeps bookmarks whose sanitised names collide apart", () => {
    assert.notEqual(workspaceNameForRef("a/b"), workspaceNameForRef("a-b"));
    assert.isTrue(isT3WorkspaceName(workspaceNameForRef("a/b")));
  });

  it("never claims the default workspace", () => {
    assert.isFalse(isT3WorkspaceName("default"));
  });

  it("lays the workspace out under the worktrees directory", () => {
    assert.equal(
      defaultWorkspacePathForRef({
        worktreesDir: "/state/worktrees",
        mainWorkspaceRoot: "/code/project",
        refName: "feat/x",
      }),
      "/state/worktrees/project/feat-x",
    );
  });
});

describeJj("JjWorkspaces.createWorktree", () => {
  it.effect("refuses a non-colocated repository without creating a partial workspace", () =>
    withRepo(
      ({ ops, root, fileSystem, worktreesDir }) =>
        Effect.gen(function* () {
          const failure = yield* ops
            .createWorktree({
              cwd: root,
              refName: "root()",
              newRefName: "unsupported",
              path: null,
            })
            .pipe(Effect.flip);
          assert.include(JSON.stringify(failure), "colocated Jujutsu repositories");
          const codec = Schema.toCodecJson(GitCommandError);
          const wire = yield* Schema.encodeEffect(codec)(failure);
          const decoded = yield* Schema.decodeUnknownEffect(codec)(
            JSON.parse(JSON.stringify(wire)),
          );
          assert.equal(decoded.reason, "unsupported_repository");
          assert.isTrue(Schema.is(VcsUnsupportedOperationError)(failure.cause));
          if (Schema.is(VcsUnsupportedOperationError)(failure.cause)) {
            assert.equal(decoded.detail, failure.cause.detail);
          }
          assert.deepEqual(yield* fileSystem.readDirectory(worktreesDir), []);
          assert.equal((yield* runJj(root, ["workspace", "list"])).trim().split("\n").length, 1);
        }),
      { colocated: false },
    ),
  );

  it.effect("creates a fresh working-copy change with an empty description", () =>
    withRepo(({ ops, root }) =>
      Effect.gen(function* () {
        const base = yield* commitId(root, "main");
        const created = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "feat/empty-description",
          path: null,
        });
        assert.notEqual(yield* commitId(created.worktree.path, "@"), base);
        assert.equal(yield* commitId(created.worktree.path, "@-"), base);
        const description = yield* runJj(created.worktree.path, [
          "log",
          "-r",
          "@",
          "--no-graph",
          "-T",
          "self.description()",
        ]);
        assert.equal(description, "");
      }),
    ),
  );

  it.effect(
    "preserves the workspace when concurrent callers create the same existing bookmark",
    () =>
      withRepo(({ ops, root, fileSystem, driver }) =>
        Effect.gen(function* () {
          const source = yield* ops.createWorktree({
            cwd: root,
            refName: "main",
            newRefName: "feat/source",
            path: null,
          });
          const created = yield* Effect.all(
            [root, source.worktree.path, root, source.worktree.path].map((cwd) =>
              ops.createWorktree({ cwd, refName: "main", path: null }),
            ),
            { concurrency: "unbounded" },
          );
          const destination = created[0]!.worktree.path;
          assert.isTrue(created.every((result) => result.worktree.path === destination));
          assert.equal(yield* fileSystem.readFileString(`${destination}/seed.txt`), "seed\n");
          const workspaces = yield* driver.listWorkspaces(root);
          assert.equal(workspaces.filter((workspace) => workspace.root === destination).length, 1);
        }),
      ),
  );

  it.effect("does not block workspace creation in an unrelated repository", () =>
    withJjRepo({ prefix: "t3-jj-create-lock-first-", seed: true }, (first) =>
      withJjRepo({ prefix: "t3-jj-create-lock-second-", seed: true }, (second) =>
        Effect.gen(function* () {
          const blocked = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const process = {
            ...first.process,
            run: (input: Parameters<typeof first.process.run>[0]) =>
              input.cwd === first.root &&
              input.command === "jj" &&
              input.args.includes("workspace") &&
              input.args.includes("add")
                ? Deferred.succeed(blocked, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(first.process.run(input)),
                  )
                : first.process.run(input),
          };
          const remotes = makeJjRemotes({ driver: first.driver, process });
          const ops = makeJjWorkspaces({
            ...first,
            process,
            worktreesDir: first.path.join(first.base, "worktrees"),
            bookmarkTo: remotes.bookmarkTo,
          });
          const creating = yield* ops
            .createWorktree({ cwd: first.root, refName: "main", path: null })
            .pipe(Effect.forkChild);
          yield* Deferred.await(blocked);
          const created = yield* ops
            .createWorktree({
              cwd: second.root,
              refName: "main",
              path: second.path.join(second.base, "parallel-workspace"),
            })
            .pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
          assert.isTrue(yield* second.fileSystem.exists(`${created.worktree.path}/.jj`));
          yield* Fiber.join(creating);
        }).pipe(Effect.scoped),
      ).pipe(Effect.scoped),
    ),
  );

  it.effect("releases the repository lock before notifying that a workspace was claimed", () =>
    withRepo(({ fileSystem, ops, root }) =>
      Effect.gen(function* () {
        const claimed = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const creating = yield* ops
          .createWorktree(
            { cwd: root, refName: "main", newRefName: "feat/first-claimed", path: null },
            {
              progress: {
                onWorktreeClaimed: () =>
                  Deferred.succeed(claimed, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  ),
              },
            },
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(claimed);
        const second = yield* ops
          .createWorktree({
            cwd: root,
            refName: "main",
            newRefName: "feat/second-claimed",
            path: null,
          })
          .pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        assert.isTrue(yield* fileSystem.exists(`${second.worktree.path}/.jj`));
        yield* Fiber.join(creating);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("refuses a new bookmark whose workspace belongs to another thread", () =>
    withRepo(({ ops, root, fileSystem }) =>
      Effect.gen(function* () {
        const input = { cwd: root, refName: "main", newRefName: "feat/owned", path: null };
        const first = yield* ops.createWorktree(input);
        const ownedFile = `${first.worktree.path}/user-work.txt`;
        yield* fileSystem.writeFileString(ownedFile, "keep this work");
        const error = yield* ops.createWorktree(input).pipe(Effect.flip);
        assert.include(error.detail, "already has a workspace");
        assert.equal(yield* fileSystem.readFileString(ownedFile), "keep this work");
      }),
    ),
  );

  it.effect("resolves Git tags, abbreviated commits and ancestry expressions as bases", () =>
    withRepo(({ ops, root }) =>
      Effect.gen(function* () {
        const base = yield* commitId(root, "main");
        yield* runGit(root, ["tag", "workspace-base", base]);
        for (const [index, refName] of [
          "workspace-base",
          base.slice(0, 12),
          `${base}~0`,
        ].entries()) {
          const created = yield* ops.createWorktree({
            cwd: root,
            refName,
            newRefName: `feat/base-${index}`,
            path: null,
          });
          assert.equal(yield* commitId(created.worktree.path, "@-"), base);
        }
      }),
    ),
  );

  it.effect(
    "rolls back interrupted workspace creation including the backing Git registration",
    () =>
      withJjRepo({ prefix: "t3-jj-interrupted-add-", seed: true }, (repo) =>
        Effect.gen(function* () {
          const added = yield* Deferred.make<void>();
          const destination = repo.path.join(repo.base, "interrupted");
          const process = {
            ...repo.process,
            run: (input: Parameters<typeof repo.process.run>[0]) =>
              repo.process
                .run(input)
                .pipe(
                  Effect.flatMap((result) =>
                    input.command === "jj" &&
                    input.args.includes("workspace") &&
                    input.args.includes("add")
                      ? Deferred.succeed(added, undefined).pipe(Effect.andThen(Effect.never))
                      : Effect.succeed(result),
                  ),
                ),
          };
          const remotes = makeJjRemotes({ driver: repo.driver, process });
          const ops = makeJjWorkspaces({
            ...repo,
            process,
            worktreesDir: repo.base,
            bookmarkTo: remotes.bookmarkTo,
          });
          let claimed = false;
          const creating = yield* ops
            .createWorktree(
              {
                cwd: repo.root,
                refName: "main",
                newRefName: "feat/interrupted-add",
                path: destination,
              },
              {
                progress: {
                  onWorktreeClaimed: () =>
                    Effect.sync(() => {
                      claimed = true;
                    }),
                },
              },
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(added);
          yield* Fiber.interrupt(creating);
          assert.isFalse(claimed);
          assert.isFalse(yield* repo.fileSystem.exists(destination));
          const workspaces = yield* repo.driver.listWorkspaces(repo.root);
          assert.isFalse(workspaces.some((workspace) => workspace.root === destination));
          assert.isFalse(
            (yield* repo.driver.listBookmarks(repo.root)).some(
              (bookmark) => bookmark.name === "feat/interrupted-add" && bookmark.remote === null,
            ),
          );
          assert.notInclude(
            yield* runGit(repo.root, ["worktree", "list", "--porcelain"]),
            destination,
          );
          const retried = yield* makeJjWorkspaces({
            ...repo,
            worktreesDir: repo.base,
            bookmarkTo: remotes.bookmarkTo,
          }).createWorktree({
            cwd: repo.root,
            refName: "main",
            newRefName: "feat/interrupted-add",
            path: destination,
          });
          assert.equal(retried.worktree.path, destination);
        }),
      ),
  );

  it.effect("creates workspaces from a resolved commit SHA with or without a new bookmark", () =>
    withRepo(({ ops, root }) =>
      Effect.gen(function* () {
        const base = yield* commitId(root, "main");
        for (const newRefName of [undefined, "feat/from-sha"]) {
          const created = yield* ops.createWorktree({
            cwd: root,
            refName: base,
            ...(newRefName === undefined ? {} : { newRefName }),
            path: null,
          });
          assert.equal(yield* commitId(created.worktree.path, "@-"), base);
          assert.equal(created.worktree.refName, newRefName ?? base);
        }
      }),
    ),
  );

  it.effect("claims the created workspace before subsequent configuration or interruption", () =>
    withRepo(({ driver, fileSystem, ops, root }) =>
      Effect.gen(function* () {
        let claimed: string | null = null;
        const result = yield* ops
          .createWorktree(
            {
              cwd: root,
              refName: "main",
              newRefName: "feat/interrupted",
              baseRefName: "main",
              path: null,
            },
            {
              progress: {
                onWorktreeClaimed: (directory) =>
                  Effect.gen(function* () {
                    assert.isTrue(yield* fileSystem.exists(`${directory}/.jj`));
                    const config = yield* fileSystem.readFileString(`${root}/.git/config`);
                    assert.notInclude(config, "gh-merge-base");
                    claimed = directory;
                    return yield* Effect.interrupt;
                  }).pipe(Effect.orDie),
              },
            },
          )
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(result));
        assert.isNotNull(claimed);
        const workspaces = yield* driver.listWorkspaces(root);
        assert.isTrue(workspaces.some((workspace) => workspace.root === claimed));
        if (claimed !== null) {
          yield* ops.removeWorktree({ cwd: root, path: claimed, force: true });
          assert.isFalse(yield* fileSystem.exists(claimed));
        }
      }),
    ),
  );

  it.effect("does not claim a reused workspace that cancellation must not remove", () =>
    withRepo(({ ops, root }) =>
      Effect.gen(function* () {
        const input = { cwd: root, refName: "main", path: null };
        const first = yield* ops.createWorktree(input);
        let claimed = false;
        const second = yield* ops.createWorktree(input, {
          progress: {
            onWorktreeClaimed: () =>
              Effect.sync(() => {
                claimed = true;
              }),
          },
        });
        assert.equal(second.worktree.path, first.worktree.path);
        assert.isFalse(claimed);
      }),
    ),
  );

  it.effect("honors a configured worktrees directory when no explicit path is supplied", () =>
    withRepo(({ ops, root, path, worktreesDir }) =>
      Effect.gen(function* () {
        const directory = path.join(worktreesDir, "custom");
        const created = yield* ops.createWorktree(
          { cwd: root, refName: "main", newRefName: "feat/custom", path: null },
          { worktreesDirectory: directory },
        );
        assert.isTrue(created.worktree.path.startsWith(`${directory}${path.sep}`));
      }),
    ),
  );

  it.effect("mints the bookmark and lands under the worktrees directory", () =>
    withRepo(({ ops, root, worktreesDir }) =>
      Effect.gen(function* () {
        const created = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "feat/one",
          path: null,
        });

        assert.equal(created.worktree.refName, "feat/one");
        assert.isTrue(created.worktree.path.startsWith(worktreesDir));
        const bookmarks = yield* runJj(root, ["bookmark", "list"]);
        assert.include(bookmarks, "feat/one");
      }),
    ),
  );

  it.effect("is idempotent for the same bookmark", () =>
    withRepo(({ ops, root }) =>
      Effect.gen(function* () {
        const first = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "feat/two",
          path: null,
        });
        const second = yield* ops.createWorktree({ cwd: root, refName: "feat/two", path: null });

        assert.equal(second.worktree.path, first.worktree.path);
      }),
    ),
  );

  it.effect("gives two colliding bookmark names two workspaces", () =>
    withRepo(({ ops, root }) =>
      Effect.gen(function* () {
        const slashed = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "a/b",
          path: null,
        });
        const dashed = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "a-b",
          path: null,
        });

        assert.notEqual(slashed.worktree.path, dashed.worktree.path);
      }),
    ),
  );

  it.effect("records the pull-request base in the colocated Git config", () =>
    withRepo(({ ops, root }) =>
      Effect.gen(function* () {
        yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "feat/base",
          baseRefName: "main",
          path: null,
        });

        const gitConfig = yield* FileSystem.FileSystem.pipe(
          Effect.flatMap((fileSystem) => fileSystem.readFileString(`${root}/.git/config`)),
        );
        assert.include(gitConfig, "gh-merge-base");
        assert.include(gitConfig, "feat/base");
      }),
    ),
  );

  for (const baseRefName of ["refs/remotes/upstream/main", "upstream/main", "main"]) {
    it.effect(`preserves the remote comparison ref for base ${baseRefName}`, () =>
      withRepo(
        ({ ops, root }) =>
          Effect.gen(function* () {
            yield* runGit(root, ["remote", "rename", "origin", "upstream"]);
            if (baseRefName === "main") {
              // Git resolves an otherwise absent branch against the primary remote. Tracking the
              // workspace base creates a local bookmark, so resolution must precede that mutation.
              yield* runJj(root, ["bookmark", "forget", "main"]);
            }
            yield* ops.createWorktree({
              cwd: root,
              refName: "upstream/main",
              newRefName: "feat/remote-base",
              baseRefName,
              path: null,
            });

            assert.equal(
              (yield* runGit(root, ["config", "--get", "branch.feat/remote-base.gh-merge-base"])).trim(),
              "main",
            );
            assert.equal(
              (
                yield* runGit(root, [
                  "config",
                  "--get",
                  "branch.feat/remote-base.t3-merge-base-ref",
                ])
              ).trim(),
              "refs/remotes/upstream/main",
            );
          }),
        { withRemote: true },
      ),
    );
  }

  for (const baseRefName of ["main", "upstream/main"]) {
    it.effect(`matches Git's review base when local ${baseRefName} shadows a remote`, () =>
      withRepo(
        ({ ops, root }) =>
          Effect.gen(function* () {
            const main = yield* commitId(root, "main");
            yield* runGit(root, ["remote", "rename", "origin", "upstream"]);
            // Renaming the Git remote can remove its tracked local bookmark on jj import.
            yield* runJj(root, ["bookmark", "set", "main", "-r", main]);
            if (baseRefName === "upstream/main") {
              yield* runJj(root, ["bookmark", "create", "upstream/main", "-r", "main"]);
            }
            // A remote-qualified name that also names a local branch is ambiguous to Git:
            // symbolic-full-name succeeds with empty output, so neither base key is recorded.
            const resolvedBase = yield* runGit(root, [
              "rev-parse",
              "--symbolic-full-name",
              "--verify",
              "--end-of-options",
              baseRefName,
            ]);
            assert.equal(resolvedBase.trim(), baseRefName === "main" ? "refs/heads/main" : "");
            yield* ops.createWorktree({
              cwd: root,
              refName: "main",
              newRefName: "feat/local-base",
              baseRefName,
              path: null,
            });
            const config = yield* runGit(root, ["config", "--list"]);
            if (baseRefName === "main") {
              assert.include(config, "branch.feat/local-base.gh-merge-base=main");
            } else {
              assert.notInclude(config, "branch.feat/local-base.gh-merge-base=");
            }
            assert.notInclude(config, "branch.feat/local-base.t3-merge-base-ref=");
          }),
        { withRemote: true },
      ),
    );
  }

  it.effect("records the thread bookmark's upstream when the base came from a remote", () =>
    withRepo(
      ({ ops, root }) =>
        Effect.gen(function* () {
          yield* ops.createWorktree({
            cwd: root,
            refName: "origin/main",
            newRefName: "feat/forked",
            baseRefName: "origin/main",
            path: null,
          });

          // Without these the hosting side reads no upstream for the thread's bookmark and never
          // probes owner-qualified pull-request heads, which is how fork PRs go missing.
          const gitConfig = yield* FileSystem.FileSystem.pipe(
            Effect.flatMap((fileSystem) => fileSystem.readFileString(`${root}/.git/config`)),
          );
          assert.include(gitConfig, '[branch "feat/forked"]');
          assert.include(gitConfig, "remote = origin");
          assert.include(gitConfig, "merge = refs/heads/feat/forked");
        }),
      { withRemote: true },
    ),
  );

  it.effect("re-creates a registered workspace whose directory is gone", () =>
    withRepo(({ fileSystem, ops, root }) =>
      Effect.gen(function* () {
        const created = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "feat/healed",
          path: null,
        });
        yield* fileSystem.remove(created.worktree.path, { recursive: true });

        const healed = yield* ops.createWorktree({
          cwd: root,
          refName: "feat/healed",
          path: null,
        });

        assert.equal(healed.worktree.path, created.worktree.path);
        assert.isTrue(yield* fileSystem.exists(`${healed.worktree.path}/.jj`));
      }),
    ),
  );

  it.effect("leaves no registered workspace behind when `jj workspace add` fails", () =>
    withRepo(({ driver, fileSystem, ops, root, path }) =>
      Effect.gen(function* () {
        const destination = path.join(root, "..", "blocked");
        // A file where jj wants to create the leaf directory: jj registers the workspace and then
        // fails, which is exactly the half-created state the cleanup exists for.
        yield* fileSystem.writeFileString(destination, "not a directory\n");

        const failure = yield* ops
          .createWorktree({
            cwd: root,
            refName: "main",
            newRefName: "feat/blocked",
            path: destination,
          })
          .pipe(Effect.flip);
        assert.equal(failure._tag, "GitCommandError");

        const workspaces = yield* driver.listWorkspaces(root);
        assert.isUndefined(
          workspaces.find((workspace) => workspace.name === workspaceNameForRef("feat/blocked")),
        );

        yield* fileSystem.remove(destination);
        const retried = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "feat/blocked",
          path: destination,
        });
        assert.equal(retried.worktree.refName, "feat/blocked");
      }),
    ),
  );
  it.effect("honors submodule settings and project policy in colocated workspaces", () =>
    withJjRepo({ prefix: "t3-jj-submodules-", seed: true }, (repo) =>
      Effect.gen(function* () {
        const { root, base, fileSystem, path } = repo;
        const nested = path.join(base, "nested-source");
        const source = path.join(base, "module-source");
        for (const directory of [nested, source]) {
          yield* fileSystem.makeDirectory(directory);
          yield* runGit(directory, ["init", "--initial-branch=main"]);
          yield* fileSystem.writeFileString(path.join(directory, "tool.txt"), "tool\n");
          yield* runGit(directory, ["add", "."]);
          yield* runGit(directory, [
            "-c",
            "user.name=T3",
            "-c",
            "user.email=t3@example.com",
            "commit",
            "-m",
            "tool",
          ]);
        }
        yield* runGit(source, [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          nested,
          "nested",
        ]);
        yield* runGit(source, [
          "-c",
          "user.name=T3",
          "-c",
          "user.email=t3@example.com",
          "commit",
          "-am",
          "nested",
        ]);
        yield* runGit(root, [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          source,
          "modules/tool",
        ]);
        yield* fileSystem.writeFileString(
          path.join(root, "t3.json"),
          '{"worktreeSubmodules":"none"}\n',
        );
        yield* runGit(root, ["add", "t3.json"]);
        yield* runGit(root, [
          "-c",
          "user.name=T3",
          "-c",
          "user.email=t3@example.com",
          "commit",
          "-am",
          "submodules",
        ]);
        yield* runJj(root, ["git", "import"]);
        yield* runJj(root, ["bookmark", "set", "main", "-r", "@-"]);
        const process = {
          ...repo.process,
          run: (input: Parameters<typeof repo.process.run>[0]) =>
            repo.process.run({ ...input, env: { ...input.env, GIT_ALLOW_PROTOCOL: "file" } }),
        };
        const remotes = makeJjRemotes({ driver: repo.driver, process });
        const ops = makeJjWorkspaces({
          ...repo,
          process,
          worktreesDir: base,
          bookmarkTo: remotes.bookmarkTo,
        });
        for (const mode of [null, "none", "top-level", "recursive"] as const) {
          const events: string[] = [];
          const created = yield* ops.createWorktree(
            {
              cwd: root,
              refName: "main",
              newRefName: `t3code/submodules-${mode}`,
              path: null,
            },
            {
              submodules: mode,
              progress: {
                onSubmodulesDisabled: ({ source }) =>
                  Effect.sync(() => {
                    events.push(`disabled:${source}`);
                  }),
                onSubmodulesStarted: () =>
                  Effect.sync(() => {
                    events.push("started");
                  }),
                onSubmoduleLine: (line) =>
                  Effect.sync(() => {
                    events.push(`line:${line}`);
                  }),
                onSubmodulesFinished: ({ ok }) =>
                  Effect.sync(() => {
                    events.push(`finished:${ok}`);
                  }),
              },
            },
          );
          const child = created.worktree.path;
          assert.isTrue(yield* fileSystem.exists(path.join(child, ".git")));
          assert.equal(
            yield* fileSystem.exists(path.join(child, "modules/tool/tool.txt")),
            mode === "top-level" || mode === "recursive",
          );
          assert.equal(
            yield* fileSystem.exists(path.join(child, "modules/tool/nested/tool.txt")),
            mode === "recursive",
          );
          if (mode === null || mode === "none") {
            assert.deepStrictEqual(events, [`disabled:${mode === null ? "t3.json" : "settings"}`]);
          } else {
            assert.equal(events[0], "started");
            assert.equal(events.at(-1), "finished:true");
            assert.isTrue(events.some((event) => event.startsWith("line:")));
          }
          events.length = 0;
          const reused = yield* ops.createWorktree(
            { cwd: root, refName: `t3code/submodules-${mode}`, path: null },
            {
              submodules: "recursive",
              progress: {
                onSubmodulesStarted: () =>
                  Effect.sync(() => {
                    events.push("started");
                  }),
              },
            },
          );
          assert.equal(reused.worktree.path, child);
          assert.deepStrictEqual(events, []);
        }
        const started = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const initializing = yield* ops
          .createWorktree(
            {
              cwd: root,
              refName: "main",
              newRefName: "t3code/initializing",
              path: null,
            },
            {
              submodules: "recursive",
              progress: {
                onSubmodulesStarted: () =>
                  Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(resume))),
              },
            },
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const sibling = yield* ops.createWorktree(
          {
            cwd: root,
            refName: "main",
            newRefName: "t3code/parallel",
            path: null,
          },
          { submodules: "none" },
        );
        assert.isTrue(yield* fileSystem.exists(sibling.worktree.path));
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(initializing);
      }),
    ),
  );
});

describeJj("JjWorkspaces.removeWorktree", () => {
  it.effect("allows a removed workspace to be created again at the same path", () =>
    withRepo(({ ops, root }) =>
      Effect.gen(function* () {
        const created = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "feat/recreated",
          path: null,
        });
        yield* ops.removeWorktree({ cwd: root, path: created.worktree.path, force: true });
        const recreated = yield* ops.createWorktree({
          cwd: root,
          refName: "feat/recreated",
          path: null,
        });
        assert.equal(recreated.worktree.path, created.worktree.path);
      }),
    ),
  );

  it.effect("succeeds when an unregistered workspace path is already gone", () =>
    withRepo(({ fileSystem, ops, path, root }) =>
      Effect.gen(function* () {
        const missing = path.join(root, "..", "already-gone");
        yield* ops.removeWorktree({ cwd: root, path: missing });
        assert.isFalse(yield* fileSystem.exists(missing));
      }),
    ),
  );

  it.effect("allows workspace removal to be retried", () =>
    withRepo(({ driver, fileSystem, ops, root }) =>
      Effect.gen(function* () {
        const created = yield* ops.createWorktree({ cwd: root, refName: "main", path: null });
        yield* ops.removeWorktree({ cwd: root, path: created.worktree.path, force: true });
        yield* ops.removeWorktree({ cwd: root, path: created.worktree.path });
        assert.isFalse(yield* fileSystem.exists(created.worktree.path));
        assert.isFalse(
          (yield* driver.listWorkspaces(root)).some(
            (workspace) => workspace.root === created.worktree.path,
          ),
        );
      }),
    ),
  );

  it.effect("refuses a path that is not a registered workspace and leaves it on disk", () =>
    withRepo(({ fileSystem, ops, path, root }) =>
      Effect.gen(function* () {
        const stranger = path.join(root, "..", "not-a-workspace");
        yield* fileSystem.makeDirectory(stranger, { recursive: true });
        yield* fileSystem.writeFileString(path.join(stranger, "keep.txt"), "keep\n");

        const failure = yield* ops
          .removeWorktree({ cwd: root, path: stranger, force: true })
          .pipe(Effect.flip);

        assert.include(failure.detail, "No Jujutsu workspace is registered at");
        assert.isTrue(yield* fileSystem.exists(path.join(stranger, "keep.txt")));
      }),
    ),
  );

  it.effect("refuses the main workspace and leaves the project untouched", () =>
    withRepo(({ fileSystem, ops, root }) =>
      Effect.gen(function* () {
        const failure = yield* ops
          .removeWorktree({ cwd: root, path: root, force: true })
          .pipe(Effect.flip);

        assert.include(failure.detail, "is the main Jujutsu workspace and cannot be removed");
        assert.isTrue(yield* fileSystem.exists(`${root}/.jj`));
        assert.isTrue(yield* fileSystem.exists(`${root}/.git`));
      }),
    ),
  );

  it.effect("refuses work the agent wrote with no jj command since", () =>
    withRepo(({ fileSystem, ops, path, root }) =>
      Effect.gen(function* () {
        const created = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "feat/dirty",
          path: null,
        });
        const agentFile = path.join(created.worktree.path, "agent.txt");
        yield* fileSystem.writeFileString(agentFile, "unsnapshotted\n");

        const failure = yield* ops
          .removeWorktree({ cwd: root, path: created.worktree.path })
          .pipe(Effect.flip);

        assert.include(failure.detail, "uncommitted or unbookmarked changes");
        assert.include(failure.detail, "Only snapshotted Jujutsu changes are retained");
        assert.include(failure.detail, "ignored files");
        assert.include(failure.detail, "snapshot size limits may be lost");
        assert.isTrue(yield* fileSystem.exists(agentFile));
        const retainedCommit = yield* commitId(created.worktree.path, "@");
        yield* ops.removeWorktree({ cwd: root, path: created.worktree.path, force: true });
        assert.isFalse(yield* fileSystem.exists(created.worktree.path));
        const retained = yield* runJj(root, ["file", "show", "-r", retainedCommit, "agent.txt"]);
        assert.equal(retained, "unsnapshotted\n");
      }),
    ),
  );

  it.effect("does not move another managed bookmark when force-removing a user workspace", () =>
    withRepo(({ ops, root, path, fileSystem }) =>
      Effect.gen(function* () {
        yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "aaa-child",
          path: null,
        });
        const childBefore = yield* commitId(root, "aaa-child");
        const review = path.join(root, "..", "review");
        yield* runJj(root, [
          "workspace",
          "add",
          "--colocate",
          "--name",
          "review",
          "-r",
          "main",
          review,
        ]);
        yield* fileSystem.writeFileString(path.join(review, "review.txt"), "review\n");
        yield* runJj(review, ["commit", "-m", "review work"]);
        yield* ops.removeWorktree({ cwd: root, path: review, force: true });
        assert.equal(yield* commitId(root, "aaa-child"), childBefore);
        assert.isFalse(yield* fileSystem.exists(review));
      }),
    ),
  );

  it.effect("does not report a managed child's bookmark as current in the parent", () =>
    withRepo(({ ops, refs, root }) =>
      Effect.gen(function* () {
        const child = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "aaa-child",
          path: null,
        });
        const parentRefs = yield* refs.listRefs({ cwd: root, refresh: true });
        assert.equal(parentRefs.refs.find((ref) => ref.current)?.name, "main");
        const childRefs = yield* refs.listRefs({ cwd: child.worktree.path });
        assert.equal(childRefs.refs.find((ref) => ref.current)?.name, "aaa-child");
      }),
    ),
  );

  it.effect("refuses after the agent committed, and force keeps that work on the bookmark", () =>
    withRepo(({ fileSystem, ops, refs, root }) =>
      Effect.gen(function* () {
        yield* refs.listRefs({ cwd: root });
        const created = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "t3code/committed",
          path: null,
        });
        const mainBefore = yield* commitId(root, "main");
        const local = yield* refs.listRefs({ cwd: created.worktree.path });
        assert.equal(local.refs.find((ref) => ref.current)?.name, "t3code/committed");
        yield* fileSystem.writeFileString(`${created.worktree.path}/agent.txt`, "work\n");
        yield* runJj(created.worktree.path, ["commit", "-m", "agent work"]);

        const failure = yield* ops
          .removeWorktree({ cwd: root, path: created.worktree.path })
          .pipe(Effect.flip);
        assert.include(failure.detail, "uncommitted or unbookmarked changes");

        yield* ops.removeWorktree({ cwd: root, path: created.worktree.path, force: true });

        assert.isFalse(yield* fileSystem.exists(created.worktree.path));
        assert.equal(yield* commitId(root, "main"), mainBefore);
        const listed = yield* refs.listRefs({ cwd: root, refresh: true });
        const bookmark = listed.refs.find((ref) => ref.name === "t3code/committed");
        assert.isDefined(bookmark);
        const described = yield* runJj(root, [
          "log",
          "-r",
          'bookmarks(exact:"t3code/committed")',
          "--no-graph",
          "-T",
          "description",
        ]);
        assert.include(described, "agent work");
      }),
    ),
  );

  it.effect("never moves main when a managed workspace bookmark is missing", () =>
    withRepo(({ fileSystem, ops, refs, root }) =>
      Effect.gen(function* () {
        const created = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "t3code/deleted",
          path: null,
        });
        const mainBefore = yield* commitId(root, "main");
        yield* runJj(root, ["bookmark", "delete", "t3code/deleted"]);
        yield* fileSystem.writeFileString(`${created.worktree.path}/agent.txt`, "work\n");
        yield* runJj(created.worktree.path, ["commit", "-m", "stranded agent work"]);
        const listed = yield* refs.listRefs({ cwd: created.worktree.path, refresh: true });
        assert.isFalse(listed.refs.some((ref) => ref.current));
        yield* ops.removeWorktree({ cwd: root, path: created.worktree.path, force: true });
        assert.equal(yield* commitId(root, "main"), mainBefore);
      }),
    ),
  );

  it.effect("can recreate a manually deleted workspace after removal", () =>
    withRepo(({ fileSystem, ops, root }) =>
      Effect.gen(function* () {
        const created = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "t3code/missing-directory",
          path: null,
        });
        yield* fileSystem.remove(created.worktree.path, { recursive: true });
        yield* ops.removeWorktree({ cwd: root, path: created.worktree.path });
        const retried = yield* ops.createWorktree({
          cwd: root,
          refName: "t3code/missing-directory",
          path: created.worktree.path,
        });
        assert.equal(retried.worktree.path, created.worktree.path);
      }),
    ),
  );

  it.effect("does not adopt or delete an unrelated existing bookmark", () =>
    withRepo(({ driver, ops, root }) =>
      Effect.gen(function* () {
        const mainBefore = yield* commitId(root, "main");
        yield* ops
          .createWorktree({
            cwd: root,
            refName: "main",
            newRefName: "main",
            path: null,
          })
          .pipe(Effect.flip);
        assert.equal(yield* commitId(root, "main"), mainBefore);
        assert.equal((yield* driver.listWorkspaces(root)).length, 1);
      }),
    ),
  );

  it.effect("forgets and deletes a clean workspace with force", () =>
    withRepo(({ driver, fileSystem, ops, root }) =>
      Effect.gen(function* () {
        const created = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "feat/clean",
          path: null,
        });

        yield* ops.removeWorktree({ cwd: root, path: created.worktree.path, force: true });

        assert.isFalse(yield* fileSystem.exists(created.worktree.path));
        const workspaces = yield* driver.listWorkspaces(root);
        assert.isUndefined(
          workspaces.find((workspace) => workspace.name === workspaceNameForRef("feat/clean")),
        );
      }),
    ),
  );
});

describeJj("JjWorkspaces.pruneWorktrees", () => {
  it.effect("reclaims a T3 workspace whose directory is gone and keeps the user's own", () =>
    withRepo(({ driver, fileSystem, ops, path, root }) =>
      Effect.gen(function* () {
        const created = yield* ops.createWorktree({
          cwd: root,
          refName: "main",
          newRefName: "feat/pruned",
          path: null,
        });
        const userWorkspace = path.join(root, "..", "mine");
        yield* runJj(root, ["workspace", "add", "--name", "mine", userWorkspace]);

        yield* fileSystem.remove(created.worktree.path, { recursive: true });
        yield* fileSystem.remove(userWorkspace, { recursive: true });

        yield* ops.pruneWorktrees({ cwd: root });

        const workspaces = yield* driver.listWorkspaces(root);
        assert.isUndefined(
          workspaces.find((workspace) => workspace.name === workspaceNameForRef("feat/pruned")),
        );
        assert.isDefined(workspaces.find((workspace) => workspace.name === "mine"));
      }),
    ),
  );
});
