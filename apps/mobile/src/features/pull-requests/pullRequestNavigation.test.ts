import { describe, expect, it } from "vite-plus/test";

import { parseRoutePositiveInt, resolveNativePullRequestTarget } from "./pullRequestNavigation";

describe("parseRoutePositiveInt", () => {
  it("accepts a linking string or a navigate() number", () => {
    expect(parseRoutePositiveInt("12")).toBe(12);
    expect(parseRoutePositiveInt(12)).toBe(12);
  });

  it("rejects zero, fractions and junk", () => {
    expect(parseRoutePositiveInt("0")).toBeNull();
    expect(parseRoutePositiveInt("1.5")).toBeNull();
    expect(parseRoutePositiveInt("nope")).toBeNull();
    expect(parseRoutePositiveInt(undefined)).toBeNull();
  });
});

describe("resolveNativePullRequestTarget", () => {
  it("reads a GitHub URL without needing the project identity", () => {
    expect(
      resolveNativePullRequestTarget({
        environmentId: "env-1",
        projectId: "project-1",
        url: "https://github.com/T3Tools/T3Code/pull/99",
      }),
    ).toEqual({
      environmentId: "env-1",
      projectId: "project-1",
      repository: "t3tools/t3code",
      number: "99",
    });
  });

  it("falls back to the project's repository identity when the URL is not a known host", () => {
    expect(
      resolveNativePullRequestTarget({
        environmentId: "env-1",
        projectId: "project-1",
        url: "https://example.com/change/99",
        number: 99,
        repositoryIdentity: { displayName: "acme/app", owner: "acme", name: "app" },
      }),
    ).toEqual({
      environmentId: "env-1",
      projectId: "project-1",
      repository: "acme/app",
      number: "99",
    });
  });

  it("claims nothing when neither the URL nor the project can name the repository", () => {
    expect(
      resolveNativePullRequestTarget({
        environmentId: "env-1",
        projectId: "project-1",
        url: "https://example.com/change/99",
        number: 99,
      }),
    ).toBeNull();
  });
});
