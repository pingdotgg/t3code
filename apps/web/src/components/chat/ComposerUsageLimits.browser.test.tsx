import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type UsageLimitsReport,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));

import { usageLimitsBannerItem } from "./ComposerUsageLimits";

const createdAt = "2026-10-24T22:38:00.000Z";
const inFourDays = new Date(Date.parse(createdAt) + 4 * 24 * 60 * 60 * 1000).toISOString();
const windows = [{ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 100 }] as const;
const claude = ProviderDriverKind.make("claudeAgent");

it("lists a Claude hub login's resets read-only and keeps Codex redemption", async () => {
  const report: UsageLimitsReport = {
    createdAt,
    notices: [],
    accounts: [
      {
        id: "hub:alan.json",
        driver: claude,
        label: "Watchman hub · alan.json",
        sourceLabel: "CLI Proxy",
        limits: {
          checkedAt: createdAt,
          windows,
          resetCredits: { availableCount: 1, nextExpiresAt: inFourDays },
          atLimitReset: { available: true },
        },
      },
      {
        id: "hub:broken.json",
        driver: claude,
        label: "Watchman hub · broken.json",
        sourceLabel: "CLI Proxy",
        limits: {
          checkedAt: createdAt,
          windows: [],
          unavailable: { reason: "probeFailed", message: "The hub could not read this account." },
          atLimitReset: { available: null },
        },
      },
      {
        id: "hub:dev.json",
        driver: ProviderDriverKind.make("codex"),
        label: "Watchman hub · dev.json",
        sourceLabel: "CLI Proxy",
        resetCreditInput: {
          sourceId: UsageLimitSourceId.make("hub"),
          accountId: "dev.json",
          creditId: "credit-1",
        },
        limits: {
          checkedAt: createdAt,
          windows: [{ id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 40 }],
          resetCredits: { availableCount: 2, nextCreditId: "credit-1" },
        },
      },
    ],
  };
  const item = usageLimitsBannerItem("limits", report, EnvironmentId.make("env-a"), vi.fn());
  await using screen = await render(<>{item.children}</>);

  await expect.element(screen.getByText("Weekly reset available")).toBeVisible();
  await expect
    .element(screen.getByText("1 reset credit banked · next expires in 4d 0h"))
    .toBeVisible();
  await expect.element(screen.getByText("The hub could not read this account.")).toBeVisible();
  // A failed read says nothing about resets rather than a stale or unknown one.
  await expect.element(screen.getByText("Reset status unknown")).not.toBeInTheDocument();
  await expect.element(screen.getByText("2 reset credits banked")).toBeVisible();
  // Only the Codex credit can be redeemed.
  expect(screen.getByRole("button", { name: "Use reset" }).all()).toHaveLength(1);
});

type ReportAccount = UsageLimitsReport["accounts"][number];

function renderAccount(account: ReportAccount) {
  const report: UsageLimitsReport = { createdAt, notices: [], accounts: [account] };
  const item = usageLimitsBannerItem("limits", report, EnvironmentId.make("env-a"), vi.fn());
  return render(<>{item.children}</>);
}

function nativeRow(
  driver: string,
  limits: Omit<ReportAccount["limits"], "checkedAt" | "windows"> & {
    readonly windows?: ReportAccount["limits"]["windows"];
  },
  resetCreditInput?: ReportAccount["resetCreditInput"],
): ReportAccount {
  const instanceId = ProviderInstanceId.make(driver);
  return {
    id: instanceId,
    driver: ProviderDriverKind.make(driver),
    label: `${driver} [${driver}]`,
    instanceId,
    ...(resetCreditInput ? { resetCreditInput } : {}),
    limits: { checkedAt: createdAt, windows, ...limits },
  };
}

describe("a native row that also carries the hub's weekly reset", () => {
  it("stays read-only while it shows the hub's banked count", async () => {
    await using screen = await renderAccount(
      nativeRow("claudeAgent", {
        resetCredits: { availableCount: 1, nextExpiresAt: inFourDays },
        atLimitReset: { available: true },
      }),
    );

    await expect.element(screen.getByText("Weekly reset available")).toBeVisible();
    await expect
      .element(screen.getByText("1 reset credit banked · next expires in 4d 0h"))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Use reset" })).not.toBeInTheDocument();
  });

  it("stays read-only when its limits could not be read", async () => {
    await using screen = await renderAccount(
      nativeRow("claudeAgent", {
        windows: [],
        unavailable: { reason: "probeFailed", message: "Could not read limits." },
        resetCredits: { availableCount: 1 },
        atLimitReset: { available: null },
      }),
    );

    await expect.element(screen.getByText("Could not read limits.")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Use reset" })).not.toBeInTheDocument();
  });

  it("keeps the native login's own credit redeemable", async () => {
    await using screen = await renderAccount(
      nativeRow(
        "claudeAgent",
        { resetCredits: { availableCount: 2 }, atLimitReset: { available: false } },
        { instanceId: ProviderInstanceId.make("claudeAgent") },
      ),
    );

    await expect.element(screen.getByRole("button", { name: "Use reset" })).toBeVisible();
    expect(screen.getByText("2 reset credits banked").all()).toHaveLength(1);
    await expect.element(screen.getByText("No reset available")).not.toBeInTheDocument();
  });

  it("offers nothing to redeem once the native credits are spent", async () => {
    await using screen = await renderAccount(
      nativeRow(
        "claudeAgent",
        { resetCredits: { availableCount: 0 }, atLimitReset: { available: false } },
        { instanceId: ProviderInstanceId.make("claudeAgent") },
      ),
    );

    await expect.element(screen.getByText("No reset available")).toBeVisible();
    await expect.element(screen.getByText("No reset credits banked")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Use reset" })).not.toBeInTheDocument();
  });
});

it("keeps redeeming a Codex login through its instance", async () => {
  await using screen = await renderAccount(
    nativeRow("codex", { resetCredits: { availableCount: 1 } }),
  );

  await expect.element(screen.getByRole("button", { name: "Use reset" })).toBeVisible();
  await expect.element(screen.getByText("Reset status unknown")).not.toBeInTheDocument();
});
