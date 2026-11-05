import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import { resolvePermanentPullRequestRedirect } from "./permanentRedirect.ts";

const run = (url: string) =>
  resolvePermanentPullRequestRedirect(url).pipe(
    Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
  );

const old = "http://git.sewobe.local/jobagent/manager/-/merge_requests/11122";
const destination = "https://git.sewobe.de/jobagent/manager/-/merge_requests/11122";
afterEach(() => vi.unstubAllGlobals());

function mockResponses(responses: Response[]) {
  const fetch = vi.fn();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("permanent PR/MR redirects", () => {
  it.effect.each([301, 308])("follows %s moves across origins", (status) =>
    Effect.gen(function* () {
      const fetch = mockResponses([
        new Response(null, { status, headers: { location: destination } }),
        new Response(null, { status: 200 }),
      ]);
      expect(yield* run(old)).toBe(destination);
      expect(fetch).toHaveBeenLastCalledWith(
        new URL(destination),
        expect.objectContaining({ method: "HEAD", redirect: "manual" }),
      );
    }),
  );

  it.effect("resolves relative moves and stops before a temporary sign-in redirect", () =>
    Effect.gen(function* () {
      mockResponses([
        new Response(null, {
          status: 301,
          headers: { location: "/new/manager/-/merge_requests/11122" },
        }),
        new Response(null, { status: 302, headers: { location: "/users/sign_in" } }),
      ]);
      expect(yield* run(old)).toBe("http://git.sewobe.local/new/manager/-/merge_requests/11122");
    }),
  );

  it.effect.each([302, 303, 307])("does not persist temporary %s redirects", (status) =>
    Effect.gen(function* () {
      const fetch = mockResponses([
        new Response(null, { status, headers: { location: destination } }),
      ]);
      expect(yield* run(old)).toBe(old);
      expect(fetch).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect.each([
    "/users/sign_in",
    "file:///etc/passwd",
    "https://user:password@git.sewobe.de/a/b/-/merge_requests/1",
  ])("ignores invalid targets: %s", (location) =>
    Effect.gen(function* () {
      mockResponses([new Response(null, { status: 301, headers: { location } })]);
      expect(yield* run(old)).toBe(old);
    }),
  );

  it.effect("stops redirect loops", () =>
    Effect.gen(function* () {
      const fetch = mockResponses([
        new Response(null, { status: 301, headers: { location: destination } }),
        new Response(null, { status: 308, headers: { location: old } }),
      ]);
      expect(yield* run(old)).toBe(destination);
      expect(fetch).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("keeps the stored URL on a network failure", () =>
    Effect.gen(function* () {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
      expect(yield* run(old)).toBe(old);
    }),
  );
});
