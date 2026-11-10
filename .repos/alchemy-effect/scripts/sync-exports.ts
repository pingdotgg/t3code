// Regenerate every package's export maps (see `exports.generate` in
// package-build.ts) without compiling anything: each package's
// `scripts/build.ts` runs in exports-only mode.
//
//   node scripts/sync-exports.ts           rewrite the package.json files
//   node scripts/sync-exports.ts --check   fail if any of them is out of date, or
//                                          if package source or an example
//                                          imports another package's internal
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Command, Flag } from "effect/cli";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

class InvalidManifest extends Data.TaggedError("InvalidManifest")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

const run = Effect.fn(function* (command: string, args: Array<string>, cwd: string) {
  const spawner = yield* ChildProcessSpawner;
  return yield* spawner.exitCode(
    ChildProcess.make(command, args, {
      cwd,
      env: { PACKAGE_BUILD_EXPORTS_ONLY: "1" },
      extendEnv: true,
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
});

const command = Command.make(
  "sync-exports",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription(
        "Fail if any export map is out of date, or if package source or an example imports another package's internal",
      ),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ check }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(import.meta.dirname, "..");
    const packages = path.join(root, "packages");

    const directories = (yield* fs.readDirectory(packages)).sort();
    // Packages whose published export maps block everything named `internal`.
    const blocking: Array<string> = [];
    for (const name of directories) {
      const directory = path.join(packages, name);
      if (!(yield* fs.exists(path.join(directory, "scripts", "build.ts")))) continue;
      const exitCode = yield* run("node", ["scripts/build.ts"], directory);
      if (exitCode !== 0) {
        return yield* Effect.fail(
          new Error(`packages/${name}: export sync exited with ${exitCode}`),
        );
      }
      const text = yield* fs.readFileString(path.join(directory, "package.json"));
      const manifest = yield* Effect.try({
        try: () =>
          JSON.parse(text) as {
            name: string;
            publishConfig?: { exports?: Record<string, unknown> };
          },
        catch: (cause) => new InvalidManifest({ path: `packages/${name}/package.json`, cause }),
      });
      if (Object.values(manifest.publishConfig?.exports ?? {}).includes(null)) {
        blocking.push(manifest.name.replaceAll(".", String.raw`\.`));
      }
    }

    if (check) {
      const exitCode = yield* run(
        "git",
        ["diff", "--exit-code", "--stat", "--", "packages/*/package.json"],
        root,
      );
      if (exitCode !== 0) {
        return yield* Effect.fail(
          new Error(
            "Package exports are out of date. Run `pnpm exports:sync` and commit the result.",
          ),
        );
      }
      // Published packages block `internal/` and `internal.ts`, so only tests may reach into them.
      const found = yield* run(
        "git",
        [
          "grep",
          "-nE",
          `"(${blocking.join("|")})/([^"]*/)?internal[/"]`,
          "--",
          "packages/*/src/**",
          "examples",
        ],
        root,
      );
      if (found === 0) {
        return yield* Effect.fail(
          new Error(
            "Package source and examples must not import another package's internal/ or internal.ts.",
          ),
        );
      }
      yield* Console.log("Package exports are up to date.");
    }
  }),
).pipe(Command.withDescription("Regenerate every package's export maps"));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
