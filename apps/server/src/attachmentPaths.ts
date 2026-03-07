import path from "node:path";

export const ATTACHMENTS_ROUTE_PREFIX = "/attachments";

export function normalizeAttachmentRelativePath(rawRelativePath: string): string | null {
  const normalized = path.normalize(rawRelativePath).replace(/^[/\\]+/, "");
  if (normalized.length === 0 || normalized.startsWith("..") || normalized.includes("\0")) {
    return null;
  }
  return normalized.replace(/\\/g, "/");
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
