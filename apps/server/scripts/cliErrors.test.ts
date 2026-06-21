import { assert, describe, it } from "@effect/vitest";

import * as CliErrors from "./cliErrors.ts";

describe("server CLI errors", () => {
  it("preserves the failed command exit code", () => {
    const error = new CliErrors.ServerCliCommandExitError({ exitCode: 17 });

    assert.equal(error._tag, "ServerCliCommandExitError");
    assert.equal(error.exitCode, 17);
    assert.equal(error.message, "Command exited with non-zero exit code (17)");
  });

  it("preserves missing paths and exact caller-facing messages", () => {
    const failures = [
      {
        error: new CliErrors.ServerCliPublishIconSourceMissingError({
          sourcePath: "/repo/icons/publish.png",
        }),
        tag: "ServerCliPublishIconSourceMissingError",
        path: "/repo/icons/publish.png",
        message: "Missing publish icon source: /repo/icons/publish.png",
      },
      {
        error: new CliErrors.ServerCliPublishIconTargetMissingError({
          targetPath: "/repo/dist/client/icon.png",
        }),
        tag: "ServerCliPublishIconTargetMissingError",
        path: "/repo/dist/client/icon.png",
        message:
          "Missing publish icon target: /repo/dist/client/icon.png. Run the build subcommand first.",
      },
      {
        error: new CliErrors.ServerCliDevelopmentIconSourceMissingError({
          sourcePath: "/repo/icons/development.png",
        }),
        tag: "ServerCliDevelopmentIconSourceMissingError",
        path: "/repo/icons/development.png",
        message: "Missing development icon source: /repo/icons/development.png",
      },
      {
        error: new CliErrors.ServerCliDevelopmentIconTargetMissingError({
          targetPath: "/repo/dist/client/icon.png",
        }),
        tag: "ServerCliDevelopmentIconTargetMissingError",
        path: "/repo/dist/client/icon.png",
        message: "Missing development icon target: /repo/dist/client/icon.png. Build web first.",
      },
      {
        error: new CliErrors.ServerCliBuildAssetMissingError({
          assetPath: "/repo/apps/server/dist/bin.mjs",
        }),
        tag: "ServerCliBuildAssetMissingError",
        path: "/repo/apps/server/dist/bin.mjs",
        message:
          "Missing build asset: /repo/apps/server/dist/bin.mjs. Run the build subcommand first.",
      },
    ] as const;

    for (const failure of failures) {
      assert.equal(failure.error._tag, failure.tag);
      assert.equal(failure.error.message, failure.message);
      assert.include(Object.values(failure.error), failure.path);
    }
  });
});
