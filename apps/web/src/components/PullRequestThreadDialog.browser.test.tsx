import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { vcsActionManager } from "~/state/vcs";
import { act, render } from "../../test/render";
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
