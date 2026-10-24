import { RunId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { ComposerBannerStack } from "./ComposerBannerStack";
import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";

const runId = RunId.make("limited-run");
const resetAt = "2026-10-19T12:00:00.000Z";
const onChange = vi.fn(async () => {});
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-10-19T11:59:00.000Z"));
  onChange.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function renderBanner(
  overrides: Partial<Parameters<typeof usageLimitRecoveryBannerItem>[0]> = {},
) {
  const item = usageLimitRecoveryBannerItem({
    runId,
    resetAt,
    stoppedAt: "2026-10-19T11:00:00.000Z",
    snoozedUntil: resetAt,
    recovery: { runId, resetAt, autoResume: true, snooze: true },
    onChange,
    ...overrides,
  });
  await act(() => root.render(<ComposerBannerStack items={[item]} />));
}

function button(label: string) {
  const match = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  );
  expect(match, `Expected a ${label} button`).toBeDefined();
  return match!;
}

it("lets a snoozed thread wake without cancelling auto-resume", async () => {
  await renderBanner();
  expect(button("Cancel auto-resume").disabled).toBe(false);
  await act(() => button("Wake now").click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ runId, resetAt, snooze: false });
});

it("keeps snooze available independently of auto-resume", async () => {
  await renderBanner({
    snoozedUntil: null,
    recovery: { runId, resetAt, autoResume: false, snooze: false },
  });
  await act(() => button("Snooze until reset").click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ runId, resetAt, snooze: true });
  onChange.mockClear();
  await renderBanner();
  await act(() => button("Cancel auto-resume").click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ runId, resetAt, autoResume: false });
});

it("stops offering Wake now when the reset passes without a server update", async () => {
  await renderBanner();
  button("Wake now");
  await act(async () => vi.advanceTimersByTime(60_001));
  expect(button("Snooze until reset").disabled).toBe(true);
  expect(container.textContent).not.toContain("Wake now");
  await act(() => button("Snooze until reset").click());
  expect(onChange).not.toHaveBeenCalled();
});

it("does not treat a persisted, expired snooze as active on mount", async () => {
  vi.setSystemTime(new Date("2026-10-19T12:01:00.000Z"));
  await renderBanner();
  expect(button("Snooze until reset").disabled).toBe(true);
  expect(container.textContent).not.toContain("Wake now");
});

it("does not wake a snooze belonging to another run", async () => {
  await renderBanner({
    recovery: { runId: RunId.make("older-run"), resetAt, autoResume: true, snooze: true },
  });
  expect(button("Resume at reset").disabled).toBe(false);
  expect(button("Snooze until reset").disabled).toBe(false);
  expect(container.textContent).not.toContain("Wake now");
});
