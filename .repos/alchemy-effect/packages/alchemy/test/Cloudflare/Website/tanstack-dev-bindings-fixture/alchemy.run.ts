import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export const Bucket = Cloudflare.R2.Bucket("DevBucket");

export const Website = Cloudflare.Website.Vite("TanStackDevBindingsFixture", {
  compatibility: {
    flags: ["nodejs_compat"],
  },
  assets: {
    runWorkerFirst: true,
  },
  env: {
    BUCKET: Bucket,
    DEV_MARKER: "manual-dev",
  },
  memo: {
    include: [
      "src/**",
      "package.json",
      "tsconfig.json",
      "vite.config.ts",
      "alchemy.run.ts",
    ],
  },
});

export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>;

export default Alchemy.Stack(
  "CloudflareTanStackDevBindingsFixture",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const website = yield* Website;

    return {
      url: website.url,
    };
  }),
);
