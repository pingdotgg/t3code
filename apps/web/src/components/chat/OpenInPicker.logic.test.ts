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
        remoteOpenMode: "wsl-links",
      }),
    ).toBe(true);
  });

  it("keeps other secondary local environments hidden", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "project",
        activeThreadEnvironmentId: secondary,
        primaryEnvironmentId: primary,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(false);
  });
});
