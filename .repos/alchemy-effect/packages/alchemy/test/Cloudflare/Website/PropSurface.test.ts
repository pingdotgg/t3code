import * as Cloudflare from "@/Cloudflare/index.ts";
import { describe, expect, it } from "alchemy-test";

/**
 * Compile-time pins for the framework Website resources' prop surfaces.
 *
 * The resources deliberately reject the Worker props their source dispatch
 * owns (`script`, `bundle`, `source`, `vite`, `assets` where the framework
 * owns assets) — passing one used to type-check and only fail at runtime
 * inside `resolveSource`. These `@ts-expect-error` pins fail the build if
 * an `Omit` is ever loosened again. The `() => {}` bodies never run; only
 * the types matter.
 */
describe("Website prop surfaces", () => {
  const _pins = [
    () =>
      Cloudflare.Website.Waku("W", {
        // @ts-expect-error `script` is owned by the source dispatch
        script: "export default {}",
      }),
    () =>
      Cloudflare.Website.Waku("W", {
        // @ts-expect-error `bundle` is owned by the source dispatch
        bundle: false,
      }),
    () =>
      Cloudflare.Website.SvelteKit("S", {
        // @ts-expect-error `script` is owned by the source dispatch
        script: "export default {}",
      }),
    () =>
      Cloudflare.Website.SvelteKit("S", {
        // @ts-expect-error `main` is not supported (no custom-entry seam)
        main: "worker.ts",
      }),
    () =>
      Cloudflare.Website.Nuxt("N", {
        // @ts-expect-error `bundle` is owned by the source dispatch
        bundle: false,
      }),
    () =>
      Cloudflare.Website.Astro("A", {
        // @ts-expect-error `main` is not supported (no custom-entry seam)
        main: "worker.ts",
      }),
    () =>
      Cloudflare.Website.Octane("O", {
        // @ts-expect-error `main` is not supported (no custom-entry seam)
        main: "worker.ts",
      }),
    () =>
      Cloudflare.Website.Octane("O", {
        // @ts-expect-error `script` is owned by the source dispatch
        script: "export default {}",
      }),
    () =>
      Cloudflare.Website.Astro("A", {
        // @ts-expect-error `source` is owned by the resource itself
        source: { provider: "x", options: {} },
      }),
    () =>
      Cloudflare.Website.Astro("A", {
        prerenderEnvironment: "node",
      }),
    () =>
      Cloudflare.Website.Astro("A", {
        prerenderEnvironment: "workerd",
      }),
    () =>
      Cloudflare.Website.Astro("A", {
        // @ts-expect-error only workerd and node are supported
        prerenderEnvironment: "bun",
      }),
    () =>
      Cloudflare.Website.Nextjs("X", {
        // @ts-expect-error `script` is owned by the source dispatch
        script: "export default {}",
      }),
    () =>
      Cloudflare.Website.Nextjs("X", {
        // @ts-expect-error `main` is not supported (OpenNext owns the entry)
        main: "worker.ts",
      }),
    () =>
      Cloudflare.Website.Nextjs("X", {
        // @ts-expect-error `source` is owned by the resource itself
        source: { provider: "x", options: {} },
      }),
    () =>
      Cloudflare.Website.Foldkit("F", {
        // @ts-expect-error `script` is owned by the source dispatch
        script: "export default {}",
      }),
    () =>
      Cloudflare.Website.Foldkit("F", {
        // @ts-expect-error `bundle` is owned by the source dispatch
        bundle: false,
      }),
    () =>
      Cloudflare.Website.Foldkit("F", {
        // @ts-expect-error `source` is owned by the resource itself
        source: { provider: "x", options: {} },
      }),
    () =>
      Cloudflare.Website.Foldkit("F", {
        // @ts-expect-error `viteEnvironments` is not supported (Foldkit has no RSC split)
        viteEnvironments: { entry: "rsc", children: ["ssr"] },
      }),
    // `main` IS supported — a Foldkit deployment may carry a custom Worker
    // entry (API routes, error reporting, Durable Objects) alongside the
    // client build. Pinned positively so an `Omit` can't quietly drop it.
    () => Cloudflare.Website.Foldkit("F", { main: "src/worker.ts" }),
    () =>
      Cloudflare.Website.Vocs("Docs", {
        // @ts-expect-error `source` is owned by the Vocs integration
        source: { provider: "x", options: {} },
      }),
    () =>
      Cloudflare.Website.Vocs("Docs", {
        // @ts-expect-error Vocs owns its Waku/RSC worker entry
        main: "worker.ts",
      }),
    // ── Flat-props doctrine pins ─────────────────────────────────────
    // Framework-named config bags are dissolved into flat, explicitly
    // typed props; the shared vocabulary (`outDir`, `spa`, `errorPage`)
    // is identical across composites. These pins fail the build if a bag
    // sneaks back in or a flat prop is dropped.
    // Astro: framework config lives in `astro.config.*`; the `astro`
    // prop is the deploy-time override bag merged OVER the file — an
    // explicit serializable subset, no flat mirror props, no
    // plugins/functions.
    () =>
      Cloudflare.Website.Astro("A", {
        astro: {
          site: "https://example.com",
          base: "/docs",
          output: "static",
          srcDir: "./app",
          publicDir: "./static",
          outDir: "./dist",
          trailingSlash: "always",
        },
      }),
    () =>
      Cloudflare.Website.Astro("A", {
        config: "astro.prod.config.mjs",
      }),
    () =>
      Cloudflare.Website.Astro("A", {
        // @ts-expect-error `output` lives in the `astro` override bag
        output: "static",
      }),
    () =>
      Cloudflare.Website.Astro("A", {
        // @ts-expect-error `site` belongs in astro.config.* or the `astro` bag
        site: "https://example.com",
      }),
    () =>
      Cloudflare.Website.Astro("A", {
        astro: {
          // @ts-expect-error no plugins in the serializable override bag
          integrations: [],
        },
      }),
    () =>
      Cloudflare.Website.Astro("A", {
        // @ts-expect-error only "always" | "never" | "ignore" — the value
        // mismatch surfaces on the containing `astro` assignment
        astro: {
          trailingSlash: "sometimes",
        },
      }),
    () =>
      Cloudflare.Website.Nextjs("X", {
        // @ts-expect-error the `nextjs` config bag is dissolved into flat props
        nextjs: { devMode: "hmr" },
      }),
    () =>
      Cloudflare.Website.Nextjs("X", {
        // @ts-expect-error the OpenNext pipeline knobs are gone — configure
        // them in open-next.config.ts; dev behavior moved to `dev.mode`
        devMode: "hmr",
        buildCommand: "npx next build",
        minify: true,
        skipNextBuild: false,
        configPath: "open-next.config.ts",
        debug: false,
      }),
    // The `nuxt` bag is the ONE sanctioned override surface: serializable
    // deploy-time config merged over nuxt.config.ts (highest-priority c12
    // layer). Pinned positively so an `Omit` can't quietly drop it.
    () =>
      Cloudflare.Website.Nuxt("N", {
        nuxt: {
          app: { baseURL: "/docs/" },
          runtimeConfig: { public: { apiBase: "https://example.com" } },
        },
      }),
    () =>
      Cloudflare.Website.SvelteKit("S", {
        // @ts-expect-error `adapter` removed — fallback generation is derived
        // from the platform-native `assets.notFoundHandling` knob
        adapter: { notFoundHandling: "404-page", fallback: "spa" },
      }),
    // The `kit` bag is the deploy-time override seam: JSON-serializable
    // config merged over the user's own `sveltekit(...)` call (the prop
    // wins). Pinned positively so an `Omit` can't quietly drop it.
    () =>
      Cloudflare.Website.SvelteKit("S", {
        kit: { paths: { base: "/docs" } },
      }),
    () =>
      Cloudflare.Website.SvelteKit("S", {
        assets: { notFoundHandling: "404-page" },
      }),
    () =>
      Cloudflare.Website.Waku("W", {
        // @ts-expect-error framework config lives in the `waku` override bag
        srcDir: "app",
      }),
    () =>
      Cloudflare.Website.Waku("W", {
        // @ts-expect-error framework config lives in the `waku` override bag
        outDir: "build",
      }),
    // The `waku` bag is the deploy-time override seam, merged over the
    // project's own `waku.config.*` (per-key; deploy-time values win).
    () =>
      Cloudflare.Website.Waku("W", {
        waku: { srcDir: "app", distDir: "build", basePath: "/docs/" },
      }),
    () =>
      Cloudflare.Website.Vite("V", {
        // No spa/errorPage sugar on CF Vite: Workers Assets' own
        // notFoundHandling is the platform-native surface.
        assets: { notFoundHandling: "single-page-application" },
      }),
    () =>
      Cloudflare.Website.Vite("V", {
        // @ts-expect-error spa sugar deliberately not offered on CF Vite
        spa: true,
      }),
    // ── CF Vite/Foldkit: config belongs in vite.config.* ─────────────
    // The CF composites build through the Cloudflare Vite plugin, whose
    // pipeline has no inline-override or configFile seam — so unlike the
    // AWS composites there is no `vite` override bag and no `config`
    // prop; `base`/`outDir` live only in the project's own config file.
    () =>
      Cloudflare.Website.Vite("V", {
        // @ts-expect-error no top-level `base` — set it in vite.config.*
        base: "/docs/",
      }),
    () =>
      Cloudflare.Website.Vite("V", {
        // @ts-expect-error no top-level `outDir` — the plugin owns the output layout
        outDir: "dist",
      }),
    () =>
      Cloudflare.Website.Vite("V", {
        // @ts-expect-error no `vite` override bag on CF (no seam through the plugin pipeline)
        vite: { base: "/docs/" },
      }),
    () =>
      Cloudflare.Website.Foldkit("F", {
        // @ts-expect-error no top-level `base` — set it in vite.config.*
        base: "/app/",
      }),
    () =>
      Cloudflare.Website.Foldkit("F", {
        // @ts-expect-error no `vite` override bag on CF (no seam through the plugin pipeline)
        vite: { base: "/app/" },
      }),
    // spa/errorPage sugar was dropped from CF Foldkit with CF Vite's:
    // Workers Assets' notFoundHandling (defaulted to SPA for Foldkit) is
    // the platform-native surface.
    () =>
      Cloudflare.Website.Foldkit("F", {
        // @ts-expect-error spa sugar removed — use assets.notFoundHandling
        spa: false,
      }),
    () =>
      Cloudflare.Website.Foldkit("F", {
        // @ts-expect-error errorPage sugar removed — use assets.notFoundHandling: "404-page"
        errorPage: "404.html",
      }),
  ];

  it("rejects source-dispatch props at the type level", () => {
    // The pins above are compile-time only.
    expect(_pins.length).toBeGreaterThan(0);
  });
});
