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
  const start = Number(
    url.searchParams.get("t")?.replace(/s$/, "") ?? url.searchParams.get("start") ?? "",
  );
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
