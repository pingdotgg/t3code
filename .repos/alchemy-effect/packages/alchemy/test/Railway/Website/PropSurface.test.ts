import * as Railway from "@/Railway";
import { describe, expect, it } from "alchemy-test";

describe("Railway.Website prop surfaces", () => {
  const _pins = [
    () =>
      Railway.Website.Vite("V", {
        assets: { notFoundHandling: "single-page-application" },
        vite: { outDir: "build" },
      }),
    () =>
      Railway.Website.Vite("V", {
        // @ts-expect-error spa sugar replaced by assets.notFoundHandling
        spa: true,
      }),
    () =>
      Railway.Website.Waku("W", {
        waku: { srcDir: "app" },
      }),
    () =>
      Railway.Website.Waku("W", {
        // @ts-expect-error srcDir lives on the waku bag
        srcDir: "app",
      }),
    () =>
      Railway.Website.Astro("A", {
        astro: { output: "static" },
        assets: { notFoundHandling: "404-page" },
      }),
    () =>
      Railway.Website.Nuxt("N", {
        nuxt: { app: { baseURL: "/docs/" } },
      }),
    () =>
      Railway.Website.SvelteKit("S", {
        kit: { paths: { base: "/docs" } },
      }),
    () =>
      Railway.Website.SolidStart("So", {
        nitro: { prerender: { routes: ["/"] } },
      }),
    () => Railway.Website.ReactRouter("R", {}),
    () => Railway.Website.TanStackStart("T", {}),
  ];

  it("rejects dissolved 1353 props at the type level", () => {
    expect(_pins.length).toBeGreaterThan(0);
  });
});
