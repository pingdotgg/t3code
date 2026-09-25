import * as Hetzner from "@/Hetzner";
import { describe, expect, it } from "alchemy-test";

describe("Hetzner.Website prop surfaces", () => {
  const _pins = [
    () =>
      Hetzner.Website.Vite("V", {
        assets: { notFoundHandling: "single-page-application" },
        vite: { outDir: "build" },
      }),
    () =>
      Hetzner.Website.Vite("V", {
        // @ts-expect-error spa sugar replaced by assets.notFoundHandling
        spa: true,
      }),
    () =>
      Hetzner.Website.Waku("W", {
        waku: { srcDir: "app" },
      }),
    () =>
      Hetzner.Website.Waku("W", {
        // @ts-expect-error srcDir lives on the waku bag
        srcDir: "app",
      }),
    () =>
      Hetzner.Website.Astro("A", {
        astro: { output: "static" },
        assets: { notFoundHandling: "404-page" },
      }),
    () =>
      Hetzner.Website.Nuxt("N", {
        nuxt: { app: { baseURL: "/docs/" } },
      }),
    () =>
      Hetzner.Website.SvelteKit("S", {
        kit: { paths: { base: "/docs" } },
      }),
  ];

  it("rejects dissolved 1353 props at the type level", () => {
    expect(_pins.length).toBeGreaterThan(0);
  });
});
