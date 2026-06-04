import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type WorkerEnv = Cloudflare.InferEnv<typeof Website>;

const Website = Cloudflare.StaticSite(
  "Website",
  Alchemy.Stack.useSync((stack) => ({
    command: "bun run build",
    name:
      stack.stage === "prod"
        ? // FUCK: i deleted state lol, let's adopt this to avoid potential DNS prop issue
          "alchemyeffectwebsite-worker-prod-piyvp3qw7565vvin"
        : undefined,
    main: "./src/worker.ts",
    outdir: "dist",
    domain: stack.stage === "prod" ? "v2.alchemy.run" : undefined,
    memo: {
      include: [
        "src/**",
        "astro.config.mjs",
        "package.json",
        "plugins/**",
        "public/**",
        "scripts/**",
        "../bun.lock",
      ],
    },
    compatibility: {
      date: "2026-04-02",
      flags: ["nodejs_compat"],
    },
    assetsConfig: {
      runWorkerFirst: true,
    },
  })),
);

export default Alchemy.Stack(
  "AlchemyEffectWebsite",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const website = yield* Website;

    if (stage.startsWith("pr-")) {
      yield* GitHub.Comment("preview-comment", {
        owner: "alchemy-run",
        repository: "alchemy-effect",
        issueNumber: Number(process.env.PULL_REQUEST),
        body: Output.interpolate`
          ## Website Preview Deployed

          **URL:** ${website.url}

          Built from commit ${
            // `BUILD_SHA` is set by .github/workflows/deploy.yml to the
            // PR head SHA (or `github.sha` for push deploys). The
            // ambient `GITHUB_SHA` would point at the synthetic merge
            // commit on `pull_request` events, which is not what
            // anyone wants to see in the comment.
            process.env.BUILD_SHA
              ? `[\`${process.env.BUILD_SHA.slice(0, 7)}\`](https://github.com/alchemy-run/alchemy-effect/commit/${process.env.BUILD_SHA})`
              : "unknown"
          }.

          ---
          _This comment updates automatically with each push._
        `,
      });
    }

    return {
      url: website.url,
    };
  }),
);
