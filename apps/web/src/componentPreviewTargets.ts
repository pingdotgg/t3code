/**
 * Entry points for the component preview harness right-panel surface.
 *
 * Unrelated to the desktop webview browser preview surface.
 */
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";

import { useComponentPreviewWorkspaceStore } from "./componentPreviewWorkspaceStore";
import { useRightPanelStore } from "./rightPanelStore";

const COMPONENT_EXTENSIONS = new Set([".tsx", ".jsx", ".ts", ".js", ".vue"]);

export interface ComponentPreviewPathClassification {
  enabled: boolean;
  reason?: string | undefined;
}

export interface ComponentPreviewLaunchTarget {
  relativePath: string;
}

function normalizedPath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function pathExtension(relativePath: string): string {
  const normalized = normalizedPath(relativePath);
  const index = normalized.lastIndexOf(".");
  return index >= 0 ? normalized.slice(index) : "";
}

export function classifyComponentPreviewRelativePath(
  relativePath: string,
): ComponentPreviewPathClassification {
  const normalized = normalizedPath(relativePath);
  if (/\.(stories|story)\.[^.]+$/i.test(normalized)) {
    return {
      enabled: false,
      reason: "Story files are not preview targets. Open the component source file instead.",
    };
  }
  if (normalized.endsWith(".d.ts")) {
    return {
      enabled: false,
      reason: "Declaration files cannot be previewed.",
    };
  }
  if (/(\.test|\.spec)\.[^.]+$/i.test(normalized)) {
    return {
      enabled: false,
      reason: "Test files cannot be previewed.",
    };
  }
  if (COMPONENT_EXTENSIONS.has(pathExtension(normalized))) {
    return {
      enabled: true,
    };
  }
  return {
    enabled: false,
    reason: "Only component source files can be previewed.",
  };
}

export function openComponentPreviewSurface(
  threadRef: ScopedThreadRef,
  projectRef?: ScopedProjectRef | null,
): void {
  useComponentPreviewWorkspaceStore.getState().setActiveProjectRef(projectRef ?? null);
  useRightPanelStore.getState().open(threadRef, "componentPreview");
}

export function openComponentPreviewTarget(
  threadRef: ScopedThreadRef,
  projectRef: ScopedProjectRef,
  target: ComponentPreviewLaunchTarget,
): void {
  const previewStore = useComponentPreviewWorkspaceStore.getState();
  previewStore.setActiveProjectRef(projectRef);
  previewStore.patchProjectState(projectRef, {
    currentRelativePath: target.relativePath,
    currentPreviewFileRelativePath: null,
    runtimeSnapshot: null,
    runtimeState: null,
    resolution: null,
    accessToken: null,
  });
  useRightPanelStore.getState().open(threadRef, "componentPreview");
}
