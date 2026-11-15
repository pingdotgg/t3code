import type { ClientSettings } from "@t3tools/contracts/settings";

type VideoSettings = Pick<
  ClientSettings,
  "videoBackground" | "videoBackgroundFolder" | "videoBackgroundFile"
>;

/** A file background needs the desktop app, a chosen folder, and a chosen file. */
export function videoBackgroundActive(
  settings: VideoSettings,
  canPlayFiles = typeof window !== "undefined" &&
    window.desktopBridge?.listVideoFolder !== undefined,
): boolean {
  if (settings.videoBackground === "galaxy") return true;
  return (
    settings.videoBackground === "file" &&
    canPlayFiles &&
    settings.videoBackgroundFolder !== "" &&
    settings.videoBackgroundFile !== ""
  );
}

/** Where the app's own origin serves a chosen video (see the desktop media route). */
export function videoFileUrl(origin: string, folder: string, file: string): string {
  const separator = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
  const path = folder.endsWith(separator) ? `${folder}${file}` : `${folder}${separator}${file}`;
  return `${origin}/__media/video?path=${encodeURIComponent(path)}`;
}
