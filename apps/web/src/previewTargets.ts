import type { PreviewTargetKind, ScopedProjectRef } from "@forma/contracts";

import { useBottomDrawerUiStore } from "./bottomDrawerUiStore";
import { usePreviewWorkspaceStore } from "./previewWorkspaceStore";

const COMPONENT_EXTENSIONS = new Set([".tsx", ".jsx", ".ts", ".js", ".vue"]);

export interface PreviewPathClassification {
  enabled: boolean;
  targetKind?: PreviewTargetKind | undefined;
  reason?: string | undefined;
}

export interface PreviewLaunchTarget {
  targetKind: PreviewTargetKind;
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
      enabled: true,
      targetKind: "story",
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
      targetKind: "component",
    };
  }
  return {
    enabled: false,
    reason: "Only component source files and Storybook story files can be previewed.",
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
    currentTargetKind: target.targetKind,
    currentRelativePath: target.relativePath,
    currentComponentRelativePath: target.targetKind === "component" ? target.relativePath : null,
    currentStoryRelativePath: target.targetKind === "story" ? target.relativePath : null,
    currentStoryId: null,
    currentVariantIndex: 0,
    ephemeralArgs: {},
    runtimeState: null,
    storyChoices: [],
    resolution: null,
    controls: [],
    accessToken: null,
  });
  useBottomDrawerUiStore.getState().showPreview();
}
