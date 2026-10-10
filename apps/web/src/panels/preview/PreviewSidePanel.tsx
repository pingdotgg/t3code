"use client";

import { AuthPreviewOperateScope } from "@t3tools/contracts";

import { PreviewPanelShell } from "~/components/preview/PreviewPanelShell";
import { PreviewView } from "~/components/preview/PreviewView";
import { usePreviewAvailable } from "~/browser/previewRuntime";
import { useEnvironmentScope } from "~/state/session";

import { usePanelHost } from "../panelHost";

interface PreviewSidePanelProps {
  tabId?: string | null;
  configuredUrls?: ReadonlyArray<string> | undefined;
}

// RightPanelTabs owns placement, so the side panel is always embedded.
export default function PreviewSidePanel({ tabId, configuredUrls }: PreviewSidePanelProps) {
  const { threadRef, visible, sendAnnotation } = usePanelHost();
  // The desktop app hosts browsers itself; other clients need an environment that runs them.
  const available = usePreviewAvailable(threadRef.environmentId);
  const canOperatePreview = useEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope);
  if (!canOperatePreview || !available) {
    return (
      <PreviewPanelShell mode="embedded">
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            {canOperatePreview
              ? "Preview is only available in the T3 Code desktop app."
              : "Pair this client again with preview access to control browser previews."}
          </p>
        </div>
      </PreviewPanelShell>
    );
  }

  return (
    <PreviewPanelShell mode="embedded">
      <PreviewView
        threadRef={threadRef}
        {...(tabId !== undefined ? { tabId } : {})}
        configuredUrls={configuredUrls}
        visible={visible}
        onSendAnnotation={sendAnnotation}
      />
    </PreviewPanelShell>
  );
}
