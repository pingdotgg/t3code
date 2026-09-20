import { T3ProjectFile } from "@t3tools/contracts";
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
// The owning driver supplies its local executor so clone commands share its
// tracing and process policy without depending on the driver being constructed.
export const makeWorktreeClone = Effect.fn("makeWorktreeClone")(function* (
  execute: GitVcsDriver["Service"]["execute"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { supported, clone, cloneGroups } = yield* makeFileClone();
  const git = (cwd: string, args: string[], allowNonZeroExit = false, stdin?: string) =>
    execute({
      operation: "GitVcsDriver.worktreeClone",
      cwd,
      args,
      allowNonZeroExit,
      ...(stdin === undefined ? {} : { stdin }),
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
      // Conditional includes can activate different hooks/filters in the target.
      const config = yield* git(
        cwd,
        [
          "config",
          "--get-regexp",
          "^(filter\\.|includeif\\.|core\\.sparsecheckout$|extensions\\.worktreeconfig$)",
        ],
        true,
      );
      if (config.exitCode !== 1) return null;
      const autoCrlf = yield* git(cwd, ["config", "--get", "core.autocrlf"], true);
      if (autoCrlf.exitCode !== 1 && autoCrlf.stdout.trim().toLowerCase() !== "false") return null;
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
      const executables: string[] = [];
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
        if (entry.startsWith("100755 ")) executables.push(name);
      }
      // A clean index does not prove that the source has fresh-checkout bytes:
      // clean conversions can hide LF/CRLF, encoding, or ident differences.
      const conversions = yield* git(
        cwd,
        [
          "check-attr",
          "--cached",
          "-z",
          "--stdin",
          "text",
          "eol",
          "crlf",
          "ident",
          "filter",
          "working-tree-encoding",
        ],
        false,
        `${files.join("\0")}\0`,
      );
      if (conversions.stdoutTruncated) return null;
      const converted = new Set<string>();
      const values = conversions.stdout.split("\0");
      for (let index = 0; index + 2 < values.length; index += 3) {
        if (values[index + 2] !== "unspecified" && values[index + 2] !== "unset") {
          converted.add(values[index]!);
        }
      }
      const cloneFiles = files.filter((name) => !converted.has(name));
      return cloneFiles.length > 0
        ? { cwd, head, files: cloneFiles, attributes, executables, totalFiles }
        : null;
    },
    Effect.orElseSucceed(() => null),
  );

  const checkout = Effect.fn("WorktreeClone.checkout")(function* (
    plan: {
      cwd: string;
      head: string;
      files: string[];
      attributes: string[];
      executables: string[];
      totalFiles: number;
    },
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
      const windowsGroups = [];
      for (const [parent, sources] of groups) {
        const target = path.join(destination, parent);
        yield* fs.makeDirectory(target, { recursive: true });
        if (cloneGroups) {
          windowsGroups.push({ sources, destination: target });
          continue;
        }
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
      if (cloneGroups) {
        // Windows receives all paths on stdin and compiles its native helper once.
        yield* cloneGroups(windowsGroups);
        if (onProgress)
          yield* onProgress({
            percent: Math.min(99, Math.floor((plan.files.length * 100) / plan.totalFiles)),
            completed: plan.files.length,
            total: plan.totalFiles,
          });
      }
      // Git records only executable versus regular mode. Source read-only or
      // ignored executable bits must not leak into the new checkout.
      const executables = new Set(plan.executables);
      for (const name of plan.files) {
        const target = path.join(destination, name);
        const link = yield* fs.readLink(target).pipe(Effect.orElseSucceed(() => null));
        if (link === null && (yield* fs.stat(target)).type === "File") {
          yield* fs.chmod(target, (executables.has(name) ? 0o777 : 0o666) & ~process.umask());
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

  return { prepare, checkout };
});
