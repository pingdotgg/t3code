import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ExecutionTarget, ProjectLocation } from "./executionTarget.ts";

describe("execution target contracts", () => {
  it("decodes local execution targets", () => {
    expect(Schema.decodeUnknownSync(ExecutionTarget)({ kind: "local" })).toEqual({
      kind: "local",
    });
  });

  it("decodes WSL project locations", () => {
    expect(
      Schema.decodeUnknownSync(ProjectLocation)({
        kind: "wsl",
        distroName: "Ubuntu",
        path: "/home/me/project",
      }),
    ).toEqual({
      kind: "wsl",
      distroName: "Ubuntu",
      path: "/home/me/project",
    });
  });
});
