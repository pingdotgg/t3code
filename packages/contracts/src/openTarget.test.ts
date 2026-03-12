import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { OpenWorkspaceTargetInput, WorkspaceOpenTargetId } from "./openTarget";

const decodeWorkspaceOpenTargetId = Schema.decodeUnknownSync(WorkspaceOpenTargetId);
const decodeOpenWorkspaceTargetInput = Schema.decodeUnknownSync(OpenWorkspaceTargetInput);

describe("WorkspaceOpenTargetId", () => {
  it("accepts Ghostty", () => {
    expect(decodeWorkspaceOpenTargetId("ghostty")).toBe("ghostty");
  });

  it("rejects unknown targets", () => {
    expect(() => decodeWorkspaceOpenTargetId("unknown-target")).toThrow();
  });
});

describe("OpenWorkspaceTargetInput", () => {
  it("accepts cwd and target", () => {
    const parsed = decodeOpenWorkspaceTargetInput({
      cwd: " /tmp/workspace ",
      target: "ghostty",
    });

    expect(parsed.cwd).toBe("/tmp/workspace");
    expect(parsed.target).toBe("ghostty");
  });
});
