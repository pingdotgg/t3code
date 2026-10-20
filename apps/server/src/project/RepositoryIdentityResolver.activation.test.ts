// @effect-diagnostics nodeBuiltinImport:off - realpathSync.native resolves Windows 8.3 short names, which the Effect realPath does not.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import { createJjRepo, JJ_AVAILABLE, runJj } from "../vcs/testing/JjTestSupport.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const markerStatInterceptor = vi.hoisted(() => ({
  failPath: null as string | null,
  errorCode: "EACCES",
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFS>();
  return {
    ...actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      if (args[0] === markerStatInterceptor.failPath) {
        throw Object.assign(new Error("marker stat failed"), {
          code: markerStatInterceptor.errorCode,
        });
      }
      return actual.statSync(...args);
    },
  };
});

const normalizePathSeparators = (value: string) => value.replaceAll("\\", "/");
const normalizeResolvedPath = (value: string) => normalizePathSeparators(value);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args: ["-C", cwd, ...args],
    });
  }).pipe(Effect.provide(ProcessRunner.layer));

it.layer(NodeServices.layer)("RepositoryIdentityResolver activation", (it) => {
  it.effect(
    "resolves marker identity from the real directory, not a symlink's lexical parent",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-marker-realpath-" });
        const root = path.join(base, "repository");
        const nested = path.join(root, "nested");
        const aliasParent = path.join(base, "elsewhere");
        const alias = path.join(aliasParent, "linked");
        yield* fs.makeDirectory(path.join(root, ".jj", "repo"), { recursive: true });
        yield* fs.makeDirectory(nested);
        yield* fs.makeDirectory(aliasParent);
        yield* fs.symlink(nested, alias);
        expect(RepositoryIdentityResolver.resolveRepositoryRootFromMarkers(alias)).toBe(
          yield* fs.realPath(root),
        );
      }),
  );
  it.effect.each(
    ["EACCES", "EPERM", "EIO", "ELOOP", "UNKNOWN"].flatMap((code) =>
      [".jj", ".jj/repo"].map((marker) => ({ code, marker })),
    ),
  )(
    "preserves Git discovery unless $marker establishes a jj workspace ($code)",
    ({ code, marker }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-marker-error-",
        });
        yield* fileSystem.makeDirectory(path.join(root, ".jj", "repo"), { recursive: true });
        const nested = path.join(root, "nested");
        yield* fileSystem.makeDirectory(path.join(nested, ".jj"), { recursive: true });
        const calls: Array<ReadonlyArray<string>> = [];
        const processRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (input) =>
            Effect.sync(() => {
              calls.push(input.args);
              return {
                stdout: input.args.includes("rev-parse")
                  ? `${root}\n`
                  : "origin\tgit@github.com:T3Tools/parent.git (fetch)\n",
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
            }),
        });
        markerStatInterceptor.failPath = path.join(nested, marker);
        markerStatInterceptor.errorCode = code;
        try {
          const resolver = yield* RepositoryIdentityResolver.make().pipe(
            Effect.provide(processRunner),
          );
          const identity = yield* resolver.resolve(nested);
          expect(identity?.canonicalKey).toBe("github.com/t3tools/parent");
          expect(identity?.rootPath).toBe(marker === ".jj" ? root : nested);
          expect(calls).toEqual(
            marker === ".jj"
              ? [
                  ["-C", nested, "rev-parse", "--show-toplevel"],
                  ["-C", root, "remote", "-v"],
                ]
              : [["-C", nested, "remote", "-v"]],
          );
        } finally {
          markerStatInterceptor.failPath = null;
        }
      }),
  );

  it.effect.skipIf(!JJ_AVAILABLE)(
    "resolves a secondary Jujutsu workspace through the main workspace root",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fileSystem.realPath(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-repository-identity-jj-test-" }),
        );
        const root = path.join(base, "project");
        yield* fileSystem.makeDirectory(root, { recursive: true });
        yield* createJjRepo(root);
        yield* git(root, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);
        yield* fileSystem.writeFileString(path.join(root, "seed.txt"), "seed\n");
        yield* runJj(root, ["commit", "-m", "seed"]);
        const workspace = path.join(base, "thread");
        yield* runJj(root, ["workspace", "add", "--name", "t3-thread", workspace]);

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const identity = yield* resolver.resolve(workspace);

        expect(identity).not.toBeNull();
        expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(normalizeResolvedPath(identity?.rootPath ?? "")).toBe(normalizeResolvedPath(root));
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );
});
