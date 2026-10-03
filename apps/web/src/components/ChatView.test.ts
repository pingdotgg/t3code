import { describe, expect, it } from "vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import {
  getCopilotResumeCommand,
  isScrollMetricsAtEnd,
  shouldClosePreviewMiniPlayer,
  shouldRenderPreviewMiniPlayer,
} from "./ChatView.logic";
import type { Thread } from "../types";

const COPILOT_SESSION_ID = "a7f0c803-7cce-4554-9ad6-dfd9df539e33";
const COPILOT_RESUME_CURSOR = {
  schemaVersion: 1,
  sessionId: COPILOT_SESSION_ID,
};

function buildResumeThread(input: {
  provider: string;
  providerInstanceId?: string;
  modelInstanceId: string;
  resumeCursor?: unknown;
}): Pick<Thread, "modelSelection" | "session"> {
  return {
    modelSelection: {
      instanceId: ProviderInstanceId.make(input.modelInstanceId),
      model: "gpt-5.5",
    },
    session: {
      provider: ProviderDriverKind.make(input.provider),
      ...(input.providerInstanceId
        ? { providerInstanceId: ProviderInstanceId.make(input.providerInstanceId) }
        : {}),
      status: "ready",
      orchestrationStatus: "ready",
      resumeCursor: input.resumeCursor ?? COPILOT_RESUME_CURSOR,
      createdAt: "2026-04-22T19:00:45.000Z",
      updatedAt: "2026-04-22T19:03:33.000Z",
    },
  };
}

describe("isScrollMetricsAtEnd", () => {
  it("treats the viewport as at end when LegendList reports at end", () => {
    expect(
      isScrollMetricsAtEnd({
        contentLength: 1_000,
        isAtEnd: true,
        scroll: 0,
        scrollLength: 400,
      }),
    ).toBe(true);
  });

  it("uses scroll geometry when LegendList's isAtEnd flag is stale", () => {
    expect(
      isScrollMetricsAtEnd({
        contentLength: 1_000,
        isAtEnd: false,
        scroll: 594,
        scrollLength: 400,
      }),
    ).toBe(true);
  });

  it("returns false when the viewport is visibly away from the end", () => {
    expect(
      isScrollMetricsAtEnd({
        contentLength: 1_000,
        isAtEnd: false,
        scroll: 500,
        scrollLength: 400,
      }),
    ).toBe(false);
  });
});

describe("getCopilotResumeCommand", () => {
  it("builds the Copilot resume command for Copilot sessions", () => {
    expect(
      getCopilotResumeCommand(
        buildResumeThread({
          provider: "copilot",
          modelInstanceId: "copilot",
        }),
      ),
    ).toBe(`copilot --resume=${COPILOT_SESSION_ID}`);
  });

  it("falls back to the model instance for legacy Copilot sessions", () => {
    expect(
      getCopilotResumeCommand(
        buildResumeThread({
          provider: "codex",
          modelInstanceId: "copilot",
        }),
      ),
    ).toBe(`copilot --resume=${COPILOT_SESSION_ID}`);
  });

  it("does not show Copilot resume commands for non-Copilot threads", () => {
    expect(
      getCopilotResumeCommand(
        buildResumeThread({
          provider: "codex",
          modelInstanceId: "codex",
        }),
      ),
    ).toBeNull();
  });
});

describe("shouldClosePreviewMiniPlayer", () => {
  it("keeps persisted state while preview sessions restore after refresh", () => {
    expect(
      shouldClosePreviewMiniPlayer({
        hasAuthoritativeServerState: false,
        sameTabOpenInPanel: false,
        tabExists: false,
      }),
    ).toBe(false);
  });

  it("closes stale state after the server confirms the tab is gone", () => {
    expect(
      shouldClosePreviewMiniPlayer({
        hasAuthoritativeServerState: true,
        sameTabOpenInPanel: false,
        tabExists: false,
      }),
    ).toBe(true);
  });

  it("keeps floating intent when the same tab is open in the panel", () => {
    expect(
      shouldClosePreviewMiniPlayer({
        hasAuthoritativeServerState: false,
        sameTabOpenInPanel: true,
        tabExists: false,
      }),
    ).toBe(false);
  });
});

describe("shouldRenderPreviewMiniPlayer", () => {
  it("hides the duplicate while the same preview is docked", () => {
    expect(
      shouldRenderPreviewMiniPlayer({
        source: { kind: "browser", tabId: "tab-1" },
        panelOpen: true,
        panelSurface: { id: "browser:one", kind: "preview", resourceId: "tab-1" },
      }),
    ).toBe(false);
  });

  it("restores the float when the panel moves to another surface", () => {
    expect(
      shouldRenderPreviewMiniPlayer({
        source: { kind: "browser", tabId: "tab-1" },
        panelOpen: true,
        panelSurface: { id: "diff", kind: "diff" },
      }),
    ).toBe(true);
  });

  it("suppresses a device float only for the exact host-qualified device panel", () => {
    const source = {
      kind: "device" as const,
      hostId: "ssh-host",
      deviceId: "sim-1",
      platform: "ios" as const,
      name: "iPhone",
    };
    expect(
      shouldRenderPreviewMiniPlayer({
        source,
        panelOpen: true,
        panelSurface: {
          id: "device:ssh-host:sim-1",
          kind: "device",
          target: { hostId: "ssh-host", deviceId: "sim-1", platform: "ios", name: "iPhone" },
        },
      }),
    ).toBe(false);
    expect(
      shouldRenderPreviewMiniPlayer({
        source,
        panelOpen: true,
        panelSurface: {
          id: "device:local:sim-1",
          kind: "device",
          target: { hostId: "local", deviceId: "sim-1", platform: "ios", name: "iPhone" },
        },
      }),
    ).toBe(true);
  });
});
