// @vitest-environment jsdom
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { showThreadUndoNotice, useThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import * as ThreadUndo from "../../hooks/threadUndo";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../../state/server", () => ({ primaryServerKeybindingsAtom: {} }));

it("expires a hovered notice after its sidebar unmounts without pointer leave", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const claim = ThreadUndo.begin("settle", "env/unmount");
  try {
    showThreadUndoNotice({
      action: "Settled",
      undo: async () => AsyncResult.success(undefined),
      failureTitle: "Restore failed",
      claim,
    });
    await act(async () => root.render(<SidebarThreadUndoNotice />));
    const notice = container.querySelector('[role="status"]');
    if (!notice) throw new Error("Undo notice missing");
    await act(async () => notice.dispatchEvent(new Event("pointerover", { bubbles: true })));
    await act(async () => vi.advanceTimersByTime(8_000));
    expect(useThreadUndoNotice.getState().notice).not.toBeNull();
    await act(async () => root.render(null));
    vi.advanceTimersByTime(4_999);
    expect(claim.isCurrent()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(useThreadUndoNotice.getState().notice).toBeNull();
    expect(claim.isCurrent()).toBe(false);
  } finally {
    await act(async () => root.unmount());
    claim.finish();
    container.remove();
    vi.runAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
