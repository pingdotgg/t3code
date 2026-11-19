import {
  ENTERTAINMENT_BROWSER_PROFILE_ID,
  type EntertainmentBlockingSettings,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { BUILT_IN_FILTER_LISTS, normalizeHostEntry } from "@t3tools/shared/contentBlocking";
import { youtubeEmbedUrl } from "@t3tools/shared/entertainment";
import {
  ArrowLeftIcon,
  ArrowLeftRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  Gamepad2Icon,
  MinimizeIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ShieldCheckIcon,
  StarIcon,
  TvIcon,
  XIcon,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";

import { openUrlInPreview } from "../../browser/openFileInPreview";
import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import { cn, newMessageId } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  customSiteItem,
  ENTERTAINMENT_APPS,
  ENTERTAINMENT_GAMES,
  type EntertainmentGameId,
  type EntertainmentItem,
  moveInOrder,
  orderItems,
  searchItems,
} from "./entertainmentCatalog";
import { ENTERTAINMENT_BACKGROUNDS, useEntertainmentStore } from "./entertainmentStore";
import { CircuitClickerGame } from "./games/CircuitClickerGame";
import { MinesweeperGame } from "./games/MinesweeperGame";
import { SnakeGame } from "./games/SnakeGame";

type View =
  | { readonly type: "home" }
  | { readonly type: "game"; readonly id: EntertainmentGameId }
  | { readonly type: "settings" };

/**
 * The Entertainment Center: original games that run here, and launchers for streaming sites.
 * Sites open in the Browser panel under their own profile, so they never share cookies or storage
 * with development browsing and cannot reach project files or agent tools.
 */
export function EntertainmentPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
}) {
  const store = useEntertainmentStore();
  const [view, setView] = useState<View>(() =>
    ENTERTAINMENT_GAMES.some((game) => game.id === store.lastOpen)
      ? { type: "game", id: store.lastOpen as EntertainmentGameId }
      : { type: "home" },
  );
  const [query, setQuery] = useState("");
  const [editingOrder, setEditingOrder] = useState(false);
  const [player, setPlayer] = useState<{ embedUrl: string; mini: boolean } | null>(null);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const background =
    ENTERTAINMENT_BACKGROUNDS.find((entry) => entry.id === store.background) ??
    ENTERTAINMENT_BACKGROUNDS[0];

  const allItems: EntertainmentItem[] = orderItems(
    [...ENTERTAINMENT_GAMES, ...ENTERTAINMENT_APPS, ...store.customSites.map(customSiteItem)],
    store.order,
  );
  const findItem = (id: string) => allItems.find((item) => item.id === id);

  const openItem = async (item: EntertainmentItem) => {
    store.recordOpen(item.id);
    if (item.kind === "game") {
      store.setLastOpen(item.id);
      setView({ type: "game", id: item.id });
      return;
    }
    if (item.open === "external") {
      const api = readLocalApi();
      if (api) await api.shell.openExternal(item.url);
      else window.open(item.url, "_blank", "noopener,noreferrer");
      return;
    }
    await ensureEntertainmentProfile();
    const result = await openUrlInPreview({
      threadRef: props.threadRef,
      url: item.url,
      openPreview,
      profileId: ENTERTAINMENT_BROWSER_PROFILE_ID,
    });
    if (result._tag !== "Success") {
      toastManager.add({
        type: "error",
        title: `Couldn't open ${item.name}`,
        description: "The Browser panel is unavailable here. Opening it in your browser instead.",
      });
      window.open(item.url, "_blank", "noopener,noreferrer");
    }
  };

  const goHome = () => {
    store.setLastOpen(null);
    setView({ type: "home" });
  };

  return (
    <div
      className="relative flex h-full min-h-0 flex-col overflow-hidden text-white"
      style={{ background: background.css } as CSSProperties}
      data-entertainment-panel
    >
      <header className="flex shrink-0 items-center gap-2 border-white/10 border-b bg-black/30 px-3 py-2 backdrop-blur">
        {view.type !== "home" ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Back to Entertainment"
            onClick={goHome}
          >
            <ArrowLeftIcon />
          </Button>
        ) : (
          <TvIcon className="size-4 text-arcade-highlight" />
        )}
        <span className="font-semibold text-sm">
          {view.type === "game"
            ? (findItem(view.id)?.name ?? "Game")
            : view.type === "settings"
              ? "Entertainment settings"
              : "Entertainment"}
        </span>
        {view.type === "home" ? (
          <div className="ms-auto flex w-full max-w-56 items-center gap-1.5">
            <SearchIcon className="size-3.5 shrink-0 text-white/50" />
            <Input
              size="sm"
              placeholder="Search games and apps"
              aria-label="Search games and apps"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        ) : (
          <span className="ms-auto" />
        )}
        {view.type === "home" ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Entertainment settings"
            onClick={() => setView({ type: "settings" })}
          >
            <SettingsIcon />
          </Button>
        ) : null}
      </header>
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        key={view.type === "game" ? view.id : view.type}
      >
        <div className="entertainment-enter">
          {view.type === "game" ? (
            view.id === "snake" ? (
              <SnakeGame visible={props.visible} />
            ) : view.id === "minesweeper" ? (
              <MinesweeperGame />
            ) : (
              <CircuitClickerGame visible={props.visible} />
            )
          ) : view.type === "settings" ? (
            <EntertainmentSettings />
          ) : (
            <Home
              items={allItems}
              query={query}
              editingOrder={editingOrder}
              onToggleEditOrder={() => setEditingOrder((value) => !value)}
              onOpen={(item) => void openItem(item)}
              onPlay={(embedUrl) => setPlayer({ embedUrl, mini: false })}
            />
          )}
        </div>
      </div>
      {player ? (
        <div
          className={cn(
            "z-10 overflow-hidden border-white/15 bg-black shadow-2xl",
            player.mini ? "absolute end-3 bottom-3 w-64 rounded-lg border" : "shrink-0 border-t",
          )}
        >
          <div className="flex items-center gap-1 bg-black/80 px-2 py-1 text-xs">
            <span className="min-w-0 flex-1 truncate text-white/70">YouTube player</span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={player.mini ? "Expand player" : "Mini player"}
              onClick={() => setPlayer({ ...player, mini: !player.mini })}
            >
              {player.mini ? <ArrowLeftRightIcon /> : <MinimizeIcon />}
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Close player"
              onClick={() => setPlayer(null)}
            >
              <XIcon />
            </Button>
          </div>
          <iframe
            title="YouTube player"
            src={player.embedUrl}
            className="aspect-video w-full"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
      ) : null}
    </div>
  );
}

async function ensureEntertainmentProfile() {
  const profiles = getClientSettings().browserProfiles;
  if (profiles.some((profile) => profile.id === ENTERTAINMENT_BROWSER_PROFILE_ID)) return;
  await updateClientSettings({
    browserProfiles: [
      ...profiles,
      { id: ENTERTAINMENT_BROWSER_PROFILE_ID, name: "Entertainment", kind: "persistent" },
    ],
  });
}

function Home(props: {
  readonly items: ReadonlyArray<EntertainmentItem>;
  readonly query: string;
  readonly editingOrder: boolean;
  readonly onToggleEditOrder: () => void;
  readonly onOpen: (item: EntertainmentItem) => void;
  readonly onPlay: (embedUrl: string) => void;
}) {
  const store = useEntertainmentStore();
  const matches = searchItems(props.items, props.query);
  const favorites = matches.filter((item) => store.favorites.includes(item.id));
  const recents = store.recents
    .map((entry) => matches.find((item) => item.id === entry.id))
    .filter((item): item is EntertainmentItem => item !== undefined)
    .slice(0, 6);
  const games = matches.filter((item) => item.kind === "game");
  const apps = matches.filter((item) => item.kind === "web");
  const move = (id: string, offset: -1 | 1) =>
    store.setOrder(
      moveInOrder(
        props.items.map((item) => item.id),
        id,
        offset,
      ),
    );

  return (
    <div className="flex flex-col gap-5 p-4">
      {props.query === "" ? <YouTubeLinkBox onPlay={props.onPlay} /> : null}
      {recents.length > 0 && props.query === "" ? (
        <Shelf title="Continue">
          {recents.map((item) => (
            <Tile key={item.id} item={item} compact onOpen={props.onOpen} />
          ))}
        </Shelf>
      ) : null}
      {favorites.length > 0 ? (
        <Shelf title="Favorites">
          {favorites.map((item) => (
            <Tile key={item.id} item={item} onOpen={props.onOpen} />
          ))}
        </Shelf>
      ) : null}
      <Shelf
        title="Games"
        action={
          <Button size="xs" variant="ghost" onClick={props.onToggleEditOrder}>
            {props.editingOrder ? "Done" : "Reorder"}
          </Button>
        }
      >
        {games.map((item) => (
          <Tile
            key={item.id}
            item={item}
            onOpen={props.onOpen}
            onMove={props.editingOrder ? (offset) => move(item.id, offset) : undefined}
          />
        ))}
      </Shelf>
      <Shelf title="Watch and listen">
        {apps.map((item) => (
          <Tile
            key={item.id}
            item={item}
            onOpen={props.onOpen}
            onMove={props.editingOrder ? (offset) => move(item.id, offset) : undefined}
          />
        ))}
      </Shelf>
      {matches.length === 0 ? (
        <p className="text-center text-sm text-white/60">Nothing matches “{props.query}”.</p>
      ) : null}
      <AddSiteForm />
      <p className="text-white/50 text-xs">
        Sites open in the Browser panel with the separate Entertainment profile, so they never see
        your development browsing, project files, or agent tools. Services that need protected
        playback (DRM) open in your system browser.
      </p>
    </div>
  );
}

function Shelf(props: {
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="font-semibold text-sm text-white/90">{props.title}</h3>
        <div className="ms-auto">{props.action}</div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3">
        {props.children}
      </div>
    </section>
  );
}

function ItemLogo({ item }: { readonly item: EntertainmentItem }) {
  const [failed, setFailed] = useState(false);
  if (item.kind === "game") {
    return (
      <span
        className="flex size-10 items-center justify-center rounded-xl text-white shadow-lg"
        style={{ background: item.accent }}
      >
        <Gamepad2Icon className="size-5" />
      </span>
    );
  }
  if (item.iconUrl && !failed) {
    return (
      <span className="flex size-10 items-center justify-center rounded-xl bg-white shadow-lg">
        <img
          src={item.iconUrl}
          alt=""
          className="size-6 object-contain"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return (
    <span
      className="flex size-10 items-center justify-center rounded-xl font-bold text-lg text-white shadow-lg"
      style={{ background: item.accent }}
    >
      {item.name.slice(0, 1)}
    </span>
  );
}

function Tile(props: {
  readonly item: EntertainmentItem;
  readonly compact?: boolean;
  readonly onOpen: (item: EntertainmentItem) => void;
  readonly onMove?: ((offset: -1 | 1) => void) | undefined;
}) {
  const { item } = props;
  const favorite = useEntertainmentStore((state) => state.favorites.includes(item.id));
  const toggleFavorite = useEntertainmentStore((state) => state.toggleFavorite);
  const removeCustomSite = useEntertainmentStore((state) => state.removeCustomSite);
  return (
    <div
      className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/5 shadow-lg backdrop-blur transition-[transform,background-color,border-color] duration-200 hover:border-white/25 hover:bg-white/10 motion-safe:hover:-translate-y-0.5"
      style={{ "--tile-accent": item.accent } as CSSProperties}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-16 opacity-40 transition-opacity group-hover:opacity-70"
        style={{ background: `linear-gradient(180deg, ${item.accent}66, transparent)` }}
      />
      <button
        type="button"
        className="relative flex w-full flex-col items-start gap-2 p-3 text-start outline-none focus-visible:ring-2 focus-visible:ring-arcade-highlight focus-visible:ring-inset"
        onClick={() => props.onOpen(item)}
      >
        <ItemLogo item={item} />
        <span className="font-semibold text-sm">{item.name}</span>
        {props.compact ? null : (
          <span className="line-clamp-2 text-white/60 text-xs">{item.tagline}</span>
        )}
        {item.kind === "web" && item.open === "external" && !props.compact ? (
          <span className="flex items-center gap-1 text-2xs text-white/50">
            <ExternalLinkIcon className="size-3" /> Opens in your browser
          </span>
        ) : null}
        {item.kind === "game" && !props.compact ? (
          <span className="text-2xs text-white/45">{item.credit}</span>
        ) : null}
      </button>
      <div className="absolute end-1.5 top-1.5 flex gap-0.5">
        {props.onMove ? (
          <>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Move ${item.name} earlier`}
              onClick={() => props.onMove?.(-1)}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Move ${item.name} later`}
              onClick={() => props.onMove?.(1)}
            >
              <ChevronRightIcon />
            </Button>
          </>
        ) : null}
        {item.kind === "web" && item.custom && !props.compact ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Remove ${item.name}`}
            onClick={() => removeCustomSite(item.id)}
          >
            <XIcon />
          </Button>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={favorite ? `Unfavorite ${item.name}` : `Favorite ${item.name}`}
          aria-pressed={favorite}
          onClick={() => toggleFavorite(item.id)}
        >
          <StarIcon className={cn(favorite && "fill-arcade-gold text-arcade-gold")} />
        </Button>
      </div>
    </div>
  );
}

function YouTubeLinkBox({ onPlay }: { readonly onPlay: (embedUrl: string) => void }) {
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-1.5 rounded-xl border border-white/10 bg-black/30 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const embed = youtubeEmbedUrl(link);
        if (embed === null) {
          setError("Paste a YouTube video link, such as youtube.com/watch?v=… or youtu.be/….");
          return;
        }
        setError(null);
        setLink("");
        onPlay(embed);
      }}
    >
      <label className="font-medium text-sm" htmlFor="entertainment-youtube-link">
        Play a YouTube video here
      </label>
      <div className="flex gap-2">
        <Input
          id="entertainment-youtube-link"
          size="sm"
          value={link}
          placeholder="Paste a YouTube link"
          onChange={(event) => setLink(event.target.value)}
        />
        <Button size="sm" type="submit" disabled={!link.trim()}>
          <PlayIcon /> Play
        </Button>
      </div>
      <span className="text-white/50 text-xs">
        Uses YouTube's official privacy-enhanced player. Shrink it to a mini player while you
        browse.
      </span>
      {error ? <span className="text-arcade-danger text-xs">{error}</span> : null}
    </form>
  );
}

function AddSiteForm() {
  const addCustomSite = useEntertainmentStore((state) => state.addCustomSite);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [external, setExternal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/25 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const host = normalizeHostEntry(url);
        if (host === null) {
          setError("Enter a web address such as example.com.");
          return;
        }
        const href = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
        addCustomSite({
          id: `custom:${newMessageId()}`,
          name: name.trim() || host,
          url: href,
          open: external ? "external" : "browser",
        });
        setName("");
        setUrl("");
        setError(null);
      }}
    >
      <span className="font-medium text-sm">Add a site</span>
      <div className="flex flex-wrap gap-2">
        <Input
          size="sm"
          className="w-36"
          placeholder="Name"
          aria-label="Site name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Input
          size="sm"
          className="min-w-40 flex-1"
          placeholder="example.com"
          aria-label="Site address"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <Button size="sm" type="submit" variant="outline" disabled={!url.trim()}>
          <PlusIcon /> Add
        </Button>
      </div>
      <label className="flex items-center gap-2 text-white/70 text-xs">
        <Switch checked={external} onCheckedChange={setExternal} />
        Open in my system browser (for sites that need DRM or sign-in the panel can't do)
      </label>
      {error ? <span className="text-arcade-danger text-xs">{error}</span> : null}
    </form>
  );
}

function EntertainmentSettings() {
  const blocking = useClientSettings((settings) => settings.entertainmentBlocking);
  const background = useEntertainmentStore((state) => state.background);
  const setBackground = useEntertainmentStore((state) => state.setBackground);
  const [customHost, setCustomHost] = useState("");
  const [allowHost, setAllowHost] = useState("");
  const patch = (next: Partial<EntertainmentBlockingSettings>) =>
    void updateClientSettings({ entertainmentBlocking: { ...blocking, ...next } });
  const isDesktop = readLocalApi() !== null && window.desktopBridge !== undefined;

  return (
    <div className="flex flex-col gap-5 p-4 text-sm">
      <section className="flex flex-col gap-2">
        <h3 className="font-semibold">Background</h3>
        <div className="flex flex-wrap gap-2">
          {ENTERTAINMENT_BACKGROUNDS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={entry.id === background}
              onClick={() => setBackground(entry.id)}
              className={cn(
                "flex h-14 w-24 items-end rounded-lg border p-1.5 text-start text-xs shadow",
                entry.id === background
                  ? "border-arcade-highlight ring-2 ring-arcade-highlight/40"
                  : "border-white/15",
              )}
              style={{ background: entry.css }}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <h3 className="flex items-center gap-2 font-semibold">
          <ShieldCheckIcon className="size-4 text-arcade-safe" /> Content blocking
        </h3>
        <p className="text-white/60 text-xs">
          Blocks ad and tracker requests in the Entertainment browser profile only. Your development
          browsing and app previews are never filtered.
          {isDesktop
            ? ""
            : " Blocking runs in the desktop app; in a web browser, use your browser's own blocker."}
        </p>
        <label className="flex items-center justify-between gap-3">
          Block ads and trackers
          <Switch checked={blocking.enabled} onCheckedChange={(enabled) => patch({ enabled })} />
        </label>
        {BUILT_IN_FILTER_LISTS.map((list) => (
          <label key={list.id} className="flex items-start justify-between gap-3">
            <span>
              {list.name}
              <span className="block text-white/55 text-xs">{list.description}</span>
            </span>
            <Switch
              disabled={!blocking.enabled}
              checked={blocking.lists.includes(list.id)}
              onCheckedChange={(checked) =>
                patch({
                  lists: checked
                    ? [...blocking.lists, list.id]
                    : blocking.lists.filter((id) => id !== list.id),
                })
              }
            />
          </label>
        ))}
        <HostList
          title="Also block these hosts"
          entries={blocking.customHosts}
          value={customHost}
          onValueChange={setCustomHost}
          onAdd={(host) => patch({ customHosts: [...blocking.customHosts, host] })}
          onRemove={(host) =>
            patch({ customHosts: blocking.customHosts.filter((entry) => entry !== host) })
          }
        />
        <HostList
          title="Never block on these sites"
          description="Turn blocking off for a site that breaks with it on."
          entries={blocking.allowlist}
          value={allowHost}
          onValueChange={setAllowHost}
          onAdd={(host) => patch({ allowlist: [...blocking.allowlist, host] })}
          onRemove={(host) =>
            patch({ allowlist: blocking.allowlist.filter((entry) => entry !== host) })
          }
        />
        <p className="text-white/50 text-xs">
          Blocking can break a site's video player or sign-in; add the site above if it does. It
          never bypasses DRM, subscriptions, or sign-in.
        </p>
      </section>
    </div>
  );
}

function HostList(props: {
  readonly title: string;
  readonly description?: string;
  readonly entries: ReadonlyArray<string>;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly onAdd: (host: string) => void;
  readonly onRemove: (host: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span>{props.title}</span>
      {props.description ? (
        <span className="text-white/55 text-xs">{props.description}</span>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {props.entries.map((host) => (
          <span
            key={host}
            className="flex items-center gap-1 rounded-md bg-white/10 px-2 py-0.5 font-mono text-xs"
          >
            {host}
            <button
              type="button"
              aria-label={`Remove ${host}`}
              onClick={() => props.onRemove(host)}
            >
              <XIcon className="size-3" />
            </button>
          </span>
        ))}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const host = normalizeHostEntry(props.value);
          if (host === null || props.entries.includes(host)) return;
          props.onAdd(host);
          props.onValueChange("");
        }}
      >
        <Input
          size="sm"
          placeholder="example.com"
          aria-label={props.title}
          value={props.value}
          onChange={(event) => props.onValueChange(event.target.value)}
        />
        <Button size="sm" type="submit" variant="outline" disabled={!props.value.trim()}>
          Add
        </Button>
      </form>
    </div>
  );
}
