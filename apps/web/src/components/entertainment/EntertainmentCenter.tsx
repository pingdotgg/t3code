import {
  ENTERTAINMENT_PARTITION,
  ENTERTAINMENT_SERVICES,
  normalizeEntertainmentUrl,
  shouldOpenExternally,
  youtubeEmbedUrl,
} from "@t3tools/shared/entertainment";
import {
  ArrowLeftToLineIcon,
  ArrowRightToLineIcon,
  ChevronDownIcon,
  HouseIcon,
  StarIcon,
  XIcon,
} from "lucide-react";
import { type PointerEvent, useRef, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ENTERTAINMENT_GAMES, gameDocument } from "./entertainmentGames";
import {
  ENTERTAINMENT_MAX_WIDTH,
  ENTERTAINMENT_MIN_WIDTH,
  useEntertainmentStore,
} from "./entertainmentStore";

type Selection =
  | {
      readonly kind: "media";
      readonly title: string;
      readonly url: string;
      readonly isYouTube: boolean;
    }
  | { readonly kind: "game"; readonly game: (typeof ENTERTAINMENT_GAMES)[number] };

export function EntertainmentCenter({ dock }: { readonly dock: "left" | "right" }) {
  const width = useEntertainmentStore((state) => state.width);
  const favorites = useEntertainmentStore((state) => state.favorites);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<{ readonly startX: number; readonly width: number } | null>(null);
  const desktop = Boolean(window.desktopBridge);
  const currentUrl = selection?.kind === "media" ? selection.url : null;
  const isFavorite =
    currentUrl !== null && favorites.some((favorite) => favorite.url === currentUrl);

  const resize = (next: number) => useEntertainmentStore.getState().resize(next);
  const resizePointer = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !panel.current) return;
    const delta = (event.clientX - drag.current.startX) * (dock === "left" ? 1 : -1);
    const pixels = Math.min(
      ENTERTAINMENT_MAX_WIDTH,
      Math.max(ENTERTAINMENT_MIN_WIDTH, drag.current.width + delta),
    );
    panel.current.style.inlineSize = `${pixels}px`;
  };
  const endDrag = () => {
    if (drag.current && panel.current) {
      resize(Number.parseFloat(panel.current.style.inlineSize) || width);
      drag.current = null;
      panel.current.style.removeProperty("inline-size");
    }
  };
  const openExternal = async (url: string) => {
    setError(null);
    try {
      await ensureLocalApi().shell.openExternal(url);
    } catch {
      setError("Could not open the browser.");
    }
  };
  const play = (url: string, title: string, external = false) => {
    setError(null);
    const embed = youtubeEmbedUrl(url);
    if (external || shouldOpenExternally(url) || (!desktop && embed === null)) {
      void openExternal(url);
      return;
    }
    setSelection({ kind: "media", url: embed ?? url, title, isYouTube: embed !== null });
  };
  const toggleFavorite = () => {
    if (selection?.kind !== "media") return;
    const store = useEntertainmentStore.getState();
    if (isFavorite) store.removeFavorite(selection.url);
    else store.addFavorite({ url: selection.url, title: selection.title });
  };
  return (
    <aside
      aria-label="Entertainment Center"
      ref={panel}
      className={`relative z-10 flex h-dvh max-w-[min(55vw,100%)] shrink-0 flex-col border-x bg-background max-sm:absolute max-sm:inset-0 max-sm:z-[55] max-sm:w-full! max-sm:max-w-full ${dock === "right" ? "order-last" : ""}`}
      style={{ width }}
    >
      <div
        className={`absolute top-0 bottom-0 z-20 w-2 cursor-col-resize touch-none focus-visible:bg-primary/25 max-sm:hidden ${dock === "left" ? "-end-1" : "-start-1"}`}
        role="separator"
        aria-label="Resize Entertainment Center"
        aria-orientation="vertical"
        aria-valuemin={ENTERTAINMENT_MIN_WIDTH}
        aria-valuemax={ENTERTAINMENT_MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            startX: event.clientX,
            width: panel.current?.getBoundingClientRect().width ?? width,
          };
        }}
        onPointerMove={resizePointer}
        onLostPointerCapture={endDrag}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const direction = event.key === "ArrowRight" ? 1 : -1;
          resize(width + (dock === "left" ? direction : -direction) * 24);
        }}
      />
      <div className="flex min-h-12 shrink-0 items-center gap-1 border-b px-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">Entertainment Center</h2>
        {selection ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Entertainment home"
            onClick={() => setSelection(null)}
          >
            <HouseIcon />
          </Button>
        ) : null}
        {currentUrl ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={isFavorite ? "Remove from favorites" : "Save to favorites"}
            aria-pressed={isFavorite}
            onClick={toggleFavorite}
          >
            <StarIcon />
          </Button>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={dock === "left" ? "Dock on right" : "Dock on left"}
          onClick={() =>
            useEntertainmentStore.getState().setDock(dock === "left" ? "right" : "left")
          }
        >
          {dock === "left" ? <ArrowRightToLineIcon /> : <ArrowLeftToLineIcon />}
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Collapse Entertainment Center"
          onClick={() => useEntertainmentStore.getState().toggle()}
        >
          <ChevronDownIcon />
        </Button>
      </div>
      {selection?.kind === "game" ? (
        <iframe
          title={selection.game.title}
          className="min-h-0 w-full flex-1"
          sandbox="allow-scripts"
          srcDoc={gameDocument(selection.game)}
        />
      ) : selection?.kind === "media" ? (
        <>
          <div className="flex items-center justify-between gap-2 border-b px-2 py-1">
            <span className="min-w-0 truncate text-xs">{selection.title}</span>
            <Button size="xs" variant="ghost" onClick={() => void openExternal(selection.url)}>
              Open in browser
            </Button>
          </div>
          {desktop ? (
            <webview
              key={selection.url}
              className="min-h-0 w-full flex-1"
              src={selection.url}
              partition={ENTERTAINMENT_PARTITION}
            />
          ) : selection.isYouTube ? (
            <iframe
              title={selection.title}
              className="min-h-0 w-full flex-1"
              src={selection.url}
              sandbox="allow-scripts allow-same-origin allow-presentation"
              allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
              allowFullScreen
            />
          ) : null}
        </>
      ) : (
        <div className="min-h-0 flex-1 space-y-5 overflow-auto p-3 text-sm">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const url = normalizeEntertainmentUrl(input);
              if (url === null) {
                setError("Enter a site address or a YouTube video link.");
                return;
              }
              play(url, youtubeEmbedUrl(url) ? "YouTube video" : new URL(url).hostname);
            }}
          >
            <Input
              aria-label="Site or YouTube video URL"
              placeholder="Site or YouTube video URL"
              value={input}
              onChange={(event) => setInput(event.currentTarget.value)}
            />
            <Button size="sm" type="submit" disabled={!input.trim()}>
              Open
            </Button>
          </form>
          {favorites.length > 0 ? (
            <section aria-label="Favorites" className="space-y-2">
              <h3 className="font-medium">Favorites</h3>
              {favorites.map((favorite) => (
                <div key={favorite.url} className="flex items-center justify-between gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => play(favorite.url, favorite.title)}
                  >
                    {favorite.title}
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${favorite.title} from favorites`}
                    onClick={() => useEntertainmentStore.getState().removeFavorite(favorite.url)}
                  >
                    <XIcon />
                  </Button>
                </div>
              ))}
            </section>
          ) : null}
          <section aria-label="Media services" className="space-y-2">
            <h3 className="font-medium">Media</h3>
            <div className="grid grid-cols-2 gap-2">
              {ENTERTAINMENT_SERVICES.map((service) => (
                <button
                  type="button"
                  className="rounded-md border p-2 text-start hover:bg-accent"
                  key={service.id}
                  onClick={() => play(service.url, service.title, service.playback === "external")}
                >
                  <span className="block font-medium">{service.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {service.playback === "external" || !desktop
                      ? "Opens in browser"
                      : "Plays here"}
                  </span>
                </button>
              ))}
            </div>
          </section>
          <section aria-label="Games" className="space-y-2">
            <h3 className="font-medium">Games</h3>
            <div className="space-y-2">
              {ENTERTAINMENT_GAMES.map((game) => (
                <button
                  type="button"
                  className="block w-full rounded-md border p-2 text-start hover:bg-accent"
                  key={game.id}
                  onClick={() => setSelection({ kind: "game", game })}
                >
                  <span className="block font-medium">{game.title}</span>
                  <span className="text-xs text-muted-foreground">{game.description}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
      {error ? (
        <p className="px-3 py-1 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
