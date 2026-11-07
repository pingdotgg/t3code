import { EnvironmentId, ProjectId, type PullRequestRef } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { usePullRequestActionRunner } from "./usePullRequestActions";

const state = vi.hoisted(() => ({ runAction: vi.fn() }));
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: (() => state.runAction) as never,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function MergeButton({ reference }: { reference: PullRequestRef }) {
  const { actionPending, perform } = usePullRequestActionRunner({
    environmentId: EnvironmentId.make("environment"),
    reference,
    terminology: sourceControlClients.get(undefined).changeRequest,
  });
  return (
    <button type="button" disabled={actionPending} onClick={() => void perform("merge")}>
      {actionPending ? "Merging..." : "Merge"}
    </button>
  );
}

it("keeps pending merges with their pull request when navigating between threads", async () => {
  const first: PullRequestRef = {
    projectId: ProjectId.make("project"),
    repository: "owner/repo",
    number: 1,
  };
  const second = { ...first, number: 2 };
  const firstResult = deferred<{ _tag: "Success"; value: void }>();
  const secondResult = deferred<{ _tag: "Success"; value: void }>();
  state.runAction
    .mockReset()
    .mockReturnValueOnce(firstResult.promise)
    .mockReturnValueOnce(secondResult.promise);
  await using screen = await render(<MergeButton reference={first} />);
  const button = screen.getByRole("button");

  await userEvent.click(button);
  await expect.element(button).toHaveTextContent("Merging...");
  await screen.rerender(<MergeButton reference={second} />);
  await expect.element(button).toHaveTextContent("Merge");
  await expect.element(button).toBeEnabled();
  await userEvent.click(button);
  expect(state.runAction).toHaveBeenCalledTimes(2);

  await screen.rerender(<MergeButton reference={first} />);
  await expect.element(button).toHaveTextContent("Merging...");
  await expect.element(button).toBeDisabled();
  await act(async () => {
    firstResult.resolve({ _tag: "Success", value: undefined });
    await firstResult.promise;
  });
  await expect.element(button).toHaveTextContent("Merge");
  await screen.rerender(<MergeButton reference={second} />);
  await expect.element(button).toHaveTextContent("Merging...");
  await act(async () => {
    secondResult.resolve({ _tag: "Success", value: undefined });
    await secondResult.promise;
  });
  await expect.element(button).toHaveTextContent("Merge");
});
