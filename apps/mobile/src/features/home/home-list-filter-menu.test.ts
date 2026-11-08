import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import type { WorkspaceEnvironment } from "../../state/workspaceModel";
import { filterProjectOptions, homeListFilterEnvironments } from "./home-list-filter-menu";

function environment(
  environmentId: string,
  environmentLabel: string,
  isEnabled: boolean,
): WorkspaceEnvironment {
  return {
    environmentId: environmentId as EnvironmentId,
    environmentLabel,
    displayUrl: "",
    isRelayManaged: false,
    isEnabled,
    connectionState: isEnabled ? "connected" : "available",
    connectionError: null,
    connectionErrorTraceId: null,
  };
}

it("offers only switched-on environments, sorted by label", () => {
  expect(
    homeListFilterEnvironments([
      environment("env-studio", "Studio", true),
      environment("env-laptop", "Laptop", false),
      environment("env-desk", "Desk", true),
    ]),
  ).toEqual([
    { environmentId: "env-desk", label: "Desk", connectionState: "connected" },
    { environmentId: "env-studio", label: "Studio", connectionState: "connected" },
  ]);
});

it("sorts project filters naturally with pinned projects first and searches names and paths", () => {
  const options = ["zebra", "Project 10", "alpha", "project 2", "Pinned"]
    .map((label) => ({
      key: label,
      label,
      pinned: label === "Pinned",
      project: {
        id: ProjectId.make(label),
        environmentId: EnvironmentId.make("local"),
        title: label,
        workspaceRoot: `/work/${label === "alpha" ? "special-folder" : label}`,
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      } satisfies EnvironmentProject,
    }))
    .map((option) => ({ ...option, members: [option.project] }));

  expect(filterProjectOptions(options, "").map((option) => option.label)).toEqual([
    "Pinned",
    "alpha",
    "project 2",
    "Project 10",
    "zebra",
  ]);
  expect(filterProjectOptions(options, " PROJECT ").map((option) => option.label)).toEqual([
    "project 2",
    "Project 10",
  ]);
  expect(filterProjectOptions(options, "SPECIAL-folder").map((option) => option.key)).toEqual([
    "alpha",
  ]);
  expect(filterProjectOptions(options, "missing")).toEqual([]);
  const groupedOptions = options.map((option) => ({
    ...option,
    members: [
      option.project,
      { ...option.project, title: "Remote copy", workspaceRoot: `/remote/${option.label}` },
    ],
  }));
  expect(filterProjectOptions(groupedOptions, "/remote/alpha").map((option) => option.key)).toEqual(
    ["alpha"],
  );
  expect(filterProjectOptions(groupedOptions, "Remote copy")).toHaveLength(options.length);
  expect(options[0]?.label).toBe("zebra");
});
