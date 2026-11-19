/**
 * The Entertainment Center's browser profile and URL rules. Desktop gives this partition its own
 * cookies and storage, no preload, and no access to Continuum's IPC, files, or agent tools.
 */
export const ENTERTAINMENT_PARTITION = "persist:continuum-entertainment";

export type EntertainmentPlayback =
  /** Runs in the isolated webview. */
  | "embedded"
  /** Needs DRM or a sign-in Google/Netflix refuse in embedded browsers: opens the default browser. */
  | "external";

export interface EntertainmentService {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly playback: EntertainmentPlayback;
  /** Shown on the tile so the behavior is clear before clicking. */
  readonly note: string;
  readonly accent: string;
}

export const ENTERTAINMENT_SERVICES: ReadonlyArray<EntertainmentService> = [
  {
    id: "youtube",
    title: "YouTube",
    url: "https://www.youtube.com/",
    playback: "embedded",
    note: "Plays here. Paste a video link to use the official embed. Signing in opens your browser.",
    accent: "#e5484d",
  },
  {
    id: "netflix",
    title: "Netflix",
    url: "https://www.netflix.com/",
    playback: "external",
    note: "Opens in your browser: Netflix needs DRM playback this app does not include.",
    accent: "#b42318",
  },
  {
    id: "twitch",
    title: "Twitch",
    url: "https://www.twitch.tv/",
    playback: "embedded",
    note: "Plays here without signing in.",
    accent: "#8e4ec6",
  },
  {
    id: "spotify",
    title: "Spotify",
    url: "https://open.spotify.com/",
    playback: "external",
    note: "Opens in your browser: the web player needs DRM.",
    accent: "#1db954",
  },
  {
    id: "disney-plus",
    title: "Disney+",
    url: "https://www.disneyplus.com/",
    playback: "external",
    note: "Opens in your browser: needs DRM playback.",
    accent: "#3b5bdb",
  },
  {
    id: "prime-video",
    title: "Prime Video",
    url: "https://www.primevideo.com/",
    playback: "external",
    note: "Opens in your browser: needs DRM playback.",
    accent: "#1f8fff",
  },
];

/** Hosts whose sign-in pages refuse embedded browsers; navigating there hands off to the OS browser. */
const EXTERNAL_SIGN_IN_HOSTS = ["accounts.google.com", "www.netflix.com", "accounts.spotify.com"];

export function shouldOpenExternally(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return true;
    return EXTERNAL_SIGN_IN_HOSTS.includes(parsed.hostname);
  } catch {
    return true;
  }
}

/** A YouTube watch, share, or shorts link as the official privacy-enhanced embed URL. */
export function youtubeEmbedUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0] ?? null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const match = /^\/(?:embed|shorts|live)\/([^/?#]+)/.exec(url.pathname);
      id = match?.[1] ?? null;
    }
  }
  if (id === null || !/^[A-Za-z0-9_-]{6,20}$/.test(id)) return null;
  const start = Number(url.searchParams.get("t")?.replace(/s$/, "") ?? url.searchParams.get("start") ?? "");
  const params = new URLSearchParams({ autoplay: "1", rel: "0" });
  if (Number.isFinite(start) && start > 0) params.set("start", String(Math.floor(start)));
  return `https://www.youtube-nocookie.com/embed/${id}?${params.toString()}`;
}

/** Normalizes a site the user adds; null when it is not an http(s) address. */
export function normalizeEntertainmentUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}
