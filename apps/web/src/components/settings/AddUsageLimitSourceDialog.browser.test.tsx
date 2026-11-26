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

  it("validates HTTP endpoints when URL.parse is missing", async () => {
    const originalParse = URL.parse;
    URL.parse = undefined as never;
    try {
      await using _screen = await render(
        <AddUsageLimitSourceDialog
          open
          onOpenChange={vi.fn()}
          environmentId={EnvironmentId.make("local")}
          environmentLabel="This Mac"
          kind="http"
          sources={{}}
        />,
      );

      await userEvent.type(page.getByLabelText("Endpoint URL"), "https://quota.example/status");
      await expect.element(page.getByRole("button", { name: "Add source" })).toBeEnabled();
    } finally {
      URL.parse = originalParse;
    }
  });
});
