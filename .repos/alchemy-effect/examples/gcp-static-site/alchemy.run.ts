import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";

export default Alchemy.Stack(
  "GcpStaticSiteExample",
  { providers: GCP.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const bucket = yield* GCP.Storage.Bucket("Site", {
      uniformBucketLevelAccess: true,
      // Applied when the bucket is served through a CNAME or an HTTPS
      // load balancer; path-style storage.googleapis.com URLs ignore it.
      website: { mainPageSuffix: "index.html", notFoundPage: "404.html" },
      // Site content is fully owned by this stack.
      forceDestroy: true,
    });

    // Anyone on the internet may read (and list) the site's objects.
    yield* GCP.IAM.Member("PublicRead", {
      kind: "storage.bucket",
      name: bucket.bucketName,
      role: "roles/storage.objectViewer",
      member: "allUsers",
    });

    const files = yield* GCP.Storage.Files("SiteFiles", {
      bucketName: bucket.bucketName,
      path: fileURLToPath(new URL("./site", import.meta.url)),
      // HTML revalidates on every load so deploys show up immediately.
      cacheControl: (key) =>
        key.endsWith(".html") ? "no-cache" : "public, max-age=300",
    });

    return {
      bucketName: bucket.bucketName,
      url: Output.interpolate`https://storage.googleapis.com/${bucket.bucketName}/index.html`,
      fileCount: files.length,
    };
  }),
);
