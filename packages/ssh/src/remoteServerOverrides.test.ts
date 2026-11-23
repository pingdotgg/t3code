import { describe, expect, it } from "@effect/vitest";

import { withRemoteServerOverrides } from "./remoteServerOverrides.ts";

const FORK = "https://github.com/martinothamar/t3code/releases/download";

describe("withRemoteServerOverrides", () => {
  it.each([
    ["the fork's releases by default", {}, {}, { archiveVersion: "1.0.0", releaseBaseUrl: FORK }],
    [
      "upstream's T3CODE_RELEASE_BASE_URL over the fork's",
      { releaseBaseUrl: "https://mirror.test" },
      {},
      { archiveVersion: "1.0.0", releaseBaseUrl: "https://mirror.test" },
    ],
    [
      "the fork's own overrides over both",
      { releaseBaseUrl: "https://mirror.test" },
      { archiveVersion: "2.0.0", releaseBaseUrl: "https://other.test" },
      { archiveVersion: "2.0.0", releaseBaseUrl: "https://other.test" },
    ],
  ])("installs from %s", (_name, runner, overrides, expected) => {
    expect(withRemoteServerOverrides({ archiveVersion: "1.0.0", ...runner }, overrides)).toEqual(
      expected,
    );
  });

  it("leaves a source checkout's runner alone", () => {
    const runner = { nodeScriptPath: "/src/bin.ts" };
    expect(withRemoteServerOverrides(runner, { archiveVersion: "2.0.0" })).toBe(runner);
  });
});
