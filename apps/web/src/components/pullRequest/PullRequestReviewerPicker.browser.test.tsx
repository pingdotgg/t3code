import { EnvironmentId, ProjectId, type PullRequestReviewerCandidate } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { PullRequestReviewerPicker } from "./PullRequestReviewerPicker";

const host = vi.hoisted(() => ({
  candidates: [] as Array<PullRequestReviewerCandidate>,
  multiple: true,
  request: vi.fn(),
}));

vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: {
    reviewerCandidates: () => "candidates",
    reviewerSearch: () => "search",
    requestReviewers: "requestReviewers",
  },
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: string | null) => ({
    data:
      atom === "candidates"
        ? { candidates: host.candidates, truncated: false, multiple: host.multiple }
        : null,
    isPending: false,
    error: null,
    refresh: () => {},
  }),
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => host.request,
}));

const person = (login: string, isRequested: boolean): PullRequestReviewerCandidate => ({
  login,
  name: null,
  avatarUrl: null,
  id: login,
  kind: "user",
  isRequested,
});

function setup(multiple: boolean) {
  host.candidates = [person("alice", true), person("bob", false)];
  host.multiple = multiple;
  host.request.mockReset();
  host.request.mockResolvedValue({ _tag: "Success" });
}

const picker = (
  <PullRequestReviewerPicker
    environmentId={EnvironmentId.make("environment")}
    reference={{ projectId: ProjectId.make("project"), repository: "acme/web", number: 7 }}
    allowed
    searchable={false}
  />
);

const sent = () =>
  host.request.mock.calls.map(([{ input }]) => [
    input.requested,
    input.reviewers.map((reviewer: { id: string }) => reviewer.id),
  ]);

it("replaces the reviewer where the host keeps one", async () => {
  setup(false);
  // The picker reads no route.
  await using _screen = await render(picker, { router: false });
  await page.getByLabelText("Request a review").click();
  await page.getByRole("option", { name: "bob" }).click();
  await userEvent.keyboard("{Escape}");

  await vi.waitFor(() =>
    expect(sent()).toEqual([
      [false, ["alice"]],
      [true, ["bob"]],
    ]),
  );
});

it("sends the picks when it unmounts while still open", async () => {
  setup(true);
  // The picker reads no route.
  await using screen = await render(picker, { router: false });
  await page.getByLabelText("Request a review").click();
  await page.getByRole("option", { name: "bob" }).click();
  expect(host.request).not.toHaveBeenCalled();

  await screen.unmount();

  await vi.waitFor(() => expect(sent()).toEqual([[true, ["bob"]]]));
});
