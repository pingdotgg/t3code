import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { fetchGithubStars } from "./githubStars";

const fetchMock = vi.fn<typeof fetch>();
let cache = new Map<string, string>();
const cacheKey = "t3code-github-stars";

beforeEach(() => {
  cache = new Map();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => cache.set(key, value),
  });
  vi.spyOn(Date, "now").mockReturnValue(10_000_000);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchGithubStars", () => {
  it("uses GitHub's current count and reuses it across page loads", async () => {
    fetchMock.mockResolvedValue(Response.json({ stargazers_count: 26239 }));
    expect(await fetchGithubStars()).toBe(26239);
    expect(await fetchGithubStars()).toBe(26239);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/pingdotgg/t3code");
  });

  it("refreshes a count once the two-hour cache expires", async () => {
    cache.set(cacheKey, JSON.stringify({ count: 24000, fetchedAt: 2_800_000 }));
    fetchMock.mockResolvedValue(Response.json({ stargazers_count: 26239 }));
    expect(await fetchGithubStars()).toBe(26239);
    expect(JSON.parse(cache.get(cacheKey)!)).toEqual({ count: 26239, fetchedAt: 10_000_000 });
  });

  it("ignores corrupt and future-dated cache entries", async () => {
    cache.set(cacheKey, "broken JSON");
    fetchMock.mockImplementation(async () => Response.json({ stargazers_count: 42 }));
    expect(await fetchGithubStars()).toBe(42);
    cache.set(cacheKey, JSON.stringify({ count: 99, fetchedAt: 10_000_001 }));
    expect(await fetchGithubStars()).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("works when browser storage is unavailable", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("Storage disabled");
      },
      setItem: () => {
        throw new Error("Storage disabled");
      },
    });
    fetchMock.mockResolvedValue(Response.json({ stargazers_count: 42 }));
    expect(await fetchGithubStars()).toBe(42);
  });

  it("does not present an expired count when GitHub rate-limits the request", async () => {
    cache.set(cacheKey, JSON.stringify({ count: 24000, fetchedAt: 0 }));
    fetchMock.mockResolvedValue(
      Response.json({ message: "API rate limit exceeded" }, { status: 403 }),
    );
    expect(await fetchGithubStars()).toBeUndefined();
  });

  it("handles network failures and timeouts", async () => {
    fetchMock.mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    expect(await fetchGithubStars()).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it.each([undefined, null, "26239", -1, 1.5])("rejects an invalid count: %s", async (count) => {
    fetchMock.mockResolvedValue(Response.json({ stargazers_count: count }));
    expect(await fetchGithubStars()).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("accepts zero stars", async () => {
    fetchMock.mockResolvedValue(Response.json({ stargazers_count: 0 }));
    expect(await fetchGithubStars()).toBe(0);
  });
});
