import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const toastMocks = vi.hoisted(() => ({
  update: vi.fn(),
}));

vi.mock("./ui/toast", () => ({
  stackedThreadToast: vi.fn((options) => options),
  toastManager: {
    add: vi.fn(),
    close: vi.fn(),
    update: toastMocks.update,
  },
}));

import { updateProviderUpdateToast } from "./ProviderUpdatePrimaryNotification";

describe("updateProviderUpdateToast", () => {
  beforeEach(() => {
    toastMocks.update.mockClear();
  });

  it.each([
    {
      view: {
        phase: "running" as const,
        type: "loading" as const,
        title: "Updating provider",
        description: "Running provider update command.",
      },
      retainsSettingsAction: false,
    },
    {
      view: {
        phase: "succeeded" as const,
        type: "success" as const,
        title: "Provider updated",
        description: "New sessions will use the updated provider.",
        dismissAfterVisibleMs: 3_000,
      },
      retainsSettingsAction: false,
    },
    {
      view: {
        phase: "failed" as const,
        type: "error" as const,
        title: "Provider update failed",
        description: "Update command failed.",
      },
      retainsSettingsAction: true,
    },
    {
      view: {
        phase: "unchanged" as const,
        type: "warning" as const,
        title: "Provider still needs an update",
        description: "Provider still appears outdated.",
      },
      retainsSettingsAction: true,
    },
  ])("applies the expected action in the $view.phase state", ({ view, retainsSettingsAction }) => {
    const openSettings = vi.fn();

    updateProviderUpdateToast({
      toastId: "provider-update-toast",
      view,
      openSettings,
    });

    expect(toastMocks.update).toHaveBeenCalledWith(
      "provider-update-toast",
      expect.objectContaining({
        type: view.type,
        actionProps: retainsSettingsAction
          ? {
              children: "Settings",
              onClick: openSettings,
            }
          : undefined,
      }),
    );
  });
});
