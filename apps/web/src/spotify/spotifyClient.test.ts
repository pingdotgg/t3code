import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const STORAGE_KEY = "xencode:spotify-token";
const FAR_FUTURE = Number.MAX_SAFE_INTEGER;

function setup(stored: Record<string, string>, responses: Array<Response | Error>) {
  const values = new Map(Object.entries(stored));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next || next instanceof Error) throw next ?? new Error("unexpected fetch");
    return next;
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  return { values, fetchMock, client: import("./spotifyClient") };
}

const token = (expiresAt: number) =>
  JSON.stringify({ accessToken: "old", refreshToken: "refresh-1", expiresAt });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const refreshed = () => json({ access_token: "new", expires_in: 3600 });
const playback = () => json({ is_playing: true, item: { name: "Song", artists: [] } });

describe("spotifyClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("migrates the legacy storage key", async () => {
    const { values, client } = setup({ "xscode:spotify-token": token(FAR_FUTURE) }, []);
    expect((await client).isSpotifyConnected()).toBe(true);
    expect(values.get(STORAGE_KEY)).toBe(token(FAR_FUTURE));
    expect(values.has("xscode:spotify-token")).toBe(false);
  });

  it("refreshes an expired stored token and keeps the refresh token Spotify omitted", async () => {
    const { values, fetchMock, client } = setup({ [STORAGE_KEY]: token(0) }, [
      refreshed(),
      playback(),
    ]);
    expect((await (await client).getSpotifyNowPlaying())?.title).toBe("Song");
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain("refresh_token=refresh-1");
    expect(JSON.parse(values.get(STORAGE_KEY)!)).toMatchObject({
      accessToken: "new",
      refreshToken: "refresh-1",
    });
  });

  it.each([
    ["a network error", new Error("offline")],
    ["a server error", json({}, 503)],
  ])("keeps the session after %s during refresh", async (_, failure) => {
    const { values, client } = setup({ [STORAGE_KEY]: token(0) }, [failure]);
    const spotify = await client;
    await expect(spotify.getSpotifyNowPlaying()).rejects.toThrow();
    expect(spotify.isSpotifyConnected()).toBe(true);
    expect(values.has(STORAGE_KEY)).toBe(true);
  });

  it("clears the session when Spotify rejects the refresh token", async () => {
    const { values, client } = setup({ [STORAGE_KEY]: token(0) }, [
      json({ error: "invalid_grant" }, 400),
    ]);
    const spotify = await client;
    await expect(spotify.getSpotifyNowPlaying()).rejects.toThrow();
    expect(spotify.isSpotifyConnected()).toBe(false);
    expect(values.has(STORAGE_KEY)).toBe(false);
  });

  it("refreshes once and retries after a 401 from the player API", async () => {
    const { fetchMock, client } = setup({ [STORAGE_KEY]: token(FAR_FUTURE) }, [
      json({}, 401),
      refreshed(),
      playback(),
    ]);
    const spotify = await client;
    expect((await spotify.getSpotifyNowPlaying())?.title).toBe("Song");
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toEqual({ authorization: "Bearer new" });
    expect(spotify.isSpotifyConnected()).toBe(true);
  });

  it("shares one refresh between concurrent requests", async () => {
    const { fetchMock, client } = setup({ [STORAGE_KEY]: token(0) }, [
      refreshed(),
      playback(),
      playback(),
    ]);
    const spotify = await client;
    await Promise.all([spotify.getSpotifyNowPlaying(), spotify.getSpotifyNowPlaying()]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
