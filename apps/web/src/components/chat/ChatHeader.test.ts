import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldRenderOpenInPicker, shouldShowOpenInPicker } from "./ChatHeader";

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(true);
  });

  it("hides the picker when hosted static mode has no primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
      }),
    ).toBe(false);
  });

  it("hides the picker for remote environments", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });
});

describe("host display preferences", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("hides the open picker when the host disables it even for eligible primary projects", () => {
    expect(
      shouldRenderOpenInPicker({
        hostShowOpenInPicker: false,
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });

  it("shows the open picker when both host preference and project context allow it", () => {
    expect(
      shouldRenderOpenInPicker({
        hostShowOpenInPicker: true,
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(true);
  });
});
