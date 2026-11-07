import type { ClientSettings } from "@t3tools/contracts/settings";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

const persistence = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence }),
}));

import { ClientSettingsRecoveryGate } from "./ClientSettingsRecoveryGate";

describe("ClientSettingsRecoveryGate", () => {
  it("holds the app on a failed settings read until Retry reads them", async () => {
    using _error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    persistence.getClientSettings
      .mockReset()
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValue(null);
    await using screen = await render(
      <ClientSettingsRecoveryGate>
        <p>App</p>
      </ClientSettingsRecoveryGate>,
    );

    await expect.element(screen.getByText("Couldn't load your settings")).toBeVisible();
    await expect.element(screen.getByText("App")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await expect.element(screen.getByText("App")).toBeVisible();
    expect(persistence.getClientSettings).toHaveBeenCalledTimes(2);
  });
});
