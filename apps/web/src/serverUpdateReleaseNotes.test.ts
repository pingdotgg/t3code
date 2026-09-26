import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { loadServerUpdateReleaseNotes } from "./serverUpdateReleaseNotes";

function stubFetch(...responses: ReadonlyArray<Response>) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("loadServerUpdateReleaseNotes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the target release once and groups its changes", async () => {
    const fetch = stubFetch(
      Response.json({ body: "## What's Changed\n* fix: second\n* feat: first\n" }),
    );

    const notes = await loadServerUpdateReleaseNotes("0.0.43");
    const again = await loadServerUpdateReleaseNotes("0.0.43");

    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://api.github.com/repos/pingdotgg/t3code/releases/tags/v0.0.43",
    );
    expect(notes).toEqual([
      { version: "0.0.43", items: ["feat: first", "fix: second"], totalItems: 2 },
    ]);
    expect(again).toBe(notes);
  });

  it("resolves empty when GitHub fails and asks again next time", async () => {
    const fetch = stubFetch(
      new Response(null, { status: 403 }),
      Response.json({ body: "* fix: retried" }),
    );

    expect(await loadServerUpdateReleaseNotes("0.0.44")).toEqual([]);
    expect(await loadServerUpdateReleaseNotes("0.0.44")).toEqual([
      { version: "0.0.44", items: ["fix: retried"], totalItems: 1 },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
