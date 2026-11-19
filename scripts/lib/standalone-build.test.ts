import { describe, expect, it } from "vite-plus/test";

import { standaloneBuildDefine } from "./standalone-build.ts";

describe("standaloneBuildDefine", () => {
  it("leaves default builds untouched, even in a fork's CI", () => {
    expect(standaloneBuildDefine({ GITHUB_REPOSITORY: "fork/t3code" })).toEqual({});
  });

  it("bakes the fork's release repository, preferring the update repository", () => {
    expect(
      standaloneBuildDefine({
        T3CODE_STANDALONE: "1",
        T3CODE_DESKTOP_UPDATE_REPOSITORY: "fork/t3code-releases",
        GITHUB_REPOSITORY: "fork/t3code",
      }),
    ).toEqual({
      __T3CODE_BUILD_STANDALONE__: "true",
      __T3CODE_BUILD_RELEASE_REPOSITORY__: '"fork/t3code-releases"',
    });
  });

  it.each([{}, { GITHUB_REPOSITORY: "not a repo" }, { GITHUB_REPOSITORY: "pingdotgg/t3code" }])(
    "refuses a standalone build without the fork's repository: %o",
    (env) => {
      expect(() => standaloneBuildDefine({ T3CODE_STANDALONE: "true", ...env })).toThrow();
    },
  );
});
