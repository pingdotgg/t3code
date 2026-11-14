import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { ThreadDetailsUsage } from "./ThreadDetailsUsage";

const checkedAt = "2026-11-04T12:00:00.000Z";
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("claude-proxy"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt,
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: { checkedAt, windows: [], unavailable: { reason: "unsupported" } },
};
const sources: UsageLimitSourceSnapshots = [
  {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy",
    label: "Claude pool",
    checkedAt,
    accounts: [
      {
        id: "claude-account",
        driver: provider.driver,
        usageLimits: {
          checkedAt,
          windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 17 }],
        },
      },
    ],
  },
];

it("opens available hub limits without attributing a hub account's quota to the endpoint", async () => {
  const onOpenUsageLimits = vi.fn();
  await using screen = await render(
    <ThreadDetailsUsage
      providerInstanceId={provider.instanceId}
      providers={[provider]}
      sources={sources}
      onOpenUsageLimits={onOpenUsageLimits}
    />,
  );
  await expect.element(screen.getByRole("button", { name: "View hub limits" })).toBeVisible();
  await expect.element(screen.getByText("Unavailable", { exact: true })).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "View hub limits" }).click();
  expect(onOpenUsageLimits).toHaveBeenCalledOnce();

  await screen.rerender(
    <ThreadDetailsUsage
      providerInstanceId={provider.instanceId}
      providers={[provider]}
      sources={sources}
      onOpenUsageLimits={undefined}
    />,
  );
  await expect.element(screen.getByText("Unavailable", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "View hub limits" }))
    .not.toBeInTheDocument();

  for (const unavailableSources of [
    [],
    [
      {
        ...sources[0]!,
        accounts: [{ ...sources[0]!.accounts[0]!, driver: ProviderDriverKind.make("codex") }],
      },
    ],
    [
      {
        ...sources[0]!,
        accounts: [
          {
            ...sources[0]!.accounts[0]!,
            usageLimits: {
              checkedAt,
              windows: [],
              unavailable: { reason: "probeFailed" as const },
            },
          },
        ],
      },
    ],
  ]) {
    await screen.rerender(
      <ThreadDetailsUsage
        providerInstanceId={provider.instanceId}
        providers={[provider]}
        sources={unavailableSources}
        onOpenUsageLimits={onOpenUsageLimits}
      />,
    );
    await expect.element(screen.getByText("Unavailable", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "View hub limits" }))
      .not.toBeInTheDocument();
  }

  await screen.rerender(
    <ThreadDetailsUsage
      providerInstanceId={provider.instanceId}
      providers={[
        {
          ...provider,
          usageLimits: {
            checkedAt,
            windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 60 }],
          },
        },
      ]}
      sources={sources}
      onOpenUsageLimits={onOpenUsageLimits}
    />,
  );
  await expect.element(screen.getByText("40%", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "View hub limits" }))
    .not.toBeInTheDocument();
});
