import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

type Props = ComponentProps<typeof ComposerPrimaryActions>;

const sendProps: Props = {
  compact: true,
  canOperateThread: true,
  pendingAction: null,
  isRunning: false,
  canInterrupt: false,
  showPlanFollowUpPrompt: false,
  promptHasText: true,
  isSendBusy: false,
  sendDisabledReason: null,
  isConnecting: false,
  isEnvironmentUnavailable: false,
  isPreparingWorktree: false,
  hasSendableContent: true,
  onPreviousPendingQuestion: () => {},
  onInterrupt: () => {},
  onImplementPlanInNewThread: () => {},
};

const pendingProps: Props = {
  ...sendProps,
  pendingAction: {
    questionIndex: 0,
    isLastQuestion: true,
    canAdvance: true,
    isResponding: false,
    isComplete: true,
  },
  promptHasText: false,
  hasSendableContent: false,
};

const attach = <button type="button">Attach</button>;

async function render(props: Props) {
  await act(async () => root.render(<ComposerPrimaryActions {...props} />));
}

function focusOrder(): string[] {
  return [...container.querySelectorAll<HTMLElement>("button")].map(
    (button) => button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
  );
}

function expectBefore(order: string[], first: string, second: string) {
  expect(order).toContain(first);
  expect(order).toContain(second);
  expect(order.indexOf(first)).toBeLessThan(order.indexOf(second));
}

describe("ComposerPrimaryActions", () => {
  it("puts the Compact chip ahead of the leading actions in focus order", async () => {
    await render({ ...sendProps, compactBeforeSendTokens: 169_000, leadingActions: attach });

    const order = focusOrder();
    const chip = order.find((label) => label.includes("Compact 169k tokens"));
    expect(chip).toBeDefined();
    expectBefore(order, chip!, "Attach");
    expectBefore(order, "Attach", "Compact and send");
  });

  it("keeps the leading actions before every primary action", async () => {
    const cases: Array<[Props, string]> = [
      [{ ...sendProps, leadingActions: attach }, "Submit message"],
      [{ ...pendingProps, leadingActions: attach }, "Submit"],
      [{ ...sendProps, leadingActions: attach, showPlanFollowUpPrompt: true }, "Refine"],
      [
        {
          ...sendProps,
          leadingActions: attach,
          showPlanFollowUpPrompt: true,
          promptHasText: false,
        },
        "Implement",
      ],
      [
        { ...sendProps, leadingActions: attach, canInterrupt: true, hasSendableContent: false },
        "Stop generation",
      ],
    ];

    for (const [props, primaryAction] of cases) {
      await render(props);
      expectBefore(focusOrder(), "Attach", primaryAction);
    }
  });
});
