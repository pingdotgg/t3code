import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { PullRequestCandidatePicker } from "./PullRequestCandidatePicker";

const candidates = [
  { name: "bug", applied: false },
  { name: "docs", applied: true },
];

it("sends the picks when it unmounts while still open", async () => {
  const onCommit = vi.fn(async () => {});
  await using screen = await render(
    <PullRequestCandidatePicker
      icon={null}
      label="Labels"
      allowed
      disabledReason=""
      open
      onOpenChange={() => {}}
      query=""
      onQueryChange={() => {}}
      searchLabel="Search labels"
      isPending={false}
      error={null}
      candidates={candidates}
      matches={() => true}
      isSelected={(candidate) => candidate.applied}
      single={false}
      emptyLabel=""
      noMatchLabel=""
      errorLabel=""
      truncated={false}
      truncatedLabel=""
      candidateKey={(candidate) => candidate.name}
      onCommit={onCommit}
    >
      {(candidate) => candidate.name}
    </PullRequestCandidatePicker>,
    // The picker reads no route.
    { router: false },
  );
  await page.getByRole("option", { name: "bug" }).click();
  expect(onCommit).not.toHaveBeenCalled();

  await screen.unmount();

  expect(onCommit).toHaveBeenCalledExactlyOnceWith({ add: [candidates[0]], remove: [] });
});
