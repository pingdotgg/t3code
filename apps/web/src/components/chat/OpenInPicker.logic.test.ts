import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldShowOpenInPicker } from "./OpenInPicker.logic";

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");

describe("shouldShowOpenInPicker", () => {
  it("shows the picker for a desktop-managed WSL environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "project",
        activeThreadEnvironmentId: secondary,
        primaryEnvironmentId: primary,
        hostEnvironmentId: null,
        remoteOpenMode: "wsl-links",
      }),
    ).toBe(true);
  });

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
        }),
      ).toBe(visible);
    }
  });
});
