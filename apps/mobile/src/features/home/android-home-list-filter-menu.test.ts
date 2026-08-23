import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import {
  buildAndroidProjectFilterActions,
  resolveAndroidProjectFilterProject,
} from "./android-home-list-filter-menu";

const projects = [
  {
    key: "environment-1:project-1",
    label: "Codething",
    environmentId: EnvironmentId.make("environment-1"),
    workspaceRoot: "/workspace/codething",
    faviconPath: "brand/icon.svg",
  },
  {
    key: "environment-1:project-2",
    label: "Website",
    environmentId: EnvironmentId.make("environment-1"),
    workspaceRoot: "/workspace/website",
    faviconPath: null,
  },
] as const;

describe("buildAndroidProjectFilterActions", () => {
  it("keeps project action identity separate from the selected state", () => {
    const actions = buildAndroidProjectFilterActions(projects, "environment-1:project-1");

    expect(actions).toMatchObject([
      { id: "project:all" },
      { id: "project:environment-1:project-1", state: "on" },
      { id: "project:environment-1:project-2" },
    ]);
  });

  it("resolves the matching project data for its recognized favicon", () => {
    expect(resolveAndroidProjectFilterProject("project:environment-1:project-1", projects)).toEqual(
      projects[0],
    );
    expect(resolveAndroidProjectFilterProject("project:all", projects)).toBeNull();
    expect(resolveAndroidProjectFilterProject("environment:all", projects)).toBeNull();
  });
});
