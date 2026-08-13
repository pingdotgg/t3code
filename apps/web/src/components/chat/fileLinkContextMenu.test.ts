import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFileLinkContextMenuItems,
  canRevealFileLinkInManager,
  resolveFileLinkEnvironmentId,
} from "./fileLinkContextMenu";

describe("file link environment", () => {
  it("routes through the thread environment before the active environment", () => {
    const threadEnvironmentId = EnvironmentId.make("thread-environment");
    expect(
      resolveFileLinkEnvironmentId(threadEnvironmentId, EnvironmentId.make("active-environment")),
    ).toBe(threadEnvironmentId);
  });

  it("falls back to the active environment without thread context", () => {
    const activeEnvironmentId = EnvironmentId.make("active-environment");
    expect(resolveFileLinkEnvironmentId(undefined, activeEnvironmentId)).toBe(activeEnvironmentId);
  });

  it.each([
    {
      connectionPhase: "reconnecting",
      supportsRevealRpc: true,
      availableEditors: ["file-manager"],
    },
    { connectionPhase: "connected", supportsRevealRpc: false, availableEditors: ["file-manager"] },
    { connectionPhase: "connected", supportsRevealRpc: true, availableEditors: [] },
  ] as const)("hides reveal when support is incomplete", (input) => {
    expect(canRevealFileLinkInManager(input)).toBe(false);
  });

  it("allows reveal only when connected with rpc and file manager support", () => {
    expect(
      canRevealFileLinkInManager({
        connectionPhase: "connected",
        supportsRevealRpc: true,
        availableEditors: ["file-manager"],
      }),
    ).toBe(true);
  });
});

describe("chat file link context menu", () => {
  it("puts Open in folder first when the environment supports it", () => {
    expect(
      buildFileLinkContextMenuItems({
        canRevealInFileManager: true,
        canOpenInBrowser: false,
      }),
    ).toEqual([
      { id: "open-in-folder", label: "Open in folder" },
      { id: "open", label: "Open in editor" },
      { id: "copy-relative", label: "Copy relative path" },
      { id: "copy-full", label: "Copy full path" },
    ]);
  });

  it("hides Open in folder when the environment does not support it", () => {
    expect(
      buildFileLinkContextMenuItems({
        canRevealInFileManager: false,
        canOpenInBrowser: true,
      }),
    ).toEqual([
      { id: "open", label: "Open in editor" },
      { id: "open-in-browser", label: "Open in integrated browser" },
      { id: "copy-relative", label: "Copy relative path" },
      { id: "copy-full", label: "Copy full path" },
    ]);
  });
});
