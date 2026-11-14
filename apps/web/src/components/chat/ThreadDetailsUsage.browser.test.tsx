import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fakeTimers, render } from "../../../test/render";
import { ThreadDetailsUsage } from "./ThreadDetailsUsage";

const now = Date.parse("2026-11-09T12:00:00.000Z");
const checkedAt = new Date(now).toISOString();
const inTwoDays = new Date(now + 2 * 86_400_000 + 3_600_000).toISOString();

function window(
  id: string,
  label: string,
  kind: ServerProviderUsageWindow["kind"],
  usedPercent: number,
  resetsAt?: string,
): ServerProviderUsageWindow {
  return { id, label, kind, usedPercent, ...(resetsAt ? { resetsAt } : {}) };
}

const antigravity: ServerProvider = {
  instanceId: ProviderInstanceId.make("antigravity"),
  driver: ProviderDriverKind.make("antigravity"),
  displayName: "Antigravity",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt,
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt,
    windows: [
      window("3p-5h", "Claude & GPT (shared) · 5-hour", "session", 0),
      window("gemini-5h", "Gemini · 5-hour", "session", 10),
      window("3p-weekly", "Claude & GPT (shared) · Weekly", "weekly", 0),
      window("gemini-argon-weekly", "Gemini 4 Argon · Weekly", "weekly", 100, inTwoDays),
      window("gemini-weekly", "Gemini · Weekly", "weekly", 8),
    ],
  },
};

describe("ThreadDetailsUsage", () => {
  it("groups pooled limits and says what each value means", async () => {
    using _timers = fakeTimers({ now });
    await using screen = await render(
      <div style={{ width: 280 }}>
        <ThreadDetailsUsage
          providerInstanceId={antigravity.instanceId}
          providers={[antigravity]}
          sources={[]}
        />
      </div>,
    );
    const labels = [...screen.container.querySelectorAll('[tabindex="0"]')].map((row) =>
      row.getAttribute("aria-label"),
    );
    expect(labels).toEqual([
      "5-hour: 100% left",
      "Weekly: 100% left",
      "5-hour: 90% left",
      "Weekly: 92% left",
      "Weekly: back in 2d 1h",
    ]);
    expect(screen.container.textContent).toContain("Gemini 4 Argon");
    expect(screen.container.textContent).toContain("back in 2d 1h");
  });
});
