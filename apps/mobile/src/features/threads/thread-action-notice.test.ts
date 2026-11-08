import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  dismissThreadActionNotice,
  readThreadActionNotice,
  showThreadActionNotice,
  THREAD_ACTION_NOTICE_DISMISS_MS,
} from "./thread-action-notice";

describe("thread action notice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    dismissThreadActionNotice();
    vi.useRealTimers();
  });

  it("keeps a running notice until it is dismissed", () => {
    const dismiss = showThreadActionNotice({
      phase: "running",
      label: "Starting",
      description: null,
    });
    vi.advanceTimersByTime(THREAD_ACTION_NOTICE_DISMISS_MS * 10);
    expect(readThreadActionNotice().phase).toBe("running");
    dismiss();
    expect(readThreadActionNotice().phase).toBe("idle");
  });

  it("hides a finished notice after a few seconds", () => {
    showThreadActionNotice({ phase: "success", label: "Moved to App", description: null });
    vi.advanceTimersByTime(THREAD_ACTION_NOTICE_DISMISS_MS - 1);
    expect(readThreadActionNotice().label).toBe("Moved to App");
    vi.advanceTimersByTime(1);
    expect(readThreadActionNotice().phase).toBe("idle");
  });

  it("does not let an old notice's dismiss hide a newer one", () => {
    const dismissOld = showThreadActionNotice({
      phase: "running",
      label: "Old",
      description: null,
    });
    showThreadActionNotice({ phase: "success", label: "New", description: null });
    dismissOld();
    expect(readThreadActionNotice().label).toBe("New");
  });
});
