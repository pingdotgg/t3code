import { describe, expect, it } from "vite-plus/test";

import {
  linearLocationFromStack,
  linearRoutesToResume,
  type StoredLinearLocation,
  type StoredLinearRoute,
} from "./linearResume";

const home = { name: "Home" };
const team: StoredLinearRoute = {
  name: "LinearTeam",
  params: { environmentId: "e1", teamId: "t1" },
};
const project: StoredLinearRoute = {
  name: "LinearProject",
  params: { environmentId: "e1", teamId: "t1", projectId: "p1" },
};
const issue: StoredLinearRoute = {
  name: "LinearIssue",
  params: { environmentId: "e1", issueId: "i1" },
};

describe("linearLocationFromStack", () => {
  it("keeps the trailing Linear screens in order", () => {
    expect(linearLocationFromStack([home, team, project, issue])).toEqual({
      environmentId: "e1",
      organizationId: null,
      routes: [team, project, issue],
    });
  });

  it("leaves the stored location alone when a non-Linear screen is on top", () => {
    expect(linearLocationFromStack([home, team, { name: "Thread" }])).toBeNull();
    expect(linearLocationFromStack([home])).toBeNull();
  });

  it("ignores Linear screens below a chat and unusable params", () => {
    expect(linearLocationFromStack([team, { name: "Thread" }, issue])?.routes).toEqual([issue]);
    expect(
      linearLocationFromStack([
        { name: "LinearIssue", params: { environmentId: "e1", issueId: 3 } },
      ]),
    ).toBeNull();
  });
});

describe("linearRoutesToResume", () => {
  const stored: StoredLinearLocation = {
    environmentId: "e1",
    organizationId: "o1",
    routes: [team, project],
  };

  it("resumes the stored routes for the same environment and organization", () => {
    expect(linearRoutesToResume({ stored, environmentId: "e1", organizationId: "o1" })).toEqual([
      team,
      project,
    ]);
    expect(linearRoutesToResume({ stored, environmentId: "e1", organizationId: null })).toEqual([
      team,
      project,
    ]);
    expect(
      linearRoutesToResume({
        stored: { ...stored, organizationId: null },
        environmentId: "e1",
        organizationId: "o9",
      }),
    ).toEqual([team, project]);
  });

  it("drops another environment, another organization, and nothing stored", () => {
    expect(linearRoutesToResume({ stored, environmentId: "e2", organizationId: "o1" })).toEqual([]);
    expect(linearRoutesToResume({ stored, environmentId: "e1", organizationId: "o2" })).toEqual([]);
    expect(
      linearRoutesToResume({ stored: null, environmentId: "e1", organizationId: "o1" }),
    ).toEqual([]);
    expect(linearRoutesToResume({ stored, environmentId: null, organizationId: null })).toEqual([]);
  });
});
