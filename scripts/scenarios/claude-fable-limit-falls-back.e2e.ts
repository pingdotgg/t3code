import { expect } from "e2e";

import { useClaudeWithFableSpent } from "./claude-limits.ts";
import { test, WEB } from "./t3.ts";

test(
  "A spent Fable weekly limit moves a new Fable thread to the Opus fallback",
  WEB,
  async ({ t3, app, screen }) => {
    await t3.project("demo");
    // Same Claude account for both: only Fable's bucket is spent, so Opus is still usable.
    await useClaudeWithFableSpent({
      defaultModel: { instanceId: "claudeAgent", model: "claude-fable-5-1" },
      fallbackModel: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    });

    await t3.open("/usage");
    await expect(screen.getByText("Weekly · Fable", { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    });
    await app.screenshot("limits");
    await app.open("/");
    await screen.getByRole("button", "New thread").first().tap();
    await expect(screen.getByRole("textbox").first()).toBeVisible({ timeout: 30_000 });
    await app.screenshot("new-thread");

    await expect(screen.getByText("Opus 5.5", { exact: false }).first()).toBeVisible();
    await expect(screen.getByText("out of usage", { exact: false }).first()).toBeVisible();
  },
);
