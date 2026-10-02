import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { settingsTargetsForProject } from "./settings-environment-filter.logic";

const laptop = { environmentId: EnvironmentId.make("laptop") };
const server = { environmentId: EnvironmentId.make("server") };
const group = { members: [{ project: server }] };

describe("settingsTargetsForProject", () => {
  it("keeps an explicitly empty environment selection empty", () => {
    expect(settingsTargetsForProject([], null)).toEqual([]);
    expect(settingsTargetsForProject([], group)).toEqual([]);
  });
  it("does not fall back outside the selected project or a missing group", () => {
    expect(settingsTargetsForProject([laptop], group)).toEqual([]);
    expect(settingsTargetsForProject([laptop, server], undefined)).toEqual([]);
  });
  it("keeps selected environments in order and narrows to project members", () => {
    expect(settingsTargetsForProject([laptop, server], null)).toEqual([laptop, server]);
    expect(settingsTargetsForProject([laptop, server], group)).toEqual([server]);
  });
});
