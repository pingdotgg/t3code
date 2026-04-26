import type {
  EnvironmentId,
  PreviewCaseManifest,
  PreviewManifestEntry,
  PreviewViewport,
  PreviewViewportPreset,
} from "@forma/contracts";

import type { WorkLogEntry } from "~/session-logic";
import { getEnvironmentHttpBaseUrl, readEnvironmentConnection } from "~/environments/runtime";
import { isLoopbackHostname } from "~/environments/primary/target";
import type { PreviewViewportMode } from "~/previewStateStore";

export interface PreviewAvailability {
  readonly supported: boolean;
  readonly reason: string | null;
}

const VIEWPORT_WIDTH_BY_MODE: Record<PreviewViewportPreset, number> = {
  sm: 420,
  md: 768,
  lg: 1024,
  xl: 1280,
};

function normalizeSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

export function normalizePreviewMatchPath(
  inputPath: string,
  workspaceRoot: string | null | undefined,
): string {
  const normalizedPath = normalizeSlashes(inputPath.trim()).replace(/^\.\/+/, "");
  if (!workspaceRoot) {
    return normalizedPath;
  }

  const normalizedWorkspaceRoot = normalizeSlashes(workspaceRoot.trim()).replace(/\/+$/, "");
  if (normalizedWorkspaceRoot.length === 0) {
    return normalizedPath;
  }

  if (normalizedPath === normalizedWorkspaceRoot) {
    return "";
  }

  if (normalizedPath.startsWith(`${normalizedWorkspaceRoot}/`)) {
    return normalizedPath.slice(normalizedWorkspaceRoot.length + 1);
  }

  return normalizedPath;
}

function changedPathMatchesTarget(changedPath: string, targetPath: string): boolean {
  const normalizedChangedPath = normalizeSlashes(changedPath);
  const normalizedTargetPath = normalizeSlashes(targetPath);
  return (
    normalizedChangedPath === normalizedTargetPath ||
    normalizedChangedPath.endsWith(`/${normalizedTargetPath}`)
  );
}

export function deriveChangedPreviewTabs(input: {
  readonly workEntries: ReadonlyArray<WorkLogEntry>;
  readonly previewEntries: ReadonlyArray<PreviewManifestEntry>;
  readonly workspaceRoot: string | null | undefined;
}): PreviewManifestEntry[] {
  const previewEntriesById = new Map(input.previewEntries.map((entry) => [entry.id, entry]));
  const orderedPreviewIds: string[] = [];
  const seenPreviewIds = new Set<string>();

  for (const workEntry of input.workEntries) {
    for (const changedFile of workEntry.changedFiles ?? []) {
      const normalizedChangedFile = normalizePreviewMatchPath(changedFile, input.workspaceRoot);
      for (const previewEntry of input.previewEntries) {
        if (
          changedPathMatchesTarget(normalizedChangedFile, previewEntry.componentPath) ||
          changedPathMatchesTarget(normalizedChangedFile, previewEntry.previewPath)
        ) {
          if (!seenPreviewIds.has(previewEntry.id)) {
            seenPreviewIds.add(previewEntry.id);
            orderedPreviewIds.push(previewEntry.id);
          }
        }
      }
    }
  }

  return orderedPreviewIds.flatMap((previewId) => {
    const previewEntry = previewEntriesById.get(previewId);
    return previewEntry ? [previewEntry] : [];
  });
}

export function buildChangedFilesSignature(workEntries: ReadonlyArray<WorkLogEntry>): string {
  return workEntries.flatMap((entry) => entry.changedFiles ?? []).join("\u0000");
}

export function buildPreviewRenderUrl(input: {
  readonly baseUrl: string;
  readonly previewId: string;
  readonly caseId: string;
  readonly theme: "light" | "dark";
  readonly viewportWidth: number | null;
  readonly token: string;
}): string {
  const url = new URL(`/__forma/render/${encodeURIComponent(input.previewId)}`, input.baseUrl);
  url.searchParams.set("case", input.caseId);
  url.searchParams.set("theme", input.theme);
  if (input.viewportWidth && input.viewportWidth > 0) {
    url.searchParams.set("viewportWidth", `${input.viewportWidth}`);
  }
  url.searchParams.set("token", input.token);
  return url.toString();
}

export function previewAvailabilityForEnvironment(
  environmentId: EnvironmentId,
  hasActiveProject: boolean,
): PreviewAvailability {
  if (!hasActiveProject) {
    return {
      supported: false,
      reason: "Preview is unavailable until this thread has an active project.",
    };
  }

  const connection = readEnvironmentConnection(environmentId);
  if (!connection || connection.kind === "saved") {
    return {
      supported: false,
      reason: "Preview is local-only in v1.",
    };
  }

  const httpBaseUrl =
    connection.knownEnvironment.target.httpBaseUrl ?? getEnvironmentHttpBaseUrl(environmentId);
  if (!httpBaseUrl) {
    return {
      supported: false,
      reason: "Preview is unavailable because the local environment base URL is unknown.",
    };
  }

  try {
    const url = new URL(httpBaseUrl);
    if (!isLoopbackHostname(url.hostname)) {
      return {
        supported: false,
        reason: "Preview is local-only in v1.",
      };
    }
  } catch {
    return {
      supported: false,
      reason: "Preview is unavailable because the local environment URL is invalid.",
    };
  }

  return {
    supported: true,
    reason: null,
  };
}

export function resolveViewportWidth(
  viewportMode: PreviewViewportMode,
  previewViewport: PreviewViewport | undefined,
): number | null {
  if (viewportMode === "responsive") {
    return null;
  }

  if (viewportMode === "auto") {
    if (previewViewport?.width && previewViewport.width > 0) {
      return previewViewport.width;
    }
    if (previewViewport?.preset) {
      return VIEWPORT_WIDTH_BY_MODE[previewViewport.preset] ?? null;
    }
    return null;
  }

  return VIEWPORT_WIDTH_BY_MODE[viewportMode] ?? null;
}

export function viewportModeLabel(mode: PreviewViewportMode): string {
  switch (mode) {
    case "auto":
      return "Auto";
    case "responsive":
      return "Responsive";
    case "sm":
      return "Small";
    case "md":
      return "Medium";
    case "lg":
      return "Large";
    case "xl":
      return "Extra large";
  }
}

export function previewCaseLabel(caseEntry: PreviewCaseManifest): string {
  return caseEntry.label;
}
