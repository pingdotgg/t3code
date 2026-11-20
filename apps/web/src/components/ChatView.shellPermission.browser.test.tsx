import { AuthStandardClientScopes, AuthTerminalOperateScope } from "@t3tools/contracts";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { installFakeEnvironment, type FakeDriver } from "../../test/fakeEnvironment";
import { renderAppDraft } from "../../test/renderAppDraft";

// Its own file: the session's scopes are fetched once per page and kept between tests.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("shell mode without terminal access says why and does not send", async () => {
  using _environment = installFakeEnvironment([], {
    scopes: AuthStandardClientScopes.filter((scope) => scope !== AuthTerminalOperateScope),
  });
  const draftId = DraftId.make("draft-shell-denied");
  await using _app = await renderAppDraft(draftId);
  const editor = page.getByTestId("composer-editor");

  await userEvent.type(editor, "!ls");
  await expect.element(page.getByText("Shell commands need terminal access")).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("Shell command not sent")).toBeVisible();
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe("!ls");
});
