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
    },
    {
      view: {
        phase: "succeeded" as const,
        type: "success" as const,
        title: "Provider updated",
        description: "New sessions will use the updated provider.",
        dismissAfterVisibleMs: 3_000,
      },
    },
  ])("clears the prompt action in the $view.phase state", ({ view }) => {
    updateProviderUpdateToast({
      toastId: "provider-update-toast",
      view,
      openSettings: vi.fn(),
    });

    expect(toastMocks.update).toHaveBeenCalledWith(
      "provider-update-toast",
      expect.objectContaining({
        type: view.type,
        actionProps: undefined,
      }),
    );
  });
});
