import { ProviderDriverKind } from "@t3tools/contracts";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { providerClients } from "./providerDriverMeta";
import { ProviderSettingsForm } from "./ProviderSettingsForm";

describe("ProviderSettingsForm text fields", () => {
  it("drops a rejected draft once the saved value changes", async () => {
    const claude = providerClients.get(ProviderDriverKind.make("claudeAgent"))!;
    const form = (autoCompactWindow: string) => (
      <ProviderSettingsForm
        definition={claude}
        value={{ autoCompactWindow }}
        idPrefix="claude"
        variant="settings"
        onChange={() => {}}
      />
    );
    await using screen = await render(form("300000"));
    const input = screen.getByRole("textbox", { name: "Auto-compact after" });

    await userEvent.fill(input, "300k");
    await userEvent.keyboard("{Enter}");
    await expect.element(input).toHaveValue("300k");
    await expect.element(input).toHaveAttribute("aria-invalid", "true");

    await screen.rerender(form("500000"));
    await expect.element(input).toHaveValue("500000");
    await screen.rerender(form("300000"));
    await expect.element(input).toHaveValue("300000");
    await expect.element(input).toHaveAttribute("aria-invalid", "false");
  });
});
