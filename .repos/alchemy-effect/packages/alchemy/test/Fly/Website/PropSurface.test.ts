import * as Fly from "@/Fly";
import { describe, expect, it } from "alchemy-test";

/**
 * Compile-time pins for Fly.Website prop surfaces. Fail the build if
 * dissolved 1353 bags sneak back in as flat keys, or if `spa`/`errorPage`
 * sugar returns.
 */
describe(
  "Fly.Website prop surfaces",
  { tags: ["unit", "provider:fly", "provider:fly:website", "local"] },
  () => {
    const _pins = [
      () =>
        Fly.Website.Vinext("Vinext", {
          rootDir: "./app",
          env: { GREETING: "Hello" },
          memo: { lockfile: true },
          assets: { notFoundHandling: "404-page" },
          dev: {},
          domain: "app.example.com",
        }),
      () =>
        Fly.Website.Vite("V", {
          deploy: { strategy: "bluegreen", healthTimeout: "90 seconds" },
          shutdown: { timeout: "30 seconds" },
          checks: { ready: { type: "http", port: 3000, path: "/health" } },
          services: [],
          assets: { notFoundHandling: "single-page-application" },
          vite: { outDir: "build", base: "/docs/" },
        }),
      () =>
        Fly.Website.Vite("V", {
          // @ts-expect-error spa sugar replaced by assets.notFoundHandling
          spa: true,
        }),
      () =>
        Fly.Website.Vite("V", {
          // @ts-expect-error outDir lives on the vite bag
          outDir: "build",
        }),
      () =>
        Fly.Website.Waku("W", {
          waku: { srcDir: "app", distDir: "build", basePath: "/docs/" },
        }),
      () =>
        Fly.Website.Waku("W", {
          // @ts-expect-error srcDir lives on the waku bag
          srcDir: "app",
        }),
      () =>
        Fly.Website.Astro("A", {
          astro: { output: "static" },
          assets: { notFoundHandling: "404-page" },
        }),
      () =>
        Fly.Website.Astro("A", {
          // @ts-expect-error spa sugar replaced by assets.notFoundHandling
          spa: true,
        }),
      () =>
        Fly.Website.Nuxt("N", {
          nuxt: { app: { baseURL: "/docs/" } },
        }),
      () =>
        Fly.Website.SvelteKit("S", {
          kit: { paths: { base: "/docs" } },
          deploy: { strategy: "bluegreen", healthTimeout: "90 seconds" },
          shutdown: { signal: "SIGINT", timeout: "60 seconds" },
          checks: { ready: { type: "http", port: 3000, path: "/ready" } },
          services: [],
        }),
      () =>
        Fly.Website.Nextjs("N", {
          deploy: { strategy: "rolling" },
          shutdown: { signal: "SIGTERM", timeout: "10 seconds" },
          checks: { ready: { type: "http", port: 3000, path: "/ready" } },
          services: [],
        }),
      () =>
        Fly.Website.SolidStart("So", {
          nitro: { prerender: { routes: ["/"] } },
        }),
      () => Fly.Website.ReactRouter("R", {}),
      () => Fly.Website.TanStackStart("T", {}),
      () =>
        Fly.Website.Foldkit("F", {
          assets: { notFoundHandling: "404-page" },
        }),
      () =>
        Fly.Website.StaticSite("St", {
          build: { command: "hugo --minify", output: "public" },
          deploy: { strategy: "bluegreen" },
          shutdown: { signal: "SIGTERM" },
          checks: { ready: { type: "tcp", port: 3000 } },
          services: [],
          assets: { notFoundHandling: "single-page-application" },
        }),
      () =>
        Fly.Website.StaticSite("St", {
          build: { command: "npm run build", output: "dist" },
          // @ts-expect-error command is nested under build
          command: "npm run build",
        }),
    ];

    it("rejects dissolved 1353 props at the type level", () => {
      expect(_pins.length).toBeGreaterThan(0);
    });
  },
);
