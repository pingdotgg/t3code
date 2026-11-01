import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceAccount,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));

import { UsageLimitsPooled } from "./UsageLimitsPooled";

const now = Date.parse("2026-10-24T22:38:00.000Z");
const checkedAt = new Date(now).toISOString();
const inFourDays = new Date(now + 4 * 24 * 60 * 60 * 1000).toISOString();

function hubAccount(
  email: string,
  driver: string,
  limits: Omit<ServerProviderUsageLimits, "checkedAt" | "windows">,
): UsageLimitSourceAccount {
  return {
    id: `${email}.json`,
    driver: ProviderDriverKind.make(driver),
    email,
    usageLimits: {
      checkedAt,
      windows: [
        {
          id: driver === "codex" ? "secondary" : "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 100,
          resetsAt: new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString(),
          windowDurationMins: 7 * 24 * 60,
        },
      ],
      ...limits,
    },
  };
}

function hub(accounts: readonly UsageLimitSourceAccount[]) {
  return new Map([
    [
      EnvironmentId.make("env-a"),
      {
        entry: { target: { label: "Laptop" } },
        serverConfig: {
          providers: [],
          usageLimitSources: [
            {
              id: UsageLimitSourceId.make("hub"),
              kind: "cliproxy" as const,
              label: "Watchman hub",
              checkedAt,
              accounts,
            },
          ],
        },
      },
    ],
  ]);
}

async function openSegment(initials: string) {
  await userEvent.click(page.getByRole("button", { name: new RegExp(`^${initials}: `) }));
  return page.getByRole("dialog");
}

async function closeSegment() {
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
}

describe("Claude hub resets on the Limits page", () => {
  it("says whether each hub login has a reset, without offering to redeem it", async () => {
    await using _screen = await render(
      <UsageLimitsPooled
        presentations={hub([
          hubAccount("alan@example.com", "claudeAgent", {
            resetCredits: { availableCount: 1, nextExpiresAt: inFourDays },
            atLimitReset: { available: true },
          }),
          hubAccount("ops@sample.org", "claudeAgent", {
            resetCredits: { availableCount: 0 },
            atLimitReset: { available: false },
          }),
          hubAccount("info@test.io", "claudeAgent", { atLimitReset: { available: null } }),
        ])}
        now={now}
      />,
    );

    await expect
      .element(page.getByRole("button", { name: /^AE: / }))
      .toHaveAccessibleName(/weekly reset available, 1 reset credit banked$/);
    await expect
      .element(page.getByRole("button", { name: /^OS: / }))
      .not.toHaveAccessibleName(/weekly reset/);

    const yes = await openSegment("AE");
    await expect.element(yes.getByText("Weekly reset available")).toBeVisible();
    await expect.element(yes.getByText("1 banked · expires in 4d 0h")).toBeVisible();
    await expect.element(yes.getByRole("button", { name: "Use reset" })).not.toBeInTheDocument();
    await closeSegment();

    const no = await openSegment("OS");
    await expect.element(no.getByText("No reset available")).toBeVisible();
    await expect.element(no.getByText("Weekly reset available")).not.toBeInTheDocument();
    await closeSegment();

    const unknown = await openSegment("IT");
    await expect.element(unknown.getByText("Reset status unknown")).toBeVisible();
    await expect.element(unknown.getByText("No reset available")).not.toBeInTheDocument();
  });

  it("keeps a Codex hub credit redeemable and adds no reset status to it", async () => {
    await using _screen = await render(
      <UsageLimitsPooled
        presentations={hub([
          hubAccount("dev@example.com", "codex", {
            resetCredits: {
              availableCount: 1,
              nextExpiresAt: inFourDays,
              nextCreditId: "credit-1",
            },
          }),
        ])}
        now={now}
      />,
    );

    await expect
      .element(page.getByRole("button", { name: /^DE: / }))
      .not.toHaveAccessibleName(/weekly reset/);
    const codex = await openSegment("DE");
    await expect.element(codex.getByText("1 banked · expires in 4d 0h")).toBeVisible();
    await expect.element(codex.getByRole("button", { name: "Use reset" })).toBeVisible();
    await expect.element(codex.getByText("Reset status unknown")).not.toBeInTheDocument();
  });
});

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });
});
