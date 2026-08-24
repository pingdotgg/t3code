import * as DistilledAuth from "@distilled.cloud/aws/Auth";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as STS from "@distilled.cloud/aws/sts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { ChildProcess } from "effect/unstable/process";
import * as NodeCrypto from "node:crypto";
import * as NodeOs from "node:os";
import {
  AuthError,
  AuthProviderLayer,
  type ConfigureContext,
} from "../Auth/AuthProvider.ts";
import { CredentialsStore, displayRedacted } from "../Auth/Credentials.ts";
import {
  getEnv,
  getEnvRedacted,
  getEnvRedactedRequired,
  getEnvRequired,
  retryOnce,
} from "../Auth/Env.ts";
import * as Clank from "../Util/Clank.ts";
import * as Region from "./Region.ts";

export const AWS_AUTH_PROVIDER_NAME = "AWS";

export type AwsAuthConfig =
  | { method: "sso"; ssoProfile: string }
  | { method: "stored" }
  | { method: "env" };

const options: Array<{
  value: AwsAuthConfig["method"];
  label: string;
  hint?: string;
}> = [
  {
    value: "sso",
    label: "SSO",
    hint: "aws sso login — credentials loaded from AWS SSO cache",
  },
  {
    value: "env",
    label: "Environment Variables",
    hint: "AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY",
  },
  {
    value: "stored",
    label: "Stored",
    hint: "stored in ~/.alchemy/credentials",
  },
];

export interface AwsStoredCredentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
}

export interface AwsResolvedCredentials {
  accountId: string;
  credentials: Effect.Effect<{
    accessKeyId: Redacted.Redacted<string>;
    secretAccessKey: Redacted.Redacted<string>;
    sessionToken: Redacted.Redacted<string> | undefined;
  }>;
  region: string;
  source: {
    type: AwsAuthConfig["method"];
    details?: string;
  };
}

/**
 * An explicitly-set `AWS_REGION` env var wins over the region recorded in an
 * SSO profile (`~/.aws/config`) or in stored credentials. `AWS_DEFAULT_REGION`
 * deliberately does NOT override — it is a *default* for when no region is
 * configured anywhere, and the profile's region is explicit configuration.
 */
export const applyEnvRegionOverride = <C extends { region: string }>(
  creds: C,
): Effect.Effect<C> =>
  getEnv("AWS_REGION").pipe(
    Effect.map((envRegion) =>
      envRegion ? { ...creds, region: envRegion } : creds,
    ),
  );

/**
 * Layer that registers the AWS {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Include this in the AWS
 * `providers()` layer so `alchemy login` can discover it.
 */
export const AwsAuth = AuthProviderLayer<
  AwsAuthConfig,
  AwsResolvedCredentials
>()(
  AWS_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const store = yield* CredentialsStore;

    const getAccountId = ({
      accessKeyId,
      secretAccessKey,
      sessionToken,
      region,
    }: {
      accessKeyId: Redacted.Redacted<string>;
      secretAccessKey: Redacted.Redacted<string>;
      sessionToken?: Redacted.Redacted<string>;
      region: string;
    }) =>
      STS.getCallerIdentity({}).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(
              Credentials,
              Effect.succeed({
                accessKeyId,
                secretAccessKey,
                sessionToken,
              }),
            ),
            // Provide Region directly from the resolved inputs. Relying on the
            // ambient Region provider (Region.fromEnvironment) here would
            // deadlock: it derives the region from AWSEnvironment, which is the
            // very service still being constructed by this STS call.
            Region.of(region),
          ),
        ),
        Effect.flatMap((self) =>
          self.Account
            ? Effect.succeed(self.Account)
            : Effect.die(new Error("No account ID found")),
        ),
      );

    const loginStored = Effect.fn(function* (profileName: string) {
      const accessKeyId = yield* Clank.text({
        message: "AWS Access Key ID",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      const secretAccessKey = yield* Clank.password({
        message: "AWS Secret Access Key",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      const sessionToken = yield* Clank.text({
        message: "AWS Session Token (optional — press Enter or Esc to skip)",
        placeholder: "(none)",
      }).pipe(Effect.catch(() => Effect.succeed("")));

      const region = yield* Clank.text({
        message: "AWS Region",
        placeholder: "us-east-1",
        defaultValue: "us-east-1",
      }).pipe(retryOnce);

      const accountId = yield* getAccountId({
        accessKeyId: Redacted.make(accessKeyId),
        secretAccessKey: Redacted.make(secretAccessKey),
        sessionToken: sessionToken ? Redacted.make(sessionToken) : undefined,
        region,
      });

      yield* store.write<AwsStoredCredentials>(profileName, "aws", {
        accountId,
        accessKeyId,
        secretAccessKey,
        sessionToken,
        region,
      });
      yield* Clank.success("AWS credentials saved.");

      return { method: "stored" as const };
    });

    const configureInteractive = (profileName: string) =>
      Clank.select({
        message: "AWS authentication method",
        options,
      }).pipe(
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("env", () => Effect.succeed({ method: "env" as const })),
            Match.when("sso", () =>
              Effect.gen(function* () {
                const ssoProfile = yield* Clank.text({
                  message: "AWS profile name (from ~/.aws/config)",
                  placeholder: "default",
                  defaultValue: "default",
                });

                const config = {
                  method: "sso" as const,
                  ssoProfile: ssoProfile ?? "default",
                };

                yield* loginSSO(config);

                return config;
              }),
            ),
            Match.when("stored", () => loginStored(profileName)),
            Match.exhaustive,
          ),
        ),
      );

    const configureCredentials = (profileName: string, ctx: ConfigureContext) =>
      Effect.gen(function* () {
        if (ctx.ci) {
          return { method: "env" as const };
        }
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

    const resolveCredentials = (profileName: string, config: AwsAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when(
            { method: "env" },
            Effect.fn(function* () {
              const accessKeyId =
                yield* getEnvRedactedRequired("AWS_ACCESS_KEY_ID");
              const secretAccessKey = yield* getEnvRedactedRequired(
                "AWS_SECRET_ACCESS_KEY",
              );
              const sessionToken = yield* getEnvRedacted("AWS_SESSION_TOKEN");
              const region = yield* getEnv("AWS_REGION").pipe(
                Effect.flatMap((region) =>
                  region
                    ? Effect.succeed(region)
                    : getEnv("AWS_DEFAULT_REGION"),
                ),
              );
              if (!region) {
                return yield* Effect.fail(
                  new AuthError({
                    message:
                      "AWS region not found. Set AWS_REGION or AWS_DEFAULT_REGION.",
                  }),
                );
              }
              const accountId = yield* getEnvRequired("AWS_ACCOUNT_ID").pipe(
                Effect.catch(() =>
                  getAccountId({
                    accessKeyId,
                    secretAccessKey,
                    sessionToken,
                    region,
                  }),
                ),
              );
              return {
                accountId,
                credentials: Effect.succeed({
                  accessKeyId,
                  secretAccessKey,
                  sessionToken,
                }),
                region,
                source: { type: "env" as const },
              } satisfies AwsResolvedCredentials;
            }),
          ),
          Match.when({ method: "stored" }, () =>
            store.read<AwsStoredCredentials>(profileName, "aws").pipe(
              Effect.flatMap((creds) =>
                creds == null
                  ? Effect.fail(
                      new AuthError({
                        message:
                          "AWS stored credentials not found. Run: alchemy login --configure",
                      }),
                    )
                  : Effect.succeed({
                      accountId: creds.accountId,
                      credentials: Effect.succeed({
                        accessKeyId: Redacted.make(creds.accessKeyId),
                        secretAccessKey: Redacted.make(creds.secretAccessKey),
                        sessionToken: creds.sessionToken
                          ? Redacted.make(creds.sessionToken)
                          : undefined,
                      }),
                      region: creds.region,
                      source: { type: "stored" as const },
                    } satisfies AwsResolvedCredentials),
              ),
              // an older verson of the stored credentials didn't include the account ID, so we patch it hre
              Effect.flatMap((creds) =>
                creds.accountId
                  ? Effect.succeed(creds)
                  : creds.credentials.pipe(
                      Effect.flatMap((resolved) =>
                        getAccountId({
                          accessKeyId: resolved.accessKeyId,
                          secretAccessKey: resolved.secretAccessKey,
                          sessionToken: resolved.sessionToken,
                          region: creds.region,
                        }),
                      ),
                      Effect.map(
                        (accountId) =>
                          ({
                            ...creds,
                            accountId,
                          }) satisfies AwsResolvedCredentials,
                      ),
                      // re-write the stored credentials
                      Effect.tap((creds) =>
                        creds.credentials.pipe(
                          Effect.tap(
                            ({ accessKeyId, secretAccessKey, sessionToken }) =>
                              store.write<AwsStoredCredentials>(
                                profileName,
                                "aws",
                                {
                                  accessKeyId: Redacted.value(accessKeyId),
                                  secretAccessKey:
                                    Redacted.value(secretAccessKey),
                                  sessionToken: sessionToken
                                    ? Redacted.value(sessionToken)
                                    : undefined,
                                  region: creds.region,
                                  accountId: creds.accountId,
                                },
                              ),
                          ),
                        ),
                      ),
                    ),
              ),
            ),
          ),
          Match.when({ method: "sso" }, (config) =>
            Effect.gen(function* () {
              const auth = yield* DistilledAuth.Default;
              const profile = yield* auth
                .loadProfile(config.ssoProfile)
                .pipe(Effect.catch(() => Effect.succeed(undefined)));
              return {
                accountId: profile?.sso_account_id!,
                credentials: auth
                  .loadProfileCredentials(config.ssoProfile)
                  .pipe(
                    Effect.mapError(
                      (e) =>
                        new AuthError({
                          message: "failed to load credentials",
                          cause: e,
                        }),
                    ),
                    Effect.orDie,
                  ),
                region: profile?.region!,
                source: { type: "sso" as const, details: config.ssoProfile },
              } satisfies AwsResolvedCredentials;
            }),
          ),
          Match.exhaustive,
        )
        .pipe(
          Effect.mapError(
            (e) => new AuthError({ message: "login failed", cause: e }),
          ),
          Effect.flatMap(applyEnvRegionOverride),
        );

    const prettyPrint = (profileName: string, config: AwsAuthConfig) =>
      resolveCredentials(profileName, config).pipe(
        Effect.tap(
          Effect.fn(function* (creds) {
            const { accessKeyId, secretAccessKey, sessionToken } =
              yield* creds.credentials;
            yield* Console.log(
              `  accessKeyId:     ${displayRedacted(accessKeyId)}`,
            );
            yield* Console.log(
              `  secretAccessKey: ${displayRedacted(secretAccessKey)}`,
            );
            if (sessionToken) {
              yield* Console.log(
                `  sessionToken:    ${displayRedacted(sessionToken)}`,
              );
            }
            if (creds.region) {
              yield* Console.log(`  region:          ${creds.region}`);
            }
            yield* Console.log(
              //@ts-expect-error
              `  source: ${creds.source.details ? `${creds.source.type} - ${creds.source.details}` : creds.source.type}`,
            );
          }),
        ),
      );

    const logout = (profileName: string, config: AwsAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "sso" }, (config) =>
          Clank.info(
            `AWS: running 'aws sso logout --profile ${config.ssoProfile}'...`,
          ).pipe(
            Effect.zip(runSsoCommand("logout", config.ssoProfile)),
            Effect.zip(clearDistilledSsoCache(config.ssoProfile)),
            Effect.match({
              onSuccess: () => Clank.success("AWS: SSO logout complete"),
              onFailure: (e) =>
                Clank.warn(`AWS: SSO logout failed: \`${e.message}\``),
            }),
          ),
        ),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, "aws")
            .pipe(
              Effect.andThen(Clank.success("AWS: stored credentials removed")),
            ),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: AwsAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "env" }, () => Effect.void),
          Match.when({ method: "sso" }, loginSSO),
          Match.when({ method: "stored" }, () =>
            store
              .read<AwsStoredCredentials>(profileName, "aws")
              .pipe(
                Effect.flatMap((creds) =>
                  creds == null ? loginStored(profileName) : Effect.void,
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

    return {
      configure: configureCredentials,
      login,
      logout,
      prettyPrint,
      read: resolveCredentials,
    };
  }),
);

const runSsoCommand = (command: "login" | "logout", ssoProfile: string) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make(
      "aws",
      ["sso", command, "--profile", ssoProfile],
      {
        shell: false,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const exit = yield* handle.exitCode;
    if (exit !== 0) {
      return yield* new AuthError({
        message: `aws sso ${command} exited with code ${exit}`,
      });
    }
  }).pipe(Effect.scoped);

const loginSSO = (config: Extract<AwsAuthConfig, { method: "sso" }>) =>
  Clank.info(
    `AWS SSO: running 'aws sso login --profile ${config.ssoProfile}'...`,
  ).pipe(
    Effect.andThen(runSsoCommand("login", config.ssoProfile)),
    Effect.matchEffect({
      onSuccess: () => Clank.success("AWS SSO: login complete"),
      onFailure: (e) => Clank.warn(`AWS SSO: login faield: \`${e.message}\``),
    }),
  );

/**
 * `aws sso logout` only clears AWS CLI's own caches — it does not know about the
 * `<sha1(sso_session)>.credentials.json` file that `@distilled.cloud/aws`
 * writes alongside the SSO token. Without this cleanup, `loadProfileCredentials`
 * short-circuits on the stale distilled cache file after logout and appears to
 * stay logged in until the role creds hit their TTL.
 */
const clearDistilledSsoCache = (ssoProfile: string) =>
  Effect.gen(function* () {
    const auth = yield* DistilledAuth.Default;
    const profile = yield* auth.loadProfile(ssoProfile);
    const ssoSession = (profile as { sso_session?: string }).sso_session;
    if (!ssoSession) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hash = NodeCrypto.createHash("sha1").update(ssoSession).digest("hex");
    const cacheFile = path.join(
      NodeOs.homedir(),
      ".aws",
      "sso",
      "cache",
      `${hash}.credentials.json`,
    );
    yield* fs.remove(cacheFile).pipe(Effect.catch(() => Effect.void));
  }).pipe(Effect.catch(() => Effect.void));
