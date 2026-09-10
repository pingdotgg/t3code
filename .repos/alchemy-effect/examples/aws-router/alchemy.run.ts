import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

const aws = AWS.providers();

export default Alchemy.Stack(
  "AwsRouterExample",
  { providers: aws, state: Alchemy.localState() },
  Effect.gen(function* () {
    const tags = { Example: "aws-router", Surface: "website" };

    /**
     * One CloudFront front door shared by every site below.
     *
     * `alchemy deploy` creates a real distribution; `alchemy dev` runs an
     * emulated one on a local port. Either way the sites mount onto it the
     * same way, so there is nothing dev-specific in this file.
     */
    const router = yield* AWS.Website.Router("Router", {
      invalidation: { paths: "all" },
      tags: { ...tags, Mode: "router" },
    });

    /**
     * Mounted at the root. `alchemy dev` runs Vite's own dev server (HMR
     * included) and the Router proxies to it.
     */
    const web = yield* AWS.Website.Vite("Web", {
      rootDir: "apps/web",
      domain: { router },
      tags: { ...tags, Site: "web" },
    });

    /**
     * Mounted at `/docs`. The path prefix is NOT stripped — a site served
     * under `/docs` is addressed as `/docs/...` at the edge, so Vite's
     * `base` has to match the mount point for asset URLs to resolve.
     */
    const docs = yield* AWS.Website.Vite("Docs", {
      rootDir: "apps/docs",
      vite: { base: "/docs/" },
      domain: { router, path: "/docs" },
      tags: { ...tags, Site: "docs" },
    });

    return {
      /** `https://<id>.cloudfront.net` deployed, `http://localhost:<port>` in dev. */
      url: router.url,
      web: web.url,
      docs: docs.url,
      distributionId: router.distribution.distributionId,
    };
  }),
);
