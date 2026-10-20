import "~/index.css";

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

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
let tabStart: HTMLButtonElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  tabStart = document.createElement("button");
  container = document.createElement("div");
  document.body.append(tabStart, container);
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
  await act(async () => root.render(<ComposerPrimaryActions {...props} leadingActions={attach} />));
}

// Real Tab presses, so this checks focus order rather than DOM order.
async function tabOrder(): Promise<string[]> {
  const labels: string[] = [];
  tabStart.focus();
  for (const _ of container.querySelectorAll("button")) {
    await act(() => userEvent.tab());
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || !container.contains(focused)) break;
    labels.push(focused.getAttribute("aria-label") ?? focused.textContent?.trim() ?? "");
  }
  return labels;
}

describe("ComposerPrimaryActions", () => {
  it("keeps the Compact chip ahead of attach and send in both of its states", async () => {
    const chip = "Compact 169k tokens of history before sending";

    await render({ ...sendProps, compactBeforeSendTokens: 169_000 });
    expect(await tabOrder()).toEqual([chip, "Attach", "Compact and send"]);

    await render({ ...sendProps, compactBeforeSendTokens: 169_000, keepFullHistory: true });
    expect(await tabOrder()).toEqual([chip, "Attach", "Submit message"]);
  });

  it("keeps attach ahead of the primary action in every composer state", async () => {
    const cases: Array<[Props, string[]]> = [
      [sendProps, ["Attach", "Submit message"]],
      [pendingProps, ["Attach", "Submit"]],
      [{ ...sendProps, showPlanFollowUpPrompt: true }, ["Attach", "Refine"]],
      [
        { ...sendProps, showPlanFollowUpPrompt: true, promptHasText: false },
        ["Attach", "Implement", "Implementation actions"],
      ],
      [
        { ...sendProps, canInterrupt: true, hasSendableContent: false },
        ["Attach", "Stop generation"],
      ],
    ];

    for (const [props, expected] of cases) {
      await render(props);
      expect(await tabOrder()).toEqual(expected);
    }
  });

  it("opens implementation actions with a mouse while the composer is resting", async () => {
    const onImplementPlanInNewThread = vi.fn();

    await render({
      ...sendProps,
      compact: false,
      showPlanFollowUpPrompt: true,
      promptHasText: false,
      hasSendableContent: false,
      preserveComposerFocusOnPointerDown: true,
      onImplementPlanInNewThread,
    });

    await act(async () => {
      await userEvent.click(page.getByRole("button", { name: "Implementation actions" }));
    });
    const item = page.getByRole("menuitem", { name: "Implement in a new thread" });
    await expect.element(item).toBeVisible();
    await act(async () => {
      await userEvent.click(item);
    });
    expect(onImplementPlanInNewThread).toHaveBeenCalledTimes(1);
  });
});
