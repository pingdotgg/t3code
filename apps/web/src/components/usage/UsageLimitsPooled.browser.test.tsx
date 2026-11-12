import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";
import { resolveLowLimitSignal } from "../chat/ComposerUsageLimits";

const checkedAt = "2026-10-25T16:00:00.000Z";

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

describe("pooled composer usage warning", () => {
  it.each([
    { remaining: [0, 0, 0, 87], model: "claude-fable-5-2", expected: null },
    { remaining: [0, 0, 0, 0], model: "claude-fable-5-2", unknown: true, expected: null },
    { remaining: [0, 0, 0, 87], model: "claude-opus-5-5", expected: 22 },
    { remaining: [0, 0, 0, 0], model: "claude-opus-5-5", expected: 0 },
    { remaining: [0, 45], model: "claude-opus-5-5", expected: 23 },
    { remaining: [0, 0], model: "claude-opus-5-5", expired: true, expected: null },
    { remaining: [0, 87], model: "claude-fable-5-2", session: [0, 0], expected: 0 },
  ])("uses the governing pool for $model with $remaining weekly remaining", (scenario) => {
    const { remaining, model, expected } = scenario;
    const selected = {
      ...managedChatGpt("proxy", "Claude proxy"),
      driver: ProviderDriverKind.make("claudeAgent"),
      usageLimits: undefined,
    };
    const source = {
      id: UsageLimitSourceId.make("pool"),
      kind: "cliproxy" as const,
      label: "Pooled accounts",
      checkedAt,
      accounts: remaining.map((left, index) => ({
        id: `account-${index}`,
        driver: selected.driver,
        usageLimits: {
          checkedAt,
          ...("unknown" in scenario && index < 3
            ? { unavailable: { reason: "probeFailed" as const } }
            : {}),
          windows: [
            {
              id: "seven_day",
              kind: "weekly" as const,
              label: "Weekly",
              usedPercent: 100 - left,
              resetsAt: "expired" in scenario ? "2026-10-24T16:00:00.000Z" : undefined,
            },
            {
              id: "seven_day_fable",
              kind: "weekly" as const,
              label: "Weekly · Fable",
              usedPercent: 100 - [66, 83, 91, 97][index]!,
              resetsAt: "expired" in scenario ? "2026-10-24T16:00:00.000Z" : undefined,
            },
            ...("session" in scenario
              ? [
                  {
                    id: "five_hour",
                    kind: "session" as const,
                    label: "Session",
                    usedPercent: 100 - scenario.session[index]!,
                  },
                ]
              : []),
          ],
        },
      })),
    };
    const signal = resolveLowLimitSignal(
      selected,
      [selected],
      [source],
      EnvironmentId.make("desk"),
      model,
      Date.parse(checkedAt),
    );
    expect(signal ? 100 - signal.window.usedPercent : null).toBe(expected);
  });
});
