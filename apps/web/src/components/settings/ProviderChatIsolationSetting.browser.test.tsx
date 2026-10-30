import { useState } from "react";
import { ClaudeSettings, CodexSettings, ProviderDriverKind } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { ProviderSettingsForm, type SettingsFormDefinition } from "./ProviderSettingsForm";
import "../../index.css";

function Settings({ definition }: { readonly definition: SettingsFormDefinition }) {
  const [config, setConfig] = useState<Record<string, unknown> | undefined>({
    homePath: "~/existing-account",
    shadowHomePath: "~/existing-shadow",
  });
  return (
    <ProviderSettingsForm
      definition={definition}
      value={config}
      onChange={setConfig}
      idPrefix="isolation"
      variant="settings"
    />
  );
}

it.each([
  { driver: "codex", settingsSchema: CodexSettings, homeLabel: "CODEX_HOME path" },
  { driver: "claudeAgent", settingsSchema: ClaudeSettings, homeLabel: "CLAUDE_CONFIG_DIR path" },
])(
  "preserves the previous $driver home when switching isolation on and off",
  async ({ driver, settingsSchema, homeLabel }) => {
    await using screen = await render(
      <Settings definition={{ driverKind: ProviderDriverKind.make(driver), settingsSchema }} />,
      { router: false }, // Provider fields have no navigation or route context.
    );
    const toggle = screen.getByRole("switch", { name: "Isolate chats from other apps" });
    await expect.element(toggle).not.toBeChecked();
    await expect
      .element(screen.getByRole("textbox", { name: homeLabel, exact: true }))
      .toHaveValue("~/existing-account");
    await toggle.click();
    await expect.element(toggle).toBeChecked();
    await expect
      .element(screen.getByRole("textbox", { name: homeLabel, exact: true }))
      .not.toBeInTheDocument();
    await toggle.click();
    await expect
      .element(screen.getByRole("textbox", { name: homeLabel, exact: true }))
      .toHaveValue("~/existing-account");
    if (driver === "codex") {
      await expect
        .element(screen.getByRole("textbox", { name: "Shadow home path", exact: true }))
        .toHaveValue("~/existing-shadow");
    }
  },
);
