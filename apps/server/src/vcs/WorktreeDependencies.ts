import { GitCommandError, T3ProjectFile } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { makeFileClone } from "./FileClone.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const decodeProjectFile = Schema.decodeUnknownEffect(Schema.fromJsonString(T3ProjectFile));

/** Seeds dependencies only as part of running an effective project setup script. */
export const makeWorktreeDependencies = Effect.fn("makeWorktreeDependencies")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const { supported, clone } = yield* makeFileClone();
  const git = (cwd: string, args: string[], allowNonZeroExit = false) =>
    driver.execute({
      operation: "GitVcsDriver.worktreeDependencies",
      cwd,
      args,
      allowNonZeroExit,
      timeoutMs: 300_000,
      maxOutputBytes: 16 * 1024 * 1024,
    });

  const warmDependencies = Effect.fn("WorktreeDependencies.warmDependencies")(function* (
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

  return warmDependencies;
});
