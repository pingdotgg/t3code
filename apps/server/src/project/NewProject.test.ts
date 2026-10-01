import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { createNewProjectFolder } from "./NewProject.ts";

const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-new-project-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const GIT_ENV_KEYS = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "EMAIL",
] as const;

// Git reads the developer's own config (signing, default branch, identity)
// unless the test replaces it, so each test runs against an empty one.
const withGitEnv = <A, E, R>(
  env: Partial<Record<(typeof GIT_ENV_KEYS)[number], string>>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const emptyConfig = yield* fileSystem.makeTempFileScoped({ prefix: "t3-gitconfig-" });
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const saved = GIT_ENV_KEYS.map((key) => [key, process.env[key]] as const);
        for (const key of GIT_ENV_KEYS) delete process.env[key];
        Object.assign(process.env, {
          GIT_CONFIG_GLOBAL: emptyConfig,
          GIT_CONFIG_NOSYSTEM: "1",
          ...env,
        });
        return saved;
      }),
      () => effect,
      (saved) =>
        Effect.sync(() => {
          for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }),
    );
  });

const gitOutput = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* git.execute({ operation: "NewProject.test", cwd, args });
    return result.stdout.trim();
  });

it.layer(TestLayer)("createNewProjectFolder", (it) => {
  it.effect("makes the folder, starter files, and first commit, and suffixes a taken name", () =>
    Effect.scoped(
      withGitEnv(
        {
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@test.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@test.com",
        },
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = path.join(
            yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-projects-" }),
            "projects",
          );

          const first = yield* createNewProjectFolder({ root, name: "Pinball Stats" });
          const second = yield* createNewProjectFolder({ root, name: "pinball stats" });

          assert.equal(first.workspaceRoot, path.join(root, "pinball-stats"));
          assert.equal(second.workspaceRoot, path.join(root, "pinball-stats-2"));
          assert.isUndefined(first.commitError);
          const readme = yield* fileSystem.readFileString(
            path.join(first.workspaceRoot, "README.md"),
          );
          assert.include(readme, "# Pinball Stats");
          assert.include(readme, `src="assets/icon.svg"`);
          const icon = yield* fileSystem.readFileString(
            path.join(first.workspaceRoot, "assets", "icon.svg"),
          );
          assert.include(icon, ">PS</text>");
          assert.equal(
            yield* gitOutput(first.workspaceRoot, ["log", "--format=%s"]),
            "Initial commit",
          );
          assert.equal(
            yield* gitOutput(first.workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
            "main",
          );
          assert.equal(yield* gitOutput(first.workspaceRoot, ["status", "--porcelain"]), "");
        }),
      ),
    ),
  );

  it.effect("keeps the folder and reports why when Git cannot commit", () =>
    Effect.scoped(
      // No identity anywhere, and Git may not guess one from the host name.
      withGitEnv(
        {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "user.useConfigOnly",
          GIT_CONFIG_VALUE_0: "true",
        },
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-projects-" });

          const result = yield* createNewProjectFolder({ root, name: "No Identity" });

          assert.include(result.commitError ?? "", "no name or email");
          assert.isTrue(yield* fileSystem.exists(path.join(result.workspaceRoot, "README.md")));
          assert.isTrue(yield* fileSystem.exists(path.join(result.workspaceRoot, ".git")));
        }),
      ),
    ),
  );
});
