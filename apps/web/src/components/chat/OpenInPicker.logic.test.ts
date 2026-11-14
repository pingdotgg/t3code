import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldShowOpenInPicker } from "./OpenInPicker.logic";

describe("shouldShowOpenInPicker", () => {
  it("shows both local environments when the primary has a separate WSL home", () => {
    const primaryEnvironmentId = EnvironmentId.make("wsl");
    const hostEnvironmentId = EnvironmentId.make("host");
    for (const [activeThreadEnvironmentId, visible] of [
      [primaryEnvironmentId, true],
      [hostEnvironmentId, true],
      [EnvironmentId.make("other"), false],
    ] as const) {
      expect(
        shouldShowOpenInPicker({
          activeProjectName: "Project",
          activeThreadEnvironmentId,
          primaryEnvironmentId,
          hostEnvironmentId,
          remoteOpenMode: "local-exec",
          isDesktopWslBackend: false,
        }),
      ).toBe(visible);
    }
  });

  it("shows a desktop-managed WSL backend that runs editors itself", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "Project",
        activeThreadEnvironmentId: EnvironmentId.make("wsl-secondary"),
        primaryEnvironmentId: EnvironmentId.make("primary"),
        hostEnvironmentId: null,
        remoteOpenMode: "local-exec",
        isDesktopWslBackend: true,
      }),
    ).toBe(true);
  });
});
