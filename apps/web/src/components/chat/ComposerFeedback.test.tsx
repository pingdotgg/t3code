import { MessageId } from "@t3tools/contracts";
import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { toastManager } from "../ui/toast";
import { feedbackBannerItem } from "./ComposerFeedback";

vi.mock("../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: vi.fn() }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

function copyFeedbackId() {
  const item = feedbackBannerItem(
    {
      id: MessageId.make("feedback-1"),
      command: "/feedback",
      createdAt: "2026-09-11T00:00:00.000Z",
      status: "sent",
      feedbackId: "codex-thread-1",
    },
    vi.fn(),
  );
  if (!isValidElement<{ onClick: () => void }>(item?.actions)) {
    throw new Error("Missing copy action");
  }
  item.actions.props.onClick();
}

describe("feedback ID copy confirmation", () => {
  beforeEach(() => vi.resetAllMocks());

  it("confirms copying only after the clipboard write succeeds", async () => {
    let finish!: (value: boolean) => void;
    vi.mocked(writeTextToClipboard).mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    copyFeedbackId();
    expect(writeTextToClipboard).toHaveBeenCalledWith("codex-thread-1", "Codex feedback thread ID");
    expect(toastManager.add).not.toHaveBeenCalled();
    finish(true);
    await vi.waitFor(() => {
      expect(toastManager.add).toHaveBeenCalledExactlyOnceWith({
        type: "success",
        title: "Thread ID copied",
      });
    });
  });

  it("does not confirm a clipboard write that did not copy", async () => {
    vi.mocked(writeTextToClipboard).mockResolvedValue(false);
    copyFeedbackId();
    await vi.mocked(writeTextToClipboard).mock.results[0]?.value;
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("reports a failed clipboard write without a success confirmation", async () => {
    vi.mocked(writeTextToClipboard).mockRejectedValue(new Error("Clipboard unavailable"));
    copyFeedbackId();
    await vi.waitFor(() => {
      expect(toastManager.add).toHaveBeenCalledExactlyOnceWith({
        type: "error",
        title: "Could not copy thread ID",
        description: "Clipboard unavailable",
      });
    });
  });
});
