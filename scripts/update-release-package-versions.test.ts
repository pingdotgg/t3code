import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, CliError } from "effect/unstable/cli";
import * as TestConsole from "effect/testing/TestConsole";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

import {
  ReleaseGitHubOutputConfigurationError,
  ReleaseGitHubOutputWriteError,
  ReleasePackageManifestError,
  releasePackageFiles,
  updateReleasePackageVersions,
  updateReleasePackageVersionsCommand,
} from "./update-release-package-versions.ts";

const ScriptTestLayer = Layer.mergeAll(NodeServices.layer, TestConsole.layer);
const runCli = Command.runWith(updateReleasePackageVersionsCommand, { version: "0.0.0" });
const PackageJsonSchema = Schema.Record(Schema.String, Schema.Unknown);
const PackageJsonPrettyJson = fromJsonStringPretty(PackageJsonSchema);
const decodePackageJson = Schema.decodeEffect(PackageJsonPrettyJson);
const encodePackageJson = Schema.encodeEffect(PackageJsonPrettyJson);

const writePackageJsonFixtures = Effect.fn("writePackageJsonFixtures")(function* (
  rootDir: string,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  for (const relativePath of releasePackageFiles) {
    const filePath = path.join(rootDir, relativePath);
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(
      filePath,
      `${yield* encodePackageJson({
        name: relativePath,
        version,
        private: true,
      })}\n`,
    );
  }
});

const readReleaseVersions = Effect.fn("readReleaseVersions")(function* (rootDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const versions = new Map<string, string>();

  for (const relativePath of releasePackageFiles) {
    const filePath = path.join(rootDir, relativePath);
    const packageJson = yield* fs.readFileString(filePath).pipe(Effect.flatMap(decodePackageJson));
    versions.set(relativePath, String(packageJson.version));
  }

  return versions;
});

const assertPlatformError = (cause: unknown, reasonTag: string) => {
  assert.isNotNull(cause);
  assert.equal(typeof cause, "object");
  assert.equal((cause as { readonly _tag?: unknown })._tag, "PlatformError");
  assert.equal(
    (cause as { readonly reason?: { readonly _tag?: unknown } }).reason?._tag,
    reasonTag,
  );
};

const captureLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const result = yield* effect;
    const logs = (yield* TestConsole.logLines).filter(
      (line): line is string => typeof line === "string",
    );
    return { result, logs };
  });

it.layer(ScriptTestLayer)("update-release-package-versions", (it) => {
  it.effect("updates all release package versions under the provided root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "update-release-package-versions-",
      });

      yield* writePackageJsonFixtures(baseDir, "0.0.1");

      const result = yield* updateReleasePackageVersions("1.2.3", { rootDir: baseDir });
      const versions = yield* readReleaseVersions(baseDir);

      assert.deepStrictEqual(result, { changed: true });
      assert.deepStrictEqual(
        Array.from(versions.entries()),
        releasePackageFiles.map((relativePath) => [relativePath, "1.2.3"]),
      );
    }),
  );

  it.effect("returns changed=false when all versions already match", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "update-release-package-versions-unchanged-",
      });

      yield* writePackageJsonFixtures(baseDir, "1.2.3");

      const result = yield* updateReleasePackageVersions("1.2.3", { rootDir: baseDir });

      assert.deepStrictEqual(result, { changed: false });
    }),
  );

  it.effect("preserves manifest read context and the filesystem cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "update-release-package-versions-read-error-",
      });
      const filePath = path.join(baseDir, releasePackageFiles[0]);

      const error = yield* updateReleasePackageVersions("1.2.3", {
        rootDir: baseDir,
      }).pipe(Effect.flip);

      assert.instanceOf(error, ReleasePackageManifestError);
      assert.equal(error.operation, "read");
      assert.equal(error.filePath, filePath);
      assertPlatformError(error.cause, "NotFound");
      assert.equal(error.message, `Failed to read release package manifest '${filePath}'.`);
    }),
  );

  it.effect("preserves manifest decode context and the schema cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "update-release-package-versions-decode-error-",
      });
      const filePath = path.join(baseDir, releasePackageFiles[0]);

      yield* writePackageJsonFixtures(baseDir, "0.0.1");
      yield* fs.writeFileString(filePath, "not json");

      const error = yield* updateReleasePackageVersions("1.2.3", {
        rootDir: baseDir,
      }).pipe(Effect.flip);

      assert.equal(error.operation, "decode");
      assert.equal(error.filePath, filePath);
      assert.isTrue(Schema.isSchemaError(error.cause));
      assert.equal(error.message, `Failed to decode release package manifest '${filePath}'.`);
    }),
  );

  it.effect("preserves manifest write context and the filesystem cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "update-release-package-versions-write-error-",
      });
      const filePath = path.join(baseDir, releasePackageFiles[0]);

      yield* writePackageJsonFixtures(baseDir, "0.0.1");
      yield* fs.chmod(filePath, 0o400);

      const error = yield* updateReleasePackageVersions("1.2.3", {
        rootDir: baseDir,
      }).pipe(Effect.flip, Effect.ensuring(fs.chmod(filePath, 0o600).pipe(Effect.orDie)));

      assert.equal(error.operation, "write");
      assert.equal(error.filePath, filePath);
      assertPlatformError(error.cause, "PermissionDenied");
      assert.equal(error.message, `Failed to write release package manifest '${filePath}'.`);
    }),
  );

  it.effect("accepts flags before the version positional and appends changed output", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "update-release-package-versions-cli-",
      });
      const githubOutputPath = path.join(baseDir, "github-output.txt");

      yield* writePackageJsonFixtures(baseDir, "0.0.1");

      yield* runCli(["--github-output", "--root", baseDir, "2.0.0"]).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                GITHUB_OUTPUT: githubOutputPath,
              },
            }),
          ),
        ),
      );

      const githubOutput = yield* fs.readFileString(githubOutputPath);
      assert.equal(githubOutput, "changed=true\n");
    }),
  );

  it.effect("logs when nothing changed", () =>
    captureLogs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({
          prefix: "update-release-package-versions-cli-log-",
        });

        yield* writePackageJsonFixtures(baseDir, "3.0.0");
        yield* runCli(["3.0.0", "--root", baseDir]);
      }),
    ).pipe(
      Effect.tap(({ logs }) => {
        assert.deepStrictEqual(logs, ["All package.json versions already match release version."]);
        return Effect.void;
      }),
    ),
  );

  it.effect("requires GITHUB_OUTPUT when --github-output is set", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "update-release-package-versions-cli-missing-output-",
      });

      yield* writePackageJsonFixtures(baseDir, "0.0.1");

      const error = yield* runCli(["4.0.0", "--root", baseDir, "--github-output"]).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        Effect.flip,
      );

      assert.instanceOf(error, ReleaseGitHubOutputConfigurationError);
      assert.instanceOf(error.cause, Config.ConfigError);
      assert.equal(
        error.message,
        "Failed to resolve GITHUB_OUTPUT for release package version output.",
      );
    }),
  );

  it.effect("preserves GITHUB_OUTPUT write context and the filesystem cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "update-release-package-versions-cli-output-error-",
      });

      yield* writePackageJsonFixtures(baseDir, "0.0.1");

      const error = yield* runCli(["4.0.0", "--root", baseDir, "--github-output"]).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                GITHUB_OUTPUT: baseDir,
              },
            }),
          ),
        ),
        Effect.flip,
      );

      assert.instanceOf(error, ReleaseGitHubOutputWriteError);
      assert.equal(error.filePath, baseDir);
      assertPlatformError(error.cause, "BadResource");
      assert.equal(
        error.message,
        `Failed to append release package version output to '${baseDir}'.`,
      );
    }),
  );

  it.effect("rejects unknown flags during cli parsing", () =>
    Effect.gen(function* () {
      const error = yield* runCli(["1.2.3", "--unknown"]).pipe(Effect.flip);

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }

      const optionError =
        error._tag === "ShowHelp" ? (error.errors[0] as CliError.CliError | undefined) : error;

      if (!optionError || optionError._tag !== "UnrecognizedOption") {
        assert.fail(`Expected UnrecognizedOption, got ${String(optionError?._tag)}`);
      }

      assert.equal(optionError.option, "--unknown");
    }),
  );

  it.effect("rejects a missing version positional during cli parsing", () =>
    Effect.gen(function* () {
      const error = yield* runCli(["--github-output"]).pipe(Effect.flip);

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }

      const versionError =
        error._tag === "ShowHelp" ? (error.errors[0] as CliError.CliError | undefined) : error;

      if (!versionError || versionError._tag !== "MissingArgument") {
        assert.fail(`Expected MissingArgument, got ${String(versionError?._tag)}`);
      }

      assert.equal(versionError.argument, "version");
    }),
  );
});
