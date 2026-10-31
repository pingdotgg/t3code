import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../../test/render";

vi.mock(import("../SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "environment", label: "Old server" },
    environment: {
      environmentId: "environment:old-server",
      label: "Old server",
      serverConfig: { environment: { capabilities: {} } },
    },
  })) as never,
}));

import { SkillsSettings } from "./SkillsSettings";

it("shows the upgrade message for an old-server deep link", async () => {
  await using _screen = await render(<SkillsSettings />);

  await expect
    .element(page.getByText("Update this server to use Skills", { exact: true }))
    .toBeVisible();
});
