import {
  EnvironmentId,
  type PullRequestDetailView,
  type PullRequestReviewThread,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => async () => ({ _tag: "Success" })) as never,
}));

import { render } from "../../../test/render";
import { PullRequestResolveThreadButton } from "./PullRequestResolveThreadButton";

const thread: PullRequestReviewThread = {
  id: "thread",
  path: null,
  line: null,
  side: "right",
  isResolved: false,
  isOutdated: false,
  comments: [],
};

// The button reads only these fields of the detail.
const detailWith = (reviewThreads: ReadonlyArray<PullRequestReviewThread>) =>
  ({
    capabilities: { review: { resolve: true } },
    viewerPermissions: { resolve: true },
    reviewThreads,
  }) as unknown as PullRequestDetailView;

const button = (detail: PullRequestDetailView) => (
  <PullRequestResolveThreadButton
    environmentId={EnvironmentId.make("environment")}
    reference={{ number: 1 } as never}
    detail={detail}
    thread={detail.reviewThreads[0]!}
    onRefresh={() => {}}
  />
);

it("stays disabled when the detail is rebuilt before refreshed activity arrives", async () => {
  const threads = [thread];
  await using screen = await render(button(detailWith(threads)));
  const resolve = screen.getByRole("button", { name: "Resolve" });
  await resolve.click();
  await expect.element(resolve).toBeDisabled();

  // The core detail reloads first and carries the same activity.
  await screen.rerender(button(detailWith(threads)));
  await expect.element(resolve).toBeDisabled();

  await screen.rerender(button(detailWith([{ ...thread, isResolved: true }])));
  await expect.element(screen.getByRole("button", { name: "Unresolve" })).toBeEnabled();
});

it("stays disabled when its thread is collapsed and reopened before refreshed activity arrives", async () => {
  const threads = [{ ...thread, id: "reopened" }];
  await using screen = await render(button(detailWith(threads)));
  await screen.getByRole("button", { name: "Resolve" }).click();

  await screen.rerender(<></>);
  await screen.rerender(button(detailWith(threads)));
  await expect.element(screen.getByRole("button", { name: "Resolve" })).toBeDisabled();
});
