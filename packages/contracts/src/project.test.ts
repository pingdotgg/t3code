import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import { ProjectActionEnvironment, ProjectDetails } from "./project.ts";

const decodeProjectDetails = Schema.decodeUnknownSync(ProjectDetails);
const decodeProjectActionEnvironment = Schema.decodeUnknownSync(ProjectActionEnvironment);

const baseProjectDetails = {
  id: "project-1",
  title: "Project",
  workspaceRoot: "/repo/project",
  repositoryIdentity: null,
  settings: {
    remoteOverride: null,
  },
  detected: {
    gitRoot: null,
    branch: null,
    remotes: [],
    primaryRemote: null,
  },
  effective: {
    title: "Project",
    remote: null,
  },
};

describe("ProjectDetails", () => {
  it("decodes legacy responses without model selection and scripts", () => {
    const decoded = decodeProjectDetails(baseProjectDetails);

    expect(decoded.defaultModelSelection).toBeNull();
    expect(decoded.scripts).toEqual([]);
    expect(decoded.settings.automaticGitFetchInterval).toBeNull();
    expect(decoded.settings.actionEnvironment).toEqual({});
    expect(decoded.settings.disabledProviderInstanceIds).toEqual([]);
  });

  it("rejects action environment keys reserved for T3Code runtime variables", () => {
    expect(() =>
      decodeProjectActionEnvironment({
        T3CODE_PROJECT_ROOT: "/repo/elsewhere",
      }),
    ).toThrow(/reserved/);

    expect(() =>
      decodeProjectActionEnvironment({
        T3CODE_CUSTOM: "1",
      }),
    ).toThrow(/reserved/);
  });
});
