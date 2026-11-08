import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimits";
import * as Clipboard from "expo-clipboard";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

type ButtonProps = { label: string; disabled?: boolean; onPress: () => void };

vi.mock("react-native", () => ({
  Linking: { openURL: vi.fn() },
  Pressable: ({ children, disabled, onPress }: ButtonProps & { children: ReactNode }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
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
vi.mock("../usage/useResetCredit", () => ({ useResetCredit: vi.fn() }));

import { UsageLimitRecoveryCard } from "./UsageLimitRecoveryCard";

const DAY_MS = 24 * 60 * 60 * 1000;

function failedThread(
  resetAt: string | null,
  lastErrorCode?: string,
  lastErrorClass = "usage_limit",
): EnvironmentThreadShell {
  return {
    id: "thread-1",
    updatedAt: new Date(0).toISOString(),
    snoozedUntil: null,
    latestRun: { runId: "run-1", completedAt: new Date(0).toISOString() },
    limitRecovery: null,
    runtime: { status: "failed", lastErrorClass, lastErrorCode, usageLimitResetAt: resetAt },
  } as unknown as EnvironmentThreadShell;
}

describe("UsageLimitRecoveryCard", () => {
  // Older servers report ChatGPT sharing limits as provider errors and may store a reset.
  it.each([
    [CHATGPT_USAGE_LIMIT_CODE, "usage_limit", null, ["Manage usage"]],
    [CHATGPT_WORKSPACE_USAGE_LIMIT_CODE, "usage_limit", null, ["Copy request for admin"]],
    [CHATGPT_USAGE_LIMIT_CODE, "provider_error", null, ["Manage usage"]],
    [
      CHATGPT_USAGE_LIMIT_CODE,
      "usage_limit",
      new Date(DAY_MS).toISOString(),
      ["Manage usage", "Resume at reset", "Snooze until reset"],
    ],
  ])("shows one ChatGPT notice for %s (%s, reset %s)", (code, errorClass, resetAt, actions) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    act(() =>
      root.render(
        <UsageLimitRecoveryCard
          thread={failedThread(resetAt, code, errorClass)}
          environmentId={"env-1" as EnvironmentId}
        />,
      ),
    );
    expect(container.textContent).toContain("ChatGPT usage limit reached");
    expect(container.textContent).not.toContain("did not report a reset time");
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual(
      actions,
    );
  });

  it("drops a failed copy's error once a retry copies the request", async () => {
    vi.mocked(Clipboard.setStringAsync)
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValueOnce(true);
    const container = document.createElement("div");
    const root = createRoot(container);
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    act(() =>
      root.render(
        <UsageLimitRecoveryCard
          thread={failedThread(null, CHATGPT_WORKSPACE_USAGE_LIMIT_CODE)}
          environmentId={"env-1" as EnvironmentId}
        />,
      ),
    );
    const copy = () => container.querySelector("button")!.click();
    await act(async () => copy());
    expect(container.textContent).toContain("Could not copy the request");
    await act(async () => copy());
    expect(container.textContent).toContain("Request copied");
    expect(container.textContent).not.toContain("Could not copy the request");
  });

  it("ignores a second copy while the first is still in flight", async () => {
    const first = Promise.withResolvers<boolean>();
    vi.mocked(Clipboard.setStringAsync).mockReset().mockReturnValueOnce(first.promise);
    const container = document.createElement("div");
    const root = createRoot(container);
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    act(() =>
      root.render(
        <UsageLimitRecoveryCard
          thread={failedThread(null, CHATGPT_WORKSPACE_USAGE_LIMIT_CODE)}
          environmentId={"env-1" as EnvironmentId}
        />,
      ),
    );
    const copy = () => container.querySelector("button")!.click();
    act(() => copy());
    act(() => copy());
    expect(Clipboard.setStringAsync).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(true));
    expect(container.textContent).toContain("Request copied");
  });

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
});
