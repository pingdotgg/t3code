import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UsageLimitSourceSnapshots,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { collectProviderUsageLimits } from "@t3tools/shared/usageLimits";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { ThreadDetailsUsage } from "./ThreadDetailsUsage";

const checkedAt = "2026-11-13T12:00:00.000Z";
const claude = ProviderInstanceId.make("claudeAgent");

// The instance has no limits of its own; a usage limit source reports its driver's account.
const providers: ServerProvider[] = [
  {
    instanceId: claude,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "2.1.273",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
  },
];
const sources: UsageLimitSourceSnapshots = [
  {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy",
    label: "Claude",
    checkedAt,
    accounts: [
      {
        id: "claude-a.json",
        driver: ProviderDriverKind.make("claudeAgent"),
        plan: "Claude Team Subscription",
        usageLimits: {
          checkedAt,
          windows: [
            {
              id: "five_hour",
              label: "Session",
              usedPercent: 70,
              resetsAt: "2099-01-01T00:00:00.000Z",
              windowDurationMins: 300,
            },
          ],
        },
      },
    ],
  },
];

it("shows the limits /usage-limits reports for the thread's driver", async () => {
  // /usage-limits opens with this report, so the card has data to show.
  expect(
    collectProviderUsageLimits(claude, providers, sources, Date.parse(checkedAt))?.accounts,
  ).toHaveLength(1);

  await using screen = await render(
    <ThreadDetailsUsage providerInstanceId={claude} providers={providers} sources={sources} />,
  );

  await expect.element(screen.getByLabelText(/^(Session|Limits):/)).toBeInTheDocument();
});
