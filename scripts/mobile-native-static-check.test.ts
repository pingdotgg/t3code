import { assert, it } from "@effect/vitest";

import { NativeStaticCheckCommandError } from "./mobile-native-static-check.ts";

it("describes failed native static-analysis commands structurally", () => {
  const error = new NativeStaticCheckCommandError({
    command: "swiftlint",
    args: ["lint", "--strict"],
    cwd: "/repo/apps/mobile",
    exitCode: 2,
  });

  assert.equal(error.command, "swiftlint");
  assert.deepStrictEqual(error.args, ["lint", "--strict"]);
  assert.equal(error.cwd, "/repo/apps/mobile");
  assert.equal(error.exitCode, 2);
  assert.equal(error.message, "Native static check command 'swiftlint' exited with code 2.");
});
