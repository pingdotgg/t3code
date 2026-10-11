import { RuntimeRequestId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../ui/collapsible", () => {
  const Children = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    Collapsible: Children,
    CollapsiblePanel: Children,
    CollapsibleTrigger: Children,
  };
});

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

it("cancels an answer's pending auto-submit on revocation and resumes after a new grant", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const onToggleOption = vi.fn();
  const onAdvance = vi.fn();
  const onDismiss = vi.fn();
  const prompt = {
    requestId: RuntimeRequestId.make("scoped-answer"),
    createdAt: "2026-09-05T00:00:00.000Z",
    dismissible: false,
    responseCapability: "live" as const,
    questions: [
      {
        id: "approach",
        header: "Approach",
        question: "Which approach?",
        options: [{ label: "Incremental", description: "One module at a time" }],
        multiSelect: false,
      },
    ],
  };
  const panel = (disabled: boolean) => (
    <ComposerPendingUserInputPanel
      pendingUserInputs={[prompt]}
      disabled={disabled}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      isAnswering
      onToggleAnswering={() => {}}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
      onDismiss={onDismiss}
    />
  );
  let renderer: ReactTestRenderer | undefined;
  const chooseOption = () => {
    const option = renderer!.root
      .findAllByType("button")
      .find((button) =>
        button.findAllByType("span").some((span) => span.children.includes("Incremental")),
      );
    expect(option).toBeDefined();
    option!.props.onClick();
  };
  try {
    await act(async () => {
      renderer = create(panel(false));
    });
    await act(async () => chooseOption());
    expect(onToggleOption).toHaveBeenCalledWith("approach", "Incremental");
    expect(onAdvance).not.toHaveBeenCalled();

    await act(async () => renderer!.update(panel(true)));
    await act(async () => {
      chooseOption();
      vi.runAllTimers();
    });
    expect(onToggleOption).toHaveBeenCalledTimes(1);
    expect(onAdvance).not.toHaveBeenCalled();

    await act(async () => renderer!.update(panel(false)));
    await act(async () => {
      chooseOption();
      vi.runAllTimers();
    });
    expect(onToggleOption).toHaveBeenCalledTimes(2);
    expect(onAdvance).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

it("keeps Back to message available after the operate grant is revoked", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const prompt = {
    requestId: RuntimeRequestId.make("revoked-answer"),
    createdAt: "2026-09-05T00:00:00.000Z",
    dismissible: false,
    responseCapability: "live" as const,
    questions: [
      {
        id: "approach",
        header: "Approach",
        question: "Which approach?",
        options: [{ label: "Incremental", description: "One module at a time" }],
        multiSelect: false,
      },
    ],
  };
  const panel = (isAnswering: boolean) => (
    <ComposerPendingUserInputPanel
      pendingUserInputs={[prompt]}
      disabled
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      isAnswering={isAnswering}
      onToggleAnswering={() => {}}
      onToggleOption={() => {}}
      onAdvance={() => {}}
      onDismiss={() => {}}
    />
  );
  let renderer: ReactTestRenderer | undefined;
  const toggleButton = (label: string) => {
    const button = renderer!.root
      .findAllByType("button")
      .find((candidate) => candidate.props.children === label);
    expect(button).toBeDefined();
    return button!;
  };
  try {
    await act(async () => {
      renderer = create(panel(true));
    });
    expect(toggleButton("Back to message").props.disabled).toBe(false);

    await act(async () => renderer!.update(panel(false)));
    expect(toggleButton("Answer question").props.disabled).toBe(true);
  } finally {
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
  }
});
