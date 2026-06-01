import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  shouldShowBrowserAnnotationButton,
  shouldShowOpenInPicker,
  shouldShowProjectScriptsControl,
  shouldShowPreviewButton,
} from "./ChatHeader";

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

describe("shouldShowBrowserAnnotationButton", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows in primary-project browser-agent sidebars", () => {
    expect(
      shouldShowBrowserAnnotationButton({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        browserAgentSidebarMode: true,
      }),
    ).toBe(true);
  });

  it("hides outside browser-agent sidebars", () => {
    expect(
      shouldShowBrowserAnnotationButton({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        browserAgentSidebarMode: false,
      }),
    ).toBe(false);
  });

  it("hides without an active project", () => {
    expect(
      shouldShowBrowserAnnotationButton({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        browserAgentSidebarMode: true,
      }),
    ).toBe(false);
  });

  it("hides for remote environments", () => {
    expect(
      shouldShowBrowserAnnotationButton({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        browserAgentSidebarMode: true,
      }),
    ).toBe(false);
  });
});

describe("shouldShowProjectScriptsControl", () => {
  it("shows project actions when project scripts are loaded", () => {
    expect(shouldShowProjectScriptsControl({ activeProjectScripts: [] })).toBe(true);
  });

  it("hides project actions when there is no active project", () => {
    expect(shouldShowProjectScriptsControl({ activeProjectScripts: undefined })).toBe(false);
  });
});

describe("shouldShowPreviewButton", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows in primary-project app chats", () => {
    expect(
      shouldShowPreviewButton({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        browserAgentSidebarMode: false,
        mainActionRunning: true,
        customPreviewUrl: "",
      }),
    ).toBe(true);
  });

  it("shows when a custom preview URL is configured", () => {
    expect(
      shouldShowPreviewButton({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        browserAgentSidebarMode: false,
        mainActionRunning: false,
        customPreviewUrl: "http://localhost:4000/",
      }),
    ).toBe(true);
  });

  it("hides until the main action is running", () => {
    expect(
      shouldShowPreviewButton({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        browserAgentSidebarMode: false,
        mainActionRunning: false,
        customPreviewUrl: "",
      }),
    ).toBe(false);
  });

  it("hides in browser-agent sidebars", () => {
    expect(
      shouldShowPreviewButton({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        browserAgentSidebarMode: true,
        mainActionRunning: true,
        customPreviewUrl: "",
      }),
    ).toBe(false);
  });

  it("hides without an active project", () => {
    expect(
      shouldShowPreviewButton({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        browserAgentSidebarMode: false,
        mainActionRunning: true,
        customPreviewUrl: "",
      }),
    ).toBe(false);
  });

  it("hides for remote environments", () => {
    expect(
      shouldShowPreviewButton({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        browserAgentSidebarMode: false,
        mainActionRunning: true,
        customPreviewUrl: "",
      }),
    ).toBe(false);
  });
});
