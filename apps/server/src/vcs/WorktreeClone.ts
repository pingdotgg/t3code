import { GitCommandError, T3ProjectFile } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { makeFileClone } from "./FileClone.ts";

import type { CreateWorktreeProgress, GitVcsDriver } from "./GitVcsDriver.ts";

const timeoutMs = 300_000;
const maxOutputBytes = 16 * 1024 * 1024;
const decodeProjectFile = Schema.decodeUnknownEffect(Schema.fromJsonString(T3ProjectFile));

/** Seeds an ordinary Git worktree; Git still owns its index and final contents. */
export const makeWorktreeClone = Effect.fn("makeWorktreeClone")(function* (
  execute: GitVcsDriver["Service"]["execute"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { supported, clone } = yield* makeFileClone();
  const git = (cwd: string, args: string[], allowNonZeroExit = false) =>
    execute({
      operation: "GitVcsDriver.worktreeClone",
      cwd,
      args,
      allowNonZeroExit,
      timeoutMs,
      maxOutputBytes,
    });

  const prepare = Effect.fn("WorktreeClone.prepare")(
    function* (cwd: string, ref: string) {
      if (!supported) return null;
      const projectFile = path.join(cwd, "t3.json");
      if (yield* fs.exists(projectFile)) {
        const project = yield* decodeProjectFile(yield* fs.readFileString(projectFile));
        if (project.worktreeCloneFiles === false) return null;
      }
      const head = (yield* git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
      if ((yield* git(cwd, ["rev-parse", `${ref}^{commit}`])).stdout.trim() !== head) return null;
      const root = (yield* git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
      if ((yield* fs.realPath(root)) !== (yield* fs.realPath(cwd))) return null;

      // Filters can depend on the checkout path. Sparse/worktree-specific config
      // and checkout hooks must retain Git's normal worktree-add semantics.
      const config = yield* git(
        cwd,
        [
          "config",
          "--get-regexp",
          "^(filter\\.|core\\.sparsecheckout$|extensions\\.worktreeconfig$)",
        ],
        true,
      );
      if (config.exitCode !== 1) return null;
      const hook = (yield* git(cwd, [
        "rev-parse",
        "--git-path",
        "hooks/post-checkout",
      ])).stdout.trim();
      if (yield* fs.exists(path.resolve(cwd, hook))) return null;
      const status = yield* git(cwd, ["status", "--porcelain=v1", "-uno"]);
      if (status.stdoutTruncated || status.stdout.length > 0) return null;
      const tree = yield* git(cwd, ["ls-tree", "-rz", "--full-tree", head]);
      if (tree.stdoutTruncated) return null;
      const files: string[] = [];
      const attributes: string[] = [];
      let totalFiles = 0;
      for (const entry of tree.stdout.split("\0")) {
        if (!entry) continue;
        // Git materializes symbolic links and initializes submodules after the
        // regular files have been cloned and verified. Never follow source links.
        if (!entry.startsWith("100644 blob ") && !entry.startsWith("100755 blob ")) continue;
        const name = entry.slice(entry.indexOf("\t") + 1);
        if (name.split("/").some((part) => part === ".git" || part === "..")) return null;
        totalFiles += 1;
        if (path.basename(name) === ".gitattributes") attributes.push(name);
        files.push(name);
      }
      return files.length > 0 ? { cwd, head, files, attributes, totalFiles } : null;
    },
    Effect.orElseSucceed(() => null),
  );

  const checkout = Effect.fn("WorktreeClone.checkout")(function* (
    plan: { cwd: string; head: string; files: string[]; attributes: string[]; totalFiles: number },
    destination: string,
    onProgress?: CreateWorktreeProgress["onCheckoutProgress"],
  ) {
    const copy = Effect.gen(function* () {
      if ((yield* git(destination, ["rev-parse", "HEAD"])).stdout.trim() !== plan.head)
        return false;
      let completed = 0;
      const groups = new Map<string, string[]>();
      for (const name of plan.files) {
        const parent = path.dirname(name);
        const group = groups.get(parent) ?? [];
        group.push(path.join(plan.cwd, name));
        groups.set(parent, group);
      }
      for (const [parent, sources] of groups) {
        const target = path.join(destination, parent);
        yield* fs.makeDirectory(target, { recursive: true });
        // Bound argv size; one cp per batch, not one process per file.
        for (let start = 0; start < sources.length; start += 64) {
          const batch = sources.slice(start, start + 64);
          yield* clone(batch, target);
          completed += batch.length;
          if (onProgress)
            yield* onProgress({
              percent: Math.min(99, Math.floor((completed * 100) / plan.totalFiles)),
              completed,
              total: plan.totalFiles,
            });
        }
      }
      yield* git(destination, ["read-tree", "HEAD"]);
      for (const name of plan.attributes) {
        yield* git(destination, ["checkout-index", "--force", "--", name]);
      }
      // Refresh hashes the cloned files against the new index. A source edit
      // during cloning stays dirty and the reset below replaces it from Git.
      yield* git(destination, ["update-index", "--refresh"], true);
      return true;
    });
    const copied = yield* copy.pipe(Effect.orElseSucceed(() => false));
    // This also finishes partial/non-APFS copies. Clean refreshed clones are
    // retained; missing or changed files are materialized by Git as usual.
    yield* git(destination, ["reset", "--hard", "HEAD"]);
    return copied;
  });

  const warmDependencies = Effect.fn("WorktreeClone.warmDependencies")(function* (
    cwd: string,
    destination: string,
  ) {
    if (!supported) return;
    // Seeding is only an install accelerator. Require the repository to declare
    // a setup step so this never silently replaces dependency reconciliation.
    const project = yield* decodeProjectFile(
      yield* fs.readFileString(path.join(destination, "t3.json")),
    );
    if (
      !project.worktreeCloneDependencies ||
      !project.scripts?.some((script) => script.runOnWorktreeCreate)
    )
      return;
    const root = (yield* git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
    if ((yield* fs.realPath(root)) !== (yield* fs.realPath(cwd))) return;
    const targetStatus = yield* git(destination, ["status", "--porcelain=v1", "-uno"]);
    if (targetStatus.stdoutTruncated || targetStatus.stdout.length > 0) return;
    const sourceHead = (yield* git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
    if ((yield* git(destination, ["rev-parse", "HEAD"])).stdout.trim() !== sourceHead) return;
    const status = yield* git(cwd, ["status", "--porcelain=v1", "-uno"]);
    if (status.stdoutTruncated || status.stdout.length > 0) return;
    const tracked = yield* git(destination, ["ls-files", "-z"]);
    if (tracked.stdoutTruncated) return;
    const files = tracked.stdout.split("\0");
    if (
      !files.some((name) =>
        ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"].includes(
          name,
        ),
      )
    )
      return;
    const roots = files
      .filter((name) => path.basename(name) === "package.json")
      .map((name) => path.dirname(name));
    for (const root of roots) {
      const relative = path.join(root, "node_modules");
      if (files.some((name) => name === relative || name.startsWith(`${relative}/`))) continue;
      const source = path.join(cwd, relative);
      const target = path.join(destination, relative);
      if (!(yield* fs.exists(source)) || (yield* fs.exists(target))) continue;
      // A symlinked node_modules usually denotes a shared environment; never
      // turn it into another worktree's dependency directory.
      if (
        yield* fs.readLink(source).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
      )
        continue;
      const ignored = yield* git(cwd, ["check-ignore", "-q", "--", relative], true);
      if (ignored.exitCode !== 0) continue;
      const seed = Effect.gen(function* () {
        const staging = yield* fs.makeTempDirectoryScoped({
          directory: destination,
          prefix: ".t3-deps-",
        });
        yield* clone([source], staging);
        const staged = path.join(staging, "node_modules");
        const directories = [staged];
        while (directories.length > 0) {
          const directory = directories.pop()!;
          for (const name of yield* fs.readDirectory(directory)) {
            const entry = path.join(directory, name);
            if ([".bin", ".cache", ".vite", ".vite-temp"].includes(name)) {
              yield* fs.remove(entry, { recursive: true, force: true });
              continue;
            }
            const link = yield* fs.readLink(entry).pipe(Effect.orElseSucceed(() => null));
            if (link !== null) {
              const original = path.join(source, path.relative(staged, entry));
              const resolved = path.resolve(path.dirname(original), link);
              const fromProject = path.relative(cwd, resolved);
              if (
                path.isAbsolute(link) ||
                fromProject === ".." ||
                fromProject.startsWith(`..${path.sep}`)
              ) {
                return yield* new GitCommandError({
                  operation: "GitVcsDriver.worktreeClone",
                  cwd,
                  command: "/bin/cp",
                  detail: "Dependencies contain a non-portable symlink",
                });
              }
            } else if ((yield* fs.stat(entry)).type === "Directory") {
              directories.push(entry);
            }
          }
        }
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.rename(staged, target);
      }).pipe(Effect.scoped);
      yield* seed.pipe(Effect.ignore);
    }
  }, Effect.ignore());

  return { prepare, checkout, warmDependencies };
});
