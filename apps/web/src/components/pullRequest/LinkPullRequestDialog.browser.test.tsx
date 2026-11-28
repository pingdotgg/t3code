import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { getTranslationsSnapshot, GTProvider } from "gt-react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const linking = vi.hoisted(() => ({
  changeLink: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock(import("~/hooks/usePullRequestLinking"), async (original) => ({
  ...(await original()),
  usePullRequestLinking: (() => ({
    mode: "multiple",
    canLink: () => true,
    changeLink: linking.changeLink,
  })) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [],
  useThreadShell: () => null,
}));

import { RegistryContext } from "@effect/atom-react";

import { initializeI18n } from "~/i18n/initializeI18n";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { act, render } from "../../../test/render";
import { LinkPullRequestDialogHost, openLinkPullRequestDialog } from "./LinkPullRequestDialog";

const PR_URL = "https://github.com/acme/demo-app/pull/7";

const enterEvent = (init?: KeyboardEventInit) =>
  new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });

async function openDialog() {
  linking.changeLink.mockReset().mockResolvedValue(undefined);
  appAtomRegistry.reset();
  await using stack = new AsyncDisposableStack();
  stack.defer(() => appAtomRegistry.reset());
  const screen = stack.use(
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
  const owned = stack.move();
  return {
    ...screen,
    input: page.getByPlaceholder("Pull request URL or #42"),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

it("focuses the reference input when the dialog opens", async () => {
  await using dialog = await openDialog();
  await expect.element(dialog.input).toHaveFocus();
});

it("starts only one link request on repeated Enter presses while pending and retries after failure", async () => {
  await using dialog = await openDialog();
  const pending = Promise.withResolvers<void>();
  linking.changeLink.mockReturnValueOnce(pending.promise);
  await dialog.input.fill(PR_URL);

  await act(() => {
    const element = dialog.input.element();
    element.dispatchEvent(enterEvent());
    element.dispatchEvent(enterEvent());
  });
  await userEvent.keyboard("{Enter}");

  expect(linking.changeLink).toHaveBeenCalledOnce();
  await expect.element(dialog.input).toHaveAttribute("readonly");

  await act(() => pending.reject(new Error("link failed")));
  await expect.element(page.getByText("link failed")).toBeVisible();
  await expect.element(dialog.input).not.toHaveAttribute("readonly");

  await userEvent.keyboard("{Enter}");
  expect(linking.changeLink).toHaveBeenCalledTimes(2);
  await expect.element(dialog.input).not.toBeInTheDocument();
});

it.each([{ isComposing: true }, { keyCode: 229 }, { repeat: true }])(
  "ignores Enter during IME composition or auto-repeat without validating or submitting: %j",
  async (ignoredEnter) => {
    await using dialog = await openDialog();

    await act(() => dialog.input.element().dispatchEvent(enterEvent(ignoredEnter)));
    await expect
      .element(page.getByText("Paste a pull request URL or enter 123 / #123."))
      .not.toBeInTheDocument();
    expect(linking.changeLink).not.toHaveBeenCalled();

    await dialog.input.fill(PR_URL);
    await act(() => dialog.input.element().dispatchEvent(enterEvent(ignoredEnter)));
    expect(linking.changeLink).not.toHaveBeenCalled();

    await userEvent.keyboard("{Enter}");
    expect(linking.changeLink).toHaveBeenCalledOnce();
    await expect.element(dialog.input).not.toBeInTheDocument();
  },
);

it("shows the number error in the UI language when the thread has no repository", async () => {
  // GTProvider leaves its locale in a cookie; this sets it back to English.
  initializeI18n(() => {});
  linking.changeLink.mockReset().mockResolvedValue(undefined);
  appAtomRegistry.reset();
  const translations = await getTranslationsSnapshot("de");
  await using _screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <GTProvider locale="de" translations={translations}>
        <LinkPullRequestDialogHost />
      </GTProvider>
    </RegistryContext.Provider>,
  );
  await act(() =>
    openLinkPullRequestDialog({
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
    }),
  );

  await page.getByRole("textbox").fill("123");
  await userEvent.keyboard("{Enter}");

  await expect
    .element(
      page.getByText(
        "Füge die vollständige Pull-Request-URL ein. Dieser Thread hat kein Repository, in dem die Nummer aufgelöst werden kann.",
      ),
    )
    .toBeVisible();
  expect(page.getByText(/this thread has no repository/).query()).toBeNull();
  initializeI18n(() => {});
  appAtomRegistry.reset();
});
