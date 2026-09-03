import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePreviewProjectId } from "./previewProjectId";

describe("resolvePreviewProjectId", () => {
  it("prefers the server shell over a draft", () => {
    expect(
      resolvePreviewProjectId(ProjectId.make("shell-project"), ProjectId.make("draft-project")),
    ).toBe("shell-project");
  });

  it("uses the draft when no shell has loaded", () => {
    expect(resolvePreviewProjectId(null, ProjectId.make("draft-project"))).toBe("draft-project");
    expect(resolvePreviewProjectId(undefined, ProjectId.make("draft-project"))).toBe(
      "draft-project",
    );
  });

  it("stays null when neither source has a project", () => {
    expect(resolvePreviewProjectId(null, null)).toBeNull();
    expect(resolvePreviewProjectId(undefined, undefined)).toBeNull();
  });
});
