import * as Alchemy from "alchemy";
import * as AdoptPolicy from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Output from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type WorkerEnv = Cloudflare.InferEnv<typeof Website>;

const Website = Cloudflare.Website.StaticSite(
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
    // `alchemy.run` first: the Worker's `url` output is `domains[0]`.
    // `v2.alchemy.run` stays attached (DNS + cert) but is 301-redirected
    // to `alchemy.run` by the redirect Ruleset below.
    domain:
      stack.stage === "prod" ? ["alchemy.run", "v2.alchemy.run"] : undefined,
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
    assets: {
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

    if (stage === "prod") {
      // The `alchemy.run` zone predates this stack (the v1 website created
      // it), so adopt it — and never delete it on destroy.
      const zone = yield* Cloudflare.Zone.Zone("Zone", {
        name: "alchemy.run",
      }).pipe(AdoptPolicy.adopt(true), RemovalPolicy.retain());

      // Single Redirects run at the edge before Workers, so requests to
      // `v2.alchemy.run` never reach the Worker — they 301 to `alchemy.run`
      // with path and query preserved.
      yield* Cloudflare.Ruleset.Ruleset("V2Redirect", {
        zone,
        phase: "http_request_dynamic_redirect",
        rules: [
          {
            description: "Redirect v2.alchemy.run to alchemy.run",
            expression: 'http.host eq "v2.alchemy.run"',
            action: "redirect",
            actionParameters: {
              fromValue: {
                targetUrl: {
                  expression:
                    'concat("https://alchemy.run", http.request.uri.path)',
                },
                preserveQueryString: true,
                statusCode: 301,
              },
            },
          },
        ],
      });
    }

    if (stage.startsWith("pr-")) {
      yield* GitHub.Comment("preview-comment", {
        owner: "alchemy-run",
        repository: "alchemy",
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
              ? `[\`${process.env.BUILD_SHA.slice(0, 7)}\`](https://github.com/alchemy-run/alchemy/commit/${process.env.BUILD_SHA})`
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
