import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  areComposerPathSearchTargetsEqual,
  composerPathSearchEntryDescription,
} from "./composerPathSearchState";

const environmentId = EnvironmentId.make("environment-1");

describe("composer path-search targets", () => {
  it("treats environment, cwd, roots, and query as result identity", () => {
    const target = {
      environmentId,
      cwd: "/workspace/a",
      roots: ["/workspace/a", "/workspace/b"],
      query: "src",
    };

    expect(areComposerPathSearchTargetsEqual(target, target)).toBe(true);
    expect(areComposerPathSearchTargetsEqual(target, { ...target, cwd: "/workspace/b" })).toBe(
      false,
    );
    expect(
      areComposerPathSearchTargetsEqual(target, {
        ...target,
        roots: ["/workspace/a", "/workspace/c"],
      }),
    ).toBe(false);
  });

  it("uses collision-safe root labels in mention descriptions", () => {
    const entry = {
      path: "src/index.ts",
      kind: "file" as const,
      parentPath: "src",
      root: "/clients/a/app",
    };
    expect(composerPathSearchEntryDescription(entry, "a/app")).toBe("a/app/src");
  });
});
