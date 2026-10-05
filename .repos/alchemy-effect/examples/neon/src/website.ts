import * as Neon from "alchemy/Neon";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { resources } from "./resources.ts";

export const website = Effect.fn(function* (api: Neon.Function) {
  const { project, branch, uploads, auth, publicAssets } = yield* resources;
  const web = yield* Neon.Website.Vite("Web", {
    branch,
    rootDir: "./web",
    env: { VITE_API_URL: api.url, VITE_NEON_AUTH_URL: auth.baseUrl },
    assets: { notFoundHandling: "single-page-application" },
  });
  if (!web.url)
    return yield* Effect.die(new Error("The website did not return a URL"));
  const siteUrl =
    typeof web.url === "string" ? Output.literal(web.url) : web.url;
  const origin = Output.map(
    siteUrl,
    (url: string | undefined) => new URL(url ?? "").origin,
  );
  yield* Neon.AuthTrustedDomain("WebOrigin", { auth, domain: origin });
  return {
    url: web.url,
    apiUrl: api.url,
    authUrl: auth.baseUrl,
    projectId: project.projectId,
    branchId: branch.branchId,
    bucketName: uploads.bucketName,
    publicBucketName: publicAssets.bucketName,
  };
});
