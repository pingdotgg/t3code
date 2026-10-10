// @vitest-environment jsdom

import { RuntimeRequestId } from "@t3tools/contracts";
import { act, type ComponentProps, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import type { PendingUserInput } from "../../session-logic";

const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("request-1"),
  responseCapability: "live" as const,
  createdAt: "2026-08-15T00:00:00.000Z",
  questions: [
    {
      id: "question-1",
      header: "Approach",
      question: "Which approach should the migration take?",
      options: [
        { label: "Incremental", description: "Move one module at a time" },
        { label: "Big bang", description: "Move everything in one release" },
      ],
      multiSelect: false,
    },
  ],
  dismissible: true,
};

let root: Root;
let container: HTMLDivElement;
const noop = () => {};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function Panel({
  pendingUserInput = prompt,
  collapsed = false,
  onCollapsedChange = noop,
}: {
  pendingUserInput?: PendingUserInput;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}) {
  return (
    <ComposerPendingUserInputPanel
      pendingUserInputs={[pendingUserInput]}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      collapsed={collapsed}
      onCollapsedChange={onCollapsedChange}
      onToggleOption={() => {}}
      onAdvance={() => {}}
      onDismiss={() => {}}
    />
  );
}

async function renderPanel(props: ComponentProps<typeof Panel> = {}) {
  await act(async () => root.render(<Panel {...props} />));
}

function disclosure() {
  const toggle = container.querySelector<HTMLButtonElement>("[data-pending-user-input-toggle]");
  if (!toggle) throw new Error("Question disclosure was not rendered");
  return toggle;
}

function questionBody() {
  return container.querySelector<HTMLElement>('[data-slot="collapsible-panel"]');
}

describe("ComposerPendingUserInputPanel", () => {
  it("collapses and reopens the question body through the controlled disclosure", async () => {
    const onCollapsedChange = vi.fn();
    function ControlledPanel() {
      const [collapsed, setCollapsed] = useState(false);
      return (
        <Panel
          collapsed={collapsed}
          onCollapsedChange={(nextCollapsed) => {
            onCollapsedChange(nextCollapsed);
            setCollapsed(nextCollapsed);
          }}
        />
      );
    }
    await act(async () => root.render(<ControlledPanel />));

    const toggle = disclosure();
    expect(toggle.getAttribute("data-pending-user-input-toggle")).toBe("expanded");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.type).toBe("button");
    expect(toggle.getAttribute("aria-controls")).toBe(questionBody()?.id);
    expect(questionBody()?.textContent).toContain("Incremental");

    await act(async () => toggle.click());

    expect(onCollapsedChange).toHaveBeenNthCalledWith(1, true);
    expect(disclosure().getAttribute("aria-expanded")).toBe("false");
    expect(questionBody()).toBeNull();
    expect(container.textContent).not.toContain("Incremental");

    await act(async () => disclosure().click());

    expect(onCollapsedChange).toHaveBeenNthCalledWith(2, false);
    expect(onCollapsedChange).toHaveBeenCalledTimes(2);
    expect(disclosure().getAttribute("aria-expanded")).toBe("true");
    expect(questionBody()?.textContent).toContain("Which approach should the migration take?");
    expect(questionBody()?.textContent).toContain("Incremental");
    expect(questionBody()?.textContent).toContain("Big bang");
  });

  it("shows the body according to the collapsed prop", async () => {
    await renderPanel({ collapsed: true });
    expect(questionBody()).toBeNull();
    expect(container.textContent).not.toContain("Incremental");

    await renderPanel({ collapsed: false });
    expect(questionBody()?.textContent).toContain("Incremental");

    await renderPanel({ collapsed: true });
    expect(questionBody()).toBeNull();
    expect(container.textContent).not.toContain("Incremental");
  });

  it("offers dismiss only for async questions", async () => {
    await renderPanel();
    expect(container.querySelector("[data-pending-user-input-dismiss]")).not.toBeNull();
    await renderPanel({ pendingUserInput: { ...prompt, dismissible: false } });
    expect(container.querySelector("[data-pending-user-input-dismiss]")).toBeNull();
  });

  it("shows the question and its options when expanded", async () => {
    await renderPanel();

    expect(container.textContent).toContain("Approach");
    expect(questionBody()?.textContent).toContain("Which approach should the migration take?");
    expect(questionBody()?.textContent).toContain("Incremental");
    expect(questionBody()?.textContent).toContain("Big bang");
  });
});
