import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useAcknowledgeThreadCompletion } from "./useAcknowledgeThreadCompletion";

const threadKey = "environment-1:thread-1";
const completedAt = "2026-09-10T05:01:06.022Z";

let page: EventTarget & {
  visibilityState: DocumentVisibilityState;
  hasFocus: ReturnType<typeof vi.fn<() => boolean>>;
};
let browserWindow: EventTarget;
let renderer: ReactTestRenderer | null;

function CompletionProbe(props: {
  acknowledge: (key: string, at: string) => void;
  deferWhilePageInactive?: boolean;
}) {
  useAcknowledgeThreadCompletion(
    threadKey,
    completedAt,
    props.acknowledge,
    props.deferWhilePageInactive ?? true,
  );
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  page = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
    hasFocus: vi.fn(() => true),
  });
  browserWindow = new EventTarget();
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", browserWindow);
  renderer = null;
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("useAcknowledgeThreadCompletion", () => {
  it("acknowledges a completed thread while the page is being viewed", async () => {
    const acknowledge = vi.fn();

    await act(async () => {
      renderer = create(<CompletionProbe acknowledge={acknowledge} />);
    });

    expect(acknowledge).toHaveBeenCalledWith(threadKey, completedAt);
  });

  it("waits to acknowledge a background completion until the window is focused", async () => {
    const acknowledge = vi.fn();
    page.visibilityState = "hidden";
    page.hasFocus.mockReturnValue(false);

    await act(async () => {
      renderer = create(<CompletionProbe acknowledge={acknowledge} />);
    });
    expect(acknowledge).not.toHaveBeenCalled();

    page.visibilityState = "visible";
    await act(async () => page.dispatchEvent(new Event("visibilitychange")));
    expect(acknowledge).not.toHaveBeenCalled();

    page.hasFocus.mockReturnValue(true);
    await act(async () => browserWindow.dispatchEvent(new Event("focus")));
    expect(acknowledge).toHaveBeenCalledWith(threadKey, completedAt);
  });

  it("preserves immediate acknowledgement outside the desktop app", async () => {
    const acknowledge = vi.fn();
    page.visibilityState = "hidden";
    page.hasFocus.mockReturnValue(false);

    await act(async () => {
      renderer = create(
        <CompletionProbe acknowledge={acknowledge} deferWhilePageInactive={false} />,
      );
    });

    expect(acknowledge).toHaveBeenCalledWith(threadKey, completedAt);
  });
});
