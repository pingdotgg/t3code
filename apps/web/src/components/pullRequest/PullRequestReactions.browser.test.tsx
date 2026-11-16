import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.send }));
vi.mock("~/state/pullRequests", () => ({ pullRequestEnvironment: { setReaction: {} } }));

import { PullRequestReactionBar } from "./PullRequestReactions";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it("keeps the latest reaction choice when an older toggle fails", async () => {
  state.send.mockReset();
  const first = deferred<{ _tag: "Failure" }>();
  const later = deferred<{ _tag: "Success"; value: undefined }>();
  state.send.mockReturnValueOnce(first.promise).mockReturnValue(later.promise);
  await using screen = await render(
    <PullRequestReactionBar
      environmentId={EnvironmentId.make("test")}
      reference={{ projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 }}
      reactions={[{ content: "thumbs-up", count: 1, viewerHasReacted: false, actors: ["other"] }]}
      canReact={true}
      onRefresh={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "thumbs up, 1", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "thumbs up, 2", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "thumbs up, 1", exact: true }));
  await expect
    .element(screen.getByRole("button", { name: "thumbs up, 2", exact: true }))
    .toHaveAttribute("aria-pressed", "true");

  await act(() => first.resolve({ _tag: "Failure" }));
  expect(
    screen.container
      .querySelector('button[aria-label^="thumbs up,"]')
      ?.getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.container.querySelector('button[aria-label^="thumbs up,"]')?.textContent).toContain(
    "2",
  );
  await act(() => later.resolve({ _tag: "Success", value: undefined }));
});
