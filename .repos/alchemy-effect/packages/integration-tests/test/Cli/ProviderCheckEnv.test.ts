import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@alchemy.run/test";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/process/ChildProcess";

const CLI = fileURLToPath(new URL("../../../alchemy/bin/cli.js", import.meta.url));

/**
 * The CLI discovers providers from the `package.json` dependencies of its
 * cwd, so these run from this package, which depends on `@alchemy.run/aws`.
 */
const PROJECT = fileURLToPath(new URL("../..", import.meta.url));

const checkEnv = (args: ReadonlyArray<string>, env: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({
      prefix: "alchemy-check-env-",
    });
    const handle = yield* ChildProcess.make("bun", [CLI, "provider", "check-env", ...args], {
      cwd: PROJECT,
      env: { ALCHEMY_HOME: home, ...env },
      extendEnv: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      killSignal: "SIGTERM",
      forceKillAfter: "1 second",
    });
    return yield* handle.exitCode;
  }).pipe(Effect.scoped, Effect.provide(PlatformServices));

describe("provider check-env", { tags: ["unit", "local"] }, () => {
  it.live("exits 1 when a required var is missing", () =>
    Effect.gen(function* () {
      expect(
        yield* checkEnv(["--provider", "aws"], {
          AWS_ACCESS_KEY_ID: "",
          AWS_SECRET_ACCESS_KEY: "",
        }),
      ).toBe(1);
    }),
  );

  it.live("exits 0 when the contract is satisfied", () =>
    Effect.gen(function* () {
      expect(
        yield* checkEnv(["--provider", "aws"], {
          AWS_ACCESS_KEY_ID: "AKIATESTKEY",
          AWS_SECRET_ACCESS_KEY: "test-secret",
          AWS_REGION: "us-east-1",
        }),
      ).toBe(0);
    }),
  );

  it.live("accepts an explicit profile", () =>
    Effect.gen(function* () {
      expect(
        yield* checkEnv(["--profile", "default", "--provider", "aws"], {
          AWS_ACCESS_KEY_ID: "AKIATESTKEY",
          AWS_SECRET_ACCESS_KEY: "test-secret",
          AWS_REGION: "us-east-1",
        }),
      ).toBe(0);
    }),
  );
});
