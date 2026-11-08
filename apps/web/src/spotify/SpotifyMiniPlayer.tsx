import { LogOutIcon, PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import {
  connectSpotify,
  disconnectSpotify,
  getSpotifyNowPlaying,
  isSpotifyConnected,
  isSpotifySupported,
  spotifyControl,
  subscribeSpotifyConnection,
  type SpotifyNowPlaying,
} from "./spotifyClient";

const POLL_MS = 5_000;

function reportError(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : undefined,
  });
}

export function SpotifyMiniPlayer() {
  const connected = useSyncExternalStore(subscribeSpotifyConnection, isSpotifyConnected);
  const [nowPlaying, setNowPlaying] = useState<SpotifyNowPlaying | null>(null);
  const [connecting, setConnecting] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls Spotify's playback state, an external system, while the window is visible
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      getSpotifyNowPlaying().then(
        (next) => !cancelled && setNowPlaying(next),
        () => !cancelled && setNowPlaying(null),
      );
    };
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [connected]);

  if (!isSpotifySupported()) return null;

  if (!connected) {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled={connecting}
        onClick={() => {
          setConnecting(true);
          connectSpotify()
            .catch((error: unknown) => reportError("Could not connect Spotify", error))
            .finally(() => setConnecting(false));
        }}
      >
        <SpotifyGlyph />
        {connecting ? "Waiting for Spotify…" : "Connect Spotify"}
      </Button>
    );
  }

  const control = (action: "play" | "pause" | "next" | "previous") => {
    if (nowPlaying && (action === "play" || action === "pause")) {
      setNowPlaying({ ...nowPlaying, isPlaying: action === "play" });
    }
    spotifyControl(action)
      .then(() => getSpotifyNowPlaying())
      .then(setNowPlaying)
      .catch((error: unknown) => reportError("Spotify", error));
  };

  return (
    <div className="group/spotify flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1">
      {nowPlaying?.artUrl ? (
        <img src={nowPlaying.artUrl} alt="" className="size-8 shrink-0 rounded-sm object-cover" />
      ) : (
        <span className="grid size-8 shrink-0 place-items-center rounded-sm bg-sidebar-row-hover">
          <SpotifyGlyph />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-sidebar-foreground">
          {nowPlaying?.title ?? "Nothing playing"}
        </p>
        <p className="truncate text-xs text-sidebar-muted-foreground">
          {nowPlaying?.artist ?? "Spotify"}
        </p>
      </div>
      {nowPlaying ? (
        <div className="flex shrink-0 items-center">
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Previous"
            onClick={() => control("previous")}
          >
            <SkipBackIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={nowPlaying.isPlaying ? "Pause" : "Play"}
            onClick={() => control(nowPlaying.isPlaying ? "pause" : "play")}
          >
            {nowPlaying.isPlaying ? <PauseIcon /> : <PlayIcon />}
          </Button>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Next"
            onClick={() => control("next")}
          >
            <SkipForwardIcon />
          </Button>
        </div>
      ) : null}
      <span className="hidden group-hover/spotify:flex">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Disconnect Spotify"
          title="Disconnect Spotify"
          onClick={() => {
            disconnectSpotify();
            setNowPlaying(null);
          }}
        >
          <LogOutIcon />
        </Button>
      </span>
    </div>
  );
}

function SpotifyGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4 shrink-0 fill-spotify">
      <path d="M12 0a12 12 0 1 0 0 24 12 12 0 0 0 0-24Zm5.5 17.3a.75.75 0 0 1-1 .25c-2.9-1.77-6.5-2.17-10.8-1.2a.75.75 0 1 1-.33-1.46c4.67-1.07 8.68-.6 11.88 1.36.35.22.46.68.25 1.05Zm1.47-3.27a.94.94 0 0 1-1.29.3c-3.3-2.03-8.35-2.62-12.26-1.43a.94.94 0 1 1-.55-1.8c4.47-1.35 10.02-.7 13.8 1.64.44.27.58.85.3 1.29Zm.13-3.4C15.15 8.3 8.6 8.08 4.8 9.23a1.13 1.13 0 1 1-.65-2.16c4.36-1.32 11.62-1.07 16.2 1.65a1.13 1.13 0 0 1-1.15 1.94Z" />
    </svg>
  );
}
