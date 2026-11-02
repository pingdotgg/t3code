import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { fetchGitHubStars } from "./githubStars";

const FALLBACK = "38.9k";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fetchGitHubStars", () => {
  it("rejects a failed production lookup instead of publishing a fallback", async () => {
    vi.stubEnv("PROD", true);
    vi.stubGlobal("fetch", async () => new Response(null, { status: 403 }));

    await expect(fetchGitHubStars()).rejects.toThrow("Could not fetch GitHub stars");
  });

  it.each([
    [999, "999"],
    [38_947, "38.9k"],
    [40_199, "40.1k"],
    [39_000, "39k"],
    [120_000, "120k"],
  ])("formats %i stars as %s", async (count, expected) => {
    vi.stubGlobal("fetch", async () => Response.json({ stargazers_count: count }));

    await expect(fetchGitHubStars()).resolves.toBe(expected);
  });

  it.each<[string, () => Promise<Response>]>([
    [
      "a rate limit response",
      async () => Response.json({ message: "API rate limit exceeded" }, { status: 403 }),
    ],
    ["a response without a count", async () => Response.json({})],
    [
      "a network failure",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("falls back after %s", async (_name, fetchStub) => {
    vi.stubGlobal("fetch", fetchStub);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(fetchGitHubStars()).resolves.toBe(FALLBACK);
  });
});
