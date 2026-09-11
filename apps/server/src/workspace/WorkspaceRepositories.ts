import { type WorkspaceRepository } from "@t3tools/contracts";
import { T3ProjectFileFromJson } from "@t3tools/shared/t3ProjectFile";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

export class WorkspaceRepositoryDiscoveryError extends Schema.TaggedError<WorkspaceRepositoryDiscoveryError>()(
  "WorkspaceRepositoryDiscoveryError",
  { cwd: Schema.String, message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export class WorkspaceRepositories extends Context.Service<
  WorkspaceRepositories,
  {
    readonly list: (
      cwd: string,
      options?: { readonly includeIdentity?: boolean },
    ) => Effect.Effect<ReadonlyArray<WorkspaceRepository>, WorkspaceRepositoryDiscoveryError>;
  }
>()("t3/workspace/WorkspaceRepositories") {}

const decodeProjectFile = Schema.decodeUnknownEffect(T3ProjectFileFromJson);
const isDiscoveryError = Schema.is(WorkspaceRepositoryDiscoveryError);

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess.VcsProcess;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;

  const list: WorkspaceRepositories["Service"]["list"] = Effect.fn("WorkspaceRepositories.list")(
    function* (cwd, options) {
      const root = yield* fs.realPath(cwd);
      const inside = (candidate: string) => {
        const relative = path.relative(root, candidate);
        return (
          !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
        );
      };
      const resolve = (relative: string) => {
        if (
          path.isAbsolute(relative) ||
          /^[A-Za-z]:/.test(relative) ||
          relative.includes("\\") ||
          relative.split("/").includes("..")
        ) {
          return undefined;
        }
        const candidate = path.resolve(root, relative);
        return inside(candidate) ? candidate : undefined;
      };
      const safeExisting = Effect.fn(function* (candidate: string) {
        if (!(yield* fs.exists(candidate))) return false;
        return inside(yield* fs.realPath(candidate));
      });
      const git = (at: string, args: ReadonlyArray<string>) =>
        vcs.run({
          operation: "WorkspaceRepositories.list",
          command: "git",
          cwd: at,
          args,
          env: { LC_ALL: "C" },
          allowNonZeroExit: true,
          timeoutMs: 10_000,
        });
      const available = Effect.fn(function* (at: string, exactRoot = true) {
        if (!(yield* safeExisting(at))) return false;
        if (exactRoot && !(yield* fs.exists(path.join(at, ".git")))) return false;
        const result = yield* git(at, ["rev-parse", "--show-toplevel"]);
        if (result.exitCode !== 0 && result.stderr.includes("not a git repository")) return false;
        if (result.exitCode !== 0)
          return yield* new WorkspaceRepositoryDiscoveryError({
            cwd: at,
            message: result.stderr.trim() || "Unable to inspect repository.",
          });
        return (
          !exactRoot || (yield* fs.realPath(result.stdout.trim())) === (yield* fs.realPath(at))
        );
      });
      const repositories = new Map<string, WorkspaceRepository>();
      repositories.set(".", {
        path: ".",
        name: path.basename(root) || root,
        cwd: root,
        kind: "root",
        available: yield* available(root, false),
      });
      const configPath = path.join(root, "t3.json");
      const config = (yield* fs.exists(configPath))
        ? yield* decodeProjectFile(yield* fs.readFileString(configPath))
        : undefined;
      const add = Effect.fn(function* (
        relative: string,
        kind: "repository" | "submodule",
        includeMissing: boolean,
      ) {
        const at = resolve(relative);
        if (!at)
          return yield* new WorkspaceRepositoryDiscoveryError({
            cwd,
            message: `Repository path '${relative}' must stay inside the workspace.`,
          });
        if (at === root)
          return yield* new WorkspaceRepositoryDiscoveryError({
            cwd,
            message: `Repository path '${relative}' resolves to the workspace root, which is already included.`,
          });
        if ((yield* fs.exists(at)) && !(yield* safeExisting(at))) return;
        const isAvailable = yield* available(at);
        if (!isAvailable && !includeMissing) return;
        const key = path.relative(root, at).split(path.sep).join("/");
        if (repositories.size >= 1000 && !repositories.has(key))
          return yield* new WorkspaceRepositoryDiscoveryError({
            cwd,
            message: "Workspace repository limit exceeded (1000).",
          });
        repositories.set(key, {
          path: key,
          name: path.basename(at),
          cwd: at,
          kind,
          available: isAvailable,
        });
      });
      for (const pattern of config?.repositories?.paths ?? []) {
        if (!resolve(pattern))
          return yield* new WorkspaceRepositoryDiscoveryError({
            cwd,
            message: `Repository path '${pattern}' must stay inside the workspace.`,
          });
        const wildcard = pattern.endsWith("/*");
        const directory = wildcard ? pattern.slice(0, -2) : pattern;
        if (directory.includes("*") || directory.includes("?") || directory.includes("["))
          return yield* new WorkspaceRepositoryDiscoveryError({
            cwd,
            message: `Unsupported repository pattern '${pattern}'. Use an explicit path or a trailing /*.`,
          });
        const at = resolve(directory);
        if (!at)
          return yield* new WorkspaceRepositoryDiscoveryError({
            cwd,
            message: `Repository path '${pattern}' must stay inside the workspace.`,
          });
        if (wildcard) {
          if (!(yield* safeExisting(at))) continue;
          for (const name of yield* fs.readDirectory(at)) {
            const child = path.join(at, name);
            if (!(yield* safeExisting(child))) continue;
            if ((yield* fs.stat(child)).type !== "Directory") continue;
            yield* add(path.relative(root, child).split(path.sep).join("/"), "repository", false);
          }
        } else {
          yield* add(directory, "repository", true);
        }
      }
      if (config?.repositories?.includeSubmodules) {
        const inspected = new Set<string>();
        for (const repository of repositories.values()) {
          if (
            inspected.has(repository.cwd) ||
            (!repository.available && repository.kind !== "root")
          )
            continue;
          inspected.add(repository.cwd);
          const modules = path.join(repository.cwd, ".gitmodules");
          if (!(yield* fs.exists(modules))) continue;
          const result = yield* git(repository.cwd, [
            "config",
            "--null",
            "--file",
            modules,
            "--get-regexp",
            "^submodule\\..*\\.path$",
          ]);
          if (result.exitCode !== 0 && result.exitCode !== 1)
            return yield* new WorkspaceRepositoryDiscoveryError({
              cwd,
              message: result.stderr.trim() || "Unable to read submodule declarations.",
            });
          for (const record of result.stdout.split("\0")) {
            const separator = record.indexOf("\n");
            if (separator < 0) continue;
            const declared = record.slice(separator + 1);
            if (!resolve(declared))
              return yield* new WorkspaceRepositoryDiscoveryError({
                cwd,
                message: `Invalid submodule path '${declared}'.`,
              });
            yield* add(
              path.relative(root, path.resolve(repository.cwd, declared)).split(path.sep).join("/"),
              "submodule",
              true,
            );
          }
        }
      }
      const ordered = [...repositories.values()].sort((a, b) =>
        a.path === "." ? -1 : b.path === "." ? 1 : a.path.localeCompare(b.path),
      );
      if (options?.includeIdentity === false) return ordered;
      const enriched = yield* Effect.forEach(
        ordered,
        (repository) =>
          Effect.gen(function* () {
            const repositoryIdentity = repository.available
              ? yield* identities.resolve(repository.cwd)
              : null;
            return { ...repository, ...(repositoryIdentity ? { repositoryIdentity } : {}) };
          }),
        { concurrency: 4 },
      );
      return enriched;
    },
    Effect.mapError((cause) =>
      isDiscoveryError(cause)
        ? cause
        : new WorkspaceRepositoryDiscoveryError({
            cwd: "workspace",
            message: "Failed to discover workspace repositories.",
            cause,
          }),
    ),
  );
  // Share simultaneous panel and file requests; completed discovery is never retained.
  const membershipFlights = yield* Cache.make({
    lookup: (cwd: string) => list(cwd, { includeIdentity: false }),
    capacity: 1000,
    timeToLive: "0 millis",
  });
  const identityFlights = yield* Cache.make({
    lookup: (cwd: string) => list(cwd),
    capacity: 1000,
    timeToLive: "0 millis",
  });
  return WorkspaceRepositories.of({
    list: (cwd, options) =>
      Cache.get(options?.includeIdentity === false ? membershipFlights : identityFlights, cwd),
  });
});

export const layer = Layer.effect(WorkspaceRepositories, make).pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(RepositoryIdentityResolver.layer),
);
