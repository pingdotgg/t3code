import { assert, describe, it } from "@effect/vitest";
import * as NodeOS from "node:os";

import { resolveCodexProbeCwd } from "./codexProbeCwd.ts";

describe("resolveCodexProbeCwd", () => {
  it("returns the server cwd when it is not on a WSL drvfs mount", () => {
    assert.equal(resolveCodexProbeCwd("/home/test/project"), "/home/test/project");
    assert.equal(
      resolveCodexProbeCwd("/home/test/project", { HOME: "/home/other" }),
      "/home/test/project",
    );
  });

  it("uses HOME when the server cwd is on /mnt/", () => {
    assert.equal(
      resolveCodexProbeCwd("/mnt/c/Users/id173869", { HOME: "/home/testuser" }),
      "/home/testuser",
    );
  });

  it("expands a tilde HOME when the server cwd is on /mnt/", () => {
    assert.equal(resolveCodexProbeCwd("/mnt/c/Users/id173869", { HOME: "~" }), NodeOS.homedir());
  });

  it("uses Node homedir when HOME is blank on a /mnt/ server cwd", () => {
    assert.equal(resolveCodexProbeCwd("/mnt/c/Users/id173869", { HOME: "   " }), NodeOS.homedir());
  });
});
