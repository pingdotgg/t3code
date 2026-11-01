import * as GCP from "@/GCP";
import { describe, expect, it } from "alchemy-test";

/**
 * Compile-time pins for GCP.Website prop surfaces: the shared Cloud Run
 * knobs, framework option bags, and props that other providers carry but
 * GCP deliberately omits (`domain`, `app`, Fly deploy policies).
 */
describe(
  "GCP.Website prop surfaces",
  { tags: ["unit", "provider:gcp", "provider:gcp:website", "local"] },
  () => {
    const _pins = [
      () =>
        GCP.Website.Vinext("Vinext", {
          rootDir: "./app",
          env: { GREETING: "Hello" },
          memo: { lockfile: true },
          assets: { notFoundHandling: "404-page" },
          dev: {},
        }),
      () =>
        GCP.Website.Vite("V", {
          public: false,
          ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY",
          scaling: { minInstanceCount: 1, maxInstanceCount: 3 },
          resources: { limits: { cpu: "1", memory: "1Gi" } },
          timeout: "60s",
          maxInstanceRequestConcurrency: 40,
          serviceAccount: "site@project.iam.gserviceaccount.com",
          tags: { team: "web" },
          assets: { notFoundHandling: "single-page-application" },
          vite: { outDir: "build", base: "/docs/" },
        }),
      () =>
        GCP.Website.Vite("V", {
          // @ts-expect-error spa sugar replaced by assets.notFoundHandling
          spa: true,
        }),
      () =>
        GCP.Website.Vite("V", {
          // @ts-expect-error outDir lives on the vite bag
          outDir: "build",
        }),
      () =>
        GCP.Website.Astro("A", {
          // @ts-expect-error no Cloud Run domain-mapping resource yet
          domain: "app.example.com",
        }),
      () =>
        GCP.Website.Nextjs("N", {
          // @ts-expect-error Fly deploy policies do not apply to Cloud Run
          deploy: { strategy: "rolling" },
        }),
      () =>
        GCP.Website.Waku("W", {
          waku: { srcDir: "app", distDir: "build", basePath: "/docs/" },
        }),
      () =>
        GCP.Website.Astro("A", {
          astro: { output: "static" },
          assets: { notFoundHandling: "404-page" },
        }),
      () =>
        GCP.Website.Nuxt("N", {
          nuxt: { app: { baseURL: "/docs/" } },
        }),
      () =>
        GCP.Website.SvelteKit("S", {
          kit: { paths: { base: "/docs" } },
        }),
      () =>
        GCP.Website.SolidStart("So", {
          nitro: { prerender: { routes: ["/"] } },
        }),
      () => GCP.Website.ReactRouter("R", {}),
      () => GCP.Website.TanStackStart("T", {}),
      () => GCP.Website.Octane("O", {}),
      () => GCP.Website.Vocs("D", {}),
      () =>
        GCP.Website.Foldkit("F", {
          assets: { notFoundHandling: "404-page" },
        }),
      () =>
        GCP.Website.StaticSite("St", {
          build: { command: "hugo --minify", output: "public" },
          scaling: { minInstanceCount: 1 },
          assets: { notFoundHandling: "single-page-application" },
        }),
      () =>
        GCP.Website.StaticSite("St", {
          build: { command: "npm run build", output: "dist" },
          // @ts-expect-error command is nested under build
          command: "npm run build",
        }),
    ];

    it(
      "pins the GCP.Website prop surface at the type level",
      () => {
        expect(_pins.length).toBeGreaterThan(0);
      },
      { tags: ["provider:gcp", "provider:gcp:website", "live"] },
    );
  },
);
