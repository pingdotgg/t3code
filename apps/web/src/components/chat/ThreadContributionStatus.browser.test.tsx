import { act, render as renderScreen, type Screen } from "../../../test/render";
import {
  type ContributionStatusEntry,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
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
async function renderStatus(screen: Screen, entries: ReadonlyArray<ContributionStatusEntry>) {
  testState.entries = entries;
  await act(async () => {
    await screen.rerender(
      <ThreadContributionStatus environmentId={ENVIRONMENT} threadId={THREAD} />,
    );
  });
}
/** The trigger's accessible name: its explicit label, else its text. */
function accessibleName(element: Element) {
  return element.getAttribute("aria-label") ?? element.textContent ?? "";
}
function statusButton(screen: Screen) {
  const button = [...screen.container.querySelectorAll("button")].find((candidate) =>
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
    using _setup = await setup();
    await using screen = await renderScreen(null, { router: false });
    await renderStatus(screen, [
      entry([
        { key: "a", text: "● plan" },
        { key: "b", text: "build 3/9" },
        { key: "c", text: "lint clean", tone: "success" },
        { key: "d", text: "disk almost full", tone: "warning" },
      ]),
    ]);
    const button = statusButton(screen);
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
    using _setup = await setup();
    await using screen = await renderScreen(null, { router: false });
    await renderStatus(screen, [entry([{ key: "mode", text: "● plan" }])]);
    const button = statusButton(screen);
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.tagName).toBe("BUTTON");
  });
  it("names the control with every status text, even when an item has a tooltip", async () => {
    using _setup = await setup();
    await using screen = await renderScreen(null, { router: false });
    const longText = `● ${"x".repeat(78)}`;
    await renderStatus(screen, [
      entry([
        { key: "a", text: "Plan", tooltip: "12 files to change" },
        { key: "b", text: longText },
        { key: "c", text: "disk almost full", tone: "warning" },
      ]),
    ]);
    expect(accessibleName(statusButton(screen))).toBe(
      `Provider status: Plan, ${longText}, disk almost full`,
    );
    await act(async () => statusButton(screen).click());
    const text = popupText();
    expect(text).toContain("Plan");
    expect(text).toContain("12 files to change");
    expect(text).toContain(longText);
  });
  it("renders nothing without statuses", async () => {
    using _setup = await setup();
    await using screen = await renderScreen(null, { router: false });
    await renderStatus(screen, []);
    expect(screen.container.childElementCount).toBe(0);
  });
});

async function setup() {
  return {
    [Symbol.dispose]() {
      testState.entries = [];
    },
  };
}
