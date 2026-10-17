import { MessageId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { openRevertConfirm, RevertConfirmHost } from "./ChatOverlayHosts";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

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
    await act(() => root.render(host("env:a")));

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
    await act(() => root.render(host("env:b")));
    await vi.waitFor(() => expect(dialog()).toBeNull());
  });
});
