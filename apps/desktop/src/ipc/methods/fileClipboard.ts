import * as NodeURL from "node:url";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const CopyFileToClipboardInput = Schema.Struct({
  url: Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()),
  fileName: Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()),
});

export class DesktopFileClipboardError extends Schema.TaggedErrorClass<DesktopFileClipboardError>()(
  "DesktopFileClipboardError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

// The staged copy lives under the desktop state dir so the clipboard reference
// stays valid after the renderer navigates or the remote environment goes away.
const FILE_CLIPBOARD_DIR_NAME = "file-clipboard";

export function sanitizeClipboardFileName(fileName: string): string {
  const sanitized = fileName.replaceAll("\u0000", "_").replace(/[\\/:]/g, "_");
  return sanitized === "" || /^\.+$/.test(sanitized) ? "download" : sanitized;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// Each platform expects a different raw clipboard format for "a file was
// copied": an NSFilenamesPboardType plist on macOS, a CF_HDROP DROPFILES
// struct on Windows, and the GNOME copied-files convention elsewhere.
export function fileReferenceClipboardPayload(
  platform: NodeJS.Platform,
  filePath: string,
): { readonly format: string; readonly buffer: Buffer } {
  switch (platform) {
    case "darwin": {
      const plist = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<array>",
        `<string>${escapeXml(filePath)}</string>`,
        "</array>",
        "</plist>",
      ].join("\n");
      return { format: "NSFilenamesPboardType", buffer: Buffer.from(plist, "utf8") };
    }
    case "win32": {
      // DROPFILES header: pFiles (offset to the path list), pt.x, pt.y, fNC,
      // fWide, followed by a UTF-16LE double-null-terminated path list.
      const header = Buffer.alloc(20);
      header.writeUInt32LE(20, 0);
      header.writeUInt32LE(1, 16);
      const paths = Buffer.from(`${filePath}\0\0`, "utf16le");
      return { format: "CF_HDROP", buffer: Buffer.concat([header, paths]) };
    }
    default: {
      const uri = NodeURL.pathToFileURL(filePath).href;
      return {
        format: "x-special/gnome-copied-files",
        buffer: Buffer.from(`copy\n${uri}`, "utf8"),
      };
    }
  }
}

export const copyFileToClipboard = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COPY_FILE_TO_CLIPBOARD_CHANNEL,
  payload: CopyFileToClipboardInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.fileClipboard.copyFileToClipboard")(function* ({
    url,
    fileName,
  }) {
    const parsedUrl = yield* Effect.try({
      try: () => new URL(url),
      catch: (cause) => new DesktopFileClipboardError({ reason: "Invalid file URL.", cause }),
    });
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return yield* new DesktopFileClipboardError({
        reason: "Only http and https file URLs can be copied.",
      });
    }

    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stagingDir = path.join(environment.stateDir, FILE_CLIPBOARD_DIR_NAME);

    const bytes = yield* Effect.tryPromise({
      try: async () => {
        const response = await Electron.net.fetch(parsedUrl.href);
        if (!response.ok) {
          throw new Error(`The file request failed with status ${response.status}.`);
        }
        return new Uint8Array(await response.arrayBuffer());
      },
      catch: (cause) =>
        new DesktopFileClipboardError({ reason: "Failed to download the file.", cause }),
    });

    // Replace any previously staged copy; its clipboard reference is
    // superseded by the write below.
    const targetPath = path.join(stagingDir, sanitizeClipboardFileName(fileName));
    yield* fileSystem
      .remove(stagingDir, { recursive: true })
      .pipe(Effect.orElseSucceed(() => undefined));
    yield* fileSystem
      .makeDirectory(stagingDir, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new DesktopFileClipboardError({ reason: "Failed to stage the file.", cause }),
        ),
      );
    yield* fileSystem
      .writeFile(targetPath, bytes)
      .pipe(
        Effect.mapError(
          (cause) => new DesktopFileClipboardError({ reason: "Failed to stage the file.", cause }),
        ),
      );

    const platform = yield* HostProcessPlatform;
    const payload = fileReferenceClipboardPayload(platform, targetPath);
    yield* Effect.try({
      try: () => Electron.clipboard.writeBuffer(payload.format, payload.buffer),
      catch: (cause) =>
        new DesktopFileClipboardError({
          reason: "Failed to write the file to the clipboard.",
          cause,
        }),
    });
  }),
});
