import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import {
  AuthError,
  AuthProviderLayer,
  type ConfigureContext,
} from "../Auth/AuthProvider.ts";
import { CredentialsStore, displayRedacted } from "../Auth/Credentials.ts";
import { getEnvRedacted, retryOnce } from "../Auth/Env.ts";
import { AlchemyProfile } from "../Auth/Profile.ts";
import * as Clank from "../Util/Clank.ts";

export const PRISMA_AUTH_PROVIDER_NAME = "Prisma";
export const PRISMA_SERVICE_TOKEN_ENV = "PRISMA_SERVICE_TOKEN";
export const PRISMA_API_TOKEN_ENV = "PRISMA_API_TOKEN";

export type PrismaAuthConfig = { method: "env" } | { method: "stored" };

export interface PrismaStoredCredentials {
  type: "serviceToken";
  serviceToken: string;
}

export interface PrismaResolvedCredentials {
  type: "serviceToken";
  serviceToken: Redacted.Redacted<string>;
  source: { type: PrismaAuthConfig["method"]; details?: string };
}

const options: Array<{
  value: PrismaAuthConfig["method"];
  label: string;
  hint?: string;
}> = [
  {
    value: "env",
    label: "Environment Variable",
    hint: `${PRISMA_SERVICE_TOKEN_ENV} or ${PRISMA_API_TOKEN_ENV}`,
  },
  {
    value: "stored",
    label: "Service Token",
    hint: "enter interactively, stored in ~/.alchemy/credentials",
  },
];

const nonEmptyToken = (
  token: Redacted.Redacted<string> | undefined,
): token is Redacted.Redacted<string> =>
  token !== undefined && Redacted.value(token).trim().length > 0;

const validStoredCredentials = (
  credentials: PrismaStoredCredentials | undefined,
): credentials is PrismaStoredCredentials =>
  credentials?.type === "serviceToken" &&
  credentials.serviceToken.trim().length > 0;

const trimToken = (token: Redacted.Redacted<string>) =>
  Redacted.make(Redacted.value(token).trim());

const readEnvServiceToken = Effect.fnUntraced(function* () {
  const serviceToken = yield* getEnvRedacted(PRISMA_SERVICE_TOKEN_ENV);
  if (nonEmptyToken(serviceToken)) {
    return {
      serviceToken: trimToken(serviceToken),
      envName: PRISMA_SERVICE_TOKEN_ENV,
    };
  }

  const apiToken = yield* getEnvRedacted(PRISMA_API_TOKEN_ENV);
  if (nonEmptyToken(apiToken)) {
    return {
      serviceToken: trimToken(apiToken),
      envName: PRISMA_API_TOKEN_ENV,
    };
  }

  return undefined;
});

/**
 * Layer that registers the Prisma Management API auth provider.
 */
export const PrismaAuth = AuthProviderLayer<
  PrismaAuthConfig,
  PrismaResolvedCredentials
>()(
  PRISMA_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const profiles = yield* AlchemyProfile;
    const store = yield* CredentialsStore;

    const loginStored = Effect.fnUntraced(function* (profileName: string) {
      const serviceToken = yield* Clank.password({
        message: "Prisma Service Token",
        validate: (v) => (v.trim().length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      yield* store.write<PrismaStoredCredentials>(
        profileName,
        "prisma-stored",
        {
          type: "serviceToken",
          serviceToken: serviceToken.trim(),
        },
      );
      yield* Clank.success("Prisma: credentials saved.");
      return { method: "stored" as const };
    });

    const configureInteractive = (profileName: string) =>
      Clank.select({
        message: "Prisma authentication method",
        options,
      }).pipe(
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("env", () => Effect.succeed({ method: "env" as const })),
            Match.when("stored", () => loginStored(profileName)),
            Match.exhaustive,
          ),
        ),
      );

    const configure = (profileName: string, ctx: ConfigureContext) =>
      Effect.gen(function* () {
        if (ctx.ci) return { method: "env" as const };
        return yield* configureInteractive(profileName);
      }).pipe(
        Effect.mapError(
          (e) =>
            new AuthError({
              message: "failed to configure credentials",
              cause: e,
            }),
        ),
      );

    const read = (
      profileName: string,
      config: PrismaAuthConfig,
    ): Effect.Effect<PrismaResolvedCredentials, AuthError> =>
      Match.value(config).pipe(
        Match.when(
          { method: "env" },
          Effect.fnUntraced(function* () {
            const envToken = yield* readEnvServiceToken();
            if (!envToken) {
              return yield* new AuthError({
                message: `Prisma env credentials not found. Set ${PRISMA_SERVICE_TOKEN_ENV} or ${PRISMA_API_TOKEN_ENV}.`,
              });
            }
            return {
              type: "serviceToken" as const,
              serviceToken: envToken.serviceToken,
              source: { type: "env" as const, details: envToken.envName },
            };
          }),
        ),
        Match.when({ method: "stored" }, () =>
          store
            .read<PrismaStoredCredentials>(profileName, "prisma-stored")
            .pipe(
              Effect.flatMap((creds) =>
                !validStoredCredentials(creds)
                  ? Effect.fail(
                      new AuthError({
                        message:
                          creds == null
                            ? "Prisma stored credentials not found. Run: alchemy login --configure"
                            : "Prisma stored credentials are invalid. Run: alchemy login --configure",
                      }),
                    )
                  : Effect.succeed({
                      type: "serviceToken" as const,
                      serviceToken: Redacted.make(creds.serviceToken.trim()),
                      source: { type: "stored" as const },
                    }),
              ),
            ),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: PrismaAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "env" }, () =>
            readEnvServiceToken().pipe(
              Effect.flatMap((envToken) =>
                envToken
                  ? Effect.void
                  : Effect.gen(function* () {
                      const next = yield* configureInteractive(profileName);
                      const existing = yield* profiles.getProfile(profileName);
                      yield* profiles.setProfile(profileName, {
                        ...existing,
                        [PRISMA_AUTH_PROVIDER_NAME]: next,
                      });
                    }),
              ),
            ),
          ),
          Match.when({ method: "stored" }, () =>
            store
              .read<PrismaStoredCredentials>(profileName, "prisma-stored")
              .pipe(
                Effect.flatMap((creds) =>
                  validStoredCredentials(creds)
                    ? Effect.void
                    : loginStored(profileName),
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

    const logout = (profileName: string, config: PrismaAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, "prisma-stored")
            .pipe(
              Effect.andThen(
                Clank.success("Prisma: stored credentials removed"),
              ),
            ),
        ),
        Match.exhaustive,
      );

    const prettyPrint = (profileName: string, config: PrismaAuthConfig) =>
      read(profileName, config).pipe(
        Effect.tap((creds) => {
          const source = creds.source.details
            ? `${creds.source.type} - ${creds.source.details}`
            : creds.source.type;
          return Effect.all([
            Console.log(
              `  serviceToken: ${displayRedacted(creds.serviceToken, 9)}`,
            ),
            Console.log(`  source: ${source}`),
          ]);
        }),
        Effect.catch((e) =>
          Console.error(`  Failed to retrieve credentials: ${e}`),
        ),
      );

    return { configure, login, logout, prettyPrint, read };
  }),
);
