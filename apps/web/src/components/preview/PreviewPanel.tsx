"use client";

import type { ScopedThreadRef } from "@t3tools/contracts";

import { isPreviewSupportedInRuntime } from "~/previewStateStore";

import { PreviewPanelShell, type PreviewPanelMode } from "./PreviewPanelShell";
import { PreviewView } from "./PreviewView";

interface Props {
  mode: PreviewPanelMode;
  threadRef: ScopedThreadRef;
  tabId?: string | null;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
  maximized?: boolean | undefined;
  onClose?: (() => void) | undefined;
}

export function PreviewPanel({
  mode,
  threadRef,
  tabId,
  configuredUrls,
  visible,
  maximized,
  onClose,
}: Props) {
  if (!isPreviewSupportedInRuntime()) {
    return (
      <PreviewPanelShell mode={mode} maximized={maximized}>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            Preview is only available in the T3 Code desktop app.
          </p>
        </div>
      </PreviewPanelShell>
    );
  }

  return (
    <PreviewPanelShell mode={mode} maximized={maximized}>
      <PreviewView
        threadRef={threadRef}
        {...(tabId !== undefined ? { tabId } : {})}
        configuredUrls={configuredUrls}
        visible={visible}
        onClose={onClose}
      />
    </PreviewPanelShell>
  );
}
