import {
  GCP_AUTH_PROVIDER_NAME,
  GcpAuth,
  parseGcloudLoginOutput,
  type GcpAuthConfig,
  type GcpResolvedCredentials,
} from "@alchemy.run/gcp/AuthProvider";
import { describe, expect, it } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthProvidersLive, getAuthProvider, presentEnvironment } from "alchemy/Auth/AuthProvider";
import { CredentialsStore } from "alchemy/Auth/Credentials";
import * as Interaction from "alchemy/Interaction";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";

const credentialsStore: CredentialsStore["Service"] = {
  read: () => Effect.succeed(undefined),
  write: () => Effect.void,
  delete: () => Effect.void,
  deleteProfile: () => Effect.void,
  scoped: () => credentialsStore,
};

const testLayer = (env: Record<string, string>) =>
  GcpAuth.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeServices.layer,
        AuthProvidersLive,
        Layer.succeed(CredentialsStore, credentialsStore),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
        Interaction.layerNonInteractive(),
      ),
    ),
  );

const readGcloud = (config: Omit<Extract<GcpAuthConfig, { method: "gcloud" }>, "method">) =>
  Effect.gen(function* () {
    const auth = yield* getAuthProvider<GcpAuthConfig, GcpResolvedCredentials>(
      GCP_AUTH_PROVIDER_NAME,
    );
    return yield* auth.read("default", Effect.succeed({ method: "gcloud" as const, ...config }));
  });

/**
 * Runs `effect` with gcloud's config directory set to a fresh one holding
 * the named `configurations` (gcloud's INI properties files).
 */
const withGcloudConfig = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  configurations: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-gcloud-" });
    yield* fs.makeDirectory(path.join(dir, "configurations"));
    for (const [name, properties] of Object.entries(configurations)) {
      yield* fs.writeFileString(path.join(dir, "configurations", `config_${name}`), properties);
    }
    return yield* effect.pipe(Effect.provide(testLayer({ CLOUDSDK_CONFIG: dir })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("parseGcloudLoginOutput", { tags: ["unit", "provider:gcp", "local"] }, () => {
  it("reads the authorization URL from gcloud's prompt", () => {
    expect(
      parseGcloudLoginOutput(`Your browser has been opened to visit:

    https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2F

`),
    ).toBe(
      "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2F",
    );
  });

  it("waits until the URL has been printed", () => {
    expect(parseGcloudLoginOutput("Your browser has been opened to visit:\n")).toBeUndefined();
  });
});

/** The variables that would override the selected profile, given `env`. */
const environmentOverride = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const auth = yield* getAuthProvider<GcpAuthConfig, GcpResolvedCredentials>(
      GCP_AUTH_PROVIDER_NAME,
    );
    return yield* presentEnvironment(auth.environment ?? []);
  }).pipe(Effect.provide(testLayer(env)));

describe("environment credentials", { tags: ["unit", "provider:gcp", "local"] }, () => {
  it.effect("a project variable alone does not override the profile", () =>
    Effect.gen(function* () {
      expect(yield* environmentOverride({ GOOGLE_CLOUD_PROJECT: "p" })).toBeUndefined();
    }),
  );

  it.effect("a token or key file overrides the profile", () =>
    Effect.gen(function* () {
      expect(
        yield* environmentOverride({ GOOGLE_ACCESS_TOKEN: "t", GOOGLE_PROJECT_ID: "p" }),
      ).toEqual(["GOOGLE_ACCESS_TOKEN", "GOOGLE_PROJECT_ID"]);
      expect(yield* environmentOverride({ GOOGLE_APPLICATION_CREDENTIALS: "/key.json" })).toEqual([
        "GOOGLE_APPLICATION_CREDENTIALS",
      ]);
    }),
  );
});

describe("gcloud configuration", { tags: ["unit", "provider:gcp", "local"] }, () => {
  it.effect("rejects a configuration that does not exist", () =>
    Effect.gen(function* () {
      const error = yield* withGcloudConfig(readGcloud({ configuration: "work" })).pipe(
        Effect.flip,
      );
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("gcloud configuration 'work' does not exist");
      expect(error.message).toContain("gcloud config configurations create work --no-activate");
    }),
  );
});

describe("gcloud configuration", { tags: ["provider:gcp", "live"] }, () => {
  it.live("asks for a refresh when the configuration's account has no login", () =>
    withGcloudConfig(readGcloud({ configuration: "work" }), {
      work: "[core]\naccount = nobody@example.com\nproject = p\n",
    }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error._tag).toBe("NeedsReauth");
        expect(error.message).toContain("gcloud configuration 'work' needs a login");
        expect(error.message).toContain("alchemy profile refresh --profile default --provider GCP");
      }),
    ),
  );
});

// Needs a named gcloud configuration with a login and a project on this
// machine (`gcloud auth login --configuration=<name>`). Set
// GCP_TEST_GCLOUD_CONFIGURATION to its name.
const gcloudConfiguration = process.env.GCP_TEST_GCLOUD_CONFIGURATION;

describe.skipIf(!gcloudConfiguration)(
  "gcloud configuration with a real login",
  { tags: ["provider:gcp", "live"] },
  () => {
    it.live("deploys as the configuration's account into its project", () =>
      Effect.gen(function* () {
        const credentials = yield* readGcloud({ configuration: gcloudConfiguration! }).pipe(
          Effect.provide(testLayer({})),
        );
        expect(credentials.source.type).toBe("gcloud");
        expect(credentials.source.details).toContain(`configuration ${gcloudConfiguration}`);
        expect(credentials.expiresAt).toBeGreaterThan(Date.now());

        const http = yield* HttpClient.HttpClient;
        const response = yield* http.execute(
          HttpClientRequest.get(
            `https://cloudresourcemanager.googleapis.com/v3/projects/${credentials.project}`,
          ).pipe(HttpClientRequest.bearerToken(Redacted.value(credentials.accessToken))),
        );
        expect(response.status).toBe(200);
        const project = (yield* response.json) as { projectId: string };
        expect(project.projectId).toBe(credentials.project);
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );
  },
);
