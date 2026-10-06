import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "NeonUploadPreview",
  {
    providers: Neon.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const projectId = yield* Config.String("PARENT_PROJECT_ID");
    const parentBranchId = yield* Config.String("PARENT_BRANCH_ID");
    const bucketName = yield* Config.String("PARENT_BUCKET_NAME");
    const appOrigin = yield* Effect.sync(
      () => process.env.UPLOAD_APP_ORIGIN ?? "*",
    );
    const branch = yield* Neon.Branch("Preview", {
      project: { projectId },
      parentBranch: { branchId: parentBranchId },
      initSource: "parent-data",
    });
    // Adoption is confined to the new child; the parent Auth remains independently owned.
    const auth = yield* Neon.Auth("PreviewAuth", {
      branch,
      name: "Upload journal preview",
      allowLocalhost: true,
    }).pipe(Alchemy.AdoptPolicy.adopt());
    const api = yield* Neon.Function("PreviewApi", {
      branch,
      main: "./src/native.ts",
      env: {
        APP_ORIGIN: appOrigin,
        UPLOAD_BUCKET: bucketName,
        AUTH_URL: auth.baseUrl,
        AUTH_JWKS_URL: auth.jwksUrl,
        TRIGGER_NAME: "PreviewUploads",
      },
    });
    // Inherited triggers stay disabled. This is a new, explicitly enabled child trigger.
    yield* Neon.FunctionTrigger("PreviewUploads", {
      function: api,
      name: "PreviewUploads",
      type: "storage_object_created",
      storageObjectCreated: {
        bucket: { projectId, branchId: branch.branchId, bucketName },
        prefix: "incoming/",
      },
      path: "/jobs/upload",
      enabled: true,
    });
    const web = yield* Neon.Website.Vite("PreviewWeb", {
      branch,
      rootDir: "./web",
      env: { VITE_API_URL: api.url, VITE_NEON_AUTH_URL: auth.baseUrl },
      assets: { notFoundHandling: "single-page-application" },
    });
    if (!web.url)
      return yield* Effect.die(new Error("Preview website URL is unavailable"));
    const siteUrl =
      typeof web.url === "string" ? Output.literal(web.url) : web.url;
    const origin = Output.map(
      siteUrl,
      (url: string | undefined) => new URL(url ?? "").origin,
    );
    yield* Neon.AuthTrustedDomain("PreviewOrigin", { auth, domain: origin });
    // No CustomDomain is declared: parent hostnames must never route to this preview.
    return {
      url: web.url,
      apiUrl: api.url,
      authUrl: auth.baseUrl,
      projectId,
      parentBranchId,
      branchId: branch.branchId,
      bucketName,
    };
  }),
);
