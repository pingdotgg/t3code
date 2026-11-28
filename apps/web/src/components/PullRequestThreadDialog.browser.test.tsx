import {
  EnvironmentId,
  GitManagerError,
  type GitResolvePullRequestResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { gitEnvironment } from "~/state/git";
import { vcsActionManager } from "~/state/vcs";
import { act, fakeTimers, render } from "../../test/render";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";

it("keeps another caller's checkout failure out of the dialog", async () => {
  const target = { environmentId: EnvironmentId.make("checkout-error-test"), cwd: "/repo" };
  const failure = AsyncResult.failure(Cause.fail(new Error("Pull request #42 has local changes.")));
  const reply = Promise.withResolvers<typeof failure>();

  await using _screen = await render(
    <AppAtomRegistryProvider>
      <PullRequestThreadDialog
        {...target}
        open
        initialReference={null}
        threadId={ThreadId.make("checkout-error-test")}
        onOpenChange={() => {}}
        onPrepared={() => {}}
      />
    </AppAtomRegistryProvider>,
  );

  const dialog = page.getByRole("dialog");
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  const checkout = vcsActionManager.track(
    appAtomRegistry,
    target,
    { operation: "prepare_pull_request_thread", label: "Preparing pull request thread" },
    () => reply.promise,
  );
  await expect.element(cancel).toBeDisabled();
  await act(async () => {
    reply.resolve(failure);
    await checkout;
  });
  await expect.element(cancel).toBeEnabled();
  expect(dialog.getByText(/Failed to prepare .* request thread\./).query()).toBeNull();
});

it("hides a stale resolution error while debouncing or refetching a pull request reference", async () => {
  const target = { environmentId: EnvironmentId.make("resolution-error-test"), cwd: "/repo" };
  const failure = AsyncResult.failure<GitResolvePullRequestResult, GitManagerError>(
    Cause.fail(
      new GitManagerError({
        operation: "resolvePullRequest",
        cwd: target.cwd,
        detail: "Pull request #99999 not found.",
      }),
    ),
  );
  const failedResolution =
    Atom.make<AsyncResult.AsyncResult<GitResolvePullRequestResult, GitManagerError>>(failure);
  const pendingResolution = Atom.make(
    AsyncResult.initial<GitResolvePullRequestResult, never>(true),
  );
  using _resolve = vi
    .spyOn(gitEnvironment, "pullRequestResolution")
    .mockImplementation(({ input }) =>
      input.reference === "99999" ? failedResolution : pendingResolution,
    );

  await using _screen = await render(
    <AppAtomRegistryProvider>
      <PullRequestThreadDialog
        {...target}
        open
        initialReference="#99999"
        threadId={ThreadId.make("resolution-error-test")}
        onOpenChange={() => {}}
        onPrepared={() => {}}
      />
    </AppAtomRegistryProvider>,
  );

  const dialog = page.getByRole("dialog");
  const resolving = dialog.getByText("Resolving pull request...");
  const staleError = dialog.getByText(/Pull request #99999 not found\./);
  await expect.element(staleError).toBeVisible();

  await act(() => {
    appAtomRegistry.set(failedResolution, AsyncResult.waiting(failure));
  });
  expect(resolving.element()).toBeVisible();
  expect(staleError.query()).toBeNull();

  await act(() => {
    appAtomRegistry.set(failedResolution, failure);
  });
  expect(staleError.element()).toBeVisible();

  using _timers = fakeTimers();
  await userEvent.fill(dialog.getByRole("textbox"), "#123");

  expect(resolving.element()).toBeVisible();
  expect(staleError.query()).toBeNull();

  await act(() => vi.advanceTimersByTime(450));
  await userEvent.fill(dialog.getByRole("textbox"), "#99999");
  await act(() => vi.advanceTimersByTime(450));
  expect(staleError.element()).toBeVisible();
});
