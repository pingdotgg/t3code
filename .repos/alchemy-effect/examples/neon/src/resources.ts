import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const resources = Effect.gen(function* () {
  const project = yield* Neon.Project("Project", { region: "aws-us-east-2" });
  const branch = yield* Neon.Branch("Backend", {
    project,
    migrations: "./migrations",
  });
  const uploads = yield* Neon.Bucket("Uploads", {
    branch,
    access: "private",
    // A presigned URL authorizes the PUT, not CORS. No browser cookies are used.
    cors: [
      {
        AllowedOrigins: ["*"],
        AllowedMethods: ["PUT"],
        AllowedHeaders: ["content-type"],
        MaxAgeSeconds: 300,
      },
    ],
    forceDestroy: true,
  });
  const auth = yield* Neon.Auth("Auth", {
    branch,
    name: "Upload journal",
    allowLocalhost: true,
    emailAndPassword: {
      enabled: true,
      require_email_verification: false,
      send_verification_email_on_sign_up: false,
    },
  });
  const appOrigin = yield* Effect.sync(
    () => process.env.UPLOAD_APP_ORIGIN ?? "*",
  );
  const publicAssets = yield* Neon.Bucket("PublicAssets", {
    branch,
    access: "public_read",
    forceDestroy: true,
  });
  const settings = yield* Neon.Object("Settings", {
    bucket: uploads,
    key: "config/settings.json",
    value: { theme: "system", pageSize: 25 },
    schema: Schema.Struct({ theme: Schema.String, pageSize: Schema.Number }),
  });
  yield* Neon.Object("Welcome", {
    bucket: publicAssets,
    key: "welcome.txt",
    body: "Public read, authenticated write.",
    contentType: "text/plain",
  });
  return { project, branch, uploads, auth, appOrigin, publicAssets, settings };
});
