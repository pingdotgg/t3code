// @vitest-environment jsdom

import {
  type ContributionStatusEntry,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  entries: [] as ReadonlyArray<ContributionStatusEntry>,
}));

vi.mock("../../state/contributionStatus", () => ({
  useThreadContributionStatus: () => testState.entries,
}));

import { ThreadContributionStatus } from "./ThreadContributionStatus";

const THREAD = ThreadId.make("thread-1");
const ENVIRONMENT = EnvironmentId.make("environment-1");
const PI_ORIGIN = "From a Pi extension. It can lag a session change.";

const entry = (items: ContributionStatusEntry["items"]): ContributionStatusEntry => ({
  threadId: THREAD,
  source: {
    kind: "provider-session",
    providerSessionId: ProviderSessionId.make("session-1"),
    providerInstanceId: ProviderInstanceId.make("pi"),
    driver: ProviderDriverKind.make("pi"),
  },
  items,
});

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
  container.remove();
  testState.entries = [];
  vi.unstubAllGlobals();
});

async function renderStatus(entries: ReadonlyArray<ContributionStatusEntry>) {
  testState.entries = entries;
  await act(async () => {
    root.render(<ThreadContributionStatus environmentId={ENVIRONMENT} threadId={THREAD} />);
  });
}

/** The trigger's accessible name: its explicit label, else its text. */
function accessibleName(element: Element) {
  return element.getAttribute("aria-label") ?? element.textContent ?? "";
}

function statusButton() {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    accessibleName(candidate).startsWith("Provider status"),
  );
  if (!button) throw new Error("Status button was not rendered");
  return button;
}

function popupText() {
  return document.querySelector('[data-slot="popover-popup"]')?.textContent ?? null;
}

describe("ThreadContributionStatus", () => {
  it("counts statuses past the inline ones and lists every one when tapped", async () => {
    await renderStatus([
      entry([
        { key: "a", text: "● plan" },
        { key: "b", text: "build 3/9" },
        { key: "c", text: "lint clean", tone: "success" },
        { key: "d", text: "disk almost full", tone: "warning" },
      ]),
    ]);

    const button = statusButton();
    expect(button.textContent).toBe("● planbuild 3/9+2");
    expect(popupText()).toBeNull();

    await act(async () => {
      button.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }),
      );
      button.click();
    });

    const text = popupText();
    for (const status of ["● plan", "build 3/9", "lint clean", "disk almost full", PI_ORIGIN]) {
      expect(text).toContain(status);
    }
  });

  it("is a focusable native button, so keyboard users reach the same list", async () => {
    await renderStatus([entry([{ key: "mode", text: "● plan" }])]);

    const button = statusButton();
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.tagName).toBe("BUTTON");
  });

  it("names the control with every status text, even when an item has a tooltip", async () => {
    const longText = `● ${"x".repeat(78)}`;
    await renderStatus([
      entry([
        { key: "a", text: "Plan", tooltip: "12 files to change" },
        { key: "b", text: longText },
        { key: "c", text: "disk almost full", tone: "warning" },
      ]),
    ]);

    expect(accessibleName(statusButton())).toBe(
      `Provider status: Plan, ${longText}, disk almost full`,
    );

    await act(async () => statusButton().click());
    const text = popupText();
    expect(text).toContain("Plan");
    expect(text).toContain("12 files to change");
    expect(text).toContain(longText);
  });

  it("renders nothing without statuses", async () => {
    await renderStatus([]);
    expect(container.childElementCount).toBe(0);
  });
});
