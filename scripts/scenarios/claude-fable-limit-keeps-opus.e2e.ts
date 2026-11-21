import { expect } from "e2e";

import { useClaudeWithFableSpent } from "./claude-limits.ts";
import { test, WEB } from "./t3.ts";

test(
  "A spent Fable weekly limit leaves a new Opus thread on Opus",
  WEB,
  async ({ t3, app, screen }) => {
    await t3.project("demo");
    // Fable's own bucket does not cap Opus, so the replay fallback must not apply.
    await useClaudeWithFableSpent({
      defaultModel: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      fallbackModel: { instanceId: "devReplay", model: "showcase" },
    });

    await t3.open("/usage");
    // Setup waits are not assertions: a proof counts a failed `expect` as the bug.
    await screen.getByText("Weekly · Fable", { exact: false }).first().waitFor({ timeout: 60_000 });
    await app.screenshot("limits");
    await app.open("/");
    await screen.getByRole("button", "New thread").first().tap();
    await screen.getByRole("textbox").first().waitFor({ timeout: 30_000 });
    await app.screenshot("new-thread");

    await expect(screen.getByText("Opus 5.5", { exact: false }).first()).toBeVisible();
    await expect(screen.getByText("out of usage", { exact: false }).first()).not.toBeVisible();
  },
);
