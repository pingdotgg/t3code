import { assert, describe, it } from "@effect/vitest";

import {
  ServerCliBuildAssetMissingError,
  ServerCliCommandExitError,
  ServerCliTuiBundleImportError,
} from "./cliErrors.ts";

describe("server CLI errors", () => {
  it("preserves failed command context without changing its message", () => {
    const error = new ServerCliCommandExitError({
      command: "vp",
      args: ["pm", "publish"],
      cwd: "/repo",
      exitCode: 17,
    });

    assert.equal(error._tag, "ServerCliCommandExitError");
    assert.equal(error.command, "vp");
    assert.deepEqual(error.args, ["pm", "publish"]);
    assert.equal(error.cwd, "/repo");
    assert.equal(error.exitCode, 17);
    assert.equal(error.message, "Command exited with non-zero exit code (17)");
  });

  it("preserves a representative missing asset path", () => {
    const error = new ServerCliBuildAssetMissingError({ assetPath: "/repo/server.mjs" });

    assert.equal(error.assetPath, "/repo/server.mjs");
    assert.equal(
      error.message,
      "Missing build asset: /repo/server.mjs. Run the build subcommand first.",
    );
  });

  it("identifies an unresolved TUI runtime import", () => {
    const error = new ServerCliTuiBundleImportError({
      assetPath: "/repo/dist/tui/index.js",
      specifier: "@xterm/headless",
    });

    assert.equal(
      error.message,
      "TUI bundle contains an unresolved runtime import (@xterm/headless): /repo/dist/tui/index.js",
    );
  });
});
