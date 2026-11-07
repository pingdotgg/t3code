// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Tests exercise the real native loopback page.
import * as NodeHttp from "node:http";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { openPendingSignInPage, settlePendingSignInPage } from "./PendingSignInPage.ts";

const googleLink =
  "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=test-state";

const opened: string[] = [];
const ids: string[] = [];

async function open(lifetimeMs?: number, settledLifetimeMs?: number) {
  const id = await openPendingSignInPage(
    async (url) => {
      opened.push(url);
      return true;
    },
    lifetimeMs,
    settledLifetimeMs,
  );
  ids.push(id);
  return { id, url: opened.at(-1)! };
}

const get = (url: string) => fetch(url, { redirect: "manual" });
const statusWithHost = (url: string, host: string) =>
  new Promise<number | undefined>((resolve, reject) => {
    NodeHttp.get(url, { headers: { host } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });

describe("pending sign-in page", () => {
  afterEach(() => {
    // Settling with a zero lifetime closes each page immediately.
    for (const id of ids.splice(0)) settlePendingSignInPage(id, null, 0);
    opened.length = 0;
  });

  it("opens the browser on a private loopback page that waits for the link", async () => {
    const { id, url } = await open();
    expect(url).toBe(`${new URL(url).origin}/${id}`);
    expect(new URL(url).hostname).toBe("127.0.0.1");

    const waiting = await get(url);
    expect(waiting.status).toBe(200);
    const html = await waiting.text();
    expect(html).toContain("Starting sign-in");
    expect(html).toContain('http-equiv="refresh"');

    expect((await get(`${new URL(url).origin}/wrong-token`)).status).toBe(404);
    expect(await statusWithHost(url, `rebound.example:${new URL(url).port}`)).toBe(404);
  });

  it("forwards to the Google link once it is supplied", async () => {
    const { id, url } = await open();
    settlePendingSignInPage(id, googleLink);
    const forwarded = await get(url);
    expect(forwarded.status).toBe(303);
    expect(forwarded.headers.get("location")).toBe(googleLink);
  });

  it("refuses links that are not Google sign-in", async () => {
    const { id, url } = await open();
    for (const link of [
      "https://example.com/o/oauth2/v2/auth",
      "https://accounts.google.com/elsewhere",
      "http://accounts.google.com/o/oauth2/v2/auth",
      "not a url",
    ]) {
      expect(() => settlePendingSignInPage(id, link)).toThrow();
    }
    expect((await get(url)).status).toBe(200);
  });

  it("shows that sign-in stopped without refreshing", async () => {
    const { id, url } = await open();
    settlePendingSignInPage(id, null);
    const stopped = await get(url);
    expect(stopped.status).toBe(200);
    const html = await stopped.text();
    expect(html).toContain("Sign-in stopped");
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it("shows that sign-in stopped when the page expires, then closes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { url } = await open(1_000, 500);
      vi.advanceTimersByTime(1_000);
      expect(await (await get(url)).text()).toContain("Sign-in stopped");
      vi.advanceTimersByTime(500);
      await expect(get(url)).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards to the normalized link", async () => {
    const { id, url } = await open();
    settlePendingSignInPage(
      id,
      `${googleLink}
`,
    );
    const forwarded = await get(url);
    expect(forwarded.status).toBe(303);
    expect(forwarded.headers.get("location")).toBe(googleLink);
  });

  it("caps concurrently opening pages", async () => {
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => open()));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(4);
    expect(results.find((result) => result.status === "rejected")?.reason).toMatchObject({
      message: "Too many sign-in pages are open.",
    });
  });

  it("closes the listener when opening the browser throws", async () => {
    let url = "";
    await expect(
      openPendingSignInPage((target) => {
        url = target;
        throw new Error("no shell");
      }),
    ).rejects.toThrow("Could not open your browser.");
    await expect(get(url)).rejects.toThrow();
  });

  it("closes the listener when the browser cannot be opened", async () => {
    let url = "";
    await expect(
      openPendingSignInPage(async (target) => {
        url = target;
        return false;
      }),
    ).rejects.toThrow("Could not open your browser.");
    await expect(get(url)).rejects.toThrow();
  });
});
