import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

type ButtonProps = { label: string; disabled?: boolean; onPress: () => void };

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, disabled, onPress }: ButtonProps) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { updateMetadata: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

import { UsageLimitRecoveryCard } from "./UsageLimitRecoveryCard";

const DAY_MS = 24 * 60 * 60 * 1000;

function failedThread(resetAt: string, error?: string): EnvironmentThreadShell {
  return {
    id: "thread-1",
    updatedAt: new Date(0).toISOString(),
    snoozedUntil: null,
    latestRun: { runId: "run-1", completedAt: new Date(0).toISOString() },
    limitRecovery: null,
    runtime: {
      status: "failed",
      lastErrorClass: "usage_limit",
      usageLimitResetAt: resetAt,
      ...(error === undefined ? {} : { lastErrorCode: "provider.rate-limit", lastError: error }),
    },
  } as unknown as EnvironmentThreadShell;
}

describe("UsageLimitRecoveryCard", () => {
  it("disables Snooze once a reset more than 24.8 days away passes", () => {
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    vi.useFakeTimers({ now: 0 });
    const container = document.createElement("div");
    const root = createRoot(container);
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    act(() =>
      root.render(
        <UsageLimitRecoveryCard
          thread={failedThread(new Date(30 * DAY_MS).toISOString())}
          environmentId={"env-1" as EnvironmentId}
        />,
      ),
    );
    const snooze = () =>
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Snooze until reset",
      );
    expect(snooze()?.disabled).toBe(false);

    act(() => vi.advanceTimersByTime(30 * DAY_MS));

    expect(snooze()?.disabled).toBe(true);
  });

  it("shows provider capacity detail and keeps the reset resume action", () => {
    using _format = vi
      .spyOn(Date.prototype, "toLocaleString")
      .mockReturnValue("Jan 31, 1970, 00:00");
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    vi.useFakeTimers({ now: 0 });
    const container = document.createElement("div");
    const root = createRoot(container);
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    const message =
      "Upstream request failed: [ttft_admission_refused] the cell is at capacity; retry shortly (after 30 s)";
    act(() =>
      root.render(
        <UsageLimitRecoveryCard
          thread={failedThread(new Date(30 * DAY_MS).toISOString(), message)}
          environmentId={"env-1" as EnvironmentId}
        />,
      ),
    );

    expect(container.textContent).toContain(message);
    expect(container.textContent).toContain("Resets Jan 31, 1970, 00:00.");
    expect(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Resume at reset",
      ),
    ).toBeDefined();
  });
});
