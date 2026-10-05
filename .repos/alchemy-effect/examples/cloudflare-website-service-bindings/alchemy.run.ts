import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { resolve } from "node:path";

export default Alchemy.Stack(
  "CloudflareWebsiteServiceBindingsExample",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const root = resolve(import.meta.dirname, "apps");
    const props = {
      workersDev: false,
      cache: { enabled: true },
      dev: { port: 0 },
    };
    const websites = yield* Effect.all({
      sveltekit: Cloudflare.Website.SvelteKit("sveltekit", {
        ...props,
        rootDir: resolve(root, "sveltekit"),
      }),
      nuxt: Cloudflare.Website.Nuxt("nuxt", {
        ...props,
        rootDir: resolve(root, "nuxt"),
      }),
      nextjs: Cloudflare.Website.Nextjs("nextjs", {
        ...props,
        rootDir: resolve(root, "nextjs"),
        dev: { port: 0, mode: "hmr" },
      }),
      "nextjs-preview": Cloudflare.Website.Nextjs("nextjs-preview", {
        ...props,
        rootDir: resolve(root, "nextjs-preview"),
        dev: { port: 0, mode: "preview" },
      }),
      octane: Cloudflare.Website.Octane("octane", {
        ...props,
        rootDir: resolve(root, "octane"),
      }),
      astro: Cloudflare.Website.Astro("astro", {
        ...props,
        rootDir: resolve(root, "astro"),
      }),
      waku: Cloudflare.Website.Waku("waku", {
        ...props,
        rootDir: resolve(root, "waku"),
      }),
      vocs: Cloudflare.Website.Vocs("vocs", {
        ...props,
        rootDir: resolve(root, "vocs"),
      }),
      vinext: Cloudflare.Website.Vinext("vinext", {
        ...props,
        rootDir: resolve(root, "vinext"),
      }),
    });

    const gateways = yield* Effect.forEach(
      Object.entries(websites),
      ([name, website]) =>
        Effect.gen(function* () {
          const gateway = yield* Cloudflare.Worker(`${name}Gateway`, {
            main: "./gateway.ts",
            cache: { enabled: false },
            dev: { port: 0 },
            env: { WEBSITE: website },
          });
          return [
            name,
            { websiteUrl: website.url, gatewayUrl: gateway.url },
          ] as const;
        }),
    );
    return Object.fromEntries(gateways);
  }),
);
