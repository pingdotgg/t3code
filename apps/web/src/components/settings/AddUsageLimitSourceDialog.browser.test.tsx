import { EnvironmentId } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const updateSettings = vi.hoisted(() => vi.fn());

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useUpdateEnvironmentSettings: (() => updateSettings) as never,
}));
vi.mock(import("./SecretSourceInput"), async (original) => ({
  ...(await original()),
  useSecretSources: () => [],
}));

import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";

describe("AddUsageLimitSourceDialog", () => {
  it("adds the hub when Enter is pressed in a field", async () => {
    updateSettings.mockClear();
    const onOpenChange = vi.fn();
    await using _screen = await render(
      <AddUsageLimitSourceDialog
        open
        onOpenChange={onOpenChange}
        environmentId={EnvironmentId.make("local")}
        environmentLabel="This Mac"
        sources={{}}
      />,
    );

    await userEvent.type(page.getByLabelText("Hub URL"), "https://hub.example.ts.net:8318");
    await userEvent.type(page.getByLabelText("Management key"), "secret-key{Enter}");

    expect(updateSettings).toHaveBeenCalledOnce();
    expect(updateSettings).toHaveBeenCalledWith({
      usageLimitSources: {
        "cliproxy-hub.example.ts.net-8318": expect.objectContaining({
          url: "https://hub.example.ts.net:8318",
          managementKey: "secret-key",
        }),
      },
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps Add hub disabled and ignores Enter for invalid hub URLs", async () => {
    updateSettings.mockClear();
    const onOpenChange = vi.fn();
    await using _screen = await render(
      <AddUsageLimitSourceDialog
        open
        onOpenChange={onOpenChange}
        environmentId={EnvironmentId.make("local")}
        environmentLabel="This Mac"
        sources={{}}
      />,
    );

    const urlInput = page.getByLabelText("Hub URL");
    const submitButton = page.getByRole("button", { name: "Add hub" });
    await userEvent.fill(page.getByLabelText("Management key"), "secret-key");

    for (const invalidUrl of [
      "hub.example.ts.net:8318",
      "not-a-url",
      "ftp://hub.example.com",
      "http://user:pass@hub.example.com",
    ]) {
      await userEvent.fill(urlInput, invalidUrl);
      await expect.element(submitButton).toBeDisabled();
      await userEvent.keyboard("{Enter}");
    }
    expect(updateSettings).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();

    for (const validUrl of ["http://hub.example.ts.net:8318", "https://hub.example.ts.net:8318"]) {
      await userEvent.fill(urlInput, validUrl);
      await expect.element(submitButton).toBeEnabled();
    }
  });
});
