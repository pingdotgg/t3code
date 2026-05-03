"use client";

import type { ScopedThreadRef } from "@t3tools/contracts";

import { isPreviewSupportedInRuntime } from "~/previewStateStore";

import { PreviewPanelShell, type PreviewPanelMode } from "./PreviewPanelShell";
import { PreviewView } from "./PreviewView";

interface Props {
  mode: PreviewPanelMode;
  threadRef: ScopedThreadRef;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
}

export function PreviewPanel({ mode, threadRef, configuredUrls, visible }: Props) {
  if (!isPreviewSupportedInRuntime()) {
    return (
      <PreviewPanelShell mode={mode}>
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            Preview is only available in the T3 Code desktop app.
          </p>
        </div>
      </PreviewPanelShell>
    );
  }

  return (
    <PreviewPanelShell mode={mode}>
      <PreviewView threadRef={threadRef} configuredUrls={configuredUrls} visible={visible} />
    </PreviewPanelShell>
  );
}
