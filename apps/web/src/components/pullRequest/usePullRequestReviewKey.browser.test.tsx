import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: {
    detail: ({ input }: { input: { allowStale?: boolean } }) =>
      input.allowStale === false ? "strict" : "cached",
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: string) => ({
    data: { viewer: query === "strict" ? "current-account" : "previous-account" },
  }),
}));

import { usePullRequestReviewKey } from "./usePullRequestReviewKey";
import { pullRequestReviewKey } from "./pullRequestReviewStore";

it("uses the current account when the default detail cache still belongs to the previous one", async () => {
  const environmentId = EnvironmentId.make("environment");
  const reference = { projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 };
  function Reader() {
    const key = usePullRequestReviewKey(environmentId, reference);
    return <output>{key}</output>;
  }
  await using screen = await render(<Reader />);
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent(
      pullRequestReviewKey(reference, { environmentId, viewer: "current-account" }),
    );
});
