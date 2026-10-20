import { render } from "../../../test/render";
import { EnvironmentId, UsageDay, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const testState = vi.hoisted(() => ({
  useUsage: vi.fn(),
  navigate: vi.fn(),
  canGoBack: true,
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => testState.navigate) as never,
  useCanGoBack: () => testState.canGoBack,
}));
vi.mock(import("../../state/usage"), async (original) => ({
  ...(await original()),
  useUsage: testState.useUsage,
}));

import { UsagePage } from "./UsagePage";
const environments = [
  {
    environmentId: EnvironmentId.make("test-environment"),
    label: "Test environment",
    isPending: false,
    canReadDiagnostics: true,
    error: null,
    summary: {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: "2026-08-11T12:37:00.000Z",
      sinceDay: UsageDay.make("2026-08-10"),
      untilDay: UsageDay.make("2026-08-11"),
      timeZone: "UTC",
      buckets: [],
      sources: [],
      pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
      scanDurationMs: 1,
    },
  },
];

function setup() {
  testState.useUsage.mockReturnValue({
    merged: mergeUsage([], USAGE_CONTRACT_VERSION),
    environments,
    selectedEnvironments: environments,
    isPending: false,
    shown: null,
    isPartial: false,
    refresh: vi.fn(),
  });
  testState.navigate.mockClear();
  testState.canGoBack = true;
}

describe("UsagePage Escape navigation", () => {
  // Playwright cannot press a repeating or composing key, so those cases dispatch the event.
  function escape(properties: { repeat?: boolean; isComposing?: boolean } = {}) {
    return new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
      ...properties,
    });
  }

  it("returns to the previous page on Escape", async () => {
    setup();
    using back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    await using _screen = await render(<UsagePage />);

    await userEvent.keyboard("{Escape}");
    expect(back).toHaveBeenCalledOnce();
    expect(testState.navigate).not.toHaveBeenCalled();
  });

  it("returns home when there is no previous app page", async () => {
    setup();
    using back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    await using screen = await render(<UsagePage />);

    testState.canGoBack = false;
    await screen.rerender(<UsagePage />);

    await userEvent.keyboard("{Escape}");
    expect(testState.navigate).toHaveBeenCalledWith({ to: "/" });
    expect(back).not.toHaveBeenCalled();
  });

  it("closes the environment menu before Escape navigates back", async () => {
    setup();
    using back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    await using screen = await render(<UsagePage />);
    const { container } = screen;
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="menu-trigger"]')!;
    await userEvent.click(trigger);
    await expect.element(page.getByRole("menu")).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(back).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    expect(back).toHaveBeenCalledOnce();
  });

  it.each([{ repeat: true }, { isComposing: true }])(
    "ignores Escape with %j",
    async (properties) => {
      setup();
      using back = vi.spyOn(window.history, "back").mockImplementation(() => {});
      await using _screen = await render(<UsagePage />);
      document.body.dispatchEvent(escape(properties));
      expect(back).not.toHaveBeenCalled();
      expect(testState.navigate).not.toHaveBeenCalled();
    },
  );
});
