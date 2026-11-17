import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { ThreadDetailsUsage } from "./ThreadDetailsUsage";

const NOW = "2026-11-03T12:00:00.000Z";
const instanceId = ProviderInstanceId.make("codex");

function codexResettingAt(resetsAt: string): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: NOW,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: NOW,
      windows: [
        {
          id: "session",
          kind: "session",
          label: "5h",
          usedPercent: 40,
          resetsAt,
          windowDurationMins: 300,
        },
      ],
    },
  };
}

it.each([
  ["2026-11-03T12:05:00.000Z", "Resets in 5m · "],
  ["2026-11-03T12:00:30.000Z", "Resets momentarily · "],
])("labels a limit resetting at %s", async (resetsAt, label) => {
  using _timers = fakeTimers();
  vi.setSystemTime(new Date(NOW));
  await using screen = await render(
    <ThreadDetailsUsage
      providerInstanceId={instanceId}
      providers={[codexResettingAt(resetsAt)]}
      sources={[]}
    />,
  );

  await act(async () => {
    screen.getByLabelText(/^5h:/).element().focus();
    await vi.advanceTimersByTimeAsync(1_000);
  });
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(label),
  );
});
