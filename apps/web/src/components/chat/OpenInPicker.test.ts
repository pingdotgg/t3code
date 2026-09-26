import { EnvironmentId } from "@t3tools/contracts";
import { FolderClosedIcon } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";

import { FileExplorerIcon, FinderIcon } from "../Icons";
import { resolveOpenInOptions, shouldShowOpenInPicker } from "./OpenInPicker";

describe("resolveOpenInOptions", () => {
  it.each([
    ["MacIntel", "Finder", FinderIcon],
    ["Win32", "File Explorer", FileExplorerIcon],
    ["Linux x86_64", "Files", FolderClosedIcon],
  ] as const)("includes the file manager with its icon on %s", (platform, label, Icon) => {
    expect(resolveOpenInOptions(platform, ["cursor", "vscode", "file-manager"])).toEqual([
      expect.objectContaining({ value: "cursor", label: "Cursor" }),
      expect.objectContaining({ value: "vscode", label: "VS Code" }),
      expect.objectContaining({ value: "file-manager", label, Icon }),
    ]);
  });

  it("omits the file manager when unavailable or using remote editors", () => {
    expect(resolveOpenInOptions("MacIntel", ["vscode"])).toEqual([
      expect.objectContaining({ value: "vscode" }),
    ]);
    expect(resolveOpenInOptions("MacIntel", [])).toEqual([]);
  });
});

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");
  const otherEnvironmentId = EnvironmentId.make("environment-other");

  it("shows the picker for the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        environmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        isDesktopLocalEnvironment: false,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(true);
  });

  it("shows the picker for desktop-local backends such as WSL", () => {
    expect(
      shouldShowOpenInPicker({
        environmentId: otherEnvironmentId,
        primaryEnvironmentId,
        isDesktopLocalEnvironment: true,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(true);
  });

  it("shows the picker for remote environments in deep-link mode", () => {
    expect(
      shouldShowOpenInPicker({
        environmentId: otherEnvironmentId,
        primaryEnvironmentId,
        isDesktopLocalEnvironment: false,
        remoteOpenMode: "remote-links",
      }),
    ).toBe(true);
  });

  it("shows the picker when a remote environment has no SSH route", () => {
    expect(
      shouldShowOpenInPicker({
        environmentId: otherEnvironmentId,
        primaryEnvironmentId: null,
        isDesktopLocalEnvironment: false,
        remoteOpenMode: "remote-unavailable",
      }),
    ).toBe(true);
  });

  it("hides the picker for an unclassified non-primary local-exec environment", () => {
    expect(
      shouldShowOpenInPicker({
        environmentId: otherEnvironmentId,
        primaryEnvironmentId,
        isDesktopLocalEnvironment: false,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(false);
  });
});
