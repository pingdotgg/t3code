import type { ScopedProjectRef } from "@forma/contracts";

import { useBottomDrawerUiStore } from "./bottomDrawerUiStore";
import { usePreviewWorkspaceStore } from "./previewWorkspaceStore";

const COMPONENT_EXTENSIONS = new Set([".tsx", ".jsx", ".ts", ".js", ".vue"]);

export interface PreviewPathClassification {
  enabled: boolean;
  reason?: string | undefined;
}

export interface PreviewLaunchTarget {
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

export function classifyPreviewRelativePath(relativePath: string): PreviewPathClassification {
  const normalized = normalizedPath(relativePath);
  if (/\.(stories|story)\.[^.]+$/i.test(normalized)) {
    return {
      enabled: false,
      reason: "Story files are no longer preview targets. Open the component source file instead.",
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

export function openPreviewDrawer(projectRef?: ScopedProjectRef | null): void {
  usePreviewWorkspaceStore.getState().setActiveProjectRef(projectRef ?? null);
  useBottomDrawerUiStore.getState().showPreview();
}

export function openPreviewTarget(projectRef: ScopedProjectRef, target: PreviewLaunchTarget): void {
  const previewStore = usePreviewWorkspaceStore.getState();
  previewStore.setActiveProjectRef(projectRef);
  previewStore.patchProjectState(projectRef, {
    currentRelativePath: target.relativePath,
    currentPreviewFileRelativePath: null,
    runtimeSnapshot: null,
    runtimeState: null,
    resolution: null,
    accessToken: null,
  });
  useBottomDrawerUiStore.getState().showPreview();
}
