import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { GENERAL_CHATS_PROJECT_ID } from "../../generalChats";
import { shouldShowOpenInPicker, shouldShowProjectHeaderActions } from "./ChatHeader";

describe("shouldShowProjectHeaderActions", () => {
  it("hides repository and project actions for standalone chats", () => {
    expect(shouldShowProjectHeaderActions(GENERAL_CHATS_PROJECT_ID)).toBe(false);
  });

  it("shows actions for normal projects", () => {
    expect(shouldShowProjectHeaderActions(ProjectId.make("project-1"))).toBe(true);
  });

  it("preserves the default behavior without an active project", () => {
    expect(shouldShowProjectHeaderActions(undefined)).toBe(true);
  });
});

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
