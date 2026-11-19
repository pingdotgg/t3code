/**
 * What the Entertainment Center offers. Web apps open in the Browser panel under the Entertainment
 * profile, apart from development browsing. Services that need DRM playback (Widevine), which the
 * built-in browser does not have, open in the system browser instead.
 */
export type EntertainmentGameId = "snake" | "minesweeper" | "circuit-clicker";

export type EntertainmentItem =
  | {
      readonly kind: "game";
      readonly id: EntertainmentGameId;
      readonly name: string;
      readonly tagline: string;
      /** Shown on the tile: what this is, plainly. */
      readonly credit: string;
      readonly accent: string;
    }
  | {
      readonly kind: "web";
      readonly id: string;
      readonly name: string;
      readonly tagline: string;
      readonly url: string;
      /** Where the logo comes from: the service's own icon. */
      readonly iconUrl: string | null;
      readonly accent: string;
      /** `browser`: the built-in Browser panel. `external`: the system browser (DRM). */
      readonly open: "browser" | "external";
      readonly note: string | null;
      readonly custom: boolean;
    };

export const ENTERTAINMENT_GAMES: ReadonlyArray<Extract<EntertainmentItem, { kind: "game" }>> = [
  {
    kind: "game",
    id: "snake",
    name: "Snake",
    tagline: "Eat, grow, don't bite yourself.",
    credit: "Continuum's own Snake. Google's Snake can't be embedded here.",
    accent: "#22c55e",
  },
  {
    kind: "game",
    id: "minesweeper",
    name: "Minesweeper",
    tagline: "Three difficulties, flags, chords, and best times.",
    credit: "Built into Continuum.",
    accent: "#64748b",
  },
  {
    kind: "game",
    id: "circuit-clicker",
    name: "Circuit Clicker",
    tagline: "An incremental game about making cycles.",
    credit: "Continuum's original incremental game, not Cookie Clicker.",
    accent: "#f59e0b",
  },
];

const web = (
  entry: Omit<Extract<EntertainmentItem, { kind: "web" }>, "kind" | "custom">,
): Extract<EntertainmentItem, { kind: "web" }> => ({ kind: "web", custom: false, ...entry });

export const ENTERTAINMENT_APPS: ReadonlyArray<Extract<EntertainmentItem, { kind: "web" }>> = [
  web({
    id: "youtube",
    name: "YouTube",
    tagline: "Videos, plus a player for any YouTube link.",
    url: "https://www.youtube.com/",
    iconUrl: "https://www.youtube.com/favicon.ico",
    accent: "#ff0033",
    open: "browser",
    note: null,
  }),
  web({
    id: "twitch",
    name: "Twitch",
    tagline: "Live streams.",
    url: "https://www.twitch.tv/",
    iconUrl: "https://www.twitch.tv/favicon.ico",
    accent: "#9146ff",
    open: "browser",
    note: null,
  }),
  web({
    id: "spotify",
    name: "Spotify",
    tagline: "Music and podcasts.",
    url: "https://open.spotify.com/",
    iconUrl: "https://open.spotify.com/favicon.ico",
    accent: "#1ed760",
    open: "external",
    note: "Spotify's web player needs protected playback (DRM), so it opens in your browser.",
  }),
  web({
    id: "netflix",
    name: "Netflix",
    tagline: "Films and series.",
    url: "https://www.netflix.com/",
    iconUrl: "https://www.netflix.com/favicon.ico",
    accent: "#e50914",
    open: "external",
    note: "Netflix needs protected playback (DRM), so it opens in your browser.",
  }),
  web({
    id: "disney-plus",
    name: "Disney+",
    tagline: "Disney, Pixar, Marvel, and more.",
    url: "https://www.disneyplus.com/",
    iconUrl: "https://www.disneyplus.com/favicon.ico",
    accent: "#113ccf",
    open: "external",
    note: "Disney+ needs protected playback (DRM), so it opens in your browser.",
  }),
  web({
    id: "crunchyroll",
    name: "Crunchyroll",
    tagline: "Anime.",
    url: "https://www.crunchyroll.com/",
    iconUrl: "https://www.crunchyroll.com/favicon.ico",
    accent: "#f47521",
    open: "external",
    note: "Crunchyroll needs protected playback (DRM), so it opens in your browser.",
  }),
];

export interface CustomSite {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly open: "browser" | "external";
}

export function customSiteItem(site: CustomSite): Extract<EntertainmentItem, { kind: "web" }> {
  let iconUrl: string | null = null;
  try {
    iconUrl = new URL("/favicon.ico", site.url).toString();
  } catch {
    iconUrl = null;
  }
  return {
    kind: "web",
    id: site.id,
    name: site.name,
    tagline: new URL(site.url).hostname.replace(/^www\./, ""),
    url: site.url,
    iconUrl,
    accent: "#38bdf8",
    open: site.open,
    note: null,
    custom: true,
  };
}

/** Saved order first, then anything new in catalog order. */
export function orderItems<T extends { readonly id: string }>(
  items: ReadonlyArray<T>,
  order: ReadonlyArray<string>,
): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...items].toSorted(
    (left, right) =>
      (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function searchItems<T extends EntertainmentItem>(
  items: ReadonlyArray<T>,
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...items];
  return items.filter((item) =>
    `${item.name} ${item.tagline} ${item.kind === "web" ? item.url : "game"}`
      .toLowerCase()
      .includes(needle),
  );
}

/** Moves `id` one place within `ids` (already ordered), returning the new order. */
export function moveInOrder(ids: ReadonlyArray<string>, id: string, offset: -1 | 1): string[] {
  const index = ids.indexOf(id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= ids.length) return [...ids];
  const next = [...ids];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
