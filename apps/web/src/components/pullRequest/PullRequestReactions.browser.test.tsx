import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.send }));
vi.mock("~/state/pullRequests", () => ({ pullRequestEnvironment: { setReaction: {} } }));

import { PullRequestReactionBar } from "./PullRequestReactions";

it("keeps the latest reaction choice when an older toggle fails", async () => {
  state.send.mockReset();
  let failFirst = () => {};
  let finishLater = () => {};
  state.send
    .mockReturnValueOnce(new Promise((resolve) => (failFirst = () => resolve({ _tag: "Failure" }))))
    .mockReturnValue(
      new Promise(
        (resolve) => (finishLater = () => resolve({ _tag: "Success", value: undefined })),
      ),
    );
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
  const latest = screen.getByRole("button", { name: "thumbs up, 2", exact: true });
  await expect.element(latest).toHaveAttribute("aria-pressed", "true");

  await act(() => failFirst());
  await expect.element(latest).toHaveAttribute("aria-pressed", "true");
  await act(() => finishLater());
});
