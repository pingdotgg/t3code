import path from "node:path";

import { ATTACHMENTS_ROUTE_PREFIX } from "./imageMime.ts";

export function normalizeAttachmentRelativePath(rawRelativePath: string): string | null {
  const normalized = path.normalize(rawRelativePath).replace(/^[/\\]+/, "");
  if (normalized.length === 0 || normalized.startsWith("..") || normalized.includes("\0")) {
    return null;
  }
  return normalized.replace(/\\/g, "/");
}

export function attachmentRouteToRelativePath(dataUrl: string): string | null {
  const prefix = `${ATTACHMENTS_ROUTE_PREFIX}/`;
  if (!dataUrl.startsWith(prefix)) {
    return null;
  }
  return normalizeAttachmentRelativePath(dataUrl.slice(prefix.length));
}

export function resolveAttachmentRelativePath(input: {
  readonly stateDir: string;
  readonly relativePath: string;
}): string | null {
  const normalizedRelativePath = normalizeAttachmentRelativePath(input.relativePath);
  if (!normalizedRelativePath) {
    return null;
  }

  const attachmentsRoot = path.resolve(path.join(input.stateDir, "attachments"));
  const filePath = path.resolve(path.join(attachmentsRoot, normalizedRelativePath));
  if (!filePath.startsWith(`${attachmentsRoot}${path.sep}`)) {
    return null;
  }
  return filePath;
}

export function resolveAttachmentRoutePath(input: {
  readonly stateDir: string;
  readonly dataUrl: string;
}): string | null {
  const relativePath = attachmentRouteToRelativePath(input.dataUrl);
  if (!relativePath) {
    return null;
  }
  return resolveAttachmentRelativePath({
    stateDir: input.stateDir,
    relativePath,
  });
}
