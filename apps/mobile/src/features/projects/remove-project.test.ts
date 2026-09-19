import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildRemoveProjectsConfirmation } from "./remove-project";

const member = (id: string, overrides?: { readonly environmentLabel?: string | null }) => ({
  environmentId: EnvironmentId.make(`environment-${id}`),
  id: ProjectId.make(`project-${id}`),
  title: `Project ${id}`,
  workspaceRoot: `/home/user/${id}`,
  ...overrides,
});

describe("buildRemoveProjectsConfirmation", () => {
  it("describes a single project with its path, environment, and thread count", () => {
    const confirmation = buildRemoveProjectsConfirmation({
      members: [member("a", { environmentLabel: "Mac mini" })],
      groupTitle: "Group",
      isWholeGroup: true,
      threadCount: 3,
    });

    expect(confirmation.title).toBe("Remove project “Project a”?");
    expect(confirmation.confirmText).toBe("Remove");
    expect(confirmation.message).toBe(
      [
        "This deletes its 3 threads and permanently clears their conversation history, including archived threads.",
        "Path: /home/user/a",
        "Environment: Mac mini",
        "Only the project entry is removed. Files on disk are not touched.",
        "This action cannot be undone.",
      ].join("\n"),
    );
  });

  it("uses singular thread copy and skips the environment line when unknown", () => {
    const confirmation = buildRemoveProjectsConfirmation({
      members: [member("a")],
      groupTitle: "Group",
      isWholeGroup: true,
      threadCount: 1,
    });

    expect(confirmation.message).toContain("This deletes its 1 thread and");
    expect(confirmation.message).not.toContain("Environment:");
  });

  it("calls a partial removal a checkout and keeps the other entries", () => {
    const confirmation = buildRemoveProjectsConfirmation({
      members: [member("a")],
      groupTitle: "Group",
      isWholeGroup: false,
      threadCount: 0,
    });

    expect(confirmation.title).toBe("Remove checkout “Project a”?");
    expect(confirmation.message).toBe(
      [
        "This permanently clears any archived conversation history.",
        "Path: /home/user/a",
        "Other checkouts in this project are unaffected.",
        "This action cannot be undone.",
      ].join("\n"),
    );
  });

  it("names the group and counts entries when several checkouts go at once", () => {
    const confirmation = buildRemoveProjectsConfirmation({
      members: [member("a"), member("b")],
      groupTitle: "shared-repo",
      isWholeGroup: true,
      threadCount: 0,
    });

    expect(confirmation.title).toBe("Remove project “shared-repo”?");
    expect(confirmation.message).toContain("This removes 2 grouped project entries.");
    expect(confirmation.message).not.toContain("Path:");
  });
});
