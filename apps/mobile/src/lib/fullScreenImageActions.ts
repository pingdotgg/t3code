import * as Schema from "effect/Schema";
import * as Sharing from "expo-sharing";
import type { ImageURISource } from "react-native";

export type FullScreenImageSource = {
  readonly uri: string;
  readonly fileName?: string;
  /** Forwarded to `react-native-image-viewing`'s underlying `Image` source. */
  readonly cache?: ImageURISource["cache"];
};

export type ImageActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export const SHARING_UNAVAILABLE_MESSAGE = "Sharing isn't available on this device.";
export const SHARE_FAILED_MESSAGE = "Couldn't share the image.";

export class ImageShareError extends Schema.TaggedErrorClass<ImageShareError>()("ImageShareError", {
  stage: Schema.Literals(["materialize", "share"]),
  scheme: Schema.String,
  host: Schema.optional(Schema.String),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    const action = this.stage === "materialize" ? "prepare" : "share";
    const from = this.host === undefined ? "" : ` from ${this.host}`;
    return `Failed to ${action} the ${this.scheme} image${from}.`;
  }
}

const CACHE_DIRECTORY_NAME = "fullscreen-image-share";
const DATA_URI_PATTERN = /^data:([^;,]*)(?:;[^;,=]+=[^;,]+)*(?:(;base64))?,/i;

/** iOS needs a UTI alongside the mime type for the sheet to offer the right targets. */
const IMAGE_TYPES: ReadonlyArray<{
  readonly extension: string;
  readonly mimeType: string;
  readonly uti: string;
}> = [
  { extension: "png", mimeType: "image/png", uti: "public.png" },
  { extension: "jpg", mimeType: "image/jpeg", uti: "public.jpeg" },
  { extension: "jpeg", mimeType: "image/jpeg", uti: "public.jpeg" },
  { extension: "gif", mimeType: "image/gif", uti: "com.compuserve.gif" },
  { extension: "webp", mimeType: "image/webp", uti: "org.webmproject.webp" },
  { extension: "heic", mimeType: "image/heic", uti: "public.heic" },
  { extension: "bmp", mimeType: "image/bmp", uti: "com.microsoft.bmp" },
];

type ImageType = (typeof IMAGE_TYPES)[number];

let temporaryDirectoryCounter = 0;

/**
 * Safe diagnostics for an image URI, mirroring `openExternalUrl`. Asset URLs are
 * signed capabilities and `data:` URIs are the image bytes, so neither may be
 * logged whole. For a `data:` URI `host` carries the media type instead.
 */
export function imageUriMetadata(uri: string): {
  readonly scheme: string;
  readonly host?: string;
} {
  const dataMatch = DATA_URI_PATTERN.exec(uri);
  if (dataMatch !== null) {
    return { scheme: "data", host: dataMatch[1] || "application/octet-stream" };
  }
  try {
    const parsed = new URL(uri);
    return {
      scheme: parsed.protocol.replace(/:$/, "") || "unknown",
      host: parsed.hostname || undefined,
    };
  } catch {
    return { scheme: /^([a-z][a-z\d+.-]*):/i.exec(uri)?.[1]?.toLowerCase() ?? "unknown" };
  }
}

function imageTypeFor(uri: string): ImageType | null {
  const dataMatch = DATA_URI_PATTERN.exec(uri);
  if (dataMatch !== null) {
    const mimeType = dataMatch[1]?.toLowerCase();
    return IMAGE_TYPES.find((type) => type.mimeType === mimeType) ?? null;
  }

  // Only the last path segment, so dots in the hostname are not read as an extension.
  const lastSegment = (uri.split(/[?#]/, 1)[0] ?? "").split("/").pop() ?? "";
  const dotIndex = lastSegment.lastIndexOf(".");
  if (dotIndex <= 0) {
    return null;
  }
  const extension = lastSegment.slice(dotIndex + 1).toLowerCase();
  return IMAGE_TYPES.find((type) => type.extension === extension) ?? null;
}

/** Returns "" when nothing usable is left, so the caller falls back to a generic name. */
function sanitizeFileNameStem(fileName: string): string {
  const withoutDirectories = fileName.split(/[\\/]/).pop() ?? "";
  const dotIndex = withoutDirectories.lastIndexOf(".");
  const stem = dotIndex > 0 ? withoutDirectories.slice(0, dotIndex) : withoutDirectories;
  return stem.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|-+$/g, "");
}

function temporaryFileName(source: FullScreenImageSource): string {
  const extension = imageTypeFor(source.uri)?.extension ?? "img";
  const stem = source.fileName ? sanitizeFileNameStem(source.fileName) : "";
  return `${stem.length > 0 ? stem : "image"}.${extension}`;
}

/**
 * Only a real file can be handed straight to the sheet. Android's `shareAsync`
 * rejects every other scheme outright, so `content://` is copied first even
 * though the bytes are already on the device.
 */
function isShareableFileUri(uri: string): boolean {
  return uri.startsWith("file://") || uri.startsWith("/");
}

function isContentUri(uri: string): boolean {
  return uri.startsWith("content://");
}

/**
 * A fresh directory per share. The file inside keeps its display name, which is
 * what the share sheet shows, while the unique parent stops two shares of
 * same-named images from overwriting each other.
 */
async function createTemporaryDirectory() {
  const { Directory, Paths } = await import("expo-file-system");
  temporaryDirectoryCounter += 1;
  const directory = new Directory(
    Paths.cache,
    CACHE_DIRECTORY_NAME,
    String(temporaryDirectoryCounter),
  );
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

function deleteQuietly(target: { delete: () => void }): void {
  try {
    target.delete();
  } catch {
    // A leftover entry in the cache directory is harmless; the OS reclaims it.
  }
}

type MaterializedImage = {
  readonly file: { readonly uri: string };
  /** Set when we created a temporary directory that must be removed afterwards. */
  readonly temporaryDirectory: { delete: () => void } | null;
};

/** `Sharing.shareAsync` only accepts a local file, so remote and data URIs land on disk first. */
async function materializeImageFile(source: FullScreenImageSource): Promise<MaterializedImage> {
  const { File } = await import("expo-file-system");

  if (isShareableFileUri(source.uri)) {
    return { file: new File(source.uri), temporaryDirectory: null };
  }

  const directory = await createTemporaryDirectory();
  try {
    const dataMatch = DATA_URI_PATTERN.exec(source.uri);
    if (dataMatch !== null) {
      if (dataMatch[2] === undefined) {
        throw new Error("Only base64-encoded data URIs are supported.");
      }
      const file = new File(directory, temporaryFileName(source));
      file.create({ overwrite: true });
      file.write(source.uri.slice(dataMatch[0].length), { encoding: "base64" });
      return { file, temporaryDirectory: directory };
    }

    if (isContentUri(source.uri)) {
      const destination = new File(directory, temporaryFileName(source));
      await new File(source.uri).copy(destination);
      return { file: destination, temporaryDirectory: directory };
    }

    const destination = new File(directory, temporaryFileName(source));
    const downloaded = await File.downloadFileAsync(source.uri, destination, { idempotent: true });
    return { file: downloaded, temporaryDirectory: directory };
  } catch (cause) {
    // The directory is ours and the caller never sees it, so clean up here.
    deleteQuietly(directory);
    throw cause;
  }
}

export async function shareImage(source: FullScreenImageSource): Promise<ImageActionResult> {
  let materialized: MaterializedImage | null = null;
  let stage: "materialize" | "share" = "materialize";
  try {
    if (!(await Sharing.isAvailableAsync())) {
      return { ok: false, message: SHARING_UNAVAILABLE_MESSAGE };
    }

    materialized = await materializeImageFile(source);
    stage = "share";
    const imageType = imageTypeFor(source.uri);

    // Resolves only after the sheet is dismissed, so the file outlives every read.
    await Sharing.shareAsync(materialized.file.uri, {
      dialogTitle: source.fileName,
      mimeType: imageType?.mimeType,
      UTI: imageType?.uti,
    });

    return { ok: true };
  } catch (cause) {
    console.error(new ImageShareError({ stage, ...imageUriMetadata(source.uri), cause }));
    return { ok: false, message: SHARE_FAILED_MESSAGE };
  } finally {
    if (materialized?.temporaryDirectory) {
      deleteQuietly(materialized.temporaryDirectory);
    }
  }
}
