import * as OS from "node:os";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { T3workAtlassianError } from "./t3work-atlassian-http.ts";

export type BootstrapWorkspaceRequest = {
  readonly workspaceRoot: string;
  readonly linkedRepositoryUrls?: ReadonlyArray<string>;
  readonly setupProfileId?: string;
  readonly customProfile?: import("@t3tools/t3work-skill-packs").T3WorkProfile;
};

export type LinkedRepositoryBootstrapResult = {
  readonly url: string;
  readonly localPath: string;
  readonly status: "cloned" | "updated" | "failed";
  readonly error?: string;
};

export type BootstrapWorkspaceResponse = {
  readonly workspaceRoot: string;
  readonly workspaceRepositoryInitialized: boolean;
  readonly referencesRoot: string;
  readonly linkedRepositories: ReadonlyArray<LinkedRepositoryBootstrapResult>;
};

export type ContextWorkspaceFile = {
  readonly relativePath: string;
  readonly contents: string;
  readonly encoding?: "utf8" | "base64";
};

export type WriteContextFilesRequest = {
  readonly workspaceRoot: string;
  readonly files: ReadonlyArray<ContextWorkspaceFile>;
};

export type WriteContextFilesResponse = {
  readonly workspaceRoot: string;
  readonly writtenFiles: ReadonlyArray<string>;
};

export const HIDDEN_T3WORK_DIR = ".t3work";
export const REFERENCES_DIR_NAME = "references";
export const MANIFEST_FILE_NAME = "reference-repositories.json";
export const GITIGNORE_ENTRY = ".t3work/";

export type ReferenceManifestFile = {
  readonly workspaceRoot: string;
  readonly referencesRoot: string;
  readonly workspaceRepositoryInitialized: boolean;
  readonly linkedRepositories: ReadonlyArray<LinkedRepositoryBootstrapResult>;
  readonly updatedAt: string;
};

export function normalizeRepositoryUrls(
  urls: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  const deduped = new Set<string>();
  for (const candidate of urls ?? []) {
    const trimmed = candidate.trim();
    if (trimmed.length > 0) deduped.add(trimmed);
  }
  return [...deduped.values()];
}

export const normalizeT3workWorkspaceRoot = Effect.fn("normalizeT3workWorkspaceRoot")(function* (
  workspaceRoot: string,
) {
  const path = yield* Path.Path;
  const trimmed = workspaceRoot.trim();
  if (trimmed === "~") {
    return OS.homedir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(OS.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
});

function sanitizeSlugSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function deriveReferenceDirectoryName(url: string): string {
  const trimmed = url.trim();
  const sshMatch = /^git@([^:]+):(.+)$/i.exec(trimmed);
  if (sshMatch) {
    const host = sanitizeSlugSegment(sshMatch[1] ?? "host");
    const pathPart = sanitizeSlugSegment((sshMatch[2] ?? "repo").replace(/\.git$/i, ""));
    return `${host}-${pathPart}`;
  }

  const shorthandMatch = /^([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/i.exec(trimmed);
  if (shorthandMatch) {
    const owner = sanitizeSlugSegment(shorthandMatch[1] ?? "owner");
    const repo = sanitizeSlugSegment((shorthandMatch[2] ?? "repo").replace(/\.git$/i, ""));
    return `${owner}-${repo}`;
  }

  try {
    const parsed = new URL(trimmed);
    const host = sanitizeSlugSegment(parsed.host);
    const pathname = sanitizeSlugSegment(
      parsed.pathname.replace(/^\/+/, "").replace(/\.git$/i, ""),
    );
    return `${host}-${pathname}`;
  } catch {
    const fallback = sanitizeSlugSegment(trimmed.replace(/\.git$/i, ""));
    return fallback || "repo";
  }
}

export function formatReferenceManifestJson(manifest: ReferenceManifestFile): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function toT3workError(cause: unknown, fallback: string): T3workAtlassianError {
  return cause instanceof T3workAtlassianError
    ? cause
    : new T3workAtlassianError({
        message: cause instanceof Error ? cause.message : fallback,
        cause,
      });
}
