import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Enabling inference routing without a host explains how to set one up in Providers",
  WEB,
  async ({ t3, app, screen }) => {
    await t3.project("demo");
    await t3.open("/settings/providers?instanceId=codex");
    const routing = screen.getByRole("switch", /^(Use CLI proxy|Inference routing)$/i);
    await routing.tap();
    const setup = screen.getByRole("button", "Set up accounts here");
    await expect(setup).toBeVisible();
    await setup.tap();
    await app.screenshot("routing-needs-host");
    await expect(screen.getByRole("button", "Start hosting here")).toBeVisible();
    await expect(routing).not.toBeChecked();
  },
);
