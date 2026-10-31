import { EnvironmentId, ProjectId, SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { linearPullRequestRoute } from "./linearPullRequestRoute";

const project = (environment: string, id: string) =>
  ({
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make(environment),
    repositoryIdentity: {
      canonicalKey: "github.com/pingdotgg/t3code",
      provider: SourceControlProviderKind.make("github"),
      owner: "pingdotgg",
      name: "t3code",
    },
  }) as never;

const options = { environmentId: EnvironmentId.make("linear"), configLoaded: () => true };
const url = "https://github.com/pingdotgg/t3code/pull/12";

describe("linearPullRequestRoute", () => {
  it("opens a pull request of a repository T3 holds, preferring the Linear environment's copy", () => {
    expect(
      linearPullRequestRoute(
        url,
        [project("other", "p-other"), project("linear", "p-linear")],
        options,
      ),
    ).toMatchObject({
      environmentId: "linear",
      projectId: "p-linear",
      repository: "pingdotgg/t3code",
      number: 12,
    });
  });

  it("falls back to the browser for unknown repositories and non-pull-request links", () => {
    expect(
      linearPullRequestRoute("https://github.com/o/r/pull/1", [project("linear", "p")], options),
    ).toBeNull();
    expect(
      linearPullRequestRoute("https://example.com/x", [project("linear", "p")], options),
    ).toBeNull();
    expect(linearPullRequestRoute(url, [], options)).toBeNull();
  });
});
