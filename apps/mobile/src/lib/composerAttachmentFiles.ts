export const COMPOSER_ATTACHMENT_DIRECTORY = "t3-composer-attachments";

const UUID_PATTERN = "[a-f\\d]{8}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{12}";
const GENERATED_FILE_NAME = new RegExp(`^${UUID_PATTERN}-`, "i");
const IOS_DOCUMENTS_PATH = new RegExp(
  `^(.*/Containers/Data/Application/)${UUID_PATTERN}/Documents$`,
  "i",
);
const retainedFiles = new Map<string, number>();

function fileUriPath(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:" || url.hostname || url.search || url.hash) {
      return null;
    }
    const path = decodeURIComponent(url.pathname);
    if (path.includes("\\") || path.includes("\0") || path.split("/").includes("..")) {
      return null;
    }
    return path.startsWith("/private/var/") ? path.slice("/private".length) : path;
  } catch {
    return null;
  }
}

function ownedFileLocation(uri: string) {
  const path = fileUriPath(uri);
  if (path === null) {
    return null;
  }
  const separator = `/${COMPOSER_ATTACHMENT_DIRECTORY}/`;
  const index = path.lastIndexOf(separator);
  const name = index < 0 ? "" : path.slice(index + separator.length);
  if (!name || name === "." || name.includes("/")) {
    return null;
  }
  return { documentPath: path.slice(0, index), name };
}

/** Compares references across iOS data-container moves without rewriting saved drafts. */
export function composerAttachmentFileReferenceKey(uri: string): string {
  const location = ownedFileLocation(uri);
  if (!location) {
    return uri;
  }
  const containerPrefix = GENERATED_FILE_NAME.test(location.name)
    ? IOS_DOCUMENTS_PATH.exec(location.documentPath)?.[1]
    : undefined;
  const documentPath = containerPrefix
    ? `${containerPrefix}<app>/Documents`
    : location.documentPath;
  return `file://${documentPath}/${COMPOSER_ATTACHMENT_DIRECTORY}/${encodeURIComponent(location.name)}`;
}

/** Holds a local copy until its last player or share-copy operation releases it. */
export function retainComposerAttachmentFile(uri: string, onLastRelease: () => void): () => void {
  const key = composerAttachmentFileReferenceKey(uri);
  retainedFiles.set(key, (retainedFiles.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const remaining = (retainedFiles.get(key) ?? 1) - 1;
    if (remaining > 0) {
      retainedFiles.set(key, remaining);
      return;
    }
    retainedFiles.delete(key);
    onLastRelease();
  };
}

export function isComposerAttachmentFileRetained(uri: string): boolean {
  return retainedFiles.has(composerAttachmentFileReferenceKey(uri));
}

/**
 * Resolves only our saved attachment copies. iOS preserves Documents on updates
 * but can change its container UUID. Picker and open-in-place source URIs must
 * bypass this resolver so another app's document keeps its original location.
 */
export function resolveOwnedComposerAttachmentFileUri(
  uri: string,
  documentDirectoryUri: string,
): string | null {
  const location = ownedFileLocation(uri);
  const documentPath = fileUriPath(documentDirectoryUri)?.replace(/\/+$/, "");
  if (!location || !documentPath) {
    return null;
  }
  if (location.documentPath !== documentPath) {
    const currentContainerPrefix = IOS_DOCUMENTS_PATH.exec(documentPath)?.[1];
    if (
      !currentContainerPrefix ||
      currentContainerPrefix !== IOS_DOCUMENTS_PATH.exec(location.documentPath)?.[1] ||
      !GENERATED_FILE_NAME.test(location.name)
    ) {
      return null;
    }
  }
  const resolved = new URL(documentDirectoryUri);
  resolved.pathname = `${resolved.pathname.replace(/\/+$/, "")}/${COMPOSER_ATTACHMENT_DIRECTORY}/${encodeURIComponent(location.name)}`;
  return resolved.href;
}
