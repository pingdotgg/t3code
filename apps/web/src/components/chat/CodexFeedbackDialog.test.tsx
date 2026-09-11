import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CodexFeedbackDialog } from "./CodexFeedbackDialog";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

vi.mock("../ui/dialog", () => {
  const Container = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Container,
    DialogPopup: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    DialogDescription: Container,
    DialogFooter: Container,
  };
});

let renderer: ReactTestRenderer;
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

describe("Codex feedback details", () => {
  it.each(["", "  The agent stopped early.\nPlease check the last turn.  "])(
    "allows submitting optional details: %j",
    async (details) => {
      const onSubmit = vi.fn();
      await act(async () => {
        renderer = create(<CodexFeedbackDialog onSubmit={onSubmit} onCancel={vi.fn()} />);
      });
      expect(onSubmit).not.toHaveBeenCalled();
      await act(async () => {
        renderer.root.findByType("textarea").props.onChange({
          target: { value: details },
          currentTarget: { value: details },
          nativeEvent: {},
          isPropagationStopped: () => false,
        });
      });
      await act(async () => {
        renderer.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
      });
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith(details.trim() || undefined);
    },
  );

  it("cancels without submitting feedback", async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    await act(async () => {
      renderer = create(<CodexFeedbackDialog onSubmit={onSubmit} onCancel={onCancel} />);
    });
    await act(async () => {
      renderer.root
        .findAllByType("button")
        .find((button) => button.props.children === "Cancel")
        ?.props.onClick();
    });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
