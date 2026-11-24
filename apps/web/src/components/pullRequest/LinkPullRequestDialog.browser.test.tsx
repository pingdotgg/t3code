import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const changeLink = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock(import("~/hooks/usePullRequestLinking"), async (original) => ({
  ...(await original()),
  usePullRequestLinking: (() => ({
    mode: "multiple",
    canLink: () => true,
    changeLink,
  })) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [],
  useThreadShell: () => null,
}));

import { RegistryContext } from "@effect/atom-react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { act, render } from "../../../test/render";
import { LinkPullRequestDialogHost, openLinkPullRequestDialog } from "./LinkPullRequestDialog";

const url = "https://github.com/pingdotgg/t3code/pull/42";
const input = () => page.getByPlaceholder("Pull request URL or #42");

async function renderOpenDialog() {
  changeLink.mockReset();
  await using stack = new AsyncDisposableStack();
  stack.use(
    await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <LinkPullRequestDialogHost />
      </RegistryContext.Provider>,
    ),
  );
  await act(() =>
    openLinkPullRequestDialog({
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
    }),
  );
  return stack.move();
}

it("focuses the reference input when the dialog opens", async () => {
  await using _screen = await renderOpenDialog();

  await expect.element(input()).toHaveFocus();
});

it.each([
  { isComposing: true, keyCode: 13 },
  { isComposing: false, keyCode: 229 },
])("keeps a composition Enter in the input: %j", async (composition) => {
  await using _screen = await renderOpenDialog();
  await input().fill(url);
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    ...composition,
  });
  await act(() => input().element().dispatchEvent(event));

  expect(event.defaultPrevented).toBe(false);
  expect(changeLink).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(changeLink).toHaveBeenCalledTimes(1);
});

it("links once when Enter repeats while linking", async () => {
  await using _screen = await renderOpenDialog();
  const { promise, resolve } = Promise.withResolvers<void>();
  changeLink.mockReturnValue(promise);
  await input().fill(url);
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("button", { name: "Linking..." })).toBeDisabled();
  await userEvent.keyboard("{Enter}");

  expect(changeLink).toHaveBeenCalledTimes(1);
  await act(() => resolve());
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});
