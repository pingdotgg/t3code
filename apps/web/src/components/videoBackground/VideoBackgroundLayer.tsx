import { useEffect, useRef, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { startGalaxy } from "./galaxy";
import { videoBackgroundActive, videoFileUrl } from "./videoBackground.logic";

/** The moving background behind the whole app, when Settings → Video theme turns one on. */
export function VideoBackgroundLayer() {
  const settings = useClientSettings((current) => ({
    videoBackground: current.videoBackground,
    videoBackgroundFolder: current.videoBackgroundFolder,
    videoBackgroundFile: current.videoBackgroundFile,
  }));
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [listedFolder, setListedFolder] = useState<string | null>(null);
  const folder = settings.videoBackground === "file" ? settings.videoBackgroundFolder : "";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the desktop serves a folder's videos only after the app lists it this session
  useEffect(() => {
    const list = window.desktopBridge?.listVideoFolder;
    if (folder === "" || !list) return;
    let cancelled = false;
    void list(folder).then((result) => {
      if (!cancelled) setListedFolder(result.error === null ? folder : null);
    });
    return () => {
      cancelled = true;
    };
  }, [folder]);
  if (!videoBackgroundActive(settings)) return null;

  const url =
    settings.videoBackground === "file"
      ? videoFileUrl(
          window.location.origin,
          settings.videoBackgroundFolder,
          settings.videoBackgroundFile,
        )
      : null;
  // A video that cannot play falls back to the galaxy rather than a blank window.
  const playable = url !== null && url !== failedUrl && listedFolder === folder;
  const listing = url !== null && url !== failedUrl && listedFolder !== folder;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10"
      data-video-background-layer
    >
      {listing ? null : playable ? (
        <video
          key={url}
          className="size-full object-cover"
          src={url}
          autoPlay
          loop
          muted
          playsInline
          disablePictureInPicture
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <GalaxyCanvas />
      )}
    </div>
  );
}

function GalaxyCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs the canvas animation loop for as long as the galaxy is shown
  useEffect(() => {
    const canvas = canvasRef.current;
    return canvas ? startGalaxy(canvas) : undefined;
  }, []);
  return <canvas ref={canvasRef} className="size-full" data-galaxy-canvas />;
}
