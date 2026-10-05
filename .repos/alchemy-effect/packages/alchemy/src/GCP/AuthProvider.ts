import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  AuthError,
  AuthProviderLayer,
  NeedsReauth,
  refreshHint,
  type ConfigureField,
  type ConfigureMethod,
  type ProviderDetails,
} from "../Auth/AuthProvider.ts";
import { CredentialsStore, displayRedacted } from "../Auth/Credentials.ts";
import { getEnv, getEnvRedacted, mapPromptCancellation } from "../Auth/Env.ts";
import * as Interaction from "../Interaction.ts";
import {
  mintAccessToken,
  parseServiceAccountKey,
  type ServiceAccountKey,
} from "./Token.ts";

export const GCP_AUTH_PROVIDER_NAME = "GCP";
export const GOOGLE_ACCESS_TOKEN_ENV = "GOOGLE_ACCESS_TOKEN";
export const GOOGLE_PROJECT_ID_ENV = "GOOGLE_PROJECT_ID";
export const GOOGLE_CLOUD_PROJECT_ENV = "GOOGLE_CLOUD_PROJECT";
export const GOOGLE_APPLICATION_CREDENTIALS_ENV =
  "GOOGLE_APPLICATION_CREDENTIALS";
/** Region when neither the environment nor the profile names one. */
export const DEFAULT_GCP_REGION = "us-central1";

/**
 * Default region for regional resources created without an explicit
 * location. Like the project, it is part of the profile.
 */
const region = Schema.optionalKey(Schema.String);

export const GcpAuthConfigSchema = Schema.Union([
  Schema.Struct({ method: Schema.Literal("env"), region }),
  Schema.Struct({
    method: Schema.Literal("serviceAccount"),
    credentialsFile: Schema.optionalKey(Schema.String),
    region,
  }),
  Schema.Struct({ method: Schema.Literal("stored"), region }),
]);
export type GcpAuthConfig = typeof GcpAuthConfigSchema.Type;

export const GcpStoredCredentialsSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("token"),
    accessToken: Schema.String,
    project: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("serviceAccount"),
    json: Schema.String,
    project: Schema.optionalKey(Schema.String),
  }),
]);
export type GcpStoredCredentials = typeof GcpStoredCredentialsSchema.Type;

export type GcpResolvedCredentials = {
  type: "token";
  accessToken: Redacted.Redacted<string>;
  project: string;
  /** Default region: env override, else the profile, else `us-central1`. */
  region: string;
  source: { type: GcpAuthConfig["method"] | "env"; details?: string };
};

const options: Array<{
  value: GcpAuthConfig["method"];
  label: string;
  description?: string;
}> = [
  {
    value: "env",
    label: "Environment Variables",
    description: `${GOOGLE_ACCESS_TOKEN_ENV} or ${GOOGLE_APPLICATION_CREDENTIALS_ENV} + ${GOOGLE_PROJECT_ID_ENV}`,
  },
  {
    value: "serviceAccount",
    label: "Service account JSON",
    description: "path to a service-account key file",
  },
  {
    value: "stored",
    label: "Stored",
    description: "token or key stored in ~/.alchemy/credentials",
  },
];

const REFRESH_WINDOW_MS = 5 * 60 * 1000;

export const GcpAuth = AuthProviderLayer<
  GcpAuthConfig,
  GcpResolvedCredentials
>()(
  GCP_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const store = yield* CredentialsStore;
    const fs = yield* FileSystem.FileSystem;
    const interaction = Interaction.accessors;
    const tokenCache = yield* Ref.make<
      { accessToken: string; expirationMs: number; project: string } | undefined
    >(undefined);

    const readKeyFile = (
      path: string,
    ): Effect.Effect<ServiceAccountKey, AuthError> =>
      fs.readFileString(path).pipe(
        Effect.flatMap(parseServiceAccountKey),
        Effect.mapError(
          (e) =>
            new AuthError({
              message: `Failed to read service-account key at ${path}`,
              cause: e,
            }),
        ),
      );

    const mintCached = (
      sa: ServiceAccountKey,
      project: string,
    ): Effect.Effect<Omit<GcpResolvedCredentials, "region">, AuthError> =>
      Effect.gen(function* () {
        const now = yield* Effect.sync(() => Date.now());
        const cached = yield* Ref.get(tokenCache);
        if (
          cached &&
          cached.project === project &&
          cached.expirationMs - now > REFRESH_WINDOW_MS
        ) {
          return {
            type: "token" as const,
            accessToken: Redacted.make(cached.accessToken),
            project,
            source: {
              type: "serviceAccount" as const,
              details: sa.client_email,
            },
          };
        }
        const minted = yield* mintAccessToken(sa);
        yield* Ref.set(tokenCache, {
          accessToken: Redacted.value(minted.accessToken),
          expirationMs: minted.expirationMs,
          project,
        });
        return {
          type: "token" as const,
          accessToken: minted.accessToken,
          project,
          source: {
            type: "serviceAccount" as const,
            details: sa.client_email,
          },
        };
      });

    const resolveFromServiceAccount = (
      sa: ServiceAccountKey,
      explicitProject?: string,
    ): Effect.Effect<Omit<GcpResolvedCredentials, "region">, AuthError> => {
      const project = explicitProject ?? sa.project_id;
      if (!project) {
        return Effect.fail(
          new AuthError({
            message: `Set ${GOOGLE_PROJECT_ID_ENV} (service-account JSON has no project_id)`,
          }),
        );
      }
      return mintCached(sa, project);
    };

    const loginStored = Effect.fn(function* (profileName: string) {
      const kind = yield* interaction.prompt
        .select({
          message: "GCP stored credential type",
          options: [
            {
              value: "token" as const,
              label: "Access token",
              description:
                "paste a bearer token from gcloud auth print-access-token",
            },
            {
              value: "serviceAccount" as const,
              label: "Service account JSON",
              description: "paste the key file contents",
            },
          ],
        })
        .pipe(mapPromptCancellation);

      const project = yield* interaction.prompt
        .text({
          message: "GCP project id",
          validate: (v) => (v.length === 0 ? "Required" : undefined),
        })
        .pipe(mapPromptCancellation);

      if (kind === "token") {
        const accessToken = yield* interaction.prompt
          .password({
            message: "Google access token",
            validate: (v) => (v.length === 0 ? "Required" : undefined),
          })
          .pipe(mapPromptCancellation);
        yield* store.write(
          profileName,
          GCP_AUTH_PROVIDER_NAME,
          GcpStoredCredentialsSchema,
          {
            type: "token",
            accessToken,
            project,
          },
        );
      } else {
        const json = yield* interaction.prompt
          .password({
            message: "Service account JSON",
            validate: (v) => (v.length === 0 ? "Required" : undefined),
          })
          .pipe(mapPromptCancellation);
        yield* parseServiceAccountKey(json);
        yield* store.write(
          profileName,
          GCP_AUTH_PROVIDER_NAME,
          GcpStoredCredentialsSchema,
          {
            type: "serviceAccount",
            json,
            project,
          },
        );
      }
      yield* interaction.output.success("GCP: credentials saved.");
      return { method: "stored" as const };
    });

    const configureInteractive = (profileName: string) =>
      interaction.prompt
        .select({
          message: "GCP authentication method",
          options,
        })
        .pipe(
          mapPromptCancellation,
          Effect.flatMap((method) =>
            Match.value(method).pipe(
              Match.when("env", () =>
                Effect.succeed({ method: "env" as const }),
              ),
              Match.when("serviceAccount", () =>
                interaction.prompt
                  .text({
                    message: "Path to service-account JSON (Enter for ADC env)",
                    placeholder: `$${GOOGLE_APPLICATION_CREDENTIALS_ENV}`,
                  })
                  .pipe(
                    mapPromptCancellation,
                    Effect.map((path) => {
                      const trimmed = (path ?? "").trim();
                      return {
                        method: "serviceAccount" as const,
                        ...(trimmed.length > 0
                          ? { credentialsFile: trimmed }
                          : {}),
                      };
                    }),
                  ),
              ),
              Match.when("stored", () => loginStored(profileName)),
              Match.exhaustive,
            ),
          ),
        );

    const promptRegion = interaction.prompt
      .text({
        message: "Default GCP region",
        placeholder: DEFAULT_GCP_REGION,
      })
      .pipe(
        mapPromptCancellation,
        Effect.map((value) => (value ?? "").trim() || DEFAULT_GCP_REGION),
      );

    const configureCredentials = (_profileName: string) =>
      configureInteractive(_profileName).pipe(
        Effect.flatMap((config) =>
          promptRegion.pipe(Effect.map((region) => ({ ...config, region }))),
        ),
        Effect.mapError(
          (e) =>
            new AuthError({
              message: "failed to configure credentials",
              cause: e,
            }),
        ),
      );

    const regionField: ConfigureField = {
      name: "region",
      label: "Default GCP region",
      placeholder: DEFAULT_GCP_REGION,
      optional: true,
    };

    const serviceAccountFields: ReadonlyArray<ConfigureField> = [
      {
        name: "credentialsFile",
        label: "Path to service-account JSON",
        optional: true,
      },
      regionField,
    ];

    const configureMethods: ReadonlyArray<ConfigureMethod> = [
      { method: "env", fields: [regionField] },
      { method: "serviceAccount", fields: serviceAccountFields },
    ];

    const regionOf = (values: Record<string, string>) => {
      const value = (values.region ?? "").trim();
      return value.length > 0 ? { region: value } : {};
    };

    const configureWith = (
      _profileName: string,
      input: {
        readonly method: string;
        readonly values: Record<string, string>;
      },
    ): Effect.Effect<GcpAuthConfig, AuthError> => {
      if (input.method === "env") {
        return Effect.succeed({
          method: "env" as const,
          ...regionOf(input.values),
        });
      }
      if (input.method === "serviceAccount") {
        const trimmed = (input.values.credentialsFile ?? "").trim();
        return Effect.succeed({
          method: "serviceAccount" as const,
          ...(trimmed.length > 0 ? { credentialsFile: trimmed } : {}),
          ...regionOf(input.values),
        });
      }
      return Effect.fail(
        new AuthError({
          message: `GCP: unknown method '${input.method}'. Valid methods: env, serviceAccount. (stored is interactive-only.)`,
        }),
      );
    };

    const resolveFromEnv = (): Effect.Effect<
      Omit<GcpResolvedCredentials, "region">,
      AuthError
    > =>
      Effect.gen(function* () {
        const project =
          (yield* getEnv(GOOGLE_PROJECT_ID_ENV)) ??
          (yield* getEnv(GOOGLE_CLOUD_PROJECT_ENV));
        const token = yield* getEnvRedacted(GOOGLE_ACCESS_TOKEN_ENV);
        if (token) {
          if (!project) {
            return yield* new AuthError({
              message: `GCP env credentials missing ${GOOGLE_PROJECT_ID_ENV}`,
            });
          }
          return {
            type: "token" as const,
            accessToken: token,
            project,
            source: { type: "env" as const, details: GOOGLE_ACCESS_TOKEN_ENV },
          };
        }
        const keyPath = yield* getEnv(GOOGLE_APPLICATION_CREDENTIALS_ENV);
        if (!keyPath) {
          return yield* new AuthError({
            message: `GCP env credentials not found. Set ${GOOGLE_ACCESS_TOKEN_ENV}+${GOOGLE_PROJECT_ID_ENV} or ${GOOGLE_APPLICATION_CREDENTIALS_ENV}.`,
          });
        }
        const sa = yield* readKeyFile(keyPath);
        return yield* resolveFromServiceAccount(sa, project);
      });

    const resolveFromServiceAccountFile = (
      credentialsFile: string | undefined,
    ): Effect.Effect<Omit<GcpResolvedCredentials, "region">, AuthError> =>
      Effect.gen(function* () {
        const fromEnv = yield* getEnv(GOOGLE_APPLICATION_CREDENTIALS_ENV);
        const path = credentialsFile ?? fromEnv;
        if (!path) {
          return yield* new AuthError({
            message: `GCP service-account key not found. Set ${GOOGLE_APPLICATION_CREDENTIALS_ENV}.`,
          });
        }
        const sa = yield* readKeyFile(path);
        const project =
          (yield* getEnv(GOOGLE_PROJECT_ID_ENV)) ??
          (yield* getEnv(GOOGLE_CLOUD_PROJECT_ENV));
        return yield* resolveFromServiceAccount(sa, project);
      });

    const resolveFromStored = (
      profileName: string,
    ): Effect.Effect<
      Omit<GcpResolvedCredentials, "region">,
      AuthError | NeedsReauth
    > =>
      Effect.gen(function* () {
        const creds = yield* store.read(
          profileName,
          GCP_AUTH_PROVIDER_NAME,
          GcpStoredCredentialsSchema,
        );
        if (creds == null) {
          return yield* new NeedsReauth({
            provider: GCP_AUTH_PROVIDER_NAME,
            profile: profileName,
            message: `GCP stored credentials not found. ${refreshHint(GCP_AUTH_PROVIDER_NAME, profileName)}`,
          });
        }
        if (creds.type === "token") {
          return {
            type: "token" as const,
            accessToken: Redacted.make(creds.accessToken),
            project: creds.project,
            source: { type: "stored" as const },
          };
        }
        const sa = yield* parseServiceAccountKey(creds.json);
        return yield* resolveFromServiceAccount(sa, creds.project);
      });

    const resolveToken = (
      profileName: string,
      config: GcpAuthConfig,
    ): Effect.Effect<
      Omit<GcpResolvedCredentials, "region">,
      AuthError | NeedsReauth
    > => {
      switch (config.method) {
        case "env":
          return resolveFromEnv();
        case "serviceAccount":
          return resolveFromServiceAccountFile(config.credentialsFile);
        case "stored":
          return resolveFromStored(profileName);
      }
    };

    // The region is part of the credential (the profile's `region`).
    // Google SDKs define no default-region environment variable; override
    // per stack with the `GCP.Region(...)` layer.
    const resolveCredentials = (
      profileName: string,
      config: GcpAuthConfig,
    ): Effect.Effect<GcpResolvedCredentials, AuthError | NeedsReauth> =>
      Effect.gen(function* () {
        const token = yield* resolveToken(profileName, config);
        return { ...token, region: config.region ?? DEFAULT_GCP_REGION };
      });

    const logout = (profileName: string, config: GcpAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "serviceAccount" }, () => Effect.void),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, GCP_AUTH_PROVIDER_NAME)
            .pipe(
              Effect.andThen(
                interaction.output.success("GCP: stored credentials removed"),
              ),
            ),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: GcpAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "env" }, () =>
            resolveFromEnv().pipe(Effect.as(config)),
          ),
          Match.when({ method: "serviceAccount" }, (cfg) =>
            resolveFromServiceAccountFile(cfg.credentialsFile).pipe(
              Effect.as(cfg),
            ),
          ),
          Match.when({ method: "stored" }, () =>
            store
              .read(
                profileName,
                GCP_AUTH_PROVIDER_NAME,
                GcpStoredCredentialsSchema,
              )
              .pipe(
                Effect.flatMap((creds) =>
                  creds == null
                    ? loginStored(profileName).pipe(
                        Effect.map((stored) => ({ ...config, ...stored })),
                      )
                    : Effect.succeed(config),
                ),
              ),
          ),
          Match.exhaustive,
        )
        .pipe(
          Effect.mapError(
            (e) => new AuthError({ message: "login failed", cause: e }),
          ),
        );

    const details = (
      profileName: string,
      config: GcpAuthConfig,
    ): Effect.Effect<ProviderDetails, AuthError | NeedsReauth> =>
      resolveCredentials(profileName, config).pipe(
        Effect.map((creds) => {
          const sourceStr = creds.source.details
            ? `${creds.source.type} - ${creds.source.details}`
            : creds.source.type;
          return {
            lines: [
              { key: "project", value: creds.project },
              { key: "region", value: creds.region },
              {
                key: "accessToken",
                value: displayRedacted(creds.accessToken, 8),
              },
              { key: "source", value: sourceStr },
            ],
          };
        }),
      );

    const readEnvironment = resolveFromEnv().pipe(
      Effect.map((token) => ({ ...token, region: DEFAULT_GCP_REGION })),
    );

    return {
      configSchema: GcpAuthConfigSchema,
      configure: configureCredentials,
      configureWith,
      configureMethods,
      logout,
      login,
      details,
      read: resolveCredentials,
      readEnvironment,
      environment: [
        {
          name: GOOGLE_ACCESS_TOKEN_ENV,
          required: false,
          secret: true,
          description:
            "Bearer access token (alternative to a service-account key).",
        },
        {
          name: GOOGLE_APPLICATION_CREDENTIALS_ENV,
          required: false,
          description: "Path to a service-account JSON key.",
        },
        {
          name: GOOGLE_PROJECT_ID_ENV,
          required: false,
          alternatives: [GOOGLE_CLOUD_PROJECT_ENV],
          description: "GCP project id.",
        },
      ],
    };
  }),
);
