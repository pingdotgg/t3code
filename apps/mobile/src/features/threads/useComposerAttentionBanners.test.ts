import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import { buildComposerAttentionBanners } from "./useComposerAttentionBanners";

vi.mock("../../state/use-composer-drafts", () => ({
  setFreshSessionPending: vi.fn(),
  updateComposerDraftSettings: vi.fn(),
}));

describe("buildComposerAttentionBanners", () => {
  const selection = {
    instanceId: ProviderInstanceId.make("provider-1"),
    model: "model-1",
  } satisfies ModelSelection;

  it("orders send-blocking notices before informational ones", () => {
    const items = buildComposerAttentionBanners({
      threadKey: "env:thread",
      canOperateThread: true,
      freshSessionAvailable: true,
      freshSessionArmed: true,
      composerError: "Could not send",
      onDismissComposerError: () => undefined,
      threadRuntimeMode: "auto",
      draftRuntimeMode: undefined,
      supportedRuntimeModes: ["auto", "full-access"],
      policy: undefined,
      connectionConnected: true,
      serverConfig: null,
      modelSelection: selection,
      projectId: null,
      selectedProvider: {
        instanceId: ProviderInstanceId.make("provider-1"),
        driver: "claude",
        displayName: "Claude",
        status: "ready",
        installed: true,
        auth: { status: "authenticated" },
        models: [],
        compatibilityAdvisory: {
          status: "broken",
          message: "Upgrade Claude Code to continue.",
        },
      } as never,
      onOpenModelSettings: () => undefined,
    });

    expect(items.map((item) => item.id)).toEqual([
      "provider-compatibility:provider-1",
      "composer-error",
      "fresh-session",
    ]);
    expect(items[0]?.variant).toBe("error");
    expect(items[0]?.action?.label).toBe("Open model settings");
  });

  it("uses the unavailable model description when the selection cannot send", () => {
    const antigravitySelection = {
      instanceId: ProviderInstanceId.make("antigravity-1"),
      model: "gemini-3",
    } satisfies ModelSelection;
    const items = buildComposerAttentionBanners({
      threadKey: "env:thread",
      canOperateThread: true,
      freshSessionAvailable: false,
      freshSessionArmed: false,
      composerError: null,
      onDismissComposerError: () => undefined,
      threadRuntimeMode: "auto",
      draftRuntimeMode: undefined,
      supportedRuntimeModes: undefined,
      policy: undefined,
      connectionConnected: true,
      serverConfig: {
        providers: [
          {
            instanceId: ProviderInstanceId.make("antigravity-1"),
            driver: "antigravity",
            displayName: "Antigravity",
            enabled: true,
            status: "error",
            installed: false,
            auth: { status: "unauthenticated" },
            availability: "unavailable",
            models: [],
          },
        ],
      } as never,
      modelSelection: antigravitySelection,
      projectId: null,
      selectedProvider: {
        instanceId: ProviderInstanceId.make("antigravity-1"),
        driver: "antigravity",
        displayName: "Antigravity",
        enabled: true,
        status: "error",
        installed: false,
        auth: { status: "unauthenticated" },
        availability: "unavailable",
        models: [],
      } as never,
      onOpenModelSettings: () => undefined,
    });

    expect(items[0]).toMatchObject({
      id: "model-unavailable",
      variant: "error",
      title: "Antigravity model unavailable",
    });
  });
});
