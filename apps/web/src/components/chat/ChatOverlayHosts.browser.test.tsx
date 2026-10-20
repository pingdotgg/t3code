import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { GIT_VCS_TERMINOLOGY, JJ_VCS_TERMINOLOGY } from "@t3tools/shared/vcs";
import { describe, expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { act, render } from "../../../test/render";
import {
  BranchRestoreConfirmHost,
  openBranchRestoreConfirm,
  openPullRequestThreadDialog,
  PullRequestThreadDialogHost,
  openRevertConfirm,
  RevertConfirmHost,
} from "./ChatOverlayHosts";

const messageId = MessageId.make("message-1");
const dialog = () => document.querySelector('[role="alertdialog"]');

describe("RevertConfirmHost", () => {
  it("shows only its thread's request, confirms it once, and drops it when the thread changes", async () => {
    const onConfirm = vi.fn();
    const host = (threadKey: string) => (
      <AppAtomRegistryProvider>
        <RevertConfirmHost threadKey={threadKey} onConfirm={onConfirm} />
      </AppAtomRegistryProvider>
    );
    await using screen = await render(host("env:a"));

    await act(() => openRevertConfirm("env:b", { turnCount: 2, messageId }));
    expect(dialog()).toBeNull();

    await act(() => openRevertConfirm("env:a", { turnCount: 2, messageId }));
    const keep = [...(dialog()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Revert and keep changes",
    );
    await act(() => keep?.click());
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(2, messageId, false);
    await vi.waitFor(() => expect(dialog()).toBeNull());

    await act(() => openRevertConfirm("env:a", { turnCount: 3, messageId }));
    expect(dialog()).not.toBeNull();
    await screen.rerender(host("env:b"));
    await vi.waitFor(() => expect(dialog()).toBeNull());
  });
});

describe("BranchRestoreConfirmHost", () => {
  it.each([GIT_VCS_TERMINOLOGY, JJ_VCS_TERMINOLOGY])(
    "preserves $systemName terminology and thread ownership",
    async (terminology) => {
      const onConfirm = vi.fn();
      const host = (threadKey: string) => (
        <AppAtomRegistryProvider>
          <BranchRestoreConfirmHost
            threadKey={threadKey}
            threadBranch="feature"
            canWriteSourceControl
            refNoun={terminology.refNoun}
            refSwitchChangesDescription={terminology.refSwitchChangesDescription}
            onConfirm={onConfirm}
          />
        </AppAtomRegistryProvider>
      );
      await using screen = await render(host("env:a"));
      await act(() => openBranchRestoreConfirm("env:b"));
      expect(dialog()).toBeNull();

      await act(() => openBranchRestoreConfirm("env:a"));
      expect(dialog()?.textContent).toContain(terminology.refSwitchChangesDescription);
      const confirm = [...(dialog()?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent === `Switch ${terminology.refNoun}`,
      );
      expect(confirm).toBeDefined();
      await act(() => confirm?.click());
      expect(onConfirm).toHaveBeenCalledExactlyOnceWith();
      await vi.waitFor(() => expect(dialog()).toBeNull());

      await act(() => openBranchRestoreConfirm("env:a"));
      await screen.rerender(host("env:b"));
      await vi.waitFor(() => expect(dialog()).toBeNull());
    },
  );
});

describe("unsupported VCS overlay actions", () => {
  it("disables an already-open branch restore when source control becomes unavailable", async () => {
    const onConfirm = vi.fn();
    const host = (supported: boolean) => (
      <AppAtomRegistryProvider>
        <BranchRestoreConfirmHost
          threadKey="env:unsupported-restore"
          threadBranch="feature"
          canWriteSourceControl={supported}
          refNoun="branch"
          refSwitchChangesDescription="Switch the checkout."
          onConfirm={onConfirm}
        />
      </AppAtomRegistryProvider>
    );
    await using screen = await render(host(true));
    await act(() => openBranchRestoreConfirm("env:unsupported-restore"));
    await screen.rerender(host(false));
    const restore = [...(dialog()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Switch branch",
    );
    expect(restore?.disabled).toBe(true);
    await act(() => restore?.click());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("blocks file restoration but retains chat-only rewind in an already-open dialog", async () => {
    const onConfirm = vi.fn();
    const host = (supported: boolean) => (
      <AppAtomRegistryProvider>
        <RevertConfirmHost
          threadKey="env:unsupported-rewind"
          vcsActionsSupported={supported}
          onConfirm={onConfirm}
        />
      </AppAtomRegistryProvider>
    );
    await using screen = await render(host(true));
    await act(() => openRevertConfirm("env:unsupported-rewind", { turnCount: 2, messageId }));
    await screen.rerender(host(false));
    const buttons = [...(dialog()?.querySelectorAll("button") ?? [])];
    const restore = buttons.find((button) => button.textContent === "Revert files too");
    const keep = buttons.find((button) => button.textContent === "Revert and keep changes");
    expect(restore?.disabled).toBe(true);
    await act(() => restore?.click());
    expect(onConfirm).not.toHaveBeenCalled();
    expect(keep?.disabled).toBe(false);
    await act(() => keep?.click());
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(2, messageId, false);
  });

  it("refuses a direct PR checkout overlay request while VCS actions are unavailable", async () => {
    const onPrepared = vi.fn();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <PullRequestThreadDialogHost
          threadKey="env:unsupported-pr"
          environmentId={EnvironmentId.make("env")}
          threadId={ThreadId.make("unsupported-pr")}
          cwd="/checkout"
          vcsActionsSupported={false}
          onPrepared={onPrepared}
        />
      </AppAtomRegistryProvider>,
    );
    await act(() => openPullRequestThreadDialog("env:unsupported-pr"));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onPrepared).not.toHaveBeenCalled();
  });
});
