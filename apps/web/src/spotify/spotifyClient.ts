const CLIENT_ID = "2c365bd5560d448da8e4802b5ba43ecf";
const REDIRECT_URI = "http://127.0.0.1:8898/callback";
const SCOPES = "user-read-currently-playing user-read-playback-state user-modify-playback-state";
const STORAGE_KEY = "xencode:spotify-token";
const LEGACY_STORAGE_KEY = "xscode:spotify-token";

interface SpotifyToken {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}

export interface SpotifyNowPlaying {
  readonly isPlaying: boolean;
  readonly title: string;
  readonly artist: string;
  readonly artUrl: string | null;
}

const listeners = new Set<() => void>();
let token: SpotifyToken | null = readStoredToken();

function readStoredToken(): SpotifyToken | null {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (raw === null && legacy !== null) {
      raw = legacy;
      localStorage.setItem(STORAGE_KEY, legacy);
    }
    if (legacy !== null) localStorage.removeItem(LEGACY_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SpotifyToken) : null;
  } catch {
    return null;
  }
}

function setToken(next: SpotifyToken | null) {
  token = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable; the session still works until reload.
  }
  for (const listener of listeners) listener();
}

export function subscribeSpotifyConnection(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const isSpotifyConnected = () => token !== null;

export const isSpotifySupported = () =>
  typeof window !== "undefined" && window.desktopBridge?.receiveSpotifyAuthCallback !== undefined;

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function requestToken(body: Record<string, string>) {
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`Spotify sign-in failed (${response.status}).`), {
      rejected: response.status === 400,
    });
  }
  const json = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  setToken({
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? token?.refreshToken ?? "",
    expiresAt: Date.now() + json.expires_in * 1000,
  });
}

export async function connectSpotify() {
  const bridge = window.desktopBridge;
  if (!bridge?.receiveSpotifyAuthCallback) throw new Error("Spotify needs the desktop app.");
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
  const authorize = new URL("https://accounts.spotify.com/authorize");
  authorize.search = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: challenge,
    scope: SCOPES,
    state,
  }).toString();
  const callback = new URL(await bridge.receiveSpotifyAuthCallback(authorize.toString()));
  const code = callback.searchParams.get("code");
  if (!code)
    throw new Error(callback.searchParams.get("error") ?? "Spotify sign-in was cancelled.");
  await requestToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
}

export const disconnectSpotify = () => setToken(null);

let refreshing: Promise<void> | null = null;

// Spotify rotates refresh tokens, so concurrent refreshes would race each other into invalid_grant.
function refreshToken(current: SpotifyToken) {
  refreshing ??= requestToken({ grant_type: "refresh_token", refresh_token: current.refreshToken })
    .catch((error: unknown) => {
      if ((error as { rejected?: boolean }).rejected && token === current) setToken(null);
      throw error;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

async function accessToken(forceRefresh = false) {
  if (!token) throw new Error("Spotify is not connected.");
  if (forceRefresh || token.expiresAt - 60_000 < Date.now()) await refreshToken(token);
  return token!.accessToken;
}

async function spotifyApi(path: string, method = "GET"): Promise<unknown> {
  const send = async (forceRefresh: boolean) =>
    fetch(`https://api.spotify.com/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${await accessToken(forceRefresh)}` },
    });
  let response = await send(false);
  if (response.status === 401) response = await send(true);
  if (response.status === 403) throw new Error("Playback control needs Spotify Premium.");
  if (!response.ok) throw new Error(`Spotify request failed (${response.status}).`);
  return response.status === 204 ? null : response.json().catch(() => null);
}

interface PlaybackState {
  is_playing: boolean;
  item: {
    name: string;
    artists?: ReadonlyArray<{ name: string }>;
    show?: { name: string };
    album?: { images: ReadonlyArray<{ url: string; width: number | null }> };
    images?: ReadonlyArray<{ url: string; width: number | null }>;
  } | null;
}

export async function getSpotifyNowPlaying(): Promise<SpotifyNowPlaying | null> {
  const state = (await spotifyApi(
    "/me/player?additional_types=track,episode",
  )) as PlaybackState | null;
  if (!state?.item) return null;
  const images = state.item.album?.images ?? state.item.images ?? [];
  return {
    isPlaying: state.is_playing,
    title: state.item.name,
    artist:
      state.item.artists?.map((artist) => artist.name).join(", ") ?? state.item.show?.name ?? "",
    artUrl: images.at(-1)?.url ?? null,
  };
}

export const spotifyControl = (action: "play" | "pause" | "next" | "previous") =>
  spotifyApi(`/me/player/${action}`, action === "play" || action === "pause" ? "PUT" : "POST");
