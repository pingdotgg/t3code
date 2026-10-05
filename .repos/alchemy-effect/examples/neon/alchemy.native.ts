import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import { resources } from "./src/resources.ts";
import { features } from "./src/features.ts";
import { website } from "./src/website.ts";

export default Alchemy.Stack(
  "NeonUploadNativeTutorial",
  {
    providers: Neon.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const { branch, uploads, auth, appOrigin } = yield* resources;
    const api = yield* Neon.Function("Api", {
      branch,
      main: "./src/native.ts",
      env: {
        APP_ORIGIN: appOrigin,
        UPLOAD_BUCKET: uploads.bucketName,
        AUTH_URL: auth.baseUrl,
        AUTH_JWKS_URL: auth.jwksUrl,
      },
    });
    yield* Neon.FunctionTrigger("ProcessUploads", {
      function: api,
      name: "ProcessUploads",
      type: "storage_object_created",
      storageObjectCreated: { bucket: uploads, prefix: "incoming/" },
      path: "/jobs/upload",
    });
    return { ...(yield* website(api)), ...(yield* features) };
  }),
);
