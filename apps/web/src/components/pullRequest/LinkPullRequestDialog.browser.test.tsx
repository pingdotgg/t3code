import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

vi.mock(import("~/hooks/usePullRequestLinking"), async (original) => ({
  ...(await original()),
  usePullRequestLinking: (() => ({
    mode: "multiple",
    canLink: () => true,
    changeLink: vi.fn(),
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

it("focuses the reference input when the dialog opens", async () => {
  await using _screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <LinkPullRequestDialogHost />
    </RegistryContext.Provider>,
  );
  await act(() =>
    openLinkPullRequestDialog({
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
    }),
  );

  await expect.element(page.getByPlaceholder("Pull request URL or #42")).toHaveFocus();
});
