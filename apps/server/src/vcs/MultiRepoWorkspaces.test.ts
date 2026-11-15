// @effect-diagnostics processEnvInEffect:off -- tests os.homedir behavior against an isolated temporary HOME.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as MultiRepoWorkspaces from "./MultiRepoWorkspaces.ts";
import * as VcsProcess from "./VcsProcess.ts";

const TestLayer = MultiRepoWorkspaces.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  // Merged so tests can build folders inside T3's home.
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-multi-repo-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "MultiRepoWorkspaces.test",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const makeGroup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const group = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-multi-repo-group-" });
  for (const member of ["api", "web"]) {
    const repo = path.join(group, member);
    yield* fileSystem.makeDirectory(repo);
    yield* git(repo, ["init", "--initial-branch=main"]);
    yield* git(repo, ["config", "user.email", "test@test.com"]);
    yield* git(repo, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(repo, "README.md"), `${member}\n`);
    yield* git(repo, ["add", "."]);
    yield* git(repo, ["commit", "-m", member]);
  }
  yield* fileSystem.writeFileString(path.join(group, ".workler"), "project api\nproject web\n");
  return group;
});

const currentBranches = (workspace: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return [
      yield* git(path.join(workspace, "api"), ["rev-parse", "--abbrev-ref", "HEAD"]),
      yield* git(path.join(workspace, "web"), ["rev-parse", "--abbrev-ref", "HEAD"]),
    ];
  });

it.layer(TestLayer)("MultiRepoWorkspaces", (it) => {
  it.effect("detects groups and their workspaces, not member repositories", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
      const group = yield* makeGroup;

      assert.deepEqual(yield* workspaces.members(group), ["api", "web"]);
      assert.equal(yield* workspaces.members(path.join(group, "api")), null);
      assert.equal(yield* workspaces.members(path.join(group, "missing")), null);
    }).pipe(Effect.scoped),
  );

  it.effect("makes a plain folder of repositories a group, and refuses anything else", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-multi-repo-plain-" });
      for (const member of ["api", "projects/web"]) {
        yield* fileSystem.makeDirectory(path.join(root, member), { recursive: true });
        yield* git(path.join(root, member), ["init"]);
      }
      // Hidden folders and node_modules are never members, as in Workler.
      for (const skipped of [".cache/tool", "node_modules/pkg"]) {
        yield* fileSystem.makeDirectory(path.join(root, skipped), { recursive: true });
        yield* git(path.join(root, skipped), ["init"]);
      }

      assert.deepEqual(yield* workspaces.nestedRepositories(root), ["api", "projects/web"]);
      assert.deepEqual(yield* workspaces.makeGroup(root), ["api", "projects/web"]);
      assert.deepEqual(yield* workspaces.members(root), ["api", "projects/web"]);
      assert.deepEqual(yield* workspaces.nestedRepositories(root), []);
      assert.deepEqual(yield* workspaces.makeGroup(root), ["api", "projects/web"]);

      // Workler's init would write its single-repository template into these.
      const empty = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-multi-repo-empty-" });
      assert.include(
        (yield* Effect.flip(workspaces.makeGroup(empty))).detail,
        "No Git repositories",
      );
      assert.isFalse(yield* fileSystem.exists(path.join(empty, ".workler")));
      const repository = path.join(root, "api");
      yield* fileSystem.makeDirectory(path.join(repository, "vendor", "lib"), { recursive: true });
      yield* git(path.join(repository, "vendor", "lib"), ["init"]);
      assert.include(
        (yield* Effect.flip(workspaces.makeGroup(repository))).detail,
        "is a Git repository",
      );
      assert.isFalse(yield* fileSystem.exists(path.join(repository, ".workler")));
    }).pipe(Effect.scoped),
  );

  it.effect("does not offer linked or unwritable members as group candidates", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-group-candidates-" });
      const external = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-group-external-" });
      yield* fileSystem.makeDirectory(path.join(external, "repo", ".git"), { recursive: true });
      yield* fileSystem.symlink(path.join(external, "repo"), path.join(root, "linked-repo"));
      yield* fileSystem.symlink(external, path.join(root, "linked-parent"));
      yield* fileSystem.makeDirectory(path.join(root, "linked-git"));
      yield* fileSystem.symlink(
        path.join(external, "repo", ".git"),
        path.join(root, "linked-git", ".git"),
      );
      yield* fileSystem.makeDirectory(path.join(root, `both'"quotes`, ".git"), { recursive: true });

      assert.deepEqual(yield* workspaces.nestedRepositories(root), []);
      for (const link of ["linked-repo", "linked-parent", "linked-git"]) {
        yield* fileSystem.remove(path.join(root, link), { recursive: true });
      }
      const result = yield* Effect.result(workspaces.makeGroup(root));
      assert.equal(result._tag, "Failure");
      assert.isFalse(yield* fileSystem.exists(path.join(root, ".workler")));
      assert.isFalse(yield* fileSystem.exists(path.join(root, ".gitignore")));
    }).pipe(Effect.scoped),
  );

  it.effect("refuses conversion inside a repository even when the project is not its root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
      const outer = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-group-outer-" });
      yield* git(outer, ["init"]);
      const root = path.join(outer, "vendor");
      yield* fileSystem.makeDirectory(path.join(root, "api", ".git"), { recursive: true });
      assert.deepEqual(yield* workspaces.nestedRepositories(root), []);
      const result = yield* Effect.result(workspaces.makeGroup(root));
      assert.equal(result._tag, "Failure");
      assert.isFalse(yield* fileSystem.exists(path.join(root, ".workler")));
      assert.isFalse(yield* fileSystem.exists(path.join(root, ".gitignore")));
    }).pipe(Effect.scoped),
  );

  it.effect("does not scan a folder that holds the home folder", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-group-home-" });
      for (const repository of ["api", "home/web", "home/dev/web"]) {
        yield* fileSystem.makeDirectory(path.join(root, repository, ".git"), { recursive: true });
      }
      assert.deepEqual(yield* workspaces.nestedRepositories(root), ["api", "home/web"]);

      // os.homedir() follows HOME, so point it inside the folder for this test.
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = process.env.HOME;
          process.env.HOME = path.join(root, "home");
          return previous;
        }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.HOME;
            else process.env.HOME = previous;
          }),
      );
      assert.deepEqual(yield* workspaces.nestedRepositories(root), []);
      assert.deepEqual(yield* workspaces.nestedRepositories(path.join(root, "home")), []);
      assert.deepEqual(yield* workspaces.nestedRepositories(path.join(root, "home", "dev")), [
        "web",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses conversion of T3's own scratch and worktree folders", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir } = yield* ServerConfig.ServerConfig;
      const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
      const root = path.join(baseDir, "scratch", "conversion-candidate");
      yield* fileSystem.makeDirectory(path.join(root, "api", ".git"), { recursive: true });
      const result = yield* Effect.result(workspaces.makeGroup(root));
      assert.equal(result._tag, "Failure");
      assert.isFalse(yield* fileSystem.exists(path.join(root, ".workler")));
    }),
  );

  it.effect("tells what a folder picked for a new multi-repo project can become", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir } = yield* ServerConfig.ServerConfig;
      const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-multi-repo-inspect-" });
      const inspect = (folder: string) =>
        workspaces
          .inspectFolder(folder)
          .pipe(Effect.map(({ kind, repositories }) => ({ kind, repositories })));

      assert.deepEqual(yield* inspect(path.join(root, "new")), {
        kind: "missing",
        repositories: [],
      });
      yield* fileSystem.makeDirectory(path.join(root, "empty"));
      assert.deepEqual(yield* inspect(path.join(root, "empty")), {
        kind: "empty",
        repositories: [],
      });
      // A folder made in Finder holds a .DS_Store and still counts as empty.
      yield* fileSystem.writeFileString(path.join(root, "empty", ".DS_Store"), "");
      assert.deepEqual(yield* inspect(path.join(root, "empty")), {
        kind: "empty",
        repositories: [],
      });

      const plain = path.join(root, "plain");
      for (const member of ["api", "web"]) {
        yield* fileSystem.makeDirectory(path.join(plain, member), { recursive: true });
        yield* git(path.join(plain, member), ["init"]);
      }
      assert.deepEqual(yield* inspect(plain), {
        kind: "repositories",
        repositories: ["api", "web"],
      });
      yield* workspaces.makeGroup(plain);
      assert.deepEqual(yield* inspect(plain), { kind: "group", repositories: ["api", "web"] });

      // Nothing can be grouped in, or cloned into, any of these.
      const notes = path.join(root, "notes");
      yield* fileSystem.makeDirectory(notes);
      yield* fileSystem.writeFileString(path.join(notes, "todo.md"), "todo\n");
      for (const folder of [
        notes,
        path.join(notes, "todo.md"),
        path.join(plain, "api"),
        path.join(plain, "api", "src"),
        path.join(baseDir, "scratch", "anything"),
        "~",
      ]) {
        const result = yield* workspaces.inspectFolder(folder);
        assert.equal(result.kind, "unavailable", folder);
        assert.isString(result.reason);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("creates, renames, removes and recreates a workspace across every member", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
      const group = yield* makeGroup;

      let claimed: string | null = null;
      const created = yield* workspaces.createWorkspace(
        {
          cwd: group,
          refName: "HEAD",
          newRefName: "t3code/abc12345",
          path: null,
        },
        {
          progress: {
            onWorktreeClaimed: (value) =>
              Effect.sync(() => {
                claimed = value;
              }),
          },
        },
      );
      assert.equal(claimed, created.worktree.path);
      const workspace = created.worktree.path;
      assert.equal(workspace, path.join(group, ".worktrees", "t3code-abc12345"));
      assert.equal(created.worktree.refName, "t3code/abc12345");
      assert.deepEqual(yield* currentBranches(workspace), ["t3code/abc12345", "t3code/abc12345"]);
      const members = yield* workspaces.members(workspace);
      assert.deepEqual(members, ["api", "web"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      assert.include(yield* driver.listWorktreePaths(group), workspace);
      const refs = yield* driver.listRefs({ cwd: workspace });
      assert.isFalse(refs.isRepo);
      assert.deepEqual(
        refs.refs.map((ref) => ({ name: ref.name, worktreePath: ref.worktreePath })),
        [{ name: "t3code/abc12345", worktreePath: workspace }],
      );

      const renamed = yield* workspaces.renameBranch({
        cwd: workspace,
        members: members ?? [],
        oldBranch: "t3code/abc12345",
        newBranch: "feature/login",
      });
      assert.equal(renamed.branch, "feature/login");
      assert.deepEqual(yield* currentBranches(workspace), ["feature/login", "feature/login"]);

      yield* workspaces.removeWorkspace({ cwd: group, path: workspace, force: true });
      assert.isFalse(yield* fileSystem.exists(workspace));
      assert.include(
        yield* workspaces.listLocalBranchNames(group, ["api", "web"]),
        "feature/login",
      );
      yield* git(path.join(group, "api"), ["branch", "api-only"]);
      assert.notInclude(yield* workspaces.listLocalBranchNames(group, ["api", "web"]), "api-only");
      for (const member of ["api", "web"]) {
        // Removing keeps the branch in the project, as a linked worktree would.
        yield* git(path.join(group, member), ["rev-parse", "--verify", "refs/heads/feature/login"]);
      }
      // Members that lack the branch are skipped, so a failed launch can drop it everywhere.
      yield* git(path.join(group, "api"), ["branch", "-D", "feature/login"]);
      yield* workspaces.deleteBranch({
        cwd: group,
        members: ["api", "web"],
        refName: "feature/login",
        force: true,
      });
      assert.notInclude(yield* git(path.join(group, "web"), ["branch"]), "feature/login");

      // A branch gone everywhere (its workspace deleted by hand) isn't made up from HEAD.
      const missing = yield* workspaces
        .createWorkspace({
          cwd: group,
          refName: "feature/login",
          path: workspace,
        })
        .pipe(Effect.flip);
      assert.include(missing.detail, "feature/login");
      assert.isFalse(yield* fileSystem.exists(workspace));
      for (const member of ["api", "web"]) {
        yield* git(path.join(group, member), ["branch", "feature/login"]);
      }
      // A thread whose workspace vanished gets the same folder back on its branch.
      const recreated = yield* workspaces.createWorkspace({
        cwd: group,
        refName: "feature/login",
        path: workspace,
      });
      assert.equal(recreated.worktree.path, workspace);
      assert.deepEqual(yield* currentBranches(workspace), ["feature/login", "feature/login"]);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["web", "__proto__", "constructor"])(
    "starts a new workspace at the members' commits in another workspace (%s)",
    (webMember) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
        const group = yield* makeGroup;
        // Member folders may be named like Object.prototype keys.
        if (webMember !== "web") {
          yield* fileSystem.rename(path.join(group, "web"), path.join(group, webMember));
          yield* fileSystem.writeFileString(
            path.join(group, ".workler"),
            `project api\nproject ${webMember}\n`,
          );
        }
        const parent = (yield* workspaces.createWorkspace({
          cwd: group,
          refName: "HEAD",
          newRefName: "feature/parent",
          path: null,
        })).worktree.path;
        // Members may sit on different branches; each commit exists only in the parent's clone.
        const parentApi = path.join(parent, "api");
        const parentWeb = path.join(parent, webMember);
        yield* git(parentWeb, ["switch", "-c", "feature/web-only"]);
        for (const repo of [parentApi, parentWeb]) {
          yield* fileSystem.writeFileString(path.join(repo, "change.txt"), "committed\n");
          yield* git(repo, ["add", "."]);
          yield* git(repo, [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@test.com",
            "commit",
            "-m",
            "parent work",
          ]);
        }
        yield* fileSystem.writeFileString(path.join(parentApi, "draft.txt"), "uncommitted\n");
        const rootRefs = yield* git(path.join(group, "api"), ["for-each-ref"]);

        const commits = yield* workspaces.checkoutMemberCommits({ root: group, checkout: parent });
        assert.deepEqual(commits, {
          api: yield* git(parentApi, ["rev-parse", "HEAD"]),
          [webMember]: yield* git(parentWeb, ["rev-parse", "HEAD"]),
        });
        // The project's repositories get the objects, never a ref.
        assert.equal(yield* git(path.join(group, "api"), ["for-each-ref"]), rootRefs);

        const child = (yield* workspaces.createWorkspace(
          { cwd: group, refName: "HEAD", newRefName: "feature/child", path: null },
          { memberBaseCommits: commits },
        )).worktree.path;
        for (const member of ["api", webMember]) {
          assert.equal(
            yield* git(path.join(child, member), ["branch", "--show-current"]),
            "feature/child",
          );
          assert.equal(
            yield* git(path.join(child, member), ["rev-parse", "HEAD"]),
            commits[member],
          );
        }
        assert.isFalse(yield* fileSystem.exists(path.join(child, "api", "draft.txt")));
        assert.deepEqual(
          yield* workspaces.checkoutMemberCommits({ root: group, checkout: group }),
          {
            api: yield* git(path.join(group, "api"), ["rev-parse", "HEAD"]),
            [webMember]: yield* git(path.join(group, webMember), ["rev-parse", "HEAD"]),
          },
        );
      }).pipe(Effect.scoped),
  );

  it.effect("keeps Workler links when a parent commit would overwrite them", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
      const group = yield* makeGroup;
      const api = path.join(group, "api");
      yield* fileSystem.makeDirectory(path.join(api, "config"));
      yield* fileSystem.writeFileString(path.join(api, "config", "local"), "local configuration");
      yield* fileSystem.writeFileString(path.join(api, ".workler"), "link config\n");
      const parent = (yield* workspaces.createWorkspace({
        cwd: group,
        refName: "HEAD",
        newRefName: "feature/parent",
        path: null,
      })).worktree.path;
      const member = path.join(parent, "api");
      yield* fileSystem.remove(path.join(member, "config"));
      yield* fileSystem.makeDirectory(path.join(member, "config"));
      yield* fileSystem.writeFileString(path.join(member, "config", "tracked"), "parent work");
      yield* git(member, ["add", "-f", "config"]);
      yield* git(member, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@test.com",
        "commit",
        "-m",
        "track config",
      ]);
      const commits = yield* workspaces.checkoutMemberCommits({ root: group, checkout: parent });
      const error = yield* workspaces
        .createWorkspace(
          { cwd: group, refName: "HEAD", newRefName: "feature/child", path: null },
          { memberBaseCommits: commits },
        )
        .pipe(Effect.flip);
      assert.include(error.detail, "Could not start multi-repo member 'api'");
      const config = path.join(group, ".worktrees", "feature-child", "api", "config");
      assert.equal((yield* fileSystem.lstat(config)).type, "SymbolicLink");
      assert.equal(
        yield* fileSystem.readFileString(path.join(config, "local")),
        "local configuration",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("refuses member commits from a checkout that is not this group's workspace", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
      const group = yield* makeGroup;
      const foreign = yield* makeGroup;
      // Distinct from the group's commits, which two makeGroup calls can share.
      yield* git(path.join(foreign, "api"), ["commit", "--allow-empty", "-m", "foreign only"]);
      const refused = yield* Effect.flip(
        workspaces.checkoutMemberCommits({ root: group, checkout: foreign }),
      );
      assert.include(refused.detail, "Could not copy commit");
    }).pipe(Effect.scoped),
  );

  it.effect("removing a workspace keeps its commits, or keeps it when they can't be copied", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
      const group = yield* makeGroup;
      const commit = (repo: string, message: string) =>
        git(repo, [
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=T",
          "commit",
          "--allow-empty",
          "-m",
          message,
        ]);

      const kept = yield* workspaces.createWorkspace({
        cwd: group,
        refName: "main",
        newRefName: "feature/kept",
        path: null,
      });
      yield* commit(path.join(kept.worktree.path, "api"), "kept work");
      yield* git(path.join(kept.worktree.path, "api"), ["tag", "v1"]);
      const work = yield* git(path.join(kept.worktree.path, "api"), ["rev-parse", "HEAD"]);
      for (const ref of [
        "refs/t3/checkpoints/legacy/1",
        "refs/t3/orchestration-v2/checkpoints/scope/1",
      ]) {
        yield* git(path.join(kept.worktree.path, "api"), ["update-ref", ref, "HEAD"]);
      }
      yield* workspaces.removeWorkspace({ cwd: group, path: kept.worktree.path, force: true });
      assert.isFalse(yield* fileSystem.exists(kept.worktree.path));
      const api = path.join(group, "api");
      assert.equal(yield* git(api, ["rev-parse", "refs/heads/feature/kept"]), work);
      assert.equal(yield* git(api, ["rev-parse", "refs/tags/v1^{commit}"]), work);
      for (const ref of [
        "refs/t3/checkpoints/legacy/1",
        "refs/t3/orchestration-v2/checkpoints/scope/1",
      ]) {
        assert.equal(yield* git(api, ["rev-parse", ref]), work);
      }

      // The project already has other commits on that branch name.
      const blocked = yield* workspaces.createWorkspace({
        cwd: group,
        refName: "main",
        newRefName: "feature/blocked",
        path: null,
      });
      yield* commit(path.join(blocked.worktree.path, "web"), "workspace work");
      const web = path.join(group, "web");
      yield* git(web, ["branch", "feature/blocked"]);
      yield* git(web, ["switch", "feature/blocked"]);
      yield* commit(web, "project work");
      yield* git(web, ["switch", "main"]);
      const projectTip = yield* git(web, ["rev-parse", "feature/blocked"]);
      const error = yield* workspaces
        .removeWorkspace({ cwd: group, path: blocked.worktree.path, force: true })
        .pipe(Effect.flip);
      assert.include(error.detail, "feature/blocked");
      assert.isTrue(yield* fileSystem.exists(blocked.worktree.path));
      assert.equal(yield* git(web, ["rev-parse", "feature/blocked"]), projectTip);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "removing a workspace keeps work on any branch, and keeps it for a stash or detached work",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
        const group = yield* makeGroup;
        const api = path.join(group, "api");
        const commit = (repo: string, message: string) =>
          git(repo, [
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=T",
            "commit",
            "--allow-empty",
            "-m",
            message,
          ]);
        const create = (branch: string) =>
          workspaces
            .createWorkspace({ cwd: group, refName: "HEAD", newRefName: branch, path: null })
            .pipe(Effect.map((created) => created.worktree.path));

        // Work on a side branch survives, and ending on an older main that the
        // project's checked-out main already contains doesn't block removal.
        const side = yield* create("feature/side");
        const sideClone = path.join(side, "api");
        yield* git(sideClone, ["switch", "-c", "side"]);
        yield* commit(sideClone, "side work");
        const sideWork = yield* git(sideClone, ["rev-parse", "HEAD"]);
        const oldMain = yield* git(api, ["rev-parse", "main"]);
        yield* commit(api, "project moved on");
        yield* git(sideClone, ["switch", "-C", "main", oldMain]);
        yield* workspaces.removeWorkspace({ cwd: group, path: side, force: true });
        assert.isFalse(yield* fileSystem.exists(side));
        assert.equal(yield* git(api, ["rev-parse", "refs/heads/side"]), sideWork);

        // A pushed main ahead of the project's checked-out main can't be
        // fast-forwarded there, but nothing would be lost.
        const pushed = yield* create("feature/pushed");
        const pushedClone = path.join(pushed, "api");
        const projectMain = yield* git(api, ["rev-parse", "main"]);
        yield* git(pushedClone, ["switch", "-C", "main", projectMain]);
        yield* commit(pushedClone, "pulled from upstream");
        yield* git(pushedClone, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
        yield* workspaces.removeWorkspace({ cwd: group, path: pushed, force: true });
        assert.isFalse(yield* fileSystem.exists(pushed));
        assert.equal(yield* git(api, ["rev-parse", "main"]), projectMain);

        // Commits only a detached HEAD reaches, as a stopped rebase leaves them.
        const detached = yield* create("feature/detached");
        const detachedClone = path.join(detached, "api");
        yield* git(detachedClone, ["switch", "--detach"]);
        yield* commit(detachedClone, "rebased work");
        const detachedError = yield* workspaces
          .removeWorkspace({ cwd: group, path: detached, force: true })
          .pipe(Effect.flip);
        assert.include(detachedError.detail, "commits on no branch");
        assert.isTrue(yield* fileSystem.exists(detached));

        const stashed = yield* create("feature/stashed");
        const stashedClone = path.join(stashed, "web");
        yield* fileSystem.writeFileString(path.join(stashedClone, "notes.md"), "draft\n");
        yield* git(stashedClone, [
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=T",
          "stash",
          "--include-untracked",
        ]);
        const stashError = yield* workspaces
          .removeWorkspace({ cwd: group, path: stashed, force: true })
          .pipe(Effect.flip);
        assert.include(stashError.detail, "stashed changes");
        assert.isTrue(yield* fileSystem.exists(stashed));
      }).pipe(Effect.scoped),
  );

  const commitInOldWorkspace = Effect.gen(function* () {
    const path = yield* Path.Path;
    const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
    const group = yield* makeGroup;
    const workspace = (yield* workspaces.createWorkspace({
      cwd: group,
      refName: "HEAD",
      newRefName: "feature/old-layout",
      path: null,
    })).worktree.path;
    const web = path.join(workspace, "web");
    yield* git(web, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@test.com",
      "commit",
      "--allow-empty",
      "-m",
      "unique work in a member the project drops",
    ]);
    return { group, workspace, web, head: yield* git(web, ["rev-parse", "HEAD"]) };
  });

  it.effect("copies back every clone an older workspace holds after the member list changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
      const { group, workspace, head } = yield* commitInOldWorkspace;
      // The project drops web and adds docs after the workspace was made.
      const docs = path.join(group, "docs");
      yield* fileSystem.makeDirectory(docs);
      yield* git(docs, ["init", "--initial-branch=main"]);
      yield* git(docs, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@test.com",
        "commit",
        "--allow-empty",
        "-m",
        "docs",
      ]);
      yield* fileSystem.writeFileString(
        path.join(group, ".workler"),
        "project api\nproject docs\n",
      );

      yield* workspaces.removeWorkspace({ cwd: group, path: workspace, force: true });
      assert.isFalse(yield* fileSystem.exists(workspace));
      assert.equal(yield* git(path.join(group, "web"), ["rev-parse", "feature/old-layout"]), head);
    }).pipe(Effect.scoped),
  );

  it.effect("finishes a removal that stopped after the workspace's .workler was deleted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
      const { group, workspace, head } = yield* commitInOldWorkspace;
      // The project dropped web too, so only the clone on disk says it's there.
      yield* fileSystem.writeFileString(path.join(group, ".workler"), "project api\n");
      yield* fileSystem.remove(path.join(workspace, ".workler"));

      yield* workspaces.removeWorkspace({ cwd: group, path: workspace, force: true });
      assert.isFalse(yield* fileSystem.exists(workspace));
      assert.equal(yield* git(path.join(group, "web"), ["rev-parse", "feature/old-layout"]), head);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a workspace whose clone has no source repository left", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
      const { group, workspace, web, head } = yield* commitInOldWorkspace;
      yield* fileSystem.rename(path.join(group, "web"), path.join(group, "web-moved"));
      yield* fileSystem.writeFileString(path.join(group, ".workler"), "project api\n");

      const error = yield* workspaces
        .removeWorkspace({ cwd: group, path: workspace, force: true })
        .pipe(Effect.flip);
      assert.include(error.detail, "web is no longer a Git repository");
      assert.equal(yield* git(web, ["rev-parse", "HEAD"]), head);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses an existing branch when falling back to HEAD", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
      const group = yield* makeGroup;
      yield* git(path.join(group, "web"), ["branch", "feature/existing"]);
      const error = yield* workspaces
        .createWorkspace({
          cwd: group,
          refName: "HEAD",
          newRefName: "feature/existing",
          path: null,
        })
        .pipe(Effect.flip);
      assert.include(error.detail, "already exists");
      assert.isFalse(yield* fileSystem.exists(path.join(group, ".worktrees", "feature-existing")));
    }).pipe(Effect.scoped),
  );

  it.effect("recovers a pushed branch absent from the source's ref snapshot", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
      const group = yield* makeGroup;
      for (const member of ["api", "web"]) {
        const remote = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-recovery-origin-" });
        yield* git(remote, ["init", "--bare", "--initial-branch=main"]);
        yield* git(path.join(group, member), ["remote", "add", "origin", remote]);
        yield* git(path.join(group, member), ["push", "origin", "main"]);
      }
      const workspace = (yield* workspaces.createWorkspace({
        cwd: group,
        refName: "HEAD",
        newRefName: "feature/recover",
        path: null,
      })).worktree.path;
      const heads = new Map<string, string>();
      for (const member of ["api", "web"]) {
        const repo = path.join(workspace, member);
        yield* git(repo, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@test.com",
          "commit",
          "--allow-empty",
          "-m",
          "task work",
        ]);
        yield* git(repo, ["push", "origin", "feature/recover"]);
        heads.set(member, yield* git(repo, ["rev-parse", "HEAD"]));
      }
      yield* workspaces.removeWorkspace({ cwd: group, path: workspace, force: true });
      yield* workspaces.createWorkspace({
        cwd: group,
        refName: "feature/recover",
        path: workspace,
      });
      for (const member of ["api", "web"]) {
        assert.equal(
          yield* git(path.join(workspace, member), ["rev-parse", "HEAD"]),
          heads.get(member),
        );
      }
      assert.deepEqual(yield* currentBranches(workspace), ["feature/recover", "feature/recover"]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses recovery when a missing branch name still resolves to a tag", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
      const group = yield* makeGroup;
      // The first member still has the branch; only the later member has lost it.
      yield* git(path.join(group, "api"), ["branch", "feature/recover"]);
      yield* git(path.join(group, "web"), ["tag", "feature/recover"]);
      const workspace = path.join(group, ".worktrees", "recovery");
      const error = yield* workspaces
        .createWorkspace({ cwd: group, refName: "feature/recover", path: workspace })
        .pipe(Effect.flip);
      assert.include(error.detail, "feature/recover");
      assert.isFalse(yield* fileSystem.exists(workspace));
    }).pipe(Effect.scoped),
  );

  it.effect("uses one available branch name even when only a later member has a collision", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
      const group = yield* makeGroup;
      const workspace = (yield* workspaces.createWorkspace({
        cwd: group,
        refName: "HEAD",
        newRefName: "t3code/collision",
        path: null,
      })).worktree.path;
      yield* git(path.join(workspace, "web"), ["branch", "feature/login"]);
      yield* git(path.join(workspace, "api"), ["branch", "feature/login-1"]);
      const result = yield* workspaces.renameBranch({
        cwd: workspace,
        members: ["api", "web"],
        oldBranch: "t3code/collision",
        newBranch: "feature/login",
      });
      assert.equal(result.branch, "feature/login-2");
      assert.deepEqual(yield* currentBranches(workspace), ["feature/login-2", "feature/login-2"]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "starts each member from its fetched remote default branch, not its current branch",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
        const upstreams = yield* makeGroup;
        const group = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-multi-repo-cloned-",
        });
        for (const member of ["api", "web"]) {
          const repo = path.join(group, member);
          yield* git(group, ["clone", "--", path.join(upstreams, member), repo]);
          yield* git(repo, ["checkout", "-b", "local-work"]);
          yield* git(repo, [
            "-c",
            "user.email=test@test.com",
            "-c",
            "user.name=Test",
            "commit",
            "--allow-empty",
            "-m",
            "local work",
          ]);
        }
        yield* fileSystem.writeFileString(
          path.join(group, ".workler"),
          "project api\nproject web\n",
        );
        // The remotes move on after the clones were made; only a fetch sees it.
        for (const member of ["api", "web"]) {
          yield* git(path.join(upstreams, member), ["commit", "--allow-empty", "-m", "upstream"]);
        }
        assert.deepEqual(yield* workspaces.fetchMembers(group, ["api", "web"]), []);

        const workspace = (yield* workspaces.createWorkspace({
          cwd: group,
          refName: "HEAD",
          newRefName: "t3code/0a1b2c3d",
          path: null,
        })).worktree.path;
        assert.deepEqual(yield* currentBranches(workspace), ["t3code/0a1b2c3d", "t3code/0a1b2c3d"]);
        for (const member of ["api", "web"]) {
          assert.equal(
            yield* git(path.join(workspace, member), ["rev-parse", "HEAD"]),
            yield* git(path.join(upstreams, member), ["rev-parse", "main"]),
          );
        }
        yield* fileSystem.remove(workspace, { recursive: true });

        yield* git(path.join(group, "web"), [
          "remote",
          "set-url",
          "origin",
          path.join(group, "gone"),
        ]);
        assert.deepEqual(yield* workspaces.fetchMembers(group, ["api", "web"]), ["web"]);
      }).pipe(Effect.scoped),
  );

  it.effect("puts renamed members back when a later member cannot be renamed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
      const group = yield* makeGroup;
      const workspace = (yield* workspaces.createWorkspace({
        cwd: group,
        refName: "HEAD",
        newRefName: "t3code/def67890",
        path: null,
      })).worktree.path;

      // Fail after the first rename, not during the shared-name check.
      yield* git(path.join(workspace, "web"), ["switch", "-c", "other"]);
      yield* git(path.join(workspace, "web"), ["branch", "-D", "t3code/def67890"]);
      const error = yield* workspaces
        .renameBranch({
          cwd: workspace,
          members: ["api", "web"],
          oldBranch: "t3code/def67890",
          newBranch: "feature/signup",
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "GitCommandError");
      assert.deepEqual(yield* currentBranches(workspace), ["t3code/def67890", "other"]);
      yield* fileSystem.remove(workspace, { recursive: true });
    }).pipe(Effect.scoped),
  );

  it.effect("removes the partial workspace when a later member fails to clone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
      const group = yield* makeGroup;

      // A corrupt object passes Workler's plan but fails web's checkout, after
      // api is already cloned.
      const blob = yield* git(path.join(group, "web"), ["rev-parse", "HEAD:README.md"]);
      const object = path.join(group, "web", ".git", "objects", blob.slice(0, 2), blob.slice(2));
      yield* fileSystem.chmod(object, 0o644);
      yield* fileSystem.writeFileString(object, "corrupt");

      const error = yield* workspaces
        .createWorkspace({ cwd: group, refName: "HEAD", newRefName: "feature/x", path: null })
        .pipe(Effect.flip);
      assert.include(error.detail, "web");
      assert.notInclude(error.detail, "left in place");
      assert.isFalse(yield* fileSystem.exists(path.join(group, ".worktrees", "feature-x")));
    }).pipe(Effect.scoped),
  );
});

it.effect("uses the upstream flat temporary branch across all members when one blocks t3", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
    const group = yield* makeGroup;
    yield* git(path.join(group, "web"), ["branch", "t3"]);
    const created = yield* workspaces.createWorkspace({
      cwd: group,
      refName: "main",
      newRefName: "t3/abcd1234",
      path: null,
    });
    assert.equal(created.worktree.refName, "t3-abcd1234");
    for (const member of ["api", "web"]) {
      assert.equal(
        yield* git(path.join(created.worktree.path, member), ["branch", "--show-current"]),
        "t3-abcd1234",
      );
    }
  }).pipe(Effect.provide(TestLayer), Effect.scoped),
);

it.effect("honors exact custom names without splitting a group on collision", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const workspaces = yield* MultiRepoWorkspaces.MultiRepoWorkspaces;
    const group = yield* makeGroup;
    const created = yield* workspaces.createWorkspace({
      cwd: group,
      refName: "main",
      newRefName: "t3/abcd1234",
      path: null,
    });
    yield* git(path.join(created.worktree.path, "web"), ["branch", "custom/name"]);
    yield* workspaces
      .renameBranch({
        cwd: created.worktree.path,
        members: ["api", "web"],
        oldBranch: "t3/abcd1234",
        newBranch: "custom/name",
        exactName: true,
      })
      .pipe(Effect.flip);
    for (const member of ["api", "web"]) {
      assert.equal(
        yield* git(path.join(created.worktree.path, member), ["branch", "--show-current"]),
        "t3/abcd1234",
      );
    }
  }).pipe(Effect.provide(TestLayer), Effect.scoped),
);
