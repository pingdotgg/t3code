import * as NodeOS from "node:os";

import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const GITBUTLER_APP_IDENTIFIERS = [
  "com.gitbutler.app",
  "com.gitbutler.app.nightly",
  "com.gitbutler.app.dev",
] as const;

const GitButlerProjectsFile = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      path: Schema.String,
    }),
  ),
);
const decodeGitButlerProjectsFile = Schema.decodeEffect(GitButlerProjectsFile);

export type GitButlerRegistrationStatus = "registered" | "unregistered" | "error";

export function gitButlerRegistryPaths(
  input: {
    readonly platform: NodeJS.Platform;
    readonly environment: NodeJS.ProcessEnv;
    readonly homeDir: string;
  },
  path: Path.Path,
): ReadonlyArray<string> {
  const testAppDataDir = input.environment.E2E_TEST_APP_DATA_DIR?.trim();
  if (testAppDataDir) return [path.join(testAppDataDir, "projects.json")];

  const dataDir =
    input.platform === "darwin"
      ? path.join(input.homeDir, "Library", "Application Support")
      : input.platform === "win32"
        ? input.environment.APPDATA?.trim() || path.join(input.homeDir, "AppData", "Roaming")
        : input.environment.XDG_DATA_HOME?.trim() || path.join(input.homeDir, ".local", "share");

  if (input.platform === "linux") {
    return [path.join(dataDir, "gitbutler-tauri", "projects.json")];
  }

  return GITBUTLER_APP_IDENTIFIERS.map((identifier) =>
    path.join(dataDir, identifier, "projects.json"),
  );
}

export class GitButlerProjectRegistry extends Context.Service<
  GitButlerProjectRegistry,
  {
    readonly registrationStatus: (
      workspaceRoot: string,
    ) => Effect.Effect<GitButlerRegistrationStatus>;
  }
>()("t3/gitButler/GitButlerProjectRegistry") {}

export const makeForPaths = Effect.fn("GitButlerProjectRegistry.makeForPaths")(function* (
  registryPaths: ReadonlyArray<string>,
  options: { readonly caseInsensitive?: boolean } = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return options.caseInsensitive ? resolved.toLowerCase() : resolved;
  };

  const registrationStatus = Effect.fn("GitButlerProjectRegistry.registrationStatus")(function* (
    workspaceRoot: string,
  ) {
    const expectedPath = normalize(workspaceRoot);
    let sawUnreadableRegistry = false;

    for (const registryPath of registryPaths) {
      const exists = yield* fileSystem.exists(registryPath).pipe(Effect.orElseSucceed(() => false));
      if (!exists) continue;

      const decoded = yield* fileSystem.readFileString(registryPath).pipe(
        Effect.flatMap(decodeGitButlerProjectsFile),
        Effect.map((projects) => ({ status: "ok" as const, projects })),
        Effect.orElseSucceed(() => ({ status: "error" as const })),
      );
      if (decoded.status === "error") {
        sawUnreadableRegistry = true;
        continue;
      }
      if (decoded.projects.some((project) => normalize(project.path) === expectedPath)) {
        return "registered" as const;
      }
    }

    return sawUnreadableRegistry ? ("error" as const) : ("unregistered" as const);
  });

  return GitButlerProjectRegistry.of({ registrationStatus });
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  return yield* makeForPaths(
    gitButlerRegistryPaths(
      {
        platform,
        environment,
        homeDir: NodeOS.homedir(),
      },
      path,
    ),
    { caseInsensitive: platform === "win32" },
  );
});

export const layer = Layer.effect(GitButlerProjectRegistry, make);
